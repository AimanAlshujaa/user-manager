import { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { dbPool, withTransaction } from '../config/database';
import { ProfileDTO } from '../types/radius.types';

export class ProfileService {
  /**
   * Creates or updates a Hotspot Profile in `profiles_meta` and atomically
   * synchronizes its RADIUS attributes with `radgroupreply` and `radgroupcheck`.
   */
  public async createProfile(dto: ProfileDTO) {
    return withTransaction(async (conn) => {
      const [result] = await conn.query<ResultSetHeader>(
        `INSERT INTO profiles_meta
          (name, display_name, price, cost_price, speed_limit, time_limit, data_limit_mb, validity_days, simultaneous_use, port_limit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          dto.name,
          dto.displayName,
          dto.price,
          dto.costPrice,
          dto.speedLimit,
          dto.timeLimit ?? null,
          dto.dataLimitMb ?? null,
          dto.validityDays ?? null,
          dto.simultaneousUse || 1,
          dto.portLimit || 1,
        ]
      );

      await this.syncRadiusGroupAttributes(conn, dto);
      return { id: result.insertId, ...dto };
    });
  }

  public async updateProfile(profileId: number, dto: ProfileDTO) {
    return withTransaction(async (conn) => {
      const [existing] = await conn.query<RowDataPacket[]>(
        `SELECT id, name FROM profiles_meta WHERE id = ? FOR UPDATE`,
        [profileId]
      );
      if (existing.length === 0) {
        throw new Error('Profile not found.');
      }

      const oldGroupName = existing[0].name;

      await conn.query(
        `UPDATE profiles_meta
         SET name = ?, display_name = ?, price = ?, cost_price = ?, speed_limit = ?,
             time_limit = ?, data_limit_mb = ?, validity_days = ?, simultaneous_use = ?, port_limit = ?
         WHERE id = ?`,
        [
          dto.name,
          dto.displayName,
          dto.price,
          dto.costPrice,
          dto.speedLimit,
          dto.timeLimit ?? null,
          dto.dataLimitMb ?? null,
          dto.validityDays ?? null,
          dto.simultaneousUse || 1,
          dto.portLimit || 1,
          profileId,
        ]
      );

      // If groupname changed, update existing user mappings
      if (oldGroupName !== dto.name) {
        await conn.query(`UPDATE radusergroup SET groupname = ? WHERE groupname = ?`, [
          dto.name,
          oldGroupName,
        ]);
        await conn.query(`DELETE FROM radgroupreply WHERE groupname = ?`, [oldGroupName]);
        await conn.query(`DELETE FROM radgroupcheck WHERE groupname = ?`, [oldGroupName]);
      }

      await this.syncRadiusGroupAttributes(conn, dto);
      return { id: profileId, ...dto };
    });
  }

  /**
   * Synchronizes `radgroupreply` and `radgroupcheck` for MikroTik RouterOS + FreeRADIUS 3.x
   */
  private async syncRadiusGroupAttributes(conn: any, dto: ProfileDTO) {
    // Clear previous group attributes to ensure clean idempotent state
    await conn.query(`DELETE FROM radgroupreply WHERE groupname = ?`, [dto.name]);
    await conn.query(`DELETE FROM radgroupcheck WHERE groupname = ?`, [dto.name]);

    const replyAttributes: Array<[string, string, string, string]> = [
      [dto.name, 'Mikrotik-Rate-Limit', ':=', dto.speedLimit],
      [dto.name, 'Port-Limit', ':=', String(dto.portLimit || 1)],
      [dto.name, 'Acct-Interim-Interval', ':=', '60'], // Real-time 60s accounting updates
    ];

    if (dto.timeLimit && dto.timeLimit > 0) {
      replyAttributes.push([dto.name, 'Session-Timeout', ':=', String(dto.timeLimit)]);
    }

    if (dto.dataLimitMb && dto.dataLimitMb > 0) {
      const totalBytes = BigInt(dto.dataLimitMb) * BigInt(1024 * 1024);
      replyAttributes.push([dto.name, 'Mikrotik-Total-Limit', ':=', totalBytes.toString()]);
    }

    const replyPlaceholders = replyAttributes.map(() => '(?, ?, ?, ?)').join(',');
    await conn.query(
      `INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES ${replyPlaceholders}`,
      replyAttributes.flat()
    );

    // Check attributes (`Simultaneous-Use`, `Max-All-Session`)
    const checkAttributes: Array<[string, string, string, string]> = [
      [dto.name, 'Simultaneous-Use', ':=', String(dto.simultaneousUse || 1)],
    ];

    if (dto.timeLimit && dto.timeLimit > 0) {
      checkAttributes.push([dto.name, 'Max-All-Session', ':=', String(dto.timeLimit)]);
    }

    const checkPlaceholders = checkAttributes.map(() => '(?, ?, ?, ?)').join(',');
    await conn.query(
      `INSERT INTO radgroupcheck (groupname, attribute, op, value) VALUES ${checkPlaceholders}`,
      checkAttributes.flat()
    );
  }

  public async listProfiles() {
    const [rows] = await dbPool.query<RowDataPacket[]>(
      `SELECT * FROM profiles_meta WHERE is_active = 1 ORDER BY price ASC`
    );
    return rows;
  }
}
