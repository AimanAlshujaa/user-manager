import { spawn } from 'child_process';
import { RowDataPacket } from 'mysql2/promise';
import { dbPool } from '../config/database';
import { ActiveSessionRow, AuthUser } from '../types/radius.types';

export class AccountingService {
  /**
   * Retrieves real-time Dashboard KPIs:
   * - Active sessions count & live bandwidth totals (`radacct WHERE acctstoptime IS NULL`)
   * - Voucher lifecycle counts (`UNUSED`, `ACTIVE`, `EXPIRED`)
   * - Daily & Monthly revenue aggregates
   */
  public async getDashboardKpis(actor: AuthUser) {
    const isSuperAdmin = actor.role === 'SUPER_ADMIN';
    const resellerFilter = isSuperAdmin ? '' : 'WHERE vc.reseller_id = ?';
    const resellerParams = isSuperAdmin ? [] : [actor.id];

    // 1. Active Sessions & Traffic from `radacct`
    const [activeRows] = await dbPool.query<RowDataPacket[]>(
      `SELECT
          COUNT(*) AS activeSessions,
          COALESCE(SUM(ra.acctinputoctets), 0) AS totalUploadBytes,
          COALESCE(SUM(ra.acctoutputoctets), 0) AS totalDownloadBytes
       FROM radacct ra
       ${isSuperAdmin ? '' : 'INNER JOIN voucher_cards vc ON vc.username = ra.username'}
       WHERE ra.acctstoptime IS NULL
       ${isSuperAdmin ? '' : 'AND vc.reseller_id = ?'}`,
      resellerParams
    );

    // 2. Cards status breakdown
    const [cardStats] = await dbPool.query<RowDataPacket[]>(
      `SELECT
          SUM(CASE WHEN vc.status = 'UNUSED' THEN 1 ELSE 0 END) AS unusedCards,
          SUM(CASE WHEN vc.status = 'ACTIVE' THEN 1 ELSE 0 END) AS activeCards,
          SUM(CASE WHEN vc.status = 'EXPIRED' THEN 1 ELSE 0 END) AS expiredCards
       FROM voucher_cards vc
       ${resellerFilter}`,
      resellerParams
    );

    // 3. Daily & Monthly Revenue from `voucher_batches`
    const [revenueStats] = await dbPool.query<RowDataPacket[]>(
      `SELECT
          COALESCE(SUM(CASE WHEN DATE(vb.created_at) = CURDATE() THEN vb.total_cost ELSE 0 END), 0) AS dailyRevenue,
          COALESCE(SUM(CASE WHEN YEAR(vb.created_at) = YEAR(CURDATE()) AND MONTH(vb.created_at) = MONTH(CURDATE()) THEN vb.total_cost ELSE 0 END), 0) AS monthlyRevenue
       FROM voucher_batches vb
       ${isSuperAdmin ? '' : 'WHERE vb.reseller_id = ?'}`,
      resellerParams
    );

    return {
      activeSessions: Number(activeRows[0]?.activeSessions || 0),
      totalUploadBytes: Number(activeRows[0]?.totalUploadBytes || 0),
      totalDownloadBytes: Number(activeRows[0]?.totalDownloadBytes || 0),
      vouchers: {
        unused: Number(cardStats[0]?.unusedCards || 0),
        active: Number(cardStats[0]?.activeCards || 0),
        expired: Number(cardStats[0]?.expiredCards || 0),
      },
      revenue: {
        daily: Number(revenueStats[0]?.dailyRevenue || 0),
        monthly: Number(revenueStats[0]?.monthlyRevenue || 0),
      },
    };
  }

  /**
   * Lists all active Hotspot sessions (`radacct WHERE acctstoptime IS NULL`)
   * with optional search by Username, Framed-IP, or MAC (`callingstationid`).
   */
  public async getActiveSessions(actor: AuthUser, search?: string): Promise<ActiveSessionRow[]> {
    const params: any[] = [];
    let sql = `
      SELECT
        ra.radacctid,
        ra.acctsessionid,
        ra.acctuniqueid,
        ra.username,
        ra.nasipaddress,
        ra.nasportid,
        ra.acctstarttime,
        ra.acctupdatetime,
        ra.acctsessiontime,
        ra.acctinputoctets,
        ra.acctoutputoctets,
        ra.calledstationid,
        ra.callingstationid,
        ra.framedipaddress
      FROM radacct ra
    `;

    if (actor.role !== 'SUPER_ADMIN') {
      sql += ` INNER JOIN voucher_cards vc ON vc.username = ra.username AND vc.reseller_id = ? `;
      params.push(actor.id);
    }

    sql += ` WHERE ra.acctstoptime IS NULL `;

    if (search && search.trim() !== '') {
      const term = `%${search.trim()}%`;
      sql += ` AND (ra.username LIKE ? OR ra.framedipaddress LIKE ? OR ra.callingstationid LIKE ?) `;
      params.push(term, term, term);
    }

    sql += ` ORDER BY ra.acctstarttime DESC LIMIT 500 `;

    const [rows] = await dbPool.query<RowDataPacket[]>(sql, params);
    return rows as unknown as ActiveSessionRow[];
  }

