import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Briefcase,
  Bus,
  CheckCircle2,
  FileText,
  RotateCcw,
  Search,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch, formatEGP, normalizeLookupText } from '../../lib/api';
import { useEscapeKey } from '../../lib/useEscapeKey';
import { DriverAvatar } from '../DriverAvatar';
import type {
  EmployeeRecord,
  EnrichedDriver,
  FleetVehicle,
  SalaryRecord,
  SchoolItem,
} from '../../types';

interface ArchivePayload {
  drivers: EnrichedDriver[];
  employees: EmployeeRecord[];
  vehicles: FleetVehicle[];
  schools: SchoolItem[];
}

interface ArchivedDriverStatement {
  driver: EnrichedDriver;
  period: { month: number; year: number };
  salary: SalaryRecord;
}

export const ArchiveModule: React.FC = () => {
  const { dbUser } = useAuth();
  const perms = dbUser?.permissions || [];
  const isSuperAdmin = dbUser?.roleSlug === 'super_admin' || perms.includes('*');
  const can = (p: string) => isSuperAdmin || perms.includes('*') || perms.includes(p);

  const [data, setData] = useState<ArchivePayload>({
    drivers: [],
    employees: [],
    vehicles: [],
    schools: [],
  });
  const [tab, setTab] = useState<'drivers' | 'employees' | 'assets'>('drivers');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [deleteDriverTarget, setDeleteDriverTarget] = useState<EnrichedDriver | null>(null);
  const [deleteEmployeeTarget, setDeleteEmployeeTarget] = useState<EmployeeRecord | null>(null);
  const [deleteVehicleTarget, setDeleteVehicleTarget] = useState<FleetVehicle | null>(null);
  const [deleteSchoolTarget, setDeleteSchoolTarget] = useState<SchoolItem | null>(null);
  const [statementPreview, setStatementPreview] = useState<ArchivedDriverStatement | null>(null);

  useEscapeKey(
    Boolean(
      deleteSchoolTarget ||
        deleteVehicleTarget ||
        deleteEmployeeTarget ||
        deleteDriverTarget ||
        statementPreview
    ),
    () => {
      if (deleteSchoolTarget) setDeleteSchoolTarget(null);
      else if (deleteVehicleTarget) setDeleteVehicleTarget(null);
      else if (deleteEmployeeTarget) setDeleteEmployeeTarget(null);
      else if (deleteDriverTarget) setDeleteDriverTarget(null);
      else if (statementPreview) setStatementPreview(null);
    }
  );

  const loadArchive = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<ArchivePayload>('/api/archive');
      setData(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل بيانات الأرشفة');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadArchive();
  }, [loadArchive]);

  const restoreDriver = async (d: EnrichedDriver) => {
    setBusyId(`driver-${d.id}`);
    setError(null);
    setMessage(null);
    try {
      await apiFetch(`/api/archive/drivers/${d.id}/restore`, { method: 'POST' });
      setMessage(`تمت استعادة السائق ${d.fullName} إلى القائمة النشطة بنجاح.`);
      await loadArchive();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر استعادة السائق');
    } finally {
      setBusyId(null);
    }
  };

  const restoreEmployee = async (emp: EmployeeRecord) => {
    setBusyId(`emp-${emp.id}`);
    setError(null);
    setMessage(null);
    try {
      await apiFetch(`/api/archive/employees/${emp.id}/restore`, { method: 'POST' });
      setMessage(`تمت استعادة الموظف ${emp.fullName} إلى القائمة النشطة بنجاح.`);
      await loadArchive();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر استعادة الموظف');
    } finally {
      setBusyId(null);
    }
  };

  const restoreVehicle = async (v: FleetVehicle) => {
    setBusyId(`veh-${v.id}`);
    setError(null);
    setMessage(null);
    try {
      await apiFetch(`/api/archive/vehicles/${v.id}/restore`, { method: 'POST' });
      setMessage(`تمت استعادة المركبة ${v.busNumber} إلى التشغيل.`);
      await loadArchive();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر استعادة المركبة');
    } finally {
      setBusyId(null);
    }
  };

  const restoreSchool = async (s: SchoolItem) => {
    setBusyId(`school-${s.id}`);
    setError(null);
    setMessage(null);
    try {
      await apiFetch(`/api/archive/schools/${s.id}/restore`, { method: 'POST' });
      setMessage(`تمت استعادة ${s.name} إلى القائمة النشطة.`);
      await loadArchive();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر استعادة المدرسة');
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteDriver = async () => {
    if (!deleteDriverTarget) return;
    setBusyId(`del-driver-${deleteDriverTarget.id}`);
    setError(null);
    setMessage(null);
    try {
      await apiFetch(`/api/archive/drivers/${deleteDriverTarget.id}`, { method: 'DELETE' });
      const deletedName = deleteDriverTarget.fullName;
      setDeleteDriverTarget(null);
      setMessage(`تم حذف السائق ${deletedName} نهائياً من النظام.`);
      await loadArchive();
    } catch (err: unknown) {
      setDeleteDriverTarget(null);
      setError(err instanceof Error ? err.message : 'تعذر الحذف النهائي للسائق');
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteEmployee = async () => {
    if (!deleteEmployeeTarget) return;
    setBusyId(`del-emp-${deleteEmployeeTarget.id}`);
    setError(null);
    setMessage(null);
    try {
      await apiFetch(`/api/archive/employees/${deleteEmployeeTarget.id}`, { method: 'DELETE' });
      const deletedName = deleteEmployeeTarget.fullName;
      setDeleteEmployeeTarget(null);
      setMessage(`تم حذف الموظف ${deletedName} نهائياً من النظام.`);
      await loadArchive();
    } catch (err: unknown) {
      setDeleteEmployeeTarget(null);
      setError(err instanceof Error ? err.message : 'تعذر حذف الموظف نهائياً');
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteVehicle = async () => {
    if (!deleteVehicleTarget) return;
    setBusyId(`del-veh-${deleteVehicleTarget.id}`);
    setError(null);
    setMessage(null);
    try {
      await apiFetch(`/api/archive/vehicles/${deleteVehicleTarget.id}`, { method: 'DELETE' });
      const busNum = deleteVehicleTarget.busNumber;
      setDeleteVehicleTarget(null);
      setMessage(`تم حذف المركبة ${busNum} نهائياً من النظام.`);
      await loadArchive();
    } catch (err: unknown) {
      setDeleteVehicleTarget(null);
      setError(err instanceof Error ? err.message : 'تعذر الحذف النهائي للمركبة');
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteSchool = async () => {
    if (!deleteSchoolTarget) return;
    setBusyId(`del-school-${deleteSchoolTarget.id}`);
    setError(null);
    setMessage(null);
    try {
      await apiFetch(`/api/archive/schools/${deleteSchoolTarget.id}`, { method: 'DELETE' });
      const schoolName = deleteSchoolTarget.name;
      setDeleteSchoolTarget(null);
      setMessage(`تم حذف المدرسة ${schoolName} نهائياً من النظام.`);
      await loadArchive();
    } catch (err: unknown) {
      setDeleteSchoolTarget(null);
      setError(err instanceof Error ? err.message : 'تعذر الحذف النهائي للمدرسة');
    } finally {
      setBusyId(null);
    }
  };

  const openStatementPreview = async (driverId: number) => {
    const now = new Date();
    try {
      const res = await apiFetch<ArchivedDriverStatement>(
        `/api/drivers/${driverId}/statement?month=${now.getMonth() + 1}&year=${now.getFullYear()}`
      );
      setStatementPreview(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل كشف الحساب');
    }
  };

  const q = normalizeLookupText(search);
  const digitsOnly = q.replace(/\D/g, '');
  const filteredDrivers = data.drivers.filter(
    (d) =>
      !q ||
      normalizeLookupText(d.fullName).includes(q) ||
      normalizeLookupText(d.driverCode).includes(q) ||
      normalizeLookupText(d.phone).includes(q) ||
      (digitsOnly.length >= 2 && normalizeLookupText(d.phone).replace(/\D/g, '').includes(digitsOnly))
  );
  const filteredEmployees = data.employees.filter(
    (e) =>
      !q ||
      normalizeLookupText(e.fullName).includes(q) ||
      normalizeLookupText(e.employeeCode).includes(q) ||
      normalizeLookupText(e.jobTitle).includes(q)
  );
  const filteredVehicles = data.vehicles.filter(
    (v) =>
      !q ||
      normalizeLookupText(v.busNumber).includes(q) ||
      normalizeLookupText(v.registrationNumber).includes(q) ||
      normalizeLookupText(v.ownerName).includes(q) ||
      normalizeLookupText(v.schoolName || '').includes(q)
  );
  const filteredSchools = data.schools.filter(
    (s) =>
      !q ||
      normalizeLookupText(s.name).includes(q) ||
      normalizeLookupText(s.contactName || '').includes(q) ||
      normalizeLookupText(s.contactPhone || '').includes(q)
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#0B1F3A] flex items-center gap-2.5">
            <Archive className="w-6 h-6 text-[#C89B3C]" />
            الأرشفة
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            مكان مخصص ومستقل للسجلات المؤرشفة — لا تظهر أي سجلات مؤرشفة في القوائم النشطة أو لوحة التحكم
          </p>
        </div>
      </div>

      {/* Category Switcher + Search */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1.5 p-1 bg-slate-100 rounded-lg self-start">
          {[
            { id: 'drivers' as const, label: `السائقون (${data.drivers.length})`, icon: Users },
            { id: 'employees' as const, label: `الموظفون (${data.employees.length})`, icon: Briefcase },
            {
              id: 'assets' as const,
              label: `المدارس والمركبات (${data.vehicles.length + data.schools.length})`,
              icon: Bus,
            },
          ].map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                  tab === t.id
                    ? 'bg-[#0B1F3A] text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {t.label}
              </button>
            );
          })}
        </div>

        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="بحث في الأرشيف بالاسم أو الكود أو الهاتف..."
            className="w-full rounded-lg border border-slate-200 bg-slate-50 pr-9 pl-8 py-2 text-xs focus:border-[#0B1F3A] focus:outline-none"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="مسح البحث"
              className="absolute left-2.5 top-2 text-slate-400 hover:text-slate-700 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-800">
          {error}
        </div>
      )}

      {message && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs font-semibold text-emerald-900 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>{message}</span>
        </div>
      )}

      {/* ARCHIVED DRIVERS */}
      {tab === 'drivers' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {loading ? (
            <div className="p-10 text-center text-xs text-slate-400">جاري تحميل الأرشيف...</div>
          ) : filteredDrivers.length === 0 ? (
            <div className="p-12 text-center text-xs text-slate-400">
              لا يوجد سائقون في الأرشفة حالياً
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {filteredDrivers.map((d) => (
                <div
                  key={d.id}
                  className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-slate-50/70"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <DriverAvatar name={d.fullName} photoUrl={d.photoUrl} size="md" />
                    <div className="min-w-0">
                      <div className="font-bold text-sm text-[#0B1F3A] truncate">{d.fullName}</div>
                      <div className="text-xs text-slate-500 mt-0.5 font-mono">
                        كود {d.driverCode} · {d.phone} · الراتب: {formatEGP(d.monthlyAgreedSalary)}
                      </div>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        {d.schoolName} · باص {d.busNumber}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={busyId === `driver-${d.id}`}
                      onClick={() => restoreDriver(d)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[#0B1F3A] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5 text-[#C89B3C]" />
                      استعادة للنشطين
                    </button>
                    <button
                      type="button"
                      onClick={() => openStatementPreview(d.id)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                    >
                      <FileText className="w-3.5 h-3.5" />
                      كشف حساب
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteDriverTarget(d)}
                      className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      حذف نهائي
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ARCHIVED EMPLOYEES */}
      {tab === 'employees' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {loading ? (
            <div className="p-10 text-center text-xs text-slate-400">جاري تحميل الأرشيف...</div>
          ) : filteredEmployees.length === 0 ? (
            <div className="p-12 text-center text-xs text-slate-400">
              لا يوجد موظفون في الأرشفة حالياً
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {filteredEmployees.map((emp) => (
                <div
                  key={emp.id}
                  className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-slate-50/70"
                >
                  <div>
                    <div className="font-bold text-sm text-[#0B1F3A]">{emp.fullName}</div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {emp.jobTitle || 'موظف'} · كود {emp.employeeCode || '—'} ·{' '}
                      <span className="font-mono">{emp.phone || '—'}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busyId === `emp-${emp.id}`}
                      onClick={() => restoreEmployee(emp)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[#0B1F3A] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5 text-[#C89B3C]" />
                      استعادة للنشطين
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteEmployeeTarget(emp)}
                      className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      حذف نهائي
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ARCHIVED VEHICLES & SCHOOLS */}
      {tab === 'assets' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 font-bold text-sm text-[#0B1F3A]">
              المركبات المؤرشفة ({filteredVehicles.length})
            </div>
            {filteredVehicles.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-400">لا توجد مركبات مؤرشفة</div>
            ) : (
              <div className="divide-y divide-slate-100">
                {filteredVehicles.map((v) => (
                  <div key={v.id} className="p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
                    <div>
                      <div className="font-bold text-[#0B1F3A] font-mono">
                        {v.busNumber} · {v.registrationNumber}
                      </div>
                      <div className="text-slate-500 mt-0.5">
                        المالك: {v.ownerName || '—'} · {v.schoolName || 'غير معين'}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {can('vehicles:write') && (
                        <>
                          <button
                            type="button"
                            disabled={busyId === `veh-${v.id}`}
                            onClick={() => restoreVehicle(v)}
                            className="inline-flex items-center gap-1 rounded-lg bg-[#0B1F3A] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#13325c] disabled:opacity-50 whitespace-nowrap cursor-pointer"
                          >
                            <RotateCcw className="w-3.5 h-3.5 text-[#C89B3C]" />
                            استعادة
                          </button>
                          <button
                            type="button"
                            disabled={busyId === `del-veh-${v.id}`}
                            onClick={() => setDeleteVehicleTarget(v)}
                            className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50 whitespace-nowrap cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            حذف نهائي
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 font-bold text-sm text-[#0B1F3A]">
              المدارس المؤرشفة ({filteredSchools.length})
            </div>
            {filteredSchools.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-400">لا توجد مدارس مؤرشفة</div>
            ) : (
              <div className="divide-y divide-slate-100">
                {filteredSchools.map((s) => (
                  <div key={s.id} className="p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
                    <div>
                      <div className="font-bold text-[#0B1F3A]">{s.name}</div>
                      <div className="text-slate-500 mt-0.5 tabular-nums">
                        قيمة العقد: {formatEGP(s.monthlyContractValue)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {can('schools:write') && (
                        <>
                          <button
                            type="button"
                            disabled={busyId === `school-${s.id}`}
                            onClick={() => restoreSchool(s)}
                            className="inline-flex items-center gap-1 rounded-lg bg-[#0B1F3A] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#13325c] disabled:opacity-50 whitespace-nowrap cursor-pointer"
                          >
                            <RotateCcw className="w-3.5 h-3.5 text-[#C89B3C]" />
                            استعادة
                          </button>
                          <button
                            type="button"
                            disabled={busyId === `del-school-${s.id}`}
                            onClick={() => setDeleteSchoolTarget(s)}
                            className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50 whitespace-nowrap cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            حذف نهائي
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Statement Modal for Archived Driver */}
      {statementPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-lg bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
            <div className="px-5 py-4 bg-[#0B1F3A] text-white flex items-center justify-between">
              <h3 className="font-display text-sm font-bold">
                ملخص حساب {statementPreview.driver.fullName}
              </h3>
              <button
                type="button"
                onClick={() => setStatementPreview(null)}
                className="text-slate-300 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 grid grid-cols-2 gap-3 text-xs">
              <div className="border border-slate-200 rounded-lg p-3">
                <div className="text-slate-500">الراتب الأساسي</div>
                <div className="font-mono font-bold mt-1">
                  {formatEGP(statementPreview.salary.baseSalary)}
                </div>
              </div>
              <div className="border border-slate-200 rounded-lg p-3">
                <div className="text-slate-500">السلف</div>
                <div className="font-mono font-bold text-red-700 mt-1">
                  − {formatEGP(statementPreview.salary.totalAdvances)}
                </div>
              </div>
              <div className="border border-slate-200 rounded-lg p-3">
                <div className="text-slate-500">خصم التغطيات</div>
                <div className="font-mono font-bold text-red-700 mt-1">
                  − {formatEGP(statementPreview.salary.totalCoverageDeductions)}
                </div>
              </div>
              <div className="bg-[#0B1F3A] text-white rounded-lg p-3">
                <div className="text-slate-300">صافي المستحق</div>
                <div className="font-mono font-bold text-[#C89B3C] mt-1">
                  {formatEGP(statementPreview.salary.netSalary)}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Permanent Delete Driver Confirmation */}
      {deleteDriverTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
            <div className="px-5 py-4 bg-red-700 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5" />
                <h3 className="font-display text-sm font-bold">تأكيد الحذف النهائي للسائق</h3>
              </div>
              <button
                type="button"
                onClick={() => setDeleteDriverTarget(null)}
                className="text-red-100 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4 text-xs">
              <p className="text-slate-700 leading-relaxed">
                هل تريد حذف السائق <strong>{deleteDriverTarget.fullName}</strong> (كود{' '}
                <strong className="font-mono">{deleteDriverTarget.driverCode}</strong>) نهائياً من النظام؟
                سيتم مسح ملفه ورواتبه وسجلاته المرتبطة بشكل نهائي لا يمكن التراجع عنه.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDeleteDriverTarget(null)}
                  className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="button"
                  disabled={busyId === `del-driver-${deleteDriverTarget.id}`}
                  onClick={handleDeleteDriver}
                  className="rounded-lg bg-red-600 px-4 py-2 font-bold text-white hover:bg-red-700 disabled:opacity-50 cursor-pointer"
                >
                  حذف نهائي
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Permanent Delete Employee Confirmation */}
      {deleteEmployeeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
            <div className="px-5 py-4 bg-red-700 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5" />
                <h3 className="font-display text-sm font-bold">تأكيد الحذف النهائي للموظف</h3>
              </div>
              <button
                type="button"
                onClick={() => setDeleteEmployeeTarget(null)}
                className="text-red-100 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4 text-xs">
              <p className="text-slate-700 leading-relaxed">
                هل تريد حذف الموظف <strong>{deleteEmployeeTarget.fullName}</strong> نهائياً من النظام؟ هذا الإجراء لا يمكن التراجع عنه.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDeleteEmployeeTarget(null)}
                  className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="button"
                  disabled={busyId === `del-emp-${deleteEmployeeTarget.id}`}
                  onClick={handleDeleteEmployee}
                  className="rounded-lg bg-red-600 px-4 py-2 font-bold text-white hover:bg-red-700 disabled:opacity-50 cursor-pointer"
                >
                  حذف نهائي
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Permanent Delete Vehicle Confirmation */}
      {deleteVehicleTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
            <div className="px-5 py-4 bg-red-700 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5" />
                <h3 className="font-display text-sm font-bold">تأكيد الحذف النهائي للمركبة</h3>
              </div>
              <button
                type="button"
                onClick={() => setDeleteVehicleTarget(null)}
                className="text-red-100 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4 text-xs">
              <p className="text-slate-700 leading-relaxed">
                هل تريد حذف المركبة <strong className="font-mono">{deleteVehicleTarget.busNumber}</strong> (لوحة{' '}
                <strong className="font-mono">{deleteVehicleTarget.registrationNumber}</strong>) نهائياً من النظام؟
                لا يمكن التراجع عن هذا الإجراء.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDeleteVehicleTarget(null)}
                  className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="button"
                  disabled={busyId === `del-veh-${deleteVehicleTarget.id}`}
                  onClick={handleDeleteVehicle}
                  className="rounded-lg bg-red-600 px-4 py-2 font-bold text-white hover:bg-red-700 disabled:opacity-50 cursor-pointer"
                >
                  حذف نهائي
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Permanent Delete School Confirmation */}
      {deleteSchoolTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
            <div className="px-5 py-4 bg-red-700 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5" />
                <h3 className="font-display text-sm font-bold">تأكيد الحذف النهائي للمدرسة</h3>
              </div>
              <button
                type="button"
                onClick={() => setDeleteSchoolTarget(null)}
                className="text-red-100 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4 text-xs">
              <p className="text-slate-700 leading-relaxed">
                هل تريد حذف المدرسة <strong>{deleteSchoolTarget.name}</strong> نهائياً من النظام؟ سيتم فك ارتباطها بالسجلات وحذفها بشكل نهائي لا يمكن التراجع عنه.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDeleteSchoolTarget(null)}
                  className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="button"
                  disabled={busyId === `del-school-${deleteSchoolTarget.id}`}
                  onClick={handleDeleteSchool}
                  className="rounded-lg bg-red-600 px-4 py-2 font-bold text-white hover:bg-red-700 disabled:opacity-50 cursor-pointer"
                >
                  حذف نهائي
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
