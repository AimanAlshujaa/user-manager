import React, { useState } from 'react';
import {
  Printer,
  Sparkles,
  QrCode,
  Layers,
  Hash,
  Type,
  ShieldCheck,
  AlertCircle,
} from 'lucide-react';

export interface VoucherCardItem {
  username: string;
  cleartextPassword: string;
  serialNumber: string;
}

export interface ProfileOption {
  id: number;
  name: string;
  display_name: string;
  price: number;
  cost_price: number;
  speed_limit: string;
  validity_days?: number;
}

interface Props {
  profiles: ProfileOption[];
  apiBaseUrl?: string;
  authToken?: string;
}

export const BatchVoucherGenerator: React.FC<Props> = ({
  profiles,
  apiBaseUrl = '/api',
  authToken = '',
}) => {
  // Generation Form State
  const [profileId, setProfileId] = useState<number>(profiles[0]?.id || 1);
  const [quantity, setQuantity] = useState<number>(40);
  const [voucherType, setVoucherType] = useState<'PIN_ONLY' | 'USER_PASS'>('PIN_ONLY');
  const [prefix, setPrefix] = useState<string>('');
  const [codeLength, setCodeLength] = useState<number>(8);
  const [charsetType, setCharsetType] = useState<'NUMERIC' | 'ALPHANUMERIC_UPPER' | 'ALPHANUMERIC_MIXED'>('NUMERIC');

  // Print Customization State (40 Cards per A4 Sheet: 4 cols x 10 rows)
  const [networkBrandName, setNetworkBrandName] = useState<string>('شبكة النور هوت سبوت');
  const [hotspotDnsUrl, setHotspotDnsUrl] = useState<string>('http://wifi.lan/login');
  const [supportPhone, setSupportPhone] = useState<string>('0500000000');
  const [showQrCode, setShowQrCode] = useState<boolean>(true);
  const [cardsPerPage, setCardsPerPage] = useState<40 | 30>(40);

  // Result State
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [batchCode, setBatchCode] = useState<string>('');
  const [cards, setCards] = useState<VoucherCardItem[]>([]);

  const selectedProfile = profiles.find((p) => p.id === Number(profileId));

  const handleGenerateBatch = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/vouchers/batches`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          profileId: Number(profileId),
          quantity: Number(quantity),
          voucherType,
          prefix,
          codeLength: Number(codeLength),
          charsetType,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || 'فشل توليد دفعة الكروت');
      }

      setBatchCode(data.batchCode);
      setCards(data.cards);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Chunk cards into A4 pages (e.g., 40 cards per page = 4 columns x 10 rows)
  const pages: VoucherCardItem[][] = [];
  for (let i = 0; i < cards.length; i += cardsPerPage) {
    pages.push(cards.slice(i, i + cardsPerPage));
  }

  return (
    <div dir="rtl" className="min-h-screen bg-slate-50 text-slate-900 p-6 font-sans">
      {/* Print-specific CSS rules to render exact A4 40-card sheets cleanly */}
      <style>{`
        @media print {
          @page {
            size: A4 portrait;
            margin: 5mm;
          }
          body * {
            visibility: hidden;
          }
          #printable-voucher-sheets,
          #printable-voucher-sheets * {
            visibility: visible;
          }
          #printable-voucher-sheets {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
          }
          .a4-page-break {
            page-break-after: always;
            break-after: page;
          }
        }
      `}</style>

      {/* Non-Print Control Panel */}
      <div className="print:hidden max-w-7xl mx-auto space-y-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
          <div>
            <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
              <Sparkles className="w-6 h-6 text-indigo-600" />
              مولّد كروت الهوت سبوت والطباعة الفورية (Batch Voucher Generator)
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              توليد دفعات الكروت وإضافتها مباشرة إلى قاعدة بيانات FreeRADIUS (`radcheck` & `radusergroup`) مع قالب طباعة A4 قياسي.
            </p>
          </div>
          {cards.length > 0 && (
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold px-6 py-3 rounded-xl shadow transition"
            >
              <Printer className="w-5 h-5" />
              طباعة الدفعة ({cards.length} كرت - A4)
            </button>
          )}
        </div>

        {error && (
          <div className="flex items-center gap-3 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form
          onSubmit={handleGenerateBatch}
          className="grid grid-cols-1 lg:grid-cols-3 gap-6"
        >
          {/* Column 1 & 2: Batch Generation Parameters */}
          <div className="lg:col-span-2 bg-white p-6 rounded-2xl shadow-sm border border-slate-200 space-y-5">
            <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2 border-b pb-3">
              <Layers className="w-5 h-5 text-indigo-600" />
              إعدادات الدفعة والباقة (FreeRADIUS Profile)
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  الباقة / السرعة (Profile)
                </label>
                <select
                  value={profileId}
                  onChange={(e) => setProfileId(Number(e.target.value))}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                >
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.display_name} ({p.speed_limit}) - السعر: {p.price}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  عدد الكروت المطلوبة (Quantity)
                </label>
                <input
                  type="number"
                  min={1}
                  max={10000}
                  value={quantity}
                  onChange={(e) => setQuantity(Number(e.target.value))}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  نوع الكرت (Auth Mode)
                </label>
                <select
                  value={voucherType}
                  onChange={(e) => setVoucherType(e.target.value as 'PIN_ONLY' | 'USER_PASS')}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                >
                  <option value="PIN_ONLY">رمز دخول موحد (Username = Password)</option>
                  <option value="USER_PASS">اسم مستخدم + كلمة مرور منفصلة</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  بادئة الكرت الاختيارية (Prefix)
                </label>
                <input
                  type="text"
                  maxLength={6}
                  placeholder="مثال: VIP أو 77"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1 flex items-center gap-1">
                  <Hash className="w-4 h-4 text-slate-400" />
                  طول الكود الكلي (Code Length)
                </label>
                <input
                  type="number"
                  min={6}
                  max={16}
                  value={codeLength}
                  onChange={(e) => setCodeLength(Number(e.target.value))}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1 flex items-center gap-1">
                  <Type className="w-4 h-4 text-slate-400" />
                  تركيبة الأحرف والأرقام (Charset)
                </label>
                <select
                  value={charsetType}
                  onChange={(e) => setCharsetType(e.target.value as any)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                >
                  <option value="NUMERIC">أرقام فقط (0-9) - أسهل للإدخال</option>
                  <option value="ALPHANUMERIC_UPPER">أحرف كبيرة وأرقام (بدون أحرف متشابهة 0/O)</option>
                  <option value="ALPHANUMERIC_MIXED">أحرف كبيرة وصغيرة وأرقام</option>
                </select>
              </div>
            </div>

            {selectedProfile && (
              <div className="bg-indigo-50/70 border border-indigo-100 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4 text-sm">
                <div className="flex items-center gap-2 text-indigo-900 font-medium">
                  <ShieldCheck className="w-5 h-5 text-indigo-600" />
                  <span>
                    الباقة المختارة: <strong>{selectedProfile.display_name}</strong> ({selectedProfile.speed_limit})
                  </span>
                </div>
                <div className="text-indigo-800">
                  التكلفة الإجمالية للدفعة:{' '}
                  <strong className="text-lg">
                    {(selectedProfile.cost_price * quantity).toFixed(2)}
                  </strong>
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white font-bold py-3 px-6 rounded-xl shadow transition"
            >
              {loading ? 'جاري التوليد والحفظ في FreeRADIUS...' : 'توليد الدفعة وتجهيز الطباعة'}
            </button>
          </div>

          {/* Column 3: Printable Card Branding & QR Options */}
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 space-y-4">
            <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2 border-b pb-3">
              <QrCode className="w-5 h-5 text-indigo-600" />
              تخصيص تصميم الكرت المطبوع
            </h2>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                اسم الشبكة على الكرت
              </label>
              <input
                type="text"
                value={networkBrandName}
                onChange={(e) => setNetworkBrandName(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                رابط صفحة الدخول (لرمز QR التلقائي)
              </label>
              <input
                type="text"
                dir="ltr"
                value={hotspotDnsUrl}
                onChange={(e) => setHotspotDnsUrl(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-left"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                رقم الدعم الفني
              </label>
              <input
                type="text"
                value={supportPhone}
                onChange={(e) => setSupportPhone(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                عدد الكروت في الورقة (A4)
              </label>
              <select
                value={cardsPerPage}
                onChange={(e) => setCardsPerPage(Number(e.target.value) as 40 | 30)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              >
                <option value={40}>40 كرت في صفحة A4 (4 أعمدة × 10 صفوف)</option>
                <option value={30}>30 كرت في صفحة A4 (3 أعمدة × 10 صفوف)</option>
              </select>
            </div>

            <label className="flex items-center gap-2 pt-2 cursor-pointer">
              <input
                type="checkbox"
                checked={showQrCode}
                onChange={(e) => setShowQrCode(e.target.checked)}
                className="w-4 h-4 text-indigo-600 rounded"
              />
              <span className="text-sm font-medium text-slate-700">
                إظهار رمز QR للدخول التلقائي السريع
              </span>
            </label>
          </div>
        </form>
      </div>

      {/* Printable A4 Sheets (40 Cards per A4 Page: 4 columns x 10 rows) */}
      {pages.length > 0 && (
        <div id="printable-voucher-sheets" className="mt-8 mx-auto max-w-[210mm]">
          {pages.map((pageCards, pageIndex) => (
            <div
              key={pageIndex}
              className="a4-page-break bg-white p-2 mb-8 print:mb-0 print:p-0 border border-slate-200 print:border-none"
            >
              <div
                className={`grid ${
                  cardsPerPage === 40 ? 'grid-cols-4' : 'grid-cols-3'
                } gap-1.5`}
              >
                {pageCards.map((card, idx) => {
                  const autoLoginUrl = `${hotspotDnsUrl}?username=${encodeURIComponent(
                    card.username
                  )}&password=${encodeURIComponent(card.cleartextPassword)}`;

                  return (
                    <div
                      key={card.serialNumber || idx}
                      className="border border-dashed border-slate-400 rounded-md p-1.5 flex flex-col justify-between bg-white text-[10px] leading-tight h-[26.8mm] overflow-hidden"
                    >
                      {/* Top Header: Brand & Price */}
                      <div className="flex items-center justify-between border-b border-slate-200 pb-0.5">
                        <span className="font-bold text-slate-900 truncate max-w-[70%]">
                          {networkBrandName}
                        </span>
                        <span className="bg-slate-900 text-white font-bold px-1.5 py-0.2 rounded text-[9px]">
                          {selectedProfile ? `${selectedProfile.price} ر.س` : ''}
                        </span>
                      </div>

                      {/* Middle Body: Credentials + Optional QR */}
                      <div className="flex items-center justify-between gap-1 my-auto py-0.5">
                        <div className="flex-1 space-y-0.5">
                          <div className="text-[9px] text-slate-500">
                            {selectedProfile?.display_name}
                          </div>
                          {voucherType === 'PIN_ONLY' ? (
                            <div className="font-mono font-extrabold text-[13px] tracking-wider text-slate-950 bg-slate-100 px-1.5 py-0.5 rounded text-center border border-slate-300">
                              {card.username}
                            </div>
                          ) : (
                            <div className="font-mono text-[10px] space-y-0.5">
                              <div>
                                <span className="text-slate-500">المستخدم: </span>
                                <strong className="text-slate-950">{card.username}</strong>
                              </div>
                              <div>
                                <span className="text-slate-500">المرور: </span>
                                <strong className="text-slate-950">
                                  {card.cleartextPassword}
                                </strong>
                              </div>
                            </div>
                          )}
                        </div>

                        {showQrCode && (
                          <img
                            src={`https://api.qrserver.com/v1/create-qr-code/?size=70x70&margin=0&data=${encodeURIComponent(
                              autoLoginUrl
                            )}`}
                            alt="QR Auto Login"
                            className="w-11 h-11 shrink-0 border border-slate-200 rounded p-0.5"
                          />
                        )}
                      </div>

                      {/* Footer: Serial Number & Support */}
                      <div className="flex items-center justify-between text-[8px] text-slate-500 border-t border-slate-100 pt-0.5">
                        <span className="font-mono">{card.serialNumber || batchCode}</span>
                        <span>دعم: {supportPhone}</span>
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
  );
};

export default BatchVoucherGenerator;
