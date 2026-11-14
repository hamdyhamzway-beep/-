import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Bus,
  Calendar,
  Filter,
  RefreshCw,
  TrendingUp,
  UserCheck,
  UserX,
  Users,
  Wallet,
} from 'lucide-react';
import { apiFetch, formatEGP, formatRelativeArabicTime } from '../../lib/api';
import { DriverAvatar } from '../DriverAvatar';
import type { EnrichedDriver, FleetVehicle, NotificationItem, SchoolItem } from '../../types';

interface DashboardData {
  period: { month: number; year: number; date: string };
  kpis: {
    totalRegisteredDrivers: number;
    totalActiveVehicles: number;
    vehiclesOnline: number;
    vehiclesOffline: number;
    driversActive: number;
    driversAbsent: number;
    totalMonthlySalaries: number;
    totalAdvances: number;
    totalCoverageDeductions: number;
    totalOutstandingPayments: number;
    totalSchoolContracts: number;
    totalOwnerCosts: number;
    monthlyBusinessProfit: number;
  };
  drivers: EnrichedDriver[];
  fleet: FleetVehicle[];
  schools: SchoolItem[];
  recentNotifications: NotificationItem[];
}

export const AdminOverview: React.FC<{
  onNavigate: (tab: string) => void;
}> = ({ onNavigate }) => {
  const today = new Date().toISOString().slice(0, 10);
  const [schoolId, setSchoolId] = useState<string>('');
  const [driverId, setDriverId] = useState<string>('');
  const [vehicleId, setVehicleId] = useState<string>('');
  const [date, setDate] = useState<string>(today);
  const [status, setStatus] = useState<string>('');

  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (schoolId) params.set('schoolId', schoolId);
      if (driverId) params.set('driverId', driverId);
      if (vehicleId) params.set('vehicleId', vehicleId);
      if (date) params.set('date', date);
      if (status) params.set('status', status);
      const res = await apiFetch<DashboardData>(`/api/dashboard?${params.toString()}`);
      setData(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل لوحة التحكم');
    } finally {
      setLoading(false);
    }
  }, [schoolId, driverId, vehicleId, date, status]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  const resetFilters = () => {
    setSchoolId('');
    setDriverId('');
    setVehicleId('');
    setDate(today);
    setStatus('');
  };

  const kpis = data?.kpis;

  return (
    <div className="space-y-6">
      {/* Header & Quick Filter Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#0B1F3A]">
            لوحة القيادة التنفيذية
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            متابعة مباشرة للأسطول والمدارس والمرتبات وصافي ربح المكتب الشهري
          </p>
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          <button
            onClick={loadDashboard}
            className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer whitespace-nowrap"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            تحديث البيانات
          </button>
          <button
            onClick={() => onNavigate('voice')}
            className="rounded-lg bg-[#0B1F3A] px-4 py-2 text-xs font-semibold text-white hover:bg-[#13325c] cursor-pointer whitespace-nowrap"
          >
            أمر صوتي سريع
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
            <Filter className="w-4 h-4 text-[#C89B3C]" />
            <span>تصفية المؤشرات والتشغيل</span>
          </div>
          {(schoolId || driverId || vehicleId || status || date !== today) && (
            <button
              onClick={resetFilters}
              className="text-xs font-medium text-[#0B1F3A] hover:underline cursor-pointer"
            >
              إعادة تعيين الفلاتر
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <select
            value={schoolId}
            onChange={(e) => setSchoolId(e.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 focus:border-[#0B1F3A] focus:outline-none"
          >
            <option value="">كل المدارس</option>
            {data?.schools.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>

          <select
            value={driverId}
            onChange={(e) => setDriverId(e.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 focus:border-[#0B1F3A] focus:outline-none"
          >
            <option value="">كل السائقين</option>
            {data?.drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.fullName} ({d.driverCode})
              </option>
            ))}
          </select>

          <select
            value={vehicleId}
            onChange={(e) => setVehicleId(e.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 focus:border-[#0B1F3A] focus:outline-none"
          >
            <option value="">كل أرقام الباصات</option>
            {data?.fleet.map((v) => (
              <option key={v.id} value={v.id}>
                {v.busNumber} · {v.registrationNumber}
              </option>
            ))}
          </select>

          <div className="relative">
            <Calendar className="w-3.5 h-3.5 text-slate-400 absolute right-3 top-2.5 pointer-events-none" />
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 pr-8 pl-3 py-2 text-xs text-slate-800 tabular-nums focus:border-[#0B1F3A] focus:outline-none"
            />
          </div>

          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 focus:border-[#0B1F3A] focus:outline-none"
          >
            <option value="">كل حالات السائقين</option>
            <option value="active">سائقون نشطون</option>
            <option value="absent">غائبون / مغطى اليوم</option>
            <option value="inactive">غير نشط</option>
          </select>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Primary Financial & Profit Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[#0B1F3A] text-white rounded-xl p-5 border border-[#0B1F3A]">
          <div className="flex items-center justify-between text-xs text-slate-300">
            <span>صافي ربح المكتب الشهري</span>
            <TrendingUp className="w-4 h-4 text-[#C89B3C]" />
          </div>
          <div className="mt-2 font-mono text-2xl font-bold text-[#C89B3C] tabular-nums">
            {loading || !kpis ? '—' : formatEGP(kpis.monthlyBusinessProfit)}
          </div>
          <div className="mt-2 text-xs text-slate-300 tabular-nums">
            عقود المدارس {kpis ? formatEGP(kpis.totalSchoolContracts) : '—'} − تكلفة الملاك{' '}
            {kpis ? formatEGP(kpis.totalOwnerCosts) : '—'}
          </div>
        </div>

        <div className="bg-white rounded-xl p-5 border border-slate-200">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>إجمالي الرواتب الأساسية</span>
            <Wallet className="w-4 h-4 text-slate-400" />
          </div>
          <div className="mt-2 font-mono text-2xl font-bold text-[#0B1F3A] tabular-nums">
            {loading || !kpis ? '—' : formatEGP(kpis.totalMonthlySalaries)}
          </div>
          <div className="mt-2 text-xs text-slate-500 tabular-nums">
            صافي المستحق للدفع: {kpis ? formatEGP(kpis.totalOutstandingPayments) : '—'}
          </div>
        </div>

        <div className="bg-white rounded-xl p-5 border border-slate-200">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>إجمالي السلف الشهرية</span>
            <Wallet className="w-4 h-4 text-amber-600" />
          </div>
          <div className="mt-2 font-mono text-2xl font-bold text-slate-900 tabular-nums">
            {loading || !kpis ? '—' : formatEGP(kpis.totalAdvances)}
          </div>
          <div className="mt-2 text-xs text-slate-500 tabular-nums">
            خصومات التغطية: {kpis ? formatEGP(kpis.totalCoverageDeductions) : '—'}
          </div>
        </div>

        <div className="bg-white rounded-xl p-5 border border-slate-200">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>جاهزية الأسطول والسائقين</span>
            <Bus className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="mt-2 font-mono text-2xl font-bold text-slate-900 tabular-nums">
            {loading || !kpis
              ? '—'
              : `${kpis.vehiclesOnline} / ${kpis.totalActiveVehicles} متصل`}
          </div>
          <div className="mt-2 text-xs text-slate-500 tabular-nums">
            غير متصل: {kpis?.vehiclesOffline ?? '—'} · غياب اليوم: {kpis?.driversAbsent ?? '—'}
          </div>
        </div>
      </div>

      {/* Operational Counters Row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          {
            label: 'إجمالي السائقين المسجلين',
            value: kpis?.totalRegisteredDrivers ?? 0,
            icon: Users,
            tone: 'text-slate-900',
          },
          {
            label: 'سائقون نشطون',
            value: kpis?.driversActive ?? 0,
            icon: UserCheck,
            tone: 'text-emerald-700',
          },
          {
            label: 'سائقون غائبون',
            value: kpis?.driversAbsent ?? 0,
            icon: UserX,
            tone: 'text-red-700',
          },
          {
            label: 'المركبات النشطة',
            value: kpis?.totalActiveVehicles ?? 0,
            icon: Bus,
            tone: 'text-[#0B1F3A]',
          },
          {
            label: 'مركبات متصلة (GPS)',
            value: kpis?.vehiclesOnline ?? 0,
            icon: Bus,
            tone: 'text-emerald-700',
          },
          {
            label: 'مركبات غير متصلة',
            value: kpis?.vehiclesOffline ?? 0,
            icon: Bus,
            tone: 'text-amber-700',
          },
        ].map((item) => (
          <div key={item.label} className="bg-white border border-slate-200 rounded-xl px-4 py-3.5">
            <div className="text-xs text-slate-500 truncate">{item.label}</div>
            <div className={`mt-1.5 font-mono text-xl font-bold tabular-nums ${item.tone}`}>
              {loading ? '—' : item.value}
            </div>
          </div>
        ))}
      </div>

      {/* Operational Drivers & Fleet Table + Recent Alerts */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
            <h2 className="font-display text-base font-bold text-[#0B1F3A]">
              ملخص السائقين والحساب الشهري
            </h2>
            <button
              onClick={() => onNavigate('drivers')}
              className="text-xs font-semibold text-[#0B1F3A] hover:underline cursor-pointer"
            >
              إدارة السائقين
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4 font-semibold">الكود</th>
                  <th className="py-3 px-4 font-semibold">السائق</th>
                  <th className="py-3 px-4 font-semibold">المدرسة والباص</th>
                  <th className="py-3 px-4 font-semibold">الحضور</th>
                  <th className="py-3 px-4 font-semibold">السلف</th>
                  <th className="py-3 px-4 font-semibold">صافي المستحق</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-slate-400">
                      جاري تحميل البيانات...
                    </td>
                  </tr>
                ) : !data?.drivers.length ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-slate-400">
                      لا توجد نتائج مطابقة للفلاتر المحددة
                    </td>
                  </tr>
                ) : (
                  data.drivers.map((d) => {
                    const sal = d.currentSalary;
                    const att = d.todayAttendance || 'present';
                    const attText =
                      att === 'present'
                        ? 'حاضر'
                        : att === 'covered'
                        ? 'مغطى (غائب)'
                        : att === 'absent'
                        ? 'غائب'
                        : 'إجازة';
                    const attColor =
                      att === 'present'
                        ? 'text-emerald-700'
                        : att === 'covered'
                        ? 'text-amber-700'
                        : 'text-red-700';

                    return (
                      <tr
                        key={d.id}
                        onClick={() => onNavigate('drivers')}
                        title="اضغط للانتقال لتعديل أو حذف السائق"
                        className="hover:bg-slate-50/90 cursor-pointer transition-colors"
                      >
                        <td className="py-3 px-4 font-mono font-semibold text-[#0B1F3A] tabular-nums">
                          {d.driverCode}
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2.5">
                            <DriverAvatar name={d.fullName} photoUrl={d.photoUrl} size="xs" />
                            <div>
                              <div className="font-semibold text-slate-900">{d.fullName}</div>
                              <div className="text-slate-500 tabular-nums">{d.phone}</div>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="text-slate-800">{d.schoolName}</div>
                          <div className="text-slate-500 font-mono">{d.busNumber}</div>
                        </td>
                        <td className={`py-3 px-4 font-semibold ${attColor}`}>{attText}</td>
                        <td className="py-3 px-4 font-mono text-slate-700 tabular-nums">
                          {formatEGP(sal?.totalAdvances ?? 0)}
                        </td>
                        <td className="py-3 px-4 font-mono font-bold text-[#0B1F3A] tabular-nums">
                          {formatEGP(sal?.netSalary ?? d.monthlyAgreedSalary)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
            <h2 className="font-display text-base font-bold text-[#0B1F3A]">آخر التنبيهات</h2>
            <button
              onClick={() => onNavigate('map')}
              className="text-xs font-semibold text-[#0B1F3A] hover:underline cursor-pointer"
            >
              الخريطة المباشرة
            </button>
          </div>
          <div className="divide-y divide-slate-100 flex-1">
            {!data?.recentNotifications.length ? (
              <div className="p-6 text-center text-xs text-slate-400">لا توجد تنبيهات حالياً</div>
            ) : (
              data.recentNotifications.map((n) => (
                <div key={n.id} className="p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-slate-900">{n.title}</span>
                    <span className="text-[11px] text-slate-400 whitespace-nowrap">
                      {formatRelativeArabicTime(n.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-600 leading-relaxed">{n.body}</p>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
