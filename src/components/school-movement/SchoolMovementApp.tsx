import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  BarChart3,
  Camera,
  CheckCircle2,
  ClipboardList,
  Clock,
  ImagePlus,
  Loader2,
  LogOut,
  MessageSquarePlus,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch, getLocalTodayDateString } from '../../lib/api';
import { useEscapeKey } from '../../lib/useEscapeKey';
import { BrandLogo } from '../BrandLogo';
import type {
  SchoolMonthlyReportSummary,
  SchoolMovementRouteOption,
  SchoolNoteCategory,
  SchoolNoteItem,
  SchoolNoteType,
} from '../../types';

type ScreenView = 'home' | 'create' | 'my_notes' | 'report';

const CATEGORY_OPTIONS: Array<{ value: SchoolNoteCategory; label: string }> = [
  { value: 'delay', label: 'تأخير' },
  { value: 'cleanliness', label: 'نظافة' },
  { value: 'behavior', label: 'تعامل' },
  { value: 'safety', label: 'أمان' },
];

const CATEGORY_LABELS: Record<string, string> = {
  delay: 'تأخير',
  cleanliness: 'نظافة',
  behavior: 'تعامل',
  safety: 'أمان',
};

const MAX_DIMENSION = 1200;

async function compressNotePhoto(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('يرجى اختيار ملف صورة صالح (JPG أو PNG أو WebP)');
  }

  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = typeof reader.result === 'string' ? reader.result : '';
      if (!res) reject(new Error('تعذر قراءة ملف الصورة'));
      else resolve(res);
    };
    reader.onerror = () => reject(new Error('تعذر قراءة ملف الصورة'));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('تعذر تحميل الصورة المختارة'));
    el.src = rawDataUrl;
  });

  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  const scale = Math.min(1, MAX_DIMENSION / Math.max(srcW, srcH));
  const targetW = Math.max(1, Math.round(srcW * scale));
  const targetH = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('المتصفح لا يدعم معالجة الصور');
  }

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, targetW, targetH);
  ctx.drawImage(img, 0, 0, targetW, targetH);
  return canvas.toDataURL('image/jpeg', 0.82);
}

