import React, { useCallback, useEffect, useState } from 'react';
import { Archive, Briefcase, Edit3, Plus, Search, Shield, Trash2, X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch, formatEGP, normalizeLookupText } from '../../lib/api';
import { useEscapeKey } from '../../lib/useEscapeKey';
import { ContactPhoneInput } from '../ContactPhoneInput';
import {
  StaffAccessModal,
  type StaffEmployeeOption,
  type StaffRoleOption,
  type StaffSchoolOption,
  type StaffUserEditable,
} from './StaffAccessModal';
import type { EmployeeRecord } from '../../types';

interface MySchoolOption {
  id: number;
  name: string;
  isActive?: boolean;
}

export const EmployeesModule: React.FC = () => {
  const { dbUser } = useAuth();
  const perms = dbUser?.permissions || [];
  const isSuperAdmin = dbUser?.roleSlug === 'super_admin' || perms.includes('*');
  const canWriteEmployees = isSuperAdmin || perms.includes('employees:write');
  const restrictedSchoolIds = dbUser?.assignedSchoolIds || [];
  const isSingleSchoolRestricted = !isSuperAdmin && restrictedSchoolIds.length === 1;

  const [employeesList, setEmployeesList] = useState<EmployeeRecord[]>([]);
  const [mySchools, setMySchools] = useState<MySchoolOption[]>([]);
  const [schoolFilter, setSchoolFilter] = useState<string>(() =>
    isSingleSchoolRestricted ? String(restrictedSchoolIds[0]) : 'all'
  );
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<EmployeeRecord | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Super Admin Staff Access Grant / Edit state
  const [staffRoles, setStaffRoles] = useState<StaffRoleOption[]>([]);
  const [staffSchools, setStaffSchools] = useState<StaffSchoolOption[]>([]);
  const [accessModalOpen, setAccessModalOpen] = useState(false);
  const [accessTargetEmployee, setAccessTargetEmployee] = useState<StaffEmployeeOption | null>(null);
  const [accessInitialUser, setAccessInitialUser] = useState<StaffUserEditable | null>(null);

  const [formState, setFormState] = useState({
    employeeCode: '',
    fullName: '',
    jobTitle: '',
    phone: '',
    schoolId: '',
    monthlySalary: '',
    bonuses: '',
    deductions: '',
    employmentStartDate: '',
    status: 'active',
    notes: '',
  });

  const [deleteTarget, setDeleteTarget] = useState<EmployeeRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEscapeKey(Boolean(deleteTarget || showModal), () => {
    if (deleteTarget) setDeleteTarget(null);
    else if (showModal) setShowModal(false);
  });

  useEffect(() => {
    if (isSingleSchoolRestricted && restrictedSchoolIds[0]) {
      setSchoolFilter(String(restrictedSchoolIds[0]));
    }
  }, [isSingleSchoolRestricted, restrictedSchoolIds]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [res, schoolsRes, usersMeta] = await Promise.all([
        apiFetch<{ employees: EmployeeRecord[] }>('/api/employees'),
        apiFetch<{ schools: MySchoolOption[] }>('/api/my-schools').catch(() => ({ schools: [] })),
        isSuperAdmin
          ? apiFetch<{ roles: StaffRoleOption[]; schools: StaffSchoolOption[] }>('/api/users').catch(
              () => null
            )
          : Promise.resolve(null),
      ]);
      setEmployeesList(res.employees);
      setMySchools(schoolsRes.schools || []);
      if (usersMeta) {
        setStaffRoles(usersMeta.roles || []);
        setStaffSchools(usersMeta.schools || []);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل بيانات الموظفين');
    } finally {
      setLoading(false);
    }
  }, [isSuperAdmin]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const openGrantAccess = (emp: EmployeeRecord) => {
    setAccessTargetEmployee({
      id: emp.id,
      fullName: emp.fullName,
      jobTitle: emp.jobTitle,
      phone: emp.phone,
      employeeCode: emp.employeeCode,
    });
    if (emp.linkedUser) {
      setAccessInitialUser({
        id: emp.linkedUser.id,
        fullName: emp.fullName,
        email: emp.linkedUser.email,
        phone: emp.phone,
        roleId: emp.linkedUser.roleId,
        roleSlug: emp.linkedUser.roleSlug,
        assignedSchoolIds: emp.linkedUser.assignedSchoolIds || [],
        customPermissions: emp.linkedUser.customPermissions ?? null,
        effectivePermissions: emp.linkedUser.permissions || [],
        staffCode: emp.linkedUser.staffCode,
        employeeId: emp.id,
        isActive: emp.linkedUser.isActive,
      });
    } else {
      setAccessInitialUser(null);
    }
    setAccessModalOpen(true);
  };

  const openAdd = () => {
    setEditing(null);
    setFormError(null);
    const defaultSchoolId = isSingleSchoolRestricted
      ? String(restrictedSchoolIds[0])
      : schoolFilter !== 'all'
      ? schoolFilter
      : !isSuperAdmin && mySchools.length > 0
      ? String(mySchools[0].id)
      : '';
    setFormState({
      employeeCode: '',
      fullName: '',
      jobTitle: '',
      phone: '',
      schoolId: defaultSchoolId,
      monthlySalary: '',
      bonuses: '',
      deductions: '',
      employmentStartDate: '',
      status: 'active',
      notes: '',
    });
    setShowModal(true);
  };

  const openEdit = (emp: EmployeeRecord) => {
    setEditing(emp);
    setFormError(null);
    setFormState({
      employeeCode: emp.employeeCode || '',
      fullName: emp.fullName,
      jobTitle: emp.jobTitle || '',
      phone: emp.phone || '',
      schoolId: emp.schoolId
        ? String(emp.schoolId)
        : isSingleSchoolRestricted
        ? String(restrictedSchoolIds[0])
        : '',
      monthlySalary: String(emp.monthlySalary ?? 0),
      bonuses: emp.bonuses ? String(emp.bonuses) : '',
      deductions: emp.deductions ? String(emp.deductions) : '',
      employmentStartDate: emp.employmentStartDate || '',
      status: emp.status || 'active',
      notes: emp.notes || '',
    });
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      const payload = {
        ...formState,
        schoolId: formState.schoolId ? Number(formState.schoolId) : null,
        monthlySalary: Number(formState.monthlySalary || 0),
        bonuses: Number(formState.bonuses || 0),
        deductions: Number(formState.deductions || 0),
      };
      if (editing) {
        await apiFetch(`/api/employees/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch('/api/employees', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      setShowModal(false);
      await loadAll();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'تعذر حفظ بيانات الموظف');
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/employees/${deleteTarget.id}`, { method: 'DELETE' });
      setDeleteTarget(null);
      await loadAll();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر حذف الموظف');
    } finally {
      setDeleting(false);
    }
  };

  const handleArchiveEmployee = async (emp: EmployeeRecord) => {
    try {
      await apiFetch(`/api/employees/${emp.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'inactive' }),
      });
      await loadAll();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر نقل الموظف للأرشفة');
    }
  };

  const filtered = employeesList.filter((e) => {
    if (schoolFilter !== 'all') {
      if (schoolFilter === 'general') {
        if (e.schoolId) return false;
      } else if (String(e.schoolId ?? '') !== schoolFilter) {
        return false;
      }
    }
    const q = normalizeLookupText(search);
    if (!q) return true;
    const digitsOnly = q.replace(/\D/g, '');
    return (
      normalizeLookupText(e.fullName).includes(q) ||
      normalizeLookupText(e.employeeCode).includes(q) ||
      normalizeLookupText(e.jobTitle).includes(q) ||
      normalizeLookupText(e.schoolName || '').includes(q) ||
      normalizeLookupText(e.phone).includes(q) ||
      (digitsOnly.length >= 2 && normalizeLookupText(e.phone).replace(/\D/g, '').includes(digitsOnly))
    );
  });

  const activeStaff = filtered.filter((e) => e.status === 'active');
  const totalNetPayroll = activeStaff.reduce((sum, e) => sum + Math.max(0, e.netSalary), 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#0B1F3A]">
            إدارة الموظفين (غير السائقين)
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            المشرفات، الإداريون، المحاسبون، موظفو الحركة، والفنيون — مع عزل كامل لكل مدرسة وحساب الرواتب ضمن دورتها
          </p>
        </div>
        {canWriteEmployees && (
          <button
            onClick={openAdd}
            className="flex items-center gap-2 rounded-lg bg-[#0B1F3A] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#13325c] cursor-pointer whitespace-nowrap shrink-0"
          >
            <Plus className="w-4 h-4 text-[#C89B3C]" />
            إضافة موظف جديد
          </button>
        )}
      </div>

      {/* Summary Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">إجمالي الموظفين بالنطاق</div>
          <div className="mt-1.5 font-mono text-2xl font-bold text-[#0B1F3A] tabular-nums">
            {filtered.length}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">الموظفون النشطون</div>
          <div className="mt-1.5 font-mono text-2xl font-bold text-emerald-700 tabular-nums">
            {activeStaff.length}
          </div>
        </div>
        <div className="bg-[#0B1F3A] text-white rounded-xl p-4">
          <div className="text-xs text-slate-300">إجمالي صافي رواتب الموظفين</div>
          <div className="mt-1.5 font-mono text-2xl font-bold text-[#C89B3C] tabular-nums">
            {formatEGP(totalNetPayroll)}
          </div>
        </div>
      </div>

      {/* Search & School Filter */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="بحث بالاسم، الكود، الوظيفة، المدرسة، أو الهاتف..."
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

        <div className="flex items-center gap-2">
          <select
            value={schoolFilter}
            disabled={isSingleSchoolRestricted}
            onChange={(e) => setSchoolFilter(e.target.value)}
            aria-label="تصفية الموظفين حسب المدرسة"
            className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-[#0B1F3A] focus:border-[#0B1F3A] focus:outline-none disabled:opacity-80"
          >
            {!isSingleSchoolRestricted && (
              <option value="all">
                {!isSuperAdmin && restrictedSchoolIds.length > 0 ? 'جميع مدارسي المخصصة' : 'جميع المدارس'}
              </option>
            )}
            {mySchools.map((s) => (
              <option key={s.id} value={String(s.id)}>
                {s.name}
              </option>
            ))}
            {isSuperAdmin && <option value="general">الإدارة العامة (غير معين بمدرسة)</option>}
          </select>
        </div>
      </div>

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

      {/* Employees Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
              <tr>
                <th className="py-3 px-4 font-semibold">الكود</th>
                <th className="py-3 px-4 font-semibold">الاسم والوظيفة</th>
                <th className="py-3 px-4 font-semibold">المدرسة</th>
                <th className="py-3 px-4 font-semibold">الهاتف</th>
                <th className="py-3 px-4 font-semibold">الراتب الأساسي</th>
                <th className="py-3 px-4 font-semibold">مكافآت</th>
                <th className="py-3 px-4 font-semibold">خصومات / سلف</th>
                <th className="py-3 px-4 font-semibold">صافي الراتب</th>
                <th className="py-3 px-4 font-semibold">الحالة</th>
                {isSuperAdmin && <th className="py-3 px-4 font-semibold">صلاحية التطبيق</th>}
                {canWriteEmployees && <th className="py-3 px-4 font-semibold">الإجراءات</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td
                    colSpan={9 + (isSuperAdmin ? 1 : 0) + (canWriteEmployees ? 1 : 0)}
                    className="py-10 text-center text-slate-400"
                  >
                    جاري التحميل...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td
                    colSpan={9 + (isSuperAdmin ? 1 : 0) + (canWriteEmployees ? 1 : 0)}
                    className="py-10 text-center text-slate-400"
                  >
                    لا يوجد موظفون مسجلون حالياً
                  </td>
                </tr>
              ) : (
                filtered.map((emp) => (
                  <tr key={emp.id} className="hover:bg-slate-50/70">
                    <td className="py-3.5 px-4 font-mono font-bold text-[#0B1F3A]">
                      {emp.employeeCode || '—'}
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="flex items-center gap-2">
                        <Briefcase className="w-4 h-4 text-[#C89B3C] shrink-0" />
                        <div>
                          <div className="font-semibold text-slate-900">{emp.fullName}</div>
                          <div className="text-slate-500">{emp.jobTitle || '—'}</div>
                        </div>
                      </div>
                    </td>
                    <td className="py-3.5 px-4 text-slate-700 font-medium">
                      {emp.schoolName || 'الإدارة العامة'}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-slate-600">{emp.phone || '—'}</td>
                    <td className="py-3.5 px-4 font-mono tabular-nums">
                      {formatEGP(emp.monthlySalary)}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-emerald-700 tabular-nums">
                      + {formatEGP(emp.bonuses)}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-red-700 tabular-nums">
                      − {formatEGP(emp.deductions)}
                    </td>
                    <td className="py-3.5 px-4 font-mono font-bold text-[#0B1F3A] tabular-nums">
                      {formatEGP(emp.netSalary)}
                    </td>
                    <td className="py-3.5 px-4">
                      <span className="font-semibold text-emerald-700">نشط</span>
                    </td>
                    {isSuperAdmin && (
                      <td className="py-3.5 px-4">
                        <div className="space-y-1">
                          {emp.linkedUser ? (
                            <div className="text-[11px] leading-snug">
                              <div className="font-bold text-[#0B1F3A]">
                                {emp.linkedUser.roleNameAr} ·{' '}
                                <span
                                  className={
                                    emp.linkedUser.isActive
                                      ? 'text-emerald-700'
                                      : 'text-red-700'
                                  }
                                >
                                  {emp.linkedUser.isActive ? 'مفعل' : 'موقوف'}
                                </span>
                              </div>
                              <div className="text-slate-500 font-mono tabular-nums">
                                {emp.linkedUser.staffCode || '—'} ·{' '}
                                {emp.linkedUser.assignedSchoolIds.length === 0
                                  ? 'جميع المدارس'
                                  : `${emp.linkedUser.assignedSchoolIds.length} مدرسة`}
                              </div>
                            </div>
                          ) : (
                            <div className="text-[11px] text-slate-400">بدون حساب دخول</div>
                          )}
                          <button
                            type="button"
                            onClick={() => openGrantAccess(emp)}
                            className="inline-flex items-center gap-1 rounded-md border border-[#C89B3C]/60 bg-amber-50 hover:bg-amber-100 px-2.5 py-1 text-[11px] font-bold text-[#0B1F3A] cursor-pointer whitespace-nowrap"
                          >
                            <Shield className="w-3 h-3 text-[#C89B3C]" />
                            {emp.linkedUser ? 'تعديل الصلاحيات' : 'منح صلاحية التطبيق'}
                          </button>
                        </div>
                      </td>
                    )}
                    {canWriteEmployees && (
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => openEdit(emp)}
                            className="inline-flex items-center gap-1 rounded-md bg-[#0B1F3A] px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-[#13325c] cursor-pointer"
                          >
                            <Edit3 className="w-3 h-3 text-[#C89B3C]" />
                            تعديل
                          </button>
                          <button
                            onClick={() => handleArchiveEmployee(emp)}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                            title="نقل إلى الأرشفة"
                          >
                            <Archive className="w-3 h-3 text-amber-600" />
                            أرشفة
                          </button>
                          <button
                            onClick={() => setDeleteTarget(emp)}
                            className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] font-semibold text-red-700 hover:bg-red-100 cursor-pointer"
                          >
                            <Trash2 className="w-3 h-3" />
                            حذف
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add/Edit Employee Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-lg bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden max-h-[90vh] flex flex-col">
            <div className="px-6 py-4 bg-[#0B1F3A] text-white flex items-center justify-between">
              <h2 className="font-display text-base font-bold">
                {editing ? 'تعديل بيانات الموظف' : 'إضافة موظف جديد (غير سائق)'}
              </h2>
              <button onClick={() => setShowModal(false)} className="text-slate-300 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-3.5 text-xs">
              {formError && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-800">
                  {formError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">الاسم الكامل *</label>
                  <input
                    required
                    value={formState.fullName}
                    onChange={(e) => setFormState({ ...formState, fullName: e.target.value })}
                    placeholder="اكتب اسم الموظف"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">الوظيفة / التخصص</label>
                  <input
                    value={formState.jobTitle}
                    onChange={(e) => setFormState({ ...formState, jobTitle: e.target.value })}
                    placeholder="اكتب المسمى الوظيفي"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">كود الموظف (اختياري)</label>
                  <input
                    value={formState.employeeCode}
                    onChange={(e) => setFormState({ ...formState, employeeCode: e.target.value })}
                    placeholder="اكتب كود الموظف"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">رقم الهاتف</label>
                  <ContactPhoneInput
                    value={formState.phone}
                    placeholder="اكتب رقم الهاتف"
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
                  <label className="block font-semibold text-slate-700 mb-1">الراتب الشهري (ج.م) *</label>
                  <input
                    type="number"
                    required
                    min={0}
                    value={formState.monthlySalary}
                    onChange={(e) => setFormState({ ...formState, monthlySalary: e.target.value })}
                    placeholder="اكتب الراتب"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
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
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">مكافآت إضافية (ج.م)</label>
                  <input
                    type="number"
                    min={0}
                    value={formState.bonuses}
                    onChange={(e) => setFormState({ ...formState, bonuses: e.target.value })}
                    placeholder="0"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">خصومات / سلف (ج.م)</label>
                  <input
                    type="number"
                    min={0}
                    value={formState.deductions}
                    onChange={(e) => setFormState({ ...formState, deductions: e.target.value })}
                    placeholder="0"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block font-semibold text-slate-700 mb-1">
                    المدرسة التابع لها الموظف {!isSuperAdmin && restrictedSchoolIds.length > 0 ? '*' : ''}
                  </label>
                  <select
                    required={!isSuperAdmin && restrictedSchoolIds.length > 0}
                    disabled={isSingleSchoolRestricted}
                    value={formState.schoolId}
                    onChange={(e) => setFormState({ ...formState, schoolId: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-semibold text-[#0B1F3A] disabled:bg-slate-100"
                  >
                    {(isSuperAdmin || restrictedSchoolIds.length === 0) && (
                      <option value="">الإدارة العامة (غير معين بمدرسة)</option>
                    )}
                    {mySchools.map((s) => (
                      <option key={s.id} value={String(s.id)}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">الوضع</label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { value: 'active', label: 'نشط' },
                    { value: 'inactive', label: 'نقل للأرشفة' },
                  ].map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setFormState({ ...formState, status: opt.value })}
                      className={`rounded-lg border px-3 py-2 text-xs font-semibold cursor-pointer ${
                        formState.status === opt.value
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
                <label className="block font-semibold text-slate-700 mb-1">ملاحظات</label>
                <textarea
                  rows={2}
                  value={formState.notes}
                  onChange={(e) => setFormState({ ...formState, notes: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-[#0B1F3A] px-5 py-2 font-semibold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
                >
                  {saving ? 'جاري الحفظ...' : 'حفظ البيانات'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-sm bg-white rounded-2xl border border-slate-200 shadow-xl p-5 space-y-4 text-xs">
            <h3 className="font-bold text-sm text-[#0B1F3A]">تأكيد حذف الموظف</h3>
            <p className="text-slate-600">
              هل تريد حذف الموظف <strong>{deleteTarget.fullName}</strong> نهائياً؟
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 cursor-pointer"
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
      )}
      {/* Grant / Edit App Permissions Modal */}
      {isSuperAdmin && (
        <StaffAccessModal
          open={accessModalOpen}
          onClose={() => {
            setAccessModalOpen(false);
            setAccessTargetEmployee(null);
            setAccessInitialUser(null);
          }}
          onSaved={loadAll}
          roles={staffRoles}
          schools={staffSchools}
          lockedEmployee={accessTargetEmployee}
          initialUser={accessInitialUser}
        />
      )}
    </div>
  );
};
