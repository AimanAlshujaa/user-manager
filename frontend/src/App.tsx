import React, { useEffect, useState, useCallback } from 'react';
import {
  LayoutDashboard,
  Ticket,
  Gauge,
  Wifi,
  Users,
  Database,
  Server,
  ShieldCheck,
  TrendingUp,
  ArrowDownCircle,
  ArrowUpCircle,
  Plus,
  Trash2,
  Printer,
  UserCheck,
  Wallet,
  RefreshCw,
  PowerOff,
  Search,
  Clock,
  CheckCircle2,
  AlertCircle,
  QrCode,
  Sparkles,
  Play,
  Pencil,
  Menu,
  X,
} from 'lucide-react';

type TabKey = 'dashboard' | 'vouchers' | 'profiles' | 'sessions' | 'resellers' | 'radius_db';

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

function formatUptime(seconds: number): string {
  const s = Math.max(0, Number(seconds) || 0);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  return [hrs, mins, secs].map((v) => String(v).padStart(2, '0')).join(':');
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
  const [actorId, setActorId] = useState<number>(1); // 1 = Super Admin, 2 = Waha Agent (Reseller)
  const [systemStatus, setSystemStatus] = useState<any>(null);

  // Shared Data States
  const [kpis, setKpis] = useState<any>(null);
  const [profiles, setProfiles] = useState<any[]>([]);
  const [batches, setBatches] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [sessionSearch, setSessionSearch] = useState<string>('');
  const [resellersData, setResellersData] = useState<{ resellers: any[]; transactions: any[] }>({
    resellers: [],
    transactions: [],
  });
  const [inspectorData, setInspectorData] = useState<any>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Batch Voucher Generator & Print State
  const [genForm, setGenForm] = useState({
    profileId: 1,
    quantity: 40,
    voucherType: 'PIN_ONLY' as 'PIN_ONLY' | 'USER_PASS',
    prefix: '77',
    codeLength: 8,
    charsetType: 'NUMERIC' as 'NUMERIC' | 'ALPHANUMERIC_UPPER' | 'ALPHANUMERIC_MIXED',
    notes: '',
  });
  const [brandSettings, setBrandSettings] = useState({
    networkName: 'شبكة النور هوت سبوت',
    hotspotUrl: 'http://wifi.lan/login',
    supportPhone: '0501112222',
    showQr: true,
    cardsPerPage: 40 as 40 | 30,
  });
  const [printableBatch, setPrintableBatch] = useState<{ batch: any; cards: any[] } | null>(null);

  // Profile Creation & Editing State
  const [editingProfileId, setEditingProfileId] = useState<number | null>(null);
  const [newProfile, setNewProfile] = useState({
    name: '',
    displayName: '',
    price: 10,
    costPrice: 7,
    speedLimit: '',
    timeLimitHours: 24,
    dataLimitMb: 10240,
    validityDays: 30,
    simultaneousUse: 1,
    portLimit: 1,
  });

  // Reseller Creation & Topup State
  const [newReseller, setNewReseller] = useState({
    name: '',
    username: '',
    phone: '',
    balance: 500,
    credit_limit: 200,
  });
  const [topupAmount, setTopupAmount] = useState<Record<number, number>>({});

  const showBanner = (type: 'success' | 'error', text: string) => {
    setToast({ type, text });
    setTimeout(() => setToast(null), 5000);
  };

  const apiFetch = useCallback(
    async (path: string, options: RequestInit = {}) => {
      const res = await fetch(path, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'x-actor-id': String(actorId),
          ...(options.headers || {}),
        },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'خطأ في العملية');
      return data;
    },
    [actorId]
  );

  const loadAllData = useCallback(async () => {
    try {
      const [sys, kpiData, profData, batchData, sessData, resData, inspData] = await Promise.all([
        apiFetch('/api/system/status'),
        apiFetch('/api/dashboard/kpis'),
        apiFetch('/api/profiles'),
        apiFetch('/api/vouchers/batches'),
        apiFetch(`/api/sessions/active?search=${encodeURIComponent(sessionSearch)}`),
        apiFetch('/api/resellers'),
        apiFetch('/api/radius/inspector'),
      ]);
      setSystemStatus(sys);
      setKpis(kpiData);
      setProfiles(profData);
      setBatches(batchData);
      setSessions(sessData.sessions || []);
      setResellersData(resData);
      setInspectorData(inspData);
    } catch (err: any) {
      showBanner('error', err.message);
    }
  }, [apiFetch, sessionSearch]);

  useEffect(() => {
    loadAllData();
  }, [loadAllData]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileMenuOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Actions
  const handleGenerateBatch = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const result = await apiFetch('/api/vouchers/batches', {
        method: 'POST',
        body: JSON.stringify(genForm),
      });
      showBanner(
        'success',
        `تم توليد ${result.quantity} كرت بنجاح (دفعة ${result.batchCode}) وإضافتها إلى radcheck و radusergroup!`
      );
      await loadAllData();
      const printData = await apiFetch(`/api/vouchers/batches/${result.batchId}/print`);
      setPrintableBatch(printData);
    } catch (err: any) {
      showBanner('error', err.message);
    }
  };

  const handleLoadBatchPrint = async (batchId: number) => {
    try {
      const printData = await apiFetch(`/api/vouchers/batches/${batchId}/print`);
      setPrintableBatch(printData);
      setActiveTab('vouchers');
    } catch (err: any) {
      showBanner('error', err.message);
    }
  };

  const startEditProfile = (p: any) => {
    setEditingProfileId(Number(p.id));
    setNewProfile({
      name: p.name || '',
      displayName: p.display_name || '',
      price: Number(p.price || 0),
      costPrice: Number(p.cost_price || 0),
      speedLimit: p.speed_limit || '',
      timeLimitHours: p.time_limit ? Number((Number(p.time_limit) / 3600).toFixed(2)) : 0,
      dataLimitMb: p.data_limit_mb ? Number(p.data_limit_mb) : 0,
      validityDays: p.validity_days ? Number(p.validity_days) : 0,
      simultaneousUse: Number(p.simultaneous_use || 1),
      portLimit: Number(p.port_limit || 1),
    });
  };

  const cancelEditProfile = () => {
    setEditingProfileId(null);
    setNewProfile({
      name: '',
      displayName: '',
      price: 10,
      costPrice: 7,
      speedLimit: '',
      timeLimitHours: 24,
      dataLimitMb: 10240,
      validityDays: 30,
      simultaneousUse: 1,
      portLimit: 1,
    });
  };

  const handleCreateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const speedLimit = newProfile.speedLimit.trim();
      const timeHours = Number(newProfile.timeLimitHours);
      const dataMb = Number(newProfile.dataLimitMb);
      const validityDaysNum = Number(newProfile.validityDays);
      const validityDays = validityDaysNum > 0 ? Math.round(validityDaysNum) : null;
      const bodyPayload = {
        name: newProfile.name.trim(),
        displayName: newProfile.displayName.trim(),
        price: Number(newProfile.price),
        costPrice: Number(newProfile.costPrice),
        speedLimit: speedLimit || null,
        timeLimit: timeHours > 0 ? Math.round(timeHours * 3600) : null,
        dataLimitMb: dataMb > 0 ? Math.round(dataMb) : null,
        validityDays,
        validity_days: validityDays,
        simultaneousUse: Number(newProfile.simultaneousUse),
        portLimit: Number(newProfile.portLimit),
      };

      if (editingProfileId !== null) {
        await apiFetch(`/api/profiles/${editingProfileId}`, {
          method: 'PUT',
          body: JSON.stringify(bodyPayload),
        });
        showBanner('success', 'تم تعديل الباقة ومزامنة FreeRADIUS بنجاح دون التأثير على الكروت المرتبطة');
      } else {
        await apiFetch('/api/profiles', {
          method: 'POST',
          body: JSON.stringify(bodyPayload),
        });
        showBanner('success', 'تم إنشاء الباقة ومزامنة خصائص MikroTik مع radgroupreply و radgroupcheck');
      }

      cancelEditProfile();
      loadAllData();
    } catch (err: any) {
      showBanner('error', err.message);
    }
  };

  const handleDeleteProfile = async (id: number) => {
    if (!window.confirm('هل أنت متأكد من حذف هذه الباقة؟ (لا يمكن حذف باقة مرتبطة بكروت حالية)')) return;
    try {
      await apiFetch(`/api/profiles/${id}`, { method: 'DELETE' });
      if (editingProfileId === id) cancelEditProfile();
      showBanner('success', 'تم حذف الباقة وإزالة خصائصها من جداول FreeRADIUS');
      loadAllData();
    } catch (err: any) {
      showBanner('error', err.message);
    }
  };

  const handleDisconnectSession = async (radacctid: number, username: string) => {
    try {
      const res = await apiFetch(`/api/sessions/${radacctid}/disconnect`, { method: 'POST' });
      showBanner('success', `تم طرد المشترك (${username}) فوراً عبر ${res.method}`);
      loadAllData();
    } catch (err: any) {
      showBanner('error', err.message);
    }
  };

  const handleSimulateSession = async () => {
    try {
      const s = await apiFetch('/api/sessions/simulate', { method: 'POST' });
      showBanner('success', `تمت محاكاة اتصال مشترك جديد (${s.username}) على IP ${s.framedipaddress}`);
      loadAllData();
    } catch (err: any) {
      showBanner('error', err.message);
    }
  };

  const handleCreateReseller = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/resellers', {
        method: 'POST',
        body: JSON.stringify(newReseller),
      });
      showBanner('success', 'تم إنشاء حساب الموزع الجديد بنجاح');
      setNewReseller({ name: '', username: '', phone: '', balance: 500, credit_limit: 200 });
      loadAllData();
    } catch (err: any) {
      showBanner('error', err.message);
    }
  };

  const handleTopupReseller = async (resellerId: number) => {
    const amount = Number(topupAmount[resellerId] || 200);
    try {
      await apiFetch(`/api/resellers/${resellerId}/topup`, {
        method: 'POST',
        body: JSON.stringify({ amount, description: 'شحن رصيد فوري من الإدارة' }),
      });
      showBanner('success', `تم شحن ${amount} ر.س في محفظة الموزع`);
      loadAllData();
    } catch (err: any) {
      showBanner('error', err.message);
    }
  };

  const currentActor = systemStatus?.currentActor;

  // Chunk printable cards into pages
  const printablePages: any[][] = [];
  if (printableBatch?.cards) {
    for (let i = 0; i < printableBatch.cards.length; i += brandSettings.cardsPerPage) {
      printablePages.push(printableBatch.cards.slice(i, i + brandSettings.cardsPerPage));
    }
  }

  return (
    <div dir="rtl" className="min-h-screen flex bg-slate-100 text-slate-900 overflow-x-clip">
      {/* Print-Only Stylesheet for A4 40-Card Sheet */}
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 5mm; }
          body * { visibility: hidden; }
          #a4-print-area, #a4-print-area * { visibility: visible; }
          #a4-print-area { position: absolute; left: 0; top: 0; width: 100%; }
          .a4-page-break { page-break-after: always; break-after: page; }
        }
      `}</style>

      {/* Mobile/Tablet Sidebar Backdrop */}
      {mobileMenuOpen && (
        <div
          className="print:hidden fixed inset-0 z-40 bg-slate-950/60 backdrop-blur-[2px] lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar Navigation */}
      <aside
        className={`print:hidden fixed inset-y-0 right-0 z-50 w-72 max-w-[85vw] bg-slate-900 text-slate-100 flex flex-col shrink-0 shadow-xl overflow-y-auto transition-transform duration-200 ease-out lg:static lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${
          mobileMenuOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="p-5 sm:p-6 border-b border-slate-800 flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-2xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-600/30 shrink-0">
              <Wifi className="w-6 h-6 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="font-extrabold text-lg tracking-wide text-white truncate">RadiusPro ISP</h1>
              <p className="text-xs text-slate-400 truncate">MikroTik & FreeRADIUS 3.x</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            className="lg:hidden p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition shrink-0"
            aria-label="إغلاق القائمة"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 p-4 space-y-1.5">
          {[
            { id: 'dashboard', label: 'لوحة القيادة والإحصائيات', icon: LayoutDashboard },
            { id: 'vouchers', label: 'توليد وطباعة الكروت (A4)', icon: Ticket },
            { id: 'profiles', label: 'الباقات والسرعات (Profiles)', icon: Gauge },
            { id: 'sessions', label: 'المتصلون الآن (Live CoA)', icon: Wifi, badge: kpis?.activeSessions },
            { id: 'resellers', label: 'الموزعون والأرصدة (RBAC)', icon: Users },
            { id: 'radius_db', label: 'فاحص جداول FreeRADIUS & NAS', icon: Database },
          ].map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  setActiveTab(item.id as TabKey);
                  setMobileMenuOpen(false);
                }}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-sm font-semibold transition ${
                  active
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/30'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <span className="flex items-center gap-3 min-w-0">
                  <Icon className="w-5 h-5 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </span>
                {item.badge !== undefined && (
                  <span className="bg-emerald-500 text-slate-950 text-xs font-extrabold px-2.5 py-0.5 rounded-full shrink-0">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* RBAC Role Switcher Box in Sidebar Footer */}
        <div className="p-4 m-4 rounded-2xl bg-slate-800/90 border border-slate-700 space-y-3">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="flex items-center gap-1 font-bold text-indigo-400">
              <UserCheck className="w-4 h-4 shrink-0" />
              تبديل الحساب لتجربة الصلاحيات (RBAC)
            </span>
          </div>
          <select
            value={actorId}
            onChange={(e) => setActorId(Number(e.target.value))}
            className="w-full bg-slate-900 text-white text-xs rounded-xl px-3 py-2.5 border border-slate-700 focus:outline-none focus:border-indigo-500"
          >
            {systemStatus?.availableActors?.map((a: any) => (
              <option key={a.id} value={a.id}>
                {a.role === 'SUPER_ADMIN' ? '👑 مدير عام: ' : '🏪 موزع: '}
                {a.name}
              </option>
            ))}
          </select>
          {currentActor && (
            <div className="flex items-center justify-between text-xs pt-1 border-t border-slate-700/80">
              <span className="text-slate-400">الرصيد الحالي:</span>
              <span className="font-bold text-emerald-400">{currentActor.balance} ر.س</span>
            </div>
          )}
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 w-full">
        {/* Top Header */}
        <header className="print:hidden bg-white border-b border-slate-200 px-4 sm:px-6 lg:px-8 py-3.5 sm:py-4 flex flex-wrap items-center justify-between gap-3 sm:gap-4">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden inline-flex items-center justify-center w-10 h-10 rounded-xl border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 shrink-0"
              aria-label="فتح القائمة"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg lg:text-xl font-extrabold text-slate-800 leading-snug">
                {activeTab === 'dashboard' && 'لوحة القيادة ومؤشرات الأداء اللحظية'}
                {activeTab === 'vouchers' && 'مولّد دفعات الكروت والطباعة الفورية (40 كرت / A4)'}
                {activeTab === 'profiles' && 'إدارة الباقات والسرعات (MikroTik Rate-Limit & Quotas)'}
                {activeTab === 'sessions' && 'مراقبة المتصلين الآن وفصل الجلسات الفوري (CoA / PoD)'}
                {activeTab === 'resellers' && 'بوابة الموزعين ونقاط البيع والعمليات المالية'}
                {activeTab === 'radius_db' && 'فاحص جداول FreeRADIUS المباشر وراوترات MikroTik NAS'}
              </h2>
              <p className="text-[11px] sm:text-xs text-slate-500 mt-0.5">
                المستخدم النشط حالياً:{' '}
                <strong className="text-indigo-700">{currentActor?.name}</strong> (
                {currentActor?.role === 'SUPER_ADMIN' ? 'صلاحية كاملة Super Admin' : 'صلاحية موزع محدد الرصيد Reseller'})
              </p>
            </div>
          </div>

          <div className="w-full sm:w-auto flex flex-wrap items-center justify-between sm:justify-end gap-2 sm:gap-3">
            <span className="inline-flex items-center gap-2 text-[11px] sm:text-xs font-bold px-3 py-2 rounded-xl bg-emerald-50 text-emerald-800 border border-emerald-200">
              <Server className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>FreeRADIUS 3.x Engine: متصل وجاهز</span>
            </span>
            <button
              onClick={loadAllData}
              className="inline-flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold px-3.5 py-2 rounded-xl transition shrink-0"
            >
              <RefreshCw className="w-4 h-4" />
              تحديث البيانات
            </button>
          </div>
        </header>

        {/* Global Notification Toast */}
        {toast && (
          <div className="print:hidden mx-4 sm:mx-6 lg:mx-8 mt-4">
            <div
              className={`flex items-center gap-3 px-4 py-3 rounded-xl text-xs sm:text-sm font-bold shadow-sm ${
                toast.type === 'success'
                  ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                  : 'bg-red-50 text-red-800 border border-red-200'
              }`}
            >
              {toast.type === 'success' ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
              ) : (
                <AlertCircle className="w-5 h-5 text-red-600 shrink-0" />
              )}
              <span>{toast.text}</span>
            </div>
          </div>
        )}

        <main className="p-4 sm:p-6 lg:p-8 space-y-5 sm:space-y-6 flex-1 overflow-y-auto min-w-0">
          {/* ================================================================= */}
          {/* TAB 1: DASHBOARD & KPIS                                           */}
          {/* ================================================================= */}
          {activeTab === 'dashboard' && kpis && (
            <div className="space-y-6">
              {/* Top 4 KPI Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5">
                <div className="bg-white p-4 sm:p-6 rounded-2xl shadow-sm border border-slate-200 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-slate-500">المتصلون الآن (radacct)</p>
                    <p className="text-2xl sm:text-3xl font-extrabold text-slate-900 mt-2">{kpis.activeSessions}</p>
                    <p className="text-xs text-emerald-600 font-semibold mt-1">جلسة نشطة حالياً</p>
                  </div>
                  <div className="w-11 h-11 sm:w-14 sm:h-14 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
                    <Wifi className="w-6 h-6 sm:w-7 sm:h-7" />
                  </div>
                </div>

                <div className="bg-white p-4 sm:p-6 rounded-2xl shadow-sm border border-slate-200 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-slate-500">الكروت المتاحة (غير مستخدمة)</p>
                    <p className="text-2xl sm:text-3xl font-extrabold text-indigo-700 mt-2">{kpis.vouchers.unused}</p>
                    <p className="text-xs text-slate-500 mt-1">
                      نشط: {kpis.vouchers.active} | منتهي: {kpis.vouchers.expired}
                    </p>
                  </div>
                  <div className="w-11 h-11 sm:w-14 sm:h-14 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
                    <Ticket className="w-6 h-6 sm:w-7 sm:h-7" />
                  </div>
                </div>

                <div className="bg-white p-4 sm:p-6 rounded-2xl shadow-sm border border-slate-200 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-slate-500">إجمالي استهلاك الجلسات الحية</p>
                    <p className="text-xl sm:text-2xl font-extrabold text-slate-900 mt-2" dir="ltr">
                      {formatBytes(kpis.totalDownloadBytes + kpis.totalUploadBytes)}
                    </p>
                    <p className="text-xs text-slate-500 mt-1" dir="ltr">
                      ↓ {formatBytes(kpis.totalDownloadBytes)} | ↑ {formatBytes(kpis.totalUploadBytes)}
                    </p>
                  </div>
                  <div className="w-11 h-11 sm:w-14 sm:h-14 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center shrink-0">
                    <ArrowDownCircle className="w-6 h-6 sm:w-7 sm:h-7" />
                  </div>
                </div>

                <div className="bg-white p-4 sm:p-6 rounded-2xl shadow-sm border border-slate-200 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-slate-500">مبيعات الدفعات اليومية</p>
                    <p className="text-2xl sm:text-3xl font-extrabold text-emerald-700 mt-2">
                      {kpis.revenue.daily.toFixed(2)} <span className="text-sm">ر.س</span>
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      التقدير الشهري: {kpis.revenue.monthly.toFixed(0)} ر.س
                    </p>
                  </div>
                  <div className="w-11 h-11 sm:w-14 sm:h-14 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
                    <TrendingUp className="w-6 h-6 sm:w-7 sm:h-7" />
                  </div>
                </div>
              </div>

              {/* Traffic Chart + Recent Batches */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 sm:gap-6">
                <div className="lg:col-span-2 bg-white p-4 sm:p-6 rounded-2xl shadow-sm border border-slate-200 min-w-0">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-6">
                    <div>
                      <h3 className="font-bold text-slate-800">حركة الترافيك الحية على راوترات MikroTik</h3>
                      <p className="text-xs text-slate-500">معدل السحب (Download / Upload بالميجابت/ثانية)</p>
                    </div>
                    <span className="text-xs font-bold bg-indigo-50 text-indigo-700 px-3 py-1 rounded-lg">
                      تحديث تلقائي من radacct
                    </span>
                  </div>

                  <div className="overflow-x-auto pb-2">
                    <div className="grid grid-cols-6 gap-3 sm:gap-4 items-end h-52 pt-6 px-2 sm:px-4 border-b border-slate-200 min-w-[320px]">
                      {kpis.trafficHistory.map((pt: any) => (
                        <div key={pt.time} className="flex flex-col items-center gap-2 h-full justify-end">
                          <div className="w-full flex items-end justify-center gap-1 sm:gap-1.5 h-40">
                            <div
                              style={{ height: `${Math.min(100, (pt.downloadMbps / 140) * 100)}%` }}
                              className="w-3.5 sm:w-5 bg-indigo-600 rounded-t-md transition-all"
                              title={`Download: ${pt.downloadMbps} Mbps`}
                            />
                            <div
                              style={{ height: `${Math.min(100, (pt.uploadMbps / 140) * 100)}%` }}
                              className="w-3.5 sm:w-5 bg-amber-400 rounded-t-md transition-all"
                              title={`Upload: ${pt.uploadMbps} Mbps`}
                            />
                          </div>
                          <span className="text-[11px] sm:text-xs font-mono text-slate-500">{pt.time}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 sm:gap-6 mt-4 text-xs text-slate-600">
                    <span className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded bg-indigo-600 inline-block" /> التحميل (Download Mbps)
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded bg-amber-400 inline-block" /> الرفع (Upload Mbps)
                    </span>
                  </div>
                </div>

                {/* Recent Voucher Batches */}
                <div className="bg-white p-4 sm:p-6 rounded-2xl shadow-sm border border-slate-200 flex flex-col justify-between min-w-0">
                  <div>
                    <h3 className="font-bold text-slate-800 mb-4">أحدث دفعات الكروت المولّدة</h3>
                    <div className="space-y-3">
                      {kpis.recentBatches.map((b: any) => (
                        <div
                          key={b.id}
                          className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/80 flex flex-wrap items-center justify-between gap-2"
                        >
                          <div className="min-w-0">
                            <div className="font-mono font-bold text-xs text-indigo-700">{b.batch_code}</div>
                            <div className="text-xs font-semibold text-slate-800 mt-0.5">
                              {b.profile_display_name} ({b.quantity} كرت)
                            </div>
                            <div className="text-[11px] text-slate-500">{b.reseller_name}</div>
                          </div>
                          <button
                            onClick={() => handleLoadBatchPrint(b.id)}
                            className="inline-flex items-center gap-1 bg-white hover:bg-indigo-50 text-indigo-700 border border-indigo-200 text-xs font-bold px-3 py-1.5 rounded-lg transition shrink-0"
                          >
                            <Printer className="w-3.5 h-3.5" />
                            طباعة
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  <button
                    onClick={() => setActiveTab('vouchers')}
                    className="mt-4 w-full bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold py-3 rounded-xl transition"
                  >
                    + توليد دفعة كروت جديدة الآن
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ================================================================= */}
          {/* TAB 2: BATCH VOUCHER GENERATOR & A4 40-CARD PRINTER               */}
          {/* ================================================================= */}
          {activeTab === 'vouchers' && (
            <div className="space-y-6">
              <div className="print:hidden grid grid-cols-1 lg:grid-cols-3 gap-5 sm:gap-6">
                {/* Batch Form */}
                <form
                  onSubmit={handleGenerateBatch}
                  className="lg:col-span-2 bg-white p-4 sm:p-6 rounded-2xl shadow-sm border border-slate-200 space-y-4 min-w-0"
                >
                  <h3 className="font-bold text-slate-800 flex items-center gap-2 border-b pb-3">
                    <Sparkles className="w-5 h-5 text-indigo-600" />
                    توليد دفعة كروت جديدة (إدراج فوري في `radcheck` و `radusergroup`)
                  </h3>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1">الباقة (Profile)</label>
                      <select
                        value={genForm.profileId}
                        onChange={(e) => setGenForm({ ...genForm, profileId: Number(e.target.value) })}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"
                      >
                        {profiles.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.display_name} ({p.speed_limit}) - التكلفة: {p.cost_price} ر.س | البيع: {p.price} ر.س
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1">عدد الكروت (Quantity)</label>
                      <input
                        type="number"
                        min={1}
                        max={2000}
                        value={genForm.quantity}
                        onChange={(e) => setGenForm({ ...genForm, quantity: Number(e.target.value) })}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1">نمط الكرت</label>
                      <select
                        value={genForm.voucherType}
                        onChange={(e) => setGenForm({ ...genForm, voucherType: e.target.value as any })}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"
                      >
                        <option value="PIN_ONLY">كود موحد (Username = Password)</option>
                        <option value="USER_PASS">اسم مستخدم + كلمة مرور منفصلة</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1">بادئة الكرت (Prefix)</label>
                      <input
                        type="text"
                        maxLength={5}
                        value={genForm.prefix}
                        onChange={(e) => setGenForm({ ...genForm, prefix: e.target.value })}
                        placeholder="مثال: 77 أو VIP"
                        className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1">طول الكود (Code Length)</label>
                      <input
                        type="number"
                        min={6}
                        max={14}
                        value={genForm.codeLength}
                        onChange={(e) => setGenForm({ ...genForm, codeLength: Number(e.target.value) })}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1">نوع الأحرف (Charset)</label>
                      <select
                        value={genForm.charsetType}
                        onChange={(e) => setGenForm({ ...genForm, charsetType: e.target.value as any })}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"
                      >
                        <option value="NUMERIC">أرقام فقط (0-9)</option>
                        <option value="ALPHANUMERIC_UPPER">أحرف كبيرة وأرقام (بدون 0/O المتشابهة)</option>
                        <option value="ALPHANUMERIC_MIXED">أحرف كبيرة وصغيرة وأرقام</option>
                      </select>
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-xl shadow transition"
                  >
                    توليد الدفعة الآن وتجهيز صفحة الطباعة A4
                  </button>
                </form>

                {/* Print Branding Customizer */}
                <div className="bg-white p-4 sm:p-6 rounded-2xl shadow-sm border border-slate-200 space-y-4 min-w-0">
                  <h3 className="font-bold text-slate-800 flex items-center gap-2 border-b pb-3">
                    <QrCode className="w-5 h-5 text-indigo-600" />
                    إعدادات قالب الطباعة (A4 Sheet)
                  </h3>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">اسم الشبكة على الكرت</label>
                    <input
                      type="text"
                      value={brandSettings.networkName}
                      onChange={(e) => setBrandSettings({ ...brandSettings, networkName: e.target.value })}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">رابط الهوت سبوت (للدخول بـ QR)</label>
                    <input
                      type="text"
                      dir="ltr"
                      value={brandSettings.hotspotUrl}
                      onChange={(e) => setBrandSettings({ ...brandSettings, hotspotUrl: e.target.value })}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">رقم خدمة العملاء</label>
                    <input
                      type="text"
                      value={brandSettings.supportPhone}
                      onChange={(e) => setBrandSettings({ ...brandSettings, supportPhone: e.target.value })}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">تقسيم الصفحة A4</label>
                    <select
                      value={brandSettings.cardsPerPage}
                      onChange={(e) =>
                        setBrandSettings({ ...brandSettings, cardsPerPage: Number(e.target.value) as 40 | 30 })
                      }
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                    >
                      <option value={40}>40 كرت في صفحة A4 (4 أعمدة × 10 صفوف)</option>
                      <option value={30}>30 كرت في صفحة A4 (3 أعمدة × 10 صفوف)</option>
                    </select>
                  </div>

                  <label className="flex items-center gap-2 pt-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={brandSettings.showQr}
                      onChange={(e) => setBrandSettings({ ...brandSettings, showQr: e.target.checked })}
                      className="w-4 h-4 text-indigo-600 rounded"
                    />
                    <span className="text-xs font-bold text-slate-700">تضمين رمز QR للدخول الفوري</span>
                  </label>

                  {printableBatch && (
                    <button
                      type="button"
                      onClick={() => window.print()}
                      className="w-full inline-flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-3 rounded-xl shadow transition"
                    >
                      <Printer className="w-5 h-5" />
                      طباعة الورقة الآن ({printableBatch.cards.length} كرت)
                    </button>
                  )}
                </div>
              </div>

              {/* Saved Batches List */}
              <div className="print:hidden bg-white p-4 sm:p-6 rounded-2xl shadow-sm border border-slate-200">
                <h3 className="font-bold text-slate-800 mb-4">سجل الدفعات المولّدة (انقر على أي دفعة لمعاينتها وطباعتها)</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-right text-sm whitespace-nowrap">
                    <thead>
                      <tr className="bg-slate-50 text-slate-600 text-xs border-b">
                        <th className="py-3 px-4">كود الدفعة</th>
                        <th className="py-3 px-4">الباقة</th>
                        <th className="py-3 px-4">الكمية</th>
                        <th className="py-3 px-4">الموزع</th>
                        <th className="py-3 px-4">التكلفة</th>
                        <th className="py-3 px-4">تاريخ الإنشاء</th>
                        <th className="py-3 px-4 text-center">معاينة الكروت</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {batches.map((b) => (
                        <tr key={b.id} className="hover:bg-slate-50">
                          <td className="py-3 px-4 font-mono font-bold text-indigo-700">{b.batch_code}</td>
                          <td className="py-3 px-4 font-semibold">{b.profile_display_name}</td>
                          <td className="py-3 px-4">{b.quantity} كرت</td>
                          <td className="py-3 px-4">{b.reseller_name}</td>
                          <td className="py-3 px-4 font-bold text-emerald-700">{b.total_cost} ر.س</td>
                          <td className="py-3 px-4 text-xs text-slate-500">
                            {new Date(b.created_at).toLocaleString('ar-SA')}
                          </td>
                          <td className="py-3 px-4 text-center">
                            <button
                              onClick={() => handleLoadBatchPrint(b.id)}
                              className="inline-flex items-center gap-1.5 bg-indigo-50 hover:bg-indigo-600 hover:text-white text-indigo-700 font-bold text-xs px-3 py-1.5 rounded-lg transition"
                            >
                              <Printer className="w-3.5 h-3.5" />
                              عرض وطباعة الكروت
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* A4 Printable Sheet Preview */}
              {printableBatch && (
                <div id="a4-print-area" className="mx-auto max-w-[210mm]">
                  <div className="print:hidden mb-3 flex flex-wrap items-center justify-between gap-3 bg-indigo-900 text-white px-4 py-3 rounded-xl">
                    <span className="text-xs sm:text-sm font-bold">
                      معاينة طباعة الدفعة: {printableBatch.batch.batch_code} ({printableBatch.cards.length} كرت -{' '}
                      {printableBatch.batch.profile_display_name})
                    </span>
                    <button
                      onClick={() => window.print()}
                      className="inline-flex items-center gap-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold text-xs px-4 py-2 rounded-lg shrink-0"
                    >
                      <Printer className="w-4 h-4" />
                      اطبع الآن (A4)
                    </button>
                  </div>

                  {printablePages.map((pageCards, pageIdx) => (
                    <div
                      key={pageIdx}
                      className="a4-page-break bg-white p-3 mb-6 print:mb-0 print:p-0 rounded-xl border border-slate-300 print:border-none shadow-sm"
                    >
                      <div
                        className={`grid ${
                          brandSettings.cardsPerPage === 40
                            ? 'grid-cols-1 sm:grid-cols-2 md:grid-cols-4 print:grid-cols-4'
                            : 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 print:grid-cols-3'
                        } gap-1.5`}
                      >
                        {pageCards.map((card: any) => {
                          const qrUrl = `${brandSettings.hotspotUrl}?username=${encodeURIComponent(
                            card.username
                          )}&password=${encodeURIComponent(card.cleartextPassword)}`;
                          return (
                            <div
                              key={card.serialNumber}
                              className="border border-dashed border-slate-400 rounded p-1.5 flex flex-col justify-between bg-white text-[10px] leading-tight min-h-[26.8mm] md:h-[26.8mm] print:h-[26.8mm] overflow-hidden"
                            >
                              <div className="flex items-center justify-between border-b border-slate-200 pb-0.5">
                                <span className="font-bold text-slate-900 truncate max-w-[68%]">
                                  {brandSettings.networkName}
                                </span>
                                <span className="bg-slate-900 text-white font-bold px-1.5 py-0.2 rounded text-[9px]">
                                  {printableBatch.batch.price} ر.س
                                </span>
                              </div>

                              <div className="flex items-center justify-between gap-1 my-auto py-0.5">
                                <div className="flex-1">
                                  <div className="text-[8.5px] text-slate-500 truncate">
                                    {printableBatch.batch.profile_display_name} ({printableBatch.batch.speed_limit})
                                  </div>
                                  {printableBatch.batch.voucher_type === 'PIN_ONLY' ? (
                                    <div className="font-mono font-extrabold text-[12.5px] tracking-wider text-slate-950 bg-slate-100 px-1 py-0.5 rounded text-center border border-slate-300 mt-0.5">
                                      {card.username}
                                    </div>
                                  ) : (
                                    <div className="font-mono text-[9.5px] space-y-0.5 mt-0.5">
                                      <div>
                                        المستخدم: <strong>{card.username}</strong>
                                      </div>
                                      <div>
                                        المرور: <strong>{card.cleartextPassword}</strong>
                                      </div>
                                    </div>
                                  )}
                                </div>

                                {brandSettings.showQr && (
                                  <img
                                    src={`https://api.qrserver.com/v1/create-qr-code/?size=64x64&margin=0&data=${encodeURIComponent(
                                      qrUrl
                                    )}`}
                                    alt="QR"
                                    className="w-10 h-10 shrink-0 border border-slate-200 rounded p-0.5"
                                  />
                                )}
                              </div>

                              <div className="flex items-center justify-between text-[8px] text-slate-500 border-t border-slate-100 pt-0.5">
                                <span className="font-mono">{card.serialNumber}</span>
                                <span>دعم: {brandSettings.supportPhone}</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ================================================================= */}
          {/* TAB 3: PROFILES & BANDWIDTH MANAGEMENT (`radgroupreply`)          */}
          {/* ================================================================= */}
          {activeTab === 'profiles' && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 sm:gap-6">
              {/* Create Profile Form */}
              <form
                onSubmit={handleCreateProfile}
                className="bg-white p-4 sm:p-6 rounded-2xl shadow-sm border border-slate-200 space-y-4 h-fit min-w-0"
              >
                <h3 className="font-bold text-slate-800 flex items-center gap-2 border-b pb-3">
                  {editingProfileId !== null ? (
                    <>
                      <Pencil className="w-5 h-5 text-amber-600" />
                      تعديل الباقة ({newProfile.displayName || newProfile.name})
                    </>
                  ) : (
                    <>
                      <Plus className="w-5 h-5 text-indigo-600" />
                      إضافة باقة جديدة (تزامن مع `radgroupreply`)
                    </>
                  )}
                </h3>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    الاسم البرمجي في FreeRADIUS (`groupname`)
                  </label>
                  <input
                    type="text"
                    required
                    dir="ltr"
                    placeholder="plan_6m_month"
                    value={newProfile.name}
                    onChange={(e) => setNewProfile({ ...newProfile, name: e.target.value })}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">اسم الباقة بالعربية (للكروت)</label>
                  <input
                    type="text"
                    required
                    placeholder="باقة 6 ميجا - شهرية"
                    value={newProfile.displayName}
                    onChange={(e) => setNewProfile({ ...newProfile, displayName: e.target.value })}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">سعر البيع (ر.س)</label>
                    <input
                      type="number"
                      step="0.5"
                      value={newProfile.price}
                      onChange={(e) => setNewProfile({ ...newProfile, price: Number(e.target.value) })}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">سعر التكلفة للموزع</label>
                    <input
                      type="number"
                      step="0.5"
                      value={newProfile.costPrice}
                      onChange={(e) => setNewProfile({ ...newProfile, costPrice: Number(e.target.value) })}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    سرعة الميكروتك (Mikrotik-Rate-Limit) — اختياري
                  </label>
                  <input
                    type="text"
                    dir="ltr"
                    placeholder="مثال: 6M/6M"
                    value={newProfile.speedLimit}
                    onChange={(e) => setNewProfile({ ...newProfile, speedLimit: e.target.value })}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-mono"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">
                    اختياري — اتركه فارغاً للتحكم بالسرعة من Queues في المايكروتك
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">وقت الاستخدام الفعلي (ساعات)</label>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={newProfile.timeLimitHours}
                      onChange={(e) => setNewProfile({ ...newProfile, timeLimitHours: Number(e.target.value) })}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                    />
                    <p className="text-[11px] text-slate-500 mt-1">
                      يقبل 0 لوقت استخدام مفتوح ومعتمد على الصلاحية والبيانات فقط
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">الكوتا الإجمالية بالميجابايت (MB)</label>
                    <input
                      type="number"
                      min={0}
                      value={newProfile.dataLimitMb}
                      onChange={(e) => setNewProfile({ ...newProfile, dataLimitMb: Number(e.target.value) })}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                    />
                    <p className="text-[11px] text-slate-500 mt-1">
                      مثال: 10240 لـ 10GB أو 20480 لـ 20GB
                    </p>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    صلاحية الكارت من أول استخدام (أيام)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={newProfile.validityDays}
                    onChange={(e) => setNewProfile({ ...newProfile, validityDays: Number(e.target.value) })}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">
                    القيمة الافتراضية 30 يوماً — يقبل 0 لبدون انتهاء صلاحية
                  </p>
                </div>

                <button
                  type="submit"
                  className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2.5 rounded-xl transition"
                >
                  {editingProfileId !== null ? 'حفظ التعديلات ومزامنة FreeRADIUS' : 'حفظ الباقة ومزامنة FreeRADIUS'}
                </button>
                {editingProfileId !== null && (
                  <button
                    type="button"
                    onClick={cancelEditProfile}
                    className="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-2 rounded-xl transition"
                  >
                    إلغاء التعديل
                  </button>
                )}
              </form>

              {/* Profiles List with Synchronized RADIUS Attributes */}
              <div className="lg:col-span-2 space-y-4">
                {profiles.map((p) => {
                  const quotaText = p.data_limit_mb && Number(p.data_limit_mb) > 0
                    ? (Number(p.data_limit_mb) >= 1024
                        ? `${Number((Number(p.data_limit_mb) / 1024).toFixed(1))} GB (${p.data_limit_mb} MB)`
                        : `${p.data_limit_mb} MB`)
                    : 'غير محدود';
                  const uptimeText = p.time_limit && Number(p.time_limit) > 0
                    ? `${Number((Number(p.time_limit) / 3600).toFixed(1))} ساعة`
                    : 'مفتوح (غير محدود)';
                  const validityText = p.validity_days && Number(p.validity_days) > 0
                    ? `${p.validity_days} يوم`
                    : 'بدون انتهاء صلاحية';

                  return (
                  <div
                    key={p.id}
                    className="bg-white p-4 sm:p-6 rounded-2xl shadow-sm border border-slate-200 flex flex-col gap-4 min-w-0"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="font-extrabold text-base sm:text-lg text-slate-900">{p.display_name}</h4>
                          <span className="font-mono text-xs bg-indigo-50 text-indigo-700 px-2.5 py-0.5 rounded-md border border-indigo-200">
                            {p.name}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 mt-1">
                          سعر البيع: <strong>{p.price} ر.س</strong> | تكلفة الموزع:{' '}
                          <strong>{p.cost_price} ر.س</strong> | السرعة:{' '}
                          <strong className={p.speed_limit ? 'font-mono' : ''}>
                            {p.speed_limit || 'من المايكروتك (Queues)'}
                          </strong>
                        </p>
                      </div>

                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => startEditProfile(p)}
                          className="text-amber-600 hover:bg-amber-50 p-2 rounded-lg transition"
                          title="تعديل الباقة"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDeleteProfile(p.id)}
                          className="text-red-500 hover:bg-red-50 p-2 rounded-lg transition"
                          title="حذف الباقة"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                      <div className="bg-indigo-50/70 border border-indigo-200 rounded-xl px-3 py-2">
                        <div className="text-[11px] font-bold text-indigo-700">الكوتا الإجمالية</div>
                        <div className="font-mono text-xs font-extrabold text-indigo-950 mt-0.5" dir="ltr">{quotaText}</div>
                      </div>
                      <div className="bg-emerald-50/70 border border-emerald-200 rounded-xl px-3 py-2">
                        <div className="text-[11px] font-bold text-emerald-700">وقت الاستخدام الفعلي</div>
                        <div className="text-xs font-extrabold text-emerald-950 mt-0.5">{uptimeText}</div>
                      </div>
                      <div className="bg-amber-50/70 border border-amber-200 rounded-xl px-3 py-2">
                        <div className="text-[11px] font-bold text-amber-700">الصلاحية التقويمية</div>
                        <div className="text-xs font-extrabold text-amber-950 mt-0.5">{validityText}</div>
                      </div>
                    </div>

                    {/* Synced radgroupreply & radgroupcheck badges */}
                    <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200/80 space-y-2">
                      <div className="text-[11px] font-bold text-slate-500">
                        الخصائص المتزامنة في جدولَي `radgroupreply` و `radgroupcheck`:
                      </div>
                      <div className="flex flex-wrap gap-2" dir="ltr">
                        {p.radgroupreply?.map((r: any) => (
                          <span
                            key={r.id}
                            className="font-mono text-xs bg-white border border-slate-300 text-slate-800 px-2.5 py-1 rounded-lg break-all max-w-full"
                          >
                            <strong className="text-indigo-600">{r.attribute}</strong> {r.op} {r.value}
                          </span>
                        ))}
                        {p.radgroupcheck?.map((c: any) => (
                          <span
                            key={c.id}
                            className="font-mono text-xs bg-amber-50 border border-amber-200 text-amber-900 px-2.5 py-1 rounded-lg break-all max-w-full"
                          >
                            <strong>{c.attribute}</strong> {c.op} {c.value}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ================================================================= */}
          {/* TAB 4: LIVE ACTIVE SESSIONS & COA/POD DISCONNECT                  */}
          {/* ================================================================= */}
          {activeTab === 'sessions' && (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 sm:p-6 space-y-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b pb-5">
                <div>
                  <h3 className="text-base sm:text-lg font-extrabold text-slate-800 flex flex-wrap items-center gap-2">
                    <Wifi className="w-5 h-5 text-emerald-600 shrink-0" />
                    الجلسات النشطة الحية في `radacct` ({sessions.length} متصل)
                  </h3>
                  <p className="text-xs text-slate-500 mt-1">
                    انقر على زر <strong>فصل (Kick CoA)</strong> لإرسال حزمة PoD عبر `radclient` (منفذ UDP 3799) لقطع اتصال المشترك فوراً.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
                  <div className="relative w-full sm:w-auto">
                    <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5" />
                    <input
                      type="text"
                      placeholder="بحث بالكرت أو IP أو MAC..."
                      value={sessionSearch}
                      onChange={(e) => setSessionSearch(e.target.value)}
                      className="pr-9 pl-4 py-2 rounded-xl border border-slate-300 text-xs w-full sm:w-60"
                    />
                  </div>

                  <button
                    onClick={handleSimulateSession}
                    className="w-full sm:w-auto justify-center inline-flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold px-4 py-2 rounded-xl transition"
                  >
                    <Play className="w-3.5 h-3.5" />
                    محاكاة دخول مشترك جديد
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-right text-sm whitespace-nowrap">
                  <thead>
                    <tr className="bg-slate-50 text-slate-600 text-xs border-b">
                      <th className="py-3.5 px-4">اسم المستخدم / الكرت</th>
                      <th className="py-3.5 px-4">عنوان IP (`framedipaddress`)</th>
                      <th className="py-3.5 px-4">الماك (`callingstationid`)</th>
                      <th className="py-3.5 px-4">راوتر NAS</th>
                      <th className="py-3.5 px-4">مدة الجلسة</th>
                      <th className="py-3.5 px-4">الرفع (Upload)</th>
                      <th className="py-3.5 px-4">التحميل (Download)</th>
                      <th className="py-3.5 px-4 text-center">إجراء الفصل الفوري</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {sessions.map((s) => (
                      <tr key={s.radacctid} className="hover:bg-slate-50">
                        <td className="py-3.5 px-4 font-mono font-bold text-indigo-700">{s.username}</td>
                        <td className="py-3.5 px-4 font-mono text-xs" dir="ltr">
                          {s.framedipaddress}
                        </td>
                        <td className="py-3.5 px-4 font-mono text-xs text-slate-600" dir="ltr">
                          {s.callingstationid}
                        </td>
                        <td className="py-3.5 px-4 font-mono text-xs text-slate-500" dir="ltr">
                          {s.nasipaddress}
                        </td>
                        <td className="py-3.5 px-4">
                          <span className="inline-flex items-center gap-1 font-mono text-xs bg-slate-100 px-2.5 py-1 rounded-md">
                            <Clock className="w-3.5 h-3.5 text-slate-500" />
                            {formatUptime(s.acctsessiontime)}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 font-mono text-xs text-amber-700" dir="ltr">
                          <span className="inline-flex items-center gap-1">
                            <ArrowUpCircle className="w-3.5 h-3.5 text-amber-500" />
                            {formatBytes(s.acctinputoctets)}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 font-mono text-xs text-emerald-700" dir="ltr">
                          <span className="inline-flex items-center gap-1">
                            <ArrowDownCircle className="w-3.5 h-3.5 text-emerald-500" />
                            {formatBytes(s.acctoutputoctets)}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-center">
                          <button
                            onClick={() => handleDisconnectSession(s.radacctid, s.username)}
                            className="inline-flex items-center gap-1.5 bg-red-50 hover:bg-red-600 hover:text-white text-red-600 border border-red-200 font-bold text-xs px-3 py-1.5 rounded-lg transition"
                          >
                            <PowerOff className="w-3.5 h-3.5" />
                            فصل (Kick CoA)
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ================================================================= */}
          {/* TAB 5: RESELLERS & SUB-ACCOUNTS PORTAL (RBAC)                     */}
          {/* ================================================================= */}
          {activeTab === 'resellers' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 sm:gap-6">
                {/* Add Reseller Form (Super Admin Only) */}
                <form
                  onSubmit={handleCreateReseller}
                  className="bg-white p-4 sm:p-6 rounded-2xl shadow-sm border border-slate-200 space-y-4 h-fit min-w-0"
                >
                  <h3 className="font-bold text-slate-800 flex items-center gap-2 border-b pb-3">
                    <Users className="w-5 h-5 text-indigo-600" />
                    إضافة موزع / نقطة بيع جديدة
                  </h3>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">اسم الموزع / المتجر</label>
                    <input
                      type="text"
                      required
                      placeholder="مثال: كافيه الأندلس"
                      value={newReseller.name}
                      onChange={(e) => setNewReseller({ ...newReseller, name: e.target.value })}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">اسم الدخول (Username)</label>
                    <input
                      type="text"
                      required
                      dir="ltr"
                      placeholder="andalus_pos"
                      value={newReseller.username}
                      onChange={(e) => setNewReseller({ ...newReseller, username: e.target.value })}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">رقم الجوال</label>
                    <input
                      type="text"
                      value={newReseller.phone}
                      onChange={(e) => setNewReseller({ ...newReseller, phone: e.target.value })}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1">الرصيد الافتتاحي</label>
                      <input
                        type="number"
                        value={newReseller.balance}
                        onChange={(e) => setNewReseller({ ...newReseller, balance: Number(e.target.value) })}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1">الحد الائتماني</label>
                      <input
                        type="number"
                        value={newReseller.credit_limit}
                        onChange={(e) => setNewReseller({ ...newReseller, credit_limit: Number(e.target.value) })}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2.5 rounded-xl transition"
                  >
                    إنشاء حساب الموزع
                  </button>
                </form>

                {/* Resellers List & Top-Up */}
                <div className="lg:col-span-2 bg-white p-4 sm:p-6 rounded-2xl shadow-sm border border-slate-200 space-y-4 min-w-0">
                  <h3 className="font-bold text-slate-800">قائمة الموزعين والأرصدة الائتمانية</h3>
                  <div className="space-y-3">
                    {resellersData.resellers.map((r) => (
                      <div
                        key={r.id}
                        className="p-4 rounded-xl bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-4"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-bold text-slate-900">{r.name}</span>
                            <span className="text-xs font-mono bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded">
                              @{r.username}
                            </span>
                            <span className="text-[11px] font-bold bg-slate-200 text-slate-700 px-2 py-0.5 rounded">
                              {r.role}
                            </span>
                          </div>
                          <div className="text-xs text-slate-500 mt-1">
                            الرصيد الحالي:{' '}
                            <strong className="text-emerald-700 text-sm">{r.balance} ر.س</strong> | الحد الائتماني المسموح:{' '}
                            <strong>{r.credit_limit} ر.س</strong> | جوال: {r.phone || '-'}
                          </div>
                        </div>

                        {currentActor?.role === 'SUPER_ADMIN' && (
                          <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                            <input
                              type="number"
                              placeholder="200"
                              value={topupAmount[r.id] ?? 200}
                              onChange={(e) =>
                                setTopupAmount({ ...topupAmount, [r.id]: Number(e.target.value) })
                              }
                              className="w-24 flex-1 sm:flex-none rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                            />
                            <button
                              onClick={() => handleTopupReseller(r.id)}
                              className="inline-flex items-center justify-center gap-1 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold px-3 py-1.5 rounded-lg transition"
                            >
                              <Wallet className="w-3.5 h-3.5" />
                              شحن رصيد
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Financial Transactions Ledger */}
                  <div className="pt-4 border-t">
                    <h4 className="font-bold text-sm text-slate-700 mb-3">
                      السجل المالي للعمليات (`reseller_transactions`)
                    </h4>
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {resellersData.transactions.map((t) => (
                        <div
                          key={t.id}
                          className="text-xs flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-lg bg-slate-50 border border-slate-200/70"
                        >
                          <div>
                            <span
                              className={`font-bold px-2 py-0.5 rounded ml-2 ${
                                t.type === 'DEPOSIT'
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : 'bg-amber-100 text-amber-800'
                              }`}
                            >
                              {t.type === 'DEPOSIT' ? 'إيداع' : 'خصم دفعة'}
                            </span>
                            <span className="font-semibold text-slate-800">{t.description}</span>
                          </div>
                          <div className="font-mono text-slate-600">
                            المبلغ: <strong>{t.amount} ر.س</strong> (الرصيد بعد: {t.balance_after} ر.س)
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ================================================================= */}
          {/* TAB 6: FREERADIUS SQL TABLES INSPECTOR & NAS ROUTERS              */}
          {/* ================================================================= */}
          {activeTab === 'radius_db' && inspectorData && (
            <div className="space-y-6">
              {/* NAS Routers Table */}
              <div className="bg-white p-4 sm:p-6 rounded-2xl shadow-sm border border-slate-200 min-w-0">
                <h3 className="font-bold text-slate-800 flex items-center gap-2 mb-4">
                  <ShieldCheck className="w-5 h-5 text-indigo-600" />
                  راوترات الميكروتك المعرّفة في جدول `nas` (FreeRADIUS Clients)
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-right text-sm whitespace-nowrap">
                    <thead>
                      <tr className="bg-slate-50 text-slate-600 text-xs border-b">
                        <th className="py-3 px-4">ID</th>
                        <th className="py-3 px-4">IP الراوتر (`nasname`)</th>
                        <th className="py-3 px-4">الاسم المختصر (`shortname`)</th>
                        <th className="py-3 px-4">RADIUS Secret</th>
                        <th className="py-3 px-4">الوصف</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {inspectorData.nas.map((n: any) => (
                        <tr key={n.id}>
                          <td className="py-3 px-4 font-mono">{n.id}</td>
                          <td className="py-3 px-4 font-mono font-bold text-indigo-700" dir="ltr">
                            {n.nasname}
                          </td>
                          <td className="py-3 px-4 font-mono" dir="ltr">
                            {n.shortname}
                          </td>
                          <td className="py-3 px-4 font-mono text-xs text-emerald-700" dir="ltr">
                            {n.secret}
                          </td>
                          <td className="py-3 px-4 text-xs text-slate-600">{n.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Raw radcheck & radusergroup Live View */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 sm:gap-6">
                <div className="bg-white p-4 sm:p-6 rounded-2xl shadow-sm border border-slate-200 min-w-0">
                  <h4 className="font-bold text-slate-800 mb-3">
                    أحدث السجلات في جدول `radcheck` (المصادقة)
                  </h4>
                  <div className="overflow-x-auto max-h-80">
                    <table className="w-full text-left font-mono text-xs whitespace-nowrap" dir="ltr">
                      <thead>
                        <tr className="bg-slate-50 border-b text-slate-600">
                          <th className="py-2 px-3">username</th>
                          <th className="py-2 px-3">attribute</th>
                          <th className="py-2 px-3">op</th>
                          <th className="py-2 px-3">value</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {inspectorData.radcheckSample.map((r: any) => (
                          <tr key={r.id}>
                            <td className="py-2 px-3 font-bold text-indigo-700">{r.username}</td>
                            <td className="py-2 px-3">{r.attribute}</td>
                            <td className="py-2 px-3">{r.op}</td>
                            <td className="py-2 px-3 text-emerald-700">{r.value}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="bg-white p-4 sm:p-6 rounded-2xl shadow-sm border border-slate-200 min-w-0">
                  <h4 className="font-bold text-slate-800 mb-3">
                    أحدث السجلات في جدول `radusergroup` (ربط الكروت بالباقات)
                  </h4>
                  <div className="overflow-x-auto max-h-80">
                    <table className="w-full text-left font-mono text-xs whitespace-nowrap" dir="ltr">
                      <thead>
                        <tr className="bg-slate-50 border-b text-slate-600">
                          <th className="py-2 px-3">username</th>
                          <th className="py-2 px-3">groupname</th>
                          <th className="py-2 px-3">priority</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {inspectorData.radusergroupSample.map((ug: any) => (
                          <tr key={ug.id}>
                            <td className="py-2 px-3 font-bold text-indigo-700">{ug.username}</td>
                            <td className="py-2 px-3 text-amber-800">{ug.groupname}</td>
                            <td className="py-2 px-3">{ug.priority}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
