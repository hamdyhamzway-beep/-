import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Download, FileSpreadsheet, Loader2, MessageCircle, RefreshCw, Sparkles, X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch, exportRowsToExcel, formatEGP, formatRelativeArabicTime } from '../../lib/api';
import {
  buildWhatsAppUrl,
  captureElementAsPngBlob,
  copyPngBlobToClipboard,
  downloadBlob,
  shareImageFileViaWebShare,
} from '../../lib/whatsapp-statement';
import {
  compareSchoolAndBus,
  formatBusBadgeLabel,
  groupBySchoolSortedByBus,
} from '../../lib/bus-sorting';
import { getMarginRating, useMarginRatingThresholds } from '../../lib/profit-rating';
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

const REPORTS_SCHOOL_STORAGE_KEY = 'alwaleed_reports_school_v1';

interface SchoolFilterOption {
  id: number;
  name: string;
  shortLabelAr?: string;
}

function mergeSchoolOptions(
  prev: SchoolFilterOption[],
  incoming: SchoolFilterOption[]
): SchoolFilterOption[] {
  if (!incoming.length) return prev;
  const map = new Map<number, SchoolFilterOption>();
  for (const opt of prev) {
    map.set(opt.id, opt);
  }
  for (const opt of incoming) {
    if (!opt || !Number.isFinite(opt.id)) continue;
    const existing = map.get(opt.id);
    map.set(opt.id, {
      id: opt.id,
      name: opt.name || existing?.name || `مدرسة #${opt.id}`,
      shortLabelAr: opt.shortLabelAr ?? existing?.shortLabelAr,
    });
  }
  return Array.from(map.values());
}

function formatPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '—';
  return `${pct.toFixed(1)}%`;
}

