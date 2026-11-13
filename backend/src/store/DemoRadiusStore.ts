import { randomInt } from 'crypto';
import {
  ActiveSessionRow,
  AuthUser,
  CharsetType,
  GenerateBatchDTO,
  ProfileDTO,
} from '../types/radius.types';

const CHARSETS: Record<CharsetType, string> = {
  NUMERIC: '0123456789',
  ALPHANUMERIC_UPPER: '23456789ABCDEFGHJKLMNPQRSTUVWXYZ',
  ALPHANUMERIC_MIXED: '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ',
};

function randomCode(len: number, alphabet: string): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += alphabet[randomInt(0, alphabet.length)];
  }
  return out;
}

/**
 * Stateful FreeRADIUS 3.x + Custom Schema Engine.
 * Mirrors the exact MariaDB `radius` tables (`radcheck`, `radusergroup`, `radgroupreply`,
 * `radgroupcheck`, `radacct`, `nas`, `profiles_meta`, `resellers`, `voucher_batches`,
 * `voucher_cards`, `reseller_transactions`) so the full system can be tested immediately
 * even when MariaDB is not running on the local machine.
 */
class DemoRadiusStore {
  public radcheck: Array<{ id: number; username: string; attribute: string; op: string; value: string }> = [];
  public radusergroup: Array<{ id: number; username: string; groupname: string; priority: number }> = [];
  public radgroupreply: Array<{ id: number; groupname: string; attribute: string; op: string; value: string }> = [];
  public radgroupcheck: Array<{ id: number; groupname: string; attribute: string; op: string; value: string }> = [];
  public radacct: ActiveSessionRow[] = [];
  public nas: Array<{ id: number; nasname: string; shortname: string; type: string; secret: string; description: string }> = [];

  public profiles_meta: Array<{
    id: number;
    name: string;
    display_name: string;
    price: number;
    cost_price: number;
    speed_limit: string;
    time_limit: number | null;
    data_limit_mb: number | null;
    validity_days: number | null;
    simultaneous_use: number;
    port_limit: number;
    is_active: number;
  }> = [];

  public resellers: Array<{
    id: number;
    name: string;
    username: string;
    role: 'SUPER_ADMIN' | 'RESELLER';
    phone: string;
    balance: number;
    credit_limit: number;
    is_active: number;
    created_at: string;
  }> = [];

  public voucher_batches: Array<any> = [];
  public voucher_cards: Array<any> = [];
  public reseller_transactions: Array<any> = [];

  private seq = 100;

  constructor() {
    this.seedInitialData();
  }

  private nextId(): number {
    return ++this.seq;
  }

