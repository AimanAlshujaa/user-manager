import 'dotenv/config';
import http from 'node:http';
import { randomInt } from 'node:crypto';
let dbStore = null;
try {
  const { MariaDBRadiusStore } = await import('./lib/MariaDBRadiusStore.mjs');
  const candidate = new MariaDBRadiusStore();
  await candidate.testConnection();
  dbStore = candidate;
  console.log('✅ نجح الاتصال بقاعدة بيانات MariaDB (FreeRADIUS Live DB)');
} catch (err) {
  console.log('ℹ️ يعمل النظام حالياً بالوضع التجريبي المحلي (Local Memory Store). عند تثبيت MariaDB وتشغيلها على سيرفر أوبونتو سيتصل بها تلقائياً.');
}

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

const MODEM_AP_LIST = [
  { ip: '192.168.10.11', name: 'Modem-Main-Fiber1' },
  { ip: '192.168.10.12', name: 'AP-Tower-North' },
  { ip: '192.168.10.14', name: 'Modem-VDSL-Line2' },
  { ip: '192.168.10.18', name: 'AP-East-Cafe' },
  { ip: '192.168.10.22', name: 'AP-Market-Sector3' },
];

class RadiusEngine {
  constructor() {
    this.seq = 100;
    this.radcheck = [];
    this.radusergroup = [];
    this.radgroupreply = [];
    this.radgroupcheck = [];
    this.radacct = []; // Active sessions (acctstoptime === null)
    this.radacct_history = []; // Past & active sessions per card
    this.nas = [];
    this.profiles_meta = [];
    this.resellers = [];
    this.voucher_batches = [];
    this.voucher_cards = [];
    this.reseller_transactions = [];
    this.seed();
  }

  nextId() {
    return ++this.seq;
  }

  seed() {
    this.nas = [
      {
        id: 1,
        nasname: '10.10.0.1',
        shortname: 'MikroTik-CCR2004-Main',
        type: 'other',
        secret: 'RadSecret2026!',
        description: 'الراوتر الرئيسي - برج النور (UDP 3799 CoA Enabled)',
      },
      {
        id: 2,
        nasname: '10.10.0.2',
        shortname: 'MikroTik-RB4011-East',
        type: 'other',
        secret: 'RadSecret2026!',
        description: 'فرع الحي الشرقي - هوت سبوت كافيهات',
      },
    ];

    this.resellers = [
      {
        id: 1,
        name: 'المدير العام للنظام (admin)',
        username: 'admin',
        role: 'SUPER_ADMIN',
        phone: '0501112222',
        balance: 50000,
        credit_limit: 100000,
        is_active: 1,
        created_at: new Date(Date.now() - 86400000 * 30).toISOString(),
      },
      {
        id: 2,
        name: 'مكتب الواحة للاتصالات (موزع معتمد)',
        username: 'waha_agent',
        role: 'RESELLER',
        phone: '0553334444',
        balance: 35000.0,
        credit_limit: 10000.0,
        is_active: 1,
        created_at: new Date(Date.now() - 86400000 * 14).toISOString(),
      },
      {
        id: 3,
        name: 'سوبر ماركت النخيل - نقطة بيع',
        username: 'nakheel_pos',
        role: 'RESELLER',
        phone: '0567778888',
        balance: 18000.0,
        credit_limit: 5000.0,
        is_active: 1,
        created_at: new Date(Date.now() - 86400000 * 7).toISOString(),
      },
    ];

    const initialProfiles = [
      {
        name: '500R',
        displayName: 'باقة يومية سريعة (500R - 2M)',
        price: 450,
        costPrice: 350,
        speedLimit: '2M/2M',
        timeLimit: 259200, // 3 days in seconds
        dataLimitMb: 1726,
        validityDays: 3,
        simultaneousUse: 1,
        portLimit: 1,
      },
      {
        name: '1000R',
        displayName: 'باقة أسبوعية بلس (1000R - 4M)',
        price: 900,
        costPrice: 750,
        speedLimit: '4M/4M',
        timeLimit: 604800,
        dataLimitMb: 5120,
        validityDays: 7,
        simultaneousUse: 1,
        portLimit: 1,
      },
      {
        name: '2500R_VIP',
        displayName: 'باقة شهرية VIP مفتوحة (8M)',
        price: 2500,
        costPrice: 2000,
        speedLimit: '8M/8M',
        timeLimit: 2592000,
        dataLimitMb: 25600,
        validityDays: 30,
        simultaneousUse: 2,
        portLimit: 2,
      },
      {
        name: '200R_2H',
        displayName: 'كرت استراحة ساعتين (10M)',
        price: 200,
        costPrice: 150,
        speedLimit: '10M/10M',
        timeLimit: 7200,
        dataLimitMb: 1024,
        validityDays: 1,
        simultaneousUse: 1,
        portLimit: 1,
      },
    ];

    for (const p of initialProfiles) {
      this.createProfile(p);
    }

    const adminActor = { id: 1, username: 'admin', role: 'SUPER_ADMIN' };
    const resellerActor = { id: 2, username: 'waha_agent', role: 'RESELLER' };

    this.generateBatch(
      {
        profileId: this.profiles_meta[0].id,
        quantity: 40,
        voucherType: 'PIN_ONLY',
        prefix: '77',
        codeLength: 8,
        charsetType: 'NUMERIC',
        notes: 'دفعة افتتاحية للفرع الرئيسي',
      },
      adminActor
    );

    this.generateBatch(
      {
        profileId: this.profiles_meta[1].id,
        quantity: 20,
        voucherType: 'USER_PASS',
        prefix: '52',
        codeLength: 6,
        charsetType: 'ALPHANUMERIC_MIXED',
        notes: 'دفعة مكتب الواحة الأسبوعية',
      },
      resellerActor
    );

    // Seed active, expired, and disabled cards + sessions with Real Modem/AP IP
    const sampleCards = this.voucher_cards.slice(0, 12);
    sampleCards.forEach((card, idx) => {
      const modem = MODEM_AP_LIST[idx % MODEM_AP_LIST.length];
      const mac = `7A:C7:B1:E0:0${idx}:D${idx}`;
      const clientIp = `10.1.234.${10 + idx}`;
      const upBytes = (idx + 1) * 58 * 1024 * 1024 + randomInt(100000, 5000000);
      const downBytes = (idx + 1) * 340 * 1024 * 1024 + randomInt(1000000, 40000000);
      const usedSecs = (idx + 1) * 3650 + randomInt(60, 600);

      if (idx < 7) {
        card.status = 'ACTIVE';
        card.first_used_at = new Date(Date.now() - usedSecs * 1000).toISOString();
        card.expires_at = new Date(Date.now() + (card.validity_days || 3) * 86400000).toISOString();
        card.bound_mac = mac;
        card.last_ip = clientIp;
        card.last_mac = mac;
        card.modem_ip = modem.ip;
        card.modem_name = modem.name;
        card.used_upload_bytes = upBytes;
        card.used_download_bytes = downBytes;
        card.used_uptime_seconds = usedSecs;

        // Add historical closed session + current live session
        const pastSession = {
          radacctid: this.nextId(),
          acctsessionid: `79f00${idx}a`,
          acctuniqueid: `u_hist_${this.nextId()}`,
          username: card.username,
          nasipaddress: idx % 2 === 0 ? '10.10.0.1' : '10.10.0.2',
          modem_ip: modem.ip,
          modem_name: modem.name,
          nasportid: modem.name,
          acctstarttime: new Date(Date.now() - (usedSecs + 7200) * 1000).toISOString(),
          acctstoptime: new Date(Date.now() - (usedSecs + 3600) * 1000).toISOString(),
          acctsessiontime: 3600,
          acctinputoctets: Math.floor(upBytes * 0.35),
          acctoutputoctets: Math.floor(downBytes * 0.35),
          calledstationid: modem.name,
          callingstationid: mac,
          framedipaddress: clientIp,
          acctterminatecause: 'User-Request',
        };
        this.radacct_history.push(pastSession);

        const liveSession = {
          radacctid: this.nextId(),
          acctsessionid: `80a001c${idx + 1}`,
          acctuniqueid: `u_${this.nextId()}`,
          username: card.username,
          nasipaddress: idx % 2 === 0 ? '10.10.0.1' : '10.10.0.2',
          modem_ip: modem.ip,
          modem_name: modem.name,
          nasportid: modem.name,
          acctstarttime: new Date(Date.now() - usedSecs * 1000).toISOString(),
          acctstoptime: null,
          acctupdatetime: new Date().toISOString(),
          acctsessiontime: usedSecs,
          acctinputoctets: upBytes,
          acctoutputoctets: downBytes,
          calledstationid: modem.name,
          callingstationid: mac,
          framedipaddress: clientIp,
          acctterminatecause: null,
        };
        this.radacct.push(liveSession);
        this.radacct_history.push(liveSession);
      } else if (idx < 10) {
        card.status = 'EXPIRED';
        card.first_used_at = new Date(Date.now() - 86400000 * 5).toISOString();
        card.expires_at = new Date(Date.now() - 86400000 * 2).toISOString();
        card.bound_mac = mac;
        card.last_ip = clientIp;
        card.last_mac = mac;
        card.modem_ip = modem.ip;
        card.modem_name = modem.name;
        card.used_upload_bytes = 210 * 1024 * 1024;
        card.used_download_bytes = 1516 * 1024 * 1024;
        card.used_uptime_seconds = 86400 * 3;

        this.radacct_history.push({
          radacctid: this.nextId(),
          acctsessionid: `70e00${idx}`,
          acctuniqueid: `u_exp_${this.nextId()}`,
          username: card.username,
          nasipaddress: '10.10.0.1',
          modem_ip: modem.ip,
          modem_name: modem.name,
          nasportid: modem.name,
          acctstarttime: card.first_used_at,
          acctstoptime: card.expires_at,
          acctsessiontime: card.used_uptime_seconds,
          acctinputoctets: card.used_upload_bytes,
          acctoutputoctets: card.used_download_bytes,
          calledstationid: modem.name,
          callingstationid: mac,
          framedipaddress: clientIp,
          acctterminatecause: 'Session-Timeout',
        });
      } else {
        card.status = 'DISABLED';
        card.is_disabled = true;
        card.modem_ip = modem.ip;
        card.modem_name = modem.name;
        this.radcheck.push({
          id: this.nextId(),
          username: card.username,
          attribute: 'Auth-Type',
          op: ':=',
          value: 'Reject',
        });
      }
    });

    // Also make one active session belong to reseller #2 (`waha_agent`)
    const resellerCard = this.voucher_cards.find((c) => c.reseller_id === 2);
    if (resellerCard) {
      const modem = MODEM_AP_LIST[3];
      resellerCard.status = 'ACTIVE';
      resellerCard.first_used_at = new Date(Date.now() - 21852 * 1000).toISOString();
      resellerCard.expires_at = new Date(Date.now() + 86400000 * 2).toISOString();
      resellerCard.bound_mac = '7A:C7:B1:E0:05:D4';
      resellerCard.last_ip = '10.1.234.3';
      resellerCard.last_mac = '7A:C7:B1:E0:05:D4';
      resellerCard.modem_ip = modem.ip;
      resellerCard.modem_name = modem.name;
      resellerCard.used_upload_bytes = Math.floor(113.1 * 1024 * 1024);
      resellerCard.used_download_bytes = Math.floor(988.1 * 1024 * 1024);
      resellerCard.used_uptime_seconds = 6 * 3600 + 4 * 60 + 12;

      const s = {
        radacctid: this.nextId(),
        acctsessionid: '80a0099f',
        acctuniqueid: `u_${this.nextId()}`,
        username: resellerCard.username,
        nasipaddress: '10.10.0.2',
        modem_ip: modem.ip,
        modem_name: modem.name,
        nasportid: modem.name,
        acctstarttime: resellerCard.first_used_at,
        acctstoptime: null,
        acctupdatetime: new Date().toISOString(),
        acctsessiontime: resellerCard.used_uptime_seconds,
        acctinputoctets: resellerCard.used_upload_bytes,
        acctoutputoctets: resellerCard.used_download_bytes,
        calledstationid: modem.name,
        callingstationid: resellerCard.bound_mac,
        framedipaddress: resellerCard.last_ip,
        acctterminatecause: null,
      };
      this.radacct.push(s);
      this.radacct_history.push(s);
    }
  }

