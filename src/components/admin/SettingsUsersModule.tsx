import React, { useCallback, useEffect, useState } from 'react';
import {
  Bell,
  Check,
  Copy,
  Edit3,
  Power,
  Search,
  Shield,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { apiFetch, normalizeLookupText } from '../../lib/api';
import { PERMISSION_LABEL_MAP } from '../../lib/permissions';
import { useEscapeKey } from '../../lib/useEscapeKey';
import {
  StaffAccessModal,
  type StaffEmployeeOption,
  type StaffRoleOption,
  type StaffSchoolOption,
} from './StaffAccessModal';

interface UserItem {
  id: number;
  email: string;
  fullName: string;
  phone: string | null;
  roleId: number;
  roleSlug: string;
  roleNameAr: string;
  assignedSchoolIds: number[];
  assignedSchoolNames: string[];
  customPermissions: string[] | null;
  effectivePermissions: string[];
  staffCode: string | null;
  employeeId: number | null;
  employeeName: string | null;
  isActive: boolean;
}

interface AuditItem {
  id: number;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
}

export const SettingsUsersModule: React.FC<{ onOpenSupervisors?: () => void }> = ({
  onOpenSupervisors,
}) => {
  const [usersList, setUsersList] = useState<UserItem[]>([]);
  const [rolesList, setRolesList] = useState<StaffRoleOption[]>([]);
  const [schoolsList, setSchoolsList] = useState<StaffSchoolOption[]>([]);
  const [employeesList, setEmployeesList] = useState<StaffEmployeeOption[]>([]);
  const [auditList, setAuditList] = useState<AuditItem[]>([]);
  const [supervisorsCount, setSupervisorsCount] = useState<number>(0);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [viewFilter, setViewFilter] = useState<'staff' | 'all'>('staff');
  const [copiedUserId, setCopiedUserId] = useState<number | null>(null);

  const [staffModalOpen, setStaffModalOpen] = useState(false);
  const [editingStaff, setEditingStaff] = useState<UserItem | null>(null);
  const [deletingUser, setDeletingUser] = useState<UserItem | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);

  const [announceTitle, setAnnounceTitle] = useState('');
  const [announceBody, setAnnounceBody] = useState('');
  const [targetDriverQuery, setTargetDriverQuery] = useState('');
  const [sentMsg, setSentMsg] = useState<string | null>(null);
  const [announceError, setAnnounceError] = useState<string | null>(null);

  useEscapeKey(Boolean(deletingUser), () => setDeletingUser(null));

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [uRes, aRes, sRes] = await Promise.all([
        apiFetch<{
          users: UserItem[];
          roles: StaffRoleOption[];
          schools: StaffSchoolOption[];
          employees: StaffEmployeeOption[];
        }>('/api/users'),
        apiFetch<{ logs: AuditItem[] }>('/api/audit-logs'),
        apiFetch<{ supervisors: Array<{ id: number }> }>('/api/supervisors'),
      ]);
      setUsersList(uRes.users || []);
      setRolesList(uRes.roles || []);
      setSchoolsList(uRes.schools || []);
      setEmployeesList(uRes.employees || []);
      setAuditList(aRes.logs || []);
      setSupervisorsCount((sRes.supervisors || []).length);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل بيانات الصلاحيات والمستخدمين');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleToggleActive = async (u: UserItem) => {
    setError(null);
    setActionMsg(null);
    try {
      await apiFetch(`/api/users/${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !u.isActive }),
      });
      setActionMsg(
        !u.isActive
          ? `تم تفعيل حساب «${u.fullName}».`
          : `تم إيقاف حساب «${u.fullName}» مؤقتاً.`
      );
      await loadAll();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحديث حالة الحساب');
    }
  };

  const handleConfirmDeleteUser = async () => {
    if (!deletingUser) return;
    setDeletingBusy(true);
    setError(null);
    setActionMsg(null);
    try {
      const res = await apiFetch<{ ok: boolean; revokedOnly?: boolean; message?: string }>(
        `/api/users/${deletingUser.id}`,
        { method: 'DELETE' }
      );
      setActionMsg(
        res.message ||
          (res.revokedOnly
            ? `تم سحب صلاحية الدخول عن «${deletingUser.fullName}» مع حفظ السجلات المرتبطة.`
            : `تم حذف حساب «${deletingUser.fullName}» نهائياً.`)
      );
      setDeletingUser(null);
      await loadAll();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر حذف الحساب');
    } finally {
      setDeletingBusy(false);
    }
  };

  const handleCopyStaffCode = async (u: UserItem) => {
    if (!u.staffCode) return;
    try {
      await navigator.clipboard.writeText(u.staffCode);
      setCopiedUserId(u.id);
      window.setTimeout(() => {
        setCopiedUserId((prev) => (prev === u.id ? null : prev));
      }, 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  const handleSendAnnouncement = async (e: React.FormEvent) => {
    e.preventDefault();
    setSentMsg(null);
    setAnnounceError(null);
    try {
      await apiFetch('/api/notifications/announcement', {
        method: 'POST',
        body: JSON.stringify({
          title: announceTitle,
          body: announceBody,
          driverQuery: targetDriverQuery.trim(),
        }),
      });
      setAnnounceTitle('');
      setAnnounceBody('');
      setTargetDriverQuery('');
      setSentMsg('تم إرسال الإشعار بنجاح.');
    } catch (err: unknown) {
      setAnnounceError(err instanceof Error ? err.message : 'تعذر إرسال الإشعار');
    }
  };

  const staffRoleSlugs = new Set(['accountant', 'movement_manager', 'employee', 'super_admin']);
  const staffCount = usersList.filter((u) => staffRoleSlugs.has(u.roleSlug)).length;

  const filteredUsers = usersList.filter((u) => {
    if (viewFilter === 'staff' && !staffRoleSlugs.has(u.roleSlug)) return false;
    const q = normalizeLookupText(search);
    if (!q) return true;
    return (
      normalizeLookupText(u.fullName).includes(q) ||
      normalizeLookupText(u.email).includes(q) ||
      normalizeLookupText(u.phone || '').includes(q) ||
      normalizeLookupText(u.staffCode || '').includes(q) ||
      normalizeLookupText(u.roleNameAr).includes(q) ||
      u.assignedSchoolNames.some((sName) => normalizeLookupText(sName).includes(q))
    );
  });

  const formatPermissionsSummary = (u: UserItem) => {
    if (u.roleSlug === 'super_admin' || u.effectivePermissions.includes('*')) {
      return 'كافة الصلاحيات (وصول شامل)';
    }
    if (!u.effectivePermissions.length) return 'بدون صلاحيات مفعلة';
    const labels = u.effectivePermissions
      .slice(0, 3)
      .map((k) => PERMISSION_LABEL_MAP[k] || k);
    const extra = u.effectivePermissions.length - labels.length;
    return extra > 0 ? `${labels.join(' · ')} (+${extra})` : labels.join(' · ');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#0B1F3A]">
            إدارة صلاحيات الموظفين والمحاسبين ومديري الحركة
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            عيّن محاسباً أو مدير حركة أو أكثر لكل مدرسة وحدد صلاحياته بدقة (السائقون، السلف،
            التغطيات، المالية) مع كود دخول خاص به
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setEditingStaff(null);
            setStaffModalOpen(true);
          }}
          className="inline-flex items-center gap-2 rounded-xl bg-[#0B1F3A] hover:bg-[#13325c] px-4 py-2.5 text-xs font-bold text-white cursor-pointer whitespace-nowrap shrink-0"
        >
          <UserPlus className="w-4 h-4 text-[#C89B3C]" />
          تعيين / إضافة موظف بصلاحيات
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-800 flex items-center justify-between gap-2">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-red-500 hover:text-red-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {actionMsg && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs font-semibold text-emerald-900 flex items-center justify-between gap-2">
          <span>{actionMsg}</span>
          <button
            type="button"
            onClick={() => setActionMsg(null)}
            className="text-emerald-600 hover:text-emerald-900 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Primary Staff Management Panel (Accountants & Movement Managers per School) */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Users className="w-4 h-4 text-[#C89B3C] shrink-0" />
            <div>
              <h2 className="font-display text-sm font-bold text-[#0B1F3A]">
                فريق العمل والصلاحيات المخصصة ({staffCount} موظف إدارة)
              </h2>
              <p className="text-[11px] text-slate-500">
                يسجل الموظف دخوله من تبويب «الموظفين والإدارة» باستخدام رقم الموبايل وكود الدخول (PIN)
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-64">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute right-3 top-2.5 pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="بحث بالاسم، الكود، الهاتف، أو المدرسة..."
                className="w-full rounded-lg border border-slate-200 bg-slate-50 pr-8 pl-7 py-1.5 text-xs focus:border-[#0B1F3A] focus:outline-none"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute left-2 top-2 text-slate-400 hover:text-slate-700 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-[11px]">
              <button
                type="button"
                onClick={() => setViewFilter('staff')}
                className={`rounded-md px-3 py-1.5 font-bold cursor-pointer ${
                  viewFilter === 'staff' ? 'bg-[#0B1F3A] text-white' : 'text-slate-600'
                }`}
              >
                المحاسبون والحركة والموظفون ({staffCount})
              </button>
              <button
                type="button"
                onClick={() => setViewFilter('all')}
                className={`rounded-md px-3 py-1.5 font-bold cursor-pointer ${
                  viewFilter === 'all' ? 'bg-[#0B1F3A] text-white' : 'text-slate-600'
                }`}
              >
                جميع الحسابات ({usersList.length})
              </button>
            </div>
          </div>
        </div>

        {/* Mobile Cards */}
        <div className="md:hidden divide-y divide-slate-100">
          {loading ? (
            <div className="p-8 text-center text-xs text-slate-400">جاري تحميل الحسابات...</div>
          ) : filteredUsers.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-400">
              لا توجد حسابات مطابقة. اضغط «تعيين / إضافة موظف بصلاحيات» لإضافة محاسب أو مدير حركة.
            </div>
          ) : (
            filteredUsers.map((u) => {
              const isOwner = u.email.toLowerCase() === 'hamdyhamzway@gmail.com';
              const isStaffAccount = staffRoleSlugs.has(u.roleSlug);
              return (
                <div key={u.id} className="p-4 space-y-2.5 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-bold text-sm text-[#0B1F3A]">{u.fullName}</div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {u.roleNameAr} ·{' '}
                        <span className={u.isActive ? 'text-emerald-700 font-semibold' : 'text-red-700 font-semibold'}>
                          {u.isActive ? 'مفعل' : 'موقوف'}
                        </span>
                      </div>
                    </div>
                    {u.staffCode && (
                      <button
                        type="button"
                        onClick={() => handleCopyStaffCode(u)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 font-mono font-bold text-[#0B1F3A] cursor-pointer"
                      >
                        {copiedUserId === u.id ? (
                          <Check className="w-3 h-3 text-emerald-600" />
                        ) : (
                          <Copy className="w-3 h-3 text-[#C89B3C]" />
                        )}
                        <span className="tabular-nums">{u.staffCode}</span>
                      </button>
                    )}
                  </div>

                  <div className="text-[11px] text-slate-600 space-y-1">
                    {u.phone && (
                      <div className="font-mono tabular-nums" dir="ltr">
                        {u.phone}
                      </div>
                    )}
                    <div>
                      <span className="text-slate-400">المدارس: </span>
                      <span className="font-semibold text-slate-800">
                        {u.assignedSchoolIds.length === 0
                          ? 'جميع المدارس'
                          : u.assignedSchoolNames.join(' · ')}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400">الصلاحيات: </span>
                      <span>{formatPermissionsSummary(u)}</span>
                    </div>
                  </div>

                  {isStaffAccount && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingStaff(u);
                          setStaffModalOpen(true);
                        }}
                        className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg bg-[#0B1F3A] px-3 py-1.5 text-[11px] font-semibold text-white cursor-pointer"
                      >
                        <Edit3 className="w-3 h-3 text-[#C89B3C]" />
                        تعديل الصلاحيات
                      </button>
                      {!isOwner && (
                        <>
                          <button
                            type="button"
                            onClick={() => handleToggleActive(u)}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 cursor-pointer"
                          >
                            <Power className="w-3 h-3" />
                            {u.isActive ? 'إيقاف' : 'تفعيل'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeletingUser(u)}
                            className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] font-semibold text-red-700 cursor-pointer"
                          >
                            <Trash2 className="w-3 h-3" />
                            حذف
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Desktop Table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
              <tr>
                <th className="py-3 px-4 font-semibold">الموظف والتواصل</th>
                <th className="py-3 px-4 font-semibold">الدور والحالة</th>
                <th className="py-3 px-4 font-semibold">كود الدخول</th>
                <th className="py-3 px-4 font-semibold">نطاق المدارس</th>
                <th className="py-3 px-4 font-semibold">الصلاحيات الممنوحة</th>
                <th className="py-3 px-4 font-semibold">التحكم</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-slate-400">
                    جاري تحميل الحسابات...
                  </td>
                </tr>
              ) : filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-slate-400">
                    لا توجد حسابات مطابقة — اضغط «تعيين / إضافة موظف بصلاحيات» لإضافة محاسب أو مدير حركة
                  </td>
                </tr>
              ) : (
                filteredUsers.map((u) => {
                  const isOwner = u.email.toLowerCase() === 'hamdyhamzway@gmail.com';
                  const isStaffAccount = staffRoleSlugs.has(u.roleSlug);
                  const displayEmail =
                    u.email && !u.email.endsWith('@alwaleed.local') ? u.email : '';
                  return (
                    <tr key={u.id} className="hover:bg-slate-50/70">
                      <td className="py-3.5 px-4">
                        <div className="font-bold text-slate-900">{u.fullName}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5 space-x-2 space-x-reverse">
                          {u.phone && (
                            <span className="font-mono tabular-nums" dir="ltr">
                              {u.phone}
                            </span>
                          )}
                          {displayEmail && (
                            <span className="font-mono text-slate-400">
                              {u.phone ? '· ' : ''}
                              {displayEmail}
                            </span>
                          )}
                          {u.employeeName && (
                            <span className="text-[#0B1F3A]">· مربوط بـ {u.employeeName}</span>
                          )}
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="font-semibold text-[#0B1F3A]">{u.roleNameAr}</div>
                        <div
                          className={`text-[11px] font-semibold mt-0.5 ${
                            u.isActive ? 'text-emerald-700' : 'text-red-700'
                          }`}
                        >
                          {u.isActive ? 'حساب مفعل' : 'موقوف مؤقتاً'}
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        {u.staffCode ? (
                          <button
                            type="button"
                            onClick={() => handleCopyStaffCode(u)}
                            title="نسخ كود الدخول"
                            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 px-2.5 py-1 font-mono font-bold text-[#0B1F3A] cursor-pointer"
                          >
                            <span className="tabular-nums">{u.staffCode}</span>
                            {copiedUserId === u.id ? (
                              <Check className="w-3 h-3 text-emerald-600" />
                            ) : (
                              <Copy className="w-3 h-3 text-[#C89B3C]" />
                            )}
                          </button>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>

                      <td className="py-3.5 px-4 max-w-[200px]">
                        {u.assignedSchoolIds.length === 0 ? (
                          <span className="font-semibold text-slate-700">جميع المدارس</span>
                        ) : (
                          <span className="font-semibold text-[#0B1F3A] leading-relaxed">
                            {u.assignedSchoolNames.join(' · ')}
                          </span>
                        )}
                      </td>

                      <td className="py-3.5 px-4 max-w-[240px] text-slate-600 leading-relaxed">
                        {formatPermissionsSummary(u)}
                      </td>

                      <td className="py-3.5 px-4">
                        {isStaffAccount ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                setEditingStaff(u);
                                setStaffModalOpen(true);
                              }}
                              className="inline-flex items-center gap-1 rounded-md bg-[#0B1F3A] hover:bg-[#13325c] px-2.5 py-1.5 text-[11px] font-semibold text-white cursor-pointer whitespace-nowrap"
                            >
                              <Edit3 className="w-3 h-3 text-[#C89B3C]" />
                              تعديل الصلاحيات
                            </button>
                            {!isOwner && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => handleToggleActive(u)}
                                  className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white hover:bg-slate-50 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 cursor-pointer whitespace-nowrap"
                                >
                                  <Power className="w-3 h-3" />
                                  {u.isActive ? 'إيقاف' : 'تفعيل'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDeletingUser(u)}
                                  className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 hover:bg-red-100 px-2.5 py-1.5 text-[11px] font-semibold text-red-700 cursor-pointer whitespace-nowrap"
                                >
                                  <Trash2 className="w-3 h-3" />
                                  سحب / حذف
                                </button>
                              </>
                            )}
                          </div>
                        ) : (
                          <span className="text-[11px] text-slate-400">
                            يُدار من قسم {u.roleSlug === 'driver' ? 'السائقين' : 'المشرفات'}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Role Architecture Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {rolesList.map((r) => (
          <div key={r.id} className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="flex items-center gap-2 font-bold text-sm text-[#0B1F3A]">
              <Shield className="w-4 h-4 text-[#C89B3C]" />
              <span>{r.nameAr}</span>
            </div>
            <p className="mt-1.5 text-xs text-slate-600 leading-relaxed">{r.description}</p>
            <div className="mt-2 font-mono text-[11px] text-slate-400">{r.slug}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Supervisors Shortcut + Audit Trail */}
        <div className="lg:col-span-7 space-y-6">
          {onOpenSupervisors && (
            <div className="bg-white border border-slate-200 rounded-xl px-5 py-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-[#0B1F3A] text-[#C89B3C] flex items-center justify-center shrink-0">
                  <UserCheck className="w-4 h-4" />
                </div>
                <div>
                  <div className="font-bold text-sm text-[#0B1F3A]">
                    حسابات المشرفات ({supervisorsCount})
                  </div>
                  <p className="text-xs text-slate-500">
                    قسم مستقل «إدارة المشرفات» في القائمة الجانبية لإدارة حسابات المشرفات المعزولة.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onOpenSupervisors}
                className="rounded-xl bg-[#0B1F3A] hover:bg-[#13325c] px-4 py-2 text-xs font-bold text-white whitespace-nowrap shrink-0 cursor-pointer"
              >
                فتح إدارة المشرفات
              </button>
            </div>
          )}

          {/* Audit Trail */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 font-bold text-sm text-[#0B1F3A]">
              سجل التدقيق والأمان (Audit Trail)
            </div>
            <div className="overflow-x-auto max-h-72 overflow-y-auto">
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="py-2.5 px-4">الوقت</th>
                    <th className="py-2.5 px-4">الإجراء</th>
                    <th className="py-2.5 px-4">الجدول / المعرف</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {auditList.map((a) => (
                    <tr key={a.id}>
                      <td className="py-2.5 px-4 font-mono text-slate-500 tabular-nums">
                        {new Date(a.createdAt).toLocaleString('ar-EG')}
                      </td>
                      <td className="py-2.5 px-4 font-mono font-semibold text-[#0B1F3A]">
                        {a.action}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-slate-600">
                        {a.entityType} #{a.entityId}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Send Announcement */}
        <form
          onSubmit={handleSendAnnouncement}
          className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-3 text-xs h-fit"
        >
          <div className="flex items-center gap-2 font-bold text-sm text-[#0B1F3A]">
            <Bell className="w-4 h-4 text-[#C89B3C]" />
            <span>إرسال إشعار للسائقين</span>
          </div>
          {sentMsg && (
            <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-2.5 text-emerald-800">
              {sentMsg}
            </div>
          )}
          {announceError && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-2.5 text-red-800">
              {announceError}
            </div>
          )}
          <input
            type="text"
            value={targetDriverQuery}
            onChange={(e) => setTargetDriverQuery(e.target.value)}
            placeholder="كود أو اسم السائق (اتركه فارغاً للإرسال للجميع)"
            className="w-full rounded-lg border border-slate-200 px-3 py-2"
          />
          <input
            required
            placeholder="عنوان الإشعار *"
            value={announceTitle}
            onChange={(e) => setAnnounceTitle(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2"
          />
          <textarea
            required
            rows={3}
            placeholder="نص التنبيه أو التعميم الإداري *"
            value={announceBody}
            onChange={(e) => setAnnounceBody(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2"
          />
          <button
            type="submit"
            className="w-full rounded-lg bg-[#0B1F3A] py-2.5 font-semibold text-white hover:bg-[#13325c] cursor-pointer"
          >
            إرسال الإشعار الآن
          </button>
        </form>
      </div>

      {/* Add / Edit Staff Modal */}
      <StaffAccessModal
        open={staffModalOpen}
        onClose={() => {
          setStaffModalOpen(false);
          setEditingStaff(null);
        }}
        onSaved={loadAll}
        roles={rolesList}
        schools={schoolsList}
        employees={employeesList}
        initialUser={editingStaff}
      />

      {/* Delete / Revoke User Confirmation Modal */}
      {deletingUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-sm bg-white rounded-2xl border border-slate-200 shadow-xl p-5 space-y-4 text-xs">
            <h3 className="font-bold text-sm text-[#0B1F3A]">سحب الصلاحية أو حذف الحساب</h3>
            <p className="text-slate-600 leading-relaxed">
              هل تريد حذف أو سحب صلاحية الدخول عن <strong>{deletingUser.fullName}</strong>؟
              {deletingUser.staffCode && (
                <>
                  {' '}
                  سيتم إلغاء كود الدخول{' '}
                  <span className="font-mono font-bold text-[#0B1F3A]">{deletingUser.staffCode}</span>.
                </>
              )}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={deletingBusy}
                onClick={() => setDeletingUser(null)}
                className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={deletingBusy}
                onClick={handleConfirmDeleteUser}
                className="rounded-lg bg-red-600 px-4 py-2 font-bold text-white hover:bg-red-700 disabled:opacity-50 cursor-pointer"
              >
                {deletingBusy ? 'جاري التنفيذ...' : 'تأكيد السحب / الحذف'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
