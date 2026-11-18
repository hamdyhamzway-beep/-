import React, { useRef, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  CreditCard,
  Download,
  Eye,
  ImagePlus,
  Loader2,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { useEscapeKey } from '../lib/useEscapeKey';
import type { DriverLicensePhoto } from '../types';

interface DriverLicensesSectionProps {
  photos: DriverLicensePhoto[];
  viewerRole: 'admin' | 'driver';
  readOnly?: boolean;
  /** Form-controlled update (for Add/Edit Driver modal) */
  onChange?: (nextPhotos: DriverLicensePhoto[]) => void;
  /** Immediate persistence callback (for standalone card in Driver App & Admin Driver Workspace) */
  onSavePhotos?: (nextPhotos: DriverLicensePhoto[]) => Promise<void>;
  compact?: boolean;
}

const STANDARD_SLOTS: Array<{ id: string; label: string; hint: string }> = [
  {
    id: 'driver_license_front',
    label: 'رخصة القيادة (الوجه الأمامي)',
    hint: 'صورة واضحة للوجه الأمامي لرخصة القيادة',
  },
  {
    id: 'driver_license_back',
    label: 'رخصة القيادة (الوجه الخلفي)',
    hint: 'صورة واضحة للظهر وتاريخ الانتهاء',
  },
];

const EXTRA_LABEL_PRESETS = [
  'رخصة تسيير المركبة (الوجه)',
  'رخصة تسيير المركبة (الظهر)',
  'بطاقة الرقم القومي',
  'مستند رخصة إضافي',
];

const MAX_DIMENSION = 1200;

async function compressLicenseImage(file: File): Promise<string> {
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

export const DriverLicensesSection: React.FC<DriverLicensesSectionProps> = ({
  photos,
  viewerRole,
  readOnly = false,
  onChange,
  onSavePhotos,
  compact = false,
}) => {
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const pendingTargetRef = useRef<{ slotId: string; label: string } | null>(null);

  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [previewPhoto, setPreviewPhoto] = useState<DriverLicensePhoto | null>(null);
  const [showAddExtra, setShowAddExtra] = useState(false);
  const [extraLabel, setExtraLabel] = useState(EXTRA_LABEL_PRESETS[0]);

  useEscapeKey(Boolean(previewPhoto), () => setPreviewPhoto(null));

  const applyNextPhotos = async (nextPhotos: DriverLicensePhoto[], msg: string) => {
    setErrorMsg(null);
    setStatusMsg(null);
    if (onSavePhotos) {
      setBusy(true);
      try {
        await onSavePhotos(nextPhotos);
        setStatusMsg(msg);
      } catch (err: unknown) {
        setErrorMsg(err instanceof Error ? err.message : 'تعذر حفظ صورة الرخصة');
      } finally {
        setBusy(false);
      }
    } else if (onChange) {
      onChange(nextPhotos);
      setStatusMsg(msg);
    }
  };

  const triggerUpload = (slotId: string, label: string, mode: 'gallery' | 'camera') => {
    pendingTargetRef.current = { slotId, label };
    if (mode === 'camera') {
      cameraInputRef.current?.click();
    } else {
      galleryInputRef.current?.click();
    }
  };

  const handleFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    const target = pendingTargetRef.current;
    pendingTargetRef.current = null;
    if (!file || !target) return;

    setBusy(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const compressedUrl = await compressLicenseImage(file);
      const nextEntry: DriverLicensePhoto = {
        id: target.slotId,
        label: target.label.trim() || 'صورة رخصة',
        imageUrl: compressedUrl,
        uploadedBy: viewerRole,
        uploadedAt: new Date().toISOString(),
      };

      const existingIdx = photos.findIndex((p) => p.id === target.slotId);
      const nextPhotos =
        existingIdx >= 0
          ? photos.map((p, i) => (i === existingIdx ? nextEntry : p))
          : [...photos, nextEntry];

      setShowAddExtra(false);
      await applyNextPhotos(nextPhotos, `تم حفظ «${nextEntry.label}» بنجاح.`);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'تعذر رفع صورة الرخصة');
    } finally {
      setBusy(false);
    }
  };

  const handleDeletePhoto = async (photoId: string, label: string) => {
    const nextPhotos = photos.filter((p) => p.id !== photoId);
    await applyNextPhotos(nextPhotos, `تم حذف «${label}».`);
  };

  const standardIds = new Set(STANDARD_SLOTS.map((s) => s.id));
  const extraPhotos = photos.filter((p) => !standardIds.has(p.id));

  return (
    <div
      className={`rounded-2xl border border-slate-200 bg-white ${
        compact ? 'p-4' : 'p-5'
      } space-y-4`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-[#0B1F3A] text-[#C89B3C] flex items-center justify-center shrink-0">
            <CreditCard className="w-4 h-4" />
          </div>
          <div>
            <h3 className="font-display text-sm sm:text-base font-bold text-[#0B1F3A]">
              صور الرخص والمستندات ({photos.length})
            </h3>
            <p className="text-[11px] text-slate-500">
              {viewerRole === 'driver'
                ? 'يمكنك رفع أو تصوير رخصة القيادة ورخصة المركبة لتظهر فوراً للإدارة'
                : 'متاح للإدارة وللسائق رفع وتحديث صور الرخص ومشاهدتها بدقة كاملة'}
            </p>
          </div>
        </div>

        {!readOnly && (
          <button
            type="button"
            disabled={busy || photos.length >= 10}
            onClick={() => setShowAddExtra((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[#C89B3C]/60 bg-amber-50/70 hover:bg-amber-100/80 px-3 py-2 text-xs font-bold text-[#0B1F3A] disabled:opacity-50 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5 text-[#C89B3C]" />
            إضافة صورة رخصة أخرى
          </button>
        )}
      </div>

      {errorMsg && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700">
          {errorMsg}
        </div>
      )}

      {statusMsg && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-xs text-emerald-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{statusMsg}</span>
        </div>
      )}

      {/* Extra License Photo Drawer */}
      {showAddExtra && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold text-[#0B1F3A]">
              اختر نوع الرخصة أو اكتب اسماً مخصصاً:
            </span>
            <button
              type="button"
              onClick={() => setShowAddExtra(false)}
              className="text-slate-400 hover:text-slate-700 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {EXTRA_LABEL_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setExtraLabel(preset)}
                className={`rounded-lg px-2.5 py-1.5 text-[11px] font-semibold border cursor-pointer transition-colors ${
                  extraLabel === preset
                    ? 'bg-[#0B1F3A] text-white border-[#0B1F3A]'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                {preset}
              </button>
            ))}
          </div>

          <input
            type="text"
            value={extraLabel}
            onChange={(e) => setExtraLabel(e.target.value)}
            placeholder="مثال: رخصة القيادة المهنية — درجة أولى"
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-[#0B1F3A] focus:outline-none"
          />

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                triggerUpload(`extra_${Date.now()}`, extraLabel || 'صورة رخصة إضافية', 'gallery')
              }
              className="inline-flex items-center gap-1.5 rounded-xl bg-[#0B1F3A] hover:bg-[#13325c] px-4 py-2 text-xs font-bold text-white disabled:opacity-50 cursor-pointer"
            >
              {busy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[#C89B3C]" />
              ) : (
                <ImagePlus className="w-3.5 h-3.5 text-[#C89B3C]" />
              )}
              اختيار صورة من الجهاز
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                triggerUpload(`extra_${Date.now()}`, extraLabel || 'صورة رخصة إضافية', 'camera')
              }
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 px-4 py-2 text-xs font-semibold text-[#0B1F3A] disabled:opacity-50 cursor-pointer"
            >
              <Camera className="w-3.5 h-3.5 text-[#C89B3C]" />
              تصوير بالكاميرا
            </button>
          </div>
        </div>
      )}

      {/* Standard Front & Back License Slots + Uploaded Extra Licenses */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
        {STANDARD_SLOTS.map((slot) => {
          const existing = photos.find((p) => p.id === slot.id);
          return (
            <div
              key={slot.id}
              className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 flex flex-col justify-between gap-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-bold text-[#0B1F3A]">{slot.label}</p>
                  <p className="text-[11px] text-slate-500 mt-0.5">{slot.hint}</p>
                </div>
                {existing && (
                  <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800 shrink-0">
                    {existing.uploadedBy === 'driver' ? 'رفع السائق' : 'رفع الإدارة'}
                  </span>
                )}
              </div>

              {existing ? (
                <div className="space-y-2.5">
                  <button
                    type="button"
                    onClick={() => setPreviewPhoto(existing)}
                    className="group relative w-full h-36 rounded-xl overflow-hidden border border-slate-200 bg-slate-900 cursor-pointer block"
                  >
                    <img
                      src={existing.imageUrl}
                      alt={existing.label}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                    />
                    <div className="absolute inset-0 bg-slate-950/35 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <span className="inline-flex items-center gap-1 rounded-lg bg-white/95 px-3 py-1.5 text-[11px] font-bold text-[#0B1F3A]">
                        <Eye className="w-3.5 h-3.5" />
                        تكبير الصورة
                      </span>
                    </div>
                  </button>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setPreviewPhoto(existing)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 cursor-pointer"
                    >
                      <Eye className="w-3.5 h-3.5 text-[#0B1F3A]" />
                      عرض
                    </button>
                    {!readOnly && (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => triggerUpload(slot.id, slot.label, 'gallery')}
                          className="inline-flex items-center gap-1 rounded-lg bg-[#0B1F3A] hover:bg-[#13325c] px-2.5 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50 cursor-pointer"
                        >
                          <ImagePlus className="w-3.5 h-3.5 text-[#C89B3C]" />
                          تغيير
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => triggerUpload(slot.id, slot.label, 'camera')}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 disabled:opacity-50 cursor-pointer"
                        >
                          <Camera className="w-3.5 h-3.5" />
                          كاميرا
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleDeletePhoto(existing.id, existing.label)}
                          className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 hover:bg-red-100 px-2.5 py-1.5 text-[11px] font-semibold text-red-700 disabled:opacity-50 cursor-pointer mr-auto"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          حذف
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-slate-300 bg-white p-4 flex flex-col items-center justify-center gap-2.5 text-center min-h-[136px]">
                  <p className="text-[11px] text-slate-500">لم يتم رفع صورة بعد</p>
                  {!readOnly && (
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => triggerUpload(slot.id, slot.label, 'gallery')}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[#0B1F3A] hover:bg-[#13325c] px-3 py-2 text-[11px] font-bold text-white disabled:opacity-50 cursor-pointer"
                      >
                        <ImagePlus className="w-3.5 h-3.5 text-[#C89B3C]" />
                        رفع من الجهاز
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => triggerUpload(slot.id, slot.label, 'camera')}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 px-3 py-2 text-[11px] font-semibold text-[#0B1F3A] disabled:opacity-50 cursor-pointer"
                      >
                        <Camera className="w-3.5 h-3.5 text-[#C89B3C]" />
                        تصوير
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {extraPhotos.map((photo) => (
          <div
            key={photo.id}
            className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 flex flex-col justify-between gap-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-bold text-[#0B1F3A] truncate">{photo.label}</p>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {new Date(photo.uploadedAt).toLocaleDateString('ar-EG')}
                </p>
              </div>
              <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800 shrink-0">
                {photo.uploadedBy === 'driver' ? 'رفع السائق' : 'رفع الإدارة'}
              </span>
            </div>

            <button
              type="button"
              onClick={() => setPreviewPhoto(photo)}
              className="group relative w-full h-36 rounded-xl overflow-hidden border border-slate-200 bg-slate-900 cursor-pointer block"
            >
              <img
                src={photo.imageUrl}
                alt={photo.label}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover group-hover:scale-105 transition-transform"
              />
              <div className="absolute inset-0 bg-slate-950/35 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <span className="inline-flex items-center gap-1 rounded-lg bg-white/95 px-3 py-1.5 text-[11px] font-bold text-[#0B1F3A]">
                  <Eye className="w-3.5 h-3.5" />
                  تكبير الصورة
                </span>
              </div>
            </button>

            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPreviewPhoto(photo)}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 cursor-pointer"
              >
                <Eye className="w-3.5 h-3.5 text-[#0B1F3A]" />
                عرض
              </button>
              {!readOnly && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => triggerUpload(photo.id, photo.label, 'gallery')}
                    className="inline-flex items-center gap-1 rounded-lg bg-[#0B1F3A] hover:bg-[#13325c] px-2.5 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50 cursor-pointer"
                  >
                    <ImagePlus className="w-3.5 h-3.5 text-[#C89B3C]" />
                    تغيير
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleDeletePhoto(photo.id, photo.label)}
                    className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 hover:bg-red-100 px-2.5 py-1.5 text-[11px] font-semibold text-red-700 disabled:opacity-50 cursor-pointer mr-auto"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    حذف
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Hidden File Inputs */}
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*"
        onChange={handleFilePicked}
        className="hidden"
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFilePicked}
        className="hidden"
      />

      {/* Lightbox Fullscreen Preview Modal */}
      {previewPhoto && (
        <div
          onClick={() => setPreviewPhoto(null)}
          className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-xs"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-2xl rounded-2xl border border-white/15 bg-[#0B1F3A] text-white shadow-2xl overflow-hidden"
          >
            <div className="px-5 py-3.5 border-b border-white/10 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h4 className="font-display text-sm font-bold truncate">{previewPhoto.label}</h4>
                <p className="text-[11px] text-slate-300">
                  {previewPhoto.uploadedBy === 'driver' ? 'مرفوعة من السائق' : 'مرفوعة من الإدارة'} ·{' '}
                  {new Date(previewPhoto.uploadedAt).toLocaleString('ar-EG')}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <a
                  href={previewPhoto.imageUrl}
                  download={`${previewPhoto.label}.jpg`}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#C89B3C] px-3 py-1.5 text-xs font-bold text-[#0B1F3A] hover:bg-[#d8ac4e]"
                >
                  <Download className="w-3.5 h-3.5" />
                  تنزيل
                </a>
                <button
                  type="button"
                  onClick={() => setPreviewPhoto(null)}
                  className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="p-4 bg-slate-950 flex items-center justify-center">
              <img
                src={previewPhoto.imageUrl}
                alt={previewPhoto.label}
                referrerPolicy="no-referrer"
                className="max-w-full max-h-[75vh] object-contain rounded-lg"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
