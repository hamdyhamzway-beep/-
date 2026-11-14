import React, { useCallback, useEffect, useState } from 'react';
import { FileSpreadsheet, Printer } from 'lucide-react';
import { apiFetch, exportRowsToExcel, formatEGP, formatRelativeArabicTime } from '../../lib/api';
import type {
  AdvanceRecord,
  CoverageRecord,
  EnrichedDriver,
  FleetVehicle,
  SalaryRecord,
  SchoolItem,
} from '../../types';

interface ReportsResponse {
  period: { month: number; year: number };
  drivers: EnrichedDriver[];
  salaries: SalaryRecord[];
  advances: AdvanceRecord[];
  coverages: CoverageRecord[];
  attendance: Array<{ id: number; driverId: number; date: string; status: string }>;
  schools: SchoolItem[];
  fleet: FleetVehicle[];
}

type ReportKind =
  | 'salaries'
  | 'advances'
  | 'coverage'
  | 'statements'
  | 'schools'
  | 'vehicles'
  | 'attendance'
  | 'gps'
  | 'profitability';

export const ReportsModule: React.FC = () => {
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [year, setYear] = useState(new Date().getFullYear());
  const [reportType, setReportType] = useState<ReportKind>('salaries');
  const [data, setData] = useState<ReportsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const loadReports = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<ReportsResponse>(
        `/api/reports/summary?month=${month}&year=${year}`
      );
      setData(res);
    } finally {
      setLoading(false);
    }
  }, [month, year]);

  useEffect(() => {
    loadReports();
  }, [loadReports]);

  const driverById: Record<number, EnrichedDriver> = {};
  if (data) {
    for (const d of data.drivers) driverById[d.id] = d;
  }

  const handleExportExcel = () => {
    if (!data) return;
    if (reportType === 'salaries' || reportType === 'statements') {
      exportRowsToExcel(
        `alwaleed-salaries-${year}-${month}`,
        ['كود السائق', 'الاسم', 'المدرسة', 'الأساسي', 'السلف', 'التغطية', 'خصومات أخرى', 'المكافآت', 'الصافي'],
        data.salaries.map((s) => {
          const d = driverById[s.driverId];
          return [
            d?.driverCode || '',
            d?.fullName || '',
            d?.schoolName || '',
            Number(s.baseSalary),
            Number(s.totalAdvances),
            Number(s.totalCoverageDeductions),
            Number(s.otherDeductions),
            Number(s.bonuses),
            Number(s.netSalary),
          ];
        })
      );
    } else if (reportType === 'advances') {
      exportRowsToExcel(
        `alwaleed-advances-${year}-${month}`,
        ['التاريخ', 'الكود', 'السائق', 'المدرسة', 'المبلغ', 'طريقة الدفع', 'السبب'],
        data.advances.map((a) => {
          const d = driverById[a.driverId];
          return [a.date, d?.driverCode || '', d?.fullName || '', d?.schoolName || '', Number(a.amount), a.paymentMethod, a.reason];
        })
      );
    } else if (reportType === 'coverage') {
      exportRowsToExcel(
        `alwaleed-coverage-${year}-${month}`,
        ['التاريخ', 'السائق الغائب', 'تكلفة البديل', 'خصم الغائب', 'السبب'],
        data.coverages.map((c) => {
          const d = driverById[c.absentDriverId];
          return [c.date, d?.fullName || '', Number(c.actualReplacementCost), Number(c.absentDriverDeduction), c.reason];
        })
      );
    } else if (reportType === 'schools' || reportType === 'profitability') {
      exportRowsToExcel(
        `alwaleed-profitability-${year}-${month}`,
        ['المدرسة', 'قيمة العقد الشهري', 'عدد المركبات', 'تكلفة الملاك', 'صافي ربح المكتب'],
        data.schools.map((s) => {
          const vCount = data.fleet.filter((v) => v.schoolId === s.id).length;
          const ownerCost = data.fleet
            .filter((v) => v.schoolId === s.id)
            .reduce((sum, v) => sum + v.monthlyOwnerCost, 0);
          return [s.name, Number(s.monthlyContractValue), vCount, ownerCost, Number(s.monthlyContractValue) - ownerCost];
        })
      );
    } else if (reportType === 'vehicles' || reportType === 'gps') {
      exportRowsToExcel(
        `alwaleed-fleet-${year}-${month}`,
        ['رقم الباص', 'اللوحة', 'المدرسة', 'السائق', 'حالة GPS', 'آخر تحديث'],
        data.fleet.map((v) => [
          v.busNumber,
          v.registrationNumber,
          v.schoolName,
          v.driverName,
          v.isOnline ? 'متصل مباشر' : 'غير متصل',
          v.gps?.recordedAt || 'غير متاح',
        ])
      );
    } else {
      exportRowsToExcel(
        `alwaleed-attendance-${year}-${month}`,
        ['التاريخ', 'الكود', 'السائق', 'الحالة'],
        data.attendance.map((a) => {
          const d = driverById[a.driverId];
          return [a.date, d?.driverCode || '', d?.fullName || '', a.status];
        })
      );
    }
  };

  const reportTabs: Array<{ id: ReportKind; label: string }> = [
    { id: 'salaries', label: 'تقرير الرواتب الشهري' },
    { id: 'advances', label: 'تقرير السلف' },
    { id: 'coverage', label: 'تقرير تغطيات الغياب' },
    { id: 'statements', label: 'كشوف حساب السائقين' },
    { id: 'schools', label: 'الملخص المالي للمدارس' },
    { id: 'vehicles', label: 'تعيينات المركبات' },
    { id: 'attendance', label: 'تقرير الحضور والغياب' },
    { id: 'gps', label: 'تقرير نشاط GPS' },
    { id: 'profitability', label: 'تقرير ربحية المكتب' },
  ];

  const totalSchoolRevenue =
    data?.schools.reduce((sum, s) => sum + Number(s.monthlyContractValue || 0), 0) || 0;
  const totalOwnerCosts =
    data?.fleet.reduce((sum, v) => sum + Number(v.monthlyOwnerCost || 0), 0) || 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 no-print">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#0B1F3A]">
            التقارير والتحليلات المالية والتشغيلية
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            تصدير فوري إلى Excel (UTF-8) و PDF / طباعة رسمية لشركة الوليد ترافيل
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <select
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold"
          >
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <option key={m} value={m}>
                شهر {m}
              </option>
            ))}
          </select>
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono font-semibold"
          >
            {[2025, 2026, 2027].map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <button
            onClick={handleExportExcel}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 cursor-pointer"
          >
            <FileSpreadsheet className="w-4 h-4" />
            تصدير Excel
          </button>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-1.5 rounded-lg bg-[#0B1F3A] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#13325c] cursor-pointer"
          >
            <Printer className="w-4 h-4 text-[#C89B3C]" />
            تصدير PDF / طباعة
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 p-1.5 bg-slate-200/70 rounded-xl no-print">
        {reportTabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setReportType(t.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
              reportType === t.id
                ? 'bg-white text-[#0B1F3A] shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden print-only-full">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="font-display text-base font-bold text-[#0B1F3A]">
              الوليد ترافيل — {reportTabs.find((r) => r.id === reportType)?.label}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
              الفترة: شهر {month} / {year}
            </p>
          </div>
        </div>

        {loading || !data ? (
          <div className="p-10 text-center text-xs text-slate-400">جاري تجهيز التقرير...</div>
        ) : (
          <div className="overflow-x-auto">
            {(reportType === 'salaries' || reportType === 'statements') && (
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-4">الكود</th>
                    <th className="py-3 px-4">السائق</th>
                    <th className="py-3 px-4">المدرسة</th>
                    <th className="py-3 px-4">الأساسي</th>
                    <th className="py-3 px-4">السلف</th>
                    <th className="py-3 px-4">التغطيات</th>
                    <th className="py-3 px-4">المكافآت</th>
                    <th className="py-3 px-4">صافي المستحق</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.salaries.map((s) => {
                    const d = driverById[s.driverId];
                    return (
                      <tr key={s.id}>
                        <td className="py-3 px-4 font-mono font-bold">{d?.driverCode}</td>
                        <td className="py-3 px-4 font-semibold">{d?.fullName}</td>
                        <td className="py-3 px-4">{d?.schoolName}</td>
                        <td className="py-3 px-4 font-mono tabular-nums">{formatEGP(s.baseSalary)}</td>
                        <td className="py-3 px-4 font-mono text-red-700 tabular-nums">
                          {formatEGP(s.totalAdvances)}
                        </td>
                        <td className="py-3 px-4 font-mono text-red-700 tabular-nums">
                          {formatEGP(s.totalCoverageDeductions)}
                        </td>
                        <td className="py-3 px-4 font-mono text-emerald-700 tabular-nums">
                          {formatEGP(s.bonuses)}
                        </td>
                        <td className="py-3 px-4 font-mono font-bold text-[#0B1F3A] tabular-nums">
                          {formatEGP(s.netSalary)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {reportType === 'advances' && (
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-4">التاريخ</th>
                    <th className="py-3 px-4">السائق</th>
                    <th className="py-3 px-4">المدرسة</th>
                    <th className="py-3 px-4">الطريقة</th>
                    <th className="py-3 px-4">السبب</th>
                    <th className="py-3 px-4">المبلغ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.advances.map((a) => {
                    const d = driverById[a.driverId];
                    return (
                      <tr key={a.id}>
                        <td className="py-3 px-4 font-mono tabular-nums">{a.date}</td>
                        <td className="py-3 px-4 font-semibold">
                          {d?.fullName} ({d?.driverCode})
                        </td>
                        <td className="py-3 px-4">{d?.schoolName}</td>
                        <td className="py-3 px-4">{a.paymentMethod}</td>
                        <td className="py-3 px-4">{a.reason}</td>
                        <td className="py-3 px-4 font-mono font-bold text-red-700 tabular-nums">
                          {formatEGP(a.amount)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {reportType === 'coverage' && (
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-4">التاريخ</th>
                    <th className="py-3 px-4">السائق الغائب</th>
                    <th className="py-3 px-4">المدرسة</th>
                    <th className="py-3 px-4">تكلفة البديل الفعلية</th>
                    <th className="py-3 px-4">المخصوم من الغائب</th>
                    <th className="py-3 px-4">السبب</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.coverages.map((c) => {
                    const d = driverById[c.absentDriverId];
                    return (
                      <tr key={c.id}>
                        <td className="py-3 px-4 font-mono tabular-nums">{c.date}</td>
                        <td className="py-3 px-4 font-semibold">
                          {d?.fullName} ({d?.driverCode})
                        </td>
                        <td className="py-3 px-4">{d?.schoolName}</td>
                        <td className="py-3 px-4 font-mono tabular-nums">
                          {formatEGP(c.actualReplacementCost)}
                        </td>
                        <td className="py-3 px-4 font-mono font-bold text-red-700 tabular-nums">
                          {formatEGP(c.absentDriverDeduction)}
                        </td>
                        <td className="py-3 px-4">{c.reason}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {(reportType === 'schools' || reportType === 'profitability') && (
              <div className="p-5 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
                  <div className="border border-slate-200 rounded-xl p-4">
                    <div className="text-slate-500">إجمالي إيرادات عقود المدارس</div>
                    <div className="mt-1 font-mono text-lg font-bold text-[#0B1F3A] tabular-nums">
                      {formatEGP(totalSchoolRevenue)}
                    </div>
                  </div>
                  <div className="border border-slate-200 rounded-xl p-4">
                    <div className="text-slate-500">إجمالي تكاليف ملاك الباصات</div>
                    <div className="mt-1 font-mono text-lg font-bold text-slate-900 tabular-nums">
                      {formatEGP(totalOwnerCosts)}
                    </div>
                  </div>
                  <div className="bg-[#0B1F3A] text-white rounded-xl p-4">
                    <div className="text-slate-300">صافي ربح الوليد ترافيل</div>
                    <div className="mt-1 font-mono text-lg font-bold text-[#C89B3C] tabular-nums">
                      {formatEGP(totalSchoolRevenue - totalOwnerCosts)}
                    </div>
                  </div>
                </div>
                <table className="w-full text-right text-xs border border-slate-200">
                  <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="py-3 px-4">المدرسة</th>
                      <th className="py-3 px-4">قيمة العقد الشهري</th>
                      <th className="py-3 px-4">عدد الباصات</th>
                      <th className="py-3 px-4">تكلفة الملاك</th>
                      <th className="py-3 px-4">صافي الربح</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.schools.map((s) => {
                      const vCount = data.fleet.filter((v) => v.schoolId === s.id).length;
                      const ownerCost = data.fleet
                        .filter((v) => v.schoolId === s.id)
                        .reduce((sum, v) => sum + v.monthlyOwnerCost, 0);
                      return (
                        <tr key={s.id}>
                          <td className="py-3 px-4 font-semibold">{s.name}</td>
                          <td className="py-3 px-4 font-mono tabular-nums">
                            {formatEGP(s.monthlyContractValue)}
                          </td>
                          <td className="py-3 px-4 font-mono tabular-nums">{vCount}</td>
                          <td className="py-3 px-4 font-mono tabular-nums">
                            {formatEGP(ownerCost)}
                          </td>
                          <td className="py-3 px-4 font-mono font-bold text-emerald-700 tabular-nums">
                            {formatEGP(Number(s.monthlyContractValue) - ownerCost)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {(reportType === 'vehicles' || reportType === 'gps') && (
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-4">رقم الباص</th>
                    <th className="py-3 px-4">اللوحة</th>
                    <th className="py-3 px-4">المدرسة والخط</th>
                    <th className="py-3 px-4">السائق</th>
                    <th className="py-3 px-4">حالة GPS</th>
                    <th className="py-3 px-4">آخر تحديث</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.fleet.map((v) => (
                    <tr key={v.id}>
                      <td className="py-3 px-4 font-mono font-bold">{v.busNumber}</td>
                      <td className="py-3 px-4">{v.registrationNumber}</td>
                      <td className="py-3 px-4">
                        {v.schoolName} · {v.routeName}
                      </td>
                      <td className="py-3 px-4">
                        {v.driverName} ({v.driverCode})
                      </td>
                      <td
                        className={`py-3 px-4 font-semibold ${
                          v.isOnline ? 'text-emerald-700' : 'text-amber-700'
                        }`}
                      >
                        {v.isOnline ? `متصل (${v.gps?.speedKmh ?? 0} كم/س)` : 'غير متصل'}
                      </td>
                      <td className="py-3 px-4 text-slate-500">
                        {v.gps ? formatRelativeArabicTime(v.gps.recordedAt) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {reportType === 'attendance' && (
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-4">التاريخ</th>
                    <th className="py-3 px-4">الكود</th>
                    <th className="py-3 px-4">السائق</th>
                    <th className="py-3 px-4">الحالة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.attendance.map((a) => {
                    const d = driverById[a.driverId];
                    return (
                      <tr key={a.id}>
                        <td className="py-3 px-4 font-mono tabular-nums">{a.date}</td>
                        <td className="py-3 px-4 font-mono font-bold">{d?.driverCode}</td>
                        <td className="py-3 px-4 font-semibold">{d?.fullName}</td>
                        <td className="py-3 px-4 font-semibold">
                          {a.status === 'present'
                            ? 'حاضر'
                            : a.status === 'covered'
                            ? 'غائب (تمت التغطية)'
                            : a.status === 'absent'
                            ? 'غائب'
                            : 'إجازة'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
