import React, { useEffect, useState } from 'react';
import { Building2, KeyRound, RefreshCw, Shield, X } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { ROLE_DEFAULT_PERMISSIONS, STAFF_PERMISSIONS_CATALOG } from '../../lib/permissions';
import { useEscapeKey } from '../../lib/useEscapeKey';
import { ContactPhoneInput } from '../ContactPhoneInput';

export interface StaffRoleOption {
  id: number;
  slug: string;
  nameAr: string;
  description: string | null;
  permissions: string[];
}

export interface StaffSchoolOption {
  id: number;
  name: string;
}

export interface StaffEmployeeOption {
  id: number;
  fullName: string;
  jobTitle: string;
  phone: string;
  employeeCode: string;
}

export interface StaffUserEditable {
  id?: number;
  fullName: string;
  email: string;
  phone: string | null;
  roleId?: number;
  roleSlug: string;
  assignedSchoolIds: number[];
  customPermissions: string[] | null;
  effectivePermissions?: string[];
  staffCode: string | null;
  employeeId?: number | null;
  isActive: boolean;
}

interface StaffAccessModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
  roles: StaffRoleOption[];
  schools: StaffSchoolOption[];
  employees?: StaffEmployeeOption[];
  initialUser?: StaffUserEditable | null;
  lockedEmployee?: StaffEmployeeOption | null;
}

const GROUP_TITLES: Record<'operations' | 'finance' | 'fleet' | 'admin', string> = {
  operations: 'العمليات والسائقون والحضور',
  finance: 'السلف والتغطيات والمالية والرواتب',
  fleet: 'المدارس والمركبات وخطوط السير والتتبع',
  admin: 'التقارير والموظفون',
};

function generateRandomStaffCode(): string {
  const num = Math.floor(1000 + Math.random() * 9000);
  return `STF-${num}`;
}

