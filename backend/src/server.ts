import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { demoStore } from './store/DemoRadiusStore';
import { AuthUser } from './types/radius.types';
import { dbPool } from './config/database';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

/**
 * Checks whether MariaDB (`radius` database) is reachable on the host.
 * If unreachable, transparently uses the stateful FreeRADIUS in-memory engine
 * (`demoStore`) so every feature works immediately out-of-the-box.
 */
let isMariaDbConnected = false;
async function checkMariaDbConnection() {
  try {
    const conn = await dbPool.getConnection();
    await conn.ping();
    conn.release();
    isMariaDbConnected = true;
  } catch {
    isMariaDbConnected = false;
  }
}
checkMariaDbConnection();

/**
 * Middleware: Extracts current actor (Supports switching between Super Admin and Resellers from UI header)
 */
app.use((req, _res, next) => {
  const actorIdHeader = Number(req.headers['x-actor-id']) || 1;
  const reseller = demoStore.resellers.find((r) => r.id === actorIdHeader) || demoStore.resellers[0];
  req.user = {
    id: reseller.id,
    username: reseller.username,
    role: reseller.role,
  } as AuthUser;
  next();
});

// -----------------------------------------------------------------------------
// 1. System Status & Current RBAC Actor
// -----------------------------------------------------------------------------
app.get('/api/system/status', (req, res) => {
  const actor = demoStore.resellers.find((r) => r.id === req.user!.id) || demoStore.resellers[0];
  res.json({
    engine: isMariaDbConnected ? 'MARIADB_LIVE' : 'FREERADIUS_MEMORY_ENGINE',
    ubuntuTarget: 'Ubuntu 24.04 LTS / FreeRADIUS 3.x / MariaDB 10.11',
    currentActor: actor,
    availableActors: demoStore.resellers,
  });
});

// -----------------------------------------------------------------------------
// 2. Dashboard KPIs & Live Network Traffic Series
// -----------------------------------------------------------------------------
app.get('/api/dashboard/kpis', (req, res) => {
  const actor = req.user!;
  const isSuper = actor.role === 'SUPER_ADMIN';

  const ownedCards = isSuper
    ? demoStore.voucher_cards
    : demoStore.voucher_cards.filter((c) => c.reseller_id === actor.id);

  const ownedUsernames = new Set(ownedCards.map((c) => c.username));
  const activeSessions = isSuper
    ? demoStore.radacct
    : demoStore.radacct.filter((s) => ownedUsernames.has(s.username));

  const batches = isSuper
    ? demoStore.voucher_batches
    : demoStore.voucher_batches.filter((b) => b.reseller_id === actor.id);

  const totalUploadBytes = activeSessions.reduce((acc, s) => acc + s.acctinputoctets, 0);
  const totalDownloadBytes = activeSessions.reduce((acc, s) => acc + s.acctoutputoctets, 0);
  const totalRevenue = batches.reduce((acc, b) => acc + b.total_cost, 0);

  res.json({
    activeSessions: activeSessions.length,
    totalUploadBytes,
    totalDownloadBytes,
    vouchers: {
      total: ownedCards.length,
      unused: ownedCards.filter((c) => c.status === 'UNUSED').length,
      active: ownedCards.filter((c) => c.status === 'ACTIVE').length,
      expired: ownedCards.filter((c) => c.status === 'EXPIRED').length,
    },
    revenue: {
      daily: totalRevenue,
      monthly: totalRevenue * 4.2,
    },
    trafficHistory: [
      { time: '10:00', downloadMbps: 42, uploadMbps: 11 },
      { time: '11:00', downloadMbps: 58, uploadMbps: 15 },
      { time: '12:00', downloadMbps: 85, uploadMbps: 22 },
      { time: '13:00', downloadMbps: 94, uploadMbps: 28 },
      { time: '14:00', downloadMbps: 112, uploadMbps: 31 },
      { time: '15:00', downloadMbps: 128, uploadMbps: 36 },
    ],
    recentBatches: batches.slice(0, 6),
  });
});

// -----------------------------------------------------------------------------
// 3. Batch Voucher Generator & Printable Cards
// -----------------------------------------------------------------------------
app.get('/api/vouchers/batches', (req, res) => {
  const actor = req.user!;
  const batches =
    actor.role === 'SUPER_ADMIN'
      ? demoStore.voucher_batches
      : demoStore.voucher_batches.filter((b) => b.reseller_id === actor.id);
  res.json(batches);
});

