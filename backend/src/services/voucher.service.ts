import { randomInt } from 'crypto';
import { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { dbPool, withTransaction } from '../config/database';
import {
  AuthUser,
  CharsetType,
  GenerateBatchDTO,
  GeneratedVoucherCard,
} from '../types/radius.types';

/**
 * Unambiguous character sets (excludes 0/O, 1/I/l where confusion occurs on printed cards)
 */
const CHARSETS: Record<CharsetType, string> = {
  NUMERIC: '0123456789',
  ALPHANUMERIC_UPPER: '23456789ABCDEFGHJKLMNPQRSTUVWXYZ',
  ALPHANUMERIC_MIXED: '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ',
};

const CHUNK_SIZE = 1000; // Optimal packet size for multi-row MySQL INSERTs

export class VoucherService {
  /**
   * Generates a cryptographically random string of length `len` from `alphabet`
   * without modulo bias using Node's `crypto.randomInt`.
   */
  private generateRandomCode(len: number, alphabet: string): string {
    const alphabetLen = alphabet.length;
    let out = '';
    for (let i = 0; i < len; i++) {
      out += alphabet[randomInt(0, alphabetLen)];
    }
    return out;
  }

  /**
   * Generates a collision-free set of vouchers verified against both the in-memory
   * batch set and existing `radcheck.username` rows in MariaDB.
   */
  private async generateCollisionFreeCards(
    conn: PoolConnection,
    dto: GenerateBatchDTO,
    batchCode: string
  ): Promise<GeneratedVoucherCard[]> {
    const prefix = (dto.prefix || '').trim();
    const randomPartLength = Math.max(4, dto.codeLength - prefix.length);
    const alphabet = CHARSETS[dto.charsetType];

    // Check keyspace capacity to avoid infinite loops on tiny lengths
    const keyspace = Math.pow(alphabet.length, randomPartLength);
    if (dto.quantity > keyspace * 0.5) {
      throw new Error(
        `Keyspace too small (${keyspace} combinations) for requested quantity (${dto.quantity}). Increase codeLength.`
      );
    }

    const acceptedUsernames = new Set<string>();
    const cards: GeneratedVoucherCard[] = [];
    let attempts = 0;
    const maxAttempts = 12;

    while (acceptedUsernames.size < dto.quantity && attempts < maxAttempts) {
      attempts++;
      const needed = dto.quantity - acceptedUsernames.size;
      // Over-sample by 5% to absorb rare DB collisions in a single round-trip
      const sampleCount = Math.ceil(needed * 1.05);
      const candidates = new Set<string>();

      while (candidates.size < sampleCount) {
        const candidate = `${prefix}${this.generateRandomCode(randomPartLength, alphabet)}`;
        if (!acceptedUsernames.has(candidate)) {
          candidates.add(candidate);
        }
      }

      const candidateList = Array.from(candidates);

      // Query MariaDB in chunks of 1000 to filter out any existing usernames in `radcheck`
      const existingSet = new Set<string>();
      for (let i = 0; i < candidateList.length; i += CHUNK_SIZE) {
        const slice = candidateList.slice(i, i + CHUNK_SIZE);
        const placeholders = slice.map(() => '?').join(',');
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT username FROM radcheck WHERE username IN (${placeholders})`,
          slice
        );
        for (const row of rows) {
          existingSet.add(String(row.username));
        }
      }

      // Accept non-colliding candidates up to exact quantity
      for (const username of candidateList) {
        if (acceptedUsernames.size >= dto.quantity) break;
        if (!existingSet.has(username)) {
          acceptedUsernames.add(username);
          const seq = String(acceptedUsernames.size).padStart(5, '0');
          const cleartextPassword =
            dto.voucherType === 'PIN_ONLY'
              ? username // MikroTik Hotspot PIN mode: username == password (or blank password)
              : this.generateRandomCode(6, CHARSETS.NUMERIC);

          cards.push({
            username,
            cleartextPassword,
            serialNumber: `${batchCode}-${seq}`,
          });
        }
      }
    }

    if (cards.length < dto.quantity) {
      throw new Error(
        'Unable to generate collision-free batch after maximum retries. Please increase code length or change prefix.'
      );
    }

    return cards;
  }

  /**
   * Transactional Batch Voucher Generation:
   * 1. Locks Reseller & Profile rows (`SELECT ... FOR UPDATE`).
   * 2. Validates reseller balance & credit limit.
   * 3. Generates collision-free codes.
   * 4. Inserts batch metadata (`voucher_batches`).
   * 5. Bulk-inserts into FreeRADIUS `radcheck` & `radusergroup` + `voucher_cards`.
   * 6. Deducts reseller balance and logs financial transaction (`reseller_transactions`).
   */
  public async generateBatch(dto: GenerateBatchDTO, actor: AuthUser) {
    if (dto.quantity < 1 || dto.quantity > 10000) {
      throw new Error('Batch quantity must be between 1 and 10,000 cards per request.');
    }

    const targetResellerId =
      actor.role === 'SUPER_ADMIN' && dto.resellerId ? dto.resellerId : actor.id;

    return withTransaction(async (conn) => {
      // 1. Fetch & lock profile
      const [profileRows] = await conn.query<RowDataPacket[]>(
        `SELECT id, name, display_name, price, cost_price, validity_days, is_active
         FROM profiles_meta
         WHERE id = ? FOR UPDATE`,
        [dto.profileId]
      );
      if (profileRows.length === 0 || !profileRows[0].is_active) {
        throw new Error('Selected Hotspot profile does not exist or is inactive.');
      }
      const profile = profileRows[0];

      // 2. Fetch & lock reseller row for atomic balance check
      const [resellerRows] = await conn.query<RowDataPacket[]>(
        `SELECT id, name, role, balance, credit_limit, is_active
         FROM resellers
         WHERE id = ? FOR UPDATE`,
        [targetResellerId]
      );
      if (resellerRows.length === 0 || !resellerRows[0].is_active) {
        throw new Error('Reseller account not found or is suspended.');
      }
      const reseller = resellerRows[0];

      const unitCost = Number(profile.cost_price);
      const totalCost = Number((unitCost * dto.quantity).toFixed(2));
      const balanceBefore = Number(reseller.balance);
      const creditLimit = Number(reseller.credit_limit);

      // Super Admins bypass balance limit unless generating for a sub-reseller
      if (reseller.role !== 'SUPER_ADMIN') {
        const availablePurchasingPower = balanceBefore + creditLimit;
        if (totalCost > availablePurchasingPower) {
          throw new Error(
            `Insufficient reseller balance. Required: ${totalCost}, Available (incl. credit): ${availablePurchasingPower}`
          );
        }
      }

      // 3. Generate unique batch code & collision-free voucher cards
      const timestampPart = Date.now().toString(36).toUpperCase();
      const randomSuffix = this.generateRandomCode(4, CHARSETS.ALPHANUMERIC_UPPER);
      const batchCode = `B-${timestampPart}-${randomSuffix}`;

      const cards = await this.generateCollisionFreeCards(conn, dto, batchCode);

      // 4. Insert Batch Header (`voucher_batches`)
      const [batchHeaderResult] = await conn.query<ResultSetHeader>(
        `INSERT INTO voucher_batches
          (batch_code, profile_id, quantity, reseller_id, voucher_type, prefix, code_length, charset_type, unit_cost, total_cost, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          batchCode,
          profile.id,
          dto.quantity,
          targetResellerId,
          dto.voucherType,
          dto.prefix || '',
          dto.codeLength,
          dto.charsetType,
          unitCost,
          totalCost,
          dto.notes || null,
        ]
      );
      const batchId = batchHeaderResult.insertId;

      // 5. High-Performance Chunked Bulk Insertion into `radcheck`, `radusergroup`, and `voucher_cards`
      for (let i = 0; i < cards.length; i += CHUNK_SIZE) {
        const chunk = cards.slice(i, i + CHUNK_SIZE);

        // 5a. FreeRADIUS `radcheck`: (username, attribute, op, value)
        const radcheckValues: any[] = [];
        const radcheckPlaceholders: string[] = [];

        for (const card of chunk) {
          radcheckPlaceholders.push('(?, ?, ?, ?)');
          radcheckValues.push(
            card.username,
            'Cleartext-Password',
            ':=',
            card.cleartextPassword
          );
        }

        await conn.query(
          `INSERT INTO radcheck (username, attribute, op, value) VALUES ${radcheckPlaceholders.join(',')}`,
          radcheckValues
        );

        // 5b. FreeRADIUS `radusergroup`: (username, groupname, priority)
        const radusergroupValues: any[] = [];
        const radusergroupPlaceholders: string[] = [];

        for (const card of chunk) {
          radusergroupPlaceholders.push('(?, ?, ?)');
          radusergroupValues.push(card.username, profile.name, 1);
        }

        await conn.query(
          `INSERT INTO radusergroup (username, groupname, priority) VALUES ${radusergroupPlaceholders.join(',')}`,
          radusergroupValues
        );

        // 5c. Custom `voucher_cards`
        const voucherCardValues: any[] = [];
        const voucherCardPlaceholders: string[] = [];

        for (const card of chunk) {
          voucherCardPlaceholders.push('(?, ?, ?, ?, ?, ?, ?)');
          voucherCardValues.push(
            batchId,
            targetResellerId,
            profile.id,
            card.username,
            card.cleartextPassword,
            card.serialNumber,
            'UNUSED'
          );
        }

        await conn.query(
          `INSERT INTO voucher_cards
            (batch_id, reseller_id, profile_id, username, cleartext_password, serial_number, status)
           VALUES ${voucherCardPlaceholders.join(',')}`,
          voucherCardValues
        );
      }

      // 6. Deduct Reseller Balance & Record Ledger Transaction
      const balanceAfter = Number((balanceBefore - totalCost).toFixed(2));
      await conn.query(`UPDATE resellers SET balance = ? WHERE id = ?`, [
        balanceAfter,
        targetResellerId,
      ]);

      await conn.query(
        `INSERT INTO reseller_transactions
          (reseller_id, batch_id, type, amount, balance_before, balance_after, description)
         VALUES (?, ?, 'BATCH_DEDUCTION', ?, ?, ?, ?)`,
        [
          targetResellerId,
          batchId,
          totalCost,
          balanceBefore,
          balanceAfter,
          `Generated ${dto.quantity} cards (${profile.display_name}) - Batch ${batchCode}`,
        ]
      );

      return {
        batchId,
        batchCode,
        quantity: dto.quantity,
        profileName: profile.name,
        profileDisplayName: profile.display_name,
        price: Number(profile.price),
        totalCost,
        balanceAfter,
        cards,
      };
    });
  }

  /**
   * Fetch printable cards for a batch with strict RBAC isolation.
   */
  public async getBatchCardsForPrint(batchId: number, actor: AuthUser) {
    const params: any[] = [batchId];
    let rbacCondition = '';

    if (actor.role !== 'SUPER_ADMIN') {
      rbacCondition = 'AND vb.reseller_id = ?';
      params.push(actor.id);
    }

    const [batches] = await dbPool.query<RowDataPacket[]>(
      `SELECT vb.*, pm.display_name AS profile_display_name, pm.price, pm.speed_limit,
              pm.time_limit, pm.data_limit_mb, pm.validity_days, r.name AS reseller_name
       FROM voucher_batches vb
       INNER JOIN profiles_meta pm ON pm.id = vb.profile_id
       INNER JOIN resellers r ON r.id = vb.reseller_id
       WHERE vb.id = ? ${rbacCondition}`,
      params
    );

    if (batches.length === 0) {
      throw new Error('Batch not found or access denied.');
    }

    const [cards] = await dbPool.query<RowDataPacket[]>(
      `SELECT id, username, cleartext_password AS cleartextPassword, serial_number AS serialNumber, status
       FROM voucher_cards
       WHERE batch_id = ?
       ORDER BY id ASC`,
      [batchId]
    );

    return {
      batch: batches[0],
      cards,
    };
  }
}
