import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, FileSpreadsheet, Loader2, MessageCircle, Sparkles, X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch, exportRowsToExcel, formatEGP, formatRelativeArabicTime } from '../../lib/api';
import {
  buildWhatsAppUrl,
  captureElementAsPngBlob,
  copyPngBlobToClipboard,
  downloadBlob,
  shareImageFileViaWebShare,
} from '../../lib/whatsapp-statement';
import type {
  AdvanceRecord,
  CoverageRecord,
  EnrichedDriver,
  FleetVehicle,
  SalaryRecord,
  SchoolBillingRange,
  SchoolItem,
  SupervisorCycleSummaryItem,
} from '../../types';

interface ReportsResponse {
  period: {
    month: number;
    year: number;
    startDate?: string;
    endDate?: string;
    startDateTime?: string;
    endDateTime?: string;
    labelAr?: string;
    shortLabelAr?: string;
    schoolId?: number | null;
    schoolName?: string | null;
  };
  schoolBillingRanges?: Array<{ schoolId: number; schoolName: string; range: SchoolBillingRange }>;
  supervisors?: SupervisorCycleSummaryItem[];
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
  | 'supervisors'
  | 'advances'
  | 'coverage'
  | 'statements'
  | 'schools'
  | 'vehicles'
  | 'attendance'
  | 'gps'
  | 'profitability';

export const ReportsModule: React.FC = () => {
  const { dbUser } = useAuth();
  const isSuperAdmin =
    dbUser?.roleSlug === 'super_admin' || (dbUser?.permissions || []).includes('*');
  const restrictedSchoolIds = dbUser?.assignedSchoolIds || [];
  const isSingleSchoolRestricted = !isSuperAdmin && restrictedSchoolIds.length === 1;

  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [year, setYear] = useState(new Date().getFullYear());
  const [selectedSchoolId, setSelectedSchoolId] = useState<string>(() =>
    isSingleSchoolRestricted ? String(restrictedSchoolIds[0]) : 'all'
  );
  const initialPeriodSyncedRef = useRef(false);
  const autoTodayPeriodRef = useRef(false);
  const [reportType, setReportType] = useState<ReportKind>('salaries');
  const [data, setData] = useState<ReportsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reportCaptureRef = useRef<HTMLDivElement | null>(null);
  const [sharingWhatsApp, setSharingWhatsApp] = useState(false);
  const [whatsappPreview, setWhatsappPreview] = useState<{
    blob: Blob;
    url: string;
    filename: string;
    copied: boolean;
    statusText: string;
    whatsappUrl: string;
  } | null>(null);

  const clearWhatsappPreview = useCallback(() => {
    setWhatsappPreview((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return null;
    });
  }, []);

  const loadReports = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (initialPeriodSyncedRef.current && !autoTodayPeriodRef.current) {
        params.set('month', String(month));
        params.set('year', String(year));
      }
      if (autoTodayPeriodRef.current) {
        params.set('autoPeriod', 'true');
      }
      if (selectedSchoolId !== 'all') {
        params.set('schoolId', selectedSchoolId);
      }
      const qs = params.toString();
      const url = qs ? `/api/reports/summary?${qs}` : `/api/reports/summary`;
      const res = await apiFetch<ReportsResponse>(url);
      if ((!initialPeriodSyncedRef.current || autoTodayPeriodRef.current) && res.period) {
        initialPeriodSyncedRef.current = true;
        autoTodayPeriodRef.current = false;
        setMonth(res.period.month);
        setYear(res.period.year);
      }
      setData(res);
    } catch (err: unknown) {
      autoTodayPeriodRef.current = false;
      setError(err instanceof Error ? err.message : 'تعذر تحميل بيانات التقارير');
    } finally {
      setLoading(false);
    }
  }, [month, year, selectedSchoolId]);

  const handleAutoTodayPeriod = () => {
    autoTodayPeriodRef.current = true;
    loadReports();
  };

  useEffect(() => {
    if (isSingleSchoolRestricted && restrictedSchoolIds[0]) {
      setSelectedSchoolId(String(restrictedSchoolIds[0]));
    }
  }, [isSingleSchoolRestricted, restrictedSchoolIds]);

  useEffect(() => {
    clearWhatsappPreview();
    loadReports();
  }, [loadReports, clearWhatsappPreview]);

  useEffect(() => {
    return () => {
      if (whatsappPreview?.url) URL.revokeObjectURL(whatsappPreview.url);
    };
  }, [whatsappPreview]);

  const driverById: Record<number, EnrichedDriver> = {};
  if (data) {
    for (const d of data.drivers) driverById[d.id] = d;
  }

  const handleExportExcel = () => {
    if (!data) return;
    if (reportType === 'salaries' || reportType === 'statements') {
      exportRowsToExcel(
        `alwaleed-salaries-${year}-${month}`,
        [
          'كود السائق',
          'الاسم',
          'المدرسة',
          'الأساسي',
          'السلف',
          'خصم التغطيات (-)',
          'مستحق التغطيات (+)',
          'خصومات أخرى',
          'المكافآت',
          'الصافي',
        ],
        data.salaries.map((s) => {
          const d = driverById[s.driverId];
          return [
            d?.driverCode || '',
            d?.fullName || '',
            d?.schoolName || '',
            Number(s.baseSalary),
            Number(s.totalAdvances),
            Number(s.totalCoverageDeductions),
            Number(s.totalCoverageAdditions || 0),
            Number(s.otherDeductions),
            Number(s.bonuses),
            Number(s.netSalary),
          ];
        })
      );
    } else if (reportType === 'supervisors') {
      exportRowsToExcel(
        `alwaleed-supervisors-${year}-${month}`,
        ['الكود', 'المشرفة', 'المدرسة', 'نطاق الدورة', 'رحلات الصباح', 'رحلات المساء', 'أيام مكتملة', 'الراتب الشهري'],
        (data.supervisors || []).map((sv) => [
          sv.supervisorCode,
          sv.fullName,
          sv.schoolName,
          `${sv.billingRange.startDate} -> ${sv.billingRange.endDate}`,
          sv.morningTripsCount,
          sv.eveningTripsCount,
          sv.completedDaysCount,
          Number(sv.monthlySalary || 0),
        ])
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
        [
          'التاريخ',
          'السائق الأساسي (الغائب)',
          'السائق البديل (المستفيد)',
          'التغطيات (مخصومة من الأساسي)',
          'السبب',
        ],
        data.coverages.map((c) => {
          const d = driverById[c.absentDriverId];
          const rep = c.replacementDriverId ? driverById[c.replacementDriverId] : null;
          const amt = Number(
            c.coverageAmount ?? c.absentDriverDeduction ?? c.actualReplacementCost ?? 0
          );
          return [
            c.date,
            d?.fullName || '',
            rep?.fullName || c.replacementDriverName || c.replacementExternalName || '—',
            amt,
            c.reason,
          ];
        })
      );
    } else if (reportType === 'schools' || reportType === 'profitability') {
      exportRowsToExcel(
        `alwaleed-profitability-${year}-${month}`,
        ['المدرسة', 'قيمة العقد الشهري', 'عدد المركبات', 'إجمالي رواتب السائقين', 'صافي ربح المدرسة'],
        data.schools.map((s) => {
          const vCount = data.fleet.filter((v) => v.schoolId === s.id).length;
          const schoolSal = data.salaries
            .filter((sal) => driverById[sal.driverId]?.schoolId === s.id)
            .reduce((sum, sal) => sum + Number(sal.netSalary || 0), 0);
          return [s.name, Number(s.monthlyContractValue), vCount, schoolSal, Number(s.monthlyContractValue) - schoolSal];
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
    { id: 'supervisors', label: 'تقرير رحلات ومستحقات المشرفات' },
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
  const totalSalariesNet =
    data?.salaries.reduce((sum, sal) => sum + Number(sal.netSalary || 0), 0) || 0;

  const handleSendReportToWhatsApp = async () => {
    if (!reportCaptureRef.current || !data) return;
    setSharingWhatsApp(true);
    setError(null);
    try {
      const blob = await captureElementAsPngBlob(reportCaptureRef.current);
      const label = reportTabs.find((r) => r.id === reportType)?.label || 'تقرير';
      const filename = `تقرير-${reportType}-${month}-${year}.png`;
      const schoolLabel = data.period?.schoolName ? ` — ${data.period.schoolName}` : '';
      const rangeLabel = data.period?.labelAr ? ` — ${data.period.labelAr}` : ` (شهر ${month}/${year})`;
      const caption = `الوليد ترافيل — ${label}${schoolLabel}${rangeLabel}`;
      const whatsappUrl = buildWhatsAppUrl('', caption);

      const webShareResult = await shareImageFileViaWebShare(blob, filename, caption, caption);
      if (webShareResult === 'shared') {
        clearWhatsappPreview();
        const url = URL.createObjectURL(blob);
        setWhatsappPreview({
          blob,
          url,
          filename,
          copied: false,
          statusText: 'تم فتح المشاركة بالصورة بنجاح.',
          whatsappUrl,
        });
        return;
      }

      const copied = await copyPngBlobToClipboard(blob);
      downloadBlob(blob, filename);
      clearWhatsappPreview();
      const url = URL.createObjectURL(blob);
      setWhatsappPreview({
        blob,
        url,
        filename,
        copied,
        statusText: copied
          ? 'تم تجهيز صورة التقرير ونسخها للحافظة وتحميلها — اضغط فتح واتساب ثم الصق الصورة (Ctrl+V) أو أرفقها.'
          : 'تم تجهيز صورة التقرير وتحميلها — اضغط فتح واتساب وأرفق الصورة المحمّلة.',
        whatsappUrl,
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تجهيز صورة التقرير للواتساب');
    } finally {
      setSharingWhatsApp(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 no-print">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#0B1F3A]">
            التقارير والتحليلات المالية والتشغيلية
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            تصدير فوري إلى Excel (UTF-8) وإرسال صورة التقرير مباشرة عبر واتساب لشركة الوليد ترافيل
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <select
            value={selectedSchoolId}
            disabled={isSingleSchoolRestricted}
            onChange={(e) => setSelectedSchoolId(e.target.value)}
            aria-label="تصفية التقارير حسب المدرسة"
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-[#0B1F3A] focus:outline-none focus:border-[#C89B3C] disabled:bg-slate-100"
          >
            {!isSingleSchoolRestricted && (
              <option value="all">
                {!isSuperAdmin && restrictedSchoolIds.length > 0
                  ? 'جميع مدارسي المخصصة (كل دورة حسب مدرستها)'
                  : 'جميع المدارس (كل دورة حسب مدرستها)'}
              </option>
            )}
            {(data?.schoolBillingRanges || []).map((sb) => (
              <option key={sb.schoolId} value={String(sb.schoolId)}>
                {sb.schoolName} ({sb.range.shortLabelAr})
              </option>
            ))}
            {isSingleSchoolRestricted &&
              !(data?.schoolBillingRanges || []).some(
                (sb) => String(sb.schoolId) === String(restrictedSchoolIds[0])
              ) && (
                <option value={String(restrictedSchoolIds[0])}>
                  {dbUser?.assignedSchoolNames?.[0] || 'المدرسة المخصصة'}
                </option>
              )}
          </select>
          <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs">
            <span className="text-slate-500">شهر</span>
            <input
              type="number"
              min={1}
              max={12}
              value={month}
              onChange={(e) => {
                initialPeriodSyncedRef.current = true;
                setMonth(Math.min(12, Math.max(1, Number(e.target.value) || 1)));
              }}
              className="w-12 font-mono font-semibold text-center focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs">
            <span className="text-slate-500">سنة</span>
            <input
              type="number"
              min={2020}
              max={2050}
              value={year}
              onChange={(e) => {
                initialPeriodSyncedRef.current = true;
                setYear(Number(e.target.value) || new Date().getFullYear());
              }}
              className="w-16 font-mono font-semibold text-center focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={handleAutoTodayPeriod}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-[#0B1F3A] hover:bg-slate-50 cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5 text-[#C89B3C]" />
            الفترة التلقائية لليوم
          </button>
          <button
            onClick={handleExportExcel}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 cursor-pointer"
          >
            <FileSpreadsheet className="w-4 h-4" />
            تصدير Excel
          </button>
          <button
            type="button"
            disabled={loading || !data || sharingWhatsApp}
            onClick={handleSendReportToWhatsApp}
            className="flex items-center gap-1.5 rounded-lg bg-[#25D366] px-3.5 py-2 text-xs font-bold text-white hover:bg-[#1ebe5d] disabled:opacity-50 cursor-pointer"
          >
            {sharingWhatsApp ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <MessageCircle className="w-4 h-4" />
            )}
            {sharingWhatsApp ? 'جاري تجهيز الصورة...' : 'إرسال للواتساب (صورة)'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-800 flex items-center justify-between gap-2 no-print">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="إغلاق التنبيه"
            className="p-1 text-red-500 hover:text-red-800 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 p-1.5 bg-slate-200/70 rounded-xl no-print">
        {reportTabs.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              clearWhatsappPreview();
              setReportType(t.id);
            }}
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

      {whatsappPreview && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/80 p-4 space-y-3 text-xs">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-bold text-emerald-900 flex items-center gap-1.5">
                <MessageCircle className="w-4 h-4 text-[#25D366]" />
                <span>جاهز للإرسال عبر واتساب</span>
              </div>
              <p className="text-[11px] text-emerald-800 mt-1">{whatsappPreview.statusText}</p>
            </div>
            <button
              type="button"
              onClick={clearWhatsappPreview}
              className="text-emerald-700 hover:text-emerald-950 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
            <img
              src={whatsappPreview.url}
              alt="معاينة صورة التقرير"
              className="w-36 h-24 object-cover object-top rounded-lg border border-emerald-200 bg-white shadow-xs shrink-0"
            />
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={whatsappPreview.whatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#25D366] px-4 py-2 text-xs font-bold text-white hover:bg-[#1ebe5d]"
              >
                <MessageCircle className="w-4 h-4" />
                فتح واتساب وإرسال الصورة
              </a>
              <button
                type="button"
                onClick={async () => {
                  const copied = await copyPngBlobToClipboard(whatsappPreview.blob);
                  setWhatsappPreview((prev) => (prev ? { ...prev, copied } : null));
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-white px-3 py-2 text-xs font-semibold text-emerald-900 hover:bg-emerald-100 cursor-pointer"
              >
                {whatsappPreview.copied ? (
                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                {whatsappPreview.copied ? 'تم نسخ الصورة' : 'نسخ الصورة'}
              </button>
              <button
                type="button"
                onClick={() => downloadBlob(whatsappPreview.blob, whatsappPreview.filename)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-white px-3 py-2 text-xs font-semibold text-emerald-900 hover:bg-emerald-100 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                تحميل الصورة
              </button>
            </div>
          </div>
        </div>
      )}

      <div ref={reportCaptureRef} dir="rtl" className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-base font-bold text-[#0B1F3A]">
              الوليد ترافيل — {reportTabs.find((r) => r.id === reportType)?.label}
              {data?.period?.schoolName ? ` (${data.period.schoolName})` : ''}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
              الفترة: شهر {month} / {year}
              {data?.period?.labelAr ? ` · ${data.period.labelAr}` : ''}
            </p>
          </div>
          {selectedSchoolId === 'all' && Boolean(data?.schoolBillingRanges?.length) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {data?.schoolBillingRanges?.map((sb) => (
                <span
                  key={sb.schoolId}
                  className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${
                    sb.range.cycleType === 'shifted'
                      ? 'bg-amber-50 text-amber-800 border border-amber-200'
                      : 'bg-slate-100 text-slate-700 border border-slate-200'
                  }`}
                >
                  {sb.schoolName}: {sb.range.shortLabelAr}
                </span>
              ))}
            </div>
          )}
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
                        <td className="py-3 px-4 font-mono tabular-nums">
                          <div className="text-red-700">
                            {Number(s.totalCoverageDeductions || 0) > 0 ? '− ' : ''}
                            {formatEGP(s.totalCoverageDeductions)}
                          </div>
                          {Number(s.totalCoverageAdditions || 0) > 0 && (
                            <div className="text-[11px] font-semibold text-emerald-700">
                              + {formatEGP(s.totalCoverageAdditions || 0)} بديل
                            </div>
                          )}
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

            {reportType === 'supervisors' && (
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-4">الكود</th>
                    <th className="py-3 px-4">المشرفة</th>
                    <th className="py-3 px-4">المدرسة</th>
                    <th className="py-3 px-4">نطاق الدورة</th>
                    <th className="py-3 px-4">صباحاً</th>
                    <th className="py-3 px-4">مساءً</th>
                    <th className="py-3 px-4">أيام مكتملة</th>
                    <th className="py-3 px-4">الراتب الشهري</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(data.supervisors || []).length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-slate-400">
                        لا توجد مشرفات مسجلات في هذا النطاق
                      </td>
                    </tr>
                  ) : (
                    (data.supervisors || []).map((sv) => (
                      <tr key={sv.supervisorId}>
                        <td className="py-3 px-4 font-mono font-bold">{sv.supervisorCode}</td>
                        <td className="py-3 px-4 font-semibold">{sv.fullName}</td>
                        <td className="py-3 px-4">{sv.schoolName}</td>
                        <td className="py-3 px-4 font-mono tabular-nums">
                          {sv.billingRange.startDate} ← {sv.billingRange.endDate}
                        </td>
                        <td className="py-3 px-4 font-mono tabular-nums">{sv.morningTripsCount}</td>
                        <td className="py-3 px-4 font-mono tabular-nums">{sv.eveningTripsCount}</td>
                        <td className="py-3 px-4 font-mono tabular-nums">{sv.completedDaysCount}</td>
                        <td className="py-3 px-4 font-mono font-bold text-[#0B1F3A] tabular-nums">
                          {formatEGP(sv.monthlySalary)}
                        </td>
                      </tr>
                    ))
                  )}
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
                    <th className="py-3 px-4">السائق الأساسي (الغائب)</th>
                    <th className="py-3 px-4">السائق البديل (المستفيد)</th>
                    <th className="py-3 px-4">المدرسة</th>
                    <th className="py-3 px-4">التغطيات (مخصومة من الأساسي)</th>
                    <th className="py-3 px-4">السبب</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.coverages.map((c) => {
                    const d = driverById[c.absentDriverId];
                    const rep = c.replacementDriverId ? driverById[c.replacementDriverId] : null;
                    const amt =
                      c.coverageAmount ?? c.absentDriverDeduction ?? c.actualReplacementCost ?? 0;
                    return (
                      <tr key={c.id}>
                        <td className="py-3 px-4 font-mono tabular-nums">{c.date}</td>
                        <td className="py-3 px-4 font-semibold">
                          {d?.fullName} ({d?.driverCode})
                        </td>
                        <td className="py-3 px-4 text-slate-700 font-medium">
                          {rep ? `${rep.fullName} (${rep.driverCode})` : c.replacementDriverName || c.replacementExternalName || '—'}
                        </td>
                        <td className="py-3 px-4">{d?.schoolName}</td>
                        <td className="py-3 px-4 font-mono font-bold text-[#0B1F3A] tabular-nums">
                          {formatEGP(amt)}
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
                    <div className="text-slate-500">إجمالي صافي رواتب السائقين</div>
                    <div className="mt-1 font-mono text-lg font-bold text-red-700 tabular-nums">
                      {formatEGP(totalSalariesNet)}
                    </div>
                  </div>
                  <div className="bg-[#0B1F3A] text-white rounded-xl p-4">
                    <div className="text-slate-300">صافي ربح المكتب المتوقع</div>
                    <div className="mt-1 font-mono text-lg font-bold text-[#C89B3C] tabular-nums">
                      {formatEGP(totalSchoolRevenue - totalSalariesNet)}
                    </div>
                  </div>
                </div>
                <table className="w-full text-right text-xs border border-slate-200">
                  <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="py-3 px-4">المدرسة</th>
                      <th className="py-3 px-4">قيمة العقد الشهري</th>
                      <th className="py-3 px-4">عدد الباصات</th>
                      <th className="py-3 px-4">رواتب السائقين</th>
                      <th className="py-3 px-4">صافي الربح المتوقع</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.schools.map((s) => {
                      const vCount = data.fleet.filter((v) => v.schoolId === s.id).length;
                      const schoolSal = data.salaries
                        .filter((sal) => driverById[sal.driverId]?.schoolId === s.id)
                        .reduce((sum, sal) => sum + Number(sal.netSalary || 0), 0);
                      return (
                        <tr key={s.id}>
                          <td className="py-3 px-4 font-semibold">{s.name}</td>
                          <td className="py-3 px-4 font-mono tabular-nums">
                            {formatEGP(s.monthlyContractValue)}
                          </td>
                          <td className="py-3 px-4 font-mono tabular-nums">{vCount}</td>
                          <td className="py-3 px-4 font-mono tabular-nums text-red-700">
                            {formatEGP(schoolSal)}
                          </td>
                          <td className="py-3 px-4 font-mono font-bold text-emerald-700 tabular-nums">
                            {formatEGP(Number(s.monthlyContractValue) - schoolSal)}
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
