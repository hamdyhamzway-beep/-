import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Bell,
  Bus,
  Check,
  Clock,
  Compass,
  Home,
  LogOut,
  MapPin,
  Navigation,
  PauseCircle,
  Phone,
  PlayCircle,
  RefreshCw,
  ShieldAlert,
  UserCheck,
  Wallet,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch, formatEGP, formatRelativeArabicTime } from '../../lib/api';
import { DriverAvatar } from '../DriverAvatar';
import { PWAInstallButton } from '../PWAInstall';
import type {
  AdvanceRecord,
  CoverageRecord,
  EnrichedDriver,
  FinancialTransaction,
  NotificationItem,
  SalaryRecord,
} from '../../types';

interface DriverAppResponse {
  linked: boolean;
  period?: { month: number; year: number };
  driver: EnrichedDriver | null;
  salary?: SalaryRecord;
  advances?: AdvanceRecord[];
  coverages?: CoverageRecord[];
  transactions?: FinancialTransaction[];
  notifications?: NotificationItem[];
  gps?: {
    vehicleGpsStatus: string;
    latestGps: {
      id: number;
      lat: number;
      lng: number;
      speedKmh: number;
      accuracyMeters: number | null;
      recordedAt: string;
      isLive: boolean;
    } | null;
  };
}

type DriverTab = 'home' | 'finance' | 'location' | 'notifications';

const ARABIC_MONTHS = [
  'يناير',
  'فبراير',
  'مارس',
  'أبريل',
  'مايو',
  'يونيو',
  'يوليو',
  'أغسطس',
  'سبتمبر',
  'أكتوبر',
  'نوفمبر',
  'ديسمبر',
];