  private seedInitialData() {
    // 1. Seed NAS (MikroTik Routers)
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

    // 2. Seed Resellers
    this.resellers = [
      {
        id: 1,
        name: 'المدير العام للنظام (Super Admin)',
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
        balance: 1450.0,
        credit_limit: 500.0,
        is_active: 1,
        created_at: new Date(Date.now() - 86400000 * 14).toISOString(),
      },
      {
        id: 3,
        name: 'سوبر ماركت النخيل - نقطة بيع',
        username: 'nakheel_pos',
        role: 'RESELLER',
        phone: '0567778888',
        balance: 620.0,
        credit_limit: 200.0,
        is_active: 1,
        created_at: new Date(Date.now() - 86400000 * 7).toISOString(),
      },
    ];

    // 3. Seed Profiles & Sync with radgroupreply / radgroupcheck
    const initialProfiles: ProfileDTO[] = [
      {
        name: 'plan_2m_1day',
        displayName: 'باقة يومية سريعة (2 ميجا)',
        price: 5,
        costPrice: 3.5,
        speedLimit: '2M/2M',
        timeLimit: 86400,
        dataLimitMb: 3072,
        validityDays: 1,
        simultaneousUse: 1,
        portLimit: 1,
      },
      {
        name: 'plan_4m_week',
        displayName: 'باقة أسبوعية بلس (4 ميجا)',
        price: 20,
        costPrice: 15,
        speedLimit: '4M/4M',
        timeLimit: 604800,
        dataLimitMb: 15360,
        validityDays: 7,
        simultaneousUse: 1,
        portLimit: 1,
      },
      {
        name: 'plan_8m_month_vip',
        displayName: 'باقة شهرية VIP مفتوحة (8 ميجا)',
        price: 60,
        costPrice: 45,
        speedLimit: '8M/8M',
        timeLimit: 2592000,
        dataLimitMb: null,
        validityDays: 30,
        simultaneousUse: 2,
        portLimit: 2,
      },
      {
        name: 'plan_10m_2hours',
        displayName: 'كرت استراحة ساعتين (10 ميجا)',
        price: 3,
        costPrice: 2,
        speedLimit: '10M/10M',
        timeLimit: 7200,
        dataLimitMb: 2048,
        validityDays: 1,
        simultaneousUse: 1,
        portLimit: 1,
      },
    ];

    for (const p of initialProfiles) {
      this.createProfile(p);
    }

    // 4. Generate 2 initial batches so Dashboard has immediate realistic cards & revenue
    const adminActor: AuthUser = { id: 1, username: 'admin', role: 'SUPER_ADMIN' };
    const resellerActor: AuthUser = { id: 2, username: 'waha_agent', role: 'RESELLER' };

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
        prefix: 'W',
        codeLength: 7,
        charsetType: 'ALPHANUMERIC_UPPER',
        notes: 'دفعة مكتب الواحة الأسبوعية',
      },
      resellerActor
    );

    // Mark some cards as ACTIVE and EXPIRED and seed `radacct` live sessions
    const sampleCards = this.voucher_cards.slice(0, 8);
    sampleCards.forEach((card, idx) => {
      if (idx < 6) {
        card.status = 'ACTIVE';
        card.first_used_at = new Date(Date.now() - (idx + 1) * 1800000).toISOString();
        this.radacct.push({
          radacctid: this.nextId(),
          acctsessionid: `80a001c${idx + 1}`,
          acctuniqueid: `u_${this.nextId()}`,
          username: card.username,
          nasipaddress: idx % 2 === 0 ? '10.10.0.1' : '10.10.0.2',
          nasportid: `hotspot1`,
          acctstarttime: new Date(Date.now() - (idx + 1) * 1950000).toISOString(),
          acctupdatetime: new Date().toISOString(),
          acctsessiontime: (idx + 1) * 1950 + randomInt(30, 400),
          acctinputoctets: (idx + 1) * 48 * 1024 * 1024 + randomInt(100000, 9000000),
          acctoutputoctets: (idx + 1) * 320 * 1024 * 1024 + randomInt(1000000, 50000000),
          calledstationid: 'hotspot-server-1',
          callingstationid: `BC:24:11:4A:0${idx}:E${idx}`,
          framedipaddress: `172.16.10.${101 + idx}`,
        });
      } else {
        card.status = 'EXPIRED';
      }
    });

    // Also make one active session belong to reseller #2 (`waha_agent`) so RBAC filtering shows it
    const resellerCard = this.voucher_cards.find((c) => c.reseller_id === 2);
    if (resellerCard) {
      resellerCard.status = 'ACTIVE';
      this.radacct.push({
        radacctid: this.nextId(),
        acctsessionid: '80a0099f',
        acctuniqueid: `u_${this.nextId()}`,
        username: resellerCard.username,
        nasipaddress: '10.10.0.2',
        nasportid: 'hotspot1',
        acctstarttime: new Date(Date.now() - 4200000).toISOString(),
        acctupdatetime: new Date().toISOString(),
        acctsessiontime: 4200,
        acctinputoctets: 92 * 1024 * 1024,
        acctoutputoctets: 740 * 1024 * 1024,
        calledstationid: 'hotspot-east',
        callingstationid: 'D4:5D:64:99:1A:2B',
        framedipaddress: '172.16.20.55',
      });
    }
  }

  public createProfile(dto: ProfileDTO) {
    const id = this.profiles_meta.length + 1;
    const row = {
      id,
      name: dto.name,
      display_name: dto.displayName,
      price: Number(dto.price),
      cost_price: Number(dto.costPrice),
      speed_limit: dto.speedLimit,
      time_limit: dto.timeLimit ?? null,
      data_limit_mb: dto.dataLimitMb ?? null,
      validity_days: dto.validityDays ?? null,
      simultaneous_use: Number(dto.simultaneousUse || 1),
      port_limit: Number(dto.portLimit || 1),
      is_active: 1,
    };
    this.profiles_meta.push(row);
    this.syncGroupRadiusTables(dto);
    return row;
  }

  public updateProfile(id: number, dto: ProfileDTO) {
    const idx = this.profiles_meta.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error('الباقة غير موجودة');
    const oldName = this.profiles_meta[idx].name;

    this.profiles_meta[idx] = {
      ...this.profiles_meta[idx],
      name: dto.name,
      display_name: dto.displayName,
      price: Number(dto.price),
      cost_price: Number(dto.costPrice),
      speed_limit: dto.speedLimit,
      time_limit: dto.timeLimit ?? null,
      data_limit_mb: dto.dataLimitMb ?? null,
      validity_days: dto.validityDays ?? null,
      simultaneous_use: Number(dto.simultaneousUse || 1),
      port_limit: Number(dto.portLimit || 1),
    };

    if (oldName !== dto.name) {
      this.radusergroup.forEach((ug) => {
        if (ug.groupname === oldName) ug.groupname = dto.name;
      });
      this.radgroupreply = this.radgroupreply.filter((r) => r.groupname !== oldName);
      this.radgroupcheck = this.radgroupcheck.filter((c) => c.groupname !== oldName);
    }

    this.syncGroupRadiusTables(dto);
    return this.profiles_meta[idx];
  }

  public deleteProfile(id: number) {
    const idx = this.profiles_meta.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error('الباقة غير موجودة');
    const groupname = this.profiles_meta[idx].name;
    this.profiles_meta.splice(idx, 1);
    this.radgroupreply = this.radgroupreply.filter((r) => r.groupname !== groupname);
    this.radgroupcheck = this.radgroupcheck.filter((c) => c.groupname !== groupname);
  }

  private syncGroupRadiusTables(dto: ProfileDTO) {
    this.radgroupreply = this.radgroupreply.filter((r) => r.groupname !== dto.name);
    this.radgroupcheck = this.radgroupcheck.filter((c) => c.groupname !== dto.name);

    this.radgroupreply.push(
      { id: this.nextId(), groupname: dto.name, attribute: 'Mikrotik-Rate-Limit', op: ':=', value: dto.speedLimit },
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
      const bytes = BigInt(dto.dataLimitMb) * BigInt(1024 * 1024);
      this.radgroupreply.push({
        id: this.nextId(),
        groupname: dto.name,
        attribute: 'Mikrotik-Total-Limit',
        op: ':=',
        value: bytes.toString(),
      });
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

  public generateBatch(dto: GenerateBatchDTO, actor: AuthUser) {
    const profile = this.profiles_meta.find((p) => p.id === Number(dto.profileId));
    if (!profile) throw new Error('الباقة المختارة غير موجودة');

    const targetResellerId =
      actor.role === 'SUPER_ADMIN' && dto.resellerId ? Number(dto.resellerId) : actor.id;
    const reseller = this.resellers.find((r) => r.id === targetResellerId);
    if (!reseller || !reseller.is_active) {
      throw new Error('حساب الموزع غير موجود أو موقوف');
    }

    const unitCost = Number(profile.cost_price);
    const totalCost = Number((unitCost * dto.quantity).toFixed(2));
    const balanceBefore = reseller.balance;

    if (reseller.role !== 'SUPER_ADMIN') {
      if (totalCost > reseller.balance + reseller.credit_limit) {
        throw new Error(
          `رصيد الموزع غير كافٍ. التكلفة المطلوبة: ${totalCost} ر.س، الرصيد المتاح (شامل الائتمان): ${(
            reseller.balance + reseller.credit_limit
          ).toFixed(2)} ر.س`
        );
      }
    }

    const existingUsers = new Set(this.radcheck.map((r) => r.username));
    const prefix = (dto.prefix || '').trim();
    const randLen = Math.max(4, Number(dto.codeLength) - prefix.length);
    const alphabet = CHARSETS[dto.charsetType || 'NUMERIC'];

    const batchCode = `B-${Date.now().toString(36).toUpperCase().slice(-5)}-${randomCode(
      3,
      CHARSETS.ALPHANUMERIC_UPPER
    )}`;
    const batchId = this.voucher_batches.length + 1;

    const cards: Array<{ username: string; cleartextPassword: string; serialNumber: string }> = [];
    while (cards.length < dto.quantity) {
      const candidate = `${prefix}${randomCode(randLen, alphabet)}`;
      if (!existingUsers.has(candidate)) {
        existingUsers.add(candidate);
        const seq = String(cards.length + 1).padStart(4, '0');
        const cleartextPassword =
          dto.voucherType === 'PIN_ONLY' ? candidate : randomCode(6, CHARSETS.NUMERIC);
        cards.push({
          username: candidate,
          cleartextPassword,
          serialNumber: `${batchCode}-${seq}`,
        });
      }
    }

    // Insert Batch Header
    const batchRecord = {
      id: batchId,
      batch_code: batchCode,
      profile_id: profile.id,
      profile_display_name: profile.display_name,
      speed_limit: profile.speed_limit,
      price: profile.price,
      quantity: dto.quantity,
      reseller_id: targetResellerId,
      reseller_name: reseller.name,
      voucher_type: dto.voucherType,
      prefix,
      code_length: dto.codeLength,
      charset_type: dto.charsetType,
      unit_cost: unitCost,
      total_cost: totalCost,
      notes: dto.notes || null,
      created_at: new Date().toISOString(),
    };
    this.voucher_batches.unshift(batchRecord);

    // Bulk Insert into radcheck, radusergroup, voucher_cards
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
        profile_id: profile.id,
        profile_display_name: profile.display_name,
        price: profile.price,
        username: card.username,
        cleartext_password: card.cleartextPassword,
        serial_number: card.serialNumber,
        status: 'UNUSED',
        created_at: new Date().toISOString(),
      });
    }

    // Deduct balance
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
      description: `توليد ${dto.quantity} كرت (${profile.display_name}) - دفعة ${batchCode}`,
      created_at: new Date().toISOString(),
    });

    return {
      batchId,
      batchCode,
      quantity: dto.quantity,
      profileName: profile.name,
      profileDisplayName: profile.display_name,
      price: profile.price,
      totalCost,
      balanceAfter: reseller.balance,
      cards,
    };
  }
}

export const demoStore = new DemoRadiusStore();