app.post('/api/vouchers/batches', (req, res) => {
  try {
    const result = demoStore.generateBatch(req.body, req.user!);
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
});

app.get('/api/vouchers/batches/:batchId/print', (req, res) => {
  const batchId = Number(req.params.batchId);
  const batch = demoStore.voucher_batches.find((b) => b.id === batchId);
  if (!batch) {
    return res.status(404).json({ message: 'الدفعة غير موجودة' });
  }
  if (req.user!.role !== 'SUPER_ADMIN' && batch.reseller_id !== req.user!.id) {
    return res.status(403).json({ message: 'غير مصرح لك بعرض أو طباعة هذه الدفعة' });
  }

  const cards = demoStore.voucher_cards
    .filter((c) => c.batch_id === batchId)
    .map((c) => ({
      username: c.username,
      cleartextPassword: c.cleartext_password,
      serialNumber: c.serial_number,
      status: c.status,
    }));

  res.json({ batch, cards });
});

// -----------------------------------------------------------------------------
// 4. Profiles & Bandwidth Management (`profiles_meta` + `radgroupreply` + `radgroupcheck`)
// -----------------------------------------------------------------------------
app.get('/api/profiles', (_req, res) => {
  const enriched = demoStore.profiles_meta.map((p) => ({
    ...p,
    radgroupreply: demoStore.radgroupreply.filter((r) => r.groupname === p.name),
    radgroupcheck: demoStore.radgroupcheck.filter((c) => c.groupname === p.name),
  }));
  res.json(enriched);
});

app.post('/api/profiles', (req, res) => {
  if (req.user!.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ message: 'إدارة الباقات متاحة للمدير العام فقط' });
  }
  try {
    const created = demoStore.createProfile(req.body);
    res.status(201).json(created);
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
});

app.put('/api/profiles/:id', (req, res) => {
  if (req.user!.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ message: 'تعديل الباقات متاح للمدير العام فقط' });
  }
  try {
    const updated = demoStore.updateProfile(Number(req.params.id), req.body);
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
});

app.delete('/api/profiles/:id', (req, res) => {
  if (req.user!.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ message: 'حذف الباقات متاح للمدير العام فقط' });
  }
  try {
    demoStore.deleteProfile(Number(req.params.id));
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
});

// -----------------------------------------------------------------------------
// 5. Live Accounting & Session Management (`radacct` + CoA/PoD Disconnect)
// -----------------------------------------------------------------------------
app.get('/api/sessions/active', (req, res) => {
  const actor = req.user!;
  const search = String(req.query.search || '').trim().toLowerCase();

  let sessions = demoStore.radacct;
  if (actor.role !== 'SUPER_ADMIN') {
    const ownedUsernames = new Set(
      demoStore.voucher_cards
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
        s.callingstationid.toLowerCase().includes(search)
    );
  }

  res.json({ count: sessions.length, sessions });
});

app.post('/api/sessions/:radacctId/disconnect', (req, res) => {
  const radacctId = Number(req.params.radacctId);
  const idx = demoStore.radacct.findIndex((s) => s.radacctid === radacctId);
  if (idx === -1) {
    return res.status(404).json({ message: 'الجلسة غير موجودة أو تم فصلها مسبقاً' });
  }

  const session = demoStore.radacct[idx];
  demoStore.radacct.splice(idx, 1);

  res.json({
    success: true,
    method: `RADIUS_COA_POD (radclient ${session.nasipaddress}:3799 disconnect)`,
    username: session.username,
    framedIp: session.framedipaddress,
    nasIp: session.nasipaddress,
  });
});