export const StaffAccessModal: React.FC<StaffAccessModalProps> = ({
  open,
  onClose,
  onSaved,
  roles,
  schools,
  employees = [],
  initialUser,
  lockedEmployee,
}) => {
  const isEditing = Boolean(initialUser?.id);
  const staffRoles = roles.filter((r) =>
    ['accountant', 'movement_manager', 'employee', 'super_admin'].includes(r.slug)
  );

  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [staffCode, setStaffCode] = useState('');
  const [roleSlug, setRoleSlug] = useState<string>('accountant');
  const [employeeId, setEmployeeId] = useState<string>('');
  const [schoolScopeMode, setSchoolScopeMode] = useState<'all' | 'specific'>('all');
  const [assignedSchoolIds, setAssignedSchoolIds] = useState<number[]>([]);
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>(
    ROLE_DEFAULT_PERMISSIONS.accountant
  );
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEscapeKey(open, onClose);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (initialUser) {
      const slug = ['accountant', 'movement_manager', 'employee', 'super_admin'].includes(
        initialUser.roleSlug
      )
        ? initialUser.roleSlug
        : 'accountant';
      setFullName(initialUser.fullName || '');
      setPhone(initialUser.phone || '');
      setEmail(
        initialUser.email && !initialUser.email.endsWith('@alwaleed.local')
          ? initialUser.email
          : ''
      );
      setStaffCode(initialUser.staffCode || generateRandomStaffCode());
      setRoleSlug(slug);
      setEmployeeId(
        initialUser.employeeId
          ? String(initialUser.employeeId)
          : lockedEmployee
          ? String(lockedEmployee.id)
          : ''
      );
      const sIds = initialUser.assignedSchoolIds || [];
      setSchoolScopeMode(sIds.length > 0 ? 'specific' : 'all');
      setAssignedSchoolIds(sIds);
      const basePerms =
        initialUser.customPermissions && initialUser.customPermissions.length >= 0
          ? initialUser.customPermissions
          : initialUser.effectivePermissions ||
            ROLE_DEFAULT_PERMISSIONS[slug] ||
            ROLE_DEFAULT_PERMISSIONS.accountant;
      setSelectedPermissions(basePerms.filter((p) => p !== '*'));
      setIsActive(initialUser.isActive !== false);
    } else if (lockedEmployee) {
      setFullName(lockedEmployee.fullName || '');
      setPhone(lockedEmployee.phone || '');
      setEmail('');
      setStaffCode(generateRandomStaffCode());
      setRoleSlug('accountant');
      setEmployeeId(String(lockedEmployee.id));
      setSchoolScopeMode('all');
      setAssignedSchoolIds([]);
      setSelectedPermissions([...ROLE_DEFAULT_PERMISSIONS.accountant]);
      setIsActive(true);
    } else {
      setFullName('');
      setPhone('');
      setEmail('');
      setStaffCode(generateRandomStaffCode());
      setRoleSlug('accountant');
      setEmployeeId('');
      setSchoolScopeMode('all');
      setAssignedSchoolIds([]);
      setSelectedPermissions([...ROLE_DEFAULT_PERMISSIONS.accountant]);
      setIsActive(true);
    }
  }, [open, initialUser, lockedEmployee]);

  if (!open) return null;

  const handleSelectRole = (nextSlug: string) => {
    setRoleSlug(nextSlug);
    if (!isEditing) {
      const defaults = ROLE_DEFAULT_PERMISSIONS[nextSlug] || [];
      setSelectedPermissions(defaults.filter((p) => p !== '*'));
    }
  };

  const handlePickEmployee = (empIdStr: string) => {
    setEmployeeId(empIdStr);
    if (!empIdStr) return;
    const emp = employees.find((e) => String(e.id) === empIdStr);
    if (emp) {
      setFullName((prev) => (prev.trim() ? prev : emp.fullName));
      setPhone((prev) => (prev.trim() ? prev : emp.phone || ''));
    }
  };

  const toggleSchool = (schoolId: number) => {
    setAssignedSchoolIds((prev) =>
      prev.includes(schoolId) ? prev.filter((id) => id !== schoolId) : [...prev, schoolId]
    );
  };

  const togglePermission = (permKey: string) => {
    setSelectedPermissions((prev) =>
      prev.includes(permKey) ? prev.filter((k) => k !== permKey) : [...prev, permKey]
    );
  };

  const toggleGroupPermissions = (groupKey: 'operations' | 'finance' | 'fleet' | 'admin') => {
    const groupPerms = STAFF_PERMISSIONS_CATALOG.filter((p) => p.group === groupKey).map(
      (p) => p.key
    );
    const allSelected = groupPerms.every((k) => selectedPermissions.includes(k));
    if (allSelected) {
      setSelectedPermissions((prev) => prev.filter((k) => !groupPerms.includes(k)));
    } else {
      setSelectedPermissions((prev) => Array.from(new Set([...prev, ...groupPerms])));
    }
  };

  const applyPreset = (preset: 'coverage_advances' | 'accountant' | 'movement_manager' | 'employee') => {
    if (preset === 'coverage_advances') {
      setSelectedPermissions([
        'dashboard:read',
        'drivers:read',
        'advances:write',
        'coverage:write',
        'attendance:write',
      ]);
    } else if (preset === 'employee') {
      setSelectedPermissions([...(ROLE_DEFAULT_PERMISSIONS.employee || ['dashboard:read'])]);
    } else if (preset === 'accountant') {
      setSelectedPermissions([...ROLE_DEFAULT_PERMISSIONS.accountant]);
    } else {
      setSelectedPermissions([...ROLE_DEFAULT_PERMISSIONS.movement_manager]);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!fullName.trim()) {
      setError('يرجى إدخال اسم الموظف الكامل.');
      return;
    }
    if (schoolScopeMode === 'specific' && assignedSchoolIds.length === 0) {
      setError('اختر مدرسة واحدة على الأقل أو حدد «جميع المدارس».');
      return;
    }
    if (roleSlug !== 'super_admin' && selectedPermissions.length === 0) {
      setError('يرجى اختيار صلاحية واحدة على الأقل لهذا الموظف.');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        fullName: fullName.trim(),
        phone: phone.trim(),
        email: email.trim(),
        staffCode: staffCode.trim().toUpperCase() || generateRandomStaffCode(),
        roleSlug,
        employeeId: employeeId ? Number(employeeId) : null,
        assignedSchoolIds: schoolScopeMode === 'specific' ? assignedSchoolIds : [],
        customPermissions: roleSlug === 'super_admin' ? null : selectedPermissions,
        isActive,
      };

      if (isEditing && initialUser?.id) {
        await apiFetch(`/api/users/${initialUser.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch('/api/users', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }

      await onSaved();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر حفظ صلاحيات الموظف');
    } finally {
      setSaving(false);
    }
  };

  const isProtectedOwner =
    initialUser?.email?.toLowerCase() === 'hamdyhamzway@gmail.com';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 p-3 sm:p-4 backdrop-blur-xs">
      <div className="w-full max-w-3xl bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden max-h-[92vh] flex flex-col">
        <div className="px-6 py-4 bg-[#0B1F3A] text-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <Shield className="w-5 h-5 text-[#C89B3C] shrink-0" />
            <div className="min-w-0">
              <h2 className="font-display text-base font-bold truncate">
                {isEditing
                  ? `تعديل صلاحيات الموظف — ${initialUser?.fullName}`
                  : lockedEmployee
                  ? `منح صلاحية التطبيق للموظف — ${lockedEmployee.fullName}`
                  : 'تعيين محاسب أو مدير حركة جديد بصلاحيات محددة'}
              </h2>
              <p className="text-[11px] text-slate-300 truncate">
                تحكم كامل في الدور الوظيفي، المدارس المصرح بها، والصلاحيات التفصيلية وكود الدخول
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-300 hover:text-white cursor-pointer shrink-0"
            aria-label="إغلاق"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 sm:p-6 overflow-y-auto space-y-5 text-xs">
          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-red-800">
              {error}
            </div>
          )}

          {/* Optional Employee Link */}
          {!lockedEmployee && employees.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 space-y-1.5">
              <label className="block font-semibold text-[#0B1F3A]">
                ربط بموظف مسجل من قائمة الموظفين (اختياري)
              </label>
              <select
                value={employeeId}
                onChange={(e) => handlePickEmployee(e.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 focus:border-[#0B1F3A] focus:outline-none"
              >
                <option value="">— حساب مستقل (أو أدخل البيانات يدوياً أدناه) —</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={String(emp.id)}>
                    {emp.fullName} {emp.jobTitle ? `(${emp.jobTitle})` : ''}{' '}
                    {emp.phone ? `· ${emp.phone}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Basic Info & Login Code */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div>
              <label className="block font-semibold text-slate-700 mb-1">الاسم الكامل *</label>
              <input
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="مثال: أحمد محمد — محاسب مدرسة ..."
                className="w-full rounded-lg border border-slate-200 px-3 py-2 focus:border-[#0B1F3A] focus:outline-none"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                رقم الهاتف (لتسجيل الدخول بكود الموظف)
              </label>
              <ContactPhoneInput
                value={phone}
                placeholder="01xxxxxxxxx"
                onChange={setPhone}
                onPickContact={({ phone: pickedPhone, name }) => {
                  setPhone(pickedPhone);
                  if (!fullName.trim() && name) setFullName(name);
                }}
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                البريد الإلكتروني (اختياري — للدخول بحساب Google)
              </label>
              <input
                type="email"
                dir="ltr"
                disabled={isProtectedOwner}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="staff@example.com"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-left disabled:bg-slate-100 focus:border-[#0B1F3A] focus:outline-none"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                كود الدخول للموظف *
              </label>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <KeyRound className="w-3.5 h-3.5 text-[#C89B3C] absolute right-3 top-2.5 pointer-events-none" />
                  <input
                    required
                    dir="ltr"
                    value={staffCode}
                    onChange={(e) => setStaffCode(e.target.value.toUpperCase())}
                    placeholder="STF-1234"
                    className="w-full rounded-lg border border-slate-200 pr-8 pl-3 py-2 font-mono font-bold text-[#0B1F3A] focus:border-[#0B1F3A] focus:outline-none"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setStaffCode(generateRandomStaffCode())}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 px-3 py-2 font-semibold text-[#0B1F3A] whitespace-nowrap cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5 text-[#C89B3C]" />
                  توليد
                </button>
              </div>
            </div>
          </div>

          {/* Role Selection */}
          <div className="space-y-2">
            <label className="block font-bold text-[#0B1F3A]">الدور الوظيفي داخل التطبيق *</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
              {(staffRoles.length > 0
                ? staffRoles
                : [
                    { id: 0, slug: 'accountant', nameAr: 'محاسب', description: 'إدارة المرتبات والسلف والتغطيات', permissions: [] },
                    { id: 0, slug: 'movement_manager', nameAr: 'مشرف حركة', description: 'متابعة السائقين والتغطيات والسلف والأسطول', permissions: [] },
                    { id: 0, slug: 'employee', nameAr: 'موظف عادي / ميداني', description: 'تقديم التقارير اليومية والمحادثات ضمن مدرسته', permissions: [] },
                    { id: 0, slug: 'super_admin', nameAr: 'المدير العام', description: 'صلاحيات كاملة', permissions: [] },
                  ]
              ).map((r) => {
                const selected = roleSlug === r.slug;
                return (
                  <button
                    key={r.slug}
                    type="button"
                    disabled={isProtectedOwner && r.slug !== 'super_admin'}
                    onClick={() => handleSelectRole(r.slug)}
                    className={`rounded-xl border p-3 text-right transition-colors cursor-pointer disabled:opacity-50 ${
                      selected
                        ? 'border-[#0B1F3A] bg-[#0B1F3A] text-white'
                        : 'border-slate-200 bg-white hover:bg-slate-50 text-[#0B1F3A]'
                    }`}
                  >
                    <div className="font-bold text-xs">{r.nameAr}</div>
                    <div
                      className={`mt-1 text-[11px] leading-snug ${
                        selected ? 'text-slate-300' : 'text-slate-500'
                      }`}
                    >
                      {r.description || r.slug}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Assigned School Scope */}
          <div className="rounded-xl border border-slate-200 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-bold text-[#0B1F3A]">
                <Building2 className="w-4 h-4 text-[#C89B3C]" />
                <span>نطاق المدارس المصرح بالوصول إليها</span>
              </div>
              <div className="inline-flex rounded-lg bg-slate-100 p-0.5">
                <button
                  type="button"
                  onClick={() => {
                    setSchoolScopeMode('all');
                    setAssignedSchoolIds([]);
                  }}
                  className={`rounded-md px-3 py-1.5 text-[11px] font-bold cursor-pointer transition-colors ${
                    schoolScopeMode === 'all'
                      ? 'bg-[#0B1F3A] text-white'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  جميع المدارس
                </button>
                <button
                  type="button"
                  onClick={() => setSchoolScopeMode('specific')}
                  className={`rounded-md px-3 py-1.5 text-[11px] font-bold cursor-pointer transition-colors ${
                    schoolScopeMode === 'specific'
                      ? 'bg-[#0B1F3A] text-white'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  مدارس محددة فقط
                </button>
              </div>
            </div>

            {schoolScopeMode === 'all' ? (
              <p className="text-[11px] text-slate-500">
                يستطيع هذا الموظف الاطلاع والعمل على جميع المدارس والسائقين المسجلين وفقاً لصلاحياته.
              </p>
            ) : (
              <div className="space-y-2">
                <p className="text-[11px] text-slate-600">
                  عزل كامل لبيانات المدرسة المختارة — لا يرى الموظف أي سائقين أو مركبات أو تقارير أو مرتبات لمدارس أخرى:
                </p>
                {schools.length === 0 ? (
                  <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                    لا توجد مدارس نشطة حالياً. أضف مدارس من قسم «المدارس والمركبات» أولاً.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-44 overflow-y-auto pr-0.5">
                    {schools.map((sc) => {
                      const checked = assignedSchoolIds.includes(sc.id);
                      return (
                        <label
                          key={sc.id}
                          className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                            checked
                              ? 'border-[#0B1F3A] bg-slate-50 text-[#0B1F3A] font-semibold'
                              : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleSchool(sc.id)}
                            className="rounded border-slate-300 text-[#0B1F3A] focus:ring-[#0B1F3A]"
                          />
                          <span className="truncate">{sc.name}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Granular Permissions Matrix */}
          {roleSlug === 'super_admin' ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3.5 text-[11px] text-amber-900">
              المدير العام يمتلك جميع الصلاحيات تلقائياً (`*`) بما في ذلك إدارة المستخدمين والتصفيات والنسخ المعزولة.
            </div>
          ) : (
            <div className="rounded-xl border border-slate-200 p-4 space-y-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-bold text-[#0B1F3A]">
                    الصلاحيات التفصيلية داخل التطبيق ({selectedPermissions.length} صلاحية مفعلة)
                  </div>
                  <p className="text-[11px] text-slate-500">
                    حدد بدقة ما يمكن لهذا الموظف رؤيته أو إضافته وتعديله
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => applyPreset('coverage_advances')}
                    className="rounded-lg border border-[#C89B3C]/60 bg-amber-50 hover:bg-amber-100 px-2.5 py-1 text-[11px] font-bold text-[#0B1F3A] cursor-pointer"
                  >
                    صلاحيات التغطيات والسلف فقط
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      applyPreset(
                        roleSlug === 'movement_manager'
                          ? 'movement_manager'
                          : roleSlug === 'employee'
                          ? 'employee'
                          : 'accountant'
                      )
                    }
                    className="rounded-lg border border-slate-200 bg-white hover:bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-700 cursor-pointer"
                  >
                    الافتراضي للدور
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {(['operations', 'finance', 'fleet', 'admin'] as const).map((groupKey) => {
                  const items = STAFF_PERMISSIONS_CATALOG.filter((p) => p.group === groupKey);
                  const allInGroup = items.every((p) => selectedPermissions.includes(p.key));
                  return (
                    <div
                      key={groupKey}
                      className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-slate-200/80">
                        <span className="font-bold text-[11px] text-[#0B1F3A]">
                          {GROUP_TITLES[groupKey]}
                        </span>
                        <button
                          type="button"
                          onClick={() => toggleGroupPermissions(groupKey)}
                          className="text-[11px] font-semibold text-[#C89B3C] hover:underline cursor-pointer"
                        >
                          {allInGroup ? 'إلغاء الكل' : 'تحديد الكل'}
                        </button>
                      </div>
                      <div className="space-y-1.5">
                        {items.map((perm) => {
                          const checked = selectedPermissions.includes(perm.key);
                          return (
                            <label
                              key={perm.key}
                              className="flex items-start gap-2 rounded-lg p-1.5 hover:bg-white cursor-pointer transition-colors"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => togglePermission(perm.key)}
                                className="mt-0.5 rounded border-slate-300 text-[#0B1F3A] focus:ring-[#0B1F3A]"
                              />
                              <div className="min-w-0">
                                <div className="font-semibold text-slate-900 leading-tight">
                                  {perm.labelAr}
                                </div>
                                <div className="text-[11px] text-slate-500 leading-snug">
                                  {perm.descriptionAr}
                                </div>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Account Status */}
          {!isProtectedOwner && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <div>
                <div className="font-bold text-[#0B1F3A]">حالة تفعيل الحساب</div>
                <div className="text-[11px] text-slate-500">
                  يمكنك إيقاف الحساب مؤقتاً في أي وقت لمنع الموظف من الدخول دون حذف سجلاته
                </div>
              </div>
              <div className="inline-flex rounded-lg bg-slate-200/70 p-0.5">
                <button
                  type="button"
                  onClick={() => setIsActive(true)}
                  className={`rounded-md px-3 py-1.5 text-[11px] font-bold cursor-pointer ${
                    isActive ? 'bg-[#0B1F3A] text-white' : 'text-slate-600'
                  }`}
                >
                  مفعّل
                </button>
                <button
                  type="button"
                  onClick={() => setIsActive(false)}
                  className={`rounded-md px-3 py-1.5 text-[11px] font-bold cursor-pointer ${
                    !isActive ? 'bg-red-600 text-white' : 'text-slate-600'
                  }`}
                >
                  موقوف
                </button>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-200 px-4 py-2 font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-xl bg-[#0B1F3A] px-5 py-2 font-bold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
            >
              {saving
                ? 'جاري الحفظ...'
                : isEditing
                ? 'حفظ الصلاحيات والتعديلات'
                : 'اعتماد تعيين الموظف'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
