import React, { useEffect, useRef, useState } from 'react';
import {
  Building2,
  Check,
  ImagePlus,
  Palette,
  RotateCcw,
  SlidersHorizontal,
  Type,
  Upload,
} from 'lucide-react';
import {
  APP_FONT_OPTIONS,
  type AppFontChoice,
  useBranding,
} from '../../contexts/BrandingContext';
import {
  DEFAULT_MARGIN_RATING_THRESHOLDS,
  getMarginRating,
  loadMarginRatingThresholds,
  RATING_THRESHOLDS_EVENT,
  REPORT_RATING_STORAGE_KEY,
  resetMarginRatingThresholds,
  saveMarginRatingThresholds,
  validateMarginRatingThresholds,
} from '../../lib/profit-rating';
import { BrandLogo } from '../BrandLogo';

async function prepareLogoDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('يرجى اختيار ملف صورة صالح (PNG / JPG / SVG / WebP).');
  }
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('تعذر قراءة ملف الصورة.'));
    reader.readAsDataURL(file);
  });

  // Small files (< 220KB) or SVG can be stored directly without raster re-encoding
  if (file.size <= 220 * 1024 || file.type === 'image/svg+xml') {
    return rawDataUrl;
  }

  // Resize large photos to <= 512x512 to stay comfortably within localStorage limits
  return new Promise<string>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 512;
      const scale = Math.min(1, maxDim / Math.max(img.width || maxDim, img.height || maxDim));
      const targetW = Math.max(1, Math.round(img.width * scale));
      const targetH = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(rawDataUrl);
        return;
      }
      ctx.drawImage(img, 0, 0, targetW, targetH);
      resolve(canvas.toDataURL('image/png', 0.9));
    };
    img.onerror = () => resolve(rawDataUrl);
    img.src = rawDataUrl;
  });
}