export const SchoolMovementApp: React.FC = () => {
  const { dbUser, logout } = useAuth();
  const todayCairo = getLocalTodayDateString();
  const currentMonthCairo = todayCairo.slice(0, 7);

  const [view, setView] = useState<ScreenView>('home');
  const [homeSuccessMsg, setHomeSuccessMsg] = useState<string | null>(null);

  // School & Routes (strictly user's school)
  const [schoolName, setSchoolName] = useState<string>(
    dbUser?.assignedSchoolNames?.[0] || 'مدرستي'
  );
  const [routes, setRoutes] = useState<SchoolMovementRouteOption[]>([]);
  const [routesLoading, setRoutesLoading] = useState(false);

  // Create Note Form
  const [tripDate, setTripDate] = useState<string>(todayCairo);
  const [selectedRouteId, setSelectedRouteId] = useState<string>('');
  const [noteType, setNoteType] = useState<SchoolNoteType>('positive');
  const [category, setCategory] = useState<SchoolNoteCategory>('delay');
  const [body, setBody] = useState<string>('');
  const [photoUrl, setPhotoUrl] = useState<string>('');
  const [photoBusy, setPhotoBusy] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // My Notes
  const [myNotes, setMyNotes] = useState<SchoolNoteItem[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [zoomPhotoUrl, setZoomPhotoUrl] = useState<string | null>(null);

  // Monthly Report
  const [reportMonth, setReportMonth] = useState<string>(currentMonthCairo);
  const [report, setReport] = useState<SchoolMonthlyReportSummary | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  useEscapeKey(Boolean(zoomPhotoUrl), () => setZoomPhotoUrl(null));

  const loadRoutes = useCallback(async () => {
    setRoutesLoading(true);
    try {
      const res = await apiFetch<{
        school: { id: number; name: string };
        routes: SchoolMovementRouteOption[];
      }>('/api/school-movement/routes');
      if (res.school?.name) setSchoolName(res.school.name);
      setRoutes(res.routes || []);
    } catch {
      // handled gracefully in UI
    } finally {
      setRoutesLoading(false);
    }
  }, []);

  const loadMyNotes = useCallback(async () => {
    setNotesLoading(true);
    setNotesError(null);
    try {
      const res = await apiFetch<{ notes: SchoolNoteItem[] }>('/api/school-notes');
      setMyNotes(res.notes || []);
    } catch (err: unknown) {
      setNotesError(err instanceof Error ? err.message : 'تعذر تحميل ملاحظاتك');
    } finally {
      setNotesLoading(false);
    }
  }, []);

  const loadMonthlyReport = useCallback(async (monthStr: string) => {
    setReportLoading(true);
    setReportError(null);
    try {
      const res = await apiFetch<{ report: SchoolMonthlyReportSummary }>(
        `/api/school-notes/monthly-report?month=${encodeURIComponent(monthStr)}`
      );
      setReport(res.report);
      if (res.report?.schoolName) setSchoolName(res.report.schoolName);
    } catch (err: unknown) {
      setReportError(err instanceof Error ? err.message : 'تعذر تحميل التقرير الشهري');
    } finally {
      setReportLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRoutes();
  }, [loadRoutes]);

  const openCreateScreen = () => {
    setHomeSuccessMsg(null);
    setFormError(null);
    setTripDate(getLocalTodayDateString());
    setSelectedRouteId('');
    setNoteType('positive');
    setCategory('delay');
    setBody('');
    setPhotoUrl('');
    setView('create');
    if (routes.length === 0) loadRoutes();
  };

  const openMyNotesScreen = () => {
    setHomeSuccessMsg(null);
    setView('my_notes');
    loadMyNotes();
  };

  const openReportScreen = () => {
    setHomeSuccessMsg(null);
    setView('report');
    loadMonthlyReport(reportMonth);
  };

  const selectedRouteObj = routes.find((r) => String(r.id) === selectedRouteId) || null;

  const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setPhotoBusy(true);
    setFormError(null);
    try {
      const compressed = await compressNotePhoto(file);
      setPhotoUrl(compressed);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'تعذر تجهيز الصورة');
    } finally {
      setPhotoBusy(false);
    }
  };

  const handleSubmitNote = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const todayNow = getLocalTodayDateString();
    if (!tripDate || tripDate > todayNow) {
      setFormError('لا يمكن اختيار تاريخ مستقبلي');
      return;
    }
    const cleanBody = body.trim();
    if (!cleanBody) {
      setFormError('اكتب الملاحظة باختصار قبل التسجيل');
      return;
    }
    if (cleanBody.length > 500) {
      setFormError('الملاحظة بحد أقصى 500 حرف');
      return;
    }

    setSubmitBusy(true);
    try {
      await apiFetch('/api/school-notes', {
        method: 'POST',
        body: JSON.stringify({
          tripDate,
          routeId: selectedRouteId ? Number(selectedRouteId) : null,
          noteType,
          category,
          body: cleanBody,
          photoUrl,
        }),
      });
      setHomeSuccessMsg('اتسجلت، شكرا');
      setView('home');
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'تعذر تسجيل الملاحظة');
    } finally {
      setSubmitBusy(false);
    }
  };

  return (
    <div dir="rtl" className="min-h-screen bg-[#eef2f7] flex flex-col">
      {/* Minimal Header */}
      <header className="sticky top-0 z-20 bg-[#0B1F3A] text-white border-b border-white/10 px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <BrandLogo size="sm" />
          <div className="min-w-0">
            <div className="font-display text-sm sm:text-base font-bold truncate">
              {schoolName}
            </div>
            <div className="text-[11px] text-[#C89B3C] truncate">
              مدير حركة المدرسة · {dbUser?.fullName}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={logout}
          className="inline-flex items-center gap-1.5 rounded-xl bg-white/10 hover:bg-red-500/20 px-3 py-2 text-xs font-semibold text-white cursor-pointer shrink-0"
        >
          <LogOut className="w-4 h-4" />
          <span>خروج</span>
        </button>
      </header>

      <main className="flex-1 w-full max-w-2xl mx-auto p-4 sm:p-6">
        {/* HOME: 3 Big Buttons Only */}
        {view === 'home' && (
          <div className="space-y-5 pt-2">
            {homeSuccessMsg && (
              <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 flex items-center gap-3 text-emerald-900 shadow-sm">
                <CheckCircle2 className="w-6 h-6 text-emerald-600 shrink-0" />
                <div className="font-display text-base font-bold">{homeSuccessMsg}</div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-4">
              <button
                type="button"
                onClick={openCreateScreen}
                className="w-full rounded-2xl bg-[#0B1F3A] hover:bg-[#13325c] text-white p-6 sm:p-7 flex items-center justify-between gap-4 shadow-md transition-colors cursor-pointer text-right"
              >
                <div className="flex items-center gap-4">
                  <div className="w-14 h-14 rounded-2xl bg-[#C89B3C] text-[#0B1F3A] flex items-center justify-center shrink-0">
                    <MessageSquarePlus className="w-7 h-7" />
                  </div>
                  <div>
                    <div className="font-display text-xl font-bold">سجّل ملاحظة</div>
                    <div className="text-xs text-slate-300 mt-1">
                      تسجيل ملاحظة إيجابية أو سلبية على خط السير
                    </div>
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={openMyNotesScreen}
                className="w-full rounded-2xl bg-white hover:bg-slate-50 border border-slate-200 text-[#0B1F3A] p-6 sm:p-7 flex items-center justify-between gap-4 shadow-sm transition-colors cursor-pointer text-right"
              >
                <div className="flex items-center gap-4">
                  <div className="w-14 h-14 rounded-2xl bg-[#0B1F3A]/10 text-[#0B1F3A] flex items-center justify-center shrink-0">
                    <ClipboardList className="w-7 h-7" />
                  </div>
                  <div>
                    <div className="font-display text-xl font-bold">ملاحظاتي</div>
                    <div className="text-xs text-slate-500 mt-1">
                      متابعة الملاحظات اللي سجلتها وردود الإدارة
                    </div>
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={openReportScreen}
                className="w-full rounded-2xl bg-white hover:bg-slate-50 border border-slate-200 text-[#0B1F3A] p-6 sm:p-7 flex items-center justify-between gap-4 shadow-sm transition-colors cursor-pointer text-right"
              >
                <div className="flex items-center gap-4">
                  <div className="w-14 h-14 rounded-2xl bg-[#C89B3C]/20 text-[#0B1F3A] flex items-center justify-center shrink-0">
                    <BarChart3 className="w-7 h-7 text-[#C89B3C]" />
                  </div>
                  <div>
                    <div className="font-display text-xl font-bold">التقرير الشهري</div>
                    <div className="text-xs text-slate-500 mt-1">
                      ملخص الملاحظات ونسبة الالتزام بالمواعيد لمدرستك
                    </div>
                  </div>
                </div>
              </button>
            </div>
          </div>
        )}

        {/* CREATE NOTE SCREEN */}
        {view === 'create' && (
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => setView('home')}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 px-4 py-2 text-xs font-bold text-[#0B1F3A] cursor-pointer"
            >
              <ArrowRight className="w-4 h-4 text-[#C89B3C]" />
              رجوع للرئيسية
            </button>

            <form
              onSubmit={handleSubmitNote}
              className="rounded-2xl bg-white border border-slate-200 p-5 sm:p-6 space-y-5 shadow-sm"
            >
              <h1 className="font-display text-lg font-bold text-[#0B1F3A]">سجّل ملاحظة</h1>

              {formError && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-semibold text-red-800">
                  {formError}
                </div>
              )}

              {/* 1. التاريخ */}
              <div>
                <label className="block text-xs font-bold text-[#0B1F3A] mb-1.5">التاريخ</label>
                <input
                  type="date"
                  required
                  max={todayCairo}
                  value={tripDate}
                  onChange={(e) => setTripDate(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-[#0B1F3A] font-mono focus:border-[#0B1F3A] focus:bg-white focus:outline-none"
                />
              </div>

              {/* 2. الخط */}
              <div>
                <label className="block text-xs font-bold text-[#0B1F3A] mb-1.5">الخط</label>
                <select
                  value={selectedRouteId}
                  onChange={(e) => setSelectedRouteId(e.target.value)}
                  disabled={routesLoading}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-[#0B1F3A] focus:border-[#0B1F3A] focus:bg-white focus:outline-none"
                >
                  <option value="">— اختر الخط (اختياري) —</option>
                  {routes.map((r) => (
                    <option key={r.id} value={String(r.id)}>
                      {r.name}
                      {r.busNumber ? ` — باص ${r.busNumber}` : ''}
                      {r.currentDriverName ? ` — السائق: ${r.currentDriverName}` : ' — بدون سائق معيّن'}
                    </option>
                  ))}
                </select>
                {selectedRouteObj && (
                  <div className="mt-2 rounded-xl bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-700">
                    مربوط تلقائياً بـ: <strong className="text-[#0B1F3A]">{selectedRouteObj.name}</strong>
                    {selectedRouteObj.busNumber ? (
                      <>
                        {' · '}
                        <strong className="font-mono text-[#0B1F3A]">
                          باص {selectedRouteObj.busNumber}
                        </strong>
                      </>
                    ) : null}
                    {' · '}السائق:{' '}
                    <strong className="text-[#0B1F3A]">
                      {selectedRouteObj.currentDriverName || 'غير معيّن'}
                    </strong>
                    {' · '}التاريخ: <strong className="font-mono">{tripDate}</strong>
                  </div>
                )}
              </div>

              {/* 3. نوع الملاحظة */}
              <div>
                <label className="block text-xs font-bold text-[#0B1F3A] mb-1.5">نوع الملاحظة</label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setNoteType('positive')}
                    className={`rounded-xl border-2 py-3.5 px-4 text-sm font-bold cursor-pointer transition-colors ${
                      noteType === 'positive'
                        ? 'border-emerald-600 bg-emerald-600 text-white'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-emerald-50'
                    }`}
                  >
                    إيجابية
                  </button>
                  <button
                    type="button"
                    onClick={() => setNoteType('negative')}
                    className={`rounded-xl border-2 py-3.5 px-4 text-sm font-bold cursor-pointer transition-colors ${
                      noteType === 'negative'
                        ? 'border-red-600 bg-red-600 text-white'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-red-50'
                    }`}
                  >
                    سلبية
                  </button>
                </div>
              </div>

              {/* 4. التصنيف */}
              <div>
                <label className="block text-xs font-bold text-[#0B1F3A] mb-1.5">التصنيف</label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  {CATEGORY_OPTIONS.map((cat) => {
                    const active = category === cat.value;
                    return (
                      <button
                        key={cat.value}
                        type="button"
                        onClick={() => setCategory(cat.value)}
                        className={`rounded-xl border py-3 px-3 text-xs font-bold cursor-pointer transition-colors ${
                          active
                            ? 'border-[#0B1F3A] bg-[#0B1F3A] text-white'
                            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        {cat.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 5. النص */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-bold text-[#0B1F3A]">النص</label>
                  <span className="text-[11px] font-mono text-slate-400">
                    {body.length} / 500
                  </span>
                </div>
                <textarea
                  required
                  rows={4}
                  maxLength={500}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="اكتب الملاحظة باختصار"
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-[#0B1F3A] focus:border-[#0B1F3A] focus:bg-white focus:outline-none"
                />
              </div>

              {/* 6. صورة اختيارية */}
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handlePhotoChange}
                  className="hidden"
                />
                {photoUrl ? (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2.5">
                    <img
                      src={photoUrl}
                      alt="معاينة الصورة"
                      className="w-full max-h-56 object-contain rounded-lg bg-white border border-slate-200"
                    />
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={photoBusy}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-[#0B1F3A] cursor-pointer"
                      >
                        <Camera className="w-3.5 h-3.5 text-[#C89B3C]" />
                        تغيير الصورة
                      </button>
                      <button
                        type="button"
                        onClick={() => setPhotoUrl('')}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        حذف الصورة
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={photoBusy}
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 hover:bg-slate-100 px-4 py-2.5 text-xs font-bold text-[#0B1F3A] cursor-pointer"
                  >
                    {photoBusy ? (
                      <Loader2 className="w-4 h-4 animate-spin text-[#C89B3C]" />
                    ) : (
                      <ImagePlus className="w-4 h-4 text-[#C89B3C]" />
                    )}
                    أضف صورة
                  </button>
                )}
              </div>

              {/* 7. زرار واحد: سجّل */}
              <button
                type="submit"
                disabled={submitBusy || photoBusy}
                className="w-full rounded-xl bg-[#0B1F3A] hover:bg-[#13325c] text-white py-3.5 text-sm font-bold disabled:opacity-50 cursor-pointer"
              >
                {submitBusy ? 'جاري التسجيل...' : 'سجّل'}
              </button>
            </form>
          </div>
        )}

        {/* MY NOTES SCREEN */}
        {view === 'my_notes' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setView('home')}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 px-4 py-2 text-xs font-bold text-[#0B1F3A] cursor-pointer"
              >
                <ArrowRight className="w-4 h-4 text-[#C89B3C]" />
                رجوع للرئيسية
              </button>
              <h1 className="font-display text-base font-bold text-[#0B1F3A]">ملاحظاتي</h1>
            </div>

            {notesError && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                {notesError}
              </div>
            )}

            {notesLoading ? (
              <div className="rounded-2xl bg-white border border-slate-200 p-10 text-center text-xs text-slate-400">
                جاري تحميل ملاحظاتك...
              </div>
            ) : myNotes.length === 0 ? (
              <div className="rounded-2xl bg-white border border-slate-200 p-10 text-center text-xs text-slate-500">
                مفيش ملاحظات متسجلة لسه.
              </div>
            ) : (
              <div className="space-y-3">
                {myNotes.map((note) => {
                  const isPositive = note.noteType === 'positive';
                  const isClosed = note.status === 'closed';
                  return (
                    <div
                      key={note.id}
                      className="rounded-2xl bg-white border border-slate-200 p-4 space-y-3 shadow-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`rounded-lg px-2.5 py-1 text-xs font-bold ${
                              isPositive
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-red-100 text-red-800'
                            }`}
                          >
                            {isPositive ? 'إيجابية' : 'سلبية'}
                          </span>
                          <span className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                            {CATEGORY_LABELS[note.category] || note.category}
                          </span>
                          <span
                            className={`rounded-lg px-2.5 py-1 text-xs font-bold ${
                              isClosed
                                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                : 'bg-amber-50 text-amber-800 border border-amber-200'
                            }`}
                          >
                            {isClosed ? 'اتقفلت' : 'مفتوحة'}
                          </span>
                        </div>
                        <span className="text-xs font-mono text-slate-500">{note.tripDate}</span>
                      </div>

                      {(note.routeName || note.driverName) && (
                        <div className="text-xs text-slate-600">
                          {note.routeName && (
                            <span>
                              الخط: <strong className="text-[#0B1F3A]">{note.routeName}</strong>
                            </span>
                          )}
                          {note.routeName && note.driverName && ' · '}
                          {note.driverName && (
                            <span>
                              السائق: <strong className="text-[#0B1F3A]">{note.driverName}</strong>
                            </span>
                          )}
                        </div>
                      )}

                      <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
                        {note.body}
                      </p>

                      {note.photoUrl && (
                        <button
                          type="button"
                          onClick={() => setZoomPhotoUrl(note.photoUrl)}
                          className="block rounded-xl overflow-hidden border border-slate-200 cursor-pointer"
                        >
                          <img
                            src={note.photoUrl}
                            alt="صورة الملاحظة"
                            className="max-h-48 object-cover"
                          />
                        </button>
                      )}

                      {(note.adminReply || note.resolution) && (
                        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-1.5 text-xs">
                          {note.adminReply && (
                            <div>
                              <span className="font-bold text-[#0B1F3A]">رد الإدارة: </span>
                              <span className="text-slate-700">{note.adminReply}</span>
                            </div>
                          )}
                          {note.resolution && (
                            <div>
                              <span className="font-bold text-emerald-800">الحل: </span>
                              <span className="text-slate-700">{note.resolution}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* MONTHLY REPORT SCREEN */}
        {view === 'report' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setView('home')}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 px-4 py-2 text-xs font-bold text-[#0B1F3A] cursor-pointer"
              >
                <ArrowRight className="w-4 h-4 text-[#C89B3C]" />
                رجوع للرئيسية
              </button>

              <div className="flex items-center gap-2">
                <label className="text-xs font-bold text-[#0B1F3A]">الشهر:</label>
                <input
                  type="month"
                  max={currentMonthCairo}
                  value={reportMonth}
                  onChange={(e) => {
                    const nextMonth = e.target.value;
                    setReportMonth(nextMonth);
                    if (nextMonth) loadMonthlyReport(nextMonth);
                  }}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-mono text-[#0B1F3A]"
                />
              </div>
            </div>

            {reportError && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                {reportError}
              </div>
            )}

            {reportLoading ? (
              <div className="rounded-2xl bg-white border border-slate-200 p-10 text-center text-xs text-slate-400">
                جاري حساب التقرير الشهري...
              </div>
            ) : report ? (
              <div className="space-y-4">
                <div className="rounded-2xl bg-white border border-slate-200 p-5 space-y-4 shadow-sm">
                  <div>
                    <h1 className="font-display text-lg font-bold text-[#0B1F3A]">
                      التقرير الشهري — {report.schoolName}
                    </h1>
                    <p className="text-xs text-slate-500 mt-0.5 font-mono">{report.month}</p>
                  </div>

                  {/* Positive vs Negative */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-center">
                      <div className="text-xs font-bold text-emerald-800">ملاحظات إيجابية</div>
                      <div className="font-display text-3xl font-bold text-emerald-700 mt-1 tabular-nums">
                        {report.positiveCount}
                      </div>
                    </div>
                    <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-center">
                      <div className="text-xs font-bold text-red-800">ملاحظات سلبية</div>
                      <div className="font-display text-3xl font-bold text-red-700 mt-1 tabular-nums">
                        {report.negativeCount}
                      </div>
                    </div>
                  </div>

                  {/* Category Breakdown */}
                  <div className="space-y-2">
                    <div className="text-xs font-bold text-[#0B1F3A]">توزيع التصنيفات</div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-center">
                        <div className="text-xs text-slate-600 font-semibold">تأخير</div>
                        <div className="font-display text-xl font-bold text-[#0B1F3A] mt-0.5 tabular-nums">
                          {report.categories.delay}
                        </div>
                      </div>
                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-center">
                        <div className="text-xs text-slate-600 font-semibold">نظافة</div>
                        <div className="font-display text-xl font-bold text-[#0B1F3A] mt-0.5 tabular-nums">
                          {report.categories.cleanliness}
                        </div>
                      </div>
                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-center">
                        <div className="text-xs text-slate-600 font-semibold">تعامل</div>
                        <div className="font-display text-xl font-bold text-[#0B1F3A] mt-0.5 tabular-nums">
                          {report.categories.behavior}
                        </div>
                      </div>
                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-center">
                        <div className="text-xs text-slate-600 font-semibold">أمان</div>
                        <div className="font-display text-xl font-bold text-[#0B1F3A] mt-0.5 tabular-nums">
                          {report.categories.safety}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Punctuality */}
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-1.5">
                    <div className="flex items-center gap-2 text-xs font-bold text-[#0B1F3A]">
                      <Clock className="w-4 h-4 text-[#C89B3C]" />
                      <span>نسبة الالتزام بالمواعيد</span>
                    </div>
                    <div className="font-display text-lg font-bold text-[#0B1F3A]">
                      {report.punctuality.summaryText}
                    </div>
                  </div>

                  {/* Exact Required Line */}
                  <div className="rounded-xl border border-[#C89B3C]/50 bg-amber-50/70 p-4 flex items-center gap-2.5 text-sm font-bold text-[#0B1F3A]">
                    <ShieldAlert className="w-4 h-4 text-[#C89B3C] shrink-0" />
                    <span>
                      شكاوى اتقفلت بحل: {report.complaintsClosedCount}، مقابل مفتوحة:{' '}
                      {report.complaintsOpenCount}
                    </span>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </main>

      {/* Photo Lightbox */}
      {zoomPhotoUrl && (
        <div
          onClick={() => setZoomPhotoUrl(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative max-w-2xl w-full rounded-2xl bg-[#0B1F3A] p-3"
          >
            <button
              type="button"
              onClick={() => setZoomPhotoUrl(null)}
              className="absolute top-3 left-3 p-2 rounded-lg bg-white/15 text-white hover:bg-white/25 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
            <img
              src={zoomPhotoUrl}
              alt="صورة الملاحظة"
              className="max-h-[80vh] w-full object-contain rounded-xl"
            />
          </div>
        </div>
      )}
    </div>
  );
};
