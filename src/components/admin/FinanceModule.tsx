import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CalendarCheck,
  CheckCircle2,
  Edit3,
  Eye,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  Wallet,
  X,
} from 'lucide-react';
import { apiFetch, formatEGP } from '../../lib/api';
import type {
  AdvanceRecord,
  CoverageRecord,
  FinancialTransaction,
  SalaryRecord,
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

interface MonthlyClosingRecord {
  id: number;
  month: number;
  year: number;
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
  };
}

interface FinanceOverview {
  period: { month: number; year: number };
  activePeriod?: { month: number; year: number };
  currentClosing?: MonthlyClosingRecord | null;
  closingsHistory?: MonthlyClosingRecord[];
  salaries: SalaryRecord[];
  advances: AdvanceRecord[];
  coverages: CoverageRecord[];
  ledger: FinancialTransaction[];
}

export const FinanceModule: React.FC = () => {
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [year, setYear] = useState(new Date().getFullYear());
  const initialSyncedRef = useRef(false);
  const [tab, setTab] = useState<'salaries' | 'advances' | 'coverage' | 'ledger' | 'closing'>('salaries');
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
    date: new Date().toISOString().slice(0, 10),
    reason: '',
    paymentMethod: '',
    notes: '',
  });

  const [covForm, setCovForm] = useState({
    absentDriverQuery: '',
    replacementQuery: '',
    date: new Date().toISOString().slice(0, 10),
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

  const loadFinance = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = initialSyncedRef.current
        ? `/api/finance/overview?month=${month}&year=${year}`
        : `/api/finance/overview`;
      const fin = await apiFetch<FinanceOverview>(url);
      if (!initialSyncedRef.current) {
        initialSyncedRef.current = true;
        setMonth(fin.period.month);
        setYear(fin.period.year);
      }
      setData(fin);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل البيانات المالية');
    } finally {
      setLoading(false);
    }
  }, [month, year]);

  useEffect(() => {
    loadFinance();
  }, [loadFinance]);

  useEffect(() => {
    const curNow = new Date();
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    const targetDate =
      month === curNow.getMonth() + 1 && year === curNow.getFullYear()
        ? curNow.toISOString().slice(0, 10)
        : `${prefix}-01`;
    setAdvForm((f) => (f.date.startsWith(prefix) ? f : { ...f, date: targetDate }));
    setCovForm((f) => (f.date.startsWith(prefix) ? f : { ...f, date: targetDate }));
  }, [month, year]);

  const handleRecordAdvance = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    try {
      const idempotencyKey = `adv-${advForm.driverQuery.trim()}-${advForm.amount}-${Date.now()}`;
      await apiFetch('/api/finance/advances', {
        method: 'POST',
        body: JSON.stringify({
          driverQuery: advForm.driverQuery.trim(),
          amount: Number(advForm.amount),
          date: advForm.date,
          reason: advForm.reason,
          paymentMethod: advForm.paymentMethod,
          notes: advForm.notes,
          idempotencyKey,
        }),
      });
      setAdvForm((f) => ({ ...f, amount: '', reason: '', paymentMethod: '', notes: '' }));
      setSuccessMsg('تم تسجيل السلفة وتحديث صافي راتب السائق وإرسال إشعار له.');
      await loadFinance();
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
      await apiFetch('/api/finance/coverage', {
        method: 'POST',
        body: JSON.stringify({
          absentDriverQuery: covForm.absentDriverQuery.trim(),
          replacementQuery: covForm.replacementQuery.trim(),
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
      setSuccessMsg('تم تسجيل تغطية الغياب والفصل بين تكلفة البديل والخصم على السائق الغائب.');
      await loadFinance();
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
      await apiFetch(`/api/finance/advances/${editingAdvance.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          amount: Number(editAdvForm.amount),
          date: editAdvForm.date,
          paymentMethod: editAdvForm.paymentMethod,
          reason: editAdvForm.reason,
          notes: editAdvForm.notes,
        }),
      });
      setEditingAdvance(null);
      setSuccessMsg('تم تعديل بيانات السلفة وإعادة احتساب صافي الراتب.');
      await loadFinance();
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
      await apiFetch(`/api/finance/coverage/${editingCoverage.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          replacementQuery: editCovForm.replacementQuery.trim(),
          date: editCovForm.date,
          actualReplacementCost: Number(editCovForm.actualReplacementCost || 0),
          absentDriverDeduction: Number(editCovForm.absentDriverDeduction || 0),
          reason: editCovForm.reason,
          notes: editCovForm.notes,
        }),
      });
      setEditingCoverage(null);
      setSuccessMsg('تم تعديل سجل التغطية وإعادة احتساب صافي الراتب.');
      await loadFinance();
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
    await apiFetch(`/api/finance/salaries/${salaryId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    await loadFinance();
  };

  const handleCloseMonthAndStartNext = async () => {
    setBusyClosing(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await apiFetch<{
        closing: MonthlyClosingRecord;
        nextPeriod: { month: number; year: number };
      }>('/api/finance/close-month', {
        method: 'POST',
        body: JSON.stringify({
          month,
          year,
          markAllPaid: markAllPaidOnClose,
          notes: closingNotes.trim(),
        }),
      });
      setConfirmCloseOpen(false);
      setClosingNotes('');
      initialSyncedRef.current = true;
      setMonth(res.nextPeriod.month);
      setYear(res.nextPeriod.year);
      setSuccessMsg(
        `تمت تصفية شهر ${month}/${year} بنجاح وفتح شهر ${res.nextPeriod.month}/${res.nextPeriod.year} على بياض بنفس السائقين والمركبات والمدارس.`
      );
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
    try {
      await apiFetch('/api/finance/reset-month', {
        method: 'POST',
        body: JSON.stringify({ month, year, resetEmployees: true }),
      });
      setConfirmResetOpen(false);
      setSuccessMsg(
        `تم تصفير مالية شهر ${month}/${year} بالكامل وبدؤه على بياض مع الإبقاء على جميع السائقين والموظفين والمدارس والمركبات.`
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
  const monthTotalBase = data?.salaries.reduce((s, r) => s + Number(r.baseSalary || 0), 0) || 0;
  const monthTotalAdvances = data?.salaries.reduce((s, r) => s + Number(r.totalAdvances || 0), 0) || 0;
  const monthTotalCoverages =
    data?.salaries.reduce((s, r) => s + Number(r.totalCoverageDeductions || 0), 0) || 0;
  const monthTotalBonuses = data?.salaries.reduce((s, r) => s + Number(r.bonuses || 0), 0) || 0;
  const monthTotalOtherDed =
    data?.salaries.reduce((s, r) => s + Number(r.otherDeductions || 0), 0) || 0;
  const monthTotalNet = data?.salaries.reduce((s, r) => s + Number(r.netSalary || 0), 0) || 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#0B1F3A]">
            الإدارة المالية والمرتبات
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            المعادلة المعتمدة: صافي الراتب = الأساسي − السلف − خصم التغطية − الخصومات الأخرى + المكافآت
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
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
            onClick={() => setTab('closing')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#C89B3C] hover:bg-[#d8ac4e] px-3.5 py-2 text-xs font-bold text-[#0B1F3A] cursor-pointer"
          >
            <CalendarCheck className="w-4 h-4" />
            تصفية الشهر وبدء شهر جديد
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-xl w-fit">
        {[
          { id: 'salaries', label: 'رواتب الشهر والتسويات' },
          { id: 'advances', label: 'تسجيل وإدارة السلف' },
          { id: 'coverage', label: 'تغطية الغياب' },
          { id: 'ledger', label: 'دفتر الأستاذ المالي' },
          { id: 'closing', label: 'التصفية وبداية شهر جديد' },
        ].map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id as typeof tab)}
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
              {new Date(data.currentClosing.closedAt).toLocaleDateString('ar-EG')} — جميع بيانات وسلف وتغطيات ورواتب هذا الشهر محفوظة كما هي تماماً.
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
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-800">
          {error}
        </div>
      )}
      {successMsg && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {tab === 'salaries' && (
        <div className="space-y-6">
          {/* Quick Bonus / Other Deduction Form */}
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

          {/* Salaries Table */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
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
                  ) : (
                    data?.salaries.map((s) => (
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

          <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 font-bold text-sm text-[#0B1F3A]">
              سجل السلف للشهر المحدد ({data?.advances.length || 0})
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-4">التاريخ</th>
                    <th className="py-3 px-4">السائق</th>
                    <th className="py-3 px-4">السبب والطريقة</th>
                    <th className="py-3 px-4">المبلغ</th>
                    <th className="py-3 px-4">تعديل / حذف / إجراء</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {!data?.advances.length ? (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-slate-400">
                        لا توجد سلف مسجلة لهذا الشهر
                      </td>
                    </tr>
                  ) : (
                    data.advances.map((a) => (
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
                        <td className="py-3 px-4">
                          <div className="flex flex-wrap items-center gap-1.5">
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
                            {a.isReversed ? (
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
                            )}
                          </div>
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

      {tab === 'coverage' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
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

          <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 font-bold text-sm text-[#0B1F3A]">
              سجل التغطيات للشهر المحدد ({data?.coverages.length || 0})
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
                    <th className="py-3 px-4">تعديل / حذف / إجراء</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {!data?.coverages.length ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-slate-400">
                        لا توجد تغطيات مسجلة لهذا الشهر
                      </td>
                    </tr>
                  ) : (
                    data.coverages.map((c) => (
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
                        <td className="py-3 px-4">
                          <div className="flex flex-wrap items-center gap-1.5">
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
                            {c.isReversed ? (
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
                            )}
                          </div>
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
                {data?.ledger.map((t) => (
                  <tr key={t.id}>
                    <td className="py-3 px-4 font-mono text-slate-400">{t.id}</td>
                    <td className="py-3 px-4 font-mono text-slate-500 tabular-nums">
                      {new Date(t.createdAt).toLocaleString('ar-EG')}
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
                يُقفل شهر <strong>{month}/{year}</strong> ويُحفظ تقريره المالي بالكامل في سجل التصفيات، وتُصفَّر مكافآت وخصومات الموظفين الشهرية، ويُفتح شهر{' '}
                <strong>{nextMonthPreview}/{nextYearPreview}</strong> بأرصدة صفرية للسلف والتغطيات مع بقاء كافة السائقين والمدارس والمركبات.
              </p>

              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={markAllPaidOnClose}
                  onChange={(e) => setMarkAllPaidOnClose(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span>تحديد جميع رواتب شهر {month}/{year} كـ «تم الصرف» عند التصفية</span>
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
                اعتماد تصفية شهر {month}/{year} وبدء شهر {nextMonthPreview}/{nextYearPreview} على بياض
              </button>
            </div>

            {/* Action 2: Reset Current Selected Month Financials */}
            <div className="bg-white border border-amber-200 rounded-2xl p-6 space-y-4">
              <div className="flex items-center gap-2 font-display text-base font-bold text-amber-900">
                <RotateCcw className="w-5 h-5 text-amber-600" />
                <span>2. تصفير مالية شهر {month}/{year} فقط (إعادة ضبط على بياض)</span>
              </div>
              <p className="text-xs text-slate-600 leading-relaxed">
                استخدم هذا الخيار إذا أردت مسح جميع السلف والتغطيات والمكافآت والخصومات الخاصة بشهر{' '}
                <strong>{month}/{year}</strong> فقط والبدء فيه على بياض من جديد — مع الحفاظ الكامل على كل السائقين والموظفين والمدارس والمركبات وخطوط السير دون حذف أي شخص أو مركبة.
              </p>
              <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-[11px] text-amber-900">
                تنبيه: لن تتأثر الأشهر الأخرى أو ملفات السائقين والمدارس؛ التصفير يطال الحركات المالية لشهر {month}/{year} فقط.
              </div>
              <button
                type="button"
                onClick={() => setConfirmResetOpen(true)}
                className="w-full rounded-xl border border-red-300 bg-red-50 hover:bg-red-100 py-3 px-4 text-xs font-bold text-red-800 cursor-pointer"
              >
                تصفير مالية شهر {month}/{year} على بياض الآن
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
                      <th className="py-3 px-4">الشهر المصفى</th>
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
                        <td className="py-3 px-4 font-mono font-bold text-[#0B1F3A]">
                          {c.month} / {c.year}
                        </td>
                        <td className="py-3 px-4 text-slate-500">
                          {new Date(c.closedAt).toLocaleDateString('ar-EG')}
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
                  كشف تصفية شهر {inspectClosing.month} / {inspectClosing.year}
                </h3>
                <p className="text-xs text-slate-300 mt-0.5">
                  تاريخ التصفية: {new Date(inspectClosing.closedAt).toLocaleString('ar-EG')}
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
    </div>
  );
};
