import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Edit3,
  Eye,
  Loader2,
  MapPin,
  Phone,
  Plus,
  Route,
  Search,
  Signal,
  SignalZero,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react';
import {
  apiFetch,
  formatArabicTimestampTime,
  formatRelativeArabicTime,
  normalizeLookupText,
} from '../../lib/api';
import { useEscapeKey } from '../../lib/useEscapeKey';
import { DriverAvatar } from '../DriverAvatar';
import { DriverPhotoUploader } from '../DriverPhotoUploader';
import type { FleetVehicle, SchoolItem, SupervisorRecord } from '../../types';

interface SupervisorsModuleProps {
  onPreviewSupervisor?: (supervisorId: number) => void;
}

const PLACEHOLDER_VALUES = new Set(['غير معين', 'غير معينة', 'غير محدد', '—', '-']);

function cleanEditableField(val?: string | null): string {
  const trimmed = (val || '').trim();
  return PLACEHOLDER_VALUES.has(trimmed) ? '' : trimmed;
}

export const SupervisorsModule: React.FC<SupervisorsModuleProps> = ({
  onPreviewSupervisor,
}) => {
  const [supervisorsList, setSupervisorsList] = useState<SupervisorRecord[]>([]);
  const [schoolsList, setSchoolsList] = useState<SchoolItem[]>([]);
  const [vehiclesList, setVehiclesList] = useState<FleetVehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');

  const [showModal, setShowModal] = useState(false);
  const [editingSupervisor, setEditingSupervisor] = useState<SupervisorRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [bannerMsg, setBannerMsg] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SupervisorRecord | null>(null);

  useEscapeKey(Boolean(deleteTarget || showModal), () => {
    if (deleteTarget) setDeleteTarget(null);
    else if (showModal) setShowModal(false);
  });

  const [form, setForm] = useState({
    supervisorCode: '',
    fullName: '',
    phone: '',
    photoUrl: '',
    linkedEmail: '',
    schoolName: '',
    busNumber: '',
    routeName: '',
    pickupArea: '',
    dropoffArea: '',
    accountStatus: 'active',
    notes: '',
  });

  const loadAll = useCallback(async () => {
    setLoadError(null);
    try {
      const [sRes, schRes, vRes] = await Promise.all([
        apiFetch<{ supervisors: SupervisorRecord[] }>('/api/supervisors'),
        apiFetch<{ schools: SchoolItem[] }>('/api/schools'),
        apiFetch<{ vehicles: FleetVehicle[] }>('/api/vehicles'),
      ]);
      setSupervisorsList(sRes.supervisors || []);
      setSchoolsList(schRes.schools || []);
      setVehiclesList(vRes.vehicles || []);
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : 'تعذر تحميل بيانات المشرفات');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const filteredSupervisors = useMemo(() => {
    const q = normalizeLookupText(searchQuery);
    const digitsOnly = q.replace(/\D/g, '');
    return supervisorsList.filter((s) => {
      if (statusFilter !== 'all' && s.accountStatus !== statusFilter) return false;
      if (!q) return true;
      return (
        normalizeLookupText(s.fullName).includes(q) ||
        normalizeLookupText(s.phone).includes(q) ||
        (digitsOnly.length >= 2 && normalizeLookupText(s.phone).replace(/\D/g, '').includes(digitsOnly)) ||
        normalizeLookupText(s.supervisorCode).includes(q) ||
        normalizeLookupText(s.schoolName).includes(q) ||
        normalizeLookupText(s.routeName).includes(q) ||
        normalizeLookupText(s.busNumber).includes(q)
      );
    });
  }, [supervisorsList, searchQuery, statusFilter]);

  const stats = useMemo(() => {
    const total = supervisorsList.length;
    const active = supervisorsList.filter((s) => s.accountStatus === 'active').length;
    const liveNow = supervisorsList.filter((s) => Boolean(s.liveLocation?.isLive)).length;
    return { total, active, liveNow };
  }, [supervisorsList]);

  const openAddModal = () => {
    setEditingSupervisor(null);
    setFormError(null);
    setForm({
      supervisorCode: '',
      fullName: '',
      phone: '',
      photoUrl: '',
      linkedEmail: '',
      schoolName: '',
      busNumber: '',
      routeName: '',
      pickupArea: '',
      dropoffArea: '',
      accountStatus: 'active',
      notes: '',
    });
    setShowModal(true);
  };

  const openEditModal = (s: SupervisorRecord) => {
    setEditingSupervisor(s);
    setFormError(null);
    setForm({
      supervisorCode: s.supervisorCode,
      fullName: s.fullName,
      phone: s.phone,
      photoUrl: s.photoUrl || '',
      linkedEmail: s.linkedEmail || '',
      schoolName: cleanEditableField(s.schoolName),
      busNumber: cleanEditableField(s.busNumber),
      routeName: cleanEditableField(s.routeName),
      pickupArea: s.pickupArea || '',
      dropoffArea: s.dropoffArea || '',
      accountStatus: s.accountStatus || 'active',
      notes: s.notes || '',
    });
    setShowModal(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setBannerMsg(null);

    const cleanName = form.fullName.trim();
    const cleanPhone = form.phone.trim();
    const cleanCode = form.supervisorCode.trim();
    const cleanPhoto = form.photoUrl.trim();
    const cleanEmail = form.linkedEmail.trim();
    const cleanSchool = cleanEditableField(form.schoolName);
    const cleanBus = cleanEditableField(form.busNumber);
    const cleanRoute = cleanEditableField(form.routeName);
    const cleanPickupArea = form.pickupArea.trim();
    const cleanDropoffArea = form.dropoffArea.trim();
    const cleanStatus = form.accountStatus === 'inactive' ? 'inactive' : 'active';
    const cleanNotes = form.notes.trim();

    const normalizedPhoneDigits = cleanPhone
      .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
      .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
      .replace(/\D/g, '');

    const emailValid = !cleanEmail || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail);

    const fieldValidationLog = {
      fullName: {
        value: cleanName,
        valid: cleanName.length > 0,
        reason: cleanName.length > 0 ? 'ok' : 'اسم المشرفة الكامل مطلوب',
      },
      phone: {
        value: cleanPhone,
        digitsCount: normalizedPhoneDigits.length,
        valid: cleanPhone.length > 0 && normalizedPhoneDigits.length >= 8,
        reason:
          cleanPhone.length > 0 && normalizedPhoneDigits.length >= 8
            ? 'ok'
            : 'رقم الموبايل يجب أن يحتوي على 8 أرقام على الأقل',
      },
      supervisorCode: {
        value: cleanCode,
        valid: cleanCode.length > 0,
        reason: cleanCode.length > 0 ? 'ok' : 'كود المشرفة مطلوب',
      },
      photoUrl: { hasPhoto: Boolean(cleanPhoto), valid: true, optional: true },
      accountStatus: {
        value: cleanStatus,
        valid: cleanStatus === 'active' || cleanStatus === 'inactive',
        reason: 'ok',
      },
      routeName: { value: cleanRoute, valid: true, optional: true },
      schoolName: { value: cleanSchool, valid: true, optional: true },
      busNumber: { value: cleanBus, valid: true, optional: true },
      pickupArea: { value: cleanPickupArea, valid: true, optional: true },
      dropoffArea: { value: cleanDropoffArea, valid: true, optional: true },
      linkedEmail: {
        value: cleanEmail,
        valid: emailValid,
        optional: true,
        reason: emailValid ? 'ok' : 'صيغة البريد الإلكتروني غير صحيحة',
      },
      notes: { value: cleanNotes, valid: true, optional: true },
    };

    console.log(
      '[SupervisorsModule] Pre-submission field validation log:',
      fieldValidationLog
    );

    if (!fieldValidationLog.fullName.valid) {
      setFormError('يرجى إدخال اسم المشرفة الكامل.');
      return;
    }
    if (!fieldValidationLog.phone.valid) {
      setFormError('يرجى إدخال رقم موبايل صحيح للمشرفة (8 أرقام على الأقل).');
      return;
    }
    if (!fieldValidationLog.supervisorCode.valid) {
      setFormError('يرجى إدخال كود المشرفة.');
      return;
    }
    if (!fieldValidationLog.linkedEmail.valid) {
      setFormError('صيغة البريد الإلكتروني المدخلة غير صحيحة.');
      return;
    }

    const payload = {
      supervisorCode: cleanCode,
      fullName: cleanName,
      phone: cleanPhone,
      photoUrl: cleanPhoto,
      linkedEmail: cleanEmail,
      schoolName: cleanSchool,
      busNumber: cleanBus,
      routeName: cleanRoute,
      pickupArea: cleanPickupArea,
      dropoffArea: cleanDropoffArea,
      accountStatus: cleanStatus,
      notes: cleanNotes,
    };

    setBusy(true);
    try {
      if (editingSupervisor) {
        await apiFetch(`/api/supervisors/${editingSupervisor.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        setBannerMsg(`تم تحديث بيانات المشرفة «${cleanName}» بنجاح.`);
      } else {
        await apiFetch('/api/supervisors', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setBannerMsg(`تمت إضافة المشرفة «${cleanName}» بكود ${cleanCode} بنجاح.`);
      }
      setShowModal(false);
      await loadAll();
    } catch (err: unknown) {
      const apiDetails =
        err && typeof err === 'object' && 'details' in err
          ? (err as { details?: string }).details
          : undefined;
      console.error('[SupervisorsModule] Failed to save supervisor:', {
        mode: editingSupervisor ? 'edit' : 'create',
        payload: { ...payload, photoUrl: cleanPhoto ? '[base64/url]' : '' },
        details: apiDetails,
        error: err,
      });
      const message = err instanceof Error ? err.message : 'تعذر حفظ بيانات المشرفة';
      setFormError(message);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    setFormError(null);
    setBannerMsg(null);
    try {
      await apiFetch(`/api/supervisors/${deleteTarget.id}`, { method: 'DELETE' });
      setBannerMsg(`تم حذف حساب المشرفة «${deleteTarget.fullName}».`);
      setDeleteTarget(null);
      await loadAll();
    } catch (err: unknown) {
      console.error('[SupervisorsModule] Failed to delete supervisor:', err);
      setLoadError(err instanceof Error ? err.message : 'تعذر حذف المشرفة');
      setDeleteTarget(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Primary Action */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#0B1F3A]">إدارة المشرفات</h1>
          <p className="text-sm text-slate-500 mt-1">
            إضافة وتعديل وحذف حسابات المشرفات بالصورة الشخصية ورقم الموبايل ومتابعة اللايف لوكيشن وبداية ونهاية الرحلة اليومية.
          </p>
        </div>

        <button
          type="button"
          onClick={openAddModal}
          className="min-h-[44px] inline-flex items-center gap-2 rounded-xl bg-[#0B1F3A] hover:bg-[#13325c] px-5 py-2.5 text-sm font-bold text-white whitespace-nowrap shrink-0 transition-colors cursor-pointer"
        >
          <Plus className="w-4 h-4 text-[#C89B3C]" />
          إضافة مشرفة جديدة
        </button>
      </div>

      {/* KPI Strip (Single-Elevation Hairline Grid) */}
      <div className="bg-white border border-slate-200 rounded-xl grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x sm:divide-x-reverse divide-slate-200">
        <div className="px-5 py-4">
          <div className="text-xs text-slate-500">إجمالي المشرفات</div>
          <div className="mt-1 font-mono text-2xl font-bold text-[#0B1F3A] tabular-nums">
            {stats.total}
          </div>
        </div>
        <div className="px-5 py-4">
          <div className="text-xs text-slate-500">حسابات نشطة</div>
          <div className="mt-1 font-mono text-2xl font-bold text-emerald-700 tabular-nums">
            {stats.active}
          </div>
        </div>
        <div className="px-5 py-4">
          <div className="text-xs text-slate-500">لايف لوكيشن نشط الآن</div>
          <div className="mt-1 font-mono text-2xl font-bold text-[#0B1F3A] tabular-nums">
            {stats.liveNow}
          </div>
        </div>
      </div>

      {bannerMsg && (
        <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-xs font-semibold text-emerald-800 flex items-center justify-between gap-2">
          <span>{bannerMsg}</span>
          <button
            type="button"
            onClick={() => setBannerMsg(null)}
            aria-label="إغلاق التنبيه"
            className="p-1 text-emerald-600 hover:text-emerald-900 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {loadError && (
        <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-xs text-red-700 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{loadError}</span>
          </div>
          <button
            type="button"
            onClick={() => setLoadError(null)}
            aria-label="إغلاق التنبيه"
            className="p-1 text-red-500 hover:text-red-800 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Search, Filter & Supervisors Table */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="بحث باسم المشرفة، رقم الموبايل، الكود، أو خط السير..."
              className="w-full rounded-xl border border-slate-200 bg-slate-50/60 pr-9 pl-8 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:bg-white focus:border-[#0B1F3A] focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="مسح البحث"
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 text-xs">
            {(
              [
                { id: 'all', label: 'الكل' },
                { id: 'active', label: 'نشط' },
                { id: 'inactive', label: 'موقوف' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setStatusFilter(tab.id)}
                className={`px-3 py-1.5 rounded-lg font-semibold whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                  statusFilter === tab.id
                    ? 'bg-white text-[#0B1F3A] shadow-sm'
                    : 'text-slate-600 hover:text-[#0B1F3A]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="p-8 text-center text-xs text-slate-500">جاري تحميل قائمة المشرفات...</div>
        ) : filteredSupervisors.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <div className="w-11 h-11 rounded-xl bg-slate-100 text-[#C89B3C] flex items-center justify-center mx-auto">
              <UserCheck className="w-5 h-5" />
            </div>
            <p className="text-sm font-bold text-[#0B1F3A]">
              {supervisorsList.length === 0
                ? 'لا توجد مشرفات مسجلات حتى الآن'
                : 'لا توجد نتائج مطابقة للبحث'}
            </p>
            <p className="text-xs text-slate-500 max-w-md mx-auto">
              {supervisorsList.length === 0
                ? 'أضف حساب المشرفة بالصورة الشخصية والكود المخصص ورقم الموبايل لتفعيل التتبع المباشر ومهام الرحلة.'
                : 'جرّب البحث بكلمة أخرى أو تغيير فلتر الحالة.'}
            </p>
            {supervisorsList.length === 0 && (
              <button
                type="button"
                onClick={openAddModal}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#0B1F3A] hover:bg-[#13325c] px-4 py-2 text-xs font-bold text-white cursor-pointer"
              >
                <Plus className="w-4 h-4 text-[#C89B3C]" />
                إضافة أول مشرفة
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4">الكود</th>
                  <th className="py-3 px-4">المشرفة والموبايل</th>
                  <th className="py-3 px-4">خط السير والباص</th>
                  <th className="py-3 px-4">اللايف لوكيشن ومهام اليوم</th>
                  <th className="py-3 px-4">الحالة</th>
                  <th className="py-3 px-4">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredSupervisors.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50/70">
                    <td className="py-3.5 px-4 font-mono font-bold text-[#0B1F3A] tabular-nums whitespace-nowrap">
                      {s.supervisorCode}
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="flex items-center gap-2.5">
                        <DriverAvatar name={s.fullName} photoUrl={s.photoUrl} size="sm" />
                        <div className="min-w-0">
                          <div className="font-bold text-slate-900 truncate">{s.fullName}</div>
                          <div className="mt-0.5 flex items-center gap-1 font-mono text-slate-500 tabular-nums">
                            <Phone className="w-3 h-3 text-[#C89B3C] shrink-0" />
                            <span dir="ltr">{s.phone}</span>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-slate-800 flex items-center gap-1.5">
                        <Route className="w-3.5 h-3.5 text-[#C89B3C] shrink-0" />
                        <span>{s.routeName}</span>
                      </div>
                      <div className="mt-0.5 text-slate-500 tabular-nums">
                        {s.schoolName} · باص {s.busNumber}
                      </div>
                    </td>
                    <td className="py-3.5 px-4 tabular-nums">
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5">
                          {s.liveLocation?.isLive ? (
                            <span className="inline-flex items-center gap-1 font-bold text-emerald-700">
                              <Signal className="w-3.5 h-3.5" />
                              لايف لوكيشن نشط
                            </span>
                          ) : s.liveLocation?.recordedAt ? (
                            <span className="inline-flex items-center gap-1 text-slate-500">
                              <SignalZero className="w-3.5 h-3.5" />
                              آخر ظهور {formatRelativeArabicTime(s.liveLocation.recordedAt)}
                            </span>
                          ) : (
                            <span className="text-slate-400">لم يبدأ التتبع بعد</span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-600">
                          <span className="inline-flex items-center gap-1">
                            {s.todayTrip?.morningStartedAt ? (
                              <CheckCircle2 className="w-3 h-3 text-emerald-600 shrink-0" />
                            ) : (
                              <Clock className="w-3 h-3 text-slate-400 shrink-0" />
                            )}
                            صباحاً:{' '}
                            <strong className="font-mono">
                              {formatArabicTimestampTime(s.todayTrip?.morningStartedAt)}
                            </strong>
                          </span>
                          <span className="inline-flex items-center gap-1">
                            {s.todayTrip?.eveningEndedAt ? (
                              <CheckCircle2 className="w-3 h-3 text-emerald-600 shrink-0" />
                            ) : (
                              <Clock className="w-3 h-3 text-slate-400 shrink-0" />
                            )}
                            مساءً:{' '}
                            <strong className="font-mono">
                              {formatArabicTimestampTime(s.todayTrip?.eveningEndedAt)}
                            </strong>
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <span
                        className={`font-bold ${
                          s.accountStatus === 'active' ? 'text-emerald-700' : 'text-amber-700'
                        }`}
                      >
                        {s.accountStatus === 'active' ? 'نشط' : 'موقوف'}
                      </span>
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="flex items-center gap-1.5">
                        {onPreviewSupervisor && (
                          <button
                            type="button"
                            onClick={() => onPreviewSupervisor(s.id)}
                            title="معاينة حساب المشرفة"
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 px-2.5 py-1.5 text-[11px] font-semibold text-[#0B1F3A] whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            <Eye className="w-3.5 h-3.5 text-[#C89B3C]" />
                            معاينة
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => openEditModal(s)}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 px-2.5 py-1.5 text-[11px] font-semibold text-[#0B1F3A] whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                          تعديل
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(s)}
                          className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 hover:bg-red-100 px-2.5 py-1.5 text-[11px] font-semibold text-red-700 whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          حذف
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Add / Edit Supervisor Modal */}
      {showModal && (
        <div
          onClick={() => setShowModal(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-xl bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden max-h-[90vh] flex flex-col"
          >
            <div className="px-5 py-4 bg-[#0B1F3A] text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <MapPin className="w-4 h-4 text-[#C89B3C]" />
                <h3 className="font-display text-base font-bold">
                  {editingSupervisor
                    ? `تعديل بيانات المشرفة: ${editingSupervisor.fullName}`
                    : 'إضافة مشرفة جديدة'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSave} className="p-5 overflow-y-auto space-y-4 text-xs">
              {formError && (
                <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-red-700">
                  {formError}
                </div>
              )}

              <DriverPhotoUploader
                photoUrl={form.photoUrl}
                driverName={form.fullName}
                title="صورة المشرفة الشخصية"
                subtitle="ارفع صورة المشرفة من الجهاز أو التقطها بالكاميرا مع إمكانية القص والتكبير وضبط الإضاءة."
                onChange={(nextPhotoUrl) => setForm((p) => ({ ...p, photoUrl: nextPhotoUrl }))}
              />

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-[#0B1F3A] mb-1">اسم المشرفة الكامل *</label>
                  <input
                    required
                    value={form.fullName}
                    onChange={(e) => setForm((p) => ({ ...p, fullName: e.target.value }))}
                    placeholder="أ. سارة محمود"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="font-bold text-[#0B1F3A]">رقم الموبايل *</label>
                    {'contacts' in navigator && 'select' in (navigator as any).contacts ? (
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const contacts = await (navigator as any).contacts.select(['tel'], { multiple: false });
                            if (contacts && contacts.length > 0 && contacts[0].tel && contacts[0].tel.length > 0) {
                              setForm((p) => ({ ...p, phone: contacts[0].tel[0] }));
                            }
                          } catch (err) {
                            console.warn('Contact picker error:', err);
                          }
                        }}
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#0B1F3A] hover:text-[#C89B3C] cursor-pointer"
                      >
                        <Phone className="w-3 h-3 text-[#C89B3C]" />
                        جهات الاتصال
                      </button>
                    ) : null}
                  </div>
                  <input
                    required
                    dir="ltr"
                    value={form.phone}
                    onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
                    placeholder="01012345678"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5 font-mono text-right"
                  />
                </div>
                <div>
                  <label className="block font-bold text-[#0B1F3A] mb-1">كود المشرفة *</label>
                  <input
                    required
                    dir="ltr"
                    value={form.supervisorCode}
                    onChange={(e) => setForm((p) => ({ ...p, supervisorCode: e.target.value }))}
                    placeholder="SUP-101"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5 font-mono text-right"
                  />
                </div>
                <div>
                  <label className="block font-bold text-[#0B1F3A] mb-1">حالة الحساب</label>
                  <select
                    value={form.accountStatus}
                    onChange={(e) => setForm((p) => ({ ...p, accountStatus: e.target.value }))}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5 bg-white"
                  >
                    <option value="active">نشط</option>
                    <option value="inactive">موقوف مؤقتاً</option>
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className="block font-bold text-[#0B1F3A] mb-1">اسم خط السير</label>
                  <input
                    value={form.routeName}
                    onChange={(e) => setForm((p) => ({ ...p, routeName: e.target.value }))}
                    placeholder="مثال: خط سموحة - فيكتوريا"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
                  />
                </div>
                <div>
                  <label className="block font-bold text-[#0B1F3A] mb-1">المدرسة المعينة</label>
                  <input
                    list="sup-mod-schools-list"
                    value={form.schoolName}
                    onChange={(e) => setForm((p) => ({ ...p, schoolName: e.target.value }))}
                    placeholder="اختر أو اكتب اسم المدرسة"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
                  />
                  <datalist id="sup-mod-schools-list">
                    {schoolsList.map((sc) => (
                      <option key={sc.id} value={sc.name} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <label className="block font-bold text-[#0B1F3A] mb-1">رقم الباص المعين</label>
                  <input
                    list="sup-mod-vehicles-list"
                    value={form.busNumber}
                    onChange={(e) => setForm((p) => ({ ...p, busNumber: e.target.value }))}
                    placeholder="مثال: 14"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
                  />
                  <datalist id="sup-mod-vehicles-list">
                    {vehiclesList.map((v) => (
                      <option key={v.id} value={v.busNumber} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <label className="block font-bold text-[#0B1F3A] mb-1">نقطة التجمع / الانطلاق</label>
                  <input
                    value={form.pickupArea}
                    onChange={(e) => setForm((p) => ({ ...p, pickupArea: e.target.value }))}
                    placeholder="نقطة التجمع (اختياري)"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
                  />
                </div>
                <div>
                  <label className="block font-bold text-[#0B1F3A] mb-1">نقطة الوصول</label>
                  <input
                    value={form.dropoffArea}
                    onChange={(e) => setForm((p) => ({ ...p, dropoffArea: e.target.value }))}
                    placeholder="نقطة الوصول (اختياري)"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block font-bold text-[#0B1F3A] mb-1">
                    البريد الإلكتروني (اختياري)
                  </label>
                  <input
                    type="email"
                    dir="ltr"
                    value={form.linkedEmail}
                    onChange={(e) => setForm((p) => ({ ...p, linkedEmail: e.target.value }))}
                    placeholder="supervisor@example.com"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-right font-mono"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block font-bold text-[#0B1F3A] mb-1">ملاحظات</label>
                  <textarea
                    rows={2}
                    value={form.notes}
                    onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2"
                  />
                </div>
              </div>

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="rounded-xl border border-slate-300 px-4 py-2.5 font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-[#0B1F3A] hover:bg-[#13325c] px-5 py-2.5 font-bold text-white disabled:opacity-50 cursor-pointer"
                >
                  {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                  {editingSupervisor ? 'حفظ التعديلات' : 'إنشاء حساب المشرفة'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Supervisor Confirm Modal */}
      {deleteTarget && (
        <div
          onClick={() => setDeleteTarget(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm bg-white rounded-2xl border border-slate-200 p-5 space-y-4 shadow-2xl"
          >
            <h3 className="font-display text-base font-bold text-[#0B1F3A]">حذف حساب المشرفة</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              هل أنت متأكد من حذف حساب المشرفة «{deleteTarget.fullName}» (كود{' '}
              <span className="font-mono font-bold">{deleteTarget.supervisorCode}</span>)؟ لن تتمكن
              من الدخول مجدداً بعد الحذف.
            </p>
            <div className="flex items-center justify-end gap-2 text-xs">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="rounded-xl border border-slate-300 px-4 py-2 font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={handleDelete}
                className="rounded-xl bg-red-600 hover:bg-red-700 px-4 py-2 font-bold text-white disabled:opacity-50 cursor-pointer"
              >
                {busy ? 'جاري الحذف...' : 'تأكيد الحذف'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