export const DriverApp: React.FC<{ allowDriverSelector?: boolean }> = ({
  allowDriverSelector = false,
}) => {
  const { dbUser, logout } = useAuth();
  const now = new Date();
  const [activeTab, setActiveTab] = useState<DriverTab>('home');
  const [month, setMonth] = useState<number>(now.getMonth() + 1);
  const [year, setYear] = useState<number>(now.getFullYear());

  const [allDrivers, setAllDrivers] = useState<EnrichedDriver[]>([]);
  const [selectedDriverId, setSelectedDriverId] = useState<string>('');
  const [data, setData] = useState<DriverAppResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Live GPS transmission state
  const [gpsConsent, setGpsConsent] = useState<boolean>(() => {
    try {
      return localStorage.getItem('alwaleed_gps_consent') === 'true';
    } catch {
      return false;
    }
  });
  const [isStreamingGps, setIsStreamingGps] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [gpsSending, setGpsSending] = useState(false);
  const [lastLocalPingAt, setLastLocalPingAt] = useState<string | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const lastSentMsRef = useRef<number>(0);

  // Load driver selector list if super_admin is previewing
  useEffect(() => {
    if (!allowDriverSelector) return;
    apiFetch<{ drivers: EnrichedDriver[] }>('/api/drivers')
      .then((res) => {
        setAllDrivers(res.drivers);
        if (res.drivers.length > 0 && !selectedDriverId) {
          setSelectedDriverId(String(res.drivers[0].id));
        }
      })
      .catch(() => {
        // ignore if unavailable
      });
  }, [allowDriverSelector, selectedDriverId]);

  const loadDriverData = useCallback(async () => {
    if (allowDriverSelector && !selectedDriverId && allDrivers.length === 0) {
      // Wait for initial driver list load if admin selector is active
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        month: String(month),
        year: String(year),
      });
      if (allowDriverSelector && selectedDriverId) {
        params.set('asDriverId', selectedDriverId);
      }
      const res = await apiFetch<DriverAppResponse>(`/api/driver-app/me?${params.toString()}`);
      setData(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل بيانات السائق');
    } finally {
      setLoading(false);
    }
  }, [month, year, allowDriverSelector, selectedDriverId, allDrivers.length]);

  useEffect(() => {
    loadDriverData();
  }, [loadDriverData]);

  const stopGpsWatch = useCallback(() => {
    if (watchIdRef.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setIsStreamingGps(false);
  }, []);

  const sendGpsCoordinates = useCallback(
    async (lat: number, lng: number, speedKmh: number, accuracyMeters: number) => {
      if (!data?.driver?.vehicleId) return;
      setGpsSending(true);
      try {
        await apiFetch('/api/gps/update', {
          method: 'POST',
          body: JSON.stringify({
            vehicleId: data.driver.vehicleId,
            lat,
            lng,
            speedKmh: Math.max(0, Math.round(speedKmh)),
            accuracyMeters: Math.round(accuracyMeters),
          }),
        });
        lastSentMsRef.current = Date.now();
        setLastLocalPingAt(new Date().toISOString());
        setGpsError(null);
        await loadDriverData();
      } catch (err: unknown) {
        setGpsError(err instanceof Error ? err.message : 'تعذر إرسال الإحداثيات إلى الخادم');
      } finally {
        setGpsSending(false);
      }
    },
    [data?.driver?.vehicleId, loadDriverData]
  );

  // Manage real navigator.geolocation.watchPosition when driver enables consent and isn't paused
  useEffect(() => {
    const isPaused = data?.gps?.vehicleGpsStatus === 'paused';
    const hasVehicle = Boolean(data?.linked && data?.driver?.vehicleId);

    if (!gpsConsent || isPaused || !hasVehicle || allowDriverSelector) {
      stopGpsWatch();
      return;
    }

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsError('متصفح هذا الجهاز لا يدعم خدمة تحديد الموقع GPS.');
      return;
    }

    setGpsError(null);
    setIsStreamingGps(true);

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const nowMs = Date.now();
        // Throttle server writes to once every 10 seconds
        if (nowMs - lastSentMsRef.current < 10000) return;
        const speedKmh = pos.coords.speed ? pos.coords.speed * 3.6 : 0;
        sendGpsCoordinates(
          pos.coords.latitude,
          pos.coords.longitude,
          speedKmh,
          pos.coords.accuracy || 10
        );
      },
      (geoErr) => {
        setIsStreamingGps(false);
        if (geoErr.code === geoErr.PERMISSION_DENIED) {
          setGpsError('تم رفض إذن الوصول للموقع من المتصفح. يرجى تفعيل الموقع من إعدادات المتصفح.');
        } else if (geoErr.code === geoErr.POSITION_UNAVAILABLE) {
          setGpsError('تعذر تحديد الموقع الحالي، تأكد من تشغيل GPS في الجهاز.');
        } else {
          setGpsError('انتهت مهلة تحديد الموقع. حاول التحقق من الإشارة.');
        }
      },
      {
        enableHighAccuracy: true,
        maximumAge: 10000,
        timeout: 15000,
      }
    );

    return () => {
      stopGpsWatch();
    };
  }, [
    gpsConsent,
    data?.gps?.vehicleGpsStatus,
    data?.linked,
    data?.driver?.vehicleId,
    allowDriverSelector,
    sendGpsCoordinates,
    stopGpsWatch,
  ]);

  const handleToggleConsent = async () => {
    const next = !gpsConsent;
    setGpsConsent(next);
    try {
      localStorage.setItem('alwaleed_gps_consent', String(next));
    } catch {
      // ignore storage errors
    }
    if (!next) {
      stopGpsWatch();
    } else if (data?.gps?.vehicleGpsStatus === 'paused') {
      await handleTogglePause(false);
    }
  };

  const handleManualPing = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsError('الجهاز لا يدعم خدمة GPS.');
      return;
    }
    setGpsSending(true);
    setGpsError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const speedKmh = pos.coords.speed ? pos.coords.speed * 3.6 : 0;
        sendGpsCoordinates(
          pos.coords.latitude,
          pos.coords.longitude,
          speedKmh,
          pos.coords.accuracy || 10
        );
      },
      (err) => {
        setGpsSending(false);
        setGpsError(
          err.code === err.PERMISSION_DENIED
            ? 'يرجى السماح بالوصول للموقع الجغرافي من إعدادات المتصفح.'
            : 'تعذر قراءة الموقع الجغرافي الحالي.'
        );
      },
      { enableHighAccuracy: true, timeout: 12000 }
    );
  };

  const handleTogglePause = async (paused: boolean) => {
    if (!data?.driver) return;
    setError(null);
    try {
      await apiFetch('/api/driver-app/gps-pause', {
        method: 'POST',
        body: JSON.stringify({
          paused,
          driverId: allowDriverSelector ? data.driver.id : undefined,
        }),
      });
      if (paused) stopGpsWatch();
      await loadDriverData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحديث حالة الموقع');
    }
  };

  const handleMarkNotificationRead = async (id: number) => {
    try {
      await apiFetch(`/api/notifications/${id}/read`, { method: 'PATCH' });
      await loadDriverData();
    } catch {
      // ignore
    }
  };

  const unreadCount = (data?.notifications || []).filter((n) => !n.isRead).length;
  const driver = data?.driver;
  const salary = data?.salary;
  const latestGps = data?.gps?.latestGps;
  const vehicleGpsStatus = data?.gps?.vehicleGpsStatus || 'offline';
  const isLiveSharing = vehicleGpsStatus !== 'paused' && Boolean(latestGps?.isLive);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Sticky Top Header (h-14, compact mobile thumb-friendly shell) */}
      <header className="sticky top-0 z-30 h-14 bg-[#0B1F3A] text-white border-b border-slate-800 px-4">
        <div className="max-w-3xl mx-auto h-full flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            {driver ? (
              <DriverAvatar
                name={driver.fullName}
                photoUrl={driver.photoUrl}
                size="sm"
                variant="dark"
              />
            ) : (
              <div className="w-8 h-8 rounded-lg bg-[#C89B3C] text-[#0B1F3A] flex items-center justify-center shrink-0">
                <Bus className="w-4 h-4" />
              </div>
            )}
            <div className="min-w-0">
              <div className="font-display text-sm font-bold truncate">
                {driver ? driver.fullName : 'تطبيق السائق · الوليد ترافيل'}
              </div>
              {driver && (
                <div className="text-[11px] text-slate-300 font-mono truncate">
                  كود: {driver.driverCode} · باص {driver.busNumber}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {allowDriverSelector && allDrivers.length > 0 && (
              <select
                value={selectedDriverId}
                onChange={(e) => setSelectedDriverId(e.target.value)}
                aria-label="اختيار سائق للمعاينة"
                className="rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#C89B3C]"
              >
                {allDrivers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.fullName} ({d.driverCode})
                  </option>
                ))}
              </select>
            )}

            {!allowDriverSelector && <PWAInstallButton variant="dark" />}

            {!allowDriverSelector && (
              <button
                onClick={logout}
                title="تسجيل الخروج"
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-200 transition-colors cursor-pointer"
              >
                <LogOut className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Scrollable Content */}
      <main className="flex-1 w-full max-w-3xl mx-auto px-4 pt-4 pb-24 space-y-4">
        {allowDriverSelector && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900 flex items-center justify-between gap-3">
            <span>وضع معاينة تطبيق السائق (حساب المدير العام)</span>
            <span className="font-semibold">عرض مطابق تماماً لشاشة السائق</span>
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading && !data ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-sm text-slate-500">
            جاري تحميل ملف السائق...
          </div>
        ) : !data?.linked || !driver ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 text-center space-y-4">
            <div className="w-12 h-12 rounded-2xl bg-amber-50 text-[#C89B3C] flex items-center justify-center mx-auto border border-amber-200">
              <UserCheck className="w-6 h-6" />
            </div>
            <h2 className="font-display text-lg font-bold text-[#0B1F3A]">
              الحساب غير مرتبط بملف سائق بعد
            </h2>
            <p className="text-sm text-slate-600 leading-relaxed max-w-md mx-auto">
              تم تسجيل دخولك بنجاح بالبريد{' '}
              <span className="font-mono font-semibold text-[#0B1F3A]">{dbUser?.email}</span>،
              ولكن لم يتم ربط هذا البريد بملف سائق في قاعدة البيانات حتى الآن.
            </p>
            <p className="text-xs text-slate-500 leading-relaxed max-w-md mx-auto">
              يرجى التواصل مع إدارة الوليد ترافيل لإضافة بريدك الإلكتروني في خانة «البريد الإلكتروني
              المرتبط بحساب السائق» داخل صفحة السائقين.
            </p>
            <div className="pt-2 flex items-center justify-center gap-3">
              <button
                onClick={loadDriverData}
                className="min-h-[44px] inline-flex items-center gap-2 rounded-xl bg-[#0B1F3A] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#13325c] cursor-pointer"
              >
                <RefreshCw className="w-4 h-4" />
                إعادة التحقق
              </button>
              {!allowDriverSelector && (
                <button
                  onClick={logout}
                  className="min-h-[44px] inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  تسجيل الخروج
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* TAB 1: HOME */}
            {activeTab === 'home' && (
              <div className="space-y-4">
                {/* Identity & Salary Summary Card */}
                <section className="rounded-2xl bg-[#0B1F3A] text-white p-5 space-y-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3.5 min-w-0">
                      <DriverAvatar
                        name={driver.fullName}
                        photoUrl={driver.photoUrl}
                        size="lg"
                        variant="dark"
                      />
                      <div className="min-w-0">
                        <p className="text-xs text-slate-300">ملف السائق الشخصي</p>
                        <h1 className="font-display text-xl font-bold mt-0.5 truncate">
                          {driver.fullName}
                        </h1>
                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-300">
                          <span className="font-mono">الكود: {driver.driverCode}</span>
                          <span className="flex items-center gap-1 font-mono" dir="ltr">
                            <Phone className="w-3.5 h-3.5 text-[#C89B3C]" />
                            {driver.phone}
                          </span>
                        </div>
                      </div>
                    </div>
                    <span className="rounded-lg bg-white/10 px-2.5 py-1 text-xs font-semibold text-[#C89B3C] shrink-0">
                      {driver.accountStatus === 'active' ? 'حساب نشط' : 'حساب موقوف'}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-3 pt-4 border-t border-white/10">
                    <div>
                      <p className="text-xs text-slate-300">الراتب المتفق عليه</p>
                      <p className="text-lg sm:text-xl font-bold tabular-nums mt-0.5">
                        {formatEGP(driver.monthlyAgreedSalary)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-300">
                        صافي المستحق ({ARABIC_MONTHS[month - 1]})
                      </p>
                      <p className="text-lg sm:text-xl font-bold text-[#C89B3C] tabular-nums mt-0.5">
                        {formatEGP(salary?.netSalary || 0)}
                      </p>
                    </div>
                  </div>
                </section>

                {/* Assignment & Route Details */}
                <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="font-display text-base font-bold text-[#0B1F3A]">
                      بيانات المدرسة والمركبة وخط السير
                    </h2>
                    <Bus className="w-5 h-5 text-[#C89B3C]" />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                    <div className="rounded-xl bg-slate-50 p-3.5">
                      <p className="text-xs text-slate-500">المدرسة المعينة</p>
                      <p className="font-semibold text-[#0B1F3A] mt-1">{driver.schoolName}</p>
                    </div>
                    <div className="rounded-xl bg-slate-50 p-3.5">
                      <p className="text-xs text-slate-500">رقم الباص واللوحة</p>
                      <p className="font-semibold text-[#0B1F3A] mt-1">
                        {driver.busNumber} ·{' '}
                        <span className="font-mono text-xs text-slate-600">
                          {driver.registrationNumber}
                        </span>
                      </p>
                    </div>
                    <div className="rounded-xl bg-slate-50 p-3.5 sm:col-span-2">
                      <p className="text-xs text-slate-500">خط السير والمواعيد</p>
                      <p className="font-semibold text-[#0B1F3A] mt-1">{driver.routeName}</p>
                      {(driver.pickupArea || driver.dropoffArea) && (
                        <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-slate-600">
                          <span className="flex items-center gap-1">
                            <Clock className="w-3.5 h-3.5 text-[#C89B3C]" />
                            التحرك: {driver.pickupArea || '—'} ({driver.pickupTime || '—'})
                          </span>
                          <span>
                            الوصول: {driver.dropoffArea || '—'} ({driver.dropoffTime || '—'})
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </section>

                {/* Location Status Quick Card */}
                <section className="bg-white border border-slate-200 rounded-2xl p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                          isLiveSharing
                            ? 'bg-emerald-50 text-emerald-700'
                            : vehicleGpsStatus === 'paused'
                            ? 'bg-amber-50 text-amber-700'
                            : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        <Compass className="w-5 h-5" />
                      </div>
                      <div>
                        <p className="text-sm font-bold text-[#0B1F3A]">
                          حالة مشاركة الموقع:{' '}
                          {isLiveSharing
                            ? 'بث مباشر نشط'
                            : vehicleGpsStatus === 'paused'
                            ? 'متوقف مؤقتاً'
                            : 'غير متصل'}
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {latestGps?.recordedAt
                            ? `آخر تحديث: ${formatRelativeArabicTime(latestGps.recordedAt)}`
                            : 'لم يتم إرسال موقع بعد'}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setActiveTab('location')}
                      className="min-h-[44px] rounded-xl bg-slate-100 hover:bg-slate-200 px-3.5 py-2 text-xs font-semibold text-[#0B1F3A] shrink-0 cursor-pointer"
                    >
                      إدارة الموقع
                    </button>
                  </div>
                </section>

                {/* Recent Notifications Preview */}
                <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <h2 className="font-display text-base font-bold text-[#0B1F3A]">
                      أحدث التنبيهات ({unreadCount} غير مقروء)
                    </h2>
                    <button
                      onClick={() => setActiveTab('notifications')}
                      className="text-xs font-semibold text-[#C89B3C] hover:underline cursor-pointer"
                    >
                      عرض الكل
                    </button>
                  </div>
                  {(data.notifications || []).slice(0, 2).length === 0 ? (
                    <p className="text-xs text-slate-500">لا توجد إشعارات جديدة حالياً.</p>
                  ) : (
                    <div className="space-y-2">
                      {(data.notifications || []).slice(0, 2).map((n) => (
                        <div
                          key={n.id}
                          className={`rounded-xl p-3 text-xs ${
                            n.isRead ? 'bg-slate-50 text-slate-600' : 'bg-amber-50 text-amber-950'
                          }`}
                        >
                          <p className="font-bold">{n.title}</p>
                          <p className="mt-0.5 leading-relaxed">{n.body}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}

            {/* TAB 2: FINANCE (STRICTLY READ-ONLY) */}
            {activeTab === 'finance' && (
              <div className="space-y-4">
                <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div>
                      <h1 className="font-display text-lg font-bold text-[#0B1F3A]">
                        كشف الحساب المالي الشهري
                      </h1>
                      <p className="text-xs text-slate-500 mt-0.5">
                        بيان مالي موثق للقراءة فقط — يتم تحديثه تلقائياً من إدارة الوليد ترافيل
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        value={month}
                        onChange={(e) => setMonth(Number(e.target.value))}
                        className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-800"
                      >
                        {ARABIC_MONTHS.map((mName, idx) => (
                          <option key={idx + 1} value={idx + 1}>
                            {mName}
                          </option>
                        ))}
                      </select>
                      <select
                        value={year}
                        onChange={(e) => setYear(Number(e.target.value))}
                        className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-800 font-mono"
                      >
                        {[2024, 2025, 2026, 2027].map((y) => (
                          <option key={y} value={y}>
                            {y}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Salary Formula Breakdown */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <div className="rounded-xl bg-slate-50 p-3.5">
                      <p className="text-xs text-slate-500">الراتب الأساسي</p>
                      <p className="text-base font-bold text-[#0B1F3A] tabular-nums mt-1">
                        {formatEGP(salary?.baseSalary || 0)}
                      </p>
                    </div>
                    <div className="rounded-xl bg-red-50/70 p-3.5">
                      <p className="text-xs text-red-700">إجمالي السلف (-)</p>
                      <p className="text-base font-bold text-red-700 tabular-nums mt-1">
                        {formatEGP(salary?.totalAdvances || 0)}
                      </p>
                    </div>
                    <div className="rounded-xl bg-red-50/70 p-3.5">
                      <p className="text-xs text-red-700">خصم تغطية الغياب (-)</p>
                      <p className="text-base font-bold text-red-700 tabular-nums mt-1">
                        {formatEGP(salary?.totalCoverageDeductions || 0)}
                      </p>
                    </div>
                    <div className="rounded-xl bg-slate-50 p-3.5">
                      <p className="text-xs text-slate-500">خصومات أخرى (-)</p>
                      <p className="text-base font-bold text-slate-800 tabular-nums mt-1">
                        {formatEGP(salary?.otherDeductions || 0)}
                      </p>
                    </div>
                    <div className="rounded-xl bg-emerald-50/80 p-3.5">
                      <p className="text-xs text-emerald-800">المكافآت (+)</p>
                      <p className="text-base font-bold text-emerald-700 tabular-nums mt-1">
                        {formatEGP(salary?.bonuses || 0)}
                      </p>
                    </div>
                    <div className="rounded-xl bg-[#0B1F3A] text-white p-3.5">
                      <p className="text-xs text-slate-300">صافي الراتب المستحق</p>
                      <p className="text-base font-bold text-[#C89B3C] tabular-nums mt-1">
                        {formatEGP(salary?.netSalary || 0)}
                      </p>
                    </div>
                  </div>
                </section>

                {/* Advances List */}
                <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
                  <h2 className="font-display text-base font-bold text-[#0B1F3A]">
                    السلف المسجلة هذا الشهر ({(data.advances || []).length})
                  </h2>
                  {(data.advances || []).length === 0 ? (
                    <p className="text-xs text-slate-500">لا توجد سلف مسجلة في هذا الشهر.</p>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {(data.advances || []).map((a) => (
                        <div key={a.id} className="py-3 flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-[#0B1F3A]">
                              {a.reason}{' '}
                              {a.isReversed && (
                                <span className="text-xs text-slate-400">(تم عكس القيد)</span>
                              )}
                            </p>
                            <p className="text-xs text-slate-500 font-mono mt-0.5">{a.date}</p>
                          </div>
                          <span
                            className={`text-sm font-bold tabular-nums ${
                              a.isReversed ? 'line-through text-slate-400' : 'text-red-700'
                            }`}
                          >
                            {formatEGP(a.amount)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                {/* Coverage Deductions List */}
                <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
                  <h2 className="font-display text-base font-bold text-[#0B1F3A]">
                    خصومات تغطية الغياب ({(data.coverages || []).length})
                  </h2>
                  {(data.coverages || []).length === 0 ? (
                    <p className="text-xs text-slate-500">لا توجد خصومات تغطية في هذا الشهر.</p>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {(data.coverages || []).map((c) => (
                        <div key={c.id} className="py-3 flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-[#0B1F3A]">
                              {c.reason}{' '}
                              {c.isReversed && (
                                <span className="text-xs text-slate-400">(تم عكس القيد)</span>
                              )}
                            </p>
                            <p className="text-xs text-slate-500 font-mono mt-0.5">{c.date}</p>
                          </div>
                          <span
                            className={`text-sm font-bold tabular-nums ${
                              c.isReversed ? 'line-through text-slate-400' : 'text-red-700'
                            }`}
                          >
                            {formatEGP(c.absentDriverDeduction)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                {/* Immutable Transaction History */}
                <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
                  <h2 className="font-display text-base font-bold text-[#0B1F3A]">
                    سجل الحركات المالية ({(data.transactions || []).length})
                  </h2>
                  {(data.transactions || []).length === 0 ? (
                    <p className="text-xs text-slate-500">لا توجد حركات مالية مسجلة لهذا الشهر.</p>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {(data.transactions || []).map((t) => (
                        <div key={t.id} className="py-3 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-[#0B1F3A] truncate">
                              {t.description}
                            </p>
                            <p className="text-xs text-slate-500 mt-0.5">
                              {new Date(t.createdAt).toLocaleString('ar-EG')}
                            </p>
                          </div>
                          <span
                            className={`text-sm font-bold tabular-nums shrink-0 ${
                              t.direction === 'credit' ? 'text-emerald-700' : 'text-red-700'
                            }`}
                          >
                            {t.direction === 'credit' ? '+' : '-'}
                            {formatEGP(t.amount)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}

            {/* TAB 3: LOCATION & PRIVACY */}
            {activeTab === 'location' && (
              <div className="space-y-4">
                <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h1 className="font-display text-lg font-bold text-[#0B1F3A]">
                        مشاركة الموقع الجغرافي (GPS)
                      </h1>
                      <p className="text-xs text-slate-500 mt-1">
                        الباص رقم {driver.busNumber} · {driver.schoolName}
                      </p>
                    </div>
                    <span
                      className={`rounded-lg px-2.5 py-1 text-xs font-bold shrink-0 ${
                        isLiveSharing
                          ? 'bg-emerald-50 text-emerald-700'
                          : vehicleGpsStatus === 'paused'
                          ? 'bg-amber-50 text-amber-800'
                          : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {isLiveSharing
                        ? 'بث مباشر نشط'
                        : vehicleGpsStatus === 'paused'
                        ? 'متوقف مؤقتاً'
                        : 'غير متصل (مخزن)'}
                    </span>
                  </div>

                  {gpsError && (
                    <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700 flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{gpsError}</span>
                    </div>
                  )}

                  {/* Controls */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {!allowDriverSelector && (
                      <button
                        onClick={handleToggleConsent}
                        className={`min-h-[48px] flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold transition-colors cursor-pointer ${
                          gpsConsent && isStreamingGps
                            ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                            : 'bg-[#0B1F3A] text-white hover:bg-[#13325c]'
                        }`}
                      >
                        <Navigation className="w-4 h-4" />
                        {gpsConsent
                          ? 'إيقاف البث التلقائي من هذا الجهاز'
                          : 'الموافقة وتفعيل البث المباشر'}
                      </button>
                    )}

                    <button
                      onClick={() => handleTogglePause(vehicleGpsStatus !== 'paused')}
                      className={`min-h-[48px] flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-bold transition-colors cursor-pointer ${
                        vehicleGpsStatus === 'paused'
                          ? 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                          : 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100'
                      }`}
                    >
                      {vehicleGpsStatus === 'paused' ? (
                        <>
                          <PlayCircle className="w-4 h-4" />
                          استئناف مشاركة الموقع
                        </>
                      ) : (
                        <>
                          <PauseCircle className="w-4 h-4" />
                          إيقاف مشاركة الموقع مؤقتاً
                        </>
                      )}
                    </button>

                    {!allowDriverSelector && (
                      <button
                        onClick={handleManualPing}
                        disabled={gpsSending || !driver.vehicleId}
                        className="sm:col-span-2 min-h-[44px] flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
                      >
                        <RefreshCw className={`w-4 h-4 ${gpsSending ? 'animate-spin' : ''}`} />
                        إرسال تحديث موقع فوري الآن
                      </button>
                    )}
                  </div>

                  {/* Last Known Telemetry */}
                  <div className="rounded-xl bg-slate-50 p-4 space-y-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">حالة البيانات المعروضة للإدارة:</span>
                      <span className="font-bold text-[#0B1F3A]">
                        {isLiveSharing
                          ? 'موقع حي ومباشر'
                          : vehicleGpsStatus === 'paused'
                          ? 'متوقف بناءً على طلب السائق'
                          : 'آخر موقع مسجل (بيانات مخزنة وليست حية)'}
                      </span>
                    </div>
                    {latestGps && (
                      <>
                        <div className="flex items-center justify-between">
                          <span className="text-slate-500">الإحداثيات:</span>
                          <span className="font-mono text-slate-800" dir="ltr">
                            {latestGps.lat.toFixed(5)}, {latestGps.lng.toFixed(5)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-slate-500">السرعة المسجلة:</span>
                          <span className="font-bold tabular-nums text-slate-800">
                            {isLiveSharing ? Math.round(latestGps.speedKmh) : 0} كم/س
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-slate-500">توقيت آخر تسجيل:</span>
                          <span className="text-slate-800">
                            {formatRelativeArabicTime(lastLocalPingAt || latestGps.recordedAt)}
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                </section>

                {/* Explicit Privacy Notice */}
                <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-2">
                  <div className="flex items-center gap-2 font-display text-sm font-bold text-[#0B1F3A]">
                    <ShieldAlert className="w-4 h-4 text-[#C89B3C]" />
                    <span>إشعار الخصوصية لمشاركة الموقع</span>
                  </div>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    يتم جمع موقع الباص الجغرافي والسرعة فقط أثناء فترة العمل وبموافقتك الصريحة
                    لضمان سلامة رحلات المدرسة ومتابعة خطوط السير في إدارة الوليد ترافيل. يمكنك
                    إيقاف مشاركة الموقع مؤقتاً أو إلغاء البث في أي وقت عبر الأزرار أعلاه، وعند
                    الإيقاف يظهر للإدارة فوراً أن البث متوقف مؤقتاً ولا يتم إرسال إحداثيات جديدة.
                  </p>
                </section>
              </div>
            )}

            {/* TAB 4: NOTIFICATIONS */}
            {activeTab === 'notifications' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h1 className="font-display text-lg font-bold text-[#0B1F3A]">
                    الإشعارات والتنبيهات ({(data.notifications || []).length})
                  </h1>
                  <button
                    onClick={loadDriverData}
                    className="min-h-[40px] flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    تحديث
                  </button>
                </div>

                {(data.notifications || []).length === 0 ? (
                  <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-sm text-slate-500">
                    لا توجد إشعارات مسجلة لحسابك حتى الآن.
                  </div>
                ) : (
                  (data.notifications || []).map((n) => (
                    <div
                      key={n.id}
                      className={`rounded-2xl border p-4 space-y-2 ${
                        n.isRead
                          ? 'border-slate-200 bg-white'
                          : 'border-amber-200 bg-amber-50/60'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <h3 className="text-sm font-bold text-[#0B1F3A]">{n.title}</h3>
                        {!n.isRead && (
                          <button
                            onClick={() => handleMarkNotificationRead(n.id)}
                            className="inline-flex items-center gap-1 rounded-lg bg-[#0B1F3A] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#13325c] shrink-0 cursor-pointer"
                          >
                            <Check className="w-3 h-3" />
                            تمت القراءة
                          </button>
                        )}
                      </div>
                      <p className="text-xs text-slate-700 leading-relaxed">{n.body}</p>
                      <p className="text-[11px] text-slate-400">
                        {formatRelativeArabicTime(n.createdAt)}
                      </p>
                    </div>
                  ))
                )}
              </div>
            )}
          </>
        )}
      </main>

      {/* Bottom Fixed Thumb-Zone Navigation Bar (h-16) */}
      <nav className="fixed bottom-0 inset-x-0 z-30 h-16 bg-white border-t border-slate-200">
        <div className="max-w-3xl mx-auto h-full grid grid-cols-4">
          <button
            onClick={() => setActiveTab('home')}
            className={`min-h-[44px] flex flex-col items-center justify-center gap-1 text-xs font-semibold transition-colors cursor-pointer ${
              activeTab === 'home' ? 'text-[#0B1F3A]' : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <Home className={`w-5 h-5 ${activeTab === 'home' ? 'text-[#C89B3C]' : ''}`} />
            <span>الرئيسية</span>
          </button>

          <button
            onClick={() => setActiveTab('finance')}
            className={`min-h-[44px] flex flex-col items-center justify-center gap-1 text-xs font-semibold transition-colors cursor-pointer ${
              activeTab === 'finance' ? 'text-[#0B1F3A]' : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <Wallet className={`w-5 h-5 ${activeTab === 'finance' ? 'text-[#C89B3C]' : ''}`} />
            <span>المالية</span>
          </button>

          <button
            onClick={() => setActiveTab('location')}
            className={`min-h-[44px] flex flex-col items-center justify-center gap-1 text-xs font-semibold transition-colors cursor-pointer ${
              activeTab === 'location' ? 'text-[#0B1F3A]' : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <MapPin className={`w-5 h-5 ${activeTab === 'location' ? 'text-[#C89B3C]' : ''}`} />
            <span>الموقع</span>
          </button>

          <button
            onClick={() => setActiveTab('notifications')}
            className={`relative min-h-[44px] flex flex-col items-center justify-center gap-1 text-xs font-semibold transition-colors cursor-pointer ${
              activeTab === 'notifications'
                ? 'text-[#0B1F3A]'
                : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <div className="relative">
              <Bell
                className={`w-5 h-5 ${activeTab === 'notifications' ? 'text-[#C89B3C]' : ''}`}
              />
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-2 min-w-[16px] h-4 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center px-1 tabular-nums">
                  {unreadCount}
                </span>
              )}
            </div>
            <span>الإشعارات</span>
          </button>
        </div>
      </nav>
    </div>
  );
};