  _normalizeProfileDto(dto) {
    const name = String(dto.name || '').trim();
    if (!name) throw new Error('الاسم البرمجي للباقة مطلوب');

    const displayName = String(dto.displayName ?? dto.display_name ?? '').trim() || name;
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
      price: Number(dto.price || 0),
      costPrice: Number(dto.costPrice ?? dto.cost_price ?? 0),
      speedLimit,
      timeLimit,
      dataLimitMb,
      validityDays,
      simultaneousUse,
      portLimit,
    };
  }

  createProfile(dto) {
    const id = this.profiles_meta.reduce((m, p) => Math.max(m, p.id), 0) + 1;
    const p = this._normalizeProfileDto(dto);
    if (this.profiles_meta.some((x) => x.name === p.name)) {
      throw new Error('الاسم البرمجي للباقة مستخدم بالفعل');
    }

    const row = {
      id,
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
      is_active: 1,
    };
    this.profiles_meta.push(row);
    this.syncGroupRadiusTables(p);
    return row;
  }

  updateProfile(id, dto) {
    const profileId = Number(id);
    const existing = this.profiles_meta.find((item) => item.id === profileId);
    if (!existing) throw new Error('الباقة غير موجودة');

    const p = this._normalizeProfileDto(dto);
    const oldName = existing.name;
    if (p.name !== oldName && this.profiles_meta.some((x) => x.name === p.name && x.id !== profileId)) {
      throw new Error('الاسم البرمجي للباقة مستخدم بالفعل لباقة أخرى');
    }

    existing.name = p.name;
    existing.display_name = p.displayName;
    existing.price = p.price;
    existing.cost_price = p.costPrice;
    existing.speed_limit = p.speedLimit;
    existing.time_limit = p.timeLimit;
    existing.data_limit_mb = p.dataLimitMb;
    existing.validity_days = p.validityDays;
    existing.simultaneous_use = p.simultaneousUse;
    existing.port_limit = p.portLimit;

    if (p.name !== oldName) {
      this.radgroupreply = this.radgroupreply.filter((r) => r.groupname !== oldName);
      this.radgroupcheck = this.radgroupcheck.filter((c) => c.groupname !== oldName);
      this.radusergroup.forEach((u) => {
        if (u.groupname === oldName) u.groupname = p.name;
      });
    }

    this.voucher_cards.forEach((c) => {
      if (c.profile_id === profileId) {
        c.profile_name = p.name;
        c.profile_display_name = p.displayName;
        c.price = p.price;
        c.speed_limit = p.speedLimit;
        c.time_limit = p.timeLimit;
        c.data_limit_mb = p.dataLimitMb;
        c.validity_days = p.validityDays;
      }
    });
    this.voucher_batches.forEach((b) => {
      if (b.profile_id === profileId) {
        b.profile_display_name = p.displayName;
        b.speed_limit = p.speedLimit;
        b.price = p.price;
      }
    });

    this.syncGroupRadiusTables(p);
    return existing;
  }

  deleteProfile(id) {
    const profileId = Number(id);
    const idx = this.profiles_meta.findIndex((p) => p.id === profileId);
    if (idx === -1) throw new Error('الباقة غير موجودة');

    const cardsCount = this.voucher_cards.filter((c) => c.profile_id === profileId).length;
    if (cardsCount > 0) {
      throw new Error(`لا يمكن حذف هذه الباقة لوجود ${cardsCount} كرت مرتبط بها. استخدم زر "تعديل" لتحديث الباقة بأمان دون التأثير على الكروت.`);
    }

    const batchesCount = this.voucher_batches.filter((b) => b.profile_id === profileId).length;
    if (batchesCount > 0) {
      throw new Error(`لا يمكن حذف هذه الباقة لوجود ${batchesCount} دفعة مرتبطة بها. يمكنك تعديل الباقة مباشرة بدلاً من حذفها.`);
    }

    const groupname = this.profiles_meta[idx].name;
    this.profiles_meta.splice(idx, 1);
    this.radgroupreply = this.radgroupreply.filter((r) => r.groupname !== groupname);
    this.radgroupcheck = this.radgroupcheck.filter((c) => c.groupname !== groupname);
  }

  syncGroupRadiusTables(dto) {
    this.radgroupreply = this.radgroupreply.filter((r) => r.groupname !== dto.name);
    this.radgroupcheck = this.radgroupcheck.filter((c) => c.groupname !== dto.name);

    const speedLimit = String(dto.speedLimit ?? dto.speed_limit ?? '').trim();
    if (speedLimit) {
      this.radgroupreply.push({
        id: this.nextId(),
        groupname: dto.name,
        attribute: 'Mikrotik-Rate-Limit',
        op: ':=',
        value: speedLimit,
      });
    }

    this.radgroupreply.push(
      { id: this.nextId(), groupname: dto.name, attribute: 'Port-Limit', op: ':=', value: String(dto.portLimit || 1) },
      { id: this.nextId(), groupname: dto.name, attribute: 'Acct-Interim-Interval', op: ':=', value: '60' }
    );

    if (dto.timeLimit && dto.timeLimit > 0) {
      this.radgroupreply.push({
        id: this.nextId(),
        groupname: dto.name,
        attribute: 'Session-Timeout',
        op: ':=',
        value: String(dto.timeLimit),
      });
    }

    if (dto.dataLimitMb && dto.dataLimitMb > 0) {
      const FOUR_GIB = 4294967296n;
      const totalBytes = BigInt(dto.dataLimitMb) * 1048576n;
      const gigawords = totalBytes / FOUR_GIB;
      const lowBytes = totalBytes % FOUR_GIB;
      this.radgroupreply.push({
        id: this.nextId(),
        groupname: dto.name,
        attribute: 'Mikrotik-Total-Limit',
        op: ':=',
        value: lowBytes.toString(),
      });
      if (gigawords > 0n) {
        this.radgroupreply.push({
          id: this.nextId(),
          groupname: dto.name,
          attribute: 'Mikrotik-Total-Limit-Gigawords',
          op: ':=',
          value: gigawords.toString(),
        });
      }
    }

    this.radgroupcheck.push({
      id: this.nextId(),
      groupname: dto.name,
      attribute: 'Simultaneous-Use',
      op: ':=',
      value: String(dto.simultaneousUse || 1),
    });

    if (dto.timeLimit && dto.timeLimit > 0) {
      this.radgroupcheck.push({
        id: this.nextId(),
        groupname: dto.name,
        attribute: 'Max-All-Session',
        op: ':=',
        value: String(dto.timeLimit),
      });
    }
  }

  generateBatch(dto, actor) {
    const profile = this.profiles_meta.find((p) => p.id === Number(dto.profileId));
    if (!profile) throw new Error('الباقة المختارة غير موجودة');

    const targetResellerId =
      actor.role === 'SUPER_ADMIN' && dto.resellerId ? Number(dto.resellerId) : actor.id;
    const reseller = this.resellers.find((r) => r.id === targetResellerId);
    if (!reseller || !reseller.is_active) {
      throw new Error('حساب الموزع غير موجود أو موقوف');
    }

    const quantity = Math.max(1, Math.min(2000, Number(dto.quantity || 40)));
    const unitCost = Number(profile.cost_price);
    const totalCost = Number((unitCost * quantity).toFixed(2));
    const balanceBefore = reseller.balance;

    if (reseller.role !== 'SUPER_ADMIN') {
      if (totalCost > reseller.balance + reseller.credit_limit) {
        throw new Error(
          `رصيد الموزع غير كافٍ. التكلفة المطلوبة: ${totalCost} ر.س، المتاح (شامل الائتمان): ${(
            reseller.balance + reseller.credit_limit
          ).toFixed(2)} ر.س`
        );
      }
    }

    const existingUsers = new Set(this.radcheck.map((r) => r.username));
    const prefix = String(dto.prefix || '').trim();
    const randLen = Math.max(4, Number(dto.codeLength || 8) - prefix.length);
    const alphabet = CHARSETS[dto.charsetType || 'NUMERIC'];

    const batchCode = `B-${Date.now().toString(36).toUpperCase().slice(-5)}-${randomCode(
      3,
      CHARSETS.ALPHANUMERIC_UPPER
    )}`;
    const batchId = this.voucher_batches.length + 1;

    const cards = [];
    while (cards.length < quantity) {
      const candidate = `${prefix}${randomCode(randLen, alphabet)}`;
      if (!existingUsers.has(candidate)) {
        existingUsers.add(candidate);
        const seq = String(cards.length + 1).padStart(4, '0');
        const cleartextPassword =
          dto.voucherType === 'PIN_ONLY' ? candidate : randomCode(4, CHARSETS.ALPHANUMERIC_MIXED);
        cards.push({
          username: candidate,
          cleartextPassword,
          serialNumber: `${batchCode}-${seq}`,
        });
      }
    }

    const batchRecord = {
      id: batchId,
      batch_code: batchCode,
      profile_id: profile.id,
      profile_display_name: profile.display_name,
      speed_limit: profile.speed_limit,
      price: profile.price,
      quantity,
      reseller_id: targetResellerId,
      reseller_name: reseller.name,
      voucher_type: dto.voucherType || 'PIN_ONLY',
      prefix,
      code_length: dto.codeLength || 8,
      charset_type: dto.charsetType || 'NUMERIC',
      unit_cost: unitCost,
      total_cost: totalCost,
      notes: dto.notes || null,
      created_at: new Date().toISOString(),
    };
    this.voucher_batches.unshift(batchRecord);

    for (const card of cards) {
      this.radcheck.push({
        id: this.nextId(),
        username: card.username,
        attribute: 'Cleartext-Password',
        op: ':=',
        value: card.cleartextPassword,
      });
      this.radusergroup.push({
        id: this.nextId(),
        username: card.username,
        groupname: profile.name,
        priority: 1,
      });
      this.voucher_cards.push({
        id: this.nextId(),
        batch_id: batchId,
        batch_code: batchCode,
        reseller_id: targetResellerId,
        reseller_username: reseller.username,
        reseller_name: reseller.name,
        profile_id: profile.id,
        profile_name: profile.name,
        profile_display_name: profile.display_name,
        price: profile.price,
        speed_limit: profile.speed_limit,
        data_limit_mb: profile.data_limit_mb,
        time_limit: profile.time_limit,
        validity_days: profile.validity_days,
        username: card.username,
        cleartext_password: card.cleartextPassword,
        serial_number: card.serialNumber,
        status: 'UNUSED',
        is_disabled: false,
        bound_mac: null,
        last_ip: null,
        last_mac: null,
        modem_ip: null,
        modem_name: null,
        used_upload_bytes: 0,
        used_download_bytes: 0,
        used_uptime_seconds: 0,
        first_used_at: null,
        expires_at: null,
        notes: dto.notes || '',
        created_at: new Date().toISOString(),
      });
    }

    reseller.balance = Number((balanceBefore - totalCost).toFixed(2));
    this.reseller_transactions.unshift({
      id: this.nextId(),
      reseller_id: targetResellerId,
      reseller_name: reseller.name,
      batch_id: batchId,
      type: 'BATCH_DEDUCTION',
      amount: totalCost,
      balance_before: balanceBefore,
      balance_after: reseller.balance,
      description: `توليد ${quantity} كرت (${profile.display_name}) - دفعة ${batchCode}`,
      created_at: new Date().toISOString(),
    });

    return {
      batchId,
      batchCode,
      quantity,
      profileName: profile.name,
      profileDisplayName: profile.display_name,
      price: profile.price,
      totalCost,
      balanceAfter: reseller.balance,
      cards,
    };
  }

  /**
   * Retrieves full User/Card Details matching MikroTik User Manager + Sessions History
   */
  getCardDetails(username) {
    const card = this.voucher_cards.find((c) => c.username === username);
    if (!card) throw new Error('الكرت غير موجود في قاعدة البيانات');

    const profile =
      this.profiles_meta.find((p) => p.id === card.profile_id) || this.profiles_meta[0];
    const activeSession = this.radacct.find((s) => s.username === username) || null;
    const sessions = this.radacct_history
      .filter((s) => s.username === username)
      .slice()
      .reverse();

    const usedUploadBytes = activeSession
      ? activeSession.acctinputoctets
      : card.used_upload_bytes || 0;
    const usedDownloadBytes = activeSession
      ? activeSession.acctoutputoctets
      : card.used_download_bytes || 0;
    const usedTotalBytes = usedUploadBytes + usedDownloadBytes;
    const usedUptimeSeconds = activeSession
      ? activeSession.acctsessiontime
      : card.used_uptime_seconds || 0;

    const totalLimitSeconds = profile?.time_limit || null;
    const remainingSeconds = totalLimitSeconds
      ? Math.max(0, totalLimitSeconds - usedUptimeSeconds)
      : null;
    const dataLimitMb = profile?.data_limit_mb ?? null;
    const totalQuotaBytes = dataLimitMb ? Number(dataLimitMb) * 1024 * 1024 : null;
    const remainingBytes = totalQuotaBytes !== null ? Math.max(0, totalQuotaBytes - usedTotalBytes) : null;

    return {
      card: {
        ...card,
        profile_name: profile?.name || card.profile_name,
        profile_display_name: profile?.display_name || card.profile_display_name,
        speed_limit: card.custom_rate_limit || profile?.speed_limit || '',
        data_limit_mb: dataLimitMb,
        time_limit: totalLimitSeconds,
        validity_days: profile?.validity_days ?? null,
        price: profile?.price ?? card.price ?? 0,
        used_upload_bytes: usedUploadBytes,
        used_download_bytes: usedDownloadBytes,
        used_total_bytes: usedTotalBytes,
        remaining_bytes: remainingBytes,
        used_uptime_seconds: usedUptimeSeconds,
        remaining_seconds: remainingSeconds,
        last_ip: activeSession?.framedipaddress || card.last_ip || 'غير معروف',
        last_mac: activeSession?.callingstationid || card.last_mac || 'غير معروف',
        modem_ip: activeSession?.modem_ip || card.modem_ip || 'غير متصل',
        modem_name: activeSession?.modem_name || card.modem_name || '-',
        last_seen: activeSession ? 'متصل الآن (Active)' : card.expires_at || 'غير معروف',
        is_online: Boolean(activeSession),
      },
      sessions,
      availableProfiles: this.profiles_meta,
    };
  }

  /**
   * Saves edits made inside the User Details Modal (`username`, `password`, `disabled`, `bound_mac`, `profile_id`, `custom_rate_limit`, `notes`)
   */
  updateCardDetails(oldUsername, body) {
    const card = this.voucher_cards.find((c) => c.username === oldUsername);
    if (!card) throw new Error('الكرت غير موجود');

    const newUsername = String(body.username || oldUsername).trim();
    if (!newUsername) throw new Error('اسم المستخدم لا يمكن أن يكون فارغاً');

    if (newUsername !== oldUsername) {
      const collision = this.voucher_cards.find((c) => c.username === newUsername);
      if (collision) throw new Error('اسم المستخدم الجديد مستخدم بالفعل لكرت آخر');

      // Update username in radcheck, radusergroup, radacct, radacct_history
      this.radcheck.forEach((r) => {
        if (r.username === oldUsername) r.username = newUsername;
      });
      this.radusergroup.forEach((u) => {
        if (u.username === oldUsername) u.username = newUsername;
      });
      this.radacct.forEach((s) => {
        if (s.username === oldUsername) s.username = newUsername;
      });
      this.radacct_history.forEach((s) => {
        if (s.username === oldUsername) s.username = newUsername;
      });
      card.username = newUsername;
    }

    if (body.cleartext_password !== undefined) {
      card.cleartext_password = String(body.cleartext_password);
      const passRow = this.radcheck.find(
        (r) => r.username === card.username && r.attribute === 'Cleartext-Password'
      );
      if (passRow) passRow.value = card.cleartext_password;
    }

    if (body.profile_id !== undefined && Number(body.profile_id) !== card.profile_id) {
      const newProf = this.profiles_meta.find((p) => p.id === Number(body.profile_id));
      if (newProf) {
        card.profile_id = newProf.id;
        card.profile_name = newProf.name;
        card.profile_display_name = newProf.display_name;
        card.price = newProf.price;
        card.speed_limit = newProf.speed_limit;
        card.data_limit_mb = newProf.data_limit_mb;
        card.time_limit = newProf.time_limit;
        card.validity_days = newProf.validity_days;

        const ug = this.radusergroup.find((u) => u.username === card.username);
        if (ug) ug.groupname = newProf.name;
      }
    }

    if (body.custom_rate_limit !== undefined) {
      card.custom_rate_limit = body.custom_rate_limit.trim() || null;
    }

    if (body.bound_mac !== undefined) {
      card.bound_mac = body.bound_mac.trim() || null;
      this.radcheck = this.radcheck.filter(
        (r) => !(r.username === card.username && r.attribute === 'Calling-Station-Id')
      );
      if (card.bound_mac) {
        this.radcheck.push({
          id: this.nextId(),
          username: card.username,
          attribute: 'Calling-Station-Id',
          op: ':=',
          value: card.bound_mac,
        });
      }
    }

    if (body.notes !== undefined) {
      card.notes = body.notes;
    }

    if (body.is_disabled !== undefined) {
      const disableFlag = Boolean(body.is_disabled);
      if (disableFlag) {
        this.executeCardAction(card.username, 'disable');
      } else if (card.status === 'DISABLED') {
        this.executeCardAction(card.username, 'enable');
      }
    }

    return this.getCardDetails(card.username);
  }

  /**
   * Executes the 5 operational actions on a Card/User:
   * - disconnect: Kick active session via CoA/PoD
   * - disable: Set Auth-Type := Reject in radcheck + Kick active session
   * - enable: Remove Auth-Type := Reject from radcheck + Restore status
   * - reset: Smart Reset (`DATA_TIME` | `MAC_ONLY` | `FULL_RESET`)
   * - delete: Kick active session + delete from radcheck, radusergroup, voucher_cards
   */
  executeCardAction(username, action, resetMode = 'FULL_RESET') {
    const cardIdx = this.voucher_cards.findIndex((c) => c.username === username);
    const card = cardIdx !== -1 ? this.voucher_cards[cardIdx] : null;

    if (action === 'disconnect') {
      const sessIdx = this.radacct.findIndex((s) => s.username === username);
      if (sessIdx === -1) {
        throw new Error(`المشترك (${username}) غير متصل حالياً`);
      }
      const sess = this.radacct[sessIdx];
      sess.acctstoptime = new Date().toISOString();
      sess.acctterminatecause = 'Admin-Reset (CoA)';
      this.radacct.splice(sessIdx, 1);
      return {
        message: `تم فصل جلسة المشترك (${username}) فوراً عبر CoA/PoD من المودم ${sess.modem_ip}`,
      };
    }

    if (!card) throw new Error('الكرت غير موجود');

    if (action === 'disable') {
      card.status = 'DISABLED';
      card.is_disabled = true;
      // Add Auth-Type := Reject in radcheck
      const hasReject = this.radcheck.some(
        (r) => r.username === username && r.attribute === 'Auth-Type'
      );
      if (!hasReject) {
        this.radcheck.push({
          id: this.nextId(),
          username,
          attribute: 'Auth-Type',
          op: ':=',
          value: 'Reject',
        });
      }
      // Also kick if currently connected
      const sessIdx = this.radacct.findIndex((s) => s.username === username);
      if (sessIdx !== -1) {
        this.radacct[sessIdx].acctstoptime = new Date().toISOString();
        this.radacct[sessIdx].acctterminatecause = 'Admin-Disable';
        this.radacct.splice(sessIdx, 1);
      }
      return { message: `تم تعطيل الكرت (${username}) ومنعه من الدخول في radcheck` };
    }

    if (action === 'enable') {
      card.is_disabled = false;
      card.status = card.first_used_at ? 'ACTIVE' : 'UNUSED';
      this.radcheck = this.radcheck.filter(
        (r) => !(r.username === username && r.attribute === 'Auth-Type')
      );
      return { message: `تم تمكين الكرت (${username}) وإعادة تفعيله في الشبكة` };
    }

    if (action === 'reset') {
      if (resetMode === 'MAC_ONLY') {
        card.bound_mac = null;
        this.radcheck = this.radcheck.filter(
          (r) => !(r.username === username && r.attribute === 'Calling-Station-Id')
        );
        return { message: `تم فك قفل الماك أدريس للكرت (${username}) بنجاح` };
      }

      if (resetMode === 'DATA_TIME') {
        card.used_upload_bytes = 0;
        card.used_download_bytes = 0;
        card.used_uptime_seconds = 0;
        const active = this.radacct.find((s) => s.username === username);
        if (active) {
          active.acctinputoctets = 0;
          active.acctoutputoctets = 0;
          active.acctsessiontime = 0;
        }
        if (card.status === 'EXPIRED') card.status = 'ACTIVE';
        return { message: `تم تصفير عدادات التحميل والرفع والوقت للكرت (${username})` };
      }

      // FULL_RESET
      card.used_upload_bytes = 0;
      card.used_download_bytes = 0;
      card.used_uptime_seconds = 0;
      card.bound_mac = null;
      card.first_used_at = null;
      card.expires_at = null;
      card.is_disabled = false;
      card.status = 'UNUSED';
      this.radcheck = this.radcheck.filter(
        (r) =>
          !(
            r.username === username &&
            (r.attribute === 'Calling-Station-Id' || r.attribute === 'Auth-Type')
          )
      );
      const sessIdx = this.radacct.findIndex((s) => s.username === username);
      if (sessIdx !== -1) this.radacct.splice(sessIdx, 1);
      return {
        message: `تم التصفير الشامل للكرت (${username}) وإعادته ككرت جديد غير مستخدم`,
      };
    }

    if (action === 'delete') {
      const sessIdx = this.radacct.findIndex((s) => s.username === username);
      if (sessIdx !== -1) this.radacct.splice(sessIdx, 1);
      this.radcheck = this.radcheck.filter((r) => r.username !== username);
      this.radusergroup = this.radusergroup.filter((u) => u.username !== username);
      this.voucher_cards.splice(cardIdx, 1);
      return { message: `تم حذف الكرت (${username}) نهائياً من النظام وجداول FreeRADIUS` };
    }

    throw new Error('إجراء غير معروف');
  }
}