export const ReportsModule: React.FC = () => {
  const { dbUser } = useAuth();
  const isSuperAdmin =
    dbUser?.roleSlug === 'super_admin' || (dbUser?.permissions || []).includes('*');
  const restrictedSchoolIds = useMemo(
    () => dbUser?.assignedSchoolIds || [],
    [dbUser?.assignedSchoolIds]
  );
  const isSingleSchoolRestricted = !isSuperAdmin && restrictedSchoolIds.length === 1;

  const marginThresholds = useMarginRatingThresholds();

  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [year, setYear] = useState(new Date().getFullYear());
  const [selectedSchoolId, setSelectedSchoolId] = useState<string>(() => {
    if (isSingleSchoolRestricted && restrictedSchoolIds[0]) {
      return String(restrictedSchoolIds[0]);
    }
    try {
      return window.localStorage.getItem(REPORTS_SCHOOL_STORAGE_KEY) || 'all';
    } catch {
      return 'all';
    }
  });
  const [schoolOptions, setSchoolOptions] = useState<SchoolFilterOption[]>([]);
  const [schoolOptionsLoaded, setSchoolOptionsLoaded] = useState(false);

  const initialPeriodSyncedRef = useRef(false);
  const autoTodayPeriodRef = useRef(false);
  const requestSeqRef = useRef(0);
  const [reportType, setReportType] = useState<ReportKind>('salaries');
  const [data, setData] = useState<ReportsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [slowLoading, setSlowLoading] = useState(false);
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

  // Silent one-time fetch of school list so the filter dropdown stays populated even if report summary is loading/failing
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<
          | {
              schools?: Array<{
                id: number;
                name: string;
                currentBillingRange?: { shortLabelAr?: string };
              }>;
            }
          | Array<{
              id: number;
              name: string;
              currentBillingRange?: { shortLabelAr?: string };
            }>
        >('/api/schools');
        if (cancelled) return;
        const list = Array.isArray(res) ? res : res?.schools || [];
        const filtered =
          !isSuperAdmin && restrictedSchoolIds.length > 0
            ? list.filter((s) => restrictedSchoolIds.includes(s.id))
            : list;
        const mapped: SchoolFilterOption[] = filtered.map((s) => ({
          id: s.id,
          name: s.name,
          shortLabelAr: s.currentBillingRange?.shortLabelAr,
        }));
        setSchoolOptions((prev) => mergeSchoolOptions(prev, mapped));
        setSchoolOptionsLoaded(true);
      } catch {
        // Silent by design: user may not have schools:read permission; fallback populates from summary response
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSuperAdmin, restrictedSchoolIds]);

  const loadReports = useCallback(async () => {
    const seq = ++requestSeqRef.current;
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
      if (seq !== requestSeqRef.current) return;

      if ((!initialPeriodSyncedRef.current || autoTodayPeriodRef.current) && res.period) {
        initialPeriodSyncedRef.current = true;
        autoTodayPeriodRef.current = false;
        setMonth(res.period.month);
        setYear(res.period.year);
      }
      if (res.schoolBillingRanges && res.schoolBillingRanges.length > 0) {
        const rangeOpts: SchoolFilterOption[] = res.schoolBillingRanges.map((sb) => ({
          id: sb.schoolId,
          name: sb.schoolName,
          shortLabelAr: sb.range?.shortLabelAr,
        }));
        setSchoolOptions((prev) => mergeSchoolOptions(prev, rangeOpts));
        setSchoolOptionsLoaded(true);
      } else if (res.schools && res.schools.length > 0) {
        const schoolFallbackOpts: SchoolFilterOption[] = res.schools.map((s) => ({
          id: s.id,
          name: s.name,
        }));
        setSchoolOptions((prev) => mergeSchoolOptions(prev, schoolFallbackOpts));
        setSchoolOptionsLoaded(true);
      }
      setData(res);
    } catch (err: unknown) {
      if (seq !== requestSeqRef.current) return;
      autoTodayPeriodRef.current = false;
      setError(err instanceof Error ? err.message : 'تعذر تحميل بيانات التقارير');
    } finally {
      if (seq === requestSeqRef.current) {
        setLoading(false);
      }
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

  // Verify saved localStorage schoolId exists once options are known; otherwise fall back to 'all'
  useEffect(() => {
    if (isSingleSchoolRestricted) return;
    if (!schoolOptionsLoaded || schoolOptions.length === 0) return;
    if (
      selectedSchoolId !== 'all' &&
      !schoolOptions.some((opt) => String(opt.id) === selectedSchoolId)
    ) {
      setSelectedSchoolId('all');
      try {
        window.localStorage.setItem(REPORTS_SCHOOL_STORAGE_KEY, 'all');
      } catch {
        // ignore
      }
    }
  }, [isSingleSchoolRestricted, schoolOptionsLoaded, schoolOptions, selectedSchoolId]);

  // 15-second slow-loading warning timer
  useEffect(() => {
    if (!loading) {
      setSlowLoading(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setSlowLoading(true);
    }, 15000);
    return () => window.clearTimeout(timer);
  }, [loading]);

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

  const sortedSalaries = data
    ? [...data.salaries].sort((a, b) => {
        const dA = driverById[a.driverId];
        const dB = driverById[b.driverId];
        return compareSchoolAndBus(
          {
            schoolId: dA?.schoolId ?? a.schoolId,
            schoolName: dA?.schoolName ?? a.schoolName,
            busNumber: dA?.busNumber ?? a.busNumber,
            vehicleId: dA ? dA.vehicleId : undefined,
          },
          {
            schoolId: dB?.schoolId ?? b.schoolId,
            schoolName: dB?.schoolName ?? b.schoolName,
            busNumber: dB?.busNumber ?? b.busNumber,
            vehicleId: dB ? dB.vehicleId : undefined,
          }
        );
      })
    : [];

  const groupedSalaries = groupBySchoolSortedByBus(
    sortedSalaries.map((s) => {
      const d = driverById[s.driverId];
      return {
        ...s,
        schoolId: d?.schoolId ?? s.schoolId,
        schoolName: d?.schoolName ?? s.schoolName,
        busNumber: d?.busNumber ?? s.busNumber,
        vehicleId: d ? d.vehicleId : undefined,
      };
    })
  );

  const sortedSupervisors = data?.supervisors
    ? [...data.supervisors].sort(compareSchoolAndBus)
    : [];
  const groupedSupervisors = groupBySchoolSortedByBus(sortedSupervisors);

  const handleExportExcel = () => {
    if (!data) return;
    if (reportType === 'salaries' || reportType === 'statements') {
      exportRowsToExcel(
        `alwaleed-salaries-${year}-${month}`,
        [
          'كود السائق',
          'الاسم',
          'الباص',
          'المدرسة',
          'الأساسي',
          'السلف',
          'خصم التغطيات (-)',
          'مستحق التغطيات (+)',
          'خصومات أخرى',
          'المكافآت',
          'الصافي',
        ],
        sortedSalaries.map((s) => {
          const d = driverById[s.driverId];
          return [
            d?.driverCode || '',
            d?.fullName || '',
            formatBusBadgeLabel(d?.busNumber ?? s.busNumber, d?.vehicleId),
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
        ['الكود', 'المشرفة', 'الباص', 'المدرسة', 'نطاق الدورة', 'رحلات الصباح', 'رحلات المساء', 'أيام مكتملة', 'الراتب الشهري'],
        sortedSupervisors.map((sv) => [
          sv.supervisorCode,
          sv.fullName,
          formatBusBadgeLabel(sv.busNumber, sv.vehicleId),
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
        [
          'المدرسة',
          'قيمة العقد الشهري',
          'عدد الباصات',
          'الرواتب الأساسية',
          'السلف',
          'خصم التغطيات',
          'مستحق التغطيات',
          'صافي الفرق',
          'الهامش الفعلي (ج)',
          'الهامش الفعلي (%)',
          'التقييم',
          'الصافي بعد السلف والتغطيات (ج) - للمعلومة',
          'الصافي بعد السلف والتغطيات (%) - للمعلومة',
        ],
        schoolProfitRows.map((row) => [
          row.school.name,
          row.contractValue,
          row.busCount,
          row.baseSalaries,
          row.advances,
          row.coverageDeductions,
          row.coverageAdditions,
          row.difference,
          row.actualMargin,
          row.actualMarginPct !== null ? Number(row.actualMarginPct.toFixed(1)) : '—',
          row.actualMarginPct !== null ? row.rating.label : '—',
          row.netAfterAdvances,
          row.netAfterAdvancesPct !== null ? Number(row.netAfterAdvancesPct.toFixed(1)) : '—',
        ])
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

  const schoolProfitRows = useMemo(() => {
    if (!data) return [];
    const byDriver: Record<number, EnrichedDriver> = {};
    for (const d of data.drivers) byDriver[d.id] = d;

    return data.schools.map((s) => {
      const busCount = data.fleet.filter((v) => v.schoolId === s.id).length;
      const schoolSalaries = data.salaries.filter(
        (sal) => (byDriver[sal.driverId]?.schoolId ?? sal.schoolId) === s.id
      );

      const contractValue = Number(s.monthlyContractValue || 0);
      const baseSalaries = schoolSalaries.reduce((sum, sal) => sum + Number(sal.baseSalary || 0), 0);
      const advances = schoolSalaries.reduce((sum, sal) => sum + Number(sal.totalAdvances || 0), 0);
      const coverageDeductions = schoolSalaries.reduce(
        (sum, sal) => sum + Number(sal.totalCoverageDeductions || 0),
        0
      );
      const coverageAdditions = schoolSalaries.reduce(
        (sum, sal) => sum + Number(sal.totalCoverageAdditions || 0),
        0
      );
      const bonuses = schoolSalaries.reduce((sum, sal) => sum + Number(sal.bonuses || 0), 0);
      const otherDeductions = schoolSalaries.reduce(
        (sum, sal) => sum + Number(sal.otherDeductions || 0),
        0
      );
      const netSalaries = schoolSalaries.reduce((sum, sal) => sum + Number(sal.netSalary || 0), 0);

      const actualMargin = contractValue - baseSalaries;
      const actualMarginPct = contractValue > 0 ? (actualMargin / contractValue) * 100 : null;
      const netAfterAdvances = contractValue - netSalaries;
      const netAfterAdvancesPct =
        contractValue > 0 ? (netAfterAdvances / contractValue) * 100 : null;
      const difference =
        advances + coverageDeductions - coverageAdditions - bonuses + otherDeductions;
      const rating = getMarginRating(actualMarginPct, marginThresholds);

      return {
        school: s,
        busCount,
        contractValue,
        baseSalaries,
        advances,
        coverageDeductions,
        coverageAdditions,
        bonuses,
        otherDeductions,
        netSalaries,
        actualMargin,
        actualMarginPct,
        netAfterAdvances,
        netAfterAdvancesPct,
        difference,
        rating,
      };
    });
  }, [data, marginThresholds]);

  const profitTotals = useMemo(() => {
    const sums = schoolProfitRows.reduce(
      (acc, r) => ({
        contractValue: acc.contractValue + r.contractValue,
        busCount: acc.busCount + r.busCount,
        baseSalaries: acc.baseSalaries + r.baseSalaries,
        advances: acc.advances + r.advances,
        coverageDeductions: acc.coverageDeductions + r.coverageDeductions,
        coverageAdditions: acc.coverageAdditions + r.coverageAdditions,
        bonuses: acc.bonuses + r.bonuses,
        otherDeductions: acc.otherDeductions + r.otherDeductions,
        netSalaries: acc.netSalaries + r.netSalaries,
        actualMargin: acc.actualMargin + r.actualMargin,
        netAfterAdvances: acc.netAfterAdvances + r.netAfterAdvances,
        difference: acc.difference + r.difference,
      }),
      {
        contractValue: 0,
        busCount: 0,
        baseSalaries: 0,
        advances: 0,
        coverageDeductions: 0,
        coverageAdditions: 0,
        bonuses: 0,
        otherDeductions: 0,
        netSalaries: 0,
        actualMargin: 0,
        netAfterAdvances: 0,
        difference: 0,
      }
    );

    const actualMarginPct =
      sums.contractValue > 0 ? (sums.actualMargin / sums.contractValue) * 100 : null;
    const netAfterAdvancesPct =
      sums.contractValue > 0 ? (sums.netAfterAdvances / sums.contractValue) * 100 : null;
    const rating = getMarginRating(actualMarginPct, marginThresholds);

    return {
      ...sums,
      actualMarginPct,
      netAfterAdvancesPct,
      rating,
    };
  }, [schoolProfitRows, marginThresholds]);

  const selectedSchoolOption = schoolOptions.find((o) => String(o.id) === selectedSchoolId);
  const activeSchoolName =
    data?.period?.schoolName || (selectedSchoolId !== 'all' ? selectedSchoolOption?.name || null : null);

  const handleSendReportToWhatsApp = async () => {
    if (!reportCaptureRef.current || !data) return;
    setSharingWhatsApp(true);
    setError(null);
    try {
      const captureWidth =
        reportType === 'schools' || reportType === 'profitability' ? 1200 : 1020;
      const blob = await captureElementAsPngBlob(reportCaptureRef.current, {
        width: captureWidth,
        backgroundColor: '#ffffff',
      });
      const label = reportTabs.find((r) => r.id === reportType)?.label || 'تقرير';
      const filename = `تقرير-${reportType}-${month}-${year}.png`;
      const schoolLabel = data.period?.schoolName ? ` — ${data.period.schoolName}` : '';
      const rangeLabel = data.period?.labelAr ? ` — ${data.period.labelAr}` : ` (شهر ${month}/${year})`;
      const caption = `الوليد ترافيل — ${label}${schoolLabel}${rangeLabel}`;
      const whatsappUrl = buildWhatsAppUrl('', caption);

      const copied = await copyPngBlobToClipboard(blob);
      clearWhatsappPreview();
      const url = URL.createObjectURL(blob);
      setWhatsappPreview({
        blob,
        url,
        filename,
        copied,
        statusText: copied
          ? 'تم تجهيز صورة التقرير كاملة ونسخها للحافظة — راجع المعاينة ثم اضغط تحميل الصورة أو فتح واتساب.'
          : 'تم تجهيز صورة التقرير كاملة — راجع المعاينة ثم اضغط تحميل الصورة أو فتح واتساب.',
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
            onChange={(e) => {
              const nextId = e.target.value;
              setSelectedSchoolId(nextId);
              if (!isSingleSchoolRestricted) {
                try {
                  window.localStorage.setItem(REPORTS_SCHOOL_STORAGE_KEY, nextId);
                } catch {
                  // ignore storage errors
                }
              }
            }}
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
            {schoolOptions.map((sb) => (
              <option key={sb.id} value={String(sb.id)}>
                {sb.name}
                {sb.shortLabelAr ? ` (${sb.shortLabelAr})` : ''}
              </option>
            ))}
            {isSingleSchoolRestricted &&
              !schoolOptions.some((sb) => String(sb.id) === String(restrictedSchoolIds[0])) && (
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

      {error && data && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-800 flex items-center justify-between gap-2 no-print">
          <span>{error}</span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={loadReports}
              className="inline-flex items-center gap-1 rounded-lg bg-white border border-red-200 px-2.5 py-1 text-[11px] font-bold text-red-800 hover:bg-red-100 cursor-pointer"
            >
              <RefreshCw className="w-3 h-3" />
              إعادة المحاولة
            </button>
            <button
              type="button"
              onClick={() => setError(null)}
              aria-label="إغلاق التنبيه"
              className="p-1 text-red-500 hover:text-red-800 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
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
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/70 p-3 sm:p-5 backdrop-blur-xs">
          <div className="w-full max-w-4xl max-h-[92vh] bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden flex flex-col text-xs">
            <div className="px-5 py-3.5 bg-[#0B1F3A] text-white flex items-center justify-between gap-3 shrink-0">
              <div className="flex items-center gap-2">
                <MessageCircle className="w-4 h-4 text-[#25D366]" />
                <span className="font-display font-bold text-sm">
                  معاينة صورة التقرير الكاملة قبل الإرسال / التحميل
                </span>
              </div>
              <button
                type="button"
                onClick={clearWhatsappPreview}
                aria-label="إغلاق المعاينة"
                className="text-slate-300 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 sm:p-5 overflow-y-auto bg-slate-100 space-y-4">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 font-semibold text-emerald-900">
                {whatsappPreview.statusText}
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-2 shadow-xs">
                <img
                  src={whatsappPreview.url}
                  alt="معاينة صورة التقرير"
                  className="w-full h-auto block rounded-lg bg-white"
                />
              </div>
            </div>
            <div className="px-5 py-3.5 border-t border-slate-200 bg-white flex flex-wrap items-center justify-between gap-2 shrink-0">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => downloadBlob(whatsappPreview.blob, whatsappPreview.filename)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#0B1F3A] hover:bg-[#13325c] px-4 py-2 text-xs font-bold text-white cursor-pointer"
                >
                  <Download className="w-4 h-4 text-[#C89B3C]" />
                  تحميل الصورة (PNG)
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const copied = await copyPngBlobToClipboard(whatsappPreview.blob);
                    setWhatsappPreview((prev) => (prev ? { ...prev, copied } : null));
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 px-3.5 py-2 text-xs font-semibold text-[#0B1F3A] cursor-pointer"
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
                  onClick={async () => {
                    await shareImageFileViaWebShare(
                      whatsappPreview.blob,
                      whatsappPreview.filename,
                      'تقرير الوليد ترافيل',
                      whatsappPreview.filename
                    );
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 hover:bg-emerald-100 px-3.5 py-2 text-xs font-bold text-emerald-900 cursor-pointer"
                >
                  مشاركة مباشرة بالصورة
                </button>
              </div>
              <a
                href={whatsappPreview.whatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#25D366] px-4 py-2 text-xs font-bold text-white hover:bg-[#1ebe5d]"
              >
                <MessageCircle className="w-4 h-4" />
                فتح واتساب وإرسال الصورة
              </a>
            </div>
          </div>
        </div>
      )}

      <div ref={reportCaptureRef} dir="rtl" className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-base font-bold text-[#0B1F3A]">
              الوليد ترافيل — {reportTabs.find((r) => r.id === reportType)?.label}
              {activeSchoolName ? ` (${activeSchoolName})` : ''}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
              الفترة: شهر {month} / {year}
              {activeSchoolName ? ` · المدرسة: ${activeSchoolName}` : ''}
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

        {loading ? (
          <div className="p-10 text-center space-y-2">
            <div className="inline-flex items-center gap-2 text-xs font-semibold text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin text-[#0B1F3A]" />
              <span>جاري تجهيز التقرير...</span>
            </div>
            {slowLoading && (
              <p className="text-xs font-semibold text-amber-700">
                التحميل أبطأ من المعتاد. جرّب تختار مدرسة واحدة
              </p>
            )}
          </div>
        ) : error && !data ? (
          <div className="p-10 text-center space-y-3">
            <p className="text-xs font-semibold text-red-700">{error}</p>
            <button
              type="button"
              onClick={loadReports}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#0B1F3A] hover:bg-[#13325c] px-4 py-2 text-xs font-bold text-white cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5 text-[#C89B3C]" />
              إعادة المحاولة
            </button>
          </div>
        ) : !data ? (
          <div className="p-10 text-center text-xs text-slate-400">لا توجد بيانات للعرض</div>
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
                  {groupedSalaries.map((grp) => (
                    <React.Fragment key={grp.schoolKey}>
                      {groupedSalaries.length > 1 && (
                        <tr className="bg-slate-100/80 border-y border-slate-200">
                          <td colSpan={8} className="py-2 px-4 font-bold text-[#0B1F3A] text-xs">
                            {grp.schoolName} ({grp.items.length})
                          </td>
                        </tr>
                      )}
                      {grp.items.map((s) => {
                        const d = driverById[s.driverId];
                        const busLabel = formatBusBadgeLabel(s.busNumber, s.vehicleId);
                        return (
                          <tr key={s.id}>
                            <td className="py-3 px-4 font-mono font-bold">{d?.driverCode}</td>
                            <td className="py-3 px-4">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="font-semibold">{d?.fullName}</span>
                                <span
                                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${
                                    busLabel === 'بدون باص حالي'
                                      ? 'bg-slate-100 text-slate-500'
                                      : 'bg-amber-50 text-[#0B1F3A] border border-amber-200'
                                  }`}
                                >
                                  {busLabel}
                                </span>
                              </div>
                            </td>
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
                    </React.Fragment>
                  ))}
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
                  {sortedSupervisors.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-slate-400">
                        لا توجد مشرفات مسجلات في هذا النطاق
                      </td>
                    </tr>
                  ) : (
                    groupedSupervisors.map((grp) => (
                      <React.Fragment key={grp.schoolKey}>
                        {groupedSupervisors.length > 1 && (
                          <tr className="bg-slate-100/80 border-y border-slate-200">
                            <td colSpan={8} className="py-2 px-4 font-bold text-[#0B1F3A] text-xs">
                              {grp.schoolName} ({grp.items.length})
                            </td>
                          </tr>
                        )}
                        {grp.items.map((sv) => {
                          const busLabel = formatBusBadgeLabel(sv.busNumber, sv.vehicleId);
                          return (
                            <tr key={sv.supervisorId}>
                              <td className="py-3 px-4 font-mono font-bold">{sv.supervisorCode}</td>
                              <td className="py-3 px-4">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="font-semibold">{sv.fullName}</span>
                                  <span
                                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${
                                      busLabel === 'بدون باص حالي'
                                        ? 'bg-slate-100 text-slate-500'
                                        : 'bg-amber-50 text-[#0B1F3A] border border-amber-200'
                                    }`}
                                  >
                                    {busLabel}
                                  </span>
                                </div>
                              </td>
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
                          );
                        })}
                      </React.Fragment>
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
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
                  <div className="border border-slate-200 rounded-xl p-4 bg-white">
                    <div className="text-slate-500">إيرادات العقود</div>
                    <div className="mt-1 font-mono text-lg font-bold text-[#0B1F3A] tabular-nums">
                      {formatEGP(profitTotals.contractValue)}
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500 tabular-nums">
                      {schoolProfitRows.length} مدرسة · {profitTotals.busCount} باص
                    </div>
                  </div>

                  <div className="border border-slate-200 rounded-xl p-4 bg-white">
                    <div className="text-slate-500">الرواتب الأساسية</div>
                    <div className="mt-1 font-mono text-lg font-bold text-red-700 tabular-nums">
                      {formatEGP(profitTotals.baseSalaries)}
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500 tabular-nums">
                      الصافي المنصرف للسائقين: {formatEGP(profitTotals.netSalaries)}
                    </div>
                  </div>

                  <div className="bg-[#0B1F3A] text-white rounded-xl p-4">
                    <div className="text-slate-300 font-semibold">الهامش الفعلي</div>
                    <div
                      className={`mt-1 font-mono text-lg font-bold tabular-nums ${
                        profitTotals.actualMargin >= 0 ? 'text-[#C89B3C]' : 'text-red-300'
                      }`}
                    >
                      {formatEGP(profitTotals.actualMargin)}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span className="text-[11px] text-slate-200 font-mono tabular-nums" dir="ltr">
                        {formatPct(profitTotals.actualMarginPct)}
                      </span>
                      {profitTotals.actualMarginPct !== null ? (
                        <span
                          className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-bold ${profitTotals.rating.badgeClassName}`}
                        >
                          {profitTotals.rating.label}
                        </span>
                      ) : (
                        <span className="text-[11px] text-slate-400">—</span>
                      )}
                    </div>
                  </div>

                  <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/70">
                    <div className="text-slate-500">الصافي بعد السلف والتغطيات (للمعلومة فقط)</div>
                    <div className="mt-1 font-mono text-base font-semibold text-slate-700 tabular-nums">
                      {formatEGP(profitTotals.netAfterAdvances)}
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500 tabular-nums">
                      نسبة من العقود:{' '}
                      <span dir="ltr" className="font-mono font-semibold text-slate-700">
                        {formatPct(profitTotals.netAfterAdvancesPct)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Explicit breakdown of the difference between Actual Margin and Net After Advances */}
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] text-slate-700 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-bold text-[#0B1F3A]">
                      الفرق بين الهامش الفعلي والصافي بعد السلف والتغطيات:
                    </span>
                    <span className="font-mono font-bold text-[#0B1F3A] tabular-nums">
                      {formatEGP(profitTotals.difference)}
                    </span>
                  </div>
                  <div className="text-slate-600 tabular-nums">
                    السلف ({formatEGP(profitTotals.advances)}) + خصم التغطيات (
                    {formatEGP(profitTotals.coverageDeductions)}) − مستحق التغطيات (
                    {formatEGP(profitTotals.coverageAdditions)}) − المكافآت (
                    {formatEGP(profitTotals.bonuses)}) + الخصومات الأخرى (
                    {formatEGP(profitTotals.otherDeductions)})
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-right text-xs border border-slate-200">
                    <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                      <tr>
                        <th className="py-3 px-3 whitespace-nowrap">المدرسة</th>
                        <th className="py-3 px-3 whitespace-nowrap">قيمة العقد</th>
                        <th className="py-3 px-3 whitespace-nowrap">عدد الباصات</th>
                        <th className="py-3 px-3 whitespace-nowrap">الرواتب الأساسية</th>
                        <th className="py-3 px-3 whitespace-nowrap">السلف</th>
                        <th className="py-3 px-3 whitespace-nowrap">التغطيات (الخصم / المستحق)</th>
                        <th className="py-3 px-3 whitespace-nowrap font-bold text-[#0B1F3A]">الهامش الفعلي (ج)</th>
                        <th className="py-3 px-3 whitespace-nowrap font-bold text-[#0B1F3A]">الهامش الفعلي (%)</th>
                        <th className="py-3 px-3 whitespace-nowrap font-bold text-[#0B1F3A]">التقييم</th>
                        <th className="py-3 px-3 whitespace-nowrap text-slate-500 font-medium">
                          الصافي بعد السلف والتغطيات (للمعلومة)
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {schoolProfitRows.length === 0 ? (
                        <tr>
                          <td colSpan={10} className="py-8 text-center text-slate-400">
                            لا توجد مدارس مسجلة في هذا النطاق
                          </td>
                        </tr>
                      ) : (
                        schoolProfitRows.map((row) => {
                          const coverageNet = row.coverageDeductions - row.coverageAdditions;
                          return (
                            <tr key={row.school.id} className="hover:bg-slate-50/70">
                              <td className="py-3 px-3 font-semibold text-[#0B1F3A] whitespace-nowrap">
                                {row.school.name}
                              </td>
                              <td className="py-3 px-3 font-mono tabular-nums whitespace-nowrap">
                                {formatEGP(row.contractValue)}
                              </td>
                              <td className="py-3 px-3 font-mono tabular-nums whitespace-nowrap">
                                {row.busCount}
                              </td>
                              <td className="py-3 px-3 font-mono tabular-nums text-red-700 whitespace-nowrap">
                                {formatEGP(row.baseSalaries)}
                              </td>
                              <td className="py-3 px-3 font-mono tabular-nums text-slate-700 whitespace-nowrap">
                                {formatEGP(row.advances)}
                              </td>
                              <td className="py-3 px-3 font-mono tabular-nums whitespace-nowrap">
                                {row.coverageDeductions === 0 && row.coverageAdditions === 0 ? (
                                  <span className="text-slate-400">{formatEGP(0)}</span>
                                ) : (
                                  <div className="space-y-0.5">
                                    {row.coverageDeductions > 0 && (
                                      <div className="text-red-700">
                                        خصم: {formatEGP(row.coverageDeductions)}
                                      </div>
                                    )}
                                    {row.coverageAdditions > 0 && (
                                      <div className="text-emerald-700">
                                        مستحق: {formatEGP(row.coverageAdditions)}
                                      </div>
                                    )}
                                    <div className="text-[10px] text-slate-500">
                                      صافي: {coverageNet >= 0 ? '+' : ''}
                                      {formatEGP(coverageNet)}
                                    </div>
                                  </div>
                                )}
                              </td>
                              <td
                                className={`py-3 px-3 font-mono font-bold tabular-nums whitespace-nowrap ${
                                  row.actualMargin >= 0 ? 'text-[#0B1F3A]' : 'text-red-700'
                                }`}
                              >
                                {formatEGP(row.actualMargin)}
                              </td>
                              <td className="py-3 px-3 font-mono font-bold text-[#0B1F3A] tabular-nums whitespace-nowrap">
                                <span dir="ltr">{formatPct(row.actualMarginPct)}</span>
                              </td>
                              <td className="py-3 px-3 whitespace-nowrap">
                                {row.actualMarginPct !== null ? (
                                  <span
                                    className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-bold ${row.rating.badgeClassName}`}
                                  >
                                    {row.rating.label}
                                  </span>
                                ) : (
                                  <span className="text-slate-400">—</span>
                                )}
                              </td>
                              <td className="py-3 px-3 font-mono tabular-nums whitespace-nowrap text-slate-500">
                                <div className="font-medium text-slate-600">
                                  {formatEGP(row.netAfterAdvances)}
                                </div>
                                <div className="text-[11px] text-slate-400" dir="ltr">
                                  {formatPct(row.netAfterAdvancesPct)}
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                    {schoolProfitRows.length > 0 && (
                      <tfoot className="bg-slate-100 border-t-2 border-slate-200 font-bold text-[#0B1F3A]">
                        <tr>
                          <td className="py-3 px-3 whitespace-nowrap">الإجمالي</td>
                          <td className="py-3 px-3 font-mono tabular-nums whitespace-nowrap">
                            {formatEGP(profitTotals.contractValue)}
                          </td>
                          <td className="py-3 px-3 font-mono tabular-nums whitespace-nowrap">
                            {profitTotals.busCount}
                          </td>
                          <td className="py-3 px-3 font-mono tabular-nums text-red-700 whitespace-nowrap">
                            {formatEGP(profitTotals.baseSalaries)}
                          </td>
                          <td className="py-3 px-3 font-mono tabular-nums whitespace-nowrap">
                            {formatEGP(profitTotals.advances)}
                          </td>
                          <td className="py-3 px-3 font-mono tabular-nums whitespace-nowrap">
                            {formatEGP(profitTotals.coverageDeductions - profitTotals.coverageAdditions)}
                          </td>
                          <td
                            className={`py-3 px-3 font-mono tabular-nums whitespace-nowrap ${
                              profitTotals.actualMargin >= 0 ? 'text-[#0B1F3A]' : 'text-red-700'
                            }`}
                          >
                            {formatEGP(profitTotals.actualMargin)}
                          </td>
                          <td className="py-3 px-3 font-mono tabular-nums whitespace-nowrap">
                            <span dir="ltr">{formatPct(profitTotals.actualMarginPct)}</span>
                          </td>
                          <td className="py-3 px-3 whitespace-nowrap">
                            {profitTotals.actualMarginPct !== null ? (
                              <span
                                className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-bold ${profitTotals.rating.badgeClassName}`}
                              >
                                {profitTotals.rating.label}
                              </span>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="py-3 px-3 font-mono font-medium tabular-nums whitespace-nowrap text-slate-600">
                            <div>{formatEGP(profitTotals.netAfterAdvances)}</div>
                            <div className="text-[11px] text-slate-500" dir="ltr">
                              {formatPct(profitTotals.netAfterAdvancesPct)}
                            </div>
                          </td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>

                {/* Rating thresholds legend & explanatory footnotes */}
                <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 text-[11px] text-slate-600">
                  <div className="flex flex-wrap items-center gap-1.5 text-slate-700">
                    <span className="font-bold text-[#0B1F3A]">
                      التقييم على الهامش الفعلي (قيمة العقد − الرواتب الأساسية). الصافي بعد السلف والتغطيات للمعلومة فقط:
                    </span>
                    <span className="font-semibold text-red-900">خسارة &lt; 0%</span>
                    <span>·</span>
                    <span className="font-semibold text-red-700">
                      ضعيف جدًا &lt; {marginThresholds.veryWeakMax}%
                    </span>
                    <span>·</span>
                    <span className="font-semibold text-orange-700">
                      ضعيف {marginThresholds.veryWeakMax}%–&lt;{marginThresholds.weakMax}%
                    </span>
                    <span>·</span>
                    <span className="font-semibold text-emerald-700">
                      جيد {marginThresholds.weakMax}%–&lt;{marginThresholds.goodMax}%
                    </span>
                    <span>·</span>
                    <span className="font-semibold text-emerald-900">
                      ممتاز ≥ {marginThresholds.goodMax}%
                    </span>
                  </div>
                  <p>
                    السلف وخصم التغطيات بيقلّلوا اللي هتدفعه للسواقين لكن مش ربح؛ الهامش الفعلي هو الأساس للمقارنة
                  </p>
                  <p className="text-slate-500">
                    ملاحظة: رواتب المشرفات والموظفين غير داخلة في هذا الحساب (نفس منطق الهامش على مستوى العقود والسائقين).
                  </p>
                </div>
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
                      <td className="py-3 px-4 font-mono font-bold">{formatBusBadgeLabel(v.busNumber)}</td>
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
