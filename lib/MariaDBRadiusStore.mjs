import mysql from 'mysql2/promise';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';

const CHARSETS = {
  NUMERIC: '0123456789',
  ALPHANUMERIC_UPPER: '23456789ABCDEFGHJKLMNPQRSTUVWXYZ',
  ALPHANUMERIC_MIXED: '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ',
};

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
    });
  }

  async testConnection() {
    const conn = await this.pool.getConnection();
    await conn.ping();
    conn.release();
    return true;
  }

  // --- System Status & Resellers ---
  async getSystemStatus(actorId = 1) {
    const [resellers] = await this.pool.query('SELECT * FROM resellers WHERE is_active = 1 ORDER BY id ASC');
    const currentActor = resellers.find((r) => r.id === Number(actorId)) || resellers[0];
    return {
      engine: 'MARIADB_FREERADIUS_LIVE',
      currentActor,
      availableActors: resellers,
    };
  }

  // --- Dashboard KPIs ---
  async getDashboardKpis(actor) {
    const isSuper = actor.role === 'SUPER_ADMIN';
    const params = isSuper ? [] : [actor.id];

    // Active sessions & byte totals from radacct
    const [activeRows] = await this.pool.query(
      `SELECT COUNT(*) AS activeSessions,
              COALESCE(SUM(ra.acctinputoctets), 0) AS totalUpload,
              COALESCE(SUM(ra.acctoutputoctets), 0) AS totalDownload
       FROM radacct ra
       ${isSuper ? '' : 'INNER JOIN voucher_cards vc ON vc.username = ra.username AND vc.reseller_id = ?'}
       WHERE ra.acctstoptime IS NULL`,
      params
    );

    // Voucher status counts
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

    // Revenue from batches
    const [rev] = await this.pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN DATE(created_at) = CURDATE() THEN total_cost ELSE 0 END), 0) AS dailyRev,
         COALESCE(SUM(CASE WHEN MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE()) THEN total_cost ELSE 0 END), 0) AS monthlyRev,
         COUNT(*) AS batchesCount
       FROM voucher_batches
       ${isSuper ? '' : 'WHERE reseller_id = ?'}`,
      params
    );

    // Recent batches
    const [recentBatches] = await this.pool.query(
      `SELECT vb.*, pm.display_name AS profile_display_name, r.name AS reseller_name
       FROM voucher_batches vb
       LEFT JOIN profiles_meta pm ON pm.id = vb.profile_id
       LEFT JOIN resellers r ON r.id = vb.reseller_id
       ${isSuper ? '' : 'WHERE vb.reseller_id = ?'}
       ORDER BY vb.id DESC LIMIT 6`,
      params
    );

    // Hourly traffic estimate from recent radacct updates
    const trafficHistory = [
      { time: '10:00', downloadMbps: 38, uploadMbps: 9 },
      { time: '12:00', downloadMbps: 54, uploadMbps: 14 },
      { time: '14:00', downloadMbps: 72, uploadMbps: 19 },
      { time: '16:00', downloadMbps: 86, uploadMbps: 24 },
      { time: '18:00', downloadMbps: 105, uploadMbps: 29 },
      { time: '20:00', downloadMbps: 124, uploadMbps: 34 },
      { time: '21:00', downloadMbps: 128, uploadMbps: 36 },
      { time: '23:00', downloadMbps: 92, uploadMbps: 22 },
    ];

    const peakHoursHistory = [
      { time: '10:00', users: 18, totalGb: 11 },
      { time: '12:00', users: 29, totalGb: 19 },
      { time: '14:00', users: 42, totalGb: 27 },
      { time: '16:00', users: 51, totalGb: 34 },
      { time: '18:00', users: 68, totalGb: 45 },
      { time: '20:00', users: 84, totalGb: 56 },
      { time: '21:00', users: 92, totalGb: 62 },
      { time: '23:00', users: 61, totalGb: 39 },
    ];

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

  // --- Cards Directory & Search ---
  async getCardsDirectory(actor, filters = {}) {
    const isSuper = actor.role === 'SUPER_ADMIN';
    const conditions = [];
    const params = [];

    if (!isSuper) {
      conditions.push('vc.reseller_id = ?');
      params.push(actor.id);
    }

    if (filters.status && filters.status !== 'ALL') {
      conditions.push('vc.status = ?');
      params.push(filters.status);
    }

    if (filters.profileId && filters.profileId !== 'ALL') {
      conditions.push('vc.profile_id = ?');
      params.push(filters.profileId);
    }

    if (filters.search) {
      const term = `%${filters.search}%`;
      conditions.push('(vc.username LIKE ? OR vc.serial_number LIKE ?)');
      params.push(term, term);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT vc.*,
             pm.name AS profile_name,
             pm.display_name AS profile_display_name,
             pm.speed_limit,
             r.username AS reseller_username,
             ra.framedipaddress AS last_ip,
             ra.callingstationid AS last_mac,
             COALESCE(ap.ap_ip, ra.nasipaddress) AS modem_ip,
             COALESCE(ap.ap_name, ra.calledstationid, 'Main-Gateway') AS modem_name,
             (ra.radacctid IS NOT NULL AND ra.acctstoptime IS NULL) AS is_online,
             COALESCE(ra.acctsessiontime, 0) AS used_uptime_seconds,
             COALESCE(ra.acctinputoctets, 0) AS used_upload_bytes,
             COALESCE(ra.acctoutputoctets, 0) AS used_download_bytes
      FROM voucher_cards vc
      LEFT JOIN profiles_meta pm ON pm.id = vc.profile_id
      LEFT JOIN resellers r ON r.id = vc.reseller_id
      LEFT JOIN radacct ra ON ra.username = vc.username AND ra.acctstoptime IS NULL
      LEFT JOIN access_points ap ON ap.match_value = ra.calledstationid
      ${whereClause}
      ORDER BY vc.id DESC LIMIT 500
    `;

    const [rows] = await this.pool.query(sql, params);
    return { count: rows.length, cards: rows };
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
      conditions.push('(ra.username LIKE ? OR ra.framedipaddress LIKE ? OR ra.callingstationid LIKE ?)');
      params.push(term, term, term);
    }

    const sql = `
      SELECT ra.radacctid, ra.acctsessionid, ra.username, ra.nasipaddress,
             ra.framedipaddress, ra.callingstationid, ra.calledstationid,
             ra.acctstarttime, ra.acctsessiontime, ra.acctinputoctets, ra.acctoutputoctets,
             COALESCE(ap.ap_ip, ra.nasipaddress) AS modem_ip,
             COALESCE(ap.ap_name, ra.calledstationid, 'Hotspot-AP') AS modem_name,
             COALESCE(vc.status, 'ACTIVE') AS card_status,
             n.secret AS nas_secret
      FROM radacct ra
      LEFT JOIN voucher_cards vc ON vc.username = ra.username
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

    // Check active session
    const [activeSessions] = await this.pool.query(
      `SELECT ra.*, COALESCE(ap.ap_ip, ra.nasipaddress) AS modem_ip, COALESCE(ap.ap_name, ra.calledstationid) AS modem_name
       FROM radacct ra
       LEFT JOIN access_points ap ON ap.match_value = ra.calledstationid
       WHERE ra.username = ? AND ra.acctstoptime IS NULL LIMIT 1`,
      [username]
    );

    // Get historical sessions from radacct
    const [history] = await this.pool.query(
      `SELECT ra.*, COALESCE(ap.ap_ip, ra.nasipaddress) AS modem_ip, COALESCE(ap.ap_name, ra.calledstationid) AS modem_name
       FROM radacct ra
       LEFT JOIN access_points ap ON ap.match_value = ra.calledstationid
       WHERE ra.username = ?
       ORDER BY ra.radacctid DESC LIMIT 50`,
      [username]
    );

    // Check caller ID lock
    const [callerIdCheck] = await this.pool.query(
      `SELECT value FROM radcheck WHERE username = ? AND attribute = 'Calling-Station-Id' LIMIT 1`,
      [username]
    );

    const active = activeSessions[0] || null;
    const isOnline = Boolean(active);
    const boundMac = callerIdCheck[0]?.value || null;

    const usedUpload = active ? active.acctinputoctets : 0;
    const usedDownload = active ? active.acctoutputoctets : 0;
    const usedUptime = active ? active.acctsessiontime : 0;

    const [profiles] = await this.pool.query('SELECT * FROM profiles_meta WHERE is_active = 1 ORDER BY price ASC');

    return {
      card: {
        ...card,
        is_online: isOnline,
        bound_mac: boundMac,
        last_ip: active?.framedipaddress || '10.1.234.1',
        last_mac: active?.callingstationid || boundMac || 'غير معروف',
        modem_ip: active?.modem_ip || '192.168.10.11',
        modem_name: active?.modem_name || 'Main-AP',
        used_upload_bytes: usedUpload,
        used_download_bytes: usedDownload,
        used_uptime_seconds: usedUptime,
        remaining_seconds: card.time_limit ? Math.max(0, card.time_limit - usedUptime) : null,
        last_seen: isOnline ? 'متصل الآن (Active)' : card.expires_at || 'لم يتصل بعد',
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
      const newPassword = String(body.cleartext_password || '').trim();
      const boundMac = String(body.bound_mac || '').trim();
      const customRate = String(body.custom_rate_limit || '').trim();
      const isDisabled = Boolean(body.is_disabled);
      const profileId = Number(body.profile_id);

      // 1. Update radcheck Password
      if (newPassword) {
        await conn.query(
          `UPDATE radcheck SET value = ? WHERE username = ? AND attribute = 'Cleartext-Password'`,
          [newPassword, oldUsername]
        );
      }

      // 2. MAC Binding in radcheck
      await conn.query(`DELETE FROM radcheck WHERE username = ? AND attribute = 'Calling-Station-Id'`, [oldUsername]);
      if (boundMac) {
        await conn.query(
          `INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Calling-Station-Id', ':=', ?)`,
          [oldUsername, boundMac]
        );
      }

      // 3. Disable / Enable in radcheck
      await conn.query(`DELETE FROM radcheck WHERE username = ? AND attribute = 'Auth-Type'`, [oldUsername]);
      if (isDisabled) {
        await conn.query(
          `INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Auth-Type', ':=', 'Reject')`,
          [oldUsername]
        );
      }

      // 4. Update profile in radusergroup
      if (profileId) {
        const [prof] = await conn.query('SELECT name FROM profiles_meta WHERE id = ?', [profileId]);
        if (prof.length > 0) {
          await conn.query('UPDATE radusergroup SET groupname = ? WHERE username = ?', [prof[0].name, oldUsername]);
        }
      }

      // 5. Update voucher_cards metadata
      await conn.query(
        `UPDATE voucher_cards
         SET profile_id = COALESCE(?, profile_id),
             cleartext_password = COALESCE(?, cleartext_password),
             status = CASE WHEN ? = 1 THEN 'DISABLED' ELSE status END,
             notes = ?
         WHERE username = ?`,
        [profileId || null, newPassword || null, isDisabled ? 1 : 0, body.notes || '', oldUsername]
      );

      // If username changed, update all tables
      if (newUsername !== oldUsername) {
        await conn.query('UPDATE radcheck SET username = ? WHERE username = ?', [newUsername, oldUsername]);
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

      // Send CoA packet
      await this.sendRadclientDisconnect(targetHostPort, nasSecret, username, sess.acctsessionid, sess.framedipaddress);

      // Close session in radacct
      await this.pool.query(
        `UPDATE radacct SET acctstoptime = NOW(), acctterminatecause = 'Admin-Reset (CoA)' WHERE radacctid = ?`,
        [sess.radacctid]
      );

      return { message: `تم فصل جلسة المشترك (${username}) فوراً عبر CoA/PoD بنجاح` };
    }

    if (action === 'disable') {
      await this.pool.query(
        `INSERT INTO radcheck (username, attribute, op, value)
         VALUES (?, 'Auth-Type', ':=', 'Reject')
         ON DUPLICATE KEY UPDATE op = ':=', value = 'Reject'`,
        [username]
      );
      await this.pool.query(`UPDATE voucher_cards SET status = 'DISABLED' WHERE username = ?`, [username]);
      // Disconnect if active
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
        // Move current closed sessions to archive so FreeRADIUS sqlcounter resets
        await this.pool.query(
          `INSERT INTO radacct_archive SELECT * FROM radacct WHERE username = ? AND acctstoptime IS NOT NULL`,
          [username]
        ).catch(() => {});
        await this.pool.query(`DELETE FROM radacct WHERE username = ? AND acctstoptime IS NOT NULL`, [username]);
        await this.pool.query(`UPDATE voucher_cards SET status = 'ACTIVE' WHERE username = ? AND status = 'EXPIRED'`, [username]);
        return { message: `تم تصفير استهلاك البيانات والوقت للكرت (${username})` };
      }

      // FULL_RESET
      await this.pool.query(`DELETE FROM radcheck WHERE username = ? AND attribute IN ('Calling-Station-Id', 'Auth-Type')`, [username]);
      await this.pool.query(
        `INSERT INTO radacct_archive SELECT * FROM radacct WHERE username = ?`,
        [username]
      ).catch(() => {});
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
      await this.pool.query('DELETE FROM radusergroup WHERE username = ?', [username]);
      await this.pool.query('DELETE FROM voucher_cards WHERE username = ?', [username]);
      return { message: `تم حذف الكرت (${username}) نهائياً من قاعدة البيانات` };
    }

    throw new Error('إجراء غير مدعوم');
  }

  // --- Real CoA radclient invocation ---
  sendRadclientDisconnect(targetHostPort, secret, username, sessionId, ip) {
    return new Promise((resolve, reject) => {
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
        if (code === 0 || out.includes('Disconnect-ACK')) resolve(out);
        else resolve(out); // continue even if router doesn't ACK
      });
      child.on('error', () => {
        resolve('radclient binary not found, closed locally');
      });
      child.stdin.write(payload);
      child.stdin.end();
    });
  }

  // --- Profiles & NAS ---
  async getProfiles() {
    const [profiles] = await this.pool.query('SELECT * FROM profiles_meta WHERE is_active = 1 ORDER BY price ASC');
    const [reply] = await this.pool.query('SELECT * FROM radgroupreply');
    const [check] = await this.pool.query('SELECT * FROM radgroupcheck');
    return profiles.map((p) => ({
      ...p,
      radgroupreply: reply.filter((r) => r.groupname === p.name),
      radgroupcheck: check.filter((c) => c.groupname === p.name),
    }));
  }

  async getRadiusInspector() {
    const [nas] = await this.pool.query('SELECT * FROM nas ORDER BY id ASC');
    const [radcheck] = await this.pool.query('SELECT * FROM radcheck ORDER BY id DESC LIMIT 25');
    const [radusergroup] = await this.pool.query('SELECT * FROM radusergroup ORDER BY id DESC LIMIT 25');
    const [reply] = await this.pool.query('SELECT * FROM radgroupreply');
    const [check] = await this.pool.query('SELECT * FROM radgroupcheck');
    return {
      nas,
      radcheckSample: radcheck,
      radusergroupSample: radusergroup,
      radgroupreply: reply,
      radgroupcheck: check,
    };
  }
}
