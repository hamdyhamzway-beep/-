import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  Calculator,
  CalendarCheck,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Edit3,
  Eye,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  TrendingUp,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch, formatEGP, getLocalTodayDateString } from '../../lib/api';
import { useEscapeKey } from '../../lib/useEscapeKey';
import type {
  AdvanceRecord,
  CoverageRecord,
  FinanceGrandTotals,
  FinancialTransaction,
  SalaryRecord,
  SchoolFinanceContract,
  SupervisorCycleSummaryItem,
} from '../../types';

interface ClosingSnapshotDriver {
  driverId: number;
  driverCode: string;
  fullName: string;
  schoolName: string;
  baseSalary: number;
  totalAdvances: number;
  totalCoverageDeductions: number;
  otherDeductions: number;
  bonuses: number;
  netSalary: number;
  status: string;
}

interface ClosingSnapshotEmployee {
  employeeId: number;
  employeeCode: string;
  fullName: string;
  jobTitle: string;
  monthlySalary: number;
  bonuses: number;
  deductions: number;
  netSalary: number;
}

interface ClosingSnapshotSupervisor {
  supervisorId: number;
  supervisorCode: string;
  fullName: string;
  schoolName: string;
  monthlySalary: number;
  tripsCount: number;
}

interface MonthlyClosingRecord {
  id: number;
  month: number;
  year: number;
  schoolId?: number | null;
  schoolName?: string | null;
  cycleStartDate?: string | null;
  cycleEndDate?: string | null;
  driversCount: number;
  employeesCount: number;
  totalDriverSalaries: string | number;
  totalEmployeeSalaries: string | number;
  totalAdvances: string | number;
  totalCoverageDeductions: string | number;
  totalBonuses: string | number;
  totalOtherDeductions: string | number;
  totalSchoolContracts: string | number;
  netProfit: string | number;
  notes?: string;
  closedAt: string;
  snapshotJson?: {
    drivers: ClosingSnapshotDriver[];
    employees: ClosingSnapshotEmployee[];
    supervisors?: ClosingSnapshotSupervisor[];
  };
}

interface FinanceOverview {
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
    isAutoTodayPeriod?: boolean;
  };
  activePeriod?: { month: number; year: number };
  currentClosing?: MonthlyClosingRecord | null;
  closingsHistory?: MonthlyClosingRecord[];
  schoolContracts?: SchoolFinanceContract[];
  contractsSummary?: {
    schoolsCount: number;
    totalContractsValue: number;
    totalAllBaseSalaries: number;
    totalAllNetSalaries: number;
    totalAllProfit: number;
  };
  grandTotals?: FinanceGrandTotals;
  salaries: SalaryRecord[];
  supervisors?: SupervisorCycleSummaryItem[];
  advances: AdvanceRecord[];
  coverages: CoverageRecord[];
  ledger: FinancialTransaction[];
}

type FinanceTabId = 'schools' | 'salaries' | 'advances' | 'coverage' | 'ledger' | 'closing';