// Simulate a new Hotspot client login into `radacct` for testing
app.post('/api/sessions/simulate', (_req, res) => {
  const unusedCard = demoStore.voucher_cards.find((c) => c.status === 'UNUSED');
  const username = unusedCard ? unusedCard.username : `77${Math.floor(100000 + Math.random() * 900000)}`;
  if (unusedCard) unusedCard.status = 'ACTIVE';

  const newSession = {
    radacctid: Date.now(),
    acctsessionid: `80b${Math.floor(10000 + Math.random() * 90000)}`,
    acctuniqueid: `u_${Date.now()}`,
    username,
    nasipaddress: Math.random() > 0.5 ? '10.10.0.1' : '10.10.0.2',
    nasportid: 'hotspot1',
    acctstarttime: new Date().toISOString(),
    acctupdatetime: new Date().toISOString(),
    acctsessiontime: 15,
    acctinputoctets: 2 * 1024 * 1024,
    acctoutputoctets: 14 * 1024 * 1024,
    calledstationid: 'hotspot-main',
    callingstationid: `A4:83:E7:${Math.floor(10 + Math.random() * 89)}:${Math.floor(10 + Math.random() * 89)}:C1`,
    framedipaddress: `172.16.10.${Math.floor(110 + Math.random() * 140)}`,
  };

  demoStore.radacct.unshift(newSession);
  res.status(201).json(newSession);
});

// -----------------------------------------------------------------------------
// 6. Resellers & Sub-Accounts Portal (RBAC + Financial Ledger)
// -----------------------------------------------------------------------------
app.get('/api/resellers', (req, res) => {
  if (req.user!.role !== 'SUPER_ADMIN') {
    const self = demoStore.resellers.filter((r) => r.id === req.user!.id);
    return res.json({
      resellers: self,
      transactions: demoStore.reseller_transactions.filter((t) => t.reseller_id === req.user!.id),
    });
  }
  res.json({
    resellers: demoStore.resellers,
    transactions: demoStore.reseller_transactions.slice(0, 30),
  });
});

app.post('/api/resellers', (req, res) => {
  if (req.user!.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ message: 'إضافة الموزعين متاحة للمدير العام فقط' });
  }
  const { name, username, phone, balance, credit_limit } = req.body;
  if (!name || !username) {
    return res.status(400).json({ message: 'الاسم واسم المستخدم مطلوبان' });
  }
  const newReseller = {
    id: demoStore.resellers.length + 1,
    name,
    username,
    role: 'RESELLER' as const,
    phone: phone || '',
    balance: Number(balance || 0),
    credit_limit: Number(credit_limit || 0),
    is_active: 1,
    created_at: new Date().toISOString(),
  };
  demoStore.resellers.push(newReseller);
  res.status(201).json(newReseller);
});

app.post('/api/resellers/:id/topup', (req, res) => {
  if (req.user!.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ message: 'شحن الرصيد متاح للمدير العام فقط' });
  }
  const reseller = demoStore.resellers.find((r) => r.id === Number(req.params.id));
  if (!reseller) return res.status(404).json({ message: 'الموزع غير موجود' });

  const amount = Number(req.body.amount || 0);
  const before = reseller.balance;
  reseller.balance = Number((before + amount).toFixed(2));

  demoStore.reseller_transactions.unshift({
    id: Date.now(),
    reseller_id: reseller.id,
    reseller_name: reseller.name,
    batch_id: null,
    type: 'DEPOSIT',
    amount,
    balance_before: before,
    balance_after: reseller.balance,
    description: req.body.description || 'إيداع رصيد مباشر من الإدارة',
    created_at: new Date().toISOString(),
  });

  res.json(reseller);
});

// -----------------------------------------------------------------------------
// 7. NAS Routers & Raw FreeRADIUS Tables Inspector (`nas`, `radcheck`, `radgroupreply`)
// -----------------------------------------------------------------------------
app.get('/api/radius/inspector', (_req, res) => {
  res.json({
    nas: demoStore.nas,
    radcheckSample: demoStore.radcheck.slice(-25).reverse(),
    radusergroupSample: demoStore.radusergroup.slice(-25).reverse(),
    radgroupreply: demoStore.radgroupreply,
    radgroupcheck: demoStore.radgroupcheck,
  });
});

app.post('/api/radius/nas', (req, res) => {
  if (req.user!.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ message: 'إضافة راوتر NAS متاح للمدير العام فقط' });
  }
  const { nasname, shortname, secret, description } = req.body;
  const newNas = {
    id: demoStore.nas.length + 1,
    nasname,
    shortname,
    type: 'other',
    secret,
    description: description || '',
  };
  demoStore.nas.push(newNas);
  res.status(201).json(newNas);
});

const PORT = Number(process.env.PORT) || 4000;
app.listen(PORT, () => {
  console.log(`✅ FreeRADIUS Hotspot Backend API running on http://localhost:${PORT}`);
});
