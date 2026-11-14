import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Plus, RotateCcw, Wallet } from 'lucide-react';
import { apiFetch, formatEGP } from '../../lib/api';
import type {
  AdvanceRecord,
  CoverageRecord,
  EnrichedDriver,
  FinancialTransaction,
  SalaryRecord,
} from '../../types';

interface FinanceOverview {
  period: { month: number; year: number };
  salaries: SalaryRecord[];
  advances: AdvanceRecord[];
  coverages: CoverageRecord[];
  ledger: FinancialTransaction[];
}

export const FinanceModule: React.FC = () => {
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [year, setYear] = useState(new Date().getFullYear());
  const [tab, setTab] = useState<'salaries' | 'advances' | 'coverage' | 'ledger'>('salaries');
  const [data, setData] = useState<FinanceOverview | null>(null);
  const [driversList, setDriversList] = useState<EnrichedDriver[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Forms
  const [advForm, setAdvForm] = useState({
    driverId: '',
    amount: '',
    date: new Date().toISOString().slice(0, 10),
    reason: 'سلفة نقدية',
    paymentMethod: 'cash',
    notes: '',
  });

  const [covForm, setCovForm] = useState({
    absentDriverId: '',
    replacementDriverId: '',
    replacementExternalName: '',
    date: new Date().toISOString().slice(0, 10),
    actualReplacementCost: '',
    absentDriverDeduction: '',
    reason: 'تغطية غياب سائق',
    notes: '',
  });

  const [adjForm, setAdjForm] = useState({
    driverId: '',
    type: 'bonus' as 'bonus' | 'other_deduction',
    amount: '',
    description: '',
  });

  const loadFinance = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [fin, drv] = await Promise.all([
        apiFetch<FinanceOverview>(`/api/finance/overview?month=${month}&year=${year}`),
        apiFetch<{ drivers: EnrichedDriver[] }>('/api/drivers'),
      ]);
      setData(fin);
      setDriversList(drv.drivers);
      if (!advForm.driverId && drv.drivers[0]) {
        const firstId = String(drv.drivers[0].id);
        setAdvForm((f) => ({ ...f, driverId: firstId }));
        setCovForm((f) => ({ ...f, absentDriverId: firstId }));
        setAdjForm((f) => ({ ...f, driverId: firstId }));
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل البيانات المالية');
    } finally {
      setLoading(false);
    }
  }, [month, year]);

  useEffect(() => {
    loadFinance();
  }, [loadFinance]);

  const handleRecordAdvance = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    try {
      const idempotencyKey = `adv-${advForm.driverId}-${advForm.amount}-${Date.now()}`;
      await apiFetch('/api/finance/advances', {
        method: 'POST',
        body: JSON.stringify({
          ...advForm,
          driverId: Number(advForm.driverId),
          amount: Number(advForm.amount),
          idempotencyKey,
        }),
      });
      setAdvForm((f) => ({ ...f, amount: '', notes: '' }));
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
      const absentDriver = driversList.find((d) => d.id === Number(covForm.absentDriverId));
      const idempotencyKey = `cov-${covForm.absentDriverId}-${covForm.date}-${Date.now()}`;
      await apiFetch('/api/finance/coverage', {
        method: 'POST',
        body: JSON.stringify({
          absentDriverId: Number(covForm.absentDriverId),
          replacementDriverId: covForm.replacementDriverId
            ? Number(covForm.replacementDriverId)
            : null,
          replacementExternalName: covForm.replacementExternalName,
          vehicleId: absentDriver?.vehicleId || null,
          schoolId: absentDriver?.schoolId || null,
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
        actualReplacementCost: '',
        absentDriverDeduction: '',
        replacementExternalName: '',
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
          driverId: Number(adjForm.driverId),
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
      setSuccessMsg('تم إنشاء قيد عكسي غير قابل للحذف وتحديث صافي الراتب تلقائياً.');
      await loadFinance();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تنفيذ قيد العكس');
    }
  };

  const handleSalaryStatus = async (salaryId: number, status: 'open' | 'approved' | 'paid') => {
    await apiFetch(`/api/finance/salaries/${salaryId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    await loadFinance();
  };

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

        <div className="flex items-center gap-2 shrink-0">
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
        </div>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-xl w-fit">
        {[
          { id: 'salaries', label: 'رواتب الشهر والتسويات' },
          { id: 'advances', label: 'تسجيل وإدارة السلف' },
          { id: 'coverage', label: 'تغطية الغياب' },
          { id: 'ledger', label: 'دفتر الأستاذ غير القابل للحذف' },
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
              <label className="block font-semibold text-slate-700 mb-1">السائق</label>
              <select
                value={adjForm.driverId}
                onChange={(e) => setAdjForm({ ...adjForm, driverId: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2"
              >
                {driversList.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.fullName} ({d.driverCode})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-semibold text-slate-700 mb-1">نوع التسوية</label>
              <select
                value={adjForm.type}
                onChange={(e) =>
                  setAdjForm({ ...adjForm, type: e.target.value as 'bonus' | 'other_deduction' })
                }
                className="w-full rounded-lg border border-slate-200 px-3 py-2"
              >
                <option value="bonus">مكافأة إضافية (+)</option>
                <option value="other_deduction">خصم إداري (−)</option>
              </select>
            </div>
            <div>
              <label className="block font-semibold text-slate-700 mb-1">المبلغ (ج.م)</label>
              <input
                type="number"
                required
                min={1}
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
                placeholder="مثال: مكافأة التزام"
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
                          <select
                            value={s.status}
                            onChange={(e) =>
                              handleSalaryStatus(
                                s.id,
                                e.target.value as 'open' | 'approved' | 'paid'
                              )
                            }
                            className="rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold"
                          >
                            <option value="open">قيد التشغيل</option>
                            <option value="approved">معتمد للصرف</option>
                            <option value="paid">تم الصرف</option>
                          </select>
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
              <select
                required
                value={advForm.driverId}
                onChange={(e) => setAdvForm({ ...advForm, driverId: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2"
              >
                {driversList.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.fullName} (كود {d.driverCode})
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">المبلغ (ج.م) *</label>
                <input
                  type="number"
                  required
                  min={1}
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
              <select
                value={advForm.paymentMethod}
                onChange={(e) => setAdvForm({ ...advForm, paymentMethod: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2"
              >
                <option value="cash">نقدي (كاش)</option>
                <option value="instapay">إنستاباي (InstaPay)</option>
                <option value="vodafone_cash">فودافون كاش</option>
                <option value="bank_transfer">تحويل بنكي</option>
              </select>
            </div>
            <div>
              <label className="block font-semibold text-slate-700 mb-1">السبب</label>
              <input
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
              سجل السلف للشهر المحدد
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-4">التاريخ</th>
                    <th className="py-3 px-4">السائق</th>
                    <th className="py-3 px-4">السبب والطريقة</th>
                    <th className="py-3 px-4">المبلغ</th>
                    <th className="py-3 px-4">الإجراء</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data?.advances.map((a) => (
                    <tr key={a.id} className={a.isReversed ? 'opacity-50 line-through' : ''}>
                      <td className="py-3 px-4 font-mono tabular-nums">{a.date}</td>
                      <td className="py-3 px-4">
                        <div className="font-semibold text-slate-900">{a.driverName}</div>
                        <div className="text-slate-500">كود {a.driverCode}</div>
                      </td>
                      <td className="py-3 px-4">
                        <div>{a.reason}</div>
                        <div className="text-slate-400">{a.paymentMethod}</div>
                      </td>
                      <td className="py-3 px-4 font-mono font-bold text-red-700 tabular-nums">
                        {formatEGP(a.amount)}
                      </td>
                      <td className="py-3 px-4">
                        {a.isReversed ? (
                          <span className="text-slate-500">معكوسة</span>
                        ) : (
                          <button
                            onClick={() => handleReverse('advance', a.id)}
                            className="flex items-center gap-1 text-[11px] font-semibold text-amber-700 hover:underline cursor-pointer"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            عكس القيد
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
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
              <select
                required
                value={covForm.absentDriverId}
                onChange={(e) => setCovForm({ ...covForm, absentDriverId: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2"
              >
                {driversList.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.fullName} (كود {d.driverCode})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                السائق البديل (من النظام)
              </label>
              <select
                value={covForm.replacementDriverId}
                onChange={(e) => setCovForm({ ...covForm, replacementDriverId: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2"
              >
                <option value="">سائق احتياطي خارجي</option>
                {driversList
                  .filter((d) => String(d.id) !== covForm.absentDriverId)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.fullName} (كود {d.driverCode})
                    </option>
                  ))}
              </select>
            </div>
            {!covForm.replacementDriverId && (
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  اسم السائق البديل الخارجي
                </label>
                <input
                  value={covForm.replacementExternalName}
                  onChange={(e) =>
                    setCovForm({ ...covForm, replacementExternalName: e.target.value })
                  }
                  placeholder="مثال: عماد شوقي"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
            )}
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
              سجل التغطيات للشهر المحدد
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
                    <th className="py-3 px-4">الإجراء</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data?.coverages.map((c) => (
                    <tr key={c.id} className={c.isReversed ? 'opacity-50 line-through' : ''}>
                      <td className="py-3 px-4 font-mono tabular-nums">{c.date}</td>
                      <td className="py-3 px-4">
                        <div className="font-semibold text-slate-900">{c.absentDriverName}</div>
                        <div className="text-slate-500">
                          كود {c.absentDriverCode} · {c.busNumber}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-slate-700">{c.replacementDriverName}</td>
                      <td className="py-3 px-4 font-mono text-slate-800 tabular-nums">
                        {formatEGP(c.actualReplacementCost)}
                      </td>
                      <td className="py-3 px-4 font-mono font-bold text-red-700 tabular-nums">
                        {formatEGP(c.absentDriverDeduction)}
                      </td>
                      <td className="py-3 px-4">
                        {c.isReversed ? (
                          <span className="text-slate-500">معكوسة</span>
                        ) : (
                          <button
                            onClick={() => handleReverse('coverage', c.id)}
                            className="flex items-center gap-1 text-[11px] font-semibold text-amber-700 hover:underline cursor-pointer"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            عكس القيد
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
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
              سجل القيود المالية (Immutable Financial Ledger)
            </h3>
            <span className="text-xs text-slate-500">جميع القيود محمية ضد الحذف الصامت</span>
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
    </div>
  );
};
