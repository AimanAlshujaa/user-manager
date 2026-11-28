import mysql from 'mysql2/promise';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { hashPassword } from './security.mjs';

const CHARSETS = {
  NUMERIC: '0123456789',
  ALPHANUMERIC_UPPER: '23456789ABCDEFGHJKLMNPQRSTUVWXYZ',
  ALPHANUMERIC_MIXED: '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ',
};

const CHUNK_SIZE = 500;
const BULK_ACTION_CHUNK_SIZE = 300;
const ALLOWED_PAGE_SIZES = [20, 50, 100, 250, 500, 1000];
const ALLOWED_BULK_ACTIONS = new Set(['delete', 'disable', 'enable', 'reset', 'disconnect']);

function normalizePageSize(rawLimit) {
  const n = Number(rawLimit);
  return ALLOWED_PAGE_SIZES.includes(n) ? n : 50;
}

function chunkItems(items, size = BULK_ACTION_CHUNK_SIZE) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function runWithConcurrency(items, concurrency, worker) {
  let idx = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const workers = Array.from({ length: limit }, async () => {
    while (idx < items.length) {
      const current = items[idx++];
      await worker(current);
    }
  });
  await Promise.all(workers);
}

function randomCode(len, alphabet) {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += alphabet[randomInt(0, alphabet.length)];
  }
  return out;
}

export class MariaDBRadiusStore {
  constructor(config = {}) {
    this.pool = mysql.createPool({
      host: config.host || process.env.DB_HOST || '127.0.0.1',
      port: Number(config.port || process.env.DB_PORT || 3306),
      user: config.user || process.env.DB_USER || 'radius',
      password: config.password || process.env.DB_PASSWORD || 'RadPass2026!',
      database: config.database || process.env.DB_NAME || 'radius',
      waitForConnections: true,
      connectionLimit: 20,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      decimalNumbers: true,
    });
  }

  async testConnection() {
    const conn = await this.pool.getConnection();
    await conn.ping();
    conn.release();
    await this.ensureInitialSetup();
    return true;
  }

  /**
   * Ensures auxiliary columns/tables and a default SUPER_ADMIN exist on fresh MariaDB installs.
   */
  async ensureInitialSetup() {
    try {
      await this.pool.query(
        `ALTER TABLE voucher_cards ADD COLUMN IF NOT EXISTS notes VARCHAR(255) DEFAULT NULL`
      );
    } catch {
      // Older MySQL without IF NOT EXISTS; ignore if column already exists
    }

    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS access_points (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT,
          nas_ip VARCHAR(128) DEFAULT NULL,
          match_type ENUM('CALLED_STATION_ID', 'NAS_PORT_ID') NOT NULL DEFAULT 'CALLED_STATION_ID',
          match_value VARCHAR(128) NOT NULL,
          ap_ip VARCHAR(64) NOT NULL,
          ap_name VARCHAR(120) NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY uk_ap_match (nas_ip, match_type, match_value)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    } catch {
      // Ignore if insufficient DDL privileges
    }

    try {
      await this.pool.query(`CREATE TABLE IF NOT EXISTS radacct_archive LIKE radacct`);
    } catch {
      // Ignore
    }

    const [resellers] = await this.pool.query('SELECT id FROM resellers LIMIT 1');
    if (resellers.length === 0) {
      const defaultPass = hashPassword(process.env.ADMIN_DEFAULT_PASSWORD || 'admin123');
      await this.pool.query(
        `INSERT INTO resellers (name, username, password_hash, role, phone, balance, credit_limit, is_active)
         VALUES (?, ?, ?, 'SUPER_ADMIN', '', 50000.00, 100000.00, 1)`,
        ['المدير العام للنظام (admin)', 'admin', defaultPass]
      );
    }
  }

  async getActor(actorId = 1) {
    const [rows] = await this.pool.query(
      'SELECT id, name, username, role, phone, balance, credit_limit, is_active FROM resellers WHERE is_active = 1'
    );
    return rows.find((r) => r.id === Number(actorId)) || rows[0] || {
      id: 1,
      name: 'المدير العام (admin)',
      username: 'admin',
      role: 'SUPER_ADMIN',
      balance: 0,
      credit_limit: 0,
    };
  }