  /**
   * Terminates an active MikroTik Hotspot session immediately using FreeRADIUS CoA/PoD
   * (`radclient` over UDP port 3799), looking up the NAS secret from the `nas` table.
   * Safe against command injection by passing attributes via `stdin` to `spawn('radclient')`.
   */
  public async disconnectSession(radacctId: number, actor: AuthUser) {
    const params: any[] = [radacctId];
    let rbacJoin = '';

    if (actor.role !== 'SUPER_ADMIN') {
      rbacJoin = 'INNER JOIN voucher_cards vc ON vc.username = ra.username AND vc.reseller_id = ?';
      params.push(actor.id);
    }

    const [sessions] = await dbPool.query<RowDataPacket[]>(
      `SELECT
          ra.radacctid,
          ra.username,
          ra.acctsessionid,
          ra.nasipaddress,
          ra.framedipaddress,
          ra.callingstationid,
          n.secret AS nas_secret
       FROM radacct ra
       ${rbacJoin}
       LEFT JOIN nas n ON n.nasname = ra.nasipaddress
       WHERE ra.radacctid = ? AND ra.acctstoptime IS NULL`,
      params
    );

    if (sessions.length === 0) {
      throw new Error('Active session not found or already terminated.');
    }

    const session = sessions[0];
    const nasIp = session.nasipaddress;
    const nasSecret = session.nas_secret || process.env.DEFAULT_NAS_SECRET || 'testing123';
    const coaPort = Number(process.env.MikroTik_COA_PORT) || 3799;

    // Construct RFC 5176 Packet of Disconnect (PoD) payload for MikroTik RouterOS
    const podAttributes = [
      `User-Name = "${String(session.username).replace(/"/g, '')}"`,
      `Acct-Session-Id = "${String(session.acctsessionid).replace(/"/g, '')}"`,
      session.framedipaddress ? `Framed-IP-Address = ${session.framedipaddress}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const output = await this.executeRadclientDisconnect(
        `${nasIp}:${coaPort}`,
        nasSecret,
        podAttributes
      );

      // Optimistically mark session stopped if MikroTik ACKed (`Received Disconnect-ACK`)
      if (output.includes('Disconnect-ACK')) {
        await dbPool.query(
          `UPDATE radacct
           SET acctstoptime = NOW(), acctterminatecause = 'Admin-Reset'
           WHERE radacctid = ? AND acctstoptime IS NULL`,
          [radacctId]
        );
      }

      return {
        success: true,
        method: 'RADIUS_COA_POD',
        username: session.username,
        framedIp: session.framedipaddress,
        nasIp,
        radclientResponse: output.trim(),
      };
    } catch (radErr: any) {
      // Fallback: If `radclient` fails or UDP 3799 is firewalled, attempt MikroTik RouterOS v7 REST API
      if (process.env.MIKROTIK_REST_ENABLED === 'true') {
        await this.disconnectViaMikrotikRestApi(nasIp, session.username);
        return {
          success: true,
          method: 'MIKROTIK_REST_API',
          username: session.username,
          framedIp: session.framedipaddress,
          nasIp,
        };
      }
      throw new Error(`CoA/PoD Disconnect failed: ${radErr.message}`);
    }
  }

  /**
   * Spawns `radclient -x -r 2 -t 2 <nasIp:3799> disconnect <secret>` safely without shell interpolation.
   */
  private executeRadclientDisconnect(
    targetHostPort: string,
    secret: string,
    payload: string
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('radclient', ['-x', '-r', '2', '-t', '2', targetHostPort, 'disconnect', secret]);

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        reject(new Error(`Failed to execute radclient binary: ${err.message}`));
      });

      child.on('close', (code) => {
        if (code === 0 && !stdout.includes('Disconnect-NAK')) {
          resolve(stdout);
        } else {
          reject(
            new Error(
              `radclient exited with code ${code}. Output: ${stdout || stderr}`
            )
          );
        }
      });

      child.stdin.write(payload + '\n');
      child.stdin.end();
    });
  }

  /**
   * Optional Fallback: Terminates Hotspot Active Session via MikroTik RouterOS v7 REST API
   */
  private async disconnectViaMikrotikRestApi(nasIp: string, username: string) {
    const apiUser = process.env.MIKROTIK_API_USER || 'admin';
    const apiPass = process.env.MIKROTIK_API_PASS || '';
    const baseUrl = `http://${nasIp}/rest/ip/hotspot/active`;
    const authHeader = 'Basic ' + Buffer.from(`${apiUser}:${apiPass}`).toString('base64');

    const listRes = await fetch(`${baseUrl}?user=${encodeURIComponent(username)}`, {
      headers: { Authorization: authHeader },
    });

    if (!listRes.ok) {
      throw new Error(`MikroTik REST API returned HTTP ${listRes.status}`);
    }

    const activeEntries = (await listRes.json()) as Array<{ '.id': string }>;
    for (const entry of activeEntries) {
      await fetch(`${baseUrl}/${entry['.id']}`, {
        method: 'DELETE',
        headers: { Authorization: authHeader },
      });
    }
  }
}
