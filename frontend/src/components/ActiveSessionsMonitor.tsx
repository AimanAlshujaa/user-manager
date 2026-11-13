import React, { useEffect, useState, useCallback } from 'react';
import {
  Wifi,
  PowerOff,
  RefreshCw,
  Search,
  ArrowDownCircle,
  ArrowUpCircle,
  Clock,
  ShieldAlert,
  CheckCircle2,
} from 'lucide-react';

export interface ActiveSession {
  radacctid: number;
  acctsessionid: string;
  username: string;
  nasipaddress: string;
  acctstarttime: string;
  acctsessiontime: number;
  acctinputoctets: number;
  acctoutputoctets: number;
  callingstationid: string; // Client MAC
  framedipaddress: string; // Client IP
}

interface Props {
  apiBaseUrl?: string;
  authToken?: string;
  pollIntervalMs?: number;
}

/**
 * Formats byte counts into human-readable KB / MB / GB
 */
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

/**
 * Formats seconds into HH:MM:SS
 */
function formatUptime(seconds: number): string {
  const s = Math.max(0, Number(seconds) || 0);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  return [hrs, mins, secs].map((v) => String(v).padStart(2, '0')).join(':');
}

export const ActiveSessionsMonitor: React.FC<Props> = ({
  apiBaseUrl = '/api',
  authToken = '',
  pollIntervalMs = 10000,
}) => {
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [search, setSearch] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [kickingId, setKickingId] = useState<number | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );

  const fetchActiveSessions = useCallback(async () => {
    setLoading(true);
    try {
      const url = `${apiBaseUrl}/sessions/active?search=${encodeURIComponent(search)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await res.json();
      if (res.ok && Array.isArray(data.sessions)) {
        setSessions(data.sessions);
      }
    } catch {
      // Keep existing table data during transient network hiccups
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, authToken, search]);

  useEffect(() => {
    fetchActiveSessions();
    const timer = setInterval(fetchActiveSessions, pollIntervalMs);
    return () => clearInterval(timer);
  }, [fetchActiveSessions, pollIntervalMs]);

  const handleDisconnect = async (session: ActiveSession) => {
    const confirmed = window.confirm(
      `هل أنت متأكد من فصل جلسة المشترك (${session.username}) على IP (${session.framedipaddress}) فوراً؟`
    );
    if (!confirmed) return;

    setKickingId(session.radacctid);
    setToast(null);

    try {
      const res = await fetch(
        `${apiBaseUrl}/sessions/${session.radacctid}/disconnect`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}` },
        }
      );
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || 'تعذر إرسال حزمة CoA/PoD للراوتر');
      }

      // Remove disconnected user from state immediately
      setSessions((prev) => prev.filter((s) => s.radacctid !== session.radacctid));
      setToast({
        type: 'success',
        text: `تم فصل المشترك ${session.username} بنجاح عبر (${data.method})`,
      });
    } catch (err: any) {
      setToast({
        type: 'error',
        text: err.message,
      });
    } finally {
      setKickingId(null);
    }
  };

  return (
    <div dir="rtl" className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 font-sans">
      {/* Header & Search Controls */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-slate-200">
        <div>
          <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <Wifi className="w-6 h-6 text-emerald-600 animate-pulse" />
            المتصلون الآن مباشر (Live Active Sessions)
            <span className="bg-emerald-100 text-emerald-800 text-sm font-bold px-3 py-0.5 rounded-full">
              {sessions.length} متصل
            </span>
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            مراقبة حية من جدول `radacct` مع إمكانية قطع الاتصال الفوري عبر حزم CoA/PoD (UDP 3799).
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute right-3 top-3" />
            <input
              type="text"
              placeholder="بحث بالكود أو IP أو MAC..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pr-9 pl-4 py-2 rounded-xl border border-slate-300 text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none w-64"
            />
          </div>

          <button
            type="button"
            onClick={fetchActiveSessions}
            disabled={loading}
            className="inline-flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium px-4 py-2 rounded-xl transition"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            تحديث
          </button>
        </div>
      </div>

      {/* Feedback Banner */}
      {toast && (
        <div
          className={`mt-4 flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-medium ${
            toast.type === 'success'
              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
              : 'bg-red-50 text-red-800 border border-red-200'
          }`}
        >
          {toast.type === 'success' ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
          ) : (
            <ShieldAlert className="w-5 h-5 text-red-600 shrink-0" />
          )}
          <span>{toast.text}</span>
        </div>
      )}

      {/* Sessions Table */}
      <div className="mt-6 overflow-x-auto">
        <table className="w-full text-right border-collapse">
          <thead>
            <tr className="bg-slate-50 text-slate-600 text-xs uppercase border-b border-slate-200">
              <th className="py-3.5 px-4 font-bold">المستخدم / الكرت</th>
              <th className="py-3.5 px-4 font-bold">عنوان IP</th>
              <th className="py-3.5 px-4 font-bold">عنوان MAC (`callingstationid`)</th>
              <th className="py-3.5 px-4 font-bold">راوتر MikroTik (NAS)</th>
              <th className="py-3.5 px-4 font-bold">مدة الاتصال</th>
              <th className="py-3.5 px-4 font-bold">الرفع (Upload)</th>
              <th className="py-3.5 px-4 font-bold">التحميل (Download)</th>
              <th className="py-3.5 px-4 font-bold text-center">إجراء</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 text-sm">
            {sessions.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-12 text-center text-slate-400">
                  لا توجد جلسات نشطة مطابقة حالياً في `radacct`.
                </td>
              </tr>
            ) : (
              sessions.map((session) => (
                <tr
                  key={session.radacctid}
                  className="hover:bg-slate-50/80 transition"
                >
                  <td className="py-3.5 px-4 font-mono font-bold text-indigo-700">
                    {session.username}
                  </td>
                  <td className="py-3.5 px-4 font-mono text-slate-700" dir="ltr">
                    {session.framedipaddress || '-'}
                  </td>
                  <td className="py-3.5 px-4 font-mono text-xs text-slate-600" dir="ltr">
                    {session.callingstationid || '-'}
                  </td>
                  <td className="py-3.5 px-4 font-mono text-xs text-slate-500" dir="ltr">
                    {session.nasipaddress}
                  </td>
                  <td className="py-3.5 px-4">
                    <span className="inline-flex items-center gap-1 font-mono text-xs bg-slate-100 text-slate-800 px-2.5 py-1 rounded-md">
                      <Clock className="w-3.5 h-3.5 text-slate-500" />
                      {formatUptime(session.acctsessiontime)}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 font-mono text-xs text-amber-700" dir="ltr">
                    <span className="inline-flex items-center gap-1">
                      <ArrowUpCircle className="w-3.5 h-3.5 text-amber-500" />
                      {formatBytes(session.acctinputoctets)}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 font-mono text-xs text-emerald-700" dir="ltr">
                    <span className="inline-flex items-center gap-1">
                      <ArrowDownCircle className="w-3.5 h-3.5 text-emerald-500" />
                      {formatBytes(session.acctoutputoctets)}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 text-center">
                    <button
                      type="button"
                      disabled={kickingId === session.radacctid}
                      onClick={() => handleDisconnect(session)}
                      className="inline-flex items-center gap-1.5 bg-red-50 hover:bg-red-600 hover:text-white text-red-600 border border-red-200 font-semibold text-xs px-3 py-1.5 rounded-lg transition disabled:opacity-50"
                    >
                      <PowerOff className="w-3.5 h-3.5" />
                      {kickingId === session.radacctid ? 'جاري الفصل...' : 'فصل (Kick)'}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default ActiveSessionsMonitor;