export const FinanceModule: React.FC = () => {
  const { dbUser } = useAuth();
  const perms = dbUser?.permissions || [];
  const isSuperAdmin = dbUser?.roleSlug === 'super_admin' || perms.includes('*');
  const can = (perm: string) => isSuperAdmin || perms.includes('*') || perms.includes(perm);

  const canFinanceWrite = can('finance:write');
  const canFinanceRead = can('finance:read') || canFinanceWrite;
  const canAdvancesWrite = can('advances:write') || canFinanceWrite;
  const canCoverageWrite = can('coverage:write') || canFinanceWrite;
  const restrictedSchoolIds = dbUser?.assignedSchoolIds || [];
  const restrictedSchoolCount = restrictedSchoolIds.length;
  const isSingleSchoolRestricted = !isSuperAdmin && restrictedSchoolCount === 1;

  const allowedTabs: Array<{ id: FinanceTabId; label: string }> = [
    ...(canFinanceRead ? [{ id: 'schools' as const, label: 'المدارس والعقود والأرباح' }] : []),
    ...(canFinanceRead ? [{ id: 'salaries' as const, label: 'رواتب الشهر والتسويات' }] : []),
    ...(canAdvancesWrite || canFinanceRead
      ? [{ id: 'advances' as const, label: 'تسجيل وإدارة السلف' }]
      : []),
    ...(canCoverageWrite || canFinanceRead
      ? [{ id: 'coverage' as const, label: 'تغطية الغياب' }]
      : []),
    ...(canFinanceRead ? [{ id: 'ledger' as const, label: 'دفتر الأستاذ المالي' }] : []),
    ...(canFinanceWrite ? [{ id: 'closing' as const, label: 'التصفية وبداية شهر جديد' }] : []),
  ];

  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [year, setYear] = useState(new Date().getFullYear());
  const initialSyncedRef = useRef(false);
  const autoPeriodRef = useRef(false);
  const [tab, setTab] = useState<FinanceTabId>(() => allowedTabs[0]?.id || 'advances');
  const [selectedSchoolKey, setSelectedSchoolKey] = useState<string>(() =>
    isSingleSchoolRestricted ? String(restrictedSchoolIds[0]) : 'all'
  );
  const [closingSchoolId, setClosingSchoolId] = useState<string>(() =>
    isSingleSchoolRestricted ? String(restrictedSchoolIds[0]) : 'all'
  );
  const [showGrandTotalsBox, setShowGrandTotalsBox] = useState<boolean>(true);
  const [data, setData] = useState<FinanceOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Closing & Rollover state
  const [closingNotes, setClosingNotes] = useState('');
  const [markAllPaidOnClose, setMarkAllPaidOnClose] = useState(true);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  const [busyClosing, setBusyClosing] = useState(false);
  const [inspectClosing, setInspectClosing] = useState<MonthlyClosingRecord | null>(null);

  // Forms
  const [advForm, setAdvForm] = useState({
    driverQuery: '',
    amount: '',
    date: getLocalTodayDateString(),
    reason: '',
    paymentMethod: '',
    notes: '',
  });

  const [covForm, setCovForm] = useState({
    absentDriverQuery: '',
    replacementQuery: '',
    date: getLocalTodayDateString(),
    actualReplacementCost: '',
    absentDriverDeduction: '',
    reason: '',
    notes: '',
  });

  const [adjForm, setAdjForm] = useState({
    driverQuery: '',
    type: 'bonus' as 'bonus' | 'other_deduction',
    amount: '',
    description: '',
  });

  // Edit / Delete Advance state
  const [editingAdvance, setEditingAdvance] = useState<AdvanceRecord | null>(null);
  const [editAdvForm, setEditAdvForm] = useState({
    amount: '',
    date: '',
    paymentMethod: '',
    reason: '',
    notes: '',
  });
  const [savingAdvEdit, setSavingAdvEdit] = useState(false);
  const [editAdvError, setEditAdvError] = useState<string | null>(null);
  const [deletingAdvance, setDeletingAdvance] = useState<AdvanceRecord | null>(null);

  // Edit / Delete Coverage state
  const [editingCoverage, setEditingCoverage] = useState<CoverageRecord | null>(null);
  const [editCovForm, setEditCovForm] = useState({
    replacementQuery: '',
    date: '',
    actualReplacementCost: '',
    absentDriverDeduction: '',
    reason: '',
    notes: '',
  });
  const [savingCovEdit, setSavingCovEdit] = useState(false);
  const [editCovError, setEditCovError] = useState<string | null>(null);
  const [deletingCoverage, setDeletingCoverage] = useState<CoverageRecord | null>(null);

  const [deletingRecord, setDeletingRecord] = useState(false);

  // Per-school Billing Period Customization Modal
  const [billingModalSchool, setBillingModalSchool] = useState<SchoolFinanceContract | null>(null);
  const [billingForm, setBillingForm] = useState({
    cycleType: 'calendar' as 'calendar' | 'shifted',
    startDay: '1',
    endDay: '31',
    activeMonth: String(new Date().getMonth() + 1),
    activeYear: String(new Date().getFullYear()),
    customStartDate: '',
    customEndDate: '',
  });
  const [savingBillingPeriod, setSavingBillingPeriod] = useState(false);
  const [billingModalError, setBillingModalError] = useState<string | null>(null);

  useEscapeKey(
    Boolean(
      billingModalSchool ||
        inspectClosing ||
        confirmResetOpen ||
        confirmCloseOpen ||
        deletingCoverage ||
        editingCoverage ||
        deletingAdvance ||
        editingAdvance
    ),
    () => {
      if (billingModalSchool) setBillingModalSchool(null);
      else if (inspectClosing) setInspectClosing(null);
      else if (confirmResetOpen) setConfirmResetOpen(false);
      else if (confirmCloseOpen) setConfirmCloseOpen(false);
      else if (deletingCoverage) setDeletingCoverage(null);
      else if (editingCoverage) setEditingCoverage(null);
      else if (deletingAdvance) setDeletingAdvance(null);
      else if (editingAdvance) setEditingAdvance(null);
    }
  );

  const loadFinance = useCallback(
    async (overrideMonth?: number, overrideYear?: number) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (overrideMonth !== undefined && overrideYear !== undefined) {
          params.set('month', String(overrideMonth));
          params.set('year', String(overrideYear));
        } else if (initialSyncedRef.current && !autoPeriodRef.current) {
          params.set('month', String(month));
          params.set('year', String(year));
        }
        if (autoPeriodRef.current) {
          params.set('autoPeriod', 'true');
        }
        if (selectedSchoolKey !== 'all' && selectedSchoolKey !== 'unassigned') {
          params.set('schoolId', selectedSchoolKey);
        }
        const qs = params.toString();
        const url = qs ? `/api/finance/overview?${qs}` : `/api/finance/overview`;
        const fin = await apiFetch<FinanceOverview>(url);
        if (!initialSyncedRef.current || autoPeriodRef.current) {
          initialSyncedRef.current = true;
          autoPeriodRef.current = false;
          setMonth(fin.period.month);
          setYear(fin.period.year);
        }
        setData(fin);
      } catch (err: unknown) {
        autoPeriodRef.current = false;
        setError(err instanceof Error ? err.message : 'تعذر تحميل البيانات المالية');
      } finally {
        setLoading(false);
      }
    },
    [month, year, selectedSchoolKey]
  );

  const handleSelectAutoPeriodToday = () => {
    autoPeriodRef.current = true;
    loadFinance();
  };

  const openBillingPeriodModal = (sc: SchoolFinanceContract) => {
    if (sc.schoolId === null) return;
    setBillingModalError(null);
    setBillingModalSchool(sc);
    const br = sc.billingRange;
    const cycleType = br?.cycleType === 'shifted' ? 'shifted' : 'calendar';
    const startDay = br?.startDay || (cycleType === 'shifted' ? 13 : 1);
    const endDay = br?.endDay || (cycleType === 'shifted' ? Math.max(1, startDay - 1) : 31);
    setBillingForm({
      cycleType,
      startDay: String(startDay),
      endDay: String(endDay),
      activeMonth: String(br?.month || month),
      activeYear: String(br?.year || year),
      customStartDate: br?.startDate || '',
      customEndDate: br?.endDate || '',
    });
  };

  const handleSaveBillingPeriod = async (e: React.FormEvent, resetCustomOnly = false) => {
    e.preventDefault();
    if (!billingModalSchool || billingModalSchool.schoolId === null) return;
    setBillingModalError(null);
    setSavingBillingPeriod(true);
    try {
      const targetM = Number(billingForm.activeMonth) || month;
      const targetY = Number(billingForm.activeYear) || year;
      await apiFetch(`/api/schools/${billingModalSchool.schoolId}/billing-period`, {
        method: 'PUT',
        body: JSON.stringify({
          cycleType: billingForm.cycleType,
          startDay: Number(billingForm.startDay),
          endDay: Number(billingForm.endDay),
          activeMonth: targetM,
          activeYear: targetY,
          customStartDate: resetCustomOnly ? null : billingForm.customStartDate || null,
          customEndDate: resetCustomOnly ? null : billingForm.customEndDate || null,
        }),
      });
      setBillingModalSchool(null);
      initialSyncedRef.current = true;
      setMonth(targetM);
      setYear(targetY);
      setSuccessMsg(
        `تم تحديث بداية ونهاية الفترة الشهرية لمدرسة «${billingModalSchool.schoolName}» بنجاح (دورة ${targetM}/${targetY}).`
      );
      await loadFinance(targetM, targetY);
    } catch (err: unknown) {
      setBillingModalError(
        err instanceof Error ? err.message : 'تعذر حفظ إعدادات الفترة الشهرية للمدرسة'
      );
    } finally {
      setSavingBillingPeriod(false);
    }
  };

  useEffect(() => {
    loadFinance();
  }, [loadFinance]);

  useEffect(() => {
    if (isSingleSchoolRestricted && restrictedSchoolIds[0]) {
      const locked = String(restrictedSchoolIds[0]);
      setSelectedSchoolKey(locked);
      setClosingSchoolId(locked);
      return;
    }
    if (selectedSchoolKey !== 'all' && selectedSchoolKey !== 'unassigned') {
      setClosingSchoolId(selectedSchoolKey);
    }
  }, [selectedSchoolKey, isSingleSchoolRestricted, restrictedSchoolIds]);

  useEffect(() => {
    if (allowedTabs.length > 0 && !allowedTabs.some((t) => t.id === tab)) {
      setTab(allowedTabs[0].id);
    }
  }, [tab, canFinanceRead, canFinanceWrite, canAdvancesWrite, canCoverageWrite]);

  useEffect(() => {
    const start = data?.period?.startDate;
    const end = data?.period?.endDate;
    const today = getLocalTodayDateString();
    if (start && end) {
      const targetDate = today >= start && today <= end ? today : start;
      setAdvForm((f) => (f.date >= start && f.date <= end ? f : { ...f, date: targetDate }));
      setCovForm((f) => (f.date >= start && f.date <= end ? f : { ...f, date: targetDate }));
      return;
    }
    const curNow = new Date();
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    const targetDate =
      month === curNow.getMonth() + 1 && year === curNow.getFullYear()
        ? today
        : `${prefix}-01`;
    setAdvForm((f) => (f.date.startsWith(prefix) ? f : { ...f, date: targetDate }));
    setCovForm((f) => (f.date.startsWith(prefix) ? f : { ...f, date: targetDate }));
  }, [month, year, data?.period?.startDate, data?.period?.endDate]);

  const handleRecordAdvance = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    try {
      const idempotencyKey = `adv-${advForm.driverQuery.trim()}-${advForm.amount}-${Date.now()}`;
      const explicitSchoolId =
        selectedSchoolKey !== 'all' && selectedSchoolKey !== 'unassigned'
          ? Number(selectedSchoolKey)
          : undefined;
      const res = await apiFetch<{
        period?: { month: number; year: number };
        billingRange?: { labelAr?: string };
      }>('/api/finance/advances', {
        method: 'POST',
        body: JSON.stringify({
          driverQuery: advForm.driverQuery.trim(),
          schoolId: explicitSchoolId,
          schoolName: selectedSchoolContract?.schoolName || undefined,
          amount: Number(advForm.amount),
          date: advForm.date,
          reason: advForm.reason,
          paymentMethod: advForm.paymentMethod,
          notes: advForm.notes,
          idempotencyKey,
        }),
      });
      setAdvForm((f) => ({ ...f, amount: '', reason: '', paymentMethod: '', notes: '' }));
      const nextM = res.period?.month ?? month;
      const nextY = res.period?.year ?? year;
      if (nextM !== month || nextY !== year) {
        initialSyncedRef.current = true;
        setMonth(nextM);
        setYear(nextY);
      }
      setSuccessMsg(
        `تم تسجيل السلفة بتاريخ ${advForm.date} (دورة ${nextM}/${nextY}) وتحديث صافي راتب السائق.`
      );
      await loadFinance(nextM, nextY);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تسجيل السلفة');
    }
  };

  const handleRecordCoverage = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    try {
      const idempotencyKey = `cov-${covForm.absentDriverQuery.trim()}-${covForm.date}-${Date.now()}`;
      const explicitSchoolId =
        selectedSchoolKey !== 'all' && selectedSchoolKey !== 'unassigned'
          ? Number(selectedSchoolKey)
          : undefined;
      const res = await apiFetch<{
        period?: { month: number; year: number };
        billingRange?: { labelAr?: string };
      }>('/api/finance/coverage', {
        method: 'POST',
        body: JSON.stringify({
          absentDriverQuery: covForm.absentDriverQuery.trim(),
          replacementQuery: covForm.replacementQuery.trim(),
          schoolId: explicitSchoolId,
          schoolName: selectedSchoolContract?.schoolName || undefined,
          date: covForm.date,
          actualReplacementCost: Number(covForm.actualReplacementCost || 0),
          absentDriverDeduction: Number(covForm.absentDriverDeduction || 0),
          reason: covForm.reason,
          notes: covForm.notes,
          idempotencyKey,
        }),
      });
      setCovForm((f) => ({
        ...f,
        replacementQuery: '',
        actualReplacementCost: '',
        absentDriverDeduction: '',
        reason: '',
        notes: '',
      }));
      const nextM = res.period?.month ?? month;
      const nextY = res.period?.year ?? year;
      if (nextM !== month || nextY !== year) {
        initialSyncedRef.current = true;
        setMonth(nextM);
        setYear(nextY);
      }
      setSuccessMsg(
        `تم تسجيل تغطية الغياب بتاريخ ${covForm.date} (دورة ${nextM}/${nextY}) وتحديث صافي راتب السائق.`
      );
      await loadFinance(nextM, nextY);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تسجيل التغطية');
    }
  };

  const handleRecordAdjustment = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    try {
      await apiFetch('/api/finance/adjustments', {
        method: 'POST',
        body: JSON.stringify({
          driverQuery: adjForm.driverQuery.trim(),
          month,
          year,
          type: adjForm.type,
          amount: Number(adjForm.amount),
          description: adjForm.description,
        }),
      });
      setAdjForm((f) => ({ ...f, amount: '', description: '' }));
      setSuccessMsg('تم تسجيل التسوية المالية وتحديث الراتب.');
      await loadFinance();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تسجيل التسوية');
    }
  };

  const handleReverse = async (targetType: 'advance' | 'coverage', targetId: number) => {
    setError(null);
    setSuccessMsg(null);
    try {
      await apiFetch('/api/finance/reverse', {
        method: 'POST',
        body: JSON.stringify({ targetType, targetId, reason: 'عكس قيد بواسطة الإدارة' }),
      });
      setSuccessMsg('تم إنشاء قيد عكسي وتحديث صافي الراتب تلقائياً.');
      await loadFinance();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تنفيذ قيد العكس');
    }
  };

  const openEditAdvance = (a: AdvanceRecord) => {
    setEditAdvError(null);
    setEditingAdvance(a);
    setEditAdvForm({
      amount: String(a.amount),
      date: a.date,
      paymentMethod: a.paymentMethod || '',
      reason: a.reason || '',
      notes: a.notes || '',
    });
  };

  const handleSaveEditAdvance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingAdvance) return;
    setEditAdvError(null);
    setSavingAdvEdit(true);
    try {
      const res = await apiFetch<{ period?: { month: number; year: number } }>(
        `/api/finance/advances/${editingAdvance.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            amount: Number(editAdvForm.amount),
            date: editAdvForm.date,
            paymentMethod: editAdvForm.paymentMethod,
            reason: editAdvForm.reason,
            notes: editAdvForm.notes,
          }),
        }
      );
      setEditingAdvance(null);
      const nextM = res.period?.month ?? month;
      const nextY = res.period?.year ?? year;
      if (nextM !== month || nextY !== year) {
        initialSyncedRef.current = true;
        setMonth(nextM);
        setYear(nextY);
      }
      setSuccessMsg('تم تعديل بيانات السلفة وإعادة احتساب صافي الراتب.');
      await loadFinance(nextM, nextY);
    } catch (err: unknown) {
      setEditAdvError(err instanceof Error ? err.message : 'تعذر تعديل السلفة');
    } finally {
      setSavingAdvEdit(false);
    }
  };

  const handleConfirmDeleteAdvance = async () => {
    if (!deletingAdvance) return;
    setDeletingRecord(true);
    setError(null);
    setSuccessMsg(null);
    try {
      await apiFetch(`/api/finance/advances/${deletingAdvance.id}`, {
        method: 'DELETE',
      });
      setDeletingAdvance(null);
      setSuccessMsg('تم حذف السلفة وتحديث صافي راتب السائق تلقائياً.');
      await loadFinance();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر حذف السلفة');
    } finally {
      setDeletingRecord(false);
    }
  };

  const openEditCoverage = (c: CoverageRecord) => {
    setEditCovError(null);
    setEditingCoverage(c);
    setEditCovForm({
      replacementQuery:
        c.replacementDriverId && c.replacementDriverName && c.replacementDriverName !== '—'
          ? c.replacementDriverName
          : c.replacementExternalName || '',
      date: c.date,
      actualReplacementCost: String(c.actualReplacementCost ?? 0),
      absentDriverDeduction: String(c.absentDriverDeduction ?? 0),
      reason: c.reason || '',
      notes: c.notes || '',
    });
  };

  const handleSaveEditCoverage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingCoverage) return;
    setEditCovError(null);
    setSavingCovEdit(true);
    try {
      const res = await apiFetch<{ period?: { month: number; year: number } }>(
        `/api/finance/coverage/${editingCoverage.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            replacementQuery: editCovForm.replacementQuery.trim(),
            date: editCovForm.date,
            actualReplacementCost: Number(editCovForm.actualReplacementCost || 0),
            absentDriverDeduction: Number(editCovForm.absentDriverDeduction || 0),
            reason: editCovForm.reason,
            notes: editCovForm.notes,
          }),
        }
      );
      setEditingCoverage(null);
      const nextM = res.period?.month ?? month;
      const nextY = res.period?.year ?? year;
      if (nextM !== month || nextY !== year) {
        initialSyncedRef.current = true;
        setMonth(nextM);
        setYear(nextY);
      }
      setSuccessMsg('تم تعديل سجل التغطية وإعادة احتساب صافي الراتب.');
      await loadFinance(nextM, nextY);
    } catch (err: unknown) {
      setEditCovError(err instanceof Error ? err.message : 'تعذر تعديل التغطية');
    } finally {
      setSavingCovEdit(false);
    }
  };

  const handleConfirmDeleteCoverage = async () => {
    if (!deletingCoverage) return;
    setDeletingRecord(true);
    setError(null);
    setSuccessMsg(null);
    try {
      await apiFetch(`/api/finance/coverage/${deletingCoverage.id}`, {
        method: 'DELETE',
      });
      setDeletingCoverage(null);
      setSuccessMsg('تم حذف سجل التغطية وإعادة احتساب صافي راتب السائق تلقائياً.');
      await loadFinance();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر حذف التغطية');
    } finally {
      setDeletingRecord(false);
    }
  };

  const handleSalaryStatus = async (salaryId: number, status: 'open' | 'approved' | 'paid') => {
    setError(null);
    try {
      await apiFetch(`/api/finance/salaries/${salaryId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      await loadFinance();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحديث حالة الراتب');
    }
  };

  const handleCloseMonthAndStartNext = async () => {
    setBusyClosing(true);
    setError(null);
    setSuccessMsg(null);
    const parsedClosingSchoolId = closingSchoolId !== 'all' ? Number(closingSchoolId) : null;
    try {
      const res = await apiFetch<{
        closing: MonthlyClosingRecord;
        nextPeriod: { month: number; year: number };
      }>('/api/finance/close-month', {
        method: 'POST',
        body: JSON.stringify({
          month,
          year,
          schoolId: parsedClosingSchoolId,
          markAllPaid: markAllPaidOnClose,
          notes: closingNotes.trim(),
        }),
      });
      setConfirmCloseOpen(false);
      setClosingNotes('');
      initialSyncedRef.current = true;
      setMonth(res.nextPeriod.month);
      setYear(res.nextPeriod.year);
      const scopeLabel = res.closing.schoolName || 'جميع المدارس';
      setSuccessMsg(
        `تمت تصفية دورة ${month}/${year} (${scopeLabel}) بنجاح وفتح دورة ${res.nextPeriod.month}/${res.nextPeriod.year} على بياض بنفس السائقين والمشرفات والمركبات.`
      );
      await loadFinance();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تنفيذ التصفية الشهرية');
    } finally {
      setBusyClosing(false);
    }
  };

  const handleResetMonthFinancials = async () => {
    setBusyClosing(true);
    setError(null);
    setSuccessMsg(null);
    const parsedClosingSchoolId = closingSchoolId !== 'all' ? Number(closingSchoolId) : null;
    try {
      await apiFetch('/api/finance/reset-month', {
        method: 'POST',
        body: JSON.stringify({
          month,
          year,
          schoolId: parsedClosingSchoolId,
          resetEmployees: true,
        }),
      });
      setConfirmResetOpen(false);
      const scopeName =
        parsedClosingSchoolId !== null
          ? schoolContracts.find((s) => s.schoolId === parsedClosingSchoolId)?.schoolName || 'المدرسة المحددة'
          : 'جميع المدارس';
      setSuccessMsg(
        `تم تصفير مالية شهر ${month}/${year} (${scopeName}) وبدؤه على بياض مع الإبقاء على جميع السائقين والمشرفات والمدارس والمركبات.`
      );
      await loadFinance();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تصفير مالية الشهر');
    } finally {
      setBusyClosing(false);
    }
  };

  const nextMonthPreview = month === 12 ? 1 : month + 1;
  const nextYearPreview = month === 12 ? year + 1 : year;
  const schoolContracts = data?.schoolContracts || [];
  const getSchoolKey = (id: number | null | undefined) =>
    id === null || id === undefined ? 'unassigned' : String(id);
  const selectedSchoolContract =
    selectedSchoolKey === 'all'
      ? null
      : schoolContracts.find((sc) => getSchoolKey(sc.schoolId) === selectedSchoolKey) || null;
  const closingTargetSchool =
    closingSchoolId === 'all'
      ? null
      : schoolContracts.find((sc) => getSchoolKey(sc.schoolId) === closingSchoolId) || null;

  const matchesSchoolFilter = (sId?: number | null) =>
    selectedSchoolKey === 'all' || getSchoolKey(sId) === selectedSchoolKey;

  const filteredSalaries = (data?.salaries || []).filter((s) => matchesSchoolFilter(s.schoolId));
  const filteredSupervisors = (data?.supervisors || []).filter((sv) =>
    matchesSchoolFilter(sv.schoolId)
  );
  const filteredAdvances = (data?.advances || []).filter((a) => matchesSchoolFilter(a.schoolId));
  const filteredCoverages = (data?.coverages || []).filter((c) => matchesSchoolFilter(c.schoolId));
  const filteredLedger = (data?.ledger || []).filter((t) => matchesSchoolFilter(t.schoolId));

  const monthTotalBase = data?.salaries.reduce((s, r) => s + Number(r.baseSalary || 0), 0) || 0;
  const monthTotalAdvances = data?.salaries.reduce((s, r) => s + Number(r.totalAdvances || 0), 0) || 0;
  const monthTotalCoverages =
    data?.salaries.reduce((s, r) => s + Number(r.totalCoverageDeductions || 0), 0) || 0;
  const monthTotalBonuses = data?.salaries.reduce((s, r) => s + Number(r.bonuses || 0), 0) || 0;
  const monthTotalOtherDed =
    data?.salaries.reduce((s, r) => s + Number(r.otherDeductions || 0), 0) || 0;
  const monthTotalNet = data?.salaries.reduce((s, r) => s + Number(r.netSalary || 0), 0) || 0;

  const totalContractsValue =
    data?.contractsSummary?.totalContractsValue ??
    schoolContracts
      .filter((c) => c.schoolId !== null && c.isActive)
      .reduce((s, c) => s + c.monthlyContractValue, 0);
  const totalContractsProfit =
    data?.contractsSummary?.totalAllProfit ?? totalContractsValue - monthTotalBase;

  // Grand Totals for ALL financial data (unfiltered full-month + filtered active view sums)
  const gt = data?.grandTotals;
  const filteredTotalBase = filteredSalaries.reduce((s, r) => s + Number(r.baseSalary || 0), 0);
  const filteredTotalAdvances = filteredSalaries.reduce(
    (s, r) => s + Number(r.totalAdvances || 0),
    0
  );
  const filteredTotalCovDed = filteredSalaries.reduce(
    (s, r) => s + Number(r.totalCoverageDeductions || 0),
    0
  );
  const filteredTotalOtherDed = filteredSalaries.reduce(
    (s, r) => s + Number(r.otherDeductions || 0),
    0
  );
  const filteredTotalBonuses = filteredSalaries.reduce((s, r) => s + Number(r.bonuses || 0), 0);
  const filteredTotalNet = filteredSalaries.reduce((s, r) => s + Number(r.netSalary || 0), 0);

  const activeAdvancesSum = filteredAdvances
    .filter((a) => !a.isReversed)
    .reduce((s, a) => s + Number(a.amount || 0), 0);
  const activeCovCostSum = filteredCoverages
    .filter((c) => !c.isReversed)
    .reduce((s, c) => s + Number(c.actualReplacementCost || 0), 0);
  const activeCovDedSum = filteredCoverages
    .filter((c) => !c.isReversed)
    .reduce((s, c) => s + Number(c.absentDriverDeduction || 0), 0);
  const ledgerCreditSum = filteredLedger
    .filter((t) => t.direction === 'credit')
    .reduce((s, t) => s + Number(t.amount || 0), 0);
  const ledgerDebitSum = filteredLedger
    .filter((t) => t.direction === 'debit')
    .reduce((s, t) => s + Number(t.amount || 0), 0);

  const displayedSchoolsList = selectedSchoolContract
    ? [selectedSchoolContract]
    : schoolContracts;
  const displayedSchoolsContractsSum = displayedSchoolsList
    .filter((c) => c.schoolId !== null && c.isActive)
    .reduce((s, c) => s + c.monthlyContractValue, 0);
  const displayedSchoolsSalariesSum = displayedSchoolsList.reduce(
    (s, c) => s + c.totalBaseSalaries,
    0
  );
  const displayedSchoolsNetSum = displayedSchoolsList.reduce(
    (s, c) => s + c.totalNetSalaries,
    0
  );
  const displayedSchoolsProfitSum = displayedSchoolsList.reduce((s, c) => s + c.profit, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#0B1F3A]">
            الإدارة المالية والمرتبات وعقود المدارس
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            تقسيم العقود حسب كل مدرسة (ربح المدرسة = قيمة العقد الشهري − مجموع رواتب السائقين) · وصافي الراتب = الأساسي − السلف − التغطية − الخصومات + المكافآت
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {!isSuperAdmin && restrictedSchoolCount > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] font-semibold text-amber-900">
              نطاق صلاحيتك: {restrictedSchoolCount} مدرسة محددة
            </div>
          )}
          <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5">
            <span className="text-[11px] text-slate-500">الشهر</span>
            <input
              type="number"
              min={1}
              max={12}
              value={month}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v >= 1 && v <= 12) {
                  initialSyncedRef.current = true;
                  setMonth(v);
                }
              }}
              className="w-12 bg-transparent font-mono text-xs font-semibold text-center focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5">
            <span className="text-[11px] text-slate-500">السنة</span>
            <input
              type="number"
              min={2020}
              max={2099}
              value={year}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v >= 2020 && v <= 2099) {
                  initialSyncedRef.current = true;
                  setYear(v);
                }
              }}
              className="w-16 bg-transparent font-mono text-xs font-semibold text-center focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={handleSelectAutoPeriodToday}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 px-3 py-2 text-xs font-bold text-[#0B1F3A] cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5 text-[#C89B3C]" />
            الفترة التلقائية لليوم
          </button>
          {canFinanceWrite && (
            <button
              type="button"
              onClick={() => setTab('closing')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#C89B3C] hover:bg-[#d8ac4e] px-3.5 py-2 text-xs font-bold text-[#0B1F3A] cursor-pointer"
            >
              <CalendarCheck className="w-4 h-4" />
              تصفية الشهر وبدء شهر جديد
            </button>
          )}
        </div>
      </div>

      {/* Active School Billing Cycle Info Strip */}
      {data?.period?.labelAr && (
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 text-[#0B1F3A] font-semibold">
            <CalendarCheck className="w-4 h-4 text-[#C89B3C] shrink-0" />
            <span>
              {selectedSchoolContract
                ? `نطاق دورة ${selectedSchoolContract.schoolName}: `
                : 'الدورة المالية المعروضة: '}
              <strong className="font-mono">{data.period.labelAr}</strong>
            </span>
          </div>
          {!selectedSchoolContract && schoolContracts.some((s) => s.billingRange) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {schoolContracts
                .filter((s) => s.schoolId !== null && s.billingRange)
                .map((s) => (
                  <span
                    key={getSchoolKey(s.schoolId)}
                    className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                      s.billingRange?.cycleType === 'shifted'
                        ? 'bg-amber-50 text-amber-800 border border-amber-200'
                        : 'bg-slate-100 text-slate-700 border border-slate-200'
                    }`}
                  >
                    {s.schoolName}: {s.billingRange?.shortLabelAr}
                  </span>
                ))}
            </div>
          )}
        </div>
      )}

      {canFinanceRead ? (
        <>
          {/* Overall School Contracts Financial Strip */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-[#0B1F3A] text-white rounded-xl p-4">
              <div className="text-[11px] text-slate-300">إجمالي عقود المدارس الشهرية</div>
              <div className="font-mono text-lg font-bold text-[#C89B3C] mt-1 tabular-nums">
                {formatEGP(totalContractsValue)}
              </div>
              <div className="text-[11px] text-slate-300 mt-1">
                {data?.contractsSummary?.schoolsCount ??
                  schoolContracts.filter((c) => c.schoolId !== null && c.isActive).length}{' '}
                مدرسة متعاقدة
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-[11px] text-slate-500">مجموع رواتب السائقين</div>
              <div className="font-mono text-lg font-bold text-[#0B1F3A] mt-1 tabular-nums">
                {formatEGP(monthTotalBase)}
              </div>
              <div className="text-[11px] text-slate-500 mt-1">
                صافي الصرف: <span className="font-mono font-semibold">{formatEGP(monthTotalNet)}</span>
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-[11px] text-slate-500">صافي ربح العقود (العقود − الرواتب)</div>
              <div
                className={`font-mono text-lg font-bold mt-1 tabular-nums ${
                  totalContractsProfit >= 0 ? 'text-emerald-700' : 'text-red-700'
                }`}
              >
                {formatEGP(totalContractsProfit)}
              </div>
              <div className="text-[11px] text-slate-500 mt-1">
                هامش{' '}
                {totalContractsValue > 0
                  ? `${Math.round((totalContractsProfit / totalContractsValue) * 1000) / 10}%`
                  : '0%'}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-[11px] text-slate-500">تصفية المدرسة الحالية</div>
              <select
                value={selectedSchoolKey}
                disabled={isSingleSchoolRestricted}
                onChange={(e) => setSelectedSchoolKey(e.target.value)}
                aria-label="تصفية حسب المدرسة"
                className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-bold text-[#0B1F3A] focus:outline-none focus:border-[#C89B3C] disabled:opacity-80"
              >
                {!isSingleSchoolRestricted && (
                  <option value="all">
                    {!isSuperAdmin && restrictedSchoolCount > 0
                      ? `جميع مدارسي (${schoolContracts.length})`
                      : `جميع المدارس (${schoolContracts.length})`}
                  </option>
                )}
                {schoolContracts.map((sc) => (
                  <option key={getSchoolKey(sc.schoolId)} value={getSchoolKey(sc.schoolId)}>
                    {sc.schoolName} ({sc.driversCount} سائق)
                  </option>
                ))}
                {isSingleSchoolRestricted &&
                  !schoolContracts.some(
                    (sc) => getSchoolKey(sc.schoolId) === String(restrictedSchoolIds[0])
                  ) && (
                    <option value={String(restrictedSchoolIds[0])}>
                      {dbUser?.assignedSchoolNames?.[0] || 'المدرسة المخصصة'}
                    </option>
                  )}
              </select>
            </div>
          </div>

          {/* خانة الجمع الإجمالي الشامل لكل البيانات المالية */}
          <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
            <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-[#0B1F3A] text-[#C89B3C] flex items-center justify-center shrink-0">
                  <Calculator className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="font-display text-sm font-bold text-[#0B1F3A]">
                    خانة الجمع الإجمالي لكل البيانات المالية — شهر {month} / {year}
                  </h2>
                  <p className="text-[11px] text-slate-500">
                    تجميع شامل لجميع الإيرادات والرواتب والسلف والتغطيات والموظفين والمشرفات ودفتر الأستاذ
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowGrandTotalsBox((v) => !v)}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 px-3 py-1.5 text-xs font-semibold text-[#0B1F3A] cursor-pointer"
              >
                <span>{showGrandTotalsBox ? 'طي الخانة' : 'عرض الجمع الإجمالي'}</span>
                {showGrandTotalsBox ? (
                  <ChevronUp className="w-3.5 h-3.5" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5" />
                )}
              </button>
            </div>

            {showGrandTotalsBox && (
              <div className="divide-y divide-slate-200">
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 divide-y sm:divide-y-0 divide-x divide-x-reverse divide-slate-100 text-xs">
                  <div className="p-3.5">
                    <div className="text-slate-500">1. إجمالي عقود المدارس</div>
                    <div className="font-mono text-sm font-bold text-[#0B1F3A] mt-1 tabular-nums">
                      {formatEGP(gt?.totalSchoolContracts ?? totalContractsValue)}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      {gt?.schoolsCount ?? 0} مدرسة نشطة
                    </div>
                  </div>

                  <div className="p-3.5">
                    <div className="text-slate-500">2. رواتب السائقين (الأساسي)</div>
                    <div className="font-mono text-sm font-bold text-[#0B1F3A] mt-1 tabular-nums">
                      {formatEGP(gt?.totalDriverBaseSalaries ?? monthTotalBase)}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                      الصافي المستحق: {formatEGP(gt?.totalDriverNetSalaries ?? monthTotalNet)}
                    </div>
                  </div>

                  <div className="p-3.5">
                    <div className="text-slate-500">3. إجمالي السلف</div>
                    <div className="font-mono text-sm font-bold text-red-700 mt-1 tabular-nums">
                      {formatEGP(gt?.totalDriverAdvances ?? monthTotalAdvances)}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
                      مخصومة من رواتب {gt?.driversCount ?? 0} سائق
                    </div>
                  </div>

                  <div className="p-3.5">
                    <div className="text-slate-500">4. التغطيات (بديل / خصم)</div>
                    <div className="font-mono text-sm font-bold text-red-700 mt-1 tabular-nums">
                      {formatEGP(gt?.totalCoverageDriverDeductions ?? monthTotalCoverages)}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                      تكلفة البديل الفعلية: {formatEGP(gt?.totalCoverageReplacementCost ?? 0)}
                    </div>
                  </div>

                  <div className="p-3.5">
                    <div className="text-slate-500">5. المكافآت والخصومات</div>
                    <div className="font-mono text-sm font-bold text-emerald-700 mt-1 tabular-nums">
                      +{formatEGP(gt?.totalBonuses ?? monthTotalBonuses)}
                    </div>
                    <div className="text-[11px] text-red-700 mt-0.5 font-mono tabular-nums">
                      خصومات أخرى: −{formatEGP(gt?.totalOtherDeductions ?? monthTotalOtherDed)}
                    </div>
                  </div>

                  <div className="p-3.5 border-t border-slate-100">
                    <div className="text-slate-500">6. الموظفون والمشرفات</div>
                    <div className="font-mono text-sm font-bold text-[#0B1F3A] mt-1 tabular-nums">
                      {formatEGP(
                        (gt?.totalEmployeeNetSalaries ?? 0) + (gt?.totalSupervisorSalaries ?? 0)
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                      {gt?.employeesCount ?? 0} موظف · {gt?.supervisorsCount ?? 0} مشرفة (
                      {formatEGP(gt?.totalSupervisorSalaries ?? 0)})
                    </div>
                  </div>

                  <div className="p-3.5 border-t border-slate-100">
                    <div className="text-slate-500">7. المنصرف vs المتبقي (سائقين)</div>
                    <div className="font-mono text-sm font-bold text-emerald-700 mt-1 tabular-nums">
                      صُرف: {formatEGP(gt?.totalPaidSalaries ?? 0)}
                    </div>
                    <div className="text-[11px] text-amber-700 font-mono mt-0.5 tabular-nums">
                      متبقي: {formatEGP(gt?.totalUnpaidSalaries ?? 0)}
                    </div>
                  </div>

                  <div className="p-3.5 border-t border-slate-100">
                    <div className="text-slate-500">8. قيود دفتر الأستاذ</div>
                    <div className="font-mono text-xs font-bold text-emerald-700 mt-1 tabular-nums">
                      دائن: +{formatEGP(gt?.totalLedgerCredits ?? 0)}
                    </div>
                    <div className="font-mono text-[11px] font-semibold text-red-700 mt-0.5 tabular-nums">
                      مدين: −{formatEGP(gt?.totalLedgerDebits ?? 0)}
                    </div>
                  </div>

                  <div className="p-3.5 border-t border-slate-100 bg-[#0B1F3A] text-white">
                    <div className="text-[11px] text-[#ebd089] font-semibold">
                      9. الجمع الإجمالي (صافي الفائض العام)
                    </div>
                    <div
                      className={`font-mono text-base font-bold mt-1 tabular-nums ${
                        (gt?.overallNetBalance ?? totalContractsProfit) >= 0
                          ? 'text-[#C89B3C]'
                          : 'text-red-300'
                      }`}
                    >
                      {formatEGP(gt?.overallNetBalance ?? totalContractsProfit)}
                    </div>
                    <div className="text-[11px] text-slate-300 mt-0.5 tabular-nums">
                      إجمالي الرواتب الكلي: {formatEGP(gt?.totalCombinedPayroll ?? monthTotalNet)}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>
        </>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-slate-600">
            تم عرض أقسام <strong className="text-[#0B1F3A]">السلف والتغطيات</strong> الخاصة بالمدارس المصرح لك بإدارتها.
          </div>
          {schoolContracts.length > 0 && (
            <select
              value={selectedSchoolKey}
              disabled={isSingleSchoolRestricted}
              onChange={(e) => setSelectedSchoolKey(e.target.value)}
              aria-label="تصفية حسب المدرسة"
              className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-[#0B1F3A] focus:outline-none focus:border-[#C89B3C] disabled:opacity-80"
            >
              {!isSingleSchoolRestricted && (
                <option value="all">جميع المدارس المتاحة ({schoolContracts.length})</option>
              )}
              {schoolContracts.map((sc) => (
                <option key={getSchoolKey(sc.schoolId)} value={getSchoolKey(sc.schoolId)}>
                  {sc.schoolName} ({sc.driversCount} سائق)
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-xl w-fit">
        {allowedTabs.map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className={`px-4 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
              tab === item.id
                ? 'bg-white text-[#0B1F3A] shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {data?.currentClosing && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-xs text-amber-900 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CalendarCheck className="w-4 h-4 text-amber-700 shrink-0" />
            <span>
              تمت تصفية شهر <strong>{month}/{year}</strong> بتاريخ{' '}
              {new Date(data.currentClosing.closedAt).toLocaleDateString('ar-EG', {
                timeZone: 'Africa/Cairo',
              })}{' '}
              — جميع بيانات وسلف وتغطيات ورواتب هذا الشهر محفوظة كما هي تماماً.
            </span>
          </div>
          {data.activePeriod &&
            (data.activePeriod.month !== month || data.activePeriod.year !== year) && (
              <button
                type="button"
                onClick={() => {
                  initialSyncedRef.current = true;
                  setMonth(data.activePeriod!.month);
                  setYear(data.activePeriod!.year);
                }}
                className="rounded-lg bg-[#0B1F3A] px-3 py-1.5 text-[11px] font-bold text-white cursor-pointer"
              >
                الانتقال للشهر المفتوح ({data.activePeriod.month}/{data.activePeriod.year})
              </button>
            )}
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-800 flex items-center justify-between gap-2">
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
      {successMsg && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-800 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{successMsg}</span>
          </div>
          <button
            type="button"
            onClick={() => setSuccessMsg(null)}
            aria-label="إغلاق التنبيه"
            className="p-1 text-emerald-600 hover:text-emerald-900 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {tab === 'schools' && (
        <div className="space-y-6">
          {/* School Quick Selector Cards */}
          <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Building2 className="w-4 h-4 text-[#C89B3C]" />
                <h2 className="font-display text-sm font-bold text-[#0B1F3A]">
                  اختر المدرسة لعرض عقودها وسائقيها وأرباحها بشكل مستقل
                </h2>
              </div>
              {selectedSchoolKey !== 'all' && !isSingleSchoolRestricted && (
                <button
                  type="button"
                  onClick={() => setSelectedSchoolKey('all')}
                  className="rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 px-3 py-1.5 text-xs font-semibold text-[#0B1F3A] cursor-pointer"
                >
                  عرض جميع المدارس ({schoolContracts.length})
                </button>
              )}
            </div>

            {loading && !data ? (
              <div className="py-8 text-center text-xs text-slate-400">
                جاري تحميل عقود المدارس وأرباحها...
              </div>
            ) : schoolContracts.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400">
                لا توجد مدارس مسجلة حالياً. يمكنك إضافة المدارس من قسم «المدارس والمركبات».
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {schoolContracts.map((sc) => {
                  const key = getSchoolKey(sc.schoolId);
                  const isSelected = selectedSchoolKey === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() =>
                        setSelectedSchoolKey(isSelected && !isSingleSchoolRestricted ? 'all' : key)
                      }
                      className={`text-right rounded-xl border p-4 transition-all cursor-pointer ${
                        isSelected
                          ? 'border-[#C89B3C] bg-[#0B1F3A] text-white shadow-md'
                          : 'border-slate-200 bg-slate-50/70 hover:bg-white hover:border-slate-300 text-[#0B1F3A]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-display text-sm font-bold truncate">
                            {sc.schoolName}
                          </div>
                          <div
                            className={`text-[11px] mt-0.5 flex flex-wrap items-center gap-1.5 ${
                              isSelected ? 'text-slate-300' : 'text-slate-500'
                            }`}
                          >
                            <Users className="w-3 h-3 text-[#C89B3C]" />
                            <span>
                              {sc.driversCount} سائق · {sc.supervisorsCount ?? 0} مشرفة
                            </span>
                            {sc.billingRange && (
                              <span
                                className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${
                                  isSelected
                                    ? 'bg-white/15 text-[#ebd089]'
                                    : sc.billingRange.cycleType === 'shifted'
                                    ? 'bg-amber-50 text-amber-800'
                                    : 'bg-slate-200/70 text-slate-700'
                                }`}
                              >
                                {sc.billingRange.shortLabelAr}
                              </span>
                            )}
                          </div>
                        </div>
                        <span
                          className={`rounded-md px-2 py-0.5 text-[10px] font-bold shrink-0 ${
                            sc.profit >= 0
                              ? isSelected
                                ? 'bg-emerald-500/20 text-emerald-200'
                                : 'bg-emerald-50 text-emerald-700'
                              : isSelected
                              ? 'bg-red-500/20 text-red-200'
                              : 'bg-red-50 text-red-700'
                          }`}
                        >
                          {sc.profit >= 0 ? 'ربح' : 'عجز'}{' '}
                          {sc.monthlyContractValue > 0 ? `${sc.profitMarginPct}%` : ''}
                        </span>
                      </div>

                      <div
                        className={`mt-3 pt-3 border-t grid grid-cols-3 gap-2 text-[11px] ${
                          isSelected ? 'border-white/15' : 'border-slate-200'
                        }`}
                      >
                        <div>
                          <div className={isSelected ? 'text-slate-300' : 'text-slate-500'}>
                            قيمة العقد
                          </div>
                          <div className="font-mono font-bold tabular-nums mt-0.5">
                            {formatEGP(sc.monthlyContractValue)}
                          </div>
                        </div>
                        <div>
                          <div className={isSelected ? 'text-slate-300' : 'text-slate-500'}>
                            مجموع الرواتب
                          </div>
                          <div className="font-mono font-bold tabular-nums mt-0.5">
                            {formatEGP(sc.totalBaseSalaries)}
                          </div>
                        </div>
                        <div>
                          <div className={isSelected ? 'text-slate-300' : 'text-slate-500'}>
                            الربح المستقل
                          </div>
                          <div
                            className={`font-mono font-bold tabular-nums mt-0.5 ${
                              sc.profit >= 0
                                ? isSelected
                                  ? 'text-[#ebd089]'
                                  : 'text-emerald-700'
                                : 'text-red-500'
                            }`}
                          >
                            {formatEGP(sc.profit)}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Independent School Contracts Detail Panels */}
          {(selectedSchoolContract ? [selectedSchoolContract] : schoolContracts).map((sc) => {
            const key = getSchoolKey(sc.schoolId);
            return (
              <section
                key={key}
                className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs"
              >
                {/* School Contract Header */}
                <div className="px-5 py-4 bg-[#0B1F3A] text-white flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-xl bg-[#C89B3C]/20 text-[#C89B3C] flex items-center justify-center shrink-0">
                      <Building2 className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-display text-base font-bold truncate">
                          {sc.schoolName}
                        </h3>
                        {sc.billingRange && (
                          <span className="rounded bg-white/10 px-2 py-0.5 text-[10px] font-mono text-[#ebd089]">
                            {sc.billingRange.labelAr}
                          </span>
                        )}
                        {!sc.isActive && (
                          <span className="rounded bg-red-500/20 px-2 py-0.5 text-[10px] text-red-200">
                            غير نشطة
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-300 mt-0.5">
                        شهر {month}/{year} · {sc.driversCount} سائق · {sc.supervisorsCount ?? 0} مشرفة (
                        {formatEGP(sc.totalSupervisorSalaries ?? 0)})
                        {sc.contactPerson ? ` · المسؤول: ${sc.contactPerson}` : ''}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {sc.schoolId !== null && (canFinanceWrite || isSuperAdmin) && (
                      <button
                        type="button"
                        onClick={() => openBillingPeriodModal(sc)}
                        className="inline-flex items-center gap-1 rounded-lg bg-[#C89B3C] hover:bg-[#d8ac4e] px-3 py-1.5 font-bold text-[#0B1F3A] cursor-pointer"
                      >
                        <CalendarCheck className="w-3.5 h-3.5" />
                        تخصيص بداية ونهاية الشهر
                      </button>
                    )}
                    <div className="rounded-lg bg-white/10 px-3 py-1.5">
                      <span className="text-slate-300">قيمة العقد: </span>
                      <span className="font-mono font-bold text-[#C89B3C]">
                        {formatEGP(sc.monthlyContractValue)}
                      </span>
                    </div>
                    <div className="rounded-lg bg-white/10 px-3 py-1.5">
                      <span className="text-slate-300">الرواتب: </span>
                      <span className="font-mono font-bold text-white">
                        {formatEGP(sc.totalBaseSalaries)}
                      </span>
                    </div>
                    <div
                      className={`rounded-lg px-3 py-1.5 font-bold ${
                        sc.profit >= 0
                          ? 'bg-emerald-500/20 text-emerald-200'
                          : 'bg-red-500/25 text-red-200'
                      }`}
                    >
                      <span>الربح: </span>
                      <span className="font-mono">{formatEGP(sc.profit)}</span>
                    </div>
                  </div>
                </div>

                {/* School Contract KPI Row */}
                <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 divide-x divide-x-reverse divide-slate-100 border-b border-slate-200 bg-slate-50/60 text-xs">
                  <div className="p-4">
                    <div className="text-slate-500">قيمة العقد الشهرية للمدرسة</div>
                    <div className="font-mono text-base font-bold text-[#0B1F3A] mt-1 tabular-nums">
                      {formatEGP(sc.monthlyContractValue)}
                    </div>
                  </div>
                  <div className="p-4">
                    <div className="text-slate-500">مجموع الرواتب الأساسية ({sc.driversCount})</div>
                    <div className="font-mono text-base font-bold text-slate-900 mt-1 tabular-nums">
                      {formatEGP(sc.totalBaseSalaries)}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      صافي الصرف: {formatEGP(sc.totalNetSalaries)}
                    </div>
                  </div>
                  <div className="p-4">
                    <div className="text-slate-500 flex items-center gap-1">
                      <TrendingUp className="w-3.5 h-3.5 text-[#C89B3C]" />
                      <span>أرباح المدرسة (العقد − الرواتب)</span>
                    </div>
                    <div
                      className={`font-mono text-base font-bold mt-1 tabular-nums ${
                        sc.profit >= 0 ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {formatEGP(sc.profit)}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      نسبة الربح:{' '}
                      <span className="font-mono font-semibold">
                        {sc.monthlyContractValue > 0 ? `${sc.profitMarginPct}%` : '—'}
                      </span>
                    </div>
                  </div>
                  <div className="p-4">
                    <div className="text-slate-500">السلف والتغطيات والتسويات</div>
                    <div className="font-mono text-xs font-semibold text-red-700 mt-1 tabular-nums">
                      سلف: {formatEGP(sc.totalAdvances)} · تغطيات:{' '}
                      {formatEGP(sc.totalCoverageDeductions)}
                    </div>
                    <div className="font-mono text-[11px] text-emerald-700 mt-0.5 tabular-nums">
                      مكافآت: +{formatEGP(sc.totalBonuses)} · خصومات: −
                      {formatEGP(sc.totalOtherDeductions)}
                    </div>
                  </div>
                </div>

                {/* Drivers linked strictly to this school */}
                <div className="overflow-x-auto">
                  <table className="w-full text-right text-xs">
                    <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                      <tr>
                        <th className="py-3 px-4 font-semibold">الكود</th>
                        <th className="py-3 px-4 font-semibold">السائق والباص والخط</th>
                        <th className="py-3 px-4 font-semibold">الراتب الأساسي</th>
                        <th className="py-3 px-4 font-semibold">السلف</th>
                        <th className="py-3 px-4 font-semibold">التغطيات</th>
                        <th className="py-3 px-4 font-semibold">خصومات أخرى</th>
                        <th className="py-3 px-4 font-semibold">المكافآت</th>
                        <th className="py-3 px-4 font-semibold">صافي المستحق</th>
                        <th className="py-3 px-4 font-semibold">الصرف وإجراءات</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {sc.drivers.length === 0 ? (
                        <tr>
                          <td colSpan={9} className="py-6 text-center text-slate-400">
                            لا يوجد سائقون معينون لهذه المدرسة حالياً في شهر {month}/{year}.
                          </td>
                        </tr>
                      ) : (
                        sc.drivers.map((d) => (
                          <tr key={d.id} className="hover:bg-slate-50/70">
                            <td className="py-3 px-4 font-mono font-bold text-[#0B1F3A]">
                              {d.driverCode}
                            </td>
                            <td className="py-3 px-4">
                              <div className="font-semibold text-slate-900">{d.driverName}</div>
                              <div className="text-[11px] text-slate-500">
                                باص {d.busNumber}
                                {d.routeName && d.routeName !== '—' ? ` · ${d.routeName}` : ''}
                              </div>
                            </td>
                            <td className="py-3 px-4 font-mono font-semibold tabular-nums">
                              {formatEGP(d.baseSalary)}
                            </td>
                            <td className="py-3 px-4 font-mono text-red-700 tabular-nums">
                              {formatEGP(d.totalAdvances)}
                            </td>
                            <td className="py-3 px-4 font-mono text-red-700 tabular-nums">
                              {formatEGP(d.totalCoverageDeductions)}
                            </td>
                            <td className="py-3 px-4 font-mono text-red-700 tabular-nums">
                              {formatEGP(d.otherDeductions)}
                            </td>
                            <td className="py-3 px-4 font-mono text-emerald-700 tabular-nums">
                              {formatEGP(d.bonuses)}
                            </td>
                            <td className="py-3 px-4 font-mono font-bold text-[#0B1F3A] tabular-nums">
                              {formatEGP(d.netSalary)}
                            </td>
                            <td className="py-3 px-4">
                              <div className="flex flex-wrap items-center gap-1.5">
                                {canFinanceWrite ? (
                                  <div className="inline-flex items-center gap-0.5 rounded-lg bg-slate-100 p-0.5">
                                    {[
                                      { value: 'open' as const, label: 'قيد التشغيل' },
                                      { value: 'approved' as const, label: 'معتمد' },
                                      { value: 'paid' as const, label: 'تم الصرف' },
                                    ].map((st) => (
                                      <button
                                        key={st.value}
                                        type="button"
                                        onClick={() => handleSalaryStatus(d.id, st.value)}
                                        className={`rounded-md px-2 py-1 text-[10px] font-semibold cursor-pointer transition-colors whitespace-nowrap ${
                                          d.status === st.value
                                            ? 'bg-[#0B1F3A] text-white'
                                            : 'text-slate-600 hover:text-slate-900'
                                        }`}
                                      >
                                        {st.label}
                                      </button>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="rounded-md bg-slate-100 px-2 py-1 text-[10px] font-semibold text-slate-700">
                                    {d.status === 'paid'
                                      ? 'تم الصرف'
                                      : d.status === 'approved'
                                      ? 'معتمد'
                                      : 'قيد التشغيل'}
                                  </span>
                                )}
                                {canAdvancesWrite && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setAdvForm((f) => ({
                                        ...f,
                                        driverQuery: d.driverCode || d.driverName || '',
                                      }));
                                      setTab('advances');
                                    }}
                                    className="rounded-md border border-slate-200 bg-white hover:bg-slate-100 px-2 py-1 text-[10px] font-semibold text-[#0B1F3A] cursor-pointer"
                                  >
                                    + سلفة
                                  </button>
                                )}
                                {canFinanceWrite && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setAdjForm((f) => ({
                                        ...f,
                                        driverQuery: d.driverCode || d.driverName || '',
                                      }));
                                      setTab('salaries');
                                    }}
                                    className="rounded-md border border-slate-200 bg-white hover:bg-slate-100 px-2 py-1 text-[10px] font-semibold text-[#0B1F3A] cursor-pointer"
                                  >
                                    تسوية
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                    {sc.drivers.length > 0 && (
                      <tfoot className="bg-slate-50 border-t-2 border-slate-200 font-bold text-[#0B1F3A]">
                        <tr>
                          <td colSpan={2} className="py-3 px-4">
                            إجمالي مدرسة {sc.schoolName} ({sc.driversCount} سائق)
                          </td>
                          <td className="py-3 px-4 font-mono tabular-nums">
                            {formatEGP(sc.totalBaseSalaries)}
                          </td>
                          <td className="py-3 px-4 font-mono text-red-700 tabular-nums">
                            {formatEGP(sc.totalAdvances)}
                          </td>
                          <td className="py-3 px-4 font-mono text-red-700 tabular-nums">
                            {formatEGP(sc.totalCoverageDeductions)}
                          </td>
                          <td className="py-3 px-4 font-mono text-red-700 tabular-nums">
                            {formatEGP(sc.totalOtherDeductions)}
                          </td>
                          <td className="py-3 px-4 font-mono text-emerald-700 tabular-nums">
                            {formatEGP(sc.totalBonuses)}
                          </td>
                          <td className="py-3 px-4 font-mono tabular-nums">
                            {formatEGP(sc.totalNetSalaries)}
                          </td>
                          <td className="py-3 px-4 font-mono tabular-nums">
                            <span
                              className={
                                sc.profit >= 0 ? 'text-emerald-700' : 'text-red-700'
                              }
                            >
                              الربح: {formatEGP(sc.profit)}
                            </span>
                          </td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </section>
            );
          })}

          {displayedSchoolsList.length > 0 && (
            <div className="rounded-2xl bg-[#0B1F3A] text-white p-5 grid grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
              <div>
                <div className="text-slate-300">الجمع الإجمالي للمدارس المعروضة</div>
                <div className="font-display text-base font-bold text-white mt-1">
                  {displayedSchoolsList.length} مدرسة
                </div>
              </div>
              <div>
                <div className="text-slate-300">إجمالي قيمة العقود</div>
                <div className="font-mono text-base font-bold text-[#C89B3C] mt-1 tabular-nums">
                  {formatEGP(displayedSchoolsContractsSum)}
                </div>
              </div>
              <div>
                <div className="text-slate-300">إجمالي الرواتب (الأساسي / الصافي)</div>
                <div className="font-mono text-base font-bold text-white mt-1 tabular-nums">
                  {formatEGP(displayedSchoolsSalariesSum)}
                </div>
                <div className="text-[11px] text-slate-300 font-mono tabular-nums">
                  صافي: {formatEGP(displayedSchoolsNetSum)}
                </div>
              </div>
              <div>
                <div className="text-slate-300">الجمع الإجمالي للأرباح</div>
                <div
                  className={`font-mono text-base font-bold mt-1 tabular-nums ${
                    displayedSchoolsProfitSum >= 0 ? 'text-emerald-300' : 'text-red-300'
                  }`}
                >
                  {formatEGP(displayedSchoolsProfitSum)}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'salaries' && (
        <div className="space-y-6">
          {/* Quick Bonus / Other Deduction Form */}
          {canFinanceWrite && (
            <form
              onSubmit={handleRecordAdjustment}
              className="bg-white border border-slate-200 rounded-xl p-5 grid grid-cols-1 sm:grid-cols-5 gap-3 items-end text-xs"
            >
              <div>
                <label className="block font-semibold text-slate-700 mb-1">السائق *</label>
                <input
                  type="text"
                  required
                  value={adjForm.driverQuery}
                  onChange={(e) => setAdjForm({ ...adjForm, driverQuery: e.target.value })}
                  placeholder="اكتب اسم أو كود السائق"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">نوع التسوية</label>
                <div className="grid grid-cols-2 gap-1.5">
                  {[
                    { value: 'bonus' as const, label: 'مكافأة (+)' },
                    { value: 'other_deduction' as const, label: 'خصم (−)' },
                  ].map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setAdjForm({ ...adjForm, type: opt.value })}
                      className={`rounded-lg border px-2 py-2 text-xs font-semibold cursor-pointer transition-colors ${
                        adjForm.type === opt.value
                          ? 'border-[#0B1F3A] bg-[#0B1F3A] text-white'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">المبلغ (ج.م)</label>
                <input
                  type="number"
                  required
                  min={1}
                  placeholder="اكتب المبلغ"
                  value={adjForm.amount}
                  onChange={(e) => setAdjForm({ ...adjForm, amount: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">السبب / البيان</label>
                <input
                  required
                  value={adjForm.description}
                  onChange={(e) => setAdjForm({ ...adjForm, description: e.target.value })}
                  placeholder="اكتب سبب التسوية"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
              <button
                type="submit"
                className="rounded-lg bg-[#0B1F3A] py-2.5 px-4 font-semibold text-white hover:bg-[#13325c] cursor-pointer"
              >
                إضافة تسوية
              </button>
            </form>
          )}

          {/* Salaries Table */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-bold text-[#0B1F3A]">
                كشف رواتب السائقين ({filteredSalaries.length})
                {selectedSchoolContract ? ` — ${selectedSchoolContract.schoolName}` : ''}
              </span>
              {selectedSchoolKey !== 'all' && !isSingleSchoolRestricted && (
                <button
                  type="button"
                  onClick={() => setSelectedSchoolKey('all')}
                  className="text-xs font-semibold text-[#C89B3C] hover:underline cursor-pointer"
                >
                  عرض جميع المدارس
                </button>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-4 font-semibold">الكود</th>
                    <th className="py-3 px-4 font-semibold">السائق والمدرسة</th>
                    <th className="py-3 px-4 font-semibold">الأساسي</th>
                    <th className="py-3 px-4 font-semibold">السلف</th>
                    <th className="py-3 px-4 font-semibold">التغطيات</th>
                    <th className="py-3 px-4 font-semibold">خصومات أخرى</th>
                    <th className="py-3 px-4 font-semibold">المكافآت</th>
                    <th className="py-3 px-4 font-semibold">صافي الراتب</th>
                    <th className="py-3 px-4 font-semibold">حالة الصرف</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {loading ? (
                    <tr>
                      <td colSpan={9} className="py-8 text-center text-slate-400">
                        جاري الحساب...
                      </td>
                    </tr>
                  ) : filteredSalaries.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="py-8 text-center text-slate-400">
                        لا توجد رواتب مطابقة للتصفية الحالية
                      </td>
                    </tr>
                  ) : (
                    filteredSalaries.map((s) => (
                      <tr key={s.id} className="hover:bg-slate-50/70">
                        <td className="py-3 px-4 font-mono font-bold text-[#0B1F3A]">
                          {s.driverCode}
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-semibold text-slate-900">{s.driverName}</div>
                          <div className="text-slate-500">
                            {s.schoolName} · {s.busNumber}
                          </div>
                        </td>
                        <td className="py-3 px-4 font-mono tabular-nums">
                          {formatEGP(s.baseSalary)}
                        </td>
                        <td className="py-3 px-4 font-mono text-red-700 tabular-nums">
                          {formatEGP(s.totalAdvances)}
                        </td>
                        <td className="py-3 px-4 font-mono text-red-700 tabular-nums">
                          {formatEGP(s.totalCoverageDeductions)}
                        </td>
                        <td className="py-3 px-4 font-mono text-red-700 tabular-nums">
                          {formatEGP(s.otherDeductions)}
                        </td>
                        <td className="py-3 px-4 font-mono text-emerald-700 tabular-nums">
                          {formatEGP(s.bonuses)}
                        </td>
                        <td className="py-3 px-4 font-mono font-bold text-[#0B1F3A] tabular-nums">
                          {formatEGP(s.netSalary)}
                        </td>
                        <td className="py-3 px-4">
                          {canFinanceWrite ? (
                            <div className="inline-flex items-center gap-1 rounded-lg bg-slate-100 p-0.5">
                              {[
                                { value: 'open' as const, label: 'قيد التشغيل' },
                                { value: 'approved' as const, label: 'معتمد' },
                                { value: 'paid' as const, label: 'تم الصرف' },
                              ].map((st) => (
                                <button
                                  key={st.value}
                                  type="button"
                                  onClick={() => handleSalaryStatus(s.id, st.value)}
                                  className={`rounded-md px-2 py-1 text-[11px] font-semibold cursor-pointer transition-colors whitespace-nowrap ${
                                    s.status === st.value
                                      ? 'bg-[#0B1F3A] text-white'
                                      : 'text-slate-600 hover:text-slate-900'
                                  }`}
                                >
                                  {st.label}
                                </button>
                              ))}
                            </div>
                          ) : (
                            <span className="rounded-md bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700">
                              {s.status === 'paid'
                                ? 'تم الصرف'
                                : s.status === 'approved'
                                ? 'معتمد'
                                : 'قيد التشغيل'}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                {filteredSalaries.length > 0 && (
                  <tfoot className="bg-slate-50 border-t-2 border-slate-200 font-bold text-[#0B1F3A]">
                    <tr>
                      <td colSpan={2} className="py-3 px-4">
                        الجمع الإجمالي ({filteredSalaries.length} سائق)
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums">
                        {formatEGP(filteredTotalBase)}
                      </td>
                      <td className="py-3 px-4 font-mono text-red-700 tabular-nums">
                        {formatEGP(filteredTotalAdvances)}
                      </td>
                      <td className="py-3 px-4 font-mono text-red-700 tabular-nums">
                        {formatEGP(filteredTotalCovDed)}
                      </td>
                      <td className="py-3 px-4 font-mono text-red-700 tabular-nums">
                        {formatEGP(filteredTotalOtherDed)}
                      </td>
                      <td className="py-3 px-4 font-mono text-emerald-700 tabular-nums">
                        {formatEGP(filteredTotalBonuses)}
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums">
                        {formatEGP(filteredTotalNet)}
                      </td>
                      <td className="py-3 px-4 text-[11px] text-slate-500">إجمالي الكشف</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>

          {/* Supervisors Cycle Dues Table */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-bold text-[#0B1F3A]">
                مستحقات المشرفات وسجل الرحلات حسب دورة المدرسة ({filteredSupervisors.length})
              </span>
              <span className="font-mono font-bold text-[#0B1F3A] tabular-nums">
                إجمالي رواتب المشرفات:{' '}
                {formatEGP(filteredSupervisors.reduce((s, sv) => s + Number(sv.monthlySalary || 0), 0))}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-4 font-semibold">الكود</th>
                    <th className="py-3 px-4 font-semibold">المشرفة والمدرسة</th>
                    <th className="py-3 px-4 font-semibold">نطاق الدورة المالية</th>
                    <th className="py-3 px-4 font-semibold">رحلات الصباح</th>
                    <th className="py-3 px-4 font-semibold">رحلات المساء</th>
                    <th className="py-3 px-4 font-semibold">إجمالي الرحلات</th>
                    <th className="py-3 px-4 font-semibold">الراتب الشهري</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredSupervisors.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-6 text-center text-slate-400">
                        لا توجد مشرفات مطابقة للتصفية الحالية
                      </td>
                    </tr>
                  ) : (
                    filteredSupervisors.map((sv) => (
                      <tr key={sv.supervisorId} className="hover:bg-slate-50/70">
                        <td className="py-3 px-4 font-mono font-bold text-[#0B1F3A]">
                          {sv.supervisorCode}
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-semibold text-slate-900">{sv.fullName}</div>
                          <div className="text-slate-500">{sv.schoolName}</div>
                        </td>
                        <td className="py-3 px-4 font-mono text-[11px] text-slate-700 tabular-nums">
                          {sv.billingRange.startDate} ← {sv.billingRange.endDate}
                        </td>
                        <td className="py-3 px-4 font-mono tabular-nums">{sv.morningTripsCount}</td>
                        <td className="py-3 px-4 font-mono tabular-nums">{sv.eveningTripsCount}</td>
                        <td className="py-3 px-4 font-mono font-bold text-[#0B1F3A] tabular-nums">
                          {sv.tripsCount} ({sv.completedDaysCount} يوم مكتمل)
                        </td>
                        <td className="py-3 px-4 font-mono font-bold text-emerald-700 tabular-nums">
                          {formatEGP(sv.monthlySalary)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 'advances' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {canAdvancesWrite && (
            <form
              onSubmit={handleRecordAdvance}
              className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5 space-y-3.5 text-xs h-fit"
            >
              <div className="flex items-center gap-2 font-display text-base font-bold text-[#0B1F3A]">
                <Wallet className="w-4 h-4 text-[#C89B3C]" />
                <span>تسجيل سلفة جديدة</span>
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">السائق *</label>
                <input
                  type="text"
                  required
                  value={advForm.driverQuery}
                  onChange={(e) => setAdvForm({ ...advForm, driverQuery: e.target.value })}
                  placeholder="اكتب اسم أو كود السائق"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">المبلغ (ج.م) *</label>
                  <input
                    type="number"
                    required
                    min={1}
                    placeholder="اكتب المبلغ"
                    value={advForm.amount}
                    onChange={(e) => setAdvForm({ ...advForm, amount: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">التاريخ *</label>
                  <input
                    type="date"
                    required
                    value={advForm.date}
                    onChange={(e) => setAdvForm({ ...advForm, date: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">طريقة الدفع</label>
                <input
                  type="text"
                  placeholder="اكتب طريقة الدفع"
                  value={advForm.paymentMethod}
                  onChange={(e) => setAdvForm({ ...advForm, paymentMethod: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">السبب</label>
                <input
                  placeholder="اكتب السبب"
                  value={advForm.reason}
                  onChange={(e) => setAdvForm({ ...advForm, reason: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">ملاحظات</label>
                <textarea
                  rows={2}
                  value={advForm.notes}
                  onChange={(e) => setAdvForm({ ...advForm, notes: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
              <button
                type="submit"
                className="w-full flex items-center justify-center gap-2 rounded-lg bg-[#0B1F3A] py-2.5 font-semibold text-white hover:bg-[#13325c] cursor-pointer"
              >
                <Plus className="w-4 h-4 text-[#C89B3C]" />
                اعتماد وتسجيل السلفة
              </button>
            </form>
          )}

          <div
            className={`${
              canAdvancesWrite ? 'lg:col-span-8' : 'lg:col-span-12'
            } bg-white border border-slate-200 rounded-xl overflow-hidden`}
          >
            <div className="px-5 py-4 border-b border-slate-200 font-bold text-sm text-[#0B1F3A] flex items-center justify-between gap-2">
              <span>
                سجل السلف للشهر المحدد ({filteredAdvances.length})
                {selectedSchoolContract ? ` — ${selectedSchoolContract.schoolName}` : ''}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-4">التاريخ</th>
                    <th className="py-3 px-4">السائق</th>
                    <th className="py-3 px-4">السبب والطريقة</th>
                    <th className="py-3 px-4">المبلغ</th>
                    {(canAdvancesWrite || canFinanceWrite) && (
                      <th className="py-3 px-4">تعديل / حذف / إجراء</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {!filteredAdvances.length ? (
                    <tr>
                      <td
                        colSpan={canAdvancesWrite || canFinanceWrite ? 5 : 4}
                        className="py-8 text-center text-slate-400"
                      >
                        لا توجد سلف مسجلة لهذا الشهر
                      </td>
                    </tr>
                  ) : (
                    filteredAdvances.map((a) => (
                      <tr key={a.id} className={a.isReversed ? 'opacity-60' : ''}>
                        <td className="py-3 px-4 font-mono tabular-nums">{a.date}</td>
                        <td className="py-3 px-4">
                          <div className="font-semibold text-slate-900">{a.driverName}</div>
                          <div className="text-slate-500">كود {a.driverCode}</div>
                        </td>
                        <td className="py-3 px-4">
                          <div>{a.reason || '—'}</div>
                          <div className="text-slate-400">{a.paymentMethod || '—'}</div>
                        </td>
                        <td
                          className={`py-3 px-4 font-mono font-bold text-red-700 tabular-nums ${
                            a.isReversed ? 'line-through' : ''
                          }`}
                        >
                          {formatEGP(a.amount)}
                        </td>
                        {(canAdvancesWrite || canFinanceWrite) && (
                          <td className="py-3 px-4">
                            <div className="flex flex-wrap items-center gap-1.5">
                              {canAdvancesWrite && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => openEditAdvance(a)}
                                    className="inline-flex items-center gap-1 rounded-md bg-[#0B1F3A] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#13325c] cursor-pointer"
                                  >
                                    <Edit3 className="w-3 h-3 text-[#C89B3C]" />
                                    تعديل
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setDeletingAdvance(a)}
                                    className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100 cursor-pointer"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                    حذف
                                  </button>
                                </>
                              )}
                              {canFinanceWrite &&
                                (a.isReversed ? (
                                  <span className="text-[11px] text-slate-500 px-1">معكوسة</span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => handleReverse('advance', a.id)}
                                    className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 cursor-pointer"
                                  >
                                    <RotateCcw className="w-3 h-3" />
                                    عكس
                                  </button>
                                ))}
                            </div>
                          </td>
                        )}
                      </tr>
                    ))
                  )}
                </tbody>
                {filteredAdvances.length > 0 && (
                  <tfoot className="bg-slate-50 border-t-2 border-slate-200 font-bold text-[#0B1F3A]">
                    <tr>
                      <td colSpan={3} className="py-3 px-4">
                        الجمع الإجمالي للسلف المعتمدة ({filteredAdvances.filter((a) => !a.isReversed).length} سلفة)
                      </td>
                      <td className="py-3 px-4 font-mono text-red-700 tabular-nums">
                        {formatEGP(activeAdvancesSum)}
                      </td>
                      {(canAdvancesWrite || canFinanceWrite) && (
                        <td className="py-3 px-4 text-[11px] text-slate-500">—</td>
                      )}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 'coverage' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {canCoverageWrite && (
            <form
              onSubmit={handleRecordCoverage}
              className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5 space-y-3 text-xs h-fit"
            >
            <h3 className="font-display text-base font-bold text-[#0B1F3A]">
              تسجيل تغطية غياب سائق
            </h3>
            <div>
              <label className="block font-semibold text-slate-700 mb-1">السائق الغائب *</label>
              <input
                type="text"
                required
                value={covForm.absentDriverQuery}
                onChange={(e) => setCovForm({ ...covForm, absentDriverQuery: e.target.value })}
                placeholder="اكتب اسم أو كود السائق الغائب"
                className="w-full rounded-lg border border-slate-200 px-3 py-2"
              />
            </div>
            <div>
              <label className="block font-semibold text-slate-700 mb-1">السائق البديل</label>
              <input
                type="text"
                value={covForm.replacementQuery}
                onChange={(e) => setCovForm({ ...covForm, replacementQuery: e.target.value })}
                placeholder="اكتب اسم أو كود السائق البديل"
                className="w-full rounded-lg border border-slate-200 px-3 py-2"
              />
            </div>
            <div>
              <label className="block font-semibold text-slate-700 mb-1">تاريخ التغطية *</label>
              <input
                type="date"
                required
                value={covForm.date}
                onChange={(e) => setCovForm({ ...covForm, date: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  التكلفة الفعلية للبديل (ج.م)
                </label>
                <input
                  type="number"
                  required
                  min={0}
                  placeholder="0"
                  value={covForm.actualReplacementCost}
                  onChange={(e) =>
                    setCovForm({ ...covForm, actualReplacementCost: e.target.value })
                  }
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  الخصم من السائق الغائب (ج.م)
                </label>
                <input
                  type="number"
                  required
                  min={0}
                  placeholder="0"
                  value={covForm.absentDriverDeduction}
                  onChange={(e) =>
                    setCovForm({ ...covForm, absentDriverDeduction: e.target.value })
                  }
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                />
              </div>
            </div>
            <div>
              <label className="block font-semibold text-slate-700 mb-1">السبب</label>
              <input
                placeholder="اكتب السبب"
                value={covForm.reason}
                onChange={(e) => setCovForm({ ...covForm, reason: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2"
              />
            </div>
            <button
              type="submit"
              className="w-full rounded-lg bg-[#0B1F3A] py-2.5 font-semibold text-white hover:bg-[#13325c] cursor-pointer"
            >
              تسجيل تغطية الغياب
            </button>
          </form>
          )}

          <div
            className={`${
              canCoverageWrite ? 'lg:col-span-8' : 'lg:col-span-12'
            } bg-white border border-slate-200 rounded-xl overflow-hidden`}
          >
            <div className="px-5 py-4 border-b border-slate-200 font-bold text-sm text-[#0B1F3A]">
              سجل التغطيات للشهر المحدد ({filteredCoverages.length})
              {selectedSchoolContract ? ` — ${selectedSchoolContract.schoolName}` : ''}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-4">التاريخ</th>
                    <th className="py-3 px-4">السائق الغائب</th>
                    <th className="py-3 px-4">السائق البديل</th>
                    <th className="py-3 px-4">تكلفة البديل</th>
                    <th className="py-3 px-4">خصم الغائب</th>
                    {(canCoverageWrite || canFinanceWrite) && (
                      <th className="py-3 px-4">تعديل / حذف / إجراء</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {!filteredCoverages.length ? (
                    <tr>
                      <td
                        colSpan={canCoverageWrite || canFinanceWrite ? 6 : 5}
                        className="py-8 text-center text-slate-400"
                      >
                        لا توجد تغطيات مسجلة لهذا الشهر
                      </td>
                    </tr>
                  ) : (
                    filteredCoverages.map((c) => (
                      <tr key={c.id} className={c.isReversed ? 'opacity-60' : ''}>
                        <td className="py-3 px-4 font-mono tabular-nums">{c.date}</td>
                        <td className="py-3 px-4">
                          <div className="font-semibold text-slate-900">{c.absentDriverName}</div>
                          <div className="text-slate-500">
                            كود {c.absentDriverCode} · {c.busNumber}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-slate-700">{c.replacementDriverName}</td>
                        <td
                          className={`py-3 px-4 font-mono text-slate-800 tabular-nums ${
                            c.isReversed ? 'line-through' : ''
                          }`}
                        >
                          {formatEGP(c.actualReplacementCost)}
                        </td>
                        <td
                          className={`py-3 px-4 font-mono font-bold text-red-700 tabular-nums ${
                            c.isReversed ? 'line-through' : ''
                          }`}
                        >
                          {formatEGP(c.absentDriverDeduction)}
                        </td>
                        {(canCoverageWrite || canFinanceWrite) && (
                          <td className="py-3 px-4">
                            <div className="flex flex-wrap items-center gap-1.5">
                              {canCoverageWrite && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => openEditCoverage(c)}
                                    className="inline-flex items-center gap-1 rounded-md bg-[#0B1F3A] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#13325c] cursor-pointer"
                                  >
                                    <Edit3 className="w-3 h-3 text-[#C89B3C]" />
                                    تعديل
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setDeletingCoverage(c)}
                                    className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100 cursor-pointer"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                    حذف
                                  </button>
                                </>
                              )}
                              {canFinanceWrite &&
                                (c.isReversed ? (
                                  <span className="text-[11px] text-slate-500 px-1">معكوسة</span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => handleReverse('coverage', c.id)}
                                    className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 cursor-pointer"
                                  >
                                    <RotateCcw className="w-3 h-3" />
                                    عكس
                                  </button>
                                ))}
                            </div>
                          </td>
                        )}
                      </tr>
                    ))
                  )}
                </tbody>
                {filteredCoverages.length > 0 && (
                  <tfoot className="bg-slate-50 border-t-2 border-slate-200 font-bold text-[#0B1F3A]">
                    <tr>
                      <td colSpan={3} className="py-3 px-4">
                        الجمع الإجمالي للتغطيات النشطة ({filteredCoverages.filter((c) => !c.isReversed).length})
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-900 tabular-nums">
                        {formatEGP(activeCovCostSum)}
                      </td>
                      <td className="py-3 px-4 font-mono text-red-700 tabular-nums">
                        {formatEGP(activeCovDedSum)}
                      </td>
                      {(canCoverageWrite || canFinanceWrite) && (
                        <td className="py-3 px-4 text-[11px] text-slate-500">—</td>
                      )}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 'ledger' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
            <h3 className="font-display text-sm font-bold text-[#0B1F3A]">
              سجل القيود المالية للشهر
            </h3>
            <span className="text-xs text-slate-500">يتم تحديث القيود تلقائياً عند التعديل أو الحذف</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4">#</th>
                  <th className="py-3 px-4">التاريخ</th>
                  <th className="py-3 px-4">السائق</th>
                  <th className="py-3 px-4">النوع</th>
                  <th className="py-3 px-4">الوصف</th>
                  <th className="py-3 px-4">القيمة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredLedger.map((t) => (
                  <tr key={t.id}>
                    <td className="py-3 px-4 font-mono text-slate-400">{t.id}</td>
                    <td className="py-3 px-4 font-mono text-slate-500 tabular-nums">
                      {new Date(t.createdAt).toLocaleString('ar-EG', {
                        timeZone: 'Africa/Cairo',
                      })}
                    </td>
                    <td className="py-3 px-4 font-semibold text-slate-800">
                      {t.driverName} ({t.driverCode})
                    </td>
                    <td className="py-3 px-4">{t.type}</td>
                    <td className="py-3 px-4 text-slate-700">{t.description}</td>
                    <td
                      className={`py-3 px-4 font-mono font-bold tabular-nums ${
                        t.direction === 'credit' ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {t.direction === 'credit' ? '+' : '−'} {formatEGP(t.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
              {filteredLedger.length > 0 && (
                <tfoot className="bg-slate-50 border-t-2 border-slate-200 font-bold text-[#0B1F3A]">
                  <tr>
                    <td colSpan={4} className="py-3 px-4">
                      الجمع الإجمالي لدفتر الأستاذ ({filteredLedger.length} قيد)
                    </td>
                    <td className="py-3 px-4 font-mono text-[11px] tabular-nums">
                      دائن: +{formatEGP(ledgerCreditSum)} · مدين: −{formatEGP(ledgerDebitSum)}
                    </td>
                    <td
                      className={`py-3 px-4 font-mono tabular-nums ${
                        ledgerCreditSum - ledgerDebitSum >= 0
                          ? 'text-emerald-700'
                          : 'text-red-700'
                      }`}
                    >
                      الصافي: {formatEGP(ledgerCreditSum - ledgerDebitSum)}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}

      {/* Edit Advance Modal */}
      {editingAdvance && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
            <div className="px-5 py-4 bg-[#0B1F3A] text-white flex items-center justify-between">
              <h3 className="font-display text-sm font-bold">
                تعديل السلفة — {editingAdvance.driverName}
              </h3>
              <button
                type="button"
                onClick={() => setEditingAdvance(null)}
                className="text-slate-300 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveEditAdvance} className="p-5 space-y-3 text-xs">
              {editAdvError && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-800">
                  {editAdvError}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">المبلغ (ج.م) *</label>
                  <input
                    type="number"
                    required
                    min={1}
                    value={editAdvForm.amount}
                    onChange={(e) => setEditAdvForm({ ...editAdvForm, amount: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">التاريخ *</label>
                  <input
                    type="date"
                    required
                    value={editAdvForm.date}
                    onChange={(e) => setEditAdvForm({ ...editAdvForm, date: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">طريقة الدفع</label>
                <input
                  type="text"
                  value={editAdvForm.paymentMethod}
                  onChange={(e) =>
                    setEditAdvForm({ ...editAdvForm, paymentMethod: e.target.value })
                  }
                  placeholder="اكتب طريقة الدفع"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">السبب</label>
                <input
                  type="text"
                  value={editAdvForm.reason}
                  onChange={(e) => setEditAdvForm({ ...editAdvForm, reason: e.target.value })}
                  placeholder="اكتب السبب"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">ملاحظات</label>
                <textarea
                  rows={2}
                  value={editAdvForm.notes}
                  onChange={(e) => setEditAdvForm({ ...editAdvForm, notes: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setEditingAdvance(null)}
                  className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={savingAdvEdit}
                  className="rounded-lg bg-[#0B1F3A] px-5 py-2 font-semibold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
                >
                  {savingAdvEdit ? 'جاري الحفظ...' : 'حفظ التعديل'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Advance Confirmation */}
      {deletingAdvance && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-sm bg-white rounded-2xl border border-slate-200 shadow-xl p-5 space-y-4 text-xs">
            <h3 className="font-bold text-sm text-[#0B1F3A]">تأكيد حذف السلفة</h3>
            <p className="text-slate-600 leading-relaxed">
              هل تريد حذف السلفة المسجلة للسائق <strong>{deletingAdvance.driverName}</strong> بقيمة{' '}
              <strong className="font-mono">{formatEGP(deletingAdvance.amount)}</strong> بتاريخ{' '}
              <strong className="font-mono">{deletingAdvance.date}</strong>؟ سيتم تحديث صافي الراتب تلقائياً.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={deletingRecord}
                onClick={() => setDeletingAdvance(null)}
                className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={deletingRecord}
                onClick={handleConfirmDeleteAdvance}
                className="rounded-lg bg-red-600 px-4 py-2 font-semibold text-white hover:bg-red-700 disabled:opacity-50 cursor-pointer"
              >
                {deletingRecord ? 'جاري الحذف...' : 'حذف السلفة'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Coverage Modal */}
      {editingCoverage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
            <div className="px-5 py-4 bg-[#0B1F3A] text-white flex items-center justify-between">
              <h3 className="font-display text-sm font-bold">
                تعديل تغطية الغياب — {editingCoverage.absentDriverName}
              </h3>
              <button
                type="button"
                onClick={() => setEditingCoverage(null)}
                className="text-slate-300 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveEditCoverage} className="p-5 space-y-3 text-xs">
              {editCovError && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-800">
                  {editCovError}
                </div>
              )}
              <div>
                <label className="block font-semibold text-slate-700 mb-1">السائق البديل</label>
                <input
                  type="text"
                  value={editCovForm.replacementQuery}
                  onChange={(e) =>
                    setEditCovForm({ ...editCovForm, replacementQuery: e.target.value })
                  }
                  placeholder="اكتب اسم أو كود السائق البديل"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">تاريخ التغطية *</label>
                <input
                  type="date"
                  required
                  value={editCovForm.date}
                  onChange={(e) => setEditCovForm({ ...editCovForm, date: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    التكلفة الفعلية للبديل (ج.م)
                  </label>
                  <input
                    type="number"
                    required
                    min={0}
                    value={editCovForm.actualReplacementCost}
                    onChange={(e) =>
                      setEditCovForm({ ...editCovForm, actualReplacementCost: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    الخصم من السائق الغائب (ج.م)
                  </label>
                  <input
                    type="number"
                    required
                    min={0}
                    value={editCovForm.absentDriverDeduction}
                    onChange={(e) =>
                      setEditCovForm({ ...editCovForm, absentDriverDeduction: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">السبب</label>
                <input
                  type="text"
                  value={editCovForm.reason}
                  onChange={(e) => setEditCovForm({ ...editCovForm, reason: e.target.value })}
                  placeholder="اكتب السبب"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">ملاحظات</label>
                <textarea
                  rows={2}
                  value={editCovForm.notes}
                  onChange={(e) => setEditCovForm({ ...editCovForm, notes: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setEditingCoverage(null)}
                  className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={savingCovEdit}
                  className="rounded-lg bg-[#0B1F3A] px-5 py-2 font-semibold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
                >
                  {savingCovEdit ? 'جاري الحفظ...' : 'حفظ التعديل'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Coverage Confirmation */}
      {deletingCoverage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-sm bg-white rounded-2xl border border-slate-200 shadow-xl p-5 space-y-4 text-xs">
            <h3 className="font-bold text-sm text-[#0B1F3A]">تأكيد حذف سجل التغطية</h3>
            <p className="text-slate-600 leading-relaxed">
              هل تريد حذف تغطية الغياب للسائق <strong>{deletingCoverage.absentDriverName}</strong> بتاريخ{' '}
              <strong className="font-mono">{deletingCoverage.date}</strong> (خصم{' '}
              <strong className="font-mono">
                {formatEGP(deletingCoverage.absentDriverDeduction)}
              </strong>
              )؟ سيتم إعادة احتساب صافي الراتب تلقائياً.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={deletingRecord}
                onClick={() => setDeletingCoverage(null)}
                className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={deletingRecord}
                onClick={handleConfirmDeleteCoverage}
                className="rounded-lg bg-red-600 px-4 py-2 font-semibold text-white hover:bg-red-700 disabled:opacity-50 cursor-pointer"
              >
                {deletingRecord ? 'جاري الحذف...' : 'حذف التغطية'}
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === 'closing' && (
        <div className="space-y-6">
          {/* Explanation Card */}
          <div className="bg-[#0B1F3A] text-white rounded-2xl p-6 space-y-3">
            <div className="flex items-center gap-2 text-[#C89B3C] text-xs font-bold">
              <Sparkles className="w-4 h-4" />
              <span>نظام التصفية الشهرية وبداية الشهر الجديد على بياض</span>
            </div>
            <h2 className="font-display text-lg font-bold">
              تصفية شهر {month} / {year} والبدء في شهر جديد بنفس السائقين والمركبات والمدارس
            </h2>
            <p className="text-xs text-slate-300 leading-relaxed max-w-3xl">
              عند إتمام التصفية الشهرية، يتم حفظ كشف حساب ختامي كامل للشهر في السجل (مع إمكانية مراجعته في أي وقت)، ثم يبدأ الشهر الجديد على بياض:
              تُصفَّر السلف والتغطيات والمكافآت والخصومات تلقائياً لجميع السائقين والموظفين، بينما تبقى بيانات السائقين والموظفين والرواتب الأساسية والمدارس والمركبات وخطوط السير كما هي دون أي تغيير.
            </p>
          </div>

          {/* Current Month Preview Totals */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">إجمالي الرواتب الأساسية</div>
              <div className="font-mono text-lg font-bold text-[#0B1F3A] mt-1">
                {formatEGP(monthTotalBase)}
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                {data?.salaries.length || 0} سائق نشط
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">إجمالي السلف + التغطيات</div>
              <div className="font-mono text-lg font-bold text-red-700 mt-1">
                {formatEGP(monthTotalAdvances + monthTotalCoverages)}
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                سلف {formatEGP(monthTotalAdvances)} · تغطيات {formatEGP(monthTotalCoverages)}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">المكافآت / الخصومات الأخرى</div>
              <div className="font-mono text-lg font-bold text-emerald-700 mt-1">
                +{formatEGP(monthTotalBonuses)} / −{formatEGP(monthTotalOtherDed)}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">صافي رواتب السائقين المستحق</div>
              <div className="font-mono text-lg font-bold text-[#0B1F3A] mt-1">
                {formatEGP(monthTotalNet)}
              </div>
            </div>
          </div>

          {/* Action Cards */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Action 1: Close & Rollover to Next Month */}
            <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-4">
              <div className="flex items-center gap-2 font-display text-base font-bold text-[#0B1F3A]">
                <CalendarCheck className="w-5 h-5 text-[#C89B3C]" />
                <span>1. تصفية الشهر والانتقال للشهر التالي على بياض</span>
              </div>
              <p className="text-xs text-slate-600 leading-relaxed">
                يُقفل شهر <strong>{month}/{year}</strong> (
                <strong>{closingTargetSchool?.schoolName || 'جميع المدارس'}</strong>
                {closingTargetSchool?.billingRange
                  ? ` — من ${closingTargetSchool.billingRange.startDate} إلى ${closingTargetSchool.billingRange.endDate}`
                  : ''}
                ) ويُحفظ تقريره المالي بالكامل للموظفين والسائقين والمشرفات في سجل التصفيات، ثم يُفتح شهر{' '}
                <strong>{nextMonthPreview}/{nextYearPreview}</strong> بأرصدة صفرية للسلف والتغطيات.
              </p>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  نطاق المدرسة للتصفية والإغلاق
                </label>
                <select
                  value={closingSchoolId}
                  disabled={isSingleSchoolRestricted}
                  onChange={(e) => setClosingSchoolId(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-[#0B1F3A] disabled:opacity-80"
                >
                  {(isSuperAdmin || restrictedSchoolCount === 0) && (
                    <option value="all">جميع المدارس (تصفية شاملة لكل الأسطول)</option>
                  )}
                  {!isSuperAdmin && restrictedSchoolCount > 1 && (
                    <option value="all">جميع المدارس المخصصة لي</option>
                  )}
                  {schoolContracts
                    .filter((sc) => sc.schoolId !== null)
                    .map((sc) => (
                      <option key={getSchoolKey(sc.schoolId)} value={getSchoolKey(sc.schoolId)}>
                        {sc.schoolName} — {sc.billingRange?.shortLabelAr || `شهر ${month}/${year}`}
                      </option>
                    ))}
                </select>
              </div>

              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={markAllPaidOnClose}
                  onChange={(e) => setMarkAllPaidOnClose(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span>تحديد رواتب شهر {month}/{year} في هذا النطاق كـ «تم الصرف» عند التصفية</span>
              </label>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  ملاحظات التصفية (اختياري)
                </label>
                <input
                  type="text"
                  value={closingNotes}
                  onChange={(e) => setClosingNotes(e.target.value)}
                  placeholder="مثال: تمت تصفية جميع الحسابات واستلام العهد"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                />
              </div>

              <button
                type="button"
                onClick={() => setConfirmCloseOpen(true)}
                className="w-full rounded-xl bg-[#0B1F3A] hover:bg-[#13325c] py-3 px-4 text-xs font-bold text-white cursor-pointer"
              >
                اعتماد تصفية {closingTargetSchool ? closingTargetSchool.schoolName : 'جميع المدارس'} ({month}/{year})
              </button>
            </div>

            {/* Action 2: Reset Current Selected Month Financials */}
            <div className="bg-white border border-amber-200 rounded-2xl p-6 space-y-4">
              <div className="flex items-center gap-2 font-display text-base font-bold text-amber-900">
                <RotateCcw className="w-5 h-5 text-amber-600" />
                <span>2. تصفير مالية شهر {month}/{year} فقط (إعادة ضبط على بياض)</span>
              </div>
              <p className="text-xs text-slate-600 leading-relaxed">
                استخدم هذا الخيار إذا أردت مسح السلف والتغطيات والمكافآت والخصومات الخاصة بـ{' '}
                <strong>{closingTargetSchool?.schoolName || 'جميع المدارس'}</strong> في دورة{' '}
                <strong>{month}/{year}</strong> والبدء فيها على بياض من جديد — مع الحفاظ الكامل على كل السائقين والمشرفات والموظفين والمدارس والمركبات.
              </p>
              <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-[11px] text-amber-900">
                تنبيه: لن تتأثر المدارس أو الأشهر الأخرى؛ التصفير يطال الحركات المالية لـ{' '}
                <strong>{closingTargetSchool?.schoolName || 'جميع المدارس'}</strong> في دورة {month}/{year} فقط.
              </div>
              <button
                type="button"
                onClick={() => setConfirmResetOpen(true)}
                className="w-full rounded-xl border border-red-300 bg-red-50 hover:bg-red-100 py-3 px-4 text-xs font-bold text-red-800 cursor-pointer"
              >
                تصفير مالية {closingTargetSchool ? closingTargetSchool.schoolName : 'الشهر'} ({month}/{year}) على بياض الآن
              </button>
            </div>
          </div>

          {/* Closing History */}
          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-sm font-bold text-[#0B1F3A]">
                سجل التصفيات الشهرية السابقة ({data?.closingsHistory?.length || 0})
              </h3>
              <span className="text-xs text-slate-500">محفوظة للمراجعة والتدقيق</span>
            </div>

            {!data?.closingsHistory?.length ? (
              <div className="p-8 text-center text-xs text-slate-400">
                لا توجد تصفيات شهرية مسجلة حتى الآن. عند تنفيذ أول تصفية سيظهر السجل الكامل هنا.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-right text-xs">
                  <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="py-3 px-4">الدورة والمدرسة</th>
                      <th className="py-3 px-4">تاريخ التصفية</th>
                      <th className="py-3 px-4">السائقون / الموظفون</th>
                      <th className="py-3 px-4">صافي رواتب السائقين</th>
                      <th className="py-3 px-4">السلف والتغطيات</th>
                      <th className="py-3 px-4">عقود المدارس</th>
                      <th className="py-3 px-4">صافي الربح</th>
                      <th className="py-3 px-4">الكشف الختامي</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.closingsHistory.map((c) => (
                      <tr key={c.id} className="hover:bg-slate-50">
                        <td className="py-3 px-4">
                          <div className="font-mono font-bold text-[#0B1F3A]">
                            {c.month} / {c.year} — {c.schoolName || 'جميع المدارس'}
                          </div>
                          {(c.cycleStartDate || c.cycleEndDate) && (
                            <div className="font-mono text-[10px] text-slate-500 mt-0.5 tabular-nums">
                              {c.cycleStartDate} ← {c.cycleEndDate}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-slate-500">
                          {new Date(c.closedAt).toLocaleDateString('ar-EG', {
                            timeZone: 'Africa/Cairo',
                          })}
                        </td>
                        <td className="py-3 px-4">
                          {c.driversCount} سائق · {c.employeesCount} موظف
                        </td>
                        <td className="py-3 px-4 font-mono font-bold text-[#0B1F3A]">
                          {formatEGP(Number(c.totalDriverSalaries))}
                        </td>
                        <td className="py-3 px-4 font-mono text-red-700">
                          {formatEGP(Number(c.totalAdvances) + Number(c.totalCoverageDeductions))}
                        </td>
                        <td className="py-3 px-4 font-mono text-emerald-700">
                          {formatEGP(Number(c.totalSchoolContracts))}
                        </td>
                        <td className="py-3 px-4 font-mono font-bold text-[#0B1F3A]">
                          {formatEGP(Number(c.netProfit))}
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setInspectClosing(c)}
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 px-3 py-1.5 text-[11px] font-semibold text-[#0B1F3A] cursor-pointer"
                            >
                              <Eye className="w-3.5 h-3.5 text-[#C89B3C]" />
                              كشف التصفية
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                initialSyncedRef.current = true;
                                setMonth(c.month);
                                setYear(c.year);
                                if (c.schoolId) setSelectedSchoolKey(String(c.schoolId));
                                setTab('salaries');
                              }}
                              className="inline-flex items-center gap-1 rounded-lg bg-[#0B1F3A] hover:bg-[#13325c] px-3 py-1.5 text-[11px] font-semibold text-white cursor-pointer"
                            >
                              فتح سجلات الشهر
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Confirm Close & Rollover Modal */}
      {confirmCloseOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-xl p-6 space-y-4 text-xs">
            <div className="flex items-center gap-2 text-[#0B1F3A]">
              <CalendarCheck className="w-5 h-5 text-[#C89B3C]" />
              <h3 className="font-display text-base font-bold">
                تأكيد تصفية شهر {month}/{year}
              </h3>
            </div>
            <p className="text-slate-600 leading-relaxed">
              سيتم حفظ تصفية شهر <strong>{month}/{year}</strong> (إجمالي مستحقات السائقين{' '}
              <strong className="font-mono">{formatEGP(monthTotalNet)}</strong>) والانتقال مباشرة إلى شهر{' '}
              <strong>
                {nextMonthPreview}/{nextYearPreview}
              </strong>{' '}
              على بياض بنفس السائقين والموظفين والمدارس والمركبات.
            </p>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                disabled={busyClosing}
                onClick={() => setConfirmCloseOpen(false)}
                className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={busyClosing}
                onClick={handleCloseMonthAndStartNext}
                className="rounded-lg bg-[#0B1F3A] px-5 py-2 font-bold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
              >
                {busyClosing ? 'جاري التصفية...' : 'نعم، تصفية وبدء الشهر الجديد'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Reset Month Modal */}
      {confirmResetOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md bg-white rounded-2xl border border-red-200 shadow-xl p-6 space-y-4 text-xs">
            <div className="flex items-center gap-2 text-red-700">
              <AlertTriangle className="w-5 h-5" />
              <h3 className="font-display text-base font-bold">
                تأكيد تصفير مالية شهر {month}/{year}
              </h3>
            </div>
            <p className="text-slate-600 leading-relaxed">
              سيتم حذف جميع السلف والتغطيات والمكافآت والخصومات المسجلة في شهر{' '}
              <strong>{month}/{year}</strong> وتصفير مكافآت وخصومات الموظفين ليبدأ الشهر على بياض تماماً، مع إبقاء كافة السائقين والمركبات والمدارس كما هي.
            </p>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                disabled={busyClosing}
                onClick={() => setConfirmResetOpen(false)}
                className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={busyClosing}
                onClick={handleResetMonthFinancials}
                className="rounded-lg bg-red-600 px-5 py-2 font-bold text-white hover:bg-red-700 disabled:opacity-50 cursor-pointer"
              >
                {busyClosing ? 'جاري التصفير...' : 'نعم، تصفير مالية الشهر'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Inspect Closed Month Snapshot Modal */}
      {inspectClosing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-4xl max-h-[85vh] bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden flex flex-col">
            <div className="px-6 py-4 bg-[#0B1F3A] text-white flex items-center justify-between shrink-0">
              <div>
                <h3 className="font-display text-base font-bold">
                  كشف تصفية دورة {inspectClosing.month} / {inspectClosing.year} —{' '}
                  {inspectClosing.schoolName || 'جميع المدارس'}
                </h3>
                <p className="text-xs text-slate-300 mt-0.5">
                  {inspectClosing.cycleStartDate && inspectClosing.cycleEndDate
                    ? `نطاق الدورة: ${inspectClosing.cycleStartDate} ← ${inspectClosing.cycleEndDate} · `
                    : ''}
                  تاريخ التصفية:{' '}
                  {new Date(inspectClosing.closedAt).toLocaleString('ar-EG', {
                    timeZone: 'Africa/Cairo',
                  })}
                  {inspectClosing.notes ? ` · ${inspectClosing.notes}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setInspectClosing(null)}
                className="text-slate-300 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-6 text-xs">
              <div>
                <h4 className="font-bold text-sm text-[#0B1F3A] mb-2">
                  حسابات السائقين وقت التصفية ({inspectClosing.snapshotJson?.drivers?.length || 0})
                </h4>
                <div className="overflow-x-auto border border-slate-200 rounded-xl">
                  <table className="w-full text-right">
                    <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                      <tr>
                        <th className="py-2.5 px-3">الكود</th>
                        <th className="py-2.5 px-3">السائق</th>
                        <th className="py-2.5 px-3">الأساسي</th>
                        <th className="py-2.5 px-3">السلف</th>
                        <th className="py-2.5 px-3">التغطيات</th>
                        <th className="py-2.5 px-3">المكافآت</th>
                        <th className="py-2.5 px-3">الصافي</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {inspectClosing.snapshotJson?.drivers?.map((d) => (
                        <tr key={d.driverId}>
                          <td className="py-2 px-3 font-mono font-bold text-[#0B1F3A]">
                            {d.driverCode}
                          </td>
                          <td className="py-2 px-3 font-semibold">{d.fullName}</td>
                          <td className="py-2 px-3 font-mono">{formatEGP(d.baseSalary)}</td>
                          <td className="py-2 px-3 font-mono text-red-700">
                            {formatEGP(d.totalAdvances)}
                          </td>
                          <td className="py-2 px-3 font-mono text-red-700">
                            {formatEGP(d.totalCoverageDeductions)}
                          </td>
                          <td className="py-2 px-3 font-mono text-emerald-700">
                            {formatEGP(d.bonuses)}
                          </td>
                          <td className="py-2 px-3 font-mono font-bold text-[#0B1F3A]">
                            {formatEGP(d.netSalary)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {Boolean(inspectClosing.snapshotJson?.supervisors?.length) && (
                <div>
                  <h4 className="font-bold text-sm text-[#0B1F3A] mb-2">
                    المشرفات وقت التصفية ({inspectClosing.snapshotJson?.supervisors?.length})
                  </h4>
                  <div className="overflow-x-auto border border-slate-200 rounded-xl">
                    <table className="w-full text-right">
                      <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                        <tr>
                          <th className="py-2.5 px-3">الكود</th>
                          <th className="py-2.5 px-3">المشرفة</th>
                          <th className="py-2.5 px-3">المدرسة</th>
                          <th className="py-2.5 px-3">عدد الرحلات</th>
                          <th className="py-2.5 px-3">الراتب الشهري</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {inspectClosing.snapshotJson?.supervisors?.map((sv) => (
                          <tr key={sv.supervisorId}>
                            <td className="py-2 px-3 font-mono font-bold text-[#0B1F3A]">
                              {sv.supervisorCode}
                            </td>
                            <td className="py-2 px-3 font-semibold">{sv.fullName}</td>
                            <td className="py-2 px-3">{sv.schoolName}</td>
                            <td className="py-2 px-3 font-mono">{sv.tripsCount}</td>
                            <td className="py-2 px-3 font-mono font-bold text-[#0B1F3A]">
                              {formatEGP(sv.monthlySalary)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {Boolean(inspectClosing.snapshotJson?.employees?.length) && (
                <div>
                  <h4 className="font-bold text-sm text-[#0B1F3A] mb-2">
                    الموظفون غير السائقين وقت التصفية ({inspectClosing.snapshotJson?.employees?.length})
                  </h4>
                  <div className="overflow-x-auto border border-slate-200 rounded-xl">
                    <table className="w-full text-right">
                      <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                        <tr>
                          <th className="py-2.5 px-3">الاسم</th>
                          <th className="py-2.5 px-3">الوظيفة</th>
                          <th className="py-2.5 px-3">الأساسي</th>
                          <th className="py-2.5 px-3">المكافآت</th>
                          <th className="py-2.5 px-3">الخصومات</th>
                          <th className="py-2.5 px-3">الصافي</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {inspectClosing.snapshotJson?.employees?.map((e) => (
                          <tr key={e.employeeId}>
                            <td className="py-2 px-3 font-semibold">{e.fullName}</td>
                            <td className="py-2 px-3">{e.jobTitle || '—'}</td>
                            <td className="py-2 px-3 font-mono">{formatEGP(e.monthlySalary)}</td>
                            <td className="py-2 px-3 font-mono text-emerald-700">
                              {formatEGP(e.bonuses)}
                            </td>
                            <td className="py-2 px-3 font-mono text-red-700">
                              {formatEGP(e.deductions)}
                            </td>
                            <td className="py-2 px-3 font-mono font-bold text-[#0B1F3A]">
                              {formatEGP(e.netSalary)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Per-School Billing Period Customization Modal */}
      {billingModalSchool && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-lg bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
            <div className="px-6 py-4 bg-[#0B1F3A] text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CalendarCheck className="w-4 h-4 text-[#C89B3C]" />
                <h3 className="font-bold text-sm">
                  تخصيص بداية ونهاية الشهر — {billingModalSchool.schoolName}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setBillingModalSchool(null)}
                className="cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={(e) => handleSaveBillingPeriod(e, false)} className="p-6 space-y-4 text-xs">
              {billingModalError && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-red-800">
                  {billingModalError}
                </div>
              )}

              <div>
                <label className="block font-semibold text-slate-700 mb-1.5">
                  نوع الدورة الشهرية للمدرسة
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    {
                      value: 'calendar' as const,
                      title: 'ميلادي عادي (1 → نهاية الشهر)',
                      desc: 'الشهر يبدأ يوم 1 وينتهي آخر يوم بالشهر',
                    },
                    {
                      value: 'shifted' as const,
                      title: 'دورة مرحّلة (مثل الهلالية: 13 → 12)',
                      desc: 'تبدأ من اليوم المحدد وتنتهي في الشهر التالي',
                    },
                  ].map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() =>
                        setBillingForm((prev) => ({
                          ...prev,
                          cycleType: opt.value,
                          startDay: opt.value === 'shifted' ? '13' : '1',
                          endDay: opt.value === 'shifted' ? '12' : '31',
                        }))
                      }
                      className={`text-right rounded-xl border p-3 transition-colors cursor-pointer ${
                        billingForm.cycleType === opt.value
                          ? 'border-[#0B1F3A] bg-[#0B1F3A]/5 text-[#0B1F3A]'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <div className="font-bold">{opt.title}</div>
                      <div className="text-[11px] text-slate-500 mt-0.5">{opt.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    يوم بداية الشهر المحاسبي *
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={28}
                    required
                    value={billingForm.startDay}
                    onChange={(e) => setBillingForm({ ...billingForm, startDay: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    يوم نهاية الشهر المحاسبي *
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={31}
                    required
                    value={billingForm.endDay}
                    onChange={(e) => setBillingForm({ ...billingForm, endDay: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    الشهر المحاسبي النشط
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={12}
                    required
                    value={billingForm.activeMonth}
                    onChange={(e) =>
                      setBillingForm({ ...billingForm, activeMonth: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">السنة المحاسبية</label>
                  <input
                    type="number"
                    min={2020}
                    max={2099}
                    required
                    value={billingForm.activeYear}
                    onChange={(e) =>
                      setBillingForm({ ...billingForm, activeYear: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2.5">
                <div className="font-semibold text-[#0B1F3A]">
                  تحديد تاريخ بداية ونهاية مخصص لهذه الدورة (اختياري)
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] text-slate-600 mb-1">من تاريخ</label>
                    <input
                      type="date"
                      value={billingForm.customStartDate}
                      onChange={(e) =>
                        setBillingForm({ ...billingForm, customStartDate: e.target.value })
                      }
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-600 mb-1">إلى تاريخ</label>
                    <input
                      type="date"
                      value={billingForm.customEndDate}
                      onChange={(e) =>
                        setBillingForm({ ...billingForm, customEndDate: e.target.value })
                      }
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono"
                    />
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                {(billingForm.customStartDate || billingForm.customEndDate) && (
                  <button
                    type="button"
                    disabled={savingBillingPeriod}
                    onClick={(e) => handleSaveBillingPeriod(e, true)}
                    className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                  >
                    إلغاء التاريخ المخصص
                  </button>
                )}
                <button
                  type="submit"
                  disabled={savingBillingPeriod}
                  className="flex-1 rounded-lg bg-[#0B1F3A] py-2.5 font-bold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
                >
                  {savingBillingPeriod ? 'جاري الحفظ...' : 'حفظ الفترة الشهرية للمدرسة'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