  checkFreeRadiusService() {
    return new Promise((resolve) => {
      const child = spawn('systemctl', ['is-active', 'freeradius']);
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (code) => {
        resolve({ active: code === 0 && out.trim() === 'active', statusText: out.trim() || 'unknown' });
      });
      child.on('error', () => resolve({ active: null, statusText: 'unknown' }));
    });
  }

  // --- System Status & Resellers ---
  async getSystemStatus(actorId = 1) {
    const [resellers] = await this.pool.query(
      'SELECT id, name, username, role, phone, balance, credit_limit, is_active, created_at FROM resellers WHERE is_active = 1 ORDER BY id ASC'
    );
    const currentActor = resellers.find((r) => r.id === Number(actorId)) || resellers[0];
    const [nasRows] = await this.pool.query('SELECT COUNT(*) AS cnt FROM nas');
    const frStatus = await this.checkFreeRadiusService();

    return {
      engine: 'MARIADB_FREERADIUS_LIVE',
      dbConnected: true,
      freeradiusActive: frStatus.active,
      freeradiusStatus: frStatus.statusText,
      nasCount: Number(nasRows[0]?.cnt || 0),
      currentActor,
      availableActors: resellers,
    };
  }

  // --- Dashboard KPIs (100% Real SQL Aggregations) ---
  async getDashboardKpis(actor) {
    const isSuper = actor.role === 'SUPER_ADMIN';
    const params = isSuper ? [] : [actor.id];

    const [activeRows] = await this.pool.query(
      `SELECT COUNT(*) AS activeSessions,
              COALESCE(SUM(ra.acctinputoctets), 0) AS totalUpload,
              COALESCE(SUM(ra.acctoutputoctets), 0) AS totalDownload
       FROM radacct ra
       ${isSuper ? 'INNER JOIN voucher_cards vc ON vc.username = ra.username' : 'INNER JOIN voucher_cards vc ON vc.username = ra.username AND vc.reseller_id = ?'}
       WHERE ra.acctstoptime IS NULL`,
      params
    );

    const [voucherCounts] = await this.pool.query(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(status = 'UNUSED'), 0) AS unused,
         COALESCE(SUM(status = 'ACTIVE'), 0) AS active,
         COALESCE(SUM(status = 'EXPIRED'), 0) AS expired,
         COALESCE(SUM(status = 'DISABLED'), 0) AS disabled
       FROM voucher_cards
       ${isSuper ? '' : 'WHERE reseller_id = ?'}`,
      params
    );

    const [rev] = await this.pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN DATE(created_at) = CURDATE() THEN total_cost ELSE 0 END), 0) AS dailyRev,
         COALESCE(SUM(CASE WHEN MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE()) THEN total_cost ELSE 0 END), 0) AS monthlyRev,
         COUNT(*) AS batchesCount
       FROM voucher_batches
       ${isSuper ? '' : 'WHERE reseller_id = ?'}`,
      params
    );

    const [recentBatches] = await this.pool.query(
      `SELECT vb.*, pm.display_name AS profile_display_name, r.name AS reseller_name
       FROM voucher_batches vb
       LEFT JOIN profiles_meta pm ON pm.id = vb.profile_id
       LEFT JOIN resellers r ON r.id = vb.reseller_id
       ${isSuper ? '' : 'WHERE vb.reseller_id = ?'}
       ORDER BY vb.id DESC LIMIT 6`,
      params
    );

    // Real Hourly Traffic & Peak Users from `radacct` (last 24 hours, grouped into 3-hour or hourly slots)
    const [hourlyRows] = await this.pool.query(
      `SELECT HOUR(ra.acctstarttime) AS hr,
              COUNT(DISTINCT ra.username) AS users,
              COALESCE(SUM(ra.acctoutputoctets), 0) AS dlBytes,
              COALESCE(SUM(ra.acctinputoctets), 0) AS ulBytes,
              COALESCE(SUM(GREATEST(ra.acctsessiontime, 1)), 0) AS totalSecs
       FROM radacct ra
       ${isSuper ? 'INNER JOIN voucher_cards vc ON vc.username = ra.username' : 'INNER JOIN voucher_cards vc ON vc.username = ra.username AND vc.reseller_id = ?'}
       WHERE ra.acctstarttime >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
       GROUP BY HOUR(ra.acctstarttime)
       ORDER BY hr ASC`,
      params
    );

    const byHour = new Map();
    for (const r of hourlyRows) {
      byHour.set(Number(r.hr), r);
    }

    // Build 8 slots covering the last 8 hours (or active hours)
    const nowHour = new Date().getHours();
    const slots = [];
    for (let offset = 7; offset >= 0; offset--) {
      const hr = (nowHour - offset + 24) % 24;
      const row = byHour.get(hr);
      const dlBytes = Number(row?.dlBytes || 0);
      const ulBytes = Number(row?.ulBytes || 0);
      const users = Number(row?.users || 0);
      // Average throughput in Mbps during that hour based on bytes / active seconds
      const secs = Math.max(Number(row?.totalSecs || 0), 1);
      const dlMbps = row ? Number(((dlBytes * 8) / (secs * 1000000)).toFixed(1)) : 0;
      const ulMbps = row ? Number(((ulBytes * 8) / (secs * 1000000)).toFixed(1)) : 0;
      const totalGb = Number(((dlBytes + ulBytes) / (1024 * 1024 * 1024)).toFixed(2));
      const label = String(hr).padStart(2, '0') + ':00';

      slots.push({ time: label, downloadMbps: dlMbps, uploadMbps: ulMbps, users, totalGb });
    }

    const trafficHistory = slots.map((s) => ({
      time: s.time,
      downloadMbps: s.downloadMbps,
      uploadMbps: s.uploadMbps,
    }));

    const peakHoursHistory = slots.map((s) => ({
      time: s.time,
      users: s.users,
      totalGb: s.totalGb,
    }));

    return {
      activeSessions: Number(activeRows[0]?.activeSessions || 0),
      totalUploadBytes: Number(activeRows[0]?.totalUpload || 0),
      totalDownloadBytes: Number(activeRows[0]?.totalDownload || 0),
      vouchers: {
        total: Number(voucherCounts[0]?.total || 0),
        unused: Number(voucherCounts[0]?.unused || 0),
        active: Number(voucherCounts[0]?.active || 0),
        expired: Number(voucherCounts[0]?.expired || 0),
        disabled: Number(voucherCounts[0]?.disabled || 0),
      },
      revenue: {
        daily: Number(rev[0]?.dailyRev || 0),
        monthly: Number(rev[0]?.monthlyRev || 0),
        batchesCount: Number(rev[0]?.batchesCount || 0),
      },
      trafficHistory,
      peakHoursHistory,
      recentBatches,
    };
  }

  // --- Batches & Bulk Voucher Generation ---
  async getBatches(actor) {
    const isSuper = actor.role === 'SUPER_ADMIN';
    const [rows] = await this.pool.query(
      `SELECT vb.*, pm.display_name AS profile_display_name, pm.speed_limit, pm.price,
              r.name AS reseller_name
       FROM voucher_batches vb
       LEFT JOIN profiles_meta pm ON pm.id = vb.profile_id
       LEFT JOIN resellers r ON r.id = vb.reseller_id
       ${isSuper ? '' : 'WHERE vb.reseller_id = ?'}
       ORDER BY vb.id DESC LIMIT 100`,
      isSuper ? [] : [actor.id]
    );
    return rows;
  }

  async generateBatch(dto, actor) {
    const quantity = Number(dto.quantity);
    if (!quantity || quantity < 1 || quantity > 10000) {
      throw new Error('عدد الكروت يجب أن يكون بين 1 و 10,000 كرت');
    }

    const targetResellerId =
      actor.role === 'SUPER_ADMIN' && dto.resellerId ? Number(dto.resellerId) : actor.id;

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      // 1. Lock Profile
      const [profileRows] = await conn.query(
        'SELECT * FROM profiles_meta WHERE id = ? AND is_active = 1 FOR UPDATE',
        [Number(dto.profileId)]
      );
      if (profileRows.length === 0) {
        throw new Error('الباقة المختارة غير موجودة أو غير مفعلة. يرجى إضافة باقة أولاً.');
      }
      const profile = profileRows[0];

      // 2. Lock Reseller
      const [resellerRows] = await conn.query(
        'SELECT * FROM resellers WHERE id = ? AND is_active = 1 FOR UPDATE',
        [targetResellerId]
      );
      if (resellerRows.length === 0) {
        throw new Error('حساب الموزع غير موجود أو موقوف');
      }
      const reseller = resellerRows[0];

      const unitCost = Number(profile.cost_price);
      const totalCost = Number((unitCost * quantity).toFixed(2));
      const balanceBefore = Number(reseller.balance);
      const creditLimit = Number(reseller.credit_limit);

      if (reseller.role !== 'SUPER_ADMIN' && totalCost > balanceBefore + creditLimit) {
        throw new Error(
          `رصيد الموزع غير كافٍ. المطلوب: ${totalCost} ر.س، المتاح (شامل الائتمان): ${(balanceBefore + creditLimit).toFixed(2)} ر.س`
        );
      }

      // 3. Collision-free generation against `radcheck`
      const prefix = String(dto.prefix || '').trim();
      const codeLength = Number(dto.codeLength || 8);
      const randomPartLen = Math.max(4, codeLength - prefix.length);
      const charsetType = CHARSETS[dto.charsetType] ? dto.charsetType : 'NUMERIC';
      const alphabet = CHARSETS[charsetType];

      const batchCode = `B-${Date.now().toString(36).toUpperCase().slice(-5)}-${randomCode(3, CHARSETS.ALPHANUMERIC_UPPER)}`;

      const accepted = new Set();
      const cards = [];
      let attempts = 0;

      while (accepted.size < quantity && attempts < 12) {
        attempts++;
        const needed = quantity - accepted.size;
        const sampleCount = Math.ceil(needed * 1.05);
        const candidates = new Set();

        while (candidates.size < sampleCount) {
          const candidate = `${prefix}${randomCode(randomPartLen, alphabet)}`;
          if (!accepted.has(candidate)) candidates.add(candidate);
        }

        const candidateList = Array.from(candidates);
        const existingSet = new Set();

        for (let i = 0; i < candidateList.length; i += CHUNK_SIZE) {
          const slice = candidateList.slice(i, i + CHUNK_SIZE);
          const placeholders = slice.map(() => '?').join(',');
          const [existingRows] = await conn.query(
            `SELECT username FROM radcheck WHERE username IN (${placeholders})`,
            slice
          );
          for (const row of existingRows) existingSet.add(String(row.username));
        }

        for (const username of candidateList) {
          if (accepted.size >= quantity) break;
          if (!existingSet.has(username)) {
            accepted.add(username);
            const seq = String(accepted.size).padStart(4, '0');
            const cleartextPassword =
              dto.voucherType === 'USER_PASS' ? randomCode(5, CHARSETS.ALPHANUMERIC_MIXED) : username;
            cards.push({
              username,
              cleartextPassword,
              serialNumber: `${batchCode}-${seq}`,
            });
          }
        }
      }

      if (cards.length < quantity) {
        throw new Error('تعذر توليد كروت فريدة بالمعايير الحالية. يرجى زيادة طول الكود.');
      }

      // 4. Insert Batch Header
      const [batchRes] = await conn.query(
        `INSERT INTO voucher_batches
          (batch_code, profile_id, quantity, reseller_id, voucher_type, prefix, code_length, charset_type, unit_cost, total_cost, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          batchCode,
          profile.id,
          quantity,
          targetResellerId,
          dto.voucherType || 'PIN_ONLY',
          prefix,
          codeLength,
          charsetType,
          unitCost,
          totalCost,
          dto.notes || null,
        ]
      );
      const batchId = batchRes.insertId;

      // 5. Chunked Bulk Inserts into `radcheck`, `radusergroup`, `voucher_cards`
      for (let i = 0; i < cards.length; i += CHUNK_SIZE) {
        const chunk = cards.slice(i, i + CHUNK_SIZE);

        const rcPlaceholders = chunk.map(() => '(?, ?, ?, ?)').join(',');
        const rcValues = chunk.flatMap((c) => [c.username, 'Cleartext-Password', ':=', c.cleartextPassword]);
        await conn.query(
          `INSERT INTO radcheck (username, attribute, op, value) VALUES ${rcPlaceholders}`,
          rcValues
        );

        const rugPlaceholders = chunk.map(() => '(?, ?, ?)').join(',');
        const rugValues = chunk.flatMap((c) => [c.username, profile.name, 1]);
        await conn.query(
          `INSERT INTO radusergroup (username, groupname, priority) VALUES ${rugPlaceholders}`,
          rugValues
        );

        const vcPlaceholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(',');
        const vcValues = chunk.flatMap((c) => [
          batchId,
          targetResellerId,
          profile.id,
          c.username,
          c.cleartextPassword,
          c.serialNumber,
          'UNUSED',
        ]);
        await conn.query(
          `INSERT INTO voucher_cards (batch_id, reseller_id, profile_id, username, cleartext_password, serial_number, status)
           VALUES ${vcPlaceholders}`,
          vcValues
        );
      }

      // 6. Deduct Reseller Balance & Ledger
      const balanceAfter = Number((balanceBefore - totalCost).toFixed(2));
      await conn.query('UPDATE resellers SET balance = ? WHERE id = ?', [balanceAfter, targetResellerId]);
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
          `توليد ${quantity} كرت (${profile.display_name}) - دفعة ${batchCode}`,
        ]
      );

      await conn.commit();
      return {
        batchId,
        batchCode,
        quantity,
        profileName: profile.name,
        profileDisplayName: profile.display_name,
        price: Number(profile.price),
        totalCost,
        balanceAfter,
        cards,
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async getBatchForPrint(batchId, actor) {
    const params = [batchId];
    let rbacSql = '';
    if (actor.role !== 'SUPER_ADMIN') {
      rbacSql = 'AND vb.reseller_id = ?';
      params.push(actor.id);
    }

    const [batches] = await this.pool.query(
      `SELECT vb.*, pm.display_name AS profile_display_name, pm.price, pm.speed_limit,
              pm.time_limit, pm.data_limit_mb, pm.validity_days, r.name AS reseller_name
       FROM voucher_batches vb
       LEFT JOIN profiles_meta pm ON pm.id = vb.profile_id
       LEFT JOIN resellers r ON r.id = vb.reseller_id
       WHERE vb.id = ? ${rbacSql}`,
      params
    );

    if (batches.length === 0) {
      throw new Error('الدفعة غير موجودة أو غير مصرح لك بالوصول إليها');
    }

    const [cards] = await this.pool.query(
      `SELECT username, cleartext_password AS cleartextPassword, serial_number AS serialNumber, status
       FROM voucher_cards
       WHERE batch_id = ?
       ORDER BY id ASC`,
      [batchId]
    );

    return { batch: batches[0], cards };
  }

  // --- Cards Directory, Pagination, Filtering & Bulk Actions ---
  _buildCardsFilterClause(actor, filters = {}, { includeStatus = true } = {}) {
    const isSuper = actor.role === 'SUPER_ADMIN';
    const conditions = [];
    const params = [];

    if (!isSuper) {
      conditions.push('vc.reseller_id = ?');
      params.push(actor.id);
    } else if (filters.resellerId && filters.resellerId !== 'ALL') {
      const rId = Number(filters.resellerId);
      if (Number.isFinite(rId) && rId > 0) {
        conditions.push('vc.reseller_id = ?');
        params.push(rId);
      }
    }

    if (filters.profileId && filters.profileId !== 'ALL') {
      const pId = Number(filters.profileId);
      if (Number.isFinite(pId) && pId > 0) {
        conditions.push('vc.profile_id = ?');
        params.push(pId);
      }
    }

    if (filters.batchId && filters.batchId !== 'ALL') {
      const bId = Number(filters.batchId);
      if (Number.isFinite(bId) && bId > 0) {
        conditions.push('vc.batch_id = ?');
        params.push(bId);
      }
    }

    if (includeStatus && filters.status && filters.status !== 'ALL') {
      conditions.push('vc.status = ?');
      params.push(String(filters.status));
    }

    const olderDays = Number(filters.expiredOlderThanDays);
    if (includeStatus && Number.isFinite(olderDays) && olderDays > 0) {
      conditions.push(
        `vc.status = 'EXPIRED' AND COALESCE(vc.expires_at, vc.first_used_at, vc.created_at) <= DATE_SUB(NOW(), INTERVAL ? DAY)`
      );
      params.push(Math.floor(olderDays));
    }

    const search = String(filters.search || '').trim();
    if (search) {
      const term = `%${search}%`;
      conditions.push(
        `(vc.username LIKE ? OR vc.serial_number LIKE ? OR EXISTS (SELECT 1 FROM radacct ra_s WHERE ra_s.username = vc.username AND (ra_s.framedipaddress LIKE ? OR ra_s.callingstationid LIKE ?)))`
      );
      params.push(term, term, term, term);
    }

    return {
      whereClause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
      params,
    };
  }

  async getCardsDirectory(actor, filters = {}) {
    const limit = normalizePageSize(filters.limit);
    const requestedPage = Math.max(1, parseInt(filters.page, 10) || 1);

    const sortMap = {
      oldest: 'vc.id ASC',
      username_asc: 'vc.username ASC',
      expires_asc: '(vc.expires_at IS NULL) ASC, vc.expires_at ASC, vc.id DESC',
      newest: 'vc.id DESC',
    };
    const orderBy = sortMap[filters.sort] || sortMap.newest;

    const baseFilter = this._buildCardsFilterClause(actor, filters, { includeStatus: false });
    const fullFilter = this._buildCardsFilterClause(actor, filters, { includeStatus: true });

    const [statusRows] = await this.pool.query(
      `SELECT
         COUNT(*) AS total_all,
         COALESCE(SUM(vc.status = 'UNUSED'), 0) AS cnt_unused,
         COALESCE(SUM(vc.status = 'ACTIVE'), 0) AS cnt_active,
         COALESCE(SUM(vc.status = 'EXPIRED'), 0) AS cnt_expired,
         COALESCE(SUM(vc.status = 'DISABLED'), 0) AS cnt_disabled
       FROM voucher_cards vc
       ${baseFilter.whereClause}`,
      baseFilter.params
    );

    const cntRow = statusRows[0] || {};
    const [totalRows] = await this.pool.query(
      `SELECT COUNT(*) AS total FROM voucher_cards vc ${fullFilter.whereClause}`,
      fullFilter.params
    );
    const total = Number(totalRows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(requestedPage, totalPages);
    const offset = (safePage - 1) * limit;

    const [baseRows] = await this.pool.query(
      `SELECT vc.*,
              pm.name AS profile_name,
              pm.display_name AS profile_display_name,
              pm.speed_limit,
              pm.data_limit_mb,
              pm.time_limit,
              pm.validity_days,
              r.username AS reseller_username,
              vb.batch_code
       FROM voucher_cards vc
       LEFT JOIN profiles_meta pm ON pm.id = vc.profile_id
       LEFT JOIN resellers r ON r.id = vc.reseller_id
       LEFT JOIN voucher_batches vb ON vb.id = vc.batch_id
       ${fullFilter.whereClause}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
      [...fullFilter.params, limit, offset]
    );

    let cards = [];
    if (baseRows.length > 0) {
      const usernames = baseRows.map((row) => row.username);
      const [activeRows] = await this.pool.query(
        `SELECT ra.username,
                ra.framedipaddress AS last_ip,
                ra.callingstationid AS last_mac,
                COALESCE(ap.ap_ip, ra.nasipaddress) AS modem_ip,
                COALESCE(ap.ap_name, ra.calledstationid, 'Main-Gateway') AS modem_name
         FROM radacct ra
         LEFT JOIN access_points ap ON ap.match_value = ra.calledstationid
         WHERE ra.acctstoptime IS NULL AND ra.username IN (?)
         ORDER BY ra.radacctid DESC`,
        [usernames]
      );

      const activeByUser = new Map();
      for (const act of activeRows) {
        if (!activeByUser.has(act.username)) {
          activeByUser.set(act.username, act);
        }
      }

      const [usageRows] = await this.pool.query(
        `SELECT username,
                MIN(acctstarttime) AS first_session_start,
                COALESCE(SUM(acctsessiontime), 0) AS total_time,
                COALESCE(SUM(acctinputoctets), 0) AS total_up,
                COALESCE(SUM(acctoutputoctets), 0) AS total_down
         FROM radacct
         WHERE username IN (?)
         GROUP BY username`,
        [usernames]
      );

      const usageByUser = new Map();
      for (const u of usageRows) {
        usageByUser.set(u.username, u);
      }

      cards = baseRows.map((row) => {
        const act = activeByUser.get(row.username);
        const usage = usageByUser.get(row.username);
        const firstUsedAt = row.first_used_at || usage?.first_session_start || null;
        let expiresAt = row.expires_at || null;
        if (!expiresAt && firstUsedAt && Number(row.validity_days) > 0) {
          const d = new Date(firstUsedAt);
          if (!Number.isNaN(d.getTime())) {
            d.setDate(d.getDate() + Number(row.validity_days));
            expiresAt = d.toISOString();
          }
        }
        const up = Number(usage?.total_up || 0);
        const down = Number(usage?.total_down || 0);
        return {
          ...row,
          last_ip: act?.last_ip || null,
          last_mac: act?.last_mac || null,
          modem_ip: act?.modem_ip || null,
          modem_name: act?.modem_name || null,
          is_online: Boolean(act),
          used_uptime_seconds: Number(usage?.total_time || 0),
          used_upload_bytes: up,
          used_download_bytes: down,
          used_total_bytes: up + down,
          first_used_at: firstUsedAt,
          expires_at: expiresAt,
        };
      });
    }

    return {
      count: cards.length,
      cards,
      pagination: {
        page: safePage,
        limit,
        total,
        totalPages,
      },
      statusCounts: {
        ALL: Number(cntRow.total_all || 0),
        UNUSED: Number(cntRow.cnt_unused || 0),
        ACTIVE: Number(cntRow.cnt_active || 0),
        EXPIRED: Number(cntRow.cnt_expired || 0),
        DISABLED: Number(cntRow.cnt_disabled || 0),
      },
    };
  }

  async _resolveBulkTargets(actor, payload = {}) {
    const isSuper = actor.role === 'SUPER_ADMIN';
    let rows = [];

    if (payload.selectAllFiltered) {
      const filter = this._buildCardsFilterClause(actor, payload.filters || {}, { includeStatus: true });
      const [found] = await this.pool.query(
        `SELECT vc.username, vc.status FROM voucher_cards vc ${filter.whereClause} ORDER BY vc.id DESC`,
        filter.params
      );
      rows = found;
    } else {
      const uniqueUsernames = [...new Set(
        (Array.isArray(payload.usernames) ? payload.usernames : [])
          .map((u) => String(u || '').trim())
          .filter(Boolean)
      )];
      if (uniqueUsernames.length > 0) {
        for (const chunk of chunkItems(uniqueUsernames, BULK_ACTION_CHUNK_SIZE)) {
          const sql = isSuper
            ? `SELECT username, status FROM voucher_cards WHERE username IN (?)`
            : `SELECT username, status FROM voucher_cards WHERE username IN (?) AND reseller_id = ?`;
          const params = isSuper ? [chunk] : [chunk, actor.id];
          const [found] = await this.pool.query(sql, params);
          rows.push(...found);
        }
      }
    }

    const onlineSet = new Set();
    if (rows.length > 0) {
      const allNames = rows.map((r) => r.username);
      for (const chunk of chunkItems(allNames, BULK_ACTION_CHUNK_SIZE)) {
        const [onlineRows] = await this.pool.query(
          `SELECT DISTINCT username FROM radacct WHERE acctstoptime IS NULL AND username IN (?)`,
          [chunk]
        );
        for (const r of onlineRows) {
          onlineSet.add(r.username);
        }
      }
    }

    return { rows, onlineSet };
  }

  async previewBulkCardAction(actor, payload = {}) {
    const { rows, onlineSet } = await this._resolveBulkTargets(actor, payload);
    const breakdown = { UNUSED: 0, ACTIVE: 0, EXPIRED: 0, DISABLED: 0 };
    let onlineCount = 0;
    let nonActiveCount = 0;

    for (const r of rows) {
      if (Object.prototype.hasOwnProperty.call(breakdown, r.status)) {
        breakdown[r.status] += 1;
      }
      const isOnline = onlineSet.has(r.username);
      if (isOnline) onlineCount += 1;
      if (r.status !== 'ACTIVE' && !isOnline) nonActiveCount += 1;
    }

    return {
      total: rows.length,
      onlineCount,
      nonActiveCount,
      breakdown,
    };
  }

  async _disconnectOnlineUsernames(usernames, terminateCause = 'Admin-Bulk-Reset (CoA)') {
    if (!usernames.length) return 0;
    const activeSessions = [];
    for (const chunk of chunkItems(usernames, BULK_ACTION_CHUNK_SIZE)) {
      const [rows] = await this.pool.query(
        `SELECT ra.radacctid, ra.username, ra.nasipaddress, ra.framedipaddress, ra.acctsessionid, n.secret AS nas_secret
         FROM radacct ra
         LEFT JOIN nas n ON n.nasname = ra.nasipaddress
         WHERE ra.acctstoptime IS NULL AND ra.username IN (?)`,
        [chunk]
      );
      activeSessions.push(...rows);
    }

    if (activeSessions.length === 0) return 0;

    const coaPort = process.env.MikroTik_COA_PORT || 3799;
    const defaultSecret = process.env.DEFAULT_NAS_SECRET || 'RadSecret2026!';
    await runWithConcurrency(activeSessions, 8, async (sess) => {
      const secret = sess.nas_secret || defaultSecret;
      const targetHostPort = `${sess.nasipaddress}:${coaPort}`;
      await this.sendRadclientDisconnect(targetHostPort, secret, sess.username, sess.acctsessionid, sess.framedipaddress);
    });

    const sessionIds = activeSessions.map((s) => s.radacctid);
    for (const idChunk of chunkItems(sessionIds, BULK_ACTION_CHUNK_SIZE)) {
      await this.pool.query(
        `UPDATE radacct SET acctstoptime = NOW(), acctterminatecause = ? WHERE radacctid IN (?)`,
        [terminateCause, idChunk]
      );
    }

    return activeSessions.length;
  }

  async executeBulkCardAction(actor, payload = {}) {
    const action = String(payload.action || '').trim();
    const resetMode = String(payload.resetMode || 'FULL_RESET').trim();
    if (!ALLOWED_BULK_ACTIONS.has(action)) {
      throw new Error('الإجراء الجماعي المطلوب غير مدعوم');
    }

    const { rows, onlineSet } = await this._resolveBulkTargets(actor, payload);
    const excludeActive = Boolean(payload.excludeActive);
    const targetRows = excludeActive
      ? rows.filter((r) => r.status !== 'ACTIVE' && !onlineSet.has(r.username))
      : rows;

    const skipped = rows.length - targetRows.length;
    if (targetRows.length === 0) {
      return {
        totalTargeted: 0,
        succeeded: 0,
        skipped,
        disconnectedOnline: 0,
        action,
        message: skipped > 0
          ? `لم يتم تنفيذ الإجراء: تم استثناء جميع الكروت المحددة (${skipped}) لأنها نشطة أو متصلة حالياً`
          : 'لا توجد كروت مطابقة لتنفيذ الإجراء عليها',
      };
    }

    const usernames = targetRows.map((r) => r.username);
    let disconnectedOnline = 0;

    if (action === 'disconnect') {
      disconnectedOnline = await this._disconnectOnlineUsernames(usernames, 'Admin-Bulk-Disconnect (CoA)');
      return {
        totalTargeted: usernames.length,
        succeeded: disconnectedOnline,
        skipped,
        disconnectedOnline,
        action,
        message: disconnectedOnline > 0
          ? `تم فصل ${disconnectedOnline} جلسة نشطة من أصل ${usernames.length} كرت محدد`
          : 'لا توجد جلسات متصلة حالياً ضمن الكروت المحددة',
      };
    }

    if (action === 'disable') {
      for (const chunk of chunkItems(usernames, BULK_ACTION_CHUNK_SIZE)) {
        await this.pool.query(
          `DELETE FROM radcheck WHERE username IN (?) AND attribute = 'Auth-Type'`,
          [chunk]
        );
        const insertValues = chunk.map((u) => [u, 'Auth-Type', ':=', 'Reject']);
        await this.pool.query(
          `INSERT INTO radcheck (username, attribute, op, value) VALUES ?`,
          [insertValues]
        );
        await this.pool.query(
          `UPDATE voucher_cards SET status = 'DISABLED' WHERE username IN (?)`,
          [chunk]
        );
      }
      disconnectedOnline = await this._disconnectOnlineUsernames(usernames, 'Admin-Bulk-Disable');
      return {
        totalTargeted: usernames.length,
        succeeded: usernames.length,
        skipped,
        disconnectedOnline,
        action,
        message: `تم تعطيل ${usernames.length} كرت بنجاح` + (disconnectedOnline ? ` (وفصل ${disconnectedOnline} جلسة نشطة)` : ''),
      };
    }

    if (action === 'enable') {
      for (const chunk of chunkItems(usernames, BULK_ACTION_CHUNK_SIZE)) {
        await this.pool.query(
          `DELETE FROM radcheck WHERE username IN (?) AND attribute = 'Auth-Type'`,
          [chunk]
        );
        await this.pool.query(
          `UPDATE voucher_cards
           SET status = CASE WHEN first_used_at IS NULL THEN 'UNUSED' ELSE 'ACTIVE' END
           WHERE username IN (?)`,
          [chunk]
        );
      }
      return {
        totalTargeted: usernames.length,
        succeeded: usernames.length,
        skipped,
        disconnectedOnline: 0,
        action,
        message: `تم تمكين ${usernames.length} كرت وإعادتها للعمل بنجاح`,
      };
    }

    if (action === 'reset') {
      if (resetMode === 'MAC_ONLY') {
        for (const chunk of chunkItems(usernames, BULK_ACTION_CHUNK_SIZE)) {
          await this.pool.query(
            `DELETE FROM radcheck WHERE username IN (?) AND attribute = 'Calling-Station-Id'`,
            [chunk]
          );
        }
        return {
          totalTargeted: usernames.length,
          succeeded: usernames.length,
          skipped,
          disconnectedOnline: 0,
          action,
          message: `تم فك قفل الماك أدريس لـ ${usernames.length} كرت بنجاح`,
        };
      }

      if (resetMode === 'DATA_TIME') {
        for (const chunk of chunkItems(usernames, BULK_ACTION_CHUNK_SIZE)) {
          await this.pool.query(
            `INSERT INTO radacct_archive SELECT * FROM radacct WHERE username IN (?) AND acctstoptime IS NOT NULL`,
            [chunk]
          ).catch(() => {});
          await this.pool.query(
            `DELETE FROM radacct WHERE username IN (?) AND acctstoptime IS NOT NULL`,
            [chunk]
          );
          await this.pool.query(
            `UPDATE voucher_cards SET status = 'ACTIVE' WHERE username IN (?) AND status = 'EXPIRED'`,
            [chunk]
          );
        }
        return {
          totalTargeted: usernames.length,
          succeeded: usernames.length,
          skipped,
          disconnectedOnline: 0,
          action,
          message: `تم تصفير استهلاك البيانات والوقت لـ ${usernames.length} كرت بنجاح`,
        };
      }

      // FULL_RESET
      disconnectedOnline = await this._disconnectOnlineUsernames(usernames, 'Admin-Bulk-Reset');
      for (const chunk of chunkItems(usernames, BULK_ACTION_CHUNK_SIZE)) {
        await this.pool.query(
          `DELETE FROM radcheck WHERE username IN (?) AND attribute IN ('Calling-Station-Id', 'Auth-Type')`,
          [chunk]
        );
        await this.pool.query(
          `INSERT INTO radacct_archive SELECT * FROM radacct WHERE username IN (?)`,
          [chunk]
        ).catch(() => {});
        await this.pool.query(`DELETE FROM radacct WHERE username IN (?)`, [chunk]);
        await this.pool.query(
          `UPDATE voucher_cards SET status = 'UNUSED', first_used_at = NULL, expires_at = NULL WHERE username IN (?)`,
          [chunk]
        );
      }
      return {
        totalTargeted: usernames.length,
        succeeded: usernames.length,
        skipped,
        disconnectedOnline,
        action,
        message: `تم التصفير الشامل لـ ${usernames.length} كرت وإعادتها ككروت جديدة`,
      };
    }

    // delete
    disconnectedOnline = await this._disconnectOnlineUsernames(usernames, 'Admin-Bulk-Delete');
    for (const chunk of chunkItems(usernames, BULK_ACTION_CHUNK_SIZE)) {
      const conn = await this.pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM radcheck WHERE username IN (?)', [chunk]);
        await conn.query('DELETE FROM radreply WHERE username IN (?)', [chunk]);
        await conn.query('DELETE FROM radusergroup WHERE username IN (?)', [chunk]);
        await conn.query('DELETE FROM voucher_cards WHERE username IN (?)', [chunk]);
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    }

    return {
      totalTargeted: usernames.length,
      succeeded: usernames.length,
      skipped,
      disconnectedOnline,
      action,
      message:
        `تم حذف ${usernames.length} كرت نهائياً من النظام وجداول FreeRADIUS` +
        (disconnectedOnline ? ` (تم فصل ${disconnectedOnline} جلسة نشطة قبل الحذف)` : '') +
        (skipped ? ` — تم استثناء ${skipped} كرت نشط` : ''),
    };
  }

  async exportCards(actor, payload = {}) {
    const { rows } = await this._resolveBulkTargets(actor, payload);
    const capped = rows.slice(0, 5000).map((r) => r.username);
    if (capped.length === 0) return { cards: [] };

    const exported = [];
    for (const chunk of chunkItems(capped, BULK_ACTION_CHUNK_SIZE)) {
      const [found] = await this.pool.query(
        `SELECT vc.username, vc.cleartext_password, vc.serial_number, vc.status,
                pm.name AS profile_name, pm.display_name AS profile_display_name,
                vb.batch_code, r.username AS reseller_username,
                vc.first_used_at, vc.expires_at, vc.created_at
         FROM voucher_cards vc
         LEFT JOIN profiles_meta pm ON pm.id = vc.profile_id
         LEFT JOIN voucher_batches vb ON vb.id = vc.batch_id
         LEFT JOIN resellers r ON r.id = vc.reseller_id
         WHERE vc.username IN (?)
         ORDER BY vc.id DESC`,
        [chunk]
      );
      exported.push(...found);
    }
    return { cards: exported };
  }

  // --- Active Sessions (Live CoA) ---
  async getActiveSessions(actor, search = '') {
    const isSuper = actor.role === 'SUPER_ADMIN';
    const conditions = ['ra.acctstoptime IS NULL'];
    const params = [];

    if (!isSuper) {
      conditions.push('vc.reseller_id = ?');
      params.push(actor.id);
    }

    if (search) {
      const term = `%${search}%`;
      conditions.push('(ra.username LIKE ? OR ra.framedipaddress LIKE ? OR ra.callingstationid LIKE ? OR ra.nasipaddress LIKE ?)');
      params.push(term, term, term, term);
    }

    const sql = `
      SELECT ra.radacctid, ra.acctsessionid, ra.username, ra.nasipaddress,
             ra.framedipaddress, ra.callingstationid, ra.calledstationid,
             ra.acctstarttime, ra.acctsessiontime,
             COALESCE(ra.acctinputoctets, 0) AS acctinputoctets,
             COALESCE(ra.acctoutputoctets, 0) AS acctoutputoctets,
             (COALESCE(ra.acctinputoctets, 0) + COALESCE(ra.acctoutputoctets, 0)) AS total_bytes,
             COALESCE(ap.ap_ip, ra.nasipaddress) AS modem_ip,
             COALESCE(ap.ap_name, ra.calledstationid, 'Hotspot-AP') AS modem_name,
             COALESCE(vc.status, 'ACTIVE') AS card_status,
             n.secret AS nas_secret
      FROM radacct ra
      INNER JOIN voucher_cards vc ON vc.username = ra.username
      LEFT JOIN access_points ap ON ap.match_value = ra.calledstationid
      LEFT JOIN nas n ON n.nasname = ra.nasipaddress
      WHERE ${conditions.join(' AND ')}
      ORDER BY ra.acctstarttime DESC LIMIT 500
    `;

    const [rows] = await this.pool.query(sql, params);
    return { count: rows.length, sessions: rows };
  }

  // --- Card Details (MikroTik User Manager Style) ---
  async getCardDetails(username) {
    const [cards] = await this.pool.query(
      `SELECT vc.*,
              pm.name AS profile_name,
              pm.display_name AS profile_display_name,
              pm.speed_limit,
              pm.time_limit,
              pm.data_limit_mb,
              pm.validity_days,
              pm.price,
              r.username AS reseller_username
       FROM voucher_cards vc
       LEFT JOIN profiles_meta pm ON pm.id = vc.profile_id
       LEFT JOIN resellers r ON r.id = vc.reseller_id
       WHERE vc.username = ? LIMIT 1`,
      [username]
    );

    if (cards.length === 0) {
      throw new Error('الكرت غير موجود في قاعدة البيانات');
    }

    const card = cards[0];

    const [history] = await this.pool.query(
      `SELECT ra.*, COALESCE(ap.ap_ip, ra.nasipaddress) AS modem_ip, COALESCE(ap.ap_name, ra.calledstationid) AS modem_name
       FROM radacct ra
       LEFT JOIN access_points ap ON ap.match_value = ra.calledstationid
       WHERE ra.username = ?
       ORDER BY ra.radacctid DESC LIMIT 50`,
      [username]
    );

    const active = history.find((s) => s.acctstoptime === null) || null;
    const latest = active || history[0] || null;
    const isOnline = Boolean(active);

    const [callerIdCheck] = await this.pool.query(
      `SELECT value FROM radcheck WHERE username = ? AND attribute = 'Calling-Station-Id' LIMIT 1`,
      [username]
    );
    const [customRateRow] = await this.pool.query(
      `SELECT value FROM radreply WHERE username = ? AND attribute = 'Mikrotik-Rate-Limit' LIMIT 1`,
      [username]
    );

    const [totals] = await this.pool.query(
      `SELECT COALESCE(SUM(acctinputoctets), 0) AS up,
              COALESCE(SUM(acctoutputoctets), 0) AS down,
              COALESCE(SUM(acctsessiontime), 0) AS secs,
              MIN(acctstarttime) AS first_start
       FROM radacct WHERE username = ?`,
      [username]
    );

    const usedUpload = Number(totals[0]?.up || 0);
    const usedDownload = Number(totals[0]?.down || 0);
    const usedTotal = usedUpload + usedDownload;
    const usedUptime = Number(totals[0]?.secs || 0);
    const effectiveFirstUsedAt = card.first_used_at || totals[0]?.first_start || null;
    let effectiveExpiresAt = card.expires_at || null;
    if (!effectiveExpiresAt && effectiveFirstUsedAt && Number(card.validity_days) > 0) {
      effectiveExpiresAt = new Date(
        new Date(effectiveFirstUsedAt).getTime() + Number(card.validity_days) * 86400000
      ).toISOString();
    }
    const totalQuotaBytes = card.data_limit_mb ? Number(card.data_limit_mb) * 1024 * 1024 : null;
    const remainingBytes = totalQuotaBytes !== null ? Math.max(0, totalQuotaBytes - usedTotal) : null;

    const [profiles] = await this.pool.query('SELECT * FROM profiles_meta WHERE is_active = 1 ORDER BY price ASC');

    return {
      card: {
        ...card,
        speed_limit: customRateRow[0]?.value || card.speed_limit || '',
        first_used_at: effectiveFirstUsedAt,
        expires_at: effectiveExpiresAt,
        is_online: isOnline,
        bound_mac: callerIdCheck[0]?.value || null,
        last_ip: latest?.framedipaddress || 'غير معروف',
        last_mac: latest?.callingstationid || callerIdCheck[0]?.value || 'غير معروف',
        modem_ip: latest?.modem_ip || 'لم يتصل بعد',
        modem_name: latest?.modem_name || '-',
        used_upload_bytes: usedUpload,
        used_download_bytes: usedDownload,
        used_total_bytes: usedTotal,
        remaining_bytes: remainingBytes,
        used_uptime_seconds: usedUptime,
        remaining_seconds: card.time_limit ? Math.max(0, card.time_limit - usedUptime) : null,
        last_seen: isOnline ? 'متصل الآن (Active)' : (latest?.acctstoptime ? new Date(latest.acctstoptime).toLocaleString('en-US') : 'لم يتصل بعد'),
      },
      sessions: history,
      availableProfiles: profiles,
    };
  }

  // --- Save / Update Card Details ---
  async updateCardDetails(oldUsername, body) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      const newUsername = String(body.username || oldUsername).trim();
      if (!newUsername) throw new Error('اسم المستخدم لا يمكن أن يكون فارغاً');

      const newPassword = String(body.cleartext_password || '').trim();
      const boundMac = String(body.bound_mac || '').trim();
      const customRate = String(body.custom_rate_limit || '').trim();
      const isDisabled = Boolean(body.is_disabled);
      const profileId = Number(body.profile_id);

      if (newUsername !== oldUsername) {
        const [dup] = await conn.query('SELECT id FROM voucher_cards WHERE username = ?', [newUsername]);
        if (dup.length > 0) throw new Error('اسم المستخدم الجديد مستخدم بالفعل');
      }

      if (newPassword) {
        await conn.query(
          `UPDATE radcheck SET value = ? WHERE username = ? AND attribute = 'Cleartext-Password'`,
          [newPassword, oldUsername]
        );
      }

      // Per-card rate limit override in `radreply`
      await conn.query(`DELETE FROM radreply WHERE username = ? AND attribute = 'Mikrotik-Rate-Limit'`, [oldUsername]);
      if (customRate) {
        const [prof] = await conn.query('SELECT speed_limit FROM profiles_meta WHERE id = ?', [profileId || 0]);
        if (!prof[0] || String(prof[0].speed_limit || '').trim() !== customRate) {
          await conn.query(
            `INSERT INTO radreply (username, attribute, op, value) VALUES (?, 'Mikrotik-Rate-Limit', ':=', ?)`,
            [oldUsername, customRate]
          );
        }
      }

      // MAC Binding in radcheck
      await conn.query(`DELETE FROM radcheck WHERE username = ? AND attribute = 'Calling-Station-Id'`, [oldUsername]);
      if (boundMac) {
        await conn.query(
          `INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Calling-Station-Id', ':=', ?)`,
          [oldUsername, boundMac]
        );
      }

      // Disable / Enable in radcheck
      await conn.query(`DELETE FROM radcheck WHERE username = ? AND attribute = 'Auth-Type'`, [oldUsername]);
      if (isDisabled) {
        await conn.query(
          `INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Auth-Type', ':=', 'Reject')`,
          [oldUsername]
        );
      }

      if (profileId) {
        const [prof] = await conn.query('SELECT name FROM profiles_meta WHERE id = ?', [profileId]);
        if (prof.length > 0) {
          await conn.query('UPDATE radusergroup SET groupname = ? WHERE username = ?', [prof[0].name, oldUsername]);
        }
      }

      await conn.query(
        `UPDATE voucher_cards
         SET profile_id = COALESCE(?, profile_id),
             cleartext_password = COALESCE(?, cleartext_password),
             status = CASE WHEN ? = 1 THEN 'DISABLED' WHEN status = 'DISABLED' AND ? = 0 THEN IF(first_used_at IS NULL, 'UNUSED', 'ACTIVE') ELSE status END,
             notes = ?
         WHERE username = ?`,
        [profileId || null, newPassword || null, isDisabled ? 1 : 0, isDisabled ? 1 : 0, body.notes || '', oldUsername]
      );

      if (newUsername !== oldUsername) {
        await conn.query('UPDATE radcheck SET username = ? WHERE username = ?', [newUsername, oldUsername]);
        await conn.query('UPDATE radreply SET username = ? WHERE username = ?', [newUsername, oldUsername]);
        await conn.query('UPDATE radusergroup SET username = ? WHERE username = ?', [newUsername, oldUsername]);
        await conn.query('UPDATE radacct SET username = ? WHERE username = ?', [newUsername, oldUsername]);
        await conn.query('UPDATE voucher_cards SET username = ? WHERE username = ?', [newUsername, oldUsername]);
      }

      await conn.commit();
      return this.getCardDetails(newUsername);
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  // --- Execute Card Actions (Disconnect, Disable, Enable, Reset, Delete) ---
  async executeCardAction(username, action, resetMode = 'FULL_RESET') {
    if (action === 'disconnect') {
      const [sessions] = await this.pool.query(
        `SELECT ra.radacctid, ra.nasipaddress, ra.framedipaddress, ra.acctsessionid, n.secret AS nas_secret
         FROM radacct ra
         LEFT JOIN nas n ON n.nasname = ra.nasipaddress
         WHERE ra.username = ? AND ra.acctstoptime IS NULL LIMIT 1`,
        [username]
      );

      if (sessions.length === 0) {
        throw new Error(`المشترك (${username}) غير متصل حالياً`);
      }

      const sess = sessions[0];
      const nasSecret = sess.nas_secret || process.env.DEFAULT_NAS_SECRET || 'RadSecret2026!';
      const targetHostPort = `${sess.nasipaddress}:${process.env.MikroTik_COA_PORT || 3799}`;

      const coaResult = await this.sendRadclientDisconnect(targetHostPort, nasSecret, username, sess.acctsessionid, sess.framedipaddress);

      await this.pool.query(
        `UPDATE radacct SET acctstoptime = NOW(), acctterminatecause = 'Admin-Reset (CoA)' WHERE radacctid = ?`,
        [sess.radacctid]
      );

      return { message: `تم فصل جلسة المشترك (${username}) عبر CoA/PoD (${coaResult})` };
    }

    if (action === 'disable') {
      await this.pool.query(`DELETE FROM radcheck WHERE username = ? AND attribute = 'Auth-Type'`, [username]);
      await this.pool.query(
        `INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Auth-Type', ':=', 'Reject')`,
        [username]
      );
      await this.pool.query(`UPDATE voucher_cards SET status = 'DISABLED' WHERE username = ?`, [username]);
      try { await this.executeCardAction(username, 'disconnect'); } catch {}
      return { message: `تم تعطيل الكرت (${username}) في radcheck وفصل جلسته` };
    }

    if (action === 'enable') {
      await this.pool.query(`DELETE FROM radcheck WHERE username = ? AND attribute = 'Auth-Type'`, [username]);
      await this.pool.query(
        `UPDATE voucher_cards
         SET status = CASE WHEN first_used_at IS NULL THEN 'UNUSED' ELSE 'ACTIVE' END
         WHERE username = ?`,
        [username]
      );
      return { message: `تم تمكين الكرت (${username}) وإعادته للعمل` };
    }

    if (action === 'reset') {
      if (resetMode === 'MAC_ONLY') {
        await this.pool.query(`DELETE FROM radcheck WHERE username = ? AND attribute = 'Calling-Station-Id'`, [username]);
        return { message: `تم فك قفل الماك أدريس للكرت (${username}) بنجاح` };
      }

      if (resetMode === 'DATA_TIME') {
        await this.pool.query(`INSERT INTO radacct_archive SELECT * FROM radacct WHERE username = ? AND acctstoptime IS NOT NULL`, [username]).catch(() => {});
        await this.pool.query(`DELETE FROM radacct WHERE username = ? AND acctstoptime IS NOT NULL`, [username]);
        await this.pool.query(`UPDATE voucher_cards SET status = 'ACTIVE' WHERE username = ? AND status = 'EXPIRED'`, [username]);
        return { message: `تم تصفير استهلاك البيانات والوقت للكرت (${username})` };
      }

      await this.pool.query(`DELETE FROM radcheck WHERE username = ? AND attribute IN ('Calling-Station-Id', 'Auth-Type')`, [username]);
      await this.pool.query(`INSERT INTO radacct_archive SELECT * FROM radacct WHERE username = ?`, [username]).catch(() => {});
      await this.pool.query(`DELETE FROM radacct WHERE username = ?`, [username]);
      await this.pool.query(
        `UPDATE voucher_cards SET status = 'UNUSED', first_used_at = NULL, expires_at = NULL WHERE username = ?`,
        [username]
      );
      return { message: `تم التصفير الشامل للكرت (${username}) وإعادته ككرت جديد غير مستخدم` };
    }

    if (action === 'delete') {
      try { await this.executeCardAction(username, 'disconnect'); } catch {}
      await this.pool.query('DELETE FROM radcheck WHERE username = ?', [username]);
      await this.pool.query('DELETE FROM radreply WHERE username = ?', [username]);
      await this.pool.query('DELETE FROM radusergroup WHERE username = ?', [username]);
      await this.pool.query('DELETE FROM voucher_cards WHERE username = ?', [username]);
      return { message: `تم حذف الكرت (${username}) نهائياً من قاعدة البيانات وجداول FreeRADIUS` };
    }

    throw new Error('إجراء غير مدعوم');
  }

  sendRadclientDisconnect(targetHostPort, secret, username, sessionId, ip) {
    return new Promise((resolve) => {
      const child = spawn('radclient', ['-x', '-r', '2', '-t', '2', targetHostPort, 'disconnect', secret]);
      const payload = [
        `User-Name = "${username}"`,
        sessionId ? `Acct-Session-Id = "${sessionId}"` : '',
        ip ? `Framed-IP-Address = ${ip}` : '',
      ].filter(Boolean).join('\n') + '\n';

      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', (code) => {
        if (out.includes('Disconnect-ACK')) resolve('Disconnect-ACK');
        else if (code === 0) resolve('Sent');
        else resolve('Closed in DB');
      });
      child.on('error', () => resolve('Closed in DB'));
      child.stdin.write(payload);
      child.stdin.end();
    });
  }

  // --- Profiles Management (`profiles_meta` + `radgroupreply` + `radgroupcheck`) ---
  _normalizeProfileDto(dto) {
    const name = String(dto.name || '').trim();
    if (!name) throw new Error('الاسم البرمجي للباقة مطلوب');

    const displayName = String(dto.displayName ?? dto.display_name ?? '').trim() || name;
    const price = Number(dto.price || 0);
    const costPrice = Number(dto.costPrice ?? dto.cost_price ?? 0);
    const speedLimit = String(dto.speedLimit ?? dto.speed_limit ?? '').trim();

    const rawTimeLimit = dto.timeLimit ?? dto.time_limit;
    const timeLimit = Number(rawTimeLimit) > 0 ? Math.round(Number(rawTimeLimit)) : null;

    const rawDataLimitMb = dto.dataLimitMb ?? dto.data_limit_mb;
    const dataLimitMb = Number(rawDataLimitMb) > 0 ? Math.round(Number(rawDataLimitMb)) : null;

    const rawValidityDays = dto.validityDays ?? dto.validity_days;
    const validityDays = Number(rawValidityDays) > 0 ? Math.round(Number(rawValidityDays)) : null;

    const simultaneousUse = Number(dto.simultaneousUse ?? dto.simultaneous_use ?? 1) || 1;
    const portLimit = Number(dto.portLimit ?? dto.port_limit ?? 1) || 1;

    return {
      name,
      displayName,
      price,
      costPrice,
      speedLimit,
      timeLimit,
      dataLimitMb,
      validityDays,
      simultaneousUse,
      portLimit,
    };
  }

  async _syncProfileRadiusTables(conn, p) {
    await conn.query('DELETE FROM radgroupreply WHERE groupname = ?', [p.name]);
    await conn.query('DELETE FROM radgroupcheck WHERE groupname = ?', [p.name]);

    const replies = [
      [p.name, 'Port-Limit', ':=', String(p.portLimit)],
      [p.name, 'Acct-Interim-Interval', ':=', '60'],
    ];
    // Only sync Mikrotik-Rate-Limit when a speed is explicitly specified; empty lets MikroTik Queues handle speed
    if (p.speedLimit) {
      replies.unshift([p.name, 'Mikrotik-Rate-Limit', ':=', p.speedLimit]);
    }
    if (p.timeLimit && p.timeLimit > 0) {
      replies.push([p.name, 'Session-Timeout', ':=', String(p.timeLimit)]);
    }
    if (p.dataLimitMb && p.dataLimitMb > 0) {
      const FOUR_GIB = 4294967296n; // 2^32 threshold for MikroTik 32-bit attribute split
      const totalBytes = BigInt(p.dataLimitMb) * 1048576n; // 1024 * 1024
      const gigawords = totalBytes / FOUR_GIB;
      const lowBytes = totalBytes % FOUR_GIB;
      replies.push([p.name, 'Mikrotik-Total-Limit', ':=', lowBytes.toString()]);
      if (gigawords > 0n) {
        replies.push([p.name, 'Mikrotik-Total-Limit-Gigawords', ':=', gigawords.toString()]);
      }
    }
    const rPh = replies.map(() => '(?, ?, ?, ?)').join(',');
    await conn.query(`INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES ${rPh}`, replies.flat());

    const checks = [[p.name, 'Simultaneous-Use', ':=', String(p.simultaneousUse)]];
    if (p.timeLimit && p.timeLimit > 0) {
      checks.push([p.name, 'Max-All-Session', ':=', String(p.timeLimit)]);
    }
    const cPh = checks.map(() => '(?, ?, ?, ?)').join(',');
    await conn.query(`INSERT INTO radgroupcheck (groupname, attribute, op, value) VALUES ${cPh}`, checks.flat());
  }

  async getProfiles() {
    const [profiles] = await this.pool.query(
      `SELECT pm.*,
              (SELECT COUNT(*) FROM voucher_cards vc WHERE vc.profile_id = pm.id) AS cards_count
       FROM profiles_meta pm
       WHERE pm.is_active = 1
       ORDER BY pm.price ASC`
    );
    const [reply] = await this.pool.query('SELECT * FROM radgroupreply');
    const [check] = await this.pool.query('SELECT * FROM radgroupcheck');
    return profiles.map((p) => ({
      ...p,
      cards_count: Number(p.cards_count || 0),
      radgroupreply: reply.filter((r) => r.groupname === p.name),
      radgroupcheck: check.filter((c) => c.groupname === p.name),
    }));
  }

  async createProfile(dto) {
    const p = this._normalizeProfileDto(dto);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      // profiles_meta.speed_limit is NOT NULL in schema, so store '' when omitted (never '2M/2M')
      const [res] = await conn.query(
        `INSERT INTO profiles_meta
          (name, display_name, price, cost_price, speed_limit, time_limit, data_limit_mb, validity_days, simultaneous_use, port_limit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          p.name,
          p.displayName,
          p.price,
          p.costPrice,
          p.speedLimit,
          p.timeLimit,
          p.dataLimitMb,
          p.validityDays,
          p.simultaneousUse,
          p.portLimit,
        ]
      );

      await this._syncProfileRadiusTables(conn, p);

      await conn.commit();
      return {
        id: res.insertId,
        name: p.name,
        display_name: p.displayName,
        price: p.price,
        cost_price: p.costPrice,
        speed_limit: p.speedLimit,
        time_limit: p.timeLimit,
        data_limit_mb: p.dataLimitMb,
        validity_days: p.validityDays,
        simultaneous_use: p.simultaneousUse,
        port_limit: p.portLimit,
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async updateProfile(id, dto) {
    const profileId = Number(id);
    if (!profileId) throw new Error('معرّف الباقة غير صالح');
    const p = this._normalizeProfileDto(dto);

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      const [existingRows] = await conn.query('SELECT * FROM profiles_meta WHERE id = ? FOR UPDATE', [profileId]);
      if (existingRows.length === 0) throw new Error('الباقة غير موجودة');
      const oldName = existingRows[0].name;

      if (p.name !== oldName) {
        const [dup] = await conn.query('SELECT id FROM profiles_meta WHERE name = ? AND id <> ?', [p.name, profileId]);
        if (dup.length > 0) throw new Error('الاسم البرمجي للباقة مستخدم بالفعل لباقة أخرى');
      }

      await conn.query(
        `UPDATE profiles_meta
         SET name = ?, display_name = ?, price = ?, cost_price = ?, speed_limit = ?,
             time_limit = ?, data_limit_mb = ?, validity_days = ?, simultaneous_use = ?, port_limit = ?
         WHERE id = ?`,
        [
          p.name,
          p.displayName,
          p.price,
          p.costPrice,
          p.speedLimit,
          p.timeLimit,
          p.dataLimitMb,
          p.validityDays,
          p.simultaneousUse,
          p.portLimit,
          profileId,
        ]
      );

      if (p.name !== oldName) {
        await conn.query('UPDATE radusergroup SET groupname = ? WHERE groupname = ?', [p.name, oldName]);
        await conn.query('DELETE FROM radgroupreply WHERE groupname = ?', [oldName]);
        await conn.query('DELETE FROM radgroupcheck WHERE groupname = ?', [oldName]);
      }

      await this._syncProfileRadiusTables(conn, p);

      await conn.commit();
      return {
        id: profileId,
        name: p.name,
        display_name: p.displayName,
        price: p.price,
        cost_price: p.costPrice,
        speed_limit: p.speedLimit,
        time_limit: p.timeLimit,
        data_limit_mb: p.dataLimitMb,
        validity_days: p.validityDays,
        simultaneous_use: p.simultaneousUse,
        port_limit: p.portLimit,
      };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async deleteProfile(id) {
    const profileId = Number(id);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query('SELECT name FROM profiles_meta WHERE id = ? FOR UPDATE', [profileId]);
      if (rows.length === 0) throw new Error('الباقة غير موجودة');
      const groupname = rows[0].name;

      const [usedCards] = await conn.query('SELECT COUNT(*) AS cnt FROM voucher_cards WHERE profile_id = ?', [profileId]);
      const cardsCount = Number(usedCards[0]?.cnt || 0);
      if (cardsCount > 0) {
        throw new Error(`لا يمكن حذف هذه الباقة لوجود ${cardsCount} كرت مرتبط بها. استخدم زر "تعديل" لتحديث الباقة بأمان دون التأثير على الكروت.`);
      }

      const [usedBatches] = await conn.query('SELECT COUNT(*) AS cnt FROM voucher_batches WHERE profile_id = ?', [profileId]);
      const batchesCount = Number(usedBatches[0]?.cnt || 0);
      if (batchesCount > 0) {
        throw new Error(`لا يمكن حذف هذه الباقة لوجود ${batchesCount} دفعة مرتبطة بها. يمكنك تعديل الباقة مباشرة بدلاً من حذفها.`);
      }

      await conn.query('DELETE FROM profiles_meta WHERE id = ?', [profileId]);
      await conn.query('DELETE FROM radgroupreply WHERE groupname = ?', [groupname]);
      await conn.query('DELETE FROM radgroupcheck WHERE groupname = ?', [groupname]);

      await conn.commit();
      return { success: true };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  // --- Resellers & Financial Ledger ---
  async getResellers(actor) {
    if (actor.role !== 'SUPER_ADMIN') {
      const [resellers] = await this.pool.query(
        'SELECT id, name, username, role, phone, balance, credit_limit, is_active, created_at FROM resellers WHERE id = ?',
        [actor.id]
      );
      const [transactions] = await this.pool.query(
        `SELECT rt.*, r.name AS reseller_name
         FROM reseller_transactions rt
         LEFT JOIN resellers r ON r.id = rt.reseller_id
         WHERE rt.reseller_id = ?
         ORDER BY rt.id DESC LIMIT 30`,
        [actor.id]
      );
      return { resellers, transactions };
    }

    const [resellers] = await this.pool.query(
      'SELECT id, name, username, role, phone, balance, credit_limit, is_active, created_at FROM resellers ORDER BY id ASC'
    );
    const [transactions] = await this.pool.query(
      `SELECT rt.*, r.name AS reseller_name
       FROM reseller_transactions rt
       LEFT JOIN resellers r ON r.id = rt.reseller_id
       ORDER BY rt.id DESC LIMIT 40`
    );
    return { resellers, transactions };
  }

  async createReseller(body) {
    const name = String(body.name || '').trim();
    const username = String(body.username || '').trim();
    if (!name || !username) throw new Error('اسم الموزع واسم الدخول مطلوبان');

    const passwordHash = hashPassword(body.password || '123456');
    const [res] = await this.pool.query(
      `INSERT INTO resellers (name, username, password_hash, role, phone, balance, credit_limit, is_active)
       VALUES (?, ?, ?, 'RESELLER', ?, ?, ?, 1)`,
      [name, username, passwordHash, body.phone || '', Number(body.balance || 0), Number(body.credit_limit || 0)]
    );
    return { id: res.insertId, name, username, role: 'RESELLER', balance: Number(body.balance || 0) };
  }

  async topupReseller(resellerId, body) {
    const amount = Number(body.amount || 0);
    if (amount <= 0) throw new Error('مبلغ الشحن يجب أن يكون أكبر من صفر');

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query('SELECT * FROM resellers WHERE id = ? FOR UPDATE', [resellerId]);
      if (rows.length === 0) throw new Error('الموزع غير موجود');
      const r = rows[0];
      const before = Number(r.balance);
      const after = Number((before + amount).toFixed(2));

      await conn.query('UPDATE resellers SET balance = ? WHERE id = ?', [after, resellerId]);
      await conn.query(
        `INSERT INTO reseller_transactions (reseller_id, type, amount, balance_before, balance_after, description)
         VALUES (?, 'DEPOSIT', ?, ?, ?, ?)`,
        [resellerId, amount, before, after, body.description || 'إيداع رصيد مباشر من الإدارة']
      );

      await conn.commit();
      return { ...r, balance: after };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  // --- NAS Routers & Access Points Management ---
  async getRadiusInspector() {
    const [nas] = await this.pool.query('SELECT * FROM nas ORDER BY id ASC');
    let accessPoints = [];
    try {
      const [apRows] = await this.pool.query('SELECT * FROM access_points ORDER BY id ASC');
      accessPoints = apRows;
    } catch {
      accessPoints = [];
    }
    const [radcheck] = await this.pool.query('SELECT * FROM radcheck ORDER BY id DESC LIMIT 25');
    const [radusergroup] = await this.pool.query('SELECT * FROM radusergroup ORDER BY id DESC LIMIT 25');
    const [reply] = await this.pool.query('SELECT * FROM radgroupreply');
    const [check] = await this.pool.query('SELECT * FROM radgroupcheck');
    return {
      nas,
      accessPoints,
      radcheckSample: radcheck,
      radusergroupSample: radusergroup,
      radgroupreply: reply,
      radgroupcheck: check,
    };
  }

  async addNas(body) {
    const nasname = String(body.nasname || '').trim();
    const shortname = String(body.shortname || '').trim();
    const secret = String(body.secret || '').trim();
    if (!nasname || !secret) throw new Error('IP الراوتر (nasname) وكلمة السر (Secret) مطلوبان');

    const [res] = await this.pool.query(
      `INSERT INTO nas (nasname, shortname, type, secret, description)
       VALUES (?, ?, 'other', ?, ?)
       ON DUPLICATE KEY UPDATE shortname = VALUES(shortname), secret = VALUES(secret), description = VALUES(description)`,
      [nasname, shortname || nasname, secret, body.description || 'MikroTik Hotspot Router']
    );
    return { id: res.insertId, nasname, shortname, secret };
  }

  async deleteNas(id) {
    await this.pool.query('DELETE FROM nas WHERE id = ?', [Number(id)]);
    return { success: true };
  }

  async addAccessPoint(body) {
    const matchValue = String(body.match_value || '').trim();
    const apIp = String(body.ap_ip || '').trim();
    const apName = String(body.ap_name || '').trim();
    if (!matchValue || !apIp) throw new Error('اسم السيرفر/المنفذ (Called-Station-Id) و IP المودم مطلوبان');

    const [res] = await this.pool.query(
      `INSERT INTO access_points (nas_ip, match_type, match_value, ap_ip, ap_name)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE ap_ip = VALUES(ap_ip), ap_name = VALUES(ap_name)`,
      [body.nas_ip || null, body.match_type || 'CALLED_STATION_ID', matchValue, apIp, apName || matchValue]
    );
    return { id: res.insertId, match_value: matchValue, ap_ip: apIp, ap_name: apName };
  }

  async deleteAccessPoint(id) {
    await this.pool.query('DELETE FROM access_points WHERE id = ?', [Number(id)]);
    return { success: true };
  }
}
