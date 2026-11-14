import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  FileText,
  Plus,
  Printer,
  Search,
  Trash2,
  UserCheck,
  UserX,
  Edit3,
  X,
} from 'lucide-react';
import { apiFetch, formatEGP } from '../../lib/api';
import { ContactPhoneInput } from '../ContactPhoneInput';
import { DriverAvatar } from '../DriverAvatar';
import { DriverPhotoUploader } from '../DriverPhotoUploader';
import type {
  AdvanceRecord,
  CoverageRecord,
  EnrichedDriver,
  FinancialTransaction,
  FleetVehicle,
  RouteItem,
  SalaryRecord,
  SchoolItem,
} from '../../types';

interface StatementResponse {
  driver: EnrichedDriver;
  period: { month: number; year: number };
  salary: SalaryRecord;
  advances: AdvanceRecord[];
  coverages: CoverageRecord[];
  transactions: FinancialTransaction[];
}

export const DriversModule: React.FC = () => {
  const [driversList, setDriversList] = useState<EnrichedDriver[]>([]);
  const [schoolsList, setSchoolsList] = useState<SchoolItem[]>([]);
  const [vehiclesList, setVehiclesList] = useState<FleetVehicle[]>([]);
  const [routesList, setRoutesList] = useState<RouteItem[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add/Edit Modal
  const [showForm, setShowForm] = useState(false);
  const [editingDriver, setEditingDriver] = useState<EnrichedDriver | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [formState, setFormState] = useState({
    driverCode: '',
    fullName: '',
    phone: '',
    emergencyContact: '',
    linkedEmail: '',
    monthlyAgreedSalary: '',
    employmentStartDate: new Date().toISOString().slice(0, 10),
    accountStatus: 'active',
    photoUrl: '',
    notes: '',
    schoolId: '',
    vehicleId: '',
    routeId: '',
  });

  // Statement Modal
  const [statementDriverId, setStatementDriverId] = useState<number | null>(null);
  const [statementMonth, setStatementMonth] = useState(new Date().getMonth() + 1);
  const [statementYear, setStatementYear] = useState(new Date().getFullYear());
  const [statementData, setStatementData] = useState<StatementResponse | null>(null);
  const [statementLoading, setStatementLoading] = useState(false);

  // Delete Confirmation Modal
  const [deleteTarget, setDeleteTarget] = useState<EnrichedDriver | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [dRes, sRes, vRes] = await Promise.all([
        apiFetch<{ drivers: EnrichedDriver[] }>('/api/drivers'),
        apiFetch<{ schools: SchoolItem[]; routes: RouteItem[] }>('/api/schools'),
        apiFetch<{ vehicles: FleetVehicle[] }>('/api/vehicles'),
      ]);
      setDriversList(dRes.drivers);
      setSchoolsList(sRes.schools);
      setRoutesList(sRes.routes);
      setVehiclesList(vRes.vehicles);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل بيانات السائقين');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const openAdd = () => {
    setEditingDriver(null);
    setFormError(null);
    setFormState({
      driverCode: '',
      fullName: '',
      phone: '',
      emergencyContact: '',
      linkedEmail: '',
      monthlyAgreedSalary: '7000',
      employmentStartDate: new Date().toISOString().slice(0, 10),
      accountStatus: 'active',
      photoUrl: '',
      notes: '',
      schoolId: schoolsList[0]?.id ? String(schoolsList[0].id) : '',
      vehicleId: vehiclesList[0]?.id ? String(vehiclesList[0].id) : '',
      routeId: '',
    });
    setShowForm(true);
  };

  const openEdit = (d: EnrichedDriver) => {
    setEditingDriver(d);
    setFormError(null);
    setFormState({
      driverCode: d.driverCode,
      fullName: d.fullName,
      phone: d.phone,
      emergencyContact: d.emergencyContact || '',
      linkedEmail: d.linkedEmail || '',
      monthlyAgreedSalary: String(d.monthlyAgreedSalary),
      employmentStartDate: d.employmentStartDate,
      accountStatus: d.accountStatus,
      photoUrl: d.photoUrl || '',
      notes: d.notes || '',
      schoolId: d.schoolId ? String(d.schoolId) : '',
      vehicleId: d.vehicleId ? String(d.vehicleId) : '',
      routeId: d.routeId ? String(d.routeId) : '',
    });
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const payload = {
        ...formState,
        monthlyAgreedSalary: Number(formState.monthlyAgreedSalary || 0),
        schoolId: formState.schoolId ? Number(formState.schoolId) : null,
        vehicleId: formState.vehicleId ? Number(formState.vehicleId) : null,
        routeId: formState.routeId ? Number(formState.routeId) : null,
      };
      if (editingDriver) {
        await apiFetch(`/api/drivers/${editingDriver.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch('/api/drivers', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      setShowForm(false);
      await loadAll();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'تعذر حفظ بيانات السائق');
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (d: EnrichedDriver) => {
    const nextStatus = d.accountStatus === 'active' ? 'inactive' : 'active';
    await apiFetch(`/api/drivers/${d.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ accountStatus: nextStatus }),
    });
    await loadAll();
  };

  const openDeleteModal = (d: EnrichedDriver) => {
    setDeleteError(null);
    setDeleteTarget(d);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiFetch(`/api/drivers/${deleteTarget.id}`, { method: 'DELETE' });
      setDeleteTarget(null);
      setShowForm(false);
      await loadAll();
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : 'تعذر حذف السائق');
    } finally {
      setDeleting(false);
    }
  };

  const handleDeactivateFromDeleteModal = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiFetch(`/api/drivers/${deleteTarget.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ accountStatus: 'inactive' }),
      });
      setDeleteTarget(null);
      setShowForm(false);
      await loadAll();
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : 'تعذر إيقاف الحساب');
    } finally {
      setDeleting(false);
    }
  };

  const loadStatement = useCallback(
    async (id: number, month: number, year: number) => {
      setStatementLoading(true);
      try {
        const res = await apiFetch<StatementResponse>(
          `/api/drivers/${id}/statement?month=${month}&year=${year}`
        );
        setStatementData(res);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'تعذر تحميل كشف الحساب');
      } finally {
        setStatementLoading(false);
      }
    },
    []
  );

  const openStatement = (id: number) => {
    setStatementDriverId(id);
    loadStatement(id, statementMonth, statementYear);
  };

  useEffect(() => {
    if (statementDriverId) {
      loadStatement(statementDriverId, statementMonth, statementYear);
    }
  }, [statementDriverId, statementMonth, statementYear, loadStatement]);

  const filtered = driversList.filter((d) => {
    const matchesSearch =
      !search ||
      d.fullName.includes(search) ||
      d.driverCode.includes(search) ||
      d.phone.includes(search) ||
      d.schoolName.includes(search) ||
      d.busNumber.includes(search);
    const matchesStatus = statusFilter === 'all' || d.accountStatus === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const schoolRoutes = routesList.filter(
    (r) => !formState.schoolId || r.schoolId === Number(formState.schoolId)
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#0B1F3A]">إدارة السائقين</h1>
          <p className="text-sm text-slate-500 mt-1">
            ملفات السائقين، الأكواد الفريدة، التعيين على المدارس والباصات، وكشوف الحساب الشهرية
          </p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-2 rounded-lg bg-[#0B1F3A] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#13325c] cursor-pointer whitespace-nowrap shrink-0"
        >
          <Plus className="w-4 h-4 text-[#C89B3C]" />
          إضافة سائق جديد
        </button>
      </div>

      {/* Search and Segmented Filter */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="بحث بالاسم، كود السائق، الهاتف، المدرسة، أو رقم الباص..."
            className="w-full rounded-lg border border-slate-200 bg-slate-50 pr-9 pl-3 py-2 text-xs focus:border-[#0B1F3A] focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start">
          {[
            { id: 'all', label: 'الكل' },
            { id: 'active', label: 'نشط' },
            { id: 'inactive', label: 'موقوف' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setStatusFilter(tab.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                statusFilter === tab.id
                  ? 'bg-white text-[#0B1F3A] shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-800">
          {error}
        </div>
      )}

      {/* Mobile Cards View (Actions always visible on phone screens) */}
      <div className="md:hidden space-y-3">
        {loading ? (
          <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-xs text-slate-400">
            جاري تحميل قائمة السائقين...
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-xs text-slate-400">
            لا يوجد سائقون مطابقون لخيارات البحث
          </div>
        ) : (
          filtered.map((d) => (
            <div key={d.id} className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <DriverAvatar name={d.fullName} photoUrl={d.photoUrl} size="md" />
                  <div className="min-w-0">
                    <div className="font-bold text-sm text-[#0B1F3A] truncate">{d.fullName}</div>
                    <div className="text-xs text-slate-500 font-mono mt-0.5">
                      كود {d.driverCode} · {d.phone}
                    </div>
                  </div>
                </div>
                <span
                  className={`text-[11px] font-bold px-2 py-0.5 rounded-md shrink-0 ${
                    d.accountStatus === 'active'
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'bg-red-50 text-red-700'
                  }`}
                >
                  {d.accountStatus === 'active' ? 'نشط' : 'موقوف'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-2.5 text-[11px]">
                <div>
                  <span className="text-slate-500">المدرسة والباص: </span>
                  <span className="font-semibold text-slate-800">
                    {d.schoolName} ({d.busNumber})
                  </span>
                </div>
                <div className="text-left">
                  <span className="text-slate-500">الراتب: </span>
                  <span className="font-mono font-bold text-[#0B1F3A] tabular-nums">
                    {formatEGP(d.monthlyAgreedSalary)}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 pt-1">
                <button
                  onClick={() => openEdit(d)}
                  className="flex items-center justify-center gap-1.5 rounded-lg bg-[#0B1F3A] px-2.5 py-2 text-xs font-semibold text-white hover:bg-[#13325c] cursor-pointer"
                >
                  <Edit3 className="w-3.5 h-3.5 text-[#C89B3C]" />
                  تعديل
                </button>
                <button
                  onClick={() => openStatement(d.id)}
                  className="flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-semibold text-[#0B1F3A] hover:bg-slate-50 cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5" />
                  كشف حساب
                </button>
                <button
                  onClick={() => openDeleteModal(d)}
                  className="flex items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  حذف
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Desktop Drivers Table */}
      <div className="hidden md:block bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
              <tr>
                <th className="py-3 px-4 font-semibold">الكود</th>
                <th className="py-3 px-4 font-semibold">بيانات السائق</th>
                <th className="py-3 px-4 font-semibold">المدرسة والخط</th>
                <th className="py-3 px-4 font-semibold">الباص والمالك</th>
                <th className="py-3 px-4 font-semibold">الراتب المتفق عليه</th>
                <th className="py-3 px-4 font-semibold">الحالة</th>
                <th className="py-3 px-4 font-semibold">الإجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-400">
                    جاري تحميل قائمة السائقين...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-400">
                    لا يوجد سائقون مطابقون لخيارات البحث
                  </td>
                </tr>
              ) : (
                filtered.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50/70">
                    <td className="py-3.5 px-4 font-mono font-bold text-[#0B1F3A] tabular-nums">
                      {d.driverCode}
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="flex items-center gap-3">
                        <DriverAvatar name={d.fullName} photoUrl={d.photoUrl} size="sm" />
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-900 truncate">{d.fullName}</div>
                          <div className="text-slate-500 tabular-nums mt-0.5 truncate">
                            {d.phone}
                            {d.linkedEmail ? ` · ${d.linkedEmail}` : ''}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="font-medium text-slate-800">{d.schoolName}</div>
                      <div className="text-slate-500 mt-0.5">{d.routeName}</div>
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="font-mono font-medium text-slate-800">
                        {d.busNumber} · {d.registrationNumber}
                      </div>
                      <div className="text-slate-500 mt-0.5">المالك: {d.vehicleOwnerName}</div>
                    </td>
                    <td className="py-3.5 px-4 font-mono font-semibold text-slate-900 tabular-nums">
                      {formatEGP(d.monthlyAgreedSalary)}
                    </td>
                    <td className="py-3.5 px-4">
                      <span
                        className={`font-semibold ${
                          d.accountStatus === 'active' ? 'text-emerald-700' : 'text-red-700'
                        }`}
                      >
                        {d.accountStatus === 'active' ? 'نشط' : 'موقوف'}
                      </span>
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => openEdit(d)}
                          className="flex items-center gap-1 rounded-md bg-[#0B1F3A] px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-[#13325c] cursor-pointer whitespace-nowrap"
                          title="تعديل الاسم والبيانات والصورة"
                        >
                          <Edit3 className="w-3.5 h-3.5 text-[#C89B3C]" />
                          تعديل
                        </button>
                        <button
                          onClick={() => openStatement(d.id)}
                          className="flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-[#0B1F3A] hover:bg-slate-100 cursor-pointer whitespace-nowrap"
                        >
                          <FileText className="w-3.5 h-3.5" />
                          كشف حساب
                        </button>
                        <button
                          onClick={() => toggleStatus(d)}
                          className="p-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-100 cursor-pointer"
                          title={d.accountStatus === 'active' ? 'إيقاف الحساب' : 'تفعيل الحساب'}
                        >
                          {d.accountStatus === 'active' ? (
                            <UserX className="w-3.5 h-3.5 text-amber-600" />
                          ) : (
                            <UserCheck className="w-3.5 h-3.5 text-emerald-600" />
                          )}
                        </button>
                        <button
                          onClick={() => openDeleteModal(d)}
                          className="flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] font-semibold text-red-700 hover:bg-red-100 cursor-pointer whitespace-nowrap"
                          title="حذف السائق"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          حذف
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add/Edit Driver Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-2xl bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden max-h-[90vh] flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-[#0B1F3A] text-white">
              <h2 className="font-display text-base font-bold">
                {editingDriver ? `تعديل بيانات السائق (${editingDriver.driverCode})` : 'إضافة سائق جديد'}
              </h2>
              <button onClick={() => setShowForm(false)} className="text-slate-300 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-4 text-xs">
              {formError && (
                <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-red-800">
                  {formError}
                </div>
              )}

              <DriverPhotoUploader
                photoUrl={formState.photoUrl}
                driverName={formState.fullName}
                onChange={(photoUrl) => setFormState((prev) => ({ ...prev, photoUrl }))}
              />

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">كود السائق (فريد) *</label>
                  <input
                    required
                    value={formState.driverCode}
                    onChange={(e) => setFormState({ ...formState, driverCode: e.target.value })}
                    placeholder="مثال: 1025"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono focus:border-[#0B1F3A] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">الاسم الكامل *</label>
                  <input
                    required
                    value={formState.fullName}
                    onChange={(e) => setFormState({ ...formState, fullName: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 focus:border-[#0B1F3A] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">رقم الهاتف *</label>
                  <ContactPhoneInput
                    required
                    value={formState.phone}
                    onChange={(phone) => setFormState((prev) => ({ ...prev, phone }))}
                    onPickContact={({ phone, name }) =>
                      setFormState((prev) => ({
                        ...prev,
                        phone,
                        fullName: prev.fullName.trim() ? prev.fullName : name || prev.fullName,
                      }))
                    }
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">رقم الطوارئ</label>
                  <ContactPhoneInput
                    value={formState.emergencyContact}
                    placeholder="010... (اسم قريب السائق)"
                    onChange={(emergencyContact) =>
                      setFormState((prev) => ({ ...prev, emergencyContact }))
                    }
                    onPickContact={({ phone, name }) =>
                      setFormState((prev) => ({
                        ...prev,
                        emergencyContact: name ? `${phone} (${name})` : phone,
                      }))
                    }
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    الراتب الشهري المتفق عليه (ج.م) *
                  </label>
                  <input
                    type="number"
                    required
                    min={0}
                    value={formState.monthlyAgreedSalary}
                    onChange={(e) =>
                      setFormState({ ...formState, monthlyAgreedSalary: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono focus:border-[#0B1F3A] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">تاريخ بدء العمل</label>
                  <input
                    type="date"
                    value={formState.employmentStartDate}
                    onChange={(e) =>
                      setFormState({ ...formState, employmentStartDate: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono focus:border-[#0B1F3A] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    البريد الإلكتروني (اختياري — للدخول بحساب Google)
                  </label>
                  <input
                    type="email"
                    value={formState.linkedEmail}
                    onChange={(e) => setFormState({ ...formState, linkedEmail: e.target.value })}
                    placeholder="driver@gmail.com"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono focus:border-[#0B1F3A] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">حالة الحساب</label>
                  <select
                    value={formState.accountStatus}
                    onChange={(e) => setFormState({ ...formState, accountStatus: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 focus:border-[#0B1F3A] focus:outline-none"
                  >
                    <option value="active">نشط</option>
                    <option value="inactive">موقوف</option>
                  </select>
                </div>
              </div>

              <div className="border-t border-slate-200 pt-4">
                <h3 className="font-semibold text-slate-800 mb-3">التعيين التشغيلي الحالي</h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-slate-600 mb-1">المدرسة</label>
                    <select
                      value={formState.schoolId}
                      onChange={(e) =>
                        setFormState({ ...formState, schoolId: e.target.value, routeId: '' })
                      }
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 focus:border-[#0B1F3A] focus:outline-none"
                    >
                      <option value="">بدون تعيين</option>
                      {schoolsList.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-600 mb-1">الباص / المركبة</label>
                    <select
                      value={formState.vehicleId}
                      onChange={(e) => setFormState({ ...formState, vehicleId: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 focus:border-[#0B1F3A] focus:outline-none"
                    >
                      <option value="">بدون مركبة</option>
                      {vehiclesList.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.busNumber} ({v.registrationNumber})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-600 mb-1">خط السير</label>
                    <select
                      value={formState.routeId}
                      onChange={(e) => setFormState({ ...formState, routeId: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 focus:border-[#0B1F3A] focus:outline-none"
                    >
                      <option value="">اختر خط السير</option>
                      {schoolRoutes.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">ملاحظات ومستندات</label>
                <textarea
                  rows={2}
                  value={formState.notes}
                  onChange={(e) => setFormState({ ...formState, notes: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 focus:border-[#0B1F3A] focus:outline-none"
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100">
                <div>
                  {editingDriver && (
                    <button
                      type="button"
                      onClick={() => openDeleteModal(editingDriver)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      حذف السائق نهائياً
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setShowForm(false)}
                    className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                  >
                    إلغاء
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="rounded-lg bg-[#0B1F3A] px-5 py-2 text-xs font-semibold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
                  >
                    {saving ? 'جاري الحفظ...' : 'حفظ البيانات'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Driver Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/65 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
            <div className="px-5 py-4 bg-red-700 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5" />
                <h3 className="font-display text-sm font-bold">تأكيد حذف السائق</h3>
              </div>
              <button
                onClick={() => setDeleteTarget(null)}
                className="text-red-100 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4 text-xs">
              <div className="flex items-center gap-3 rounded-xl bg-slate-50 border border-slate-200 p-3">
                <DriverAvatar
                  name={deleteTarget.fullName}
                  photoUrl={deleteTarget.photoUrl}
                  size="md"
                />
                <div>
                  <div className="font-bold text-sm text-[#0B1F3A]">{deleteTarget.fullName}</div>
                  <div className="text-slate-500 font-mono mt-0.5">
                    كود: {deleteTarget.driverCode} · {deleteTarget.phone}
                  </div>
                </div>
              </div>

              <p className="text-slate-600 leading-relaxed">
                هل أنت متأكد من حذف هذا السائق نهائياً من النظام؟ سيتم حذف ملفه وربطه بالمركبة والمدرسة وسجل الحضور.
              </p>

              {deleteError && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900 space-y-2.5">
                  <p className="leading-relaxed font-medium">{deleteError}</p>
                  <button
                    type="button"
                    disabled={deleting}
                    onClick={handleDeactivateFromDeleteModal}
                    className="w-full rounded-lg bg-[#0B1F3A] px-3 py-2 text-xs font-semibold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
                  >
                    إيقاف حساب السائق (أرشفة) بدلاً من الحذف
                  </button>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => setDeleteTarget(null)}
                  className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={handleConfirmDelete}
                  className="rounded-lg bg-red-600 px-4 py-2 font-semibold text-white hover:bg-red-700 disabled:opacity-50 cursor-pointer"
                >
                  {deleting ? 'جاري الحذف...' : 'حذف نهائي'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Driver Financial Statement Modal */}
      {statementDriverId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-3xl bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden max-h-[90vh] flex flex-col print-only-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-[#0B1F3A] text-white no-print">
              <h2 className="font-display text-base font-bold">كشف حساب السائق الشهري</h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => window.print()}
                  className="flex items-center gap-1.5 rounded-lg bg-[#C89B3C] px-3 py-1.5 text-xs font-bold text-[#0B1F3A] cursor-pointer"
                >
                  <Printer className="w-3.5 h-3.5" />
                  طباعة / PDF
                </button>
                <button
                  onClick={() => {
                    setStatementDriverId(null);
                    setStatementData(null);
                  }}
                  className="text-slate-300 hover:text-white cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-6 overflow-y-auto space-y-5 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
                <div className="flex items-center gap-3">
                  <DriverAvatar
                    name={statementData?.driver.fullName}
                    photoUrl={statementData?.driver.photoUrl}
                    size="lg"
                  />
                  <div>
                    <div className="text-base font-bold text-[#0B1F3A]">
                      {statementData?.driver.fullName || '...'} · كود{' '}
                      <span className="font-mono">{statementData?.driver.driverCode}</span>
                    </div>
                    <div className="text-slate-500 mt-1">
                      {statementData?.driver.schoolName} · باص {statementData?.driver.busNumber} ·{' '}
                      {statementData?.driver.routeName}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 no-print">
                  <select
                    value={statementMonth}
                    onChange={(e) => setStatementMonth(Number(e.target.value))}
                    className="rounded-lg border border-slate-200 px-2.5 py-1.5"
                  >
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                      <option key={m} value={m}>
                        شهر {m}
                      </option>
                    ))}
                  </select>
                  <select
                    value={statementYear}
                    onChange={(e) => setStatementYear(Number(e.target.value))}
                    className="rounded-lg border border-slate-200 px-2.5 py-1.5 font-mono"
                  >
                    {[2025, 2026, 2027].map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {statementLoading || !statementData ? (
                <div className="py-10 text-center text-slate-400">جاري تحميل كشف الحساب...</div>
              ) : (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                    <div className="border border-slate-200 rounded-xl p-3">
                      <div className="text-slate-500">الراتب الأساسي</div>
                      <div className="mt-1 font-mono font-bold text-slate-900 tabular-nums">
                        {formatEGP(statementData.salary.baseSalary)}
                      </div>
                    </div>
                    <div className="border border-slate-200 rounded-xl p-3">
                      <div className="text-slate-500">إجمالي السلف</div>
                      <div className="mt-1 font-mono font-bold text-red-700 tabular-nums">
                        − {formatEGP(statementData.salary.totalAdvances)}
                      </div>
                    </div>
                    <div className="border border-slate-200 rounded-xl p-3">
                      <div className="text-slate-500">خصم التغطيات</div>
                      <div className="mt-1 font-mono font-bold text-red-700 tabular-nums">
                        − {formatEGP(statementData.salary.totalCoverageDeductions)}
                      </div>
                    </div>
                    <div className="border border-slate-200 rounded-xl p-3">
                      <div className="text-slate-500">خصومات أخرى</div>
                      <div className="mt-1 font-mono font-bold text-red-700 tabular-nums">
                        − {formatEGP(statementData.salary.otherDeductions)}
                      </div>
                    </div>
                    <div className="border border-slate-200 rounded-xl p-3">
                      <div className="text-slate-500">المكافآت</div>
                      <div className="mt-1 font-mono font-bold text-emerald-700 tabular-nums">
                        + {formatEGP(statementData.salary.bonuses)}
                      </div>
                    </div>
                    <div className="bg-[#0B1F3A] text-white rounded-xl p-3">
                      <div className="text-slate-300">صافي المستحق</div>
                      <div className="mt-1 font-mono font-bold text-[#C89B3C] tabular-nums">
                        {formatEGP(statementData.salary.netSalary)}
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="font-bold text-[#0B1F3A] mb-2">سجل الحركات المالية للشهر</h3>
                    <div className="border border-slate-200 rounded-xl overflow-hidden">
                      <table className="w-full text-right text-xs">
                        <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                          <tr>
                            <th className="py-2.5 px-3">التاريخ</th>
                            <th className="py-2.5 px-3">النوع</th>
                            <th className="py-2.5 px-3">البيان</th>
                            <th className="py-2.5 px-3">المبلغ</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {statementData.transactions.length === 0 ? (
                            <tr>
                              <td colSpan={4} className="py-6 text-center text-slate-400">
                                لا توجد حركات مالية مسجلة في هذا الشهر
                              </td>
                            </tr>
                          ) : (
                            statementData.transactions.map((t) => (
                              <tr key={t.id}>
                                <td className="py-2.5 px-3 font-mono text-slate-500 tabular-nums">
                                  {new Date(t.createdAt).toLocaleDateString('ar-EG')}
                                </td>
                                <td className="py-2.5 px-3 font-semibold text-slate-700">
                                  {t.type === 'advance'
                                    ? 'سلفة'
                                    : t.type === 'coverage_deduction'
                                    ? 'خصم تغطية'
                                    : t.type === 'bonus'
                                    ? 'مكافأة'
                                    : t.type === 'reversal'
                                    ? 'عكس قيد'
                                    : 'خصم إداري'}
                                </td>
                                <td className="py-2.5 px-3 text-slate-700">{t.description}</td>
                                <td
                                  className={`py-2.5 px-3 font-mono font-bold tabular-nums ${
                                    t.direction === 'credit' ? 'text-emerald-700' : 'text-red-700'
                                  }`}
                                >
                                  {t.direction === 'credit' ? '+' : '−'} {formatEGP(t.amount)}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
