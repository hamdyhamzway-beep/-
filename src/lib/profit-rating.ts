import { useEffect, useState } from 'react';

export const REPORT_RATING_STORAGE_KEY = 'alwaleed_report_rating_v1';
export const RATING_THRESHOLDS_EVENT = 'alwaleed-rating-thresholds-updated';

export interface MarginRatingThresholds {
  /** Upper bound (exclusive) for "ضعيف جدًا" (default 5%) */
  veryWeakMax: number;
  /** Upper bound (exclusive) for "ضعيف" (default 8%) */
  weakMax: number;
  /** Upper bound (exclusive) for "جيد"; >= goodMax is "ممتاز" (default 12%) */
  goodMax: number;
}

export const DEFAULT_MARGIN_RATING_THRESHOLDS: MarginRatingThresholds = {
  veryWeakMax: 5,
  weakMax: 8,
  goodMax: 12,
};

export type MarginRatingTier = 'none' | 'loss' | 'very_weak' | 'weak' | 'good' | 'excellent';

export interface MarginRatingResult {
  label: string;
  tier: MarginRatingTier;
  badgeClassName: string;
}

export function validateMarginRatingThresholds(
  input: MarginRatingThresholds
): { valid: true } | { valid: false; error: string } {
  const { veryWeakMax, weakMax, goodMax } = input;
  if (![veryWeakMax, weakMax, goodMax].every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return { valid: false, error: 'من فضلك أدخل أرقاماً صحيحة للحدود الثلاثة.' };
  }
  if (veryWeakMax <= 0 || weakMax <= 0 || goodMax <= 0) {
    return { valid: false, error: 'يجب أن تكون جميع الحدود أكبر من 0%.' };
  }
  if (!(veryWeakMax < weakMax && weakMax < goodMax)) {
    return {
      valid: false,
      error: 'يجب أن تكون الحدود مرتبة تصاعدياً بشكل صارم (الأول < الثاني < الثالث).',
    };
  }
  if (goodMax > 100) {
    return { valid: false, error: 'الحد الأعلى للتقييم لا يمكن أن يتجاوز 100%.' };
  }
  return { valid: true };
}

export function loadMarginRatingThresholds(): MarginRatingThresholds {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_MARGIN_RATING_THRESHOLDS };
  }
  try {
    const raw = window.localStorage.getItem(REPORT_RATING_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_MARGIN_RATING_THRESHOLDS };
    const parsed = JSON.parse(raw) as Partial<MarginRatingThresholds>;
    const candidate: MarginRatingThresholds = {
      veryWeakMax: Number(parsed?.veryWeakMax),
      weakMax: Number(parsed?.weakMax),
      goodMax: Number(parsed?.goodMax),
    };
    const check = validateMarginRatingThresholds(candidate);
    if (!check.valid) return { ...DEFAULT_MARGIN_RATING_THRESHOLDS };
    return candidate;
  } catch {
    return { ...DEFAULT_MARGIN_RATING_THRESHOLDS };
  }
}

export function saveMarginRatingThresholds(
  thresholds: MarginRatingThresholds
): { ok: true; thresholds: MarginRatingThresholds } | { ok: false; error: string } {
  const check = validateMarginRatingThresholds(thresholds);
  if (!check.valid) {
    return { ok: false, error: check.error };
  }
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(REPORT_RATING_STORAGE_KEY, JSON.stringify(thresholds));
      window.dispatchEvent(new CustomEvent(RATING_THRESHOLDS_EVENT, { detail: thresholds }));
    } catch {
      return { ok: false, error: 'تعذر حفظ الحدود في المتصفح.' };
    }
  }
  return { ok: true, thresholds };
}

export function resetMarginRatingThresholds(): MarginRatingThresholds {
  const defaults = { ...DEFAULT_MARGIN_RATING_THRESHOLDS };
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(REPORT_RATING_STORAGE_KEY);
      window.dispatchEvent(new CustomEvent(RATING_THRESHOLDS_EVENT, { detail: defaults }));
    } catch {
      // Ignore storage errors
    }
  }
  return defaults;
}

/**
 * Single source of truth for evaluating net-margin percentage against configured thresholds.
 */
export function getMarginRating(
  pct: number | null | undefined,
  thresholds: MarginRatingThresholds
): MarginRatingResult {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) {
    return {
      label: '—',
      tier: 'none',
      badgeClassName: 'bg-slate-100 text-slate-500 border-slate-200',
    };
  }
  if (pct < 0) {
    return {
      label: 'خسارة',
      tier: 'loss',
      badgeClassName: 'bg-red-800 text-white border-red-900',
    };
  }
  if (pct < thresholds.veryWeakMax) {
    return {
      label: 'ضعيف جدًا',
      tier: 'very_weak',
      badgeClassName: 'bg-red-100 text-red-800 border-red-300',
    };
  }
  if (pct < thresholds.weakMax) {
    return {
      label: 'ضعيف',
      tier: 'weak',
      badgeClassName: 'bg-orange-100 text-orange-800 border-orange-300',
    };
  }
  if (pct < thresholds.goodMax) {
    return {
      label: 'جيد',
      tier: 'good',
      badgeClassName: 'bg-emerald-50 text-emerald-700 border-emerald-300',
    };
  }
  return {
    label: 'ممتاز',
    tier: 'excellent',
    badgeClassName: 'bg-emerald-700 text-white border-emerald-800',
  };
}

export function useMarginRatingThresholds(): MarginRatingThresholds {
  const [thresholds, setThresholds] = useState<MarginRatingThresholds>(() =>
    loadMarginRatingThresholds()
  );

  useEffect(() => {
    const sync = () => setThresholds(loadMarginRatingThresholds());
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === REPORT_RATING_STORAGE_KEY) {
        sync();
      }
    };
    window.addEventListener(RATING_THRESHOLDS_EVENT, sync);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(RATING_THRESHOLDS_EVENT, sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return thresholds;
}