const store = new RadiusEngine();

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-actor-id, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>RadiusPro — نظام إدارة شبكات MikroTik Hotspot & FreeRADIUS 3.x</title>
  <style>
    :root {
      --bg: #f1f5f9;
      --card: #ffffff;
      --sidebar: #0f172a;
      --sidebar-hover: #1e293b;
      --primary: #4f46e5;
      --primary-hover: #4338ca;
      --emerald: #059669;
      --emerald-bg: #ecfdf5;
      --red: #dc2626;
      --red-bg: #fef2f2;
      --amber: #d97706;
      --amber-bg: #fffbeb;
      --text: #0f172a;
      --muted: #64748b;
      --border: #e2e8f0;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      max-width: 100%;
      overflow-x: hidden;
      overflow-x: clip;
    }
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      min-height: 100vh;
      direction: rtl;
    }
    body.no-scroll { overflow: hidden; }
    /* Sidebar */
    .sidebar {
      width: 275px;
      background: var(--sidebar);
      color: #f8fafc;
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      position: sticky;
      top: 0;
      height: 100vh;
      overflow-y: auto;
      box-shadow: -4px 0 15px rgba(0,0,0,0.08);
    }
    .sidebar-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, 0.55);
      backdrop-filter: blur(2px);
      z-index: 1190;
    }
    .sidebar-backdrop.open { display: block; }
    .sidebar-close-btn { display: none; }
    .menu-toggle-btn { display: none; }
    .brand {
      padding: 20px;
      border-bottom: 1px solid #1e293b;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-icon {
      width: 42px;
      height: 42px;
      border-radius: 12px;
      background: var(--primary);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      flex-shrink: 0;
      box-shadow: 0 4px 12px rgba(79,70,229,0.4);
    }
    .brand h1 { font-size: 18px; font-weight: 800; color: #fff; }
    .brand p { font-size: 11px; color: #94a3b8; margin-top: 2px; }
    .nav { padding: 14px 12px; flex: 1; display: flex; flex-direction: column; gap: 5px; }
    .nav-btn {
      width: 100%;
      background: transparent;
      border: none;
      color: #cbd5e1;
      padding: 11px 14px;
      border-radius: 11px;
      font-size: 13.5px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      text-align: right;
      transition: all 0.15s;
      font-family: inherit;
    }
    .nav-btn:hover { background: var(--sidebar-hover); color: #fff; }
    .nav-btn.active {
      background: var(--primary);
      color: #fff;
      box-shadow: 0 4px 12px rgba(79,70,229,0.35);
    }
    .badge {
      background: #10b981;
      color: #022c22;
      font-size: 11px;
      font-weight: 800;
      padding: 2px 8px;
      border-radius: 99px;
    }
    .badge-indigo {
      background: #818cf8;
      color: #1e1b4b;
      font-size: 11px;
      font-weight: 800;
      padding: 2px 8px;
      border-radius: 99px;
    }
    .rbac-box {
      margin: 12px;
      padding: 12px;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 14px;
    }
    .rbac-box label {
      display: block;
      font-size: 11.5px;
      font-weight: 700;
      color: #818cf8;
      margin-bottom: 6px;
    }
    .rbac-box select {
      width: 100%;
      background: #0f172a;
      color: #fff;
      border: 1px solid #475569;
      padding: 7px 10px;
      border-radius: 9px;
      font-size: 12px;
      font-family: inherit;
    }
    .rbac-balance {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid #334155;
      display: flex;
      justify-content: space-between;
      font-size: 12px;
    }
    .main-wrap { flex: 1; display: flex; flex-direction: column; min-width: 0; width: 100%; }
    .topbar {
      background: #fff;
      border-bottom: 1px solid var(--border);
      padding: 14px 26px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
    }
    .topbar-start {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      min-width: 0;
      flex: 1;
    }
    .topbar-actions {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
    .topbar h2 { font-size: 19px; font-weight: 800; color: #1e293b; }
    .topbar p { font-size: 12px; color: var(--muted); margin-top: 2px; }
    .status-pill {
      background: var(--emerald-bg);
      color: #065f46;
      border: 1px solid #a7f3d0;
      padding: 6px 12px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 700;
    }
    .content { padding: 22px 26px; flex: 1; overflow-y: auto; min-width: 0; }
    /* 5 Flexible Clickable KPI Cards */
    .kpi-grid-5 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(195px, 1fr));
      gap: 14px;
      margin-bottom: 20px;
    }
    .kpi-card {
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 16px 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
      position: relative;
      user-select: none;
    }
    .kpi-card:hover {
      transform: translateY(-3px);
      box-shadow: 0 10px 20px -5px rgba(79, 70, 229, 0.14);
      border-color: #818cf8;
    }
    .kpi-label { font-size: 12px; font-weight: 700; color: var(--muted); }
    .kpi-val { font-size: 26px; font-weight: 800; margin-top: 5px; color: #0f172a; }
    .kpi-sub { font-size: 11px; color: var(--muted); margin-top: 4px; }
    .kpi-link-hint {
      font-size: 10px;
      font-weight: 700;
      color: var(--primary);
      margin-top: 5px;
      display: inline-block;
    }
    .kpi-icon {
      width: 48px;
      height: 48px;
      border-radius: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      flex-shrink: 0;
    }
    .grid-3 { display: grid; grid-template-columns: 2fr 1fr; gap: 18px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    .grid-2-form { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .grid-2 > *, .grid-3 > *, .grid-2-form > *, .card { min-width: 0; }
    @media (max-width: 1100px) {
      .grid-3, .grid-2 { grid-template-columns: 1fr; }
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 18px 20px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.03);
      margin-bottom: 18px;
    }
    .card-title {
      font-size: 15px;
      font-weight: 800;
      color: #1e293b;
      padding-bottom: 11px;
      margin-bottom: 14px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
    }
    .toolbar-controls {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .search-input {
      padding: 8px 12px;
      border: 1px solid #cbd5e1;
      border-radius: 9px;
      font-size: 12.5px;
      width: 230px;
      max-width: 100%;
      font-family: inherit;
    }
    .filter-select {
      padding: 8px 10px;
      border: 1px solid #cbd5e1;
      border-radius: 9px;
      font-size: 12.5px;
      max-width: 100%;
      font-family: inherit;
      background: #fff;
    }
    /* Charts with Numbers on Top */
    .chart-scroll {
      width: 100%;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      padding-bottom: 4px;
    }
    .chart-bars {
      display: grid;
      grid-template-columns: repeat(8, 1fr);
      gap: 10px;
      min-width: 480px;
      height: 215px;
      align-items: end;
      padding: 24px 6px 8px;
      border-bottom: 1px solid var(--border);
    }
    .chart-legend {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
      font-size: 12px;
      color: #475569;
    }
    .bar-col {
      display: flex;
      flex-direction: column;
      align-items: center;
      height: 100%;
      justify-content: flex-end;
      gap: 5px;
    }
    .bar-pair {
      display: flex;
      align-items: flex-end;
      gap: 4px;
      height: 150px;
    }
    .bar-wrap {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-end;
      height: 100%;
    }
    .bar-num {
      font-size: 9.5px;
      font-weight: 800;
      margin-bottom: 3px;
      white-space: nowrap;
    }
    .bar-dl { width: 17px; background: var(--primary); border-radius: 5px 5px 0 0; min-height: 4px; }
    .bar-ul { width: 17px; background: #f59e0b; border-radius: 5px 5px 0 0; min-height: 4px; }
    .bar-peak { width: 22px; background: #10b981; border-radius: 5px 5px 0 0; min-height: 4px; }
    .bar-gb { width: 18px; background: #6366f1; border-radius: 5px 5px 0 0; min-height: 4px; }
    /* Forms & Buttons */
    .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); gap: 12px; }
    .field { margin-bottom: 11px; }
    .field label { display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 4px; }
    .field input, .field select {
      width: 100%;
      padding: 8px 11px;
      border: 1px solid #cbd5e1;
      border-radius: 9px;
      font-size: 13px;
      font-family: inherit;
      background: #fff;
    }
    .btn {
      border: none;
      border-radius: 9px;
      padding: 8px 14px;
      font-size: 12.5px;
      font-weight: 700;
      cursor: pointer;
      font-family: inherit;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      transition: all 0.15s;
    }
    .btn:hover { opacity: 0.92; }
    .btn-xs { padding: 4px 8px; font-size: 11px; border-radius: 7px; }
    .btn-primary { background: var(--primary); color: #fff; }
    .btn-emerald { background: var(--emerald); color: #fff; }
    .btn-amber { background: #fffbeb; color: #b45309; border: 1px solid #fde68a; }
    .btn-amber:hover { background: #f59e0b; color: #fff; }
    .btn-danger { background: var(--red-bg); color: var(--red); border: 1px solid #fecaca; }
    .btn-danger:hover { background: var(--red); color: #fff; }
    .btn-light { background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; }
    .btn-block { width: 100%; padding: 11px; font-size: 13.5px; }
    /* Filter Pills */
    .filter-pills { display: flex; flex-wrap: wrap; gap: 6px; }
    .pill-btn {
      background: #f1f5f9;
      color: #475569;
      border: 1px solid #cbd5e1;
      padding: 6px 13px;
      border-radius: 99px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      font-family: inherit;
    }
    .pill-btn.active {
      background: var(--primary);
      color: #fff;
      border-color: var(--primary);
    }
    /* Tables */
    .table-wrap { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .print-preview-bar {
      background: #1e1b4b;
      color: #fff;
      padding: 12px 16px;
      border-radius: 12px;
      margin-bottom: 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
    }
    .tx-row {
      padding: 10px 12px;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      font-size: 12px;
    }
    .profile-head-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 12px;
    }
    .profile-attrs {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .profile-attrs .tag {
      max-width: 100%;
      word-break: break-all;
      white-space: normal;
    }
    .reseller-topup-box {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
    }
    table { width: 100%; border-collapse: collapse; text-align: right; font-size: 12.5px; }
    th {
      background: #f8fafc;
      color: #475569;
      font-size: 11.5px;
      font-weight: 800;
      padding: 11px 12px;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }
    td { padding: 10px 12px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
    tr:hover td { background: #f8fafc; }
    .mono { font-family: Consolas, Monaco, monospace; }
    .user-link {
      font-family: Consolas, Monaco, monospace;
      font-weight: 800;
      color: #4338ca;
      background: #eef2ff;
      border: 1px solid #c7d2fe;
      padding: 3px 9px;
      border-radius: 7px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      text-decoration: none;
    }
    .user-link:hover { background: #4338ca; color: #fff; }
    .tag {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
    }
    .tag-indigo { background: #eef2ff; color: #4338ca; border: 1px solid #c7d2fe; }
    .tag-emerald { background: var(--emerald-bg); color: #065f46; border: 1px solid #a7f3d0; }
    .tag-amber { background: var(--amber-bg); color: #92400e; border: 1px solid #fde68a; }
    .tag-red { background: var(--red-bg); color: #991b1b; border: 1px solid #fecaca; }
    .action-group { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
    /* Smart Reset Inline Dropdown */
    .reset-wrap { position: relative; display: inline-block; }
    .reset-menu {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      background: #fff;
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.15);
      z-index: 10050;
      min-width: 210px;
      max-width: calc(100vw - 24px);
      padding: 5px;
    }
    .reset-menu.open { display: block; }
    .reset-item {
      display: block;
      width: 100%;
      text-align: right;
      background: none;
      border: none;
      padding: 7px 10px;
      font-size: 11.5px;
      font-weight: 700;
      color: #1e293b;
      border-radius: 7px;
      cursor: pointer;
      font-family: inherit;
    }
    .reset-item:hover { background: #eef2ff; color: var(--primary); }
    /* MikroTik User Manager Style User Details Modal */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, 0.6);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 9999;
      padding: 16px;
    }
    .modal-backdrop.open { display: flex; }
    .um-modal {
      background: #f0f0f0;
      border: 2px solid #64748b;
      border-radius: 8px;
      width: 100%;
      max-width: 680px;
      max-height: 92vh;
      max-height: 94dvh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 25px 50px rgba(0,0,0,0.35);
      overflow: hidden;
    }
    .um-header {
      background: #6e7a8a;
      color: #fff;
      padding: 9px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-weight: 800;
      font-size: 15px;
    }
    .um-close {
      background: #475569;
      color: #fff;
      border: 1px solid #cbd5e1;
      width: 26px;
      height: 26px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 900;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .um-body {
      padding: 12px 16px;
      overflow-y: auto;
      flex: 1;
      font-size: 13px;
      color: #111827;
    }
    .um-section { margin-bottom: 10px; }
    .um-sec-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 800;
      font-size: 13px;
      color: #1e293b;
      cursor: pointer;
      padding: 4px 0;
      user-select: none;
    }
    .um-sec-title::after {
      content: "";
      flex: 1;
      height: 1px;
      background: #94a3b8;
      margin-right: 8px;
    }
    .um-sec-content { padding: 6px 14px 4px; }
    .um-row {
      display: grid;
      grid-template-columns: 165px 1fr;
      align-items: center;
      gap: 10px;
      margin-bottom: 6px;
    }
    .um-label {
      text-align: left;
      font-weight: 700;
      color: #1e293b;
      font-size: 12.5px;
    }
    .um-val {
      font-weight: 600;
      color: #0f172a;
      font-size: 13px;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .um-input {
      width: 100%;
      padding: 5px 8px;
      border: 1px solid #94a3b8;
      background: #fff;
      font-size: 13.5px;
      font-family: Consolas, monospace;
      font-weight: 700;
    }
    .um-footer {
      background: #e2e8f0;
      border-top: 1px solid #94a3b8;
      padding: 10px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
    }
    /* Toast */
    #toast-box {
      margin: 12px 26px 0;
      padding: 11px 16px;
      border-radius: 11px;
      font-size: 13px;
      font-weight: 700;
      display: none;
    }
    /* Printable A4 Sheet */
    .a4-sheet {
      background: #fff;
      max-width: 210mm;
      margin: 0 auto 24px;
      padding: 10px;
      border: 1px solid #cbd5e1;
      border-radius: 10px;
    }
    .voucher-grid-40 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
    .voucher-grid-30 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .v-card {
      border: 1px dashed #64748b;
      border-radius: 6px;
      padding: 5px 7px;
      height: 26.8mm;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      font-size: 10px;
      background: #fff;
      overflow: hidden;
    }
    .v-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 2px;
      font-weight: 800;
    }
    .v-price { background: #0f172a; color: #fff; padding: 1px 5px; border-radius: 4px; font-size: 9px; }
    .v-body { display: flex; align-items: center; justify-content: space-between; gap: 4px; margin: auto 0; }
    .v-pin {
      font-family: Consolas, monospace;
      font-size: 13px;
      font-weight: 900;
      letter-spacing: 1px;
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      text-align: center;
      padding: 2px 4px;
      margin-top: 2px;
    }
    .v-foot {
      display: flex;
      justify-content: space-between;
      font-size: 8px;
      color: #64748b;
      border-top: 1px solid #f1f5f9;
      padding-top: 2px;
    }
    /* Responsive Breakpoints (Tablets, Phones & Small Screens) */
    @media (max-width: 1024px) {
      .sidebar {
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        height: 100vh;
        height: 100dvh;
        width: min(290px, 84vw);
        z-index: 1200;
        transform: translateX(100%);
        transition: transform 0.25s ease;
        box-shadow: -8px 0 28px rgba(0,0,0,0.28);
      }
      .sidebar.open { transform: translateX(0); }
      .menu-toggle-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 40px;
        flex-shrink: 0;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: #f8fafc;
        color: #0f172a;
        font-size: 20px;
        cursor: pointer;
      }
      .sidebar-close-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 34px;
        height: 34px;
        margin-right: auto;
        border-radius: 8px;
        border: 1px solid #334155;
        background: #1e293b;
        color: #f8fafc;
        font-size: 16px;
        cursor: pointer;
        flex-shrink: 0;
      }
      .topbar { padding: 12px 16px; }
      .content { padding: 16px; }
      #toast-box { margin: 10px 16px 0; }
    }
    @media screen and (max-width: 900px) {
      .voucher-grid-40, .voucher-grid-30 { grid-template-columns: repeat(2, 1fr); }
      .v-card { height: auto; min-height: 27mm; }
    }
    @media (max-width: 640px) {
      .topbar { padding: 10px 12px; gap: 10px; }
      .topbar h2 { font-size: 15.5px; line-height: 1.35; }
      .topbar p { font-size: 11px; }
      .topbar-actions { width: 100%; justify-content: space-between; gap: 8px; }
      .status-pill {
        flex: 1 1 auto;
        text-align: center;
        font-size: 11px;
        padding: 6px 10px;
        white-space: normal;
        word-break: break-word;
      }
      .content { padding: 12px; }
      #toast-box { margin: 10px 12px 0; font-size: 12px; padding: 10px 12px; }
      .card { padding: 14px; border-radius: 14px; margin-bottom: 14px; }
      .card-title { font-size: 14px; gap: 8px; }
      .kpi-grid-5 { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
      .kpi-card { padding: 12px; border-radius: 14px; gap: 8px; }
      .kpi-card > div:first-child { min-width: 0; }
      .kpi-label { font-size: 11px; }
      .kpi-val { font-size: 20px !important; word-break: break-word; }
      .kpi-sub { font-size: 10.5px; }
      .kpi-icon { width: 38px; height: 38px; border-radius: 11px; font-size: 18px; }
      .toolbar-controls { width: 100%; }
      .search-input, .filter-select { width: 100%; flex: 1 1 100%; font-size: 16px; }
      .field input, .field select, .um-input, .rbac-box select { font-size: 16px; }
      #simulate-btn { width: 100%; }
      .pill-btn { padding: 5px 10px; font-size: 11.5px; }
      th, td { padding: 8px 9px; font-size: 12px; }
      .action-group { min-width: 215px; }
      .grid-2-form { grid-template-columns: 1fr; }
      .reseller-topup-box { width: 100%; }
      .reseller-topup-box input { flex: 1 1 100px; width: auto !important; font-size: 16px; }
      .modal-backdrop { padding: 8px; }
      .um-header { padding: 9px 12px; font-size: 14px; }
      .um-body { padding: 10px 12px; font-size: 12.5px; }
      .um-sec-content { padding: 6px 4px 4px; }
      .um-row { grid-template-columns: 1fr; gap: 3px; margin-bottom: 10px; }
      .um-label { text-align: right; font-size: 11.5px; color: #475569; }
      .um-footer { padding: 8px 10px; gap: 8px; }
      .um-footer > div { width: 100%; }
      .um-footer .btn { flex: 1 1 auto; }
      #mikrotik-script-box { font-size: 11px !important; padding: 10px !important; }
    }
    @media screen and (max-width: 480px) {
      .voucher-grid-40, .voucher-grid-30 { grid-template-columns: 1fr; }
    }
    @media (max-width: 390px) {
      .kpi-grid-5 { grid-template-columns: 1fr; }
    }
    @media print {
      @page { size: A4 portrait; margin: 5mm; }
      .sidebar, .sidebar-backdrop, .menu-toggle-btn, .sidebar-close-btn, .topbar, .no-print, #toast-box, .modal-backdrop { display: none !important; }
      body { background: #fff; display: block !important; overflow: visible !important; }
      .content { padding: 0 !important; overflow: visible !important; }
      .a4-sheet { border: none; margin: 0; padding: 0; page-break-after: always; break-after: page; }
      .voucher-grid-40 { grid-template-columns: repeat(4, 1fr) !important; }
      .voucher-grid-30 { grid-template-columns: repeat(3, 1fr) !important; }
      .v-card { height: 26.8mm !important; min-height: 26.8mm !important; }
    }
  </style>
</head>
<body>
  <!-- Mobile/Tablet Sidebar Backdrop -->
  <div class="sidebar-backdrop" id="sidebar-backdrop" onclick="closeSidebar()"></div>

  <!-- Sidebar -->
  <aside class="sidebar" id="sidebar">
    <div class="brand">
      <div class="brand-icon">📡</div>
      <div>
        <h1>RadiusPro ISP</h1>
        <p>MikroTik & FreeRADIUS 3.x</p>
      </div>
      <button type="button" class="sidebar-close-btn" onclick="closeSidebar()" aria-label="إغلاق القائمة">✕</button>
    </div>

    <nav class="nav">
      <button class="nav-btn active" onclick="switchTab('dashboard')" id="nav-dashboard">
        <span>📊 لوحة القيادة والإحصائيات</span>
      </button>
      <button class="nav-btn" onclick="switchTab('cards')" id="nav-cards">
        <span>🗂️ الكروت والمستخدمين</span>
        <span class="badge-indigo" id="nav-cards-badge">0</span>
      </button>
      <button class="nav-btn" onclick="switchTab('sessions')" id="nav-sessions">
        <span>🟢 المتصلون الآن (Live CoA)</span>
        <span class="badge" id="nav-sessions-badge">0</span>
      </button>
      <button class="nav-btn" onclick="switchTab('vouchers')" id="nav-vouchers">
        <span>🎟️ توليد وطباعة الكروت (A4)</span>
      </button>
      <button class="nav-btn" onclick="switchTab('profiles')" id="nav-profiles">
        <span>⚡ الباقات والسرعات (Profiles)</span>
      </button>
      <button class="nav-btn" onclick="switchTab('resellers')" id="nav-resellers">
        <span>👥 الموزعون والأرصدة (RBAC)</span>
      </button>
      <button class="nav-btn" onclick="switchTab('radius_db')" id="nav-radius_db">
        <span>🗄️ فاحص جداول FreeRADIUS</span>
      </button>
    </nav>

    <div class="rbac-box">
      <label>🔐 تبديل الحساب لتجربة الصلاحيات (RBAC):</label>
      <select id="actor-select" onchange="changeActor(this.value)"></select>
      <div class="rbac-balance">
        <span style="color:#94a3b8">الرصيد المتاح:</span>
        <strong style="color:#34d399" id="actor-balance">0 ر.س</strong>
      </div>
    </div>
  </aside>

  <!-- Main Content -->
  <div class="main-wrap">
    <header class="topbar">
      <div class="topbar-start">
        <button type="button" class="menu-toggle-btn" id="menu-toggle-btn" onclick="toggleSidebar()" aria-label="فتح القائمة" aria-expanded="false">☰</button>
        <div style="min-width:0;">
          <h2 id="page-title">لوحة القيادة ومؤشرات الأداء اللحظية</h2>
          <p id="page-subtitle">متصل بمحرك FreeRADIUS 3.x وجداول radcheck / radacct / radgroupreply</p>
        </div>
      </div>
      <div class="topbar-actions">
        <span class="status-pill" id="system-status-pill">⏳ جاري فحص الاتصال بالسيرفر...</span>
        <button class="btn btn-light" onclick="refreshAll()">🔄 تحديث البيانات</button>
      </div>
    </header>

    <div id="toast-box"></div>

    <main class="content">
      <!-- ================================================================= -->
      <!-- TAB 1: DASHBOARD (5 Clickable Cards + 2 Detailed Charts)          -->
      <!-- ================================================================= -->
      <section id="tab-dashboard">
        <div class="kpi-grid-5" id="kpi-cards"></div>

        <!-- Two Charts Row: Traffic (with numbers) + Peak Users & Consumption -->
        <div class="grid-2">
          <div class="card">
            <div class="card-title">
              <span>📈 حركة الترافيك الحية على راوترات MikroTik (بالأرقام Mbps)</span>
              <span class="tag tag-indigo">تحديث مباشر من radacct</span>
            </div>
            <div class="chart-scroll">
              <div class="chart-bars" id="traffic-chart"></div>
            </div>
            <div class="chart-legend">
              <div>
                <span style="margin-left:16px;">🟦 التحميل (Download Mbps)</span>
                <span>🟧 الرفع (Upload Mbps)</span>
              </div>
              <span class="mono" id="traffic-peak-label" style="font-weight:700; color:#4f46e5;">الذروة الحالية: 0 Mbps</span>
            </div>
          </div>

          <div class="card">
            <div class="card-title">
              <span>🔥 أوقات الذروة: عدد المتصلين والاستهلاك العام (GB)</span>
              <span class="tag tag-emerald">تحليل ساعات الذروة</span>
            </div>
            <div class="chart-scroll">
              <div class="chart-bars" id="peak-chart"></div>
            </div>
            <div class="chart-legend">
              <div>
                <span style="margin-left:16px;">🟩 عدد المتصلين (مشترك)</span>
                <span>🟪 الاستهلاك الكلي (GB)</span>
              </div>
              <span id="peak-hour-label" style="font-weight:700; color:#059669;">ساعة الذروة: -</span>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">
            <span>🎟️ أحدث دفعات الكروت المولّدة</span>
            <button class="btn btn-primary btn-xs" onclick="switchTab('vouchers')">+ توليد دفعة جديدة</button>
          </div>
          <div id="recent-batches-list" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap:12px;"></div>
        </div>
      </section>

      <!-- ================================================================= -->
      <!-- TAB 2: ALL CARDS & USERS DIRECTORY (With Status Filters & Search) -->
      <!-- ================================================================= -->
      <section id="tab-cards" style="display:none;">
        <div class="card">
          <div class="card-title">
            <div>
              <span>🗂️ إدارة جميع الكروت والمستخدمين في النظام</span>
              <p style="font-size:12px; font-weight:400; color:#64748b; margin-top:3px;">
                اضغط على رقم الكرت لفتح نافذة <b>تفاصيل المستخدم (User Details)</b> وتعديل بياناته أو عرض جلساته.
              </p>
            </div>
            <div class="toolbar-controls">
              <input
                type="text"
                id="cards-search"
                class="search-input"
                placeholder="🔍 بحث برقم الكرت أو MAC أو IP..."
                oninput="loadCardsDirectory()"
              />
              <select id="cards-profile-filter" class="filter-select" onchange="loadCardsDirectory()">
                <option value="ALL">جميع الباقات</option>
              </select>
            </div>
          </div>

          <!-- Status Filter Pills -->
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:14px;">
            <div class="filter-pills" id="cards-status-pills">
              <button class="pill-btn active" onclick="filterCardsByStatus('ALL')" data-status="ALL">الكل</button>
              <button class="pill-btn" onclick="filterCardsByStatus('UNUSED')" data-status="UNUSED">🟦 الكروت المتاحة (غير مستخدمة)</button>
              <button class="pill-btn" onclick="filterCardsByStatus('ACTIVE')" data-status="ACTIVE">🟩 الكروت النشطة</button>
              <button class="pill-btn" onclick="filterCardsByStatus('EXPIRED')" data-status="EXPIRED">🟧 الكروت المنتهية</button>
              <button class="pill-btn" onclick="filterCardsByStatus('DISABLED')" data-status="DISABLED">🟥 الكروت المعطلة</button>
            </div>
            <span id="cards-count-label" style="font-size:12px; font-weight:800; color:#475569;"></span>
          </div>

          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>رقم الكرت / المستخدم</th>
                  <th>كلمة المرور</th>
                  <th>الباقة (Profile)</th>
                  <th>الحالة</th>
                  <th>الاستهلاك (الإجمالي / تحميل / رفع)</th>
                  <th>الوقت المستهلك</th>
                  <th>أول استخدام / الانتهاء</th>
                  <th>المودم / الأكسس بوينت (IP)</th>
                  <th>المالك</th>
                  <th>الإجراءات الخمسة</th>
                </tr>
              </thead>
              <tbody id="cards-tbody"></tbody>
            </table>
          </div>
        </div>
      </section>

      <!-- ================================================================= -->
      <!-- TAB 3: LIVE ACTIVE SESSIONS (With Real Modem IP & 5 Actions)      -->
      <!-- ================================================================= -->
      <section id="tab-sessions" style="display:none;">
        <div class="card">
          <div class="card-title">
            <div>
              <span>📡 المتصلون الآن مباشر في جدول radacct</span>
              <p style="font-size:12px; font-weight:400; color:#64748b; margin-top:3px;">
                اضغط على رقم الكرت لعرض وتعديل تفاصيله الكاملة، أو استخدم أزرار الإجراءات الخمسة (فصل، تعطيل، تمكين، تصفير، حذف).
              </p>
            </div>
            <div class="toolbar-controls">
              <input
                type="text"
                id="session-search"
                class="search-input"
                placeholder="🔍 بحث بالكرت أو IP أو المودم أو MAC..."
                oninput="loadSessions()"
              />
              <button class="btn btn-primary" id="simulate-btn" onclick="simulateNewSession()">▶️ محاكاة دخول مشترك جديد</button>
            </div>
          </div>

          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>المستخدم / الكرت</th>
                  <th>آي بي المشترك (IP)</th>
                  <th>الماك (callingstationid)</th>
                  <th>IP المودم / الأكسس بوينت المتصل منه</th>
                  <th>مدة الاتصال</th>
                  <th>الرفع (Upload)</th>
                  <th>التحميل (Download)</th>
                  <th>الإجمالي (رفع + تحميل)</th>
                  <th>الإجراءات التشغيلية (فصل / تعطيل / تمكين / تصفير / حذف)</th>
                </tr>
              </thead>
              <tbody id="sessions-tbody"></tbody>
            </table>
          </div>
        </div>
      </section>

      <!-- ================================================================= -->
      <!-- TAB 4: BATCH VOUCHER GENERATOR & A4 40-CARD PRINT                 -->
      <!-- ================================================================= -->
      <section id="tab-vouchers" style="display:none;">
        <div class="grid-3 no-print">
          <div class="card">
            <div class="card-title">✨ توليد دفعة كروت جديدة (إدراج فوري في radcheck & radusergroup)</div>
            <form onsubmit="handleGenerateBatch(event)">
              <div class="form-grid">
                <div class="field">
                  <label>الباقة / السرعة (Profile)</label>
                  <select id="gen-profile"></select>
                </div>
                <div class="field">
                  <label>عدد الكروت المطلوبة (Quantity)</label>
                  <input type="number" id="gen-qty" value="40" min="1" max="2000" required />
                </div>
                <div class="field">
                  <label>نمط الكرت</label>
                  <select id="gen-type">
                    <option value="PIN_ONLY">كود موحد (Username = Password)</option>
                    <option value="USER_PASS">اسم مستخدم + كلمة مرور منفصلة</option>
                  </select>
                </div>
                <div class="field">
                  <label>بادئة الكرت الاختيارية (Prefix)</label>
                  <input type="text" id="gen-prefix" value="77" maxlength="5" placeholder="مثال: 77 أو VIP" />
                </div>
                <div class="field">
                  <label>طول الكود الكلي (Length)</label>
                  <input type="number" id="gen-len" value="8" min="6" max="14" required />
                </div>
                <div class="field">
                  <label>تركيبة الكود (Charset)</label>
                  <select id="gen-charset">
                    <option value="NUMERIC">أرقام فقط (0-9)</option>
                    <option value="ALPHANUMERIC_UPPER">أحرف كبيرة وأرقام (بدون 0/O)</option>
                    <option value="ALPHANUMERIC_MIXED">أحرف كبيرة وصغيرة وأرقام</option>
                  </select>
                </div>
              </div>
              <button type="submit" class="btn btn-primary btn-block" style="margin-top:8px;">
                ⚡ توليد الدفعة الآن وتجهيز صفحة الطباعة A4
              </button>
            </form>
          </div>

          <div class="card">
            <div class="card-title">🖨️ تخصيص تصميم الكرت المطبوع (A4)</div>
            <div class="field">
              <label>اسم الشبكة على الكرت</label>
              <input type="text" id="brand-name" value="شبكة النور هوت سبوت" oninput="renderPrintPreview()" />
            </div>
            <div class="field">
              <label>رابط الدخول (لرمز QR التلقائي)</label>
              <input type="text" id="brand-url" dir="ltr" value="http://wifi.lan/login" oninput="renderPrintPreview()" />
              <div style="font-size:11px; color:#64748b; margin-top:4px;">أدخل رابط صفحة الدخول الفعلية في المايكروتك (DNS Name أو IP البوابة مثل http://10.5.50.1/login)</div>
            </div>
            <div class="field">
              <label>رقم الدعم الفني</label>
              <input type="text" id="brand-phone" value="0501112222" oninput="renderPrintPreview()" />
            </div>
            <div class="field">
              <label>عدد الكروت في صفحة A4</label>
              <select id="brand-perpage" onchange="renderPrintPreview()">
                <option value="40">40 كرت في صفحة A4 (4 أعمدة × 10 صفوف)</option>
                <option value="30">30 كرت في صفحة A4 (3 أعمدة × 10 صفوف)</option>
              </select>
            </div>
            <div class="field" style="display:flex; align-items:center; gap:8px; margin-top:8px;">
              <input type="checkbox" id="brand-qr" checked onchange="renderPrintPreview()" style="width:16px; height:16px;" />
              <label style="margin:0; cursor:pointer;" for="brand-qr">إظهار رمز QR للدخول السريع</label>
            </div>
            <button type="button" class="btn btn-emerald btn-block" onclick="window.print()" style="margin-top:10px;">
              🖨️ طباعة الدفعة الآن (A4)
            </button>
          </div>
        </div>

        <div class="card no-print">
          <div class="card-title">📋 سجل الدفعات المولّدة</div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>كود الدفعة</th>
                  <th>الباقة</th>
                  <th>الكمية</th>
                  <th>الموزع</th>
                  <th>التكلفة الإجمالية</th>
                  <th>تاريخ التوليد</th>
                  <th>إجراء</th>
                </tr>
              </thead>
              <tbody id="batches-tbody"></tbody>
            </table>
          </div>
        </div>

        <div id="print-preview-container"></div>
      </section>

      <!-- ================================================================= -->
      <!-- TAB 5: PROFILES & BANDWIDTH                                       -->
      <!-- ================================================================= -->
      <section id="tab-profiles" style="display:none;">
        <div class="grid-3">
          <div class="card" id="prof-form-card">
            <div class="card-title" id="prof-form-title">➕ إضافة باقة جديدة (تزامن مع radgroupreply)</div>
            <form onsubmit="handleCreateProfile(event)">
              <input type="hidden" id="prof-edit-id" value="" />
              <div class="field">
                <label>الاسم البرمجي في FreeRADIUS (groupname)</label>
                <input type="text" id="prof-name" dir="ltr" placeholder="1500R" required />
              </div>
              <div class="field">
                <label>اسم الباقة بالعربية (للكروت)</label>
                <input type="text" id="prof-display" placeholder="باقة 6 ميجا - شهرية" required />
              </div>
              <div class="grid-2-form">
                <div class="field">
                  <label>سعر البيع</label>
                  <input type="number" step="0.5" id="prof-price" value="1500" required />
                </div>
                <div class="field">
                  <label>التكلفة على الموزع</label>
                  <input type="number" step="0.5" id="prof-cost" value="1200" required />
                </div>
              </div>
              <div class="field">
                <label>سرعة الميكروتك (Mikrotik-Rate-Limit) — اختياري</label>
                <input type="text" id="prof-speed" dir="ltr" value="" placeholder="مثال: 6M/6M" />
                <div style="font-size:11px; color:#64748b; margin-top:4px;">اختياري — اتركه فارغاً للتحكم بالسرعة من Queues في المايكروتك</div>
              </div>
              <div class="grid-2-form">
                <div class="field">
                  <label>وقت الاستخدام الفعلي (ساعات)</label>
                  <input type="number" id="prof-hours" value="72" min="0" step="any" />
                  <div style="font-size:11px; color:#64748b; margin-top:4px;">يقبل 0 لوقت استخدام مفتوح ومعتمد على الصلاحية والبيانات فقط</div>
                </div>
                <div class="field">
                  <label>الكوتا الإجمالية بالميجابايت (MB)</label>
                  <input type="number" id="prof-quota" value="10240" min="0" />
                  <div style="font-size:11px; color:#64748b; margin-top:4px;">مثال: 10240 لـ 10GB أو 20480 لـ 20GB (ضع 0 لغير محدود)</div>
                </div>
              </div>
              <div class="field">
                <label>صلاحية الكارت من أول استخدام (أيام)</label>
                <input type="number" id="prof-validity" value="30" min="0" />
                <div style="font-size:11px; color:#64748b; margin-top:4px;">الافتراضي 30 يوماً — يقبل 0 لبدون انتهاء صلاحية</div>
              </div>
              <button type="submit" id="prof-submit-btn" class="btn btn-primary btn-block">💾 حفظ الباقة ومزامنة FreeRADIUS</button>
              <button type="button" id="prof-cancel-btn" class="btn btn-light btn-block" style="display:none; margin-top:8px;" onclick="cancelEditProfile()">✖️ إلغاء التعديل</button>
            </form>
          </div>

          <div id="profiles-list"></div>
        </div>
      </section>

      <!-- ================================================================= -->
      <!-- TAB 6: RESELLERS & RBAC                                           -->
      <!-- ================================================================= -->
      <section id="tab-resellers" style="display:none;">
        <div class="grid-3">
          <div class="card">
            <div class="card-title">👥 إضافة موزع / نقطة بيع جديدة</div>
            <form onsubmit="handleCreateReseller(event)">
              <div class="field">
                <label>اسم الموزع / المتجر</label>
                <input type="text" id="res-name" placeholder="مثال: كافيه الأندلس" required />
              </div>
              <div class="field">
                <label>اسم المستخدم للدخول</label>
                <input type="text" id="res-user" dir="ltr" placeholder="andalus_pos" required />
              </div>
              <div class="field">
                <label>رقم الجوال</label>
                <input type="text" id="res-phone" placeholder="0500000000" />
              </div>
              <div class="grid-2-form">
                <div class="field">
                  <label>الرصيد الافتتاحي</label>
                  <input type="number" id="res-balance" value="500" />
                </div>
                <div class="field">
                  <label>الحد الائتماني</label>
                  <input type="number" id="res-credit" value="200" />
                </div>
              </div>
              <button type="submit" class="btn btn-primary btn-block">➕ إنشاء حساب الموزع</button>
            </form>
          </div>

          <div>
            <div class="card">
              <div class="card-title">💳 قائمة الموزعين وشحن الأرصدة</div>
              <div id="resellers-list" style="display:flex; flex-direction:column; gap:12px;"></div>
            </div>

            <div class="card">
              <div class="card-title">📜 السجل المالي للعمليات والدفعات الشهرية (reseller_transactions)</div>
              <div id="transactions-list" style="display:flex; flex-direction:column; gap:8px;"></div>
            </div>
          </div>
        </div>
      </section>

      <!-- ================================================================= -->
      <!-- TAB 7: FREERADIUS INSPECTOR & MIKROTIK LINKING                    -->
      <!-- ================================================================= -->
      <section id="tab-radius_db" style="display:none;">
        <!-- Quick MikroTik RouterOS Link Script Generator -->
        <div class="card" style="border-color:#c7d2fe; background:#f8fafc;">
          <div class="card-title">
            <span>🔗 أوامر ربط راوتر MikroTik بالسيرفر مباشرة (انسخ والصق في WinBox Terminal)</span>
            <button class="btn btn-primary btn-xs" onclick="copyMikrotikScript()">📋 نسخ الأوامر</button>
          </div>
          <p style="font-size:12px; color:#475569; margin-bottom:10px;">
            تم توليد هذه الأوامر تلقائياً بعنوان IP السيرفر الحالي (<b class="mono" id="vps-host-display">...</b>). تأكد من إضافة IP الراوتر في جدول <b>nas</b> بالأسفل بنفس الـ <b>Secret</b>، وفتح المنافذ <code>1812/udp, 1813/udp, 3799/udp</code> في جدار الحماية.
          </p>
          <pre id="mikrotik-script-box" dir="ltr" style="background:#0f172a; color:#38bdf8; padding:14px; border-radius:10px; font-size:12px; overflow-x:auto; line-height:1.6;"></pre>
        </div>

        <div class="grid-2">
          <!-- Add & List NAS Routers -->
          <div class="card">
            <div class="card-title">🛡️ راوترات MikroTik المعرّفة في جدول nas</div>
            <form onsubmit="handleAddNas(event)" style="margin-bottom:14px; padding-bottom:14px; border-bottom:1px solid var(--border);">
              <div class="form-grid">
                <div class="field">
                  <label>IP الراوتر (أو IP الخط العام للراوتر)</label>
                  <input type="text" id="nas-ip" dir="ltr" placeholder="مثال: 10.10.0.1 أو IP العام" required />
                </div>
                <div class="field">
                  <label>اسم الراوتر (shortname)</label>
                  <input type="text" id="nas-short" dir="ltr" placeholder="MikroTik-Main" required />
                </div>
                <div class="field">
                  <label>كلمة السر (RADIUS Secret)</label>
                  <input type="text" id="nas-secret" dir="ltr" value="RadSecret2026!" required />
                </div>
                <div class="field">
                  <label>الوصف</label>
                  <input type="text" id="nas-desc" placeholder="الراوتر الرئيسي" />
                </div>
              </div>
              <button type="submit" class="btn btn-primary btn-xs">➕ إضافة / تحديث راوتر في جدول nas</button>
            </form>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>IP الراوتر</th>
                    <th>الاسم</th>
                    <th>Secret</th>
                    <th>الوصف</th>
                    <th>حذف</th>
                  </tr>
                </thead>
                <tbody id="nas-tbody"></tbody>
              </table>
            </div>
          </div>

          <!-- Add & List Access Points / Modems Mapping -->
          <div class="card">
            <div class="card-title">📡 ربط المودمات والأكسس بوينت (Access Points IP)</div>
            <form onsubmit="handleAddAp(event)" style="margin-bottom:14px; padding-bottom:14px; border-bottom:1px solid var(--border);">
              <div class="form-grid">
                <div class="field">
                  <label>اسم سيرفر الهوت سبوت (Called-Station-Id)</label>
                  <input type="text" id="ap-match" dir="ltr" placeholder="hotspot1 أو hs-north" required />
                </div>
                <div class="field">
                  <label>IP المودم / الأكسس بوينت الحقيقي</label>
                  <input type="text" id="ap-ip" dir="ltr" placeholder="192.168.10.11" required />
                </div>
                <div class="field">
                  <label>اسم الموقع / المودم</label>
                  <input type="text" id="ap-name" placeholder="مودم البرج الشمالي" required />
                </div>
              </div>
              <button type="submit" class="btn btn-emerald btn-xs">➕ ربط مودم / أكسس بوينت</button>
            </form>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Called-Station-Id</th>
                    <th>IP المودم</th>
                    <th>اسم المودم</th>
                    <th>حذف</th>
                  </tr>
                </thead>
                <tbody id="ap-tbody"></tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="grid-2">
          <div class="card">
            <div class="card-title">🔑 أحدث السجلات في جدول radcheck</div>
            <div class="table-wrap">
              <table dir="ltr" style="text-align:left;">
                <thead>
                  <tr><th>username</th><th>attribute</th><th>op</th><th>value</th></tr>
                </thead>
                <tbody id="radcheck-tbody"></tbody>
              </table>
            </div>
          </div>

          <div class="card">
            <div class="card-title">🔗 أحدث السجلات في جدول radusergroup</div>
            <div class="table-wrap">
              <table dir="ltr" style="text-align:left;">
                <thead>
                  <tr><th>username</th><th>groupname</th><th>priority</th></tr>
                </thead>
                <tbody id="radusergroup-tbody"></tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    </main>
  </div>

  <!-- ===================================================================== -->
  <!-- USER / CARD DETAILS MODAL (Matching MikroTik User Manager Screenshot) -->
  <!-- ===================================================================== -->
  <div class="modal-backdrop" id="user-details-modal" onclick="if(event.target===this) closeUserModal()">
    <div class="um-modal">
      <div class="um-header">
        <span id="um-modal-title">تفاصيل المستخدم</span>
        <button class="um-close" onclick="closeUserModal()">✕</button>
      </div>

      <div class="um-body" id="um-modal-body"></div>

      <div class="um-footer">
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <button class="btn btn-primary" onclick="saveUserDetails()">💾 حفظ التعديلات</button>
          <button class="btn btn-indigo" style="background:#312e81; color:#fff;" onclick="toggleUserSessionsTable()">
            📊 عرض الجلسات الخاصة بالكرت (<span id="um-sessions-count">0</span>)
          </button>
        </div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;" id="um-footer-actions"></div>
      </div>
    </div>
  </div>

  <script>
    let currentTab = 'dashboard';
    let currentActorId = 1;
    let currentCardsStatusFilter = 'ALL';
    let currentPrintableBatch = null;
    let currentProfiles = [];
    let activeModalUsername = null;
    let showModalSessions = false;

    function formatBytes(bytes) {
      const b = Number(bytes) || 0;
      if (b <= 0) return '0 B';
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
      const i = Math.floor(Math.log(b) / Math.log(1024));
      return (b / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
    }

    function formatMib(bytes) {
      const b = Number(bytes) || 0;
      return (b / (1024 * 1024)).toFixed(1) + ' MiB';
    }

    function formatUptime(sec) {
      const s = Math.max(0, Number(sec) || 0);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const r = s % 60;
      if (h > 0) return h + 'h' + m + 'm' + r + 's';
      if (m > 0) return m + 'm' + r + 's';
      return r + 's';
    }

    function formatQuotaMb(mb) {
      const val = Number(mb);
      if (!val || val <= 0) return 'غير محدود';
      if (val >= 1024) {
        const gb = val / 1024;
        const gbStr = Number.isInteger(gb) ? String(gb) : gb.toFixed(1);
        return gbStr + ' GB (' + val + ' MB)';
      }
      return val + ' MB';
    }

    function formatHoursFromSeconds(sec) {
      const val = Number(sec);
      if (!val || val <= 0) return 'مفتوح (غير محدود)';
      const hrs = val / 3600;
      return (Number.isInteger(hrs) ? String(hrs) : hrs.toFixed(1)) + ' ساعة';
    }

    function formatValidityDays(days) {
      const val = Number(days);
      if (!val || val <= 0) return 'بدون انتهاء صلاحية';
      return val + ' يوم';
    }

    function formatSpeedLabel(speed) {
      const s = String(speed || '').trim();
      return s || 'من المايكروتك (Queues)';
    }

    function formatDateTime(val) {
      if (!val) return '-';
      const d = new Date(val);
      if (Number.isNaN(d.getTime())) return String(val);
      return d.toLocaleString('en-US');
    }

    function showToast(type, msg) {
      const box = document.getElementById('toast-box');
      box.style.display = 'block';
      box.style.background = type === 'success' ? '#ecfdf5' : '#fef2f2';
      box.style.color = type === 'success' ? '#065f46' : '#991b1b';
      box.style.border = type === 'success' ? '1px solid #a7f3d0' : '1px solid #fecaca';
      box.textContent = (type === 'success' ? '✅ ' : '⚠️ ') + msg;
      setTimeout(() => { box.style.display = 'none'; }, 5000);
    }

    function closeOpenResetMenus() {
      document.querySelectorAll('.reset-menu.open').forEach((el) => el.classList.remove('open'));
    }

    function openSidebar() {
      const sb = document.getElementById('sidebar');
      const bd = document.getElementById('sidebar-backdrop');
      const btn = document.getElementById('menu-toggle-btn');
      if (sb) sb.classList.add('open');
      if (bd) bd.classList.add('open');
      if (btn) btn.setAttribute('aria-expanded', 'true');
      document.body.classList.add('no-scroll');
    }

    function closeSidebar() {
      const sb = document.getElementById('sidebar');
      const bd = document.getElementById('sidebar-backdrop');
      const btn = document.getElementById('menu-toggle-btn');
      if (sb) sb.classList.remove('open');
      if (bd) bd.classList.remove('open');
      if (btn) btn.setAttribute('aria-expanded', 'false');
      document.body.classList.remove('no-scroll');
    }

    function toggleSidebar() {
      const sb = document.getElementById('sidebar');
      if (sb && sb.classList.contains('open')) closeSidebar();
      else openSidebar();
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeSidebar();
        closeOpenResetMenus();
        const modal = document.getElementById('user-details-modal');
        if (modal && modal.classList.contains('open')) closeUserModal();
      }
    });

    window.addEventListener('scroll', closeOpenResetMenus, true);
    window.addEventListener('resize', () => {
      closeOpenResetMenus();
      if (window.innerWidth > 1024) closeSidebar();
    });

    // Close open reset menus when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.reset-wrap')) {
        closeOpenResetMenus();
      }
    });

    function toggleResetMenu(menuId, ev) {
      ev.stopPropagation();
      const menu = document.getElementById(menuId);
      if (!menu) return;
      const wasOpen = menu.classList.contains('open');
      closeOpenResetMenus();
      if (wasOpen) return;

      const trigger = ev.currentTarget || ev.target;
      const rect = trigger.getBoundingClientRect();
      menu.classList.add('open');
      const menuRect = menu.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuRect.width - 8));
      let top = rect.bottom + 4;
      if (top + menuRect.height > window.innerHeight - 8) {
        top = Math.max(8, rect.top - menuRect.height - 4);
      }
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
    }

    async function api(path, options = {}) {
      const res = await fetch(path, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'x-actor-id': String(currentActorId),
          ...(options.headers || {})
        }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'خطأ في العملية');
      return data;
    }

    const TAB_TITLES = {
      dashboard: 'لوحة القيادة ومؤشرات الأداء اللحظية',
      cards: 'إدارة الكروت والمستخدمين',
      sessions: 'المتصلون الآن ومراقبة الجلسات (Live CoA)',
      vouchers: 'توليد وطباعة الكروت (A4)',
      profiles: 'الباقات والسرعات (Profiles)',
      resellers: 'الموزعون والأرصدة والعمليات المالية (RBAC)',
      radius_db: 'فاحص جداول FreeRADIUS وربط MikroTik'
    };

    function switchTab(tab, statusFilter = null) {
      currentTab = tab;
      closeSidebar();
      closeOpenResetMenus();
      const titleEl = document.getElementById('page-title');
      if (titleEl && TAB_TITLES[tab]) titleEl.textContent = TAB_TITLES[tab];
      ['dashboard', 'cards', 'sessions', 'vouchers', 'profiles', 'resellers', 'radius_db'].forEach((t) => {
        const sec = document.getElementById('tab-' + t);
        if (sec) sec.style.display = t === tab ? 'block' : 'none';
        const btn = document.getElementById('nav-' + t);
        if (btn) btn.className = 'nav-btn' + (t === tab ? ' active' : '');
      });
      if (tab === 'cards') {
        if (statusFilter) {
          currentCardsStatusFilter = statusFilter;
          updateStatusPillsUI();
        }
        loadCardsDirectory();
      }
      if (tab === 'sessions') {
        loadSessions();
      }
    }

    function updateStatusPillsUI() {
      document.querySelectorAll('#cards-status-pills .pill-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-status') === currentCardsStatusFilter);
      });
    }

    function filterCardsByStatus(status) {
      currentCardsStatusFilter = status;
      updateStatusPillsUI();
      loadCardsDirectory();
    }

    function changeActor(val) {
      currentActorId = Number(val);
      refreshAll();
    }

    /**
     * Renders the 5 operational action buttons for any card row (in Active Sessions or Cards Directory)
     */
    function renderFiveActionsHtml(username, isOnline, status, prefixId) {
      const menuId = 'reset-menu-' + prefixId + '-' + username;
      return \`
        <div class="action-group">
          <button class="btn btn-danger btn-xs" onclick="cardAction('\${username}', 'disconnect')" title="فصل أو إغلاق الجلسة الحية">
            ⛔ فصل
          </button>
          \${status === 'DISABLED'
            ? \`<button class="btn btn-emerald btn-xs" onclick="cardAction('\${username}', 'enable')">✅ تمكين</button>\`
            : \`<button class="btn btn-amber btn-xs" onclick="cardAction('\${username}', 'disable')">🚫 تعطيل</button>\`
          }
          \${status !== 'DISABLED'
            ? \`<button class="btn btn-light btn-xs" onclick="cardAction('\${username}', 'enable')" title="تمكين الكرت">✅ تمكين</button>\`
            : ''
          }
          <div class="reset-wrap">
            <button class="btn btn-light btn-xs" onclick="toggleResetMenu('\${menuId}', event)">
              🔄 تصفير ▾
            </button>
            <div class="reset-menu" id="\${menuId}">
              <button class="reset-item" onclick="cardAction('\${username}', 'reset', 'DATA_TIME')">📊 تصفير الاستهلاك والوقت فقط</button>
              <button class="reset-item" onclick="cardAction('\${username}', 'reset', 'MAC_ONLY')">🔓 فك قفل الماك أدريس فقط</button>
              <button class="reset-item" style="color:#dc2626;" onclick="cardAction('\${username}', 'reset', 'FULL_RESET')">♻️ تصفير شامل وإعادة الكرت كجديد</button>
            </div>
          </div>
          <button class="btn btn-danger btn-xs" onclick="confirmDeleteCard('\${username}')" title="حذف الكرت نهائياً">
            🗑️ حذف
          </button>
        </div>
      \`;
    }

    async function cardAction(username, action, resetMode = 'FULL_RESET') {
      document.querySelectorAll('.reset-menu.open').forEach((el) => el.classList.remove('open'));
      try {
        const res = await api('/api/vouchers/cards/' + encodeURIComponent(username) + '/action', {
          method: 'POST',
          body: JSON.stringify({ action, resetMode })
        });
        showToast('success', res.message);
        await refreshAll();
        if (activeModalUsername === username) {
          if (action === 'delete') closeUserModal();
          else openUserModal(username);
        }
      } catch (e) {
        showToast('error', e.message);
      }
    }

    function confirmDeleteCard(username) {
      if (confirm('هل أنت متأكد من حذف الكرت (' + username + ') نهائياً من النظام وجداول FreeRADIUS؟')) {
        cardAction(username, 'delete');
      }
    }

    async function loadCardsDirectory() {
      const q = document.getElementById('cards-search')?.value || '';
      const profId = document.getElementById('cards-profile-filter')?.value || 'ALL';
      const data = await api(
        '/api/vouchers/cards?status=' + encodeURIComponent(currentCardsStatusFilter) +
        '&profileId=' + encodeURIComponent(profId) +
        '&search=' + encodeURIComponent(q)
      );

      document.getElementById('cards-count-label').textContent = 'عدد الكروت المعروضة: ' + data.cards.length + ' كرت';
      const tbody = document.getElementById('cards-tbody');
      if (!data.cards.length) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:28px; color:#94a3b8;">لا توجد كروت مطابقة للفلتر المحدد</td></tr>';
        return;
      }

      tbody.innerHTML = data.cards.map((c) => {
        let statusBadge = '';
        if (c.status === 'ACTIVE') statusBadge = '<span class="tag tag-emerald">نشط</span>';
        else if (c.status === 'UNUSED') statusBadge = '<span class="tag tag-indigo">متاح (جديد)</span>';
        else if (c.status === 'EXPIRED') statusBadge = '<span class="tag tag-amber">منتهي</span>';
        else statusBadge = '<span class="tag tag-red">معطل</span>';

        const upB = Number(c.used_upload_bytes) || 0;
        const downB = Number(c.used_download_bytes) || 0;
        const totalB = (c.used_total_bytes !== undefined && c.used_total_bytes !== null) ? Number(c.used_total_bytes) : (upB + downB);
        const firstUsedHtml = c.first_used_at ? formatDateTime(c.first_used_at) : 'لم يُستخدم';
        const expiryHtml = c.expires_at
          ? formatDateTime(c.expires_at)
          : (Number(c.validity_days) > 0 ? c.validity_days + ' يوم من أول دخول' : 'بدون انتهاء');

        return \`
          <tr>
            <td>
              <button class="user-link" onclick="openUserModal('\${c.username}')" title="اضغط لعرض وتعديل تفاصيل الكرت">
                👤 \${c.username}
              </button>
            </td>
            <td class="mono">\${c.cleartext_password}</td>
            <td>
              <b>\${c.profile_name || '-'}</b>
              \${c.profile_display_name && c.profile_display_name !== c.profile_name ? \`<span style="font-size:11px; color:#334155;"> (\${c.profile_display_name})</span>\` : ''}
              <span style="font-size:11px; color:#64748b;">(\${c.speed_limit ? c.speed_limit : 'Queues'})</span>
            </td>
            <td>\${statusBadge}</td>
            <td class="mono" dir="ltr" style="font-size:11.5px;">
              <div><b style="color:#4338ca;">\${formatBytes(totalB)}</b>\${c.data_limit_mb ? \` <span style="color:#64748b; font-size:10.5px;">/ \${formatQuotaMb(c.data_limit_mb)}</span>\` : ''}</div>
              <div style="font-size:10.5px; color:#64748b;">↓ \${formatBytes(downB)} | ↑ \${formatBytes(upB)}</div>
            </td>
            <td class="mono">\${formatUptime(c.used_uptime_seconds)}</td>
            <td style="font-size:11px; line-height:1.45;">
              <div>أول استخدام: <span class="mono" dir="ltr">\${firstUsedHtml}</span></div>
              <div style="color:#64748b;">الانتهاء: <span class="mono" dir="ltr">\${expiryHtml}</span></div>
            </td>
            <td class="mono" dir="ltr" style="font-size:11.5px;">
              \${c.modem_ip ? \`<b style="color:#0f172a;">\${c.modem_ip}</b> <span style="color:#64748b;">(\${c.modem_name})</span>\` : '<span style="color:#94a3b8;">لم يتصل بعد</span>'}
            </td>
            <td>\${c.reseller_username || 'admin'}</td>
            <td>\${renderFiveActionsHtml(c.username, c.is_online, c.status, 'dir')}</td>
          </tr>
        \`;
      }).join('');
    }

    let sessionsRefreshing = false;

    if (!window.__sessionsAutoRefresh) {
      window.__sessionsAutoRefresh = setInterval(() => {
        const tb = document.getElementById('sessions-tbody');
        if (!document.hidden && tb && tb.offsetParent !== null) {
          loadSessions().catch(() => {});
        }
      }, 10000);
    }

    async function loadSessions() {
      if (sessionsRefreshing) return;
      sessionsRefreshing = true;
      try {
        const q = document.getElementById('session-search')?.value || '';
        const sessData = await api('/api/sessions/active?search=' + encodeURIComponent(q));
        document.getElementById('nav-sessions-badge').textContent = sessData.count;
        const tbody = document.getElementById('sessions-tbody');
        if (!sessData.sessions.length) {
          tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:30px; color:#94a3b8;">لا توجد جلسات نشطة مطابقة حالياً</td></tr>';
          return;
        }
        tbody.innerHTML = sessData.sessions.map((s) => {
          const up = Number(s.acctinputoctets) || 0;
          const down = Number(s.acctoutputoctets) || 0;
          const total = (s.total_bytes !== undefined && s.total_bytes !== null) ? Number(s.total_bytes) : (up + down);
          return \`
            <tr>
              <td>
                <button class="user-link" onclick="openUserModal('\${s.username}')" title="اضغط لفتح تفاصيل المستخدم/الكرت">
                  👤 \${s.username}
                </button>
              </td>
              <td class="mono" dir="ltr">\${s.framedipaddress || '-'}</td>
              <td class="mono" dir="ltr" style="color:#475569;">\${s.callingstationid || '-'}</td>
              <td class="mono" dir="ltr">
                <span class="tag tag-emerald" style="font-size:11.5px;">
                  🌐 \${s.modem_ip || s.nasipaddress || '-'}
                </span>
                <span style="font-size:11px; color:#475569; margin-right:4px;">(\${s.modem_name || 'Main-AP'})</span>
              </td>
              <td><span class="tag tag-indigo mono">⏱️ \${formatUptime(s.acctsessiontime)}</span></td>
              <td class="mono" dir="ltr" style="color:#b45309;">⬆️ \${formatBytes(up)}</td>
              <td class="mono" dir="ltr" style="color:#047857;">⬇️ \${formatBytes(down)}</td>
              <td class="mono" dir="ltr"><b style="color:#4338ca;">\${formatBytes(total)}</b></td>
              <td>\${renderFiveActionsHtml(s.username, true, s.card_status || 'ACTIVE', 'sess')}</td>
            </tr>
          \`;
        }).join('');
      } finally {
        sessionsRefreshing = false;
      }
    }

    /**
     * Opens the MikroTik User Manager Style User Details Modal
     */
    async function openUserModal(username) {
      try {
        const data = await api('/api/vouchers/cards/' + encodeURIComponent(username));
        activeModalUsername = data.card.username;
        showModalSessions = false;
        renderUserModalContent(data);
        document.getElementById('user-details-modal').classList.add('open');
      } catch (e) {
        showToast('error', e.message);
      }
    }

    function closeUserModal() {
      document.getElementById('user-details-modal').classList.remove('open');
      activeModalUsername = null;
    }

    function toggleSec(secId) {
      const el = document.getElementById(secId);
      if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }

    function toggleUserSessionsTable() {
      showModalSessions = !showModalSessions;
      const box = document.getElementById('um-sessions-box');
      if (box) {
        box.style.display = showModalSessions ? 'block' : 'none';
        if (showModalSessions) box.scrollIntoView({ behavior: 'smooth' });
      }
    }

    function renderUserModalContent(data) {
      const c = data.card;
      const sessions = data.sessions || [];
      const profiles = data.availableProfiles || [];

      document.getElementById('um-modal-title').textContent = 'تفاصيل المستخدم — ' + c.username;
      document.getElementById('um-sessions-count').textContent = sessions.length;

      const transferLimitText = formatQuotaMb(c.data_limit_mb);
      const validityText = formatValidityDays(c.validity_days);
      const profileUptimeText = formatHoursFromSeconds(c.time_limit);
      const startTimeText = c.first_used_at ? formatDateTime(c.first_used_at) : 'لم يُستخدم بعد';
      const endTimeText = c.expires_at
        ? formatDateTime(c.expires_at)
        : (Number(c.validity_days) > 0 ? 'يبدأ عند أول دخول (' + c.validity_days + ' يوم)' : 'بدون انتهاء صلاحية');
      const remTimeText = c.remaining_seconds !== null && c.remaining_seconds !== undefined ? formatUptime(c.remaining_seconds) : 'غير محدود';
      const usedUploadBytes = Number(c.used_upload_bytes) || 0;
      const usedDownloadBytes = Number(c.used_download_bytes) || 0;
      const totalUsedBytes = (c.used_total_bytes !== undefined && c.used_total_bytes !== null)
        ? Number(c.used_total_bytes)
        : (usedUploadBytes + usedDownloadBytes);
      const totalQuotaBytes = c.data_limit_mb ? Number(c.data_limit_mb) * 1024 * 1024 : null;
      const remainingBytes = (c.remaining_bytes !== undefined && c.remaining_bytes !== null)
        ? Number(c.remaining_bytes)
        : (totalQuotaBytes !== null ? Math.max(0, totalQuotaBytes - totalUsedBytes) : null);
      const remainingBytesText = c.data_limit_mb
        ? formatBytes(remainingBytes) + ' / ' + formatQuotaMb(c.data_limit_mb)
        : 'غير محدود';

      document.getElementById('um-modal-body').innerHTML = \`
        <!-- 1. الرئيسي (Main) -->
        <div class="um-section">
          <div class="um-sec-title" onclick="toggleSec('um-sec-main')">▼ الرئيسي</div>
          <div class="um-sec-content" id="um-sec-main">
            <div class="um-row">
              <div class="um-label">:اسم المستخدم</div>
              <div><input type="text" id="um-edit-username" class="um-input" dir="ltr" value="\${c.username}" /></div>
            </div>
            <div class="um-row">
              <div class="um-label">:كلمة المرور</div>
              <div><input type="text" id="um-edit-password" class="um-input" dir="ltr" value="\${c.cleartext_password}" /></div>
            </div>
            <div class="um-row">
              <div class="um-label">:تعطيل</div>
              <div><input type="checkbox" id="um-edit-disabled" \${c.status === 'DISABLED' ? 'checked' : ''} style="width:17px; height:17px;" /></div>
            </div>
            <div class="um-row">
              <div class="um-label">:المالك</div>
              <div class="um-val mono">\${c.reseller_username || 'admin'}</div>
            </div>
          </div>
        </div>

        <!-- 2. الملف المستخدم (Active Profile) -->
        <div class="um-section">
          <div class="um-sec-title" onclick="toggleSec('um-sec-prof')">▲ الملف المستخدم</div>
          <div class="um-sec-content" id="um-sec-prof">
            <div class="um-row">
              <div class="um-label">:الباقة المرتبطة</div>
              <div class="um-val mono"><b>\${c.profile_name || '-'}</b> (\${c.profile_display_name || '-'})</div>
            </div>
            <div class="um-row">
              <div class="um-label">:تاريخ أول استخدام</div>
              <div class="um-val mono" dir="ltr">\${startTimeText}</div>
            </div>
            <div class="um-row">
              <div class="um-label">:تاريخ الانتهاء</div>
              <div class="um-val mono" dir="ltr">\${endTimeText}</div>
            </div>
            <div class="um-row">
              <div class="um-label">:وقت الاستخدام الفعلي للباقة</div>
              <div class="um-val">\${profileUptimeText}</div>
            </div>
            <div class="um-row">
              <div class="um-label">:الوقت المتبقي</div>
              <div class="um-val mono" dir="ltr">\${remTimeText}</div>
            </div>
            <div class="um-row">
              <div class="um-label">:الكوتا الإجمالية (النقل)</div>
              <div class="um-val mono" dir="ltr">\${transferLimitText}</div>
            </div>
            <div class="um-row">
              <div class="um-label">:صلاحية الكارت من أول استخدام</div>
              <div class="um-val">\${validityText}</div>
            </div>
            <div class="um-row">
              <div class="um-label">Rate limit:</div>
              <div>
                <input type="text" id="um-edit-ratelimit" class="um-input" dir="ltr" value="\${c.speed_limit || ''}" placeholder="فارغ = حسب الباقة أو Queues في المايكروتك" />
              </div>
            </div>
          </div>
        </div>

        <!-- 3. القيود (Constraints) -->
        <div class="um-section">
          <div class="um-sec-title" onclick="toggleSec('um-sec-const')">▼ القيود & Wireless & المعلومات الخاصة</div>
          <div class="um-sec-content" id="um-sec-const">
            <div class="um-row">
              <div class="um-label">:قفل الماك (Caller-ID)</div>
              <div style="display:flex; gap:6px; flex-wrap:wrap;">
                <input type="text" id="um-edit-mac" class="um-input" dir="ltr" style="flex:1 1 180px;" value="\${c.bound_mac || ''}" placeholder="فارغ = يسمح لأي جهاز" />
                <button type="button" class="btn btn-light btn-xs" onclick="document.getElementById('um-edit-mac').value=''">فك القفل</button>
              </div>
            </div>
            <div class="um-row">
              <div class="um-label">:ملاحظات الكرت</div>
              <div><input type="text" id="um-edit-notes" class="um-input" value="\${c.notes || ''}" /></div>
            </div>
          </div>
        </div>

        <!-- 4. الاحصائيات (Statistics) -->
        <div class="um-section">
          <div class="um-sec-title" onclick="toggleSec('um-sec-stats')">▲ الاحصائيات</div>
          <div class="um-sec-content" id="um-sec-stats">
            <div class="um-row">
              <div class="um-label">:الرفع المستخدم</div>
              <div class="um-val mono" dir="ltr">\${formatBytes(usedUploadBytes)}</div>
            </div>
            <div class="um-row">
              <div class="um-label">:التحميل المستخدم</div>
              <div class="um-val mono" dir="ltr">\${formatBytes(usedDownloadBytes)}</div>
            </div>
            <div class="um-row">
              <div class="um-label">:الاستهلاك الإجمالي (تحميل + رفع)</div>
              <div class="um-val mono" dir="ltr" style="color:#4338ca; font-weight:800;">\${formatBytes(totalUsedBytes)}</div>
            </div>
            <div class="um-row">
              <div class="um-label">:الرصيد المتبقي من البيانات</div>
              <div class="um-val mono" dir="ltr" style="color:#059669; font-weight:800;">\${remainingBytesText}</div>
            </div>
            <div class="um-row">
              <div class="um-label">:الوقت المستخدم</div>
              <div class="um-val mono" dir="ltr">\${formatUptime(c.used_uptime_seconds)}</div>
            </div>
            <div class="um-row">
              <div class="um-label">:آخر آي بي مستخدم</div>
              <div class="um-val mono" dir="ltr">\${c.last_ip}</div>
            </div>
            <div class="um-row">
              <div class="um-label">:آخر ماك أدريس مستخدم</div>
              <div class="um-val mono" dir="ltr">\${c.last_mac}</div>
            </div>
            <div class="um-row">
              <div class="um-label">:آي بي المودم / الأكسس بوينت</div>
              <div class="um-val mono" dir="ltr" style="color:#059669; font-weight:800;">\${c.modem_ip} (\${c.modem_name})</div>
            </div>
            <div class="um-row">
              <div class="um-label">:حتى الوقت</div>
              <div class="um-val">\${c.last_seen}</div>
            </div>
            <div class="um-row">
              <div class="um-label">:اجمالي الوقت المتبقي</div>
              <div class="um-val mono" dir="ltr">\${remTimeText}</div>
            </div>
          </div>
        </div>

        <!-- 5. الفواتير (Billing) -->
        <div class="um-section">
          <div class="um-sec-title" onclick="toggleSec('um-sec-bill')">▲ الفواتير</div>
          <div class="um-sec-content" id="um-sec-bill">
            <div class="um-row">
              <div class="um-label">:المال المدفوع</div>
              <div class="um-val mono" dir="ltr">\${Number(c.price || 0).toFixed(2)}</div>
            </div>
            <div class="um-row">
              <div class="um-label">:المال المستخدم</div>
              <div class="um-val mono" dir="ltr">\${Number(c.price || 0).toFixed(2)}</div>
            </div>
            <div class="um-row">
              <div class="um-label">:المال المتبقي</div>
              <div class="um-val mono" dir="ltr">0.00</div>
            </div>
          </div>
        </div>

        <!-- 6. اجمالي الملفات (Profiles Assignment) -->
        <div class="um-section">
          <div class="um-sec-title" onclick="toggleSec('um-sec-allprof')">▲ اجمالي الملفات</div>
          <div class="um-sec-content" id="um-sec-allprof">
            <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:8px;">
              <span><b>\${c.profile_name}</b> :مفعل</span>
              <span class="tag tag-emerald">الباقة الفعالة</span>
            </div>
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
              <span style="font-size:12px; font-weight:700;">تغيير أو ترقية الباقة (+):</span>
              <select id="um-edit-profile" class="um-input" style="max-width:100%; flex:1 1 220px;">
                \${profiles.map((p) => \`
                  <option value="\${p.id}" \${p.id === c.profile_id ? 'selected' : ''}>
                    \${p.name} (\${Number(p.price).toFixed(2)}) - \${p.display_name}
                  </option>
                \`).join('')}
              </select>
            </div>
          </div>
        </div>

        <!-- 7. جدول الجلسات الخاصة بالكرت (Card Sessions History) -->
        <div id="um-sessions-box" style="display:none; margin-top:14px; background:#fff; border:1px solid #94a3b8; border-radius:6px; padding:10px;">
          <div style="font-weight:800; margin-bottom:8px; color:#1e1b4b;">📊 سجل الجلسات الخاصة بالكرت (\${c.username}) في جدول radacct:</div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>وقت البدء</th>
                  <th>وقت التوقف</th>
                  <th>المدة</th>
                  <th>IP المشترك</th>
                  <th>الماك</th>
                  <th>IP المودم / AP</th>
                  <th>التحميل / الرفع</th>
                </tr>
              </thead>
              <tbody>
                \${sessions.length === 0
                  ? '<tr><td colspan="7" style="text-align:center; padding:14px;">لا توجد جلسات مسجلة لهذا الكرت بعد</td></tr>'
                  : sessions.map((s) => \`
                      <tr>
                        <td class="mono" dir="ltr" style="font-size:11px;">\${new Date(s.acctstarttime).toLocaleString('en-US')}</td>
                        <td class="mono" dir="ltr" style="font-size:11px;">\${s.acctstoptime ? new Date(s.acctstoptime).toLocaleString('en-US') : '<span class="tag tag-emerald">متصل الآن</span>'}</td>
                        <td class="mono">\${formatUptime(s.acctsessiontime)}</td>
                        <td class="mono" dir="ltr">\${s.framedipaddress}</td>
                        <td class="mono" dir="ltr">\${s.callingstationid}</td>
                        <td class="mono" dir="ltr"><b>\${s.modem_ip || s.nasipaddress}</b> (\${s.modem_name || '-'})</td>
                        <td class="mono" dir="ltr">↓ \${formatMib(s.acctoutputoctets)} | ↑ \${formatMib(s.acctinputoctets)}</td>
                      </tr>
                    \`).join('')
                }
              </tbody>
            </table>
          </div>
        </div>
      \`;

      document.getElementById('um-footer-actions').innerHTML = renderFiveActionsHtml(c.username, c.is_online, c.status, 'modal');
    }

    async function saveUserDetails() {
      if (!activeModalUsername) return;
      try {
        const payload = {
          username: document.getElementById('um-edit-username').value,
          cleartext_password: document.getElementById('um-edit-password').value,
          is_disabled: document.getElementById('um-edit-disabled').checked,
          custom_rate_limit: document.getElementById('um-edit-ratelimit').value,
          bound_mac: document.getElementById('um-edit-mac').value,
          notes: document.getElementById('um-edit-notes').value,
          profile_id: Number(document.getElementById('um-edit-profile').value)
        };
        const updated = await api('/api/vouchers/cards/' + encodeURIComponent(activeModalUsername), {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
        activeModalUsername = updated.card.username;
        renderUserModalContent(updated);
        showToast('success', 'تم حفظ تعديلات الكرت (' + activeModalUsername + ') في جداول FreeRADIUS بنجاح!');
        refreshAll();
      } catch (e) {
        showToast('error', e.message);
      }
    }

    async function simulateNewSession() {
      try {
        const s = await api('/api/sessions/simulate', { method: 'POST' });
        showToast('success', 'تمت محاكاة دخول مشترك جديد (' + s.username + ') عبر المودم ' + s.modem_ip);
        refreshAll();
      } catch (e) {
        showToast('error', e.message);
      }
    }

    async function loadBatchForPrint(batchId) {
      try {
        currentPrintableBatch = await api('/api/vouchers/batches/' + batchId + '/print');
        switchTab('vouchers');
        renderPrintPreview();
      } catch (e) {
        showToast('error', e.message);
      }
    }

    function renderPrintPreview() {
      saveBrandSettings();
      const container = document.getElementById('print-preview-container');
      if (!currentPrintableBatch) {
        container.innerHTML = '';
        return;
      }
      const brandName = document.getElementById('brand-name').value;
      const brandUrl = document.getElementById('brand-url').value.trim();
      const brandPhone = document.getElementById('brand-phone').value;
      const perPage = Number(document.getElementById('brand-perpage').value) || 40;
      const showQr = document.getElementById('brand-qr').checked;

      const cards = currentPrintableBatch.cards;
      const batch = currentPrintableBatch.batch;
      const pages = [];
      for (let i = 0; i < cards.length; i += perPage) {
        pages.push(cards.slice(i, i + perPage));
      }

      container.innerHTML = \`
        <div class="no-print print-preview-bar">
          <strong>🖨️ معاينة طباعة الدفعة: \${batch.batch_code} (\${cards.length} كرت - \${batch.profile_display_name})</strong>
          <button class="btn btn-emerald" onclick="window.print()">اطبع الورقة الآن (A4)</button>
        </div>
      \` + pages.map((pageCards) => \`
        <div class="a4-sheet">
          <div class="\${perPage === 40 ? 'voucher-grid-40' : 'voucher-grid-30'}">
            \${pageCards.map((c) => {
              const sep = brandUrl.includes('?') ? '&' : '?';
              const qrData = encodeURIComponent(brandUrl + sep + 'username=' + encodeURIComponent(c.username) + '&password=' + encodeURIComponent(c.cleartextPassword));
              return \`
                <div class="v-card">
                  <div class="v-head">
                    <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:68%;">\${brandName}</span>
                    <span class="v-price">\${batch.price} ر.س</span>
                  </div>
                  <div class="v-body">
                    <div style="flex:1;">
                      <div style="font-size:8.5px; color:#64748b;">\${batch.profile_display_name}\${batch.speed_limit ? \` (\${batch.speed_limit})\` : ''}</div>
                      \${batch.voucher_type === 'PIN_ONLY'
                        ? \`<div class="v-pin">\${c.username}</div>\`
                        : \`<div class="mono" style="font-size:9.5px; margin-top:2px;">
                             <div>المستخدم: <b>\${c.username}</b></div>
                             <div>المرور: <b>\${c.cleartextPassword}</b></div>
                           </div>\`
                      }
                    </div>
                    \${showQr ? \`<img src="https://api.qrserver.com/v1/create-qr-code/?size=60x60&margin=0&data=\${qrData}" style="width:38px; height:38px; border:1px solid #e2e8f0; border-radius:4px; padding:1px;" alt="QR" />\` : ''}
                  </div>
                  <div class="v-foot">
                    <span class="mono">\${c.serialNumber}</span>
                    <span>دعم: \${brandPhone}</span>
                  </div>
                </div>
              \`;
            }).join('')}
          </div>
        </div>
      \`).join('');
    }

    async function handleGenerateBatch(e) {
      e.preventDefault();
      try {
        const payload = {
          profileId: Number(document.getElementById('gen-profile').value),
          quantity: Number(document.getElementById('gen-qty').value),
          voucherType: document.getElementById('gen-type').value,
          prefix: document.getElementById('gen-prefix').value,
          codeLength: Number(document.getElementById('gen-len').value),
          charsetType: document.getElementById('gen-charset').value
        };
        const res = await api('/api/vouchers/batches', { method: 'POST', body: JSON.stringify(payload) });
        showToast('success', 'تم توليد ' + res.quantity + ' كرت بنجاح في دفعة ' + res.batchCode + ' وإضافتها إلى radcheck!');
        await refreshAll();
        await loadBatchForPrint(res.batchId);
      } catch (err) {
        showToast('error', err.message);
      }
    }

    function startEditProfile(id) {
      const p = currentProfiles.find((item) => Number(item.id) === Number(id));
      if (!p) return;
      document.getElementById('prof-edit-id').value = String(p.id);
      document.getElementById('prof-name').value = p.name || '';
      document.getElementById('prof-display').value = p.display_name || '';
      document.getElementById('prof-price').value = Number(p.price || 0);
      document.getElementById('prof-cost').value = Number(p.cost_price || 0);
      document.getElementById('prof-speed').value = p.speed_limit || '';
      document.getElementById('prof-hours').value = p.time_limit ? Number((Number(p.time_limit) / 3600).toFixed(2)) : 0;
      document.getElementById('prof-quota').value = p.data_limit_mb ? Number(p.data_limit_mb) : 0;
      document.getElementById('prof-validity').value = p.validity_days ? Number(p.validity_days) : 0;
      document.getElementById('prof-form-title').textContent = '✏️ تعديل الباقة: ' + (p.display_name || p.name);
      document.getElementById('prof-submit-btn').textContent = '💾 حفظ التعديلات ومزامنة FreeRADIUS';
      document.getElementById('prof-cancel-btn').style.display = 'inline-flex';
      const formCard = document.getElementById('prof-form-card');
      if (formCard) formCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function cancelEditProfile() {
      document.getElementById('prof-edit-id').value = '';
      document.getElementById('prof-name').value = '';
      document.getElementById('prof-display').value = '';
      document.getElementById('prof-price').value = '1500';
      document.getElementById('prof-cost').value = '1200';
      document.getElementById('prof-speed').value = '';
      document.getElementById('prof-hours').value = '72';
      document.getElementById('prof-quota').value = '10240';
      document.getElementById('prof-validity').value = '30';
      document.getElementById('prof-form-title').textContent = '➕ إضافة باقة جديدة (تزامن مع radgroupreply)';
      document.getElementById('prof-submit-btn').textContent = '💾 حفظ الباقة ومزامنة FreeRADIUS';
      document.getElementById('prof-cancel-btn').style.display = 'none';
    }

    async function handleCreateProfile(e) {
      e.preventDefault();
      try {
        const editId = document.getElementById('prof-edit-id').value.trim();
        const speedVal = document.getElementById('prof-speed').value.trim();
        const hoursRaw = document.getElementById('prof-hours').value;
        const hours = hoursRaw === '' ? 0 : Number(hoursRaw);
        const quotaRaw = document.getElementById('prof-quota').value;
        const quotaMb = quotaRaw === '' ? 0 : Number(quotaRaw);
        const validityRaw = document.getElementById('prof-validity').value;
        const validityDays = validityRaw === '' ? 0 : Number(validityRaw);
        const payload = {
          name: document.getElementById('prof-name').value.trim(),
          displayName: document.getElementById('prof-display').value.trim(),
          price: Number(document.getElementById('prof-price').value),
          costPrice: Number(document.getElementById('prof-cost').value),
          speedLimit: speedVal || null,
          timeLimit: hours > 0 ? Math.round(hours * 3600) : null,
          dataLimitMb: quotaMb > 0 ? Math.round(quotaMb) : null,
          validityDays: validityDays > 0 ? Math.round(validityDays) : null,
          validity_days: validityDays > 0 ? Math.round(validityDays) : null,
          simultaneousUse: 1,
          portLimit: 1
        };
        if (editId) {
          await api('/api/profiles/' + encodeURIComponent(editId), { method: 'PUT', body: JSON.stringify(payload) });
          showToast('success', 'تم تعديل الباقة ومزامنة FreeRADIUS بنجاح دون التأثير على الكروت المرتبطة');
        } else {
          await api('/api/profiles', { method: 'POST', body: JSON.stringify(payload) });
          showToast('success', 'تم حفظ الباقة ومزامنة خصائص الميكروتك في radgroupreply و radgroupcheck');
        }
        cancelEditProfile();
        refreshAll();
      } catch (err) {
        showToast('error', err.message);
      }
    }

    async function deleteProfile(id) {
      if (!confirm('هل أنت متأكد من حذف هذه الباقة؟ (ملاحظة: لا يمكن حذف باقة مرتبطة بكروت حالية)')) return;
      try {
        await api('/api/profiles/' + id, { method: 'DELETE' });
        if (String(document.getElementById('prof-edit-id').value) === String(id)) {
          cancelEditProfile();
        }
        showToast('success', 'تم حذف الباقة بنجاح');
        refreshAll();
      } catch (err) {
        showToast('error', err.message);
      }
    }

    async function handleCreateReseller(e) {
      e.preventDefault();
      try {
        const payload = {
          name: document.getElementById('res-name').value,
          username: document.getElementById('res-user').value,
          phone: document.getElementById('res-phone').value,
          balance: Number(document.getElementById('res-balance').value),
          credit_limit: Number(document.getElementById('res-credit').value)
        };
        await api('/api/resellers', { method: 'POST', body: JSON.stringify(payload) });
        showToast('success', 'تم إنشاء حساب الموزع الجديد بنجاح');
        document.getElementById('res-name').value = '';
        document.getElementById('res-user').value = '';
        refreshAll();
      } catch (err) {
        showToast('error', err.message);
      }
    }

    async function topupReseller(id) {
      const amount = Number(document.getElementById('topup-' + id).value) || 200;
      try {
        await api('/api/resellers/' + id + '/topup', {
          method: 'POST',
          body: JSON.stringify({ amount, description: 'شحن رصيد مباشر من الإدارة' })
        });
        showToast('success', 'تم شحن ' + amount + ' ر.س في محفظة الموزع');
        refreshAll();
      } catch (err) {
        showToast('error', err.message);
      }
    }

    function loadBrandSettings() {
      try {
        const saved = JSON.parse(localStorage.getItem('radiuspro_brand') || '{}');
        if (saved.name) document.getElementById('brand-name').value = saved.name;
        if (saved.url) document.getElementById('brand-url').value = saved.url;
        if (saved.phone) document.getElementById('brand-phone').value = saved.phone;
      } catch {}
    }

    function saveBrandSettings() {
      try {
        localStorage.setItem('radiuspro_brand', JSON.stringify({
          name: document.getElementById('brand-name').value,
          url: document.getElementById('brand-url').value,
          phone: document.getElementById('brand-phone').value
        }));
      } catch {}
    }

    function copyMikrotikScript() {
      const box = document.getElementById('mikrotik-script-box');
      if (!box) return;
      navigator.clipboard.writeText(box.textContent || '')
        .then(() => showToast('success', 'تم نسخ أوامر MikroTik! الصقها في New Terminal داخل WinBox'))
        .catch(() => showToast('info', 'حدد النص وانسخه يدوياً'));
    }

    async function handleAddNas(e) {
      e.preventDefault();
      try {
        const payload = {
          nasname: document.getElementById('nas-ip').value.trim(),
          shortname: document.getElementById('nas-short').value.trim(),
          secret: document.getElementById('nas-secret').value.trim(),
          description: document.getElementById('nas-desc').value.trim()
        };
        await api('/api/radius/nas', { method: 'POST', body: JSON.stringify(payload) });
        showToast('success', 'تم حفظ راوتر MikroTik في جدول nas بنجاح');
        document.getElementById('nas-ip').value = '';
        document.getElementById('nas-short').value = '';
        document.getElementById('nas-desc').value = '';
        refreshAll();
      } catch (err) {
        showToast('error', err.message);
      }
    }

    async function deleteNas(id) {
      if (!confirm('هل تريد حذف هذا الراوتر من جدول nas؟')) return;
      try {
        await api('/api/radius/nas/' + id, { method: 'DELETE' });
        showToast('success', 'تم حذف الراوتر من جدول nas');
        refreshAll();
      } catch (err) {
        showToast('error', err.message);
      }
    }

    async function handleAddAp(e) {
      e.preventDefault();
      try {
        const payload = {
          match_value: document.getElementById('ap-match').value.trim(),
          ap_ip: document.getElementById('ap-ip').value.trim(),
          ap_name: document.getElementById('ap-name').value.trim()
        };
        await api('/api/radius/access-points', { method: 'POST', body: JSON.stringify(payload) });
        showToast('success', 'تم ربط المودم / الأكسس بوينت بنجاح');
        document.getElementById('ap-match').value = '';
        document.getElementById('ap-ip').value = '';
        document.getElementById('ap-name').value = '';
        refreshAll();
      } catch (err) {
        showToast('error', err.message);
      }
    }

    async function deleteAp(id) {
      if (!confirm('هل تريد حذف تعريف هذا المودم؟')) return;
      try {
        await api('/api/radius/access-points/' + id, { method: 'DELETE' });
        showToast('success', 'تم حذف تعريف المودم');
        refreshAll();
      } catch (err) {
        showToast('error', err.message);
      }
    }

    async function refreshAll() {
      try {
        const [sys, kpis, profiles, batches, resData, insp] = await Promise.all([
          api('/api/system/status'),
          api('/api/dashboard/kpis'),
          api('/api/profiles'),
          api('/api/vouchers/batches'),
          api('/api/resellers'),
          api('/api/radius/inspector')
        ]);
        currentProfiles = profiles || [];

        // 0. Live Engine & FreeRADIUS Status Pill + Simulate Button visibility
        const pill = document.getElementById('system-status-pill');
        const simBtn = document.getElementById('simulate-btn');
        if (sys.engine === 'MARIADB_FREERADIUS_LIVE') {
          if (simBtn) simBtn.style.display = 'none';
          const frOk = sys.freeradiusActive === true;
          pill.style.background = frOk ? '#ecfdf5' : '#fef3c7';
          pill.style.borderColor = frOk ? '#a7f3d0' : '#fcd34d';
          pill.style.color = frOk ? '#065f46' : '#92400e';
          pill.innerHTML = \`<span>\${frOk ? '🟢' : '🟡'} FreeRADIUS (\${sys.freeradiusStatus || 'active'}) | MariaDB متصل | \${sys.nasCount || 0} راوتر NAS</span>\`;
        } else {
          if (simBtn) simBtn.style.display = 'inline-flex';
          pill.innerHTML = \`<span>🟠 وضع المعاينة المحلي (In-Memory Demo)</span>\`;
        }

        // 1. Actor selector
        const actorSelect = document.getElementById('actor-select');
        actorSelect.innerHTML = sys.availableActors.map((a) => \`
          <option value="\${a.id}" \${a.id === sys.currentActor.id ? 'selected' : ''}>
            \${a.role === 'SUPER_ADMIN' ? '👑 مدير عام: ' : '🏪 موزع: '}\${a.name}
          </option>
        \`).join('');
        document.getElementById('actor-balance').textContent = sys.currentActor.balance + ' ر.س';
        document.getElementById('nav-cards-badge').textContent = kpis.vouchers.total;

        // 2. 5 Flexible Clickable KPI Cards (Active, Unused, Expired, Live Traffic, Monthly Revenue)
        document.getElementById('kpi-cards').innerHTML = \`
          <div class="kpi-card" onclick="switchTab('sessions')" title="اضغط للانتقال إلى صفحة المتصلون الآن">
            <div>
              <div class="kpi-label">المتصلون الآن (radacct)</div>
              <div class="kpi-val">\${kpis.activeSessions}</div>
              <div class="kpi-sub" style="color:#059669; font-weight:700;">جلسة هوت سبوت نشطة</div>
              <span class="kpi-link-hint">عرض المتصلين الآن ⬅</span>
            </div>
            <div class="kpi-icon" style="background:#ecfdf5; color:#059669;">📡</div>
          </div>

          <div class="kpi-card" onclick="switchTab('cards', 'UNUSED')" title="اضغط لعرض الكروت المتاحة غير المستخدمة">
            <div>
              <div class="kpi-label">الكروت المتاحة (غير مستخدمة)</div>
              <div class="kpi-val" style="color:#4f46e5;">\${kpis.vouchers.unused}</div>
              <div class="kpi-sub">نشط حالياً: \${kpis.vouchers.active} | الإجمالي: \${kpis.vouchers.total}</div>
              <span class="kpi-link-hint">عرض الكروت المتاحة ⬅</span>
            </div>
            <div class="kpi-icon" style="background:#eef2ff; color:#4f46e5;">🎟️</div>
          </div>

          <div class="kpi-card" onclick="switchTab('cards', 'EXPIRED')" title="اضغط لعرض الكروت المنتهية لتصفيرها أو حذفها">
            <div>
              <div class="kpi-label">الكروت المنتهية (Expired)</div>
              <div class="kpi-val" style="color:#dc2626;">\${kpis.vouchers.expired}</div>
              <div class="kpi-sub">معطل: \${kpis.vouchers.disabled} كرت</div>
              <span class="kpi-link-hint" style="color:#dc2626;">فلترة الكروت المنتهية ⬅</span>
            </div>
            <div class="kpi-icon" style="background:#fef2f2; color:#dc2626;">⌛</div>
          </div>

          <div class="kpi-card" onclick="switchTab('sessions')" title="اضغط لمراقبة استهلاك الجلسات الحية">
            <div>
              <div class="kpi-label">إجمالي استهلاك الجلسات الحية</div>
              <div class="kpi-val" dir="ltr" style="font-size:21px;">\${formatBytes(kpis.totalDownloadBytes + kpis.totalUploadBytes)}</div>
              <div class="kpi-sub" dir="ltr">↓ \${formatBytes(kpis.totalDownloadBytes)} | ↑ \${formatBytes(kpis.totalUploadBytes)}</div>
              <span class="kpi-link-hint">تفاصيل الاستهلاك ⬅</span>
            </div>
            <div class="kpi-icon" style="background:#fffbeb; color:#d97706;">⚡</div>
          </div>

          <div class="kpi-card" onclick="switchTab('resellers')" title="اضغط لعرض السجل المالي وإيرادات الشهر">
            <div>
              <div class="kpi-label">إيرادات الدفعات الشهرية</div>
              <div class="kpi-val" style="color:#059669;">\${kpis.revenue.monthly.toFixed(0)} <span style="font-size:13px;">ر.س</span></div>
              <div class="kpi-sub">مبيعات اليوم: \${kpis.revenue.daily.toFixed(0)} ر.س (\${kpis.revenue.batchesCount} دفعة)</div>
              <span class="kpi-link-hint" style="color:#059669;">السجل المالي الشهري ⬅</span>
            </div>
            <div class="kpi-icon" style="background:#ecfdf5; color:#059669;">💰</div>
          </div>
        \`;

        // 3. Chart 1: Live Traffic with Numbers above every bar
        const maxTrafficMbps = Math.max(10, ...(kpis.trafficHistory || []).map((pt) => Math.max(Number(pt.downloadMbps) || 0, Number(pt.uploadMbps) || 0)));
        const peakTrafficMbps = Math.max(0, ...(kpis.trafficHistory || []).map((pt) => Number(pt.downloadMbps) || 0));
        const trafficPeakEl = document.getElementById('traffic-peak-label');
        if (trafficPeakEl) trafficPeakEl.textContent = 'الذروة المسجلة: ' + peakTrafficMbps + ' Mbps';

        document.getElementById('traffic-chart').innerHTML = (kpis.trafficHistory || []).map((pt) => \`
          <div class="bar-col">
            <div class="bar-pair">
              <div class="bar-wrap">
                <span class="bar-num" style="color:#4338ca;">\${pt.downloadMbps}M</span>
                <div class="bar-dl" style="height:\${Math.max(4, Math.min(100, (pt.downloadMbps / maxTrafficMbps) * 100))}%"></div>
              </div>
              <div class="bar-wrap">
                <span class="bar-num" style="color:#d97706;">\${pt.uploadMbps}M</span>
                <div class="bar-ul" style="height:\${Math.max(4, Math.min(100, (pt.uploadMbps / maxTrafficMbps) * 100))}%"></div>
              </div>
            </div>
            <span class="mono" style="font-size:11px; font-weight:700; color:#475569;">\${pt.time}</span>
          </div>
        \`).join('');

        // 4. Chart 2: Peak Hours (Users Count + Total GB Consumed) with Numbers above every bar
        const peakHistory = kpis.peakHoursHistory || [];
        const maxPeakUsers = Math.max(5, ...peakHistory.map((pt) => Number(pt.users) || 0));
        const maxPeakGb = Math.max(1, ...peakHistory.map((pt) => Number(pt.totalGb) || 0));
        const bestPeak = peakHistory.reduce((best, cur) => ((cur.users || 0) > (best.users || 0) ? cur : best), { users: 0, time: '--:--' });
        const peakHourEl = document.getElementById('peak-hour-label');
        if (peakHourEl) {
          peakHourEl.textContent = bestPeak.users > 0
            ? ('ساعة الذروة: ' + bestPeak.time + ' (' + bestPeak.users + ' مشترك)')
            : 'ساعة الذروة: لا توجد جلسات مسجلة خلال 24 ساعة';
        }

        document.getElementById('peak-chart').innerHTML = peakHistory.map((pt) => \`
          <div class="bar-col">
            <div class="bar-pair">
              <div class="bar-wrap">
                <span class="bar-num" style="color:#059669;">\${pt.users}👤</span>
                <div class="bar-peak" style="height:\${Math.max(4, Math.min(100, (pt.users / maxPeakUsers) * 100))}%"></div>
              </div>
              <div class="bar-wrap">
                <span class="bar-num" style="color:#4f46e5;">\${pt.totalGb}G</span>
                <div class="bar-gb" style="height:\${Math.max(4, Math.min(100, (pt.totalGb / maxPeakGb) * 100))}%"></div>
              </div>
            </div>
            <span class="mono" style="font-size:11px; font-weight:700; color:#475569;">\${pt.time}</span>
          </div>
        \`).join('');

        // 5. Recent Batches
        document.getElementById('recent-batches-list').innerHTML = kpis.recentBatches.length === 0
          ? '<div style="padding:18px; text-align:center; color:#64748b; font-size:12px;">لا توجد دفعات مولّدة بعد — اضغط "توليد دفعة جديدة"</div>'
          : kpis.recentBatches.map((b) => \`
          <div style="padding:12px 14px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
            <div>
              <div class="mono" style="font-weight:800; color:#4338ca; font-size:12px;">\${b.batch_code}</div>
              <div style="font-weight:700; font-size:13px; margin-top:2px;">\${b.profile_display_name || '-'} (\${b.quantity} كرت)</div>
              <div style="font-size:11px; color:#64748b;">\${b.reseller_name || ''}</div>
            </div>
            <button class="btn btn-light btn-xs" onclick="loadBatchForPrint(\${b.id})">🖨️ طباعة</button>
          </div>
        \`).join('');

        // 6. Populate Profile Selectors
        const genProfileSelect = document.getElementById('gen-profile');
        const currentSelectedProf = genProfileSelect.value;
        genProfileSelect.innerHTML = profiles.length === 0
          ? '<option value="">-- أنشئ باقة (Profile) أولاً من تبويب الباقات --</option>'
          : profiles.map((p) => \`
          <option value="\${p.id}" \${String(p.id) === String(currentSelectedProf) ? 'selected' : ''}>
            \${p.display_name} (\${p.speed_limit ? p.speed_limit : 'Queues'}) - التكلفة: \${p.cost_price} | البيع: \${p.price}
          </option>
        \`).join('');

        const filterProfSelect = document.getElementById('cards-profile-filter');
        const currFilterProf = filterProfSelect.value;
        filterProfSelect.innerHTML = '<option value="ALL">جميع الباقات</option>' + profiles.map((p) => \`
          <option value="\${p.id}" \${String(p.id) === String(currFilterProf) ? 'selected' : ''}>
            \${p.display_name} (\${p.name})
          </option>
        \`).join('');

        // 7. Batches Table
        document.getElementById('batches-tbody').innerHTML = batches.length === 0
          ? '<tr><td colspan="7" style="text-align:center; padding:24px; color:#64748b;">لا توجد دفعات مولّدة في قاعدة البيانات بعد</td></tr>'
          : batches.map((b) => \`
          <tr>
            <td class="mono" style="font-weight:800; color:#4338ca;">\${b.batch_code}</td>
            <td style="font-weight:700;">\${b.profile_display_name || '-'}</td>
            <td>\${b.quantity} كرت</td>
            <td>\${b.reseller_name || '-'}</td>
            <td style="font-weight:800; color:#059669;">\${b.total_cost} ر.س</td>
            <td style="font-size:12px; color:#64748b;">\${new Date(b.created_at).toLocaleString('ar-SA')}</td>
            <td>
              <button class="btn btn-primary btn-xs" onclick="loadBatchForPrint(\${b.id})">
                🖨️ معاينة وطباعة A4
              </button>
            </td>
          </tr>
        \`).join('');

        if (!currentPrintableBatch && batches.length > 0) {
          currentPrintableBatch = await api('/api/vouchers/batches/' + batches[0].id + '/print');
          renderPrintPreview();
        }

        // 8. Profiles Tab
        document.getElementById('profiles-list').innerHTML = profiles.length === 0
          ? '<div class="card" style="text-align:center; padding:30px; color:#64748b;">لا توجد باقات حالياً في قاعدة البيانات. قم بإضافة أول باقة من النموذج الجانبي للبدء ببيع الكروت.</div>'
          : profiles.map((p) => \`
          <div class="card">
            <div class="profile-head-row">
              <div>
                <span style="font-size:17px; font-weight:800;">\${p.display_name}</span>
                <span class="tag tag-indigo mono" style="margin-right:8px;">\${p.name}</span>
                \${Number(p.cards_count) > 0 ? \`<span class="tag tag-emerald" style="margin-right:6px;">🎟️ \${p.cards_count} كرت</span>\` : ''}
                <div style="font-size:12px; color:#64748b; margin-top:4px;">
                  سعر البيع: <b>\${p.price}</b> | تكلفة الموزع: <b>\${p.cost_price}</b> | السرعة: <b class="\${p.speed_limit ? 'mono' : ''}">\${formatSpeedLabel(p.speed_limit)}</b>
                </div>
              </div>
              <div style="display:flex; gap:6px; flex-shrink:0;">
                <button class="btn btn-amber btn-xs" onclick="startEditProfile(\${p.id})">✏️ تعديل</button>
                <button class="btn btn-danger btn-xs" onclick="deleteProfile(\${p.id})">🗑️ حذف</button>
              </div>
            </div>
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(min(100%, 140px), 1fr)); gap:8px; margin-bottom:12px;">
              <div style="background:#eef2ff; border:1px solid #c7d2fe; border-radius:10px; padding:8px 11px;">
                <div style="font-size:11px; color:#4338ca; font-weight:700;">📦 الكوتا الإجمالية</div>
                <div class="mono" dir="ltr" style="font-size:13px; font-weight:800; color:#1e1b4b; margin-top:2px;">\${formatQuotaMb(p.data_limit_mb)}</div>
              </div>
              <div style="background:#ecfdf5; border:1px solid #a7f3d0; border-radius:10px; padding:8px 11px;">
                <div style="font-size:11px; color:#065f46; font-weight:700;">⏱️ وقت الاستخدام الفعلي</div>
                <div style="font-size:13px; font-weight:800; color:#064e3b; margin-top:2px;">\${formatHoursFromSeconds(p.time_limit)}</div>
              </div>
              <div style="background:#fffbeb; border:1px solid #fde68a; border-radius:10px; padding:8px 11px;">
                <div style="font-size:11px; color:#92400e; font-weight:700;">📅 الصلاحية التقويمية</div>
                <div style="font-size:13px; font-weight:800; color:#78350f; margin-top:2px;">\${formatValidityDays(p.validity_days)}</div>
              </div>
            </div>
            <div style="background:#f8fafc; padding:12px; border-radius:10px; border:1px solid #e2e8f0;">
              <div style="font-size:11px; font-weight:700; color:#64748b; margin-bottom:8px;">
                الخصائص المتزامنة في جدولَي radgroupreply و radgroupcheck:
              </div>
              <div class="profile-attrs" dir="ltr">
                \${(p.radgroupreply || []).map((r) => \`<span class="tag tag-indigo mono"><b>\${r.attribute}</b> \${r.op} \${r.value}</span>\`).join('')}
                \${(p.radgroupcheck || []).map((c) => \`<span class="tag tag-amber mono"><b>\${c.attribute}</b> \${c.op} \${c.value}</span>\`).join('')}
              </div>
            </div>
          </div>
        \`).join('');

        // 9. Load Sessions & Cards Directory
        await loadSessions();
        await loadCardsDirectory();

        // 10. Resellers & Transactions
        document.getElementById('resellers-list').innerHTML = resData.resellers.map((r) => \`
          <div style="padding:14px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
            <div>
              <div style="font-weight:800; font-size:15px;">
                \${r.name}
                <span class="tag tag-indigo mono">@\${r.username}</span>
                <span class="tag tag-emerald">\${r.role}</span>
              </div>
              <div style="font-size:12px; color:#475569; margin-top:4px;">
                الرصيد الحالي: <b style="color:#059669; font-size:14px;">\${r.balance} ر.س</b> | الحد الائتماني: <b>\${r.credit_limit} ر.س</b> | جوال: \${r.phone || '-'}
              </div>
            </div>
            \${sys.currentActor.role === 'SUPER_ADMIN' ? \`
              <div class="reseller-topup-box">
                <input type="number" id="topup-\${r.id}" value="200" style="width:90px; padding:6px 8px; border:1px solid #cbd5e1; border-radius:8px;" />
                <button class="btn btn-emerald btn-xs" onclick="topupReseller(\${r.id})">💳 شحن رصيد</button>
              </div>
            \` : ''}
          </div>
        \`).join('');

        document.getElementById('transactions-list').innerHTML = (resData.transactions || []).length === 0
          ? '<div style="padding:18px; text-align:center; color:#64748b; font-size:12px;">لا توجد حركات مالية مسجلة حتى الآن</div>'
          : resData.transactions.map((t) => \`
          <div class="tx-row">
            <div>
              <span class="tag \${t.type === 'DEPOSIT' ? 'tag-emerald' : 'tag-amber'}">\${t.type === 'DEPOSIT' ? 'إيداع' : 'خصم دفعة'}</span>
              <b style="margin-right:6px;">\${t.description}</b>
            </div>
            <div class="mono">المبلغ: <b>\${t.amount} ر.س</b> (الرصيد بعد: \${t.balance_after} ر.س)</div>
          </div>
        \`).join('');

        // 11. Inspector Tab & Live MikroTik RouterOS Link Script Generator
        const vpsHost = window.location.hostname || 'YOUR_VPS_IP';
        const defaultSecret = (insp.nas && insp.nas[0] && insp.nas[0].secret) ? insp.nas[0].secret : 'RadSecret2026!';
        const vpsHostEl = document.getElementById('vps-host-display');
        if (vpsHostEl) vpsHostEl.textContent = vpsHost;
        const scriptBox = document.getElementById('mikrotik-script-box');
        if (scriptBox) {
          scriptBox.textContent = [
            '# 1. ربط راوتر MikroTik بخدمة RADIUS على السيرفر:',
            '/radius add service=hotspot address=' + vpsHost + ' secret="' + defaultSecret + '" authentication-port=1812 accounting-port=1813 timeout=3s src-address=0.0.0.0',
            '',
            '# 2. تفعيل الفصل الفوري (CoA / PoD) من السيرفر عبر منفذ 3799:',
            '/radius incoming set accept=yes port=3799',
            '',
            '# 3. تفعيل استخدام RADIUS والمحاسبة اللحظية في بروفايل الهوت سبوت:',
            '/ip hotspot profile set [find] use-radius=yes radius-accounting=yes radius-interim-update=00:02:00 nas-port-type=wireless-802.11',
            '',
            '# 4. السماح بتحميل رمز QR أو روابط الدخول المباشر (اختياري):',
            '/ip hotspot walled-garden ip add dst-address=' + vpsHost + ' action=accept'
          ].join('\\n');
        }

        document.getElementById('nas-tbody').innerHTML = (insp.nas || []).length === 0
          ? '<tr><td colspan="5" style="text-align:center; padding:16px; color:#64748b;">لا توجد راوترات مضافة في جدول nas بعد</td></tr>'
          : insp.nas.map((n) => \`
          <tr>
            <td class="mono" dir="ltr" style="font-weight:800; color:#4338ca;">\${n.nasname}</td>
            <td class="mono" dir="ltr">\${n.shortname}</td>
            <td class="mono" dir="ltr" style="color:#059669;">\${n.secret}</td>
            <td>\${n.description || '-'}</td>
            <td><button class="btn btn-danger btn-xs" onclick="deleteNas(\${n.id})">🗑️</button></td>
          </tr>
        \`).join('');

        const apTbody = document.getElementById('ap-tbody');
        if (apTbody) {
          const aps = insp.accessPoints || [];
          apTbody.innerHTML = aps.length === 0
            ? '<tr><td colspan="4" style="text-align:center; padding:16px; color:#64748b;">لم يتم تعريف مودمات بعد (يعرض IP الراوتر افتراضياً)</td></tr>'
            : aps.map((ap) => \`
            <tr>
              <td class="mono" dir="ltr" style="font-weight:700;">\${ap.match_value}</td>
              <td class="mono" dir="ltr" style="color:#4338ca; font-weight:800;">\${ap.ap_ip}</td>
              <td>\${ap.ap_name}</td>
              <td><button class="btn btn-danger btn-xs" onclick="deleteAp(\${ap.id})">🗑️</button></td>
            </tr>
          \`).join('');
        }

        document.getElementById('radcheck-tbody').innerHTML = (insp.radcheckSample || []).length === 0
          ? '<tr><td colspan="4" style="text-align:center; padding:16px; color:#64748b;">جدول radcheck فارغ حالياً — قم بتوليد دفعة كروت</td></tr>'
          : insp.radcheckSample.map((r) => \`
          <tr>
            <td class="mono" style="font-weight:800; color:#4338ca;">\${r.username}</td>
            <td class="mono">\${r.attribute}</td>
            <td class="mono">\${r.op}</td>
            <td class="mono" style="color:#059669;">\${r.value}</td>
          </tr>
        \`).join('');

        document.getElementById('radusergroup-tbody').innerHTML = (insp.radusergroupSample || []).length === 0
          ? '<tr><td colspan="3" style="text-align:center; padding:16px; color:#64748b;">جدول radusergroup فارغ حالياً</td></tr>'
          : insp.radusergroupSample.map((u) => \`
          <tr>
            <td class="mono" style="font-weight:800; color:#4338ca;">\${u.username}</td>
            <td class="mono" style="color:#b45309;">\${u.groupname}</td>
            <td class="mono">\${u.priority}</td>
          </tr>
        \`).join('');

      } catch (e) {
        showToast('error', e.message);
      }
    }

    loadBrandSettings();
    refreshAll();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    return sendJson(res, 200, {});
  }

  const parsedUrl = new URL(req.url || '/', 'http://localhost:4000');
  const pathname = parsedUrl.pathname;

  const actorIdHeader = Number(req.headers['x-actor-id']) || 1;

  try {
    const actor = dbStore
      ? await dbStore.getActor(actorIdHeader)
      : (store.resellers.find((r) => r.id === actorIdHeader) || store.resellers[0]);

    if (pathname === '/api/system/status' && req.method === 'GET') {
      if (dbStore) {
        const sys = await dbStore.getSystemStatus(actorIdHeader);
        return sendJson(res, 200, sys);
      }
      return sendJson(res, 200, {
        engine: 'FREERADIUS_3_LIVE_ENGINE',
        currentActor: actor,
        availableActors: store.resellers,
      });
    }

    if (pathname === '/api/dashboard/kpis' && req.method === 'GET') {
      if (dbStore) {
        const kpis = await dbStore.getDashboardKpis(actor);
        return sendJson(res, 200, kpis);
      }
      const isSuper = actor.role === 'SUPER_ADMIN';
      const ownedCards = isSuper
        ? store.voucher_cards
        : store.voucher_cards.filter((c) => c.reseller_id === actor.id);
      const ownedUsernames = new Set(ownedCards.map((c) => c.username));
      const activeSessions = isSuper
        ? store.radacct
        : store.radacct.filter((s) => ownedUsernames.has(s.username));
      const batches = isSuper
        ? store.voucher_batches
        : store.voucher_batches.filter((b) => b.reseller_id === actor.id);

      const totalUploadBytes = activeSessions.reduce((acc, s) => acc + s.acctinputoctets, 0);
      const totalDownloadBytes = activeSessions.reduce((acc, s) => acc + s.acctoutputoctets, 0);
      const dailyRevenue = batches.reduce((acc, b) => acc + b.total_cost, 0);
      const monthlyRevenue = dailyRevenue * 3.5;

      return sendJson(res, 200, {
        activeSessions: activeSessions.length,
        totalUploadBytes,
        totalDownloadBytes,
        vouchers: {
          total: ownedCards.length,
          unused: ownedCards.filter((c) => c.status === 'UNUSED').length,
          active: ownedCards.filter((c) => c.status === 'ACTIVE').length,
          expired: ownedCards.filter((c) => c.status === 'EXPIRED').length,
          disabled: ownedCards.filter((c) => c.status === 'DISABLED').length,
        },
        revenue: {
          daily: dailyRevenue,
          monthly: monthlyRevenue,
          batchesCount: batches.length,
        },
        trafficHistory: [
          { time: '10:00', downloadMbps: 38, uploadMbps: 9 },
          { time: '12:00', downloadMbps: 54, uploadMbps: 14 },
          { time: '14:00', downloadMbps: 72, uploadMbps: 19 },
          { time: '16:00', downloadMbps: 86, uploadMbps: 24 },
          { time: '18:00', downloadMbps: 105, uploadMbps: 29 },
          { time: '20:00', downloadMbps: 124, uploadMbps: 34 },
          { time: '21:00', downloadMbps: 128, uploadMbps: 36 },
          { time: '23:00', downloadMbps: 92, uploadMbps: 22 },
        ],
        peakHoursHistory: [
          { time: '10:00', users: 18, totalGb: 11 },
          { time: '12:00', users: 29, totalGb: 19 },
          { time: '14:00', users: 42, totalGb: 27 },
          { time: '16:00', users: 51, totalGb: 34 },
          { time: '18:00', users: 68, totalGb: 45 },
          { time: '20:00', users: 84, totalGb: 56 },
          { time: '21:00', users: 92, totalGb: 62 },
          { time: '23:00', users: 61, totalGb: 39 },
        ],
        recentBatches: batches.slice(0, 6),
      });
    }

    // Cards Directory List with Status, Profile & Search filters
    if (pathname === '/api/vouchers/cards' && req.method === 'GET') {
      const status = parsedUrl.searchParams.get('status') || 'ALL';
      const profileId = parsedUrl.searchParams.get('profileId') || 'ALL';
      const search = (parsedUrl.searchParams.get('search') || '').trim().toLowerCase();

      if (dbStore) {
        const data = await dbStore.getCardsDirectory(actor, { status, profileId, search });
        return sendJson(res, 200, data);
      }

      let list =
        actor.role === 'SUPER_ADMIN'
          ? store.voucher_cards
          : store.voucher_cards.filter((c) => c.reseller_id === actor.id);

      if (status !== 'ALL') {
        list = list.filter((c) => c.status === status);
      }
      if (profileId !== 'ALL') {
        list = list.filter((c) => String(c.profile_id) === String(profileId));
      }
      if (search) {
        list = list.filter(
          (c) =>
            c.username.toLowerCase().includes(search) ||
            (c.serial_number && c.serial_number.toLowerCase().includes(search)) ||
            (c.last_ip && c.last_ip.toLowerCase().includes(search)) ||
            (c.last_mac && c.last_mac.toLowerCase().includes(search)) ||
            (c.modem_ip && c.modem_ip.toLowerCase().includes(search))
        );
      }

      const activeSet = new Set(store.radacct.map((s) => s.username));
      const enriched = list.map((c) => ({
        ...c,
        is_online: activeSet.has(c.username),
      }));

      return sendJson(res, 200, { count: enriched.length, cards: enriched });
    }

    // Single Card Action (disconnect, disable, enable, reset, delete)
    const cardActionMatch = pathname.match(/^\/api\/vouchers\/cards\/([^/]+)\/action$/);
    if (cardActionMatch && req.method === 'POST') {
      const username = decodeURIComponent(cardActionMatch[1]);
      const body = await parseBody(req);
      if (dbStore) {
        const result = await dbStore.executeCardAction(username, body.action, body.resetMode);
        return sendJson(res, 200, result);
      }
      const result = store.executeCardAction(username, body.action, body.resetMode);
      return sendJson(res, 200, result);
    }

    // Single Card Full Details (GET & PUT)
    const cardDetailMatch = pathname.match(/^\/api\/vouchers\/cards\/([^/]+)$/);
    if (cardDetailMatch && req.method === 'GET') {
      const username = decodeURIComponent(cardDetailMatch[1]);
      if (dbStore) {
        const details = await dbStore.getCardDetails(username);
        return sendJson(res, 200, details);
      }
      return sendJson(res, 200, store.getCardDetails(username));
    }
    if (cardDetailMatch && req.method === 'PUT') {
      const username = decodeURIComponent(cardDetailMatch[1]);
      const body = await parseBody(req);
      if (dbStore) {
        const updated = await dbStore.updateCardDetails(username, body);
        return sendJson(res, 200, updated);
      }
      return sendJson(res, 200, store.updateCardDetails(username, body));
    }

    if (pathname === '/api/vouchers/batches' && req.method === 'GET') {
      if (dbStore) {
        const batches = await dbStore.getBatches(actor);
        return sendJson(res, 200, batches);
      }
      const batches =
        actor.role === 'SUPER_ADMIN'
          ? store.voucher_batches
          : store.voucher_batches.filter((b) => b.reseller_id === actor.id);
      return sendJson(res, 200, batches);
    }

    if (pathname === '/api/vouchers/batches' && req.method === 'POST') {
      const body = await parseBody(req);
      if (dbStore) {
        const result = await dbStore.generateBatch(body, actor);
        return sendJson(res, 201, result);
      }
      const result = store.generateBatch(body, actor);
      return sendJson(res, 201, result);
    }

    const printMatch = pathname.match(/^\/api\/vouchers\/batches\/(\d+)\/print$/);
    if (printMatch && req.method === 'GET') {
      const batchId = Number(printMatch[1]);
      if (dbStore) {
        const printable = await dbStore.getBatchForPrint(batchId, actor);
        return sendJson(res, 200, printable);
      }
      const batch = store.voucher_batches.find((b) => b.id === batchId);
      if (!batch) return sendJson(res, 404, { message: 'الدفعة غير موجودة' });
      if (actor.role !== 'SUPER_ADMIN' && batch.reseller_id !== actor.id) {
        return sendJson(res, 403, { message: 'غير مصرح لك بعرض أو طباعة هذه الدفعة' });
      }
      const cards = store.voucher_cards
        .filter((c) => c.batch_id === batchId)
        .map((c) => ({
          username: c.username,
          cleartextPassword: c.cleartext_password,
          serialNumber: c.serial_number,
          status: c.status,
        }));
      return sendJson(res, 200, { batch, cards });
    }

    if (pathname === '/api/profiles' && req.method === 'GET') {
      if (dbStore) {
        const profiles = await dbStore.getProfiles();
        return sendJson(res, 200, profiles);
      }
      const enriched = store.profiles_meta.map((p) => ({
        ...p,
        cards_count: store.voucher_cards.filter((c) => c.profile_id === p.id).length,
        radgroupreply: store.radgroupreply.filter((r) => r.groupname === p.name),
        radgroupcheck: store.radgroupcheck.filter((c) => c.groupname === p.name),
      }));
      return sendJson(res, 200, enriched);
    }

    if (pathname === '/api/profiles' && req.method === 'POST') {
      if (actor.role !== 'SUPER_ADMIN') {
        return sendJson(res, 403, { message: 'إدارة الباقات متاحة للمدير العام فقط' });
      }
      const body = await parseBody(req);
      if (dbStore) {
        const created = await dbStore.createProfile(body);
        return sendJson(res, 201, created);
      }
      const created = store.createProfile(body);
      return sendJson(res, 201, created);
    }

    const profByIdMatch = pathname.match(/^\/api\/profiles\/(\d+)$/);
    if (profByIdMatch && req.method === 'PUT') {
      if (actor.role !== 'SUPER_ADMIN') {
        return sendJson(res, 403, { message: 'تعديل الباقات متاح للمدير العام فقط' });
      }
      const body = await parseBody(req);
      if (dbStore) {
        const updated = await dbStore.updateProfile(Number(profByIdMatch[1]), body);
        return sendJson(res, 200, updated);
      }
      const updated = store.updateProfile(Number(profByIdMatch[1]), body);
      return sendJson(res, 200, updated);
    }

    if (profByIdMatch && req.method === 'DELETE') {
      if (actor.role !== 'SUPER_ADMIN') {
        return sendJson(res, 403, { message: 'حذف الباقات متاح للمدير العام فقط' });
      }
      if (dbStore) {
        const result = await dbStore.deleteProfile(Number(profByIdMatch[1]));
        return sendJson(res, 200, result);
      }
      store.deleteProfile(Number(profByIdMatch[1]));
      return sendJson(res, 200, { success: true });
    }

    if (pathname === '/api/sessions/active' && req.method === 'GET') {
      const search = String(parsedUrl.searchParams.get('search') || '').trim().toLowerCase();
      if (dbStore) {
        const data = await dbStore.getActiveSessions(actor, search);
        return sendJson(res, 200, data);
      }
      let sessions = store.radacct;
      if (actor.role !== 'SUPER_ADMIN') {
        const ownedUsernames = new Set(
          store.voucher_cards
            .filter((c) => c.reseller_id === actor.id)
            .map((c) => c.username)
        );
        sessions = sessions.filter((s) => ownedUsernames.has(s.username));
      }
      if (search) {
        sessions = sessions.filter(
          (s) =>
            s.username.toLowerCase().includes(search) ||
            s.framedipaddress.toLowerCase().includes(search) ||
            s.callingstationid.toLowerCase().includes(search) ||
            (s.modem_ip && s.modem_ip.toLowerCase().includes(search)) ||
            (s.modem_name && s.modem_name.toLowerCase().includes(search))
        );
      }
      const enriched = sessions.map((s) => {
        const c = store.voucher_cards.find((vc) => vc.username === s.username);
        return {
          ...s,
          card_status: c ? c.status : 'ACTIVE',
        };
      });
      return sendJson(res, 200, { count: enriched.length, sessions: enriched });
    }

    if (pathname === '/api/sessions/simulate' && req.method === 'POST') {
      if (dbStore) {
        return sendJson(res, 400, { message: 'النظام متصل بقاعدة البيانات الحية، لا يمكن إدراج جلسات وهمية' });
      }
      const unusedCard = store.voucher_cards.find((c) => c.status === 'UNUSED');
      const modem = MODEM_AP_LIST[randomInt(0, MODEM_AP_LIST.length)];
      const username = unusedCard ? unusedCard.username : `77${Math.floor(100000 + Math.random() * 900000)}`;
      const mac = `A4:83:E7:${Math.floor(10 + Math.random() * 89)}:${Math.floor(10 + Math.random() * 89)}:C1`;
      const ip = `10.1.234.${Math.floor(50 + Math.random() * 190)}`;

      if (unusedCard) {
        unusedCard.status = 'ACTIVE';
        unusedCard.first_used_at = new Date().toISOString();
        unusedCard.expires_at = new Date(Date.now() + (unusedCard.validity_days || 3) * 86400000).toISOString();
        unusedCard.bound_mac = mac;
        unusedCard.last_ip = ip;
        unusedCard.last_mac = mac;
        unusedCard.modem_ip = modem.ip;
        unusedCard.modem_name = modem.name;
      }

      const newSession = {
        radacctid: Date.now(),
        acctsessionid: `80b${Math.floor(10000 + Math.random() * 90000)}`,
        acctuniqueid: `u_${Date.now()}`,
        username,
        nasipaddress: Math.random() > 0.5 ? '10.10.0.1' : '10.10.0.2',
        modem_ip: modem.ip,
        modem_name: modem.name,
        nasportid: modem.name,
        acctstarttime: new Date().toISOString(),
        acctstoptime: null,
        acctupdatetime: new Date().toISOString(),
        acctsessiontime: 45,
        acctinputoctets: 4 * 1024 * 1024,
        acctoutputoctets: 28 * 1024 * 1024,
        calledstationid: modem.name,
        callingstationid: mac,
        framedipaddress: ip,
      };
      store.radacct.unshift(newSession);
      store.radacct_history.push(newSession);
      return sendJson(res, 201, newSession);
    }

    if (pathname === '/api/resellers' && req.method === 'GET') {
      if (dbStore) {
        const data = await dbStore.getResellers(actor);
        return sendJson(res, 200, data);
      }
      if (actor.role !== 'SUPER_ADMIN') {
        return sendJson(res, 200, {
          resellers: store.resellers.filter((r) => r.id === actor.id),
          transactions: store.reseller_transactions.filter((t) => t.reseller_id === actor.id),
        });
      }
      return sendJson(res, 200, {
        resellers: store.resellers,
        transactions: store.reseller_transactions.slice(0, 30),
      });
    }

    if (pathname === '/api/resellers' && req.method === 'POST') {
      if (actor.role !== 'SUPER_ADMIN') {
        return sendJson(res, 403, { message: 'إضافة الموزعين متاحة للمدير العام فقط' });
      }
      const body = await parseBody(req);
      if (dbStore) {
        const created = await dbStore.createReseller(body);
        return sendJson(res, 201, created);
      }
      const newReseller = {
        id: store.resellers.length + 1,
        name: body.name,
        username: body.username,
        role: 'RESELLER',
        phone: body.phone || '',
        balance: Number(body.balance || 0),
        credit_limit: Number(body.credit_limit || 0),
        is_active: 1,
        created_at: new Date().toISOString(),
      };
      store.resellers.push(newReseller);
      return sendJson(res, 201, newReseller);
    }

    const topupMatch = pathname.match(/^\/api\/resellers\/(\d+)\/topup$/);
    if (topupMatch && req.method === 'POST') {
      if (actor.role !== 'SUPER_ADMIN') {
        return sendJson(res, 403, { message: 'شحن الرصيد متاح للمدير العام فقط' });
      }
      const body = await parseBody(req);
      if (dbStore) {
        const updated = await dbStore.topupReseller(Number(topupMatch[1]), body);
        return sendJson(res, 200, updated);
      }
      const reseller = store.resellers.find((r) => r.id === Number(topupMatch[1]));
      if (!reseller) return sendJson(res, 404, { message: 'الموزع غير موجود' });
      const amount = Number(body.amount || 0);
      const before = reseller.balance;
      reseller.balance = Number((before + amount).toFixed(2));
      store.reseller_transactions.unshift({
        id: Date.now(),
        reseller_id: reseller.id,
        reseller_name: reseller.name,
        batch_id: null,
        type: 'DEPOSIT',
        amount,
        balance_before: before,
        balance_after: reseller.balance,
        description: body.description || 'إيداع رصيد مباشر من الإدارة',
        created_at: new Date().toISOString(),
      });
      return sendJson(res, 200, reseller);
    }

    // NAS Routers CRUD
    if (pathname === '/api/radius/nas' && req.method === 'POST') {
      if (actor.role !== 'SUPER_ADMIN') {
        return sendJson(res, 403, { message: 'إدارة الراوترات متاحة للمدير العام فقط' });
      }
      const body = await parseBody(req);
      if (dbStore) {
        const created = await dbStore.addNas(body);
        return sendJson(res, 201, created);
      }
      const item = {
        id: Date.now(),
        nasname: body.nasname,
        shortname: body.shortname || body.nasname,
        secret: body.secret,
        description: body.description || 'MikroTik Hotspot Router',
      };
      store.nas.push(item);
      return sendJson(res, 201, item);
    }

    const delNasMatch = pathname.match(/^\/api\/radius\/nas\/(\d+)$/);
    if (delNasMatch && req.method === 'DELETE') {
      if (actor.role !== 'SUPER_ADMIN') {
        return sendJson(res, 403, { message: 'حذف الراوترات متاح للمدير العام فقط' });
      }
      const id = Number(delNasMatch[1]);
      if (dbStore) {
        return sendJson(res, 200, await dbStore.deleteNas(id));
      }
      store.nas = store.nas.filter((n) => n.id !== id);
      return sendJson(res, 200, { success: true });
    }

    // Access Points / Modems CRUD
    if (pathname === '/api/radius/access-points' && req.method === 'POST') {
      if (actor.role !== 'SUPER_ADMIN') {
        return sendJson(res, 403, { message: 'إدارة المودمات متاحة للمدير العام فقط' });
      }
      const body = await parseBody(req);
      if (dbStore) {
        const created = await dbStore.addAccessPoint(body);
        return sendJson(res, 201, created);
      }
      if (!store.accessPoints) store.accessPoints = [];
      const item = {
        id: Date.now(),
        match_value: body.match_value,
        ap_ip: body.ap_ip,
        ap_name: body.ap_name || body.match_value,
      };
      store.accessPoints.push(item);
      return sendJson(res, 201, item);
    }

    const delApMatch = pathname.match(/^\/api\/radius\/access-points\/(\d+)$/);
    if (delApMatch && req.method === 'DELETE') {
      if (actor.role !== 'SUPER_ADMIN') {
        return sendJson(res, 403, { message: 'حذف المودمات متاح للمدير العام فقط' });
      }
      const id = Number(delApMatch[1]);
      if (dbStore) {
        return sendJson(res, 200, await dbStore.deleteAccessPoint(id));
      }
      store.accessPoints = (store.accessPoints || []).filter((a) => a.id !== id);
      return sendJson(res, 200, { success: true });
    }

    if (pathname === '/api/radius/inspector' && req.method === 'GET') {
      if (dbStore) {
        const data = await dbStore.getRadiusInspector();
        return sendJson(res, 200, data);
      }
      return sendJson(res, 200, {
        nas: store.nas,
        accessPoints: store.accessPoints || [],
        radcheckSample: store.radcheck.slice(-25).reverse(),
        radusergroupSample: store.radusergroup.slice(-25).reverse(),
        radgroupreply: store.radgroupreply,
        radgroupcheck: store.radgroupcheck,
      });
    }

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(DASHBOARD_HTML);
  } catch (err) {
    return sendJson(res, 400, { message: err.message || 'خطأ في الخادم' });
  }
});

const PORT = 4000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 RadiusPro Full-Stack Server v2 is LIVE at: http://localhost:${PORT}`);
});