export const BrandingSettingsSection: React.FC = () => {
  const { branding, updateBranding, resetLogo, resetAllBranding } = useBranding();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [savedThresholds, setSavedThresholds] = useState(() => loadMarginRatingThresholds());
  const [thresholdDrafts, setThresholdDrafts] = useState(() => {
    const initial = loadMarginRatingThresholds();
    return {
      veryWeakMax: String(initial.veryWeakMax),
      weakMax: String(initial.weakMax),
      goodMax: String(initial.goodMax),
    };
  });
  const [ratingError, setRatingError] = useState<string | null>(null);
  const [ratingSavedNotice, setRatingSavedNotice] = useState<string | null>(null);

  useEffect(() => {
    const syncFromStorage = () => {
      const latest = loadMarginRatingThresholds();
      setSavedThresholds(latest);
      setThresholdDrafts({
        veryWeakMax: String(latest.veryWeakMax),
        weakMax: String(latest.weakMax),
        goodMax: String(latest.goodMax),
      });
      setRatingError(null);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === REPORT_RATING_STORAGE_KEY) {
        syncFromStorage();
      }
    };
    window.addEventListener(RATING_THRESHOLDS_EVENT, syncFromStorage);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(RATING_THRESHOLDS_EVENT, syncFromStorage);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const handleThresholdDraftChange = (
    field: 'veryWeakMax' | 'weakMax' | 'goodMax',
    rawValue: string
  ) => {
    const nextDrafts = { ...thresholdDrafts, [field]: rawValue };
    setThresholdDrafts(nextDrafts);
    setRatingSavedNotice(null);

    if (
      nextDrafts.veryWeakMax.trim() === '' ||
      nextDrafts.weakMax.trim() === '' ||
      nextDrafts.goodMax.trim() === ''
    ) {
      setRatingError('من فضلك أدخل القيم الثلاث كاملة ليتم حفظ الحدود.');
      return;
    }

    const candidate = {
      veryWeakMax: Number(nextDrafts.veryWeakMax),
      weakMax: Number(nextDrafts.weakMax),
      goodMax: Number(nextDrafts.goodMax),
    };
    const validation = validateMarginRatingThresholds(candidate);
    if (!validation.valid) {
      setRatingError(validation.error);
      return;
    }

    const res = saveMarginRatingThresholds(candidate);
    if (res.ok) {
      setSavedThresholds(res.thresholds);
      setRatingError(null);
      setRatingSavedNotice('تم حفظ حدود التقييم وتطبيقها فوراً على شاشة التقارير');
    } else {
      setRatingError(res.error);
    }
  };

  const handleResetRatingThresholds = () => {
    const defaults = resetMarginRatingThresholds();
    setSavedThresholds(defaults);
    setThresholdDrafts({
      veryWeakMax: String(defaults.veryWeakMax),
      weakMax: String(defaults.weakMax),
      goodMax: String(defaults.goodMax),
    });
    setRatingError(null);
    setRatingSavedNotice('تمت استعادة حدود التقييم الافتراضية (5% / 8% / 12%)');
  };

  const showSuccess = (msg: string) => {
    setErrorMsg(null);
    setFeedbackMsg(msg);
    window.setTimeout(() => {
      setFeedbackMsg((curr) => (curr === msg ? null : curr));
    }, 3500);
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadBusy(true);
    setErrorMsg(null);
    try {
      const dataUrl = await prepareLogoDataUrl(file);
      updateBranding({ logoUrl: dataUrl });
      showSuccess('تم تحديث الشعار وتطبيقه على التطبيق فوراً');
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'تعذر تجهيز الشعار');
    } finally {
      setUploadBusy(false);
    }
  };

  return (
    <section
      dir="rtl"
      className="bg-white border border-slate-200 rounded-xl p-5 space-y-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#0B1F3A] text-[#C89B3C] flex items-center justify-center shrink-0">
            <Palette className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-display text-base font-bold text-[#0B1F3A]">
              هوية المكتب والبيانات
            </h3>
            <p className="text-xs text-slate-600 mt-0.5">
              تعديل الشعار، بيانات المكتب في الفوتر والهيدر، والخط الرئيسي للتطبيق (يُحفظ فوراً على هذا الجهاز).
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            resetAllBranding();
            showSuccess('تمت استعادة الشعار والبيانات الافتراضية بنجاح');
          }}
          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-slate-50 hover:bg-slate-100 px-3.5 py-2 text-xs font-bold text-[#0B1F3A] cursor-pointer whitespace-nowrap"
        >
          <RotateCcw className="w-3.5 h-3.5 text-[#C89B3C]" />
          استعادة الافتراضي
        </button>
      </div>

      {feedbackMsg && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-xs font-semibold text-emerald-800 flex items-center gap-2">
          <Check className="w-4 h-4 shrink-0" />
          <span>{feedbackMsg}</span>
        </div>
      )}

      {errorMsg && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-xs font-semibold text-red-800">
          {errorMsg}
        </div>
      )}

      {/* Logo Upload / URL & Instant Preview */}
      <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex items-center gap-3 shrink-0">
          <BrandLogo size="xl" />
          <div className="space-y-1">
            <div className="text-xs font-bold text-[#0B1F3A]">معاينة الشعار الحالي</div>
            <div className="text-[11px] text-slate-600">
              {branding.logoUrl ? 'شعار مخصص' : 'الشعار الافتراضي'}
            </div>
          </div>
        </div>

        <div className="flex-1 space-y-2.5 min-w-0">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileSelected}
            className="hidden"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={uploadBusy}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#0B1F3A] hover:bg-[#13325c] px-3.5 py-2 text-xs font-bold text-white cursor-pointer disabled:opacity-50"
            >
              {uploadBusy ? <Upload className="w-3.5 h-3.5 animate-pulse" /> : <ImagePlus className="w-3.5 h-3.5 text-[#C89B3C]" />}
              {uploadBusy ? 'جاري رفع الشعار...' : 'رفع صورة من الجهاز'}
            </button>

            {branding.logoUrl && (
              <button
                type="button"
                onClick={() => {
                  resetLogo();
                  showSuccess('تمت استعادة الشعار الافتراضي');
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 px-3 py-2 text-xs font-semibold text-[#0B1F3A] cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5 text-[#C89B3C]" />
                استعادة الشعار الافتراضي
              </button>
            )}
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-600 mb-1">
              أو رابط صورة الشعار (URL)
            </label>
            <input
              type="text"
              dir="ltr"
              value={branding.logoUrl.startsWith('data:') ? '' : branding.logoUrl}
              onChange={(e) => updateBranding({ logoUrl: e.target.value })}
              placeholder="https://example.com/logo.png"
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-[#0B1F3A] font-mono focus:border-[#0B1F3A] focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Business Identity & Contact Fields */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
        <div>
          <label className="flex items-center gap-1.5 font-semibold text-[#0B1F3A] mb-1.5">
            <Building2 className="w-3.5 h-3.5 text-[#C89B3C]" />
            اسم المكتب بالعربي
          </label>
          <input
            type="text"
            value={branding.businessNameAr}
            onChange={(e) => updateBranding({ businessNameAr: e.target.value })}
            placeholder="الوليد ترافيل للنقل المدرسي"
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-[#0B1F3A] focus:border-[#0B1F3A] focus:outline-none"
          />
        </div>

        <div>
          <label className="block font-semibold text-[#0B1F3A] mb-1.5">
            اسم المكتب بالإنجليزي
          </label>
          <input
            type="text"
            dir="ltr"
            value={branding.businessNameEn}
            onChange={(e) => updateBranding({ businessNameEn: e.target.value })}
            placeholder="Al-Waleed Travel · School Fleet Management"
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-[#0B1F3A] focus:border-[#0B1F3A] focus:outline-none"
          />
        </div>

        <div>
          <label className="block font-semibold text-[#0B1F3A] mb-1.5">
            رقم التليفون
          </label>
          <input
            type="tel"
            dir="ltr"
            value={branding.phone}
            onChange={(e) => updateBranding({ phone: e.target.value })}
            placeholder="01016815939"
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono font-bold text-[#0B1F3A] focus:border-[#0B1F3A] focus:outline-none"
          />
        </div>

        <div>
          <label className="block font-semibold text-[#0B1F3A] mb-1.5">
            رقم الواتساب
          </label>
          <input
            type="tel"
            dir="ltr"
            value={branding.whatsappPhone}
            onChange={(e) => updateBranding({ whatsappPhone: e.target.value })}
            placeholder="01016815939"
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono font-bold text-[#0B1F3A] focus:border-[#0B1F3A] focus:outline-none"
          />
        </div>

        <div>
          <label className="block font-semibold text-[#0B1F3A] mb-1.5">
            السجل التجاري
          </label>
          <input
            type="text"
            dir="ltr"
            value={branding.commercialRegister}
            onChange={(e) => updateBranding({ commercialRegister: e.target.value })}
            placeholder="83296"
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono font-bold text-[#0B1F3A] focus:border-[#0B1F3A] focus:outline-none"
          />
        </div>

        <div>
          <label className="block font-semibold text-[#0B1F3A] mb-1.5">
            التسجيل الضريبي
          </label>
          <input
            type="text"
            dir="ltr"
            value={branding.taxId}
            onChange={(e) => updateBranding({ taxId: e.target.value })}
            placeholder="775627151"
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono font-bold text-[#0B1F3A] focus:border-[#0B1F3A] focus:outline-none"
          />
        </div>

        <div>
          <label className="block font-semibold text-[#0B1F3A] mb-1.5">
            لقب التوقيع في الفوتر
          </label>
          <input
            type="text"
            value={branding.managerTitleAr}
            onChange={(e) => updateBranding({ managerTitleAr: e.target.value })}
            placeholder="الإدارة التنفيذية — م. حمدي لطفي"
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-[#0B1F3A] focus:border-[#0B1F3A] focus:outline-none"
          />
        </div>

        <div>
          <label className="flex items-center gap-1.5 font-semibold text-[#0B1F3A] mb-1.5">
            <Type className="w-3.5 h-3.5 text-[#C89B3C]" />
            الخط الرئيسي للتطبيق
          </label>
          <select
            value={branding.fontFamily}
            onChange={(e) => {
              const fontFamily = e.target.value as AppFontChoice;
              updateBranding({ fontFamily });
              showSuccess(`تم تطبيق خط ${fontFamily} على كل الشاشات`);
            }}
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-[#0B1F3A] focus:border-[#0B1F3A] focus:outline-none cursor-pointer"
          >
            {APP_FONT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="md:col-span-2">
          <label className="block font-semibold text-[#0B1F3A] mb-1.5">
            نص إضافي تحت الفوتر (اختياري — يظهر في الفوتر عند كتابته فقط)
          </label>
          <input
            type="text"
            value={branding.footerNote}
            onChange={(e) => updateBranding({ footerNote: e.target.value })}
            placeholder="مثال: جميع الرحلات مراقبة بنظام التتبع المباشر على مدار الساعة"
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-[#0B1F3A] focus:border-[#0B1F3A] focus:outline-none"
          />
        </div>
      </div>

      {/* Profit Margin Rating Thresholds Sub-section (super_admin only) */}
      <div className="border-t border-slate-200 pt-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-amber-50 border border-amber-200 text-[#0B1F3A] flex items-center justify-center shrink-0">
              <SlidersHorizontal className="w-4 h-4 text-[#C89B3C]" />
            </div>
            <div>
              <h4 className="font-display text-sm font-bold text-[#0B1F3A]">
                حدود تقييم هامش الربح
              </h4>
              <p className="text-xs text-slate-600 mt-0.5">
                الأرقام دي افتراضية تقديرية، عدّلها على أرقام مكتبك الحقيقية
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleResetRatingThresholds}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-slate-50 hover:bg-slate-100 px-3 py-1.5 text-xs font-bold text-[#0B1F3A] cursor-pointer whitespace-nowrap"
          >
            <RotateCcw className="w-3.5 h-3.5 text-[#C89B3C]" />
            استعادة الافتراضي
          </button>
        </div>

        {ratingError && (
          <div
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-xs font-semibold text-red-800"
          >
            {ratingError}
          </div>
        )}

        {!ratingError && ratingSavedNotice && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-xs font-semibold text-emerald-800 flex items-center gap-2">
            <Check className="w-4 h-4 shrink-0" />
            <span>{ratingSavedNotice}</span>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div>
            <label className="block font-semibold text-[#0B1F3A] mb-1.5">
              حد «ضعيف جدًا / ضعيف» (%)
            </label>
            <input
              type="number"
              step="0.5"
              min="0.5"
              max="98"
              dir="ltr"
              value={thresholdDrafts.veryWeakMax}
              onChange={(e) => handleThresholdDraftChange('veryWeakMax', e.target.value)}
              placeholder={String(DEFAULT_MARGIN_RATING_THRESHOLDS.veryWeakMax)}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono font-bold text-[#0B1F3A] focus:border-[#0B1F3A] focus:outline-none"
            />
            <span className="block text-[11px] text-slate-500 mt-1">
              أقل من هذا الرقم (وفوق 0%) يُقيّم «ضعيف جدًا»
            </span>
          </div>

          <div>
            <label className="block font-semibold text-[#0B1F3A] mb-1.5">
              حد «ضعيف / جيد» (%)
            </label>
            <input
              type="number"
              step="0.5"
              min="1"
              max="99"
              dir="ltr"
              value={thresholdDrafts.weakMax}
              onChange={(e) => handleThresholdDraftChange('weakMax', e.target.value)}
              placeholder={String(DEFAULT_MARGIN_RATING_THRESHOLDS.weakMax)}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono font-bold text-[#0B1F3A] focus:border-[#0B1F3A] focus:outline-none"
            />
            <span className="block text-[11px] text-slate-500 mt-1">
              من الحد الأول وحتى أقل من هذا الرقم يُقيّم «ضعيف»
            </span>
          </div>

          <div>
            <label className="block font-semibold text-[#0B1F3A] mb-1.5">
              حد «جيد / ممتاز» (%)
            </label>
            <input
              type="number"
              step="0.5"
              min="1.5"
              max="100"
              dir="ltr"
              value={thresholdDrafts.goodMax}
              onChange={(e) => handleThresholdDraftChange('goodMax', e.target.value)}
              placeholder={String(DEFAULT_MARGIN_RATING_THRESHOLDS.goodMax)}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono font-bold text-[#0B1F3A] focus:border-[#0B1F3A] focus:outline-none"
            />
            <span className="block text-[11px] text-slate-500 mt-1">
              من هذا الرقم فأعلى يُقيّم «ممتاز» (وما قبله «جيد»)
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-700">
          <span className="font-bold text-[#0B1F3A]">معاينة النطاقات المطبّقة حالياً:</span>
          {[
            { pct: -1, text: '< 0%' },
            { pct: 0, text: `0% – < ${savedThresholds.veryWeakMax}%` },
            { pct: savedThresholds.veryWeakMax, text: `${savedThresholds.veryWeakMax}% – < ${savedThresholds.weakMax}%` },
            { pct: savedThresholds.weakMax, text: `${savedThresholds.weakMax}% – < ${savedThresholds.goodMax}%` },
            { pct: savedThresholds.goodMax, text: `≥ ${savedThresholds.goodMax}%` },
          ].map((item) => {
            const r = getMarginRating(item.pct, savedThresholds);
            return (
              <span
                key={item.text}
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-bold ${r.badgeClassName}`}
              >
                <span>{r.label}</span>
                <span className="font-mono text-[10px] opacity-90" dir="ltr">
                  ({item.text})
                </span>
              </span>
            );
          })}
        </div>
      </div>
    </section>
  );
};
