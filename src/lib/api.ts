import { auth } from './firebase';
import { getSessionTokenMeta, saveSessionTokenMeta } from './local-store';

const CODE_TOKEN_KEY = 'alwaleed_driver_token'; // Holds drv_... or sup_... persistent tokens

export function getDriverSessionToken(): string | null {
  try {
    return localStorage.getItem(CODE_TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function restoreDriverSessionToken(): Promise<string | null> {
  const existing = getDriverSessionToken();
  if (existing) return existing;
  try {
    const idbToken = await getSessionTokenMeta();
    if (idbToken) {
      try {
        localStorage.setItem(CODE_TOKEN_KEY, idbToken);
      } catch {
        // ignore storage errors
      }
      return idbToken;
    }
  } catch {
    // ignore IndexedDB errors
  }
  return null;
}

export function setDriverSessionToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(CODE_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(CODE_TOKEN_KEY);
    }
  } catch {
    // ignore storage failures
  }
  saveSessionTokenMeta(token).catch(() => undefined);
}

export class ApiHttpError extends Error {
  status: number;
  details?: string;
  constructor(message: string, status: number, details?: string) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function apiFetch<T = unknown>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  if (!auth.currentUser && !getDriverSessionToken()) {
    try {
      await auth.authStateReady();
    } catch {
      // ignore authStateReady errors
    }
  }

  let user = auth.currentUser;
  let codeToken = user ? null : getDriverSessionToken();
  if (!user && !codeToken) {
    codeToken = await restoreDriverSessionToken();
  }

  let token: string | null = null;
  if (user) {
    try {
      token = await user.getIdToken();
    } catch {
      token = await user.getIdToken(true).catch(() => null);
    }
  } else {
    token = codeToken;
  }

  if (!token) {
    throw new ApiHttpError('يجب تسجيل الدخول أولاً', 401);
  }

  const executeRequest = async (bearerToken: string): Promise<Response> => {
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${bearerToken}`);
    if (options.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    try {
      return await fetch(url, {
        ...options,
        headers,
      });
    } catch (networkErr: unknown) {
      if (networkErr instanceof DOMException && networkErr.name === 'AbortError') {
        throw new ApiHttpError('انتهت مهلة الاتصال بالخادم، يرجى المحاولة مرة أخرى', 0);
      }
      throw new ApiHttpError('تعذر الاتصال بالخادم حالياً، يرجى التحقق من الشبكة والمحاولة مرة أخرى', 0);
    }
  };

  let res = await executeRequest(token);

  // If Firebase ID token expired (e.g. after 60m or mobile tab sleep), force-refresh and retry once
  if (res.status === 401 && user) {
    try {
      const freshIdToken = await user.getIdToken(true);
      if (freshIdToken && freshIdToken !== token) {
        token = freshIdToken;
        res = await executeRequest(freshIdToken);
      }
    } catch {
      // Let standard 401 handler below report the error without clearing persistent session
    }
  }

  // Sliding persistent token refresh if server issued a fresh token header
  const refreshedToken = res.headers.get('X-Refreshed-Session-Token');
  if (refreshedToken && codeToken) {
    setDriverSessionToken(refreshedToken);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Never wipe persistent driver/supervisor session token on arbitrary endpoint 401s.
    // Session revocation is handled explicitly by AuthContext /api/me verification or user logout.
    throw new ApiHttpError(
      data.error || `خطأ في الخادم (${res.status})`,
      res.status,
      typeof data.details === 'string' ? data.details : undefined
    );
  }
  return data as T;
}

export function formatEGP(value: number | string | null | undefined): string {
  const num = Number(value || 0);
  return `${num.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })} ج.م`;
}

export function formatRelativeArabicTime(dateInput: string | Date | null | undefined): string {
  if (!dateInput) return 'غير متاح';
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(dateInput).getTime()) / 1000));
  if (diffSec < 60) return `منذ ${diffSec} ثانية`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `منذ ${diffMin} دقيقة`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `منذ ${diffHr} ساعة`;
  const diffDay = Math.floor(diffHr / 24);
  return `منذ ${diffDay} يوم`;
}

export function exportRowsToExcel(filename: string, headers: string[], rows: (string | number)[][]) {
  const escape = (val: string | number) => {
    const str = String(val ?? '');
    return `"${str.replace(/"/g, '""')}"`;
  };
  const csvContent =
    '\uFEFF' +
    [headers.map(escape).join(','), ...rows.map((r) => r.map(escape).join(','))].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Formats "HH:MM" (24h) or legacy Arabic time strings cleanly as Arabic 12h (e.g. "06:45 ص" / "02:30 م").
 */
export function formatArabicTripTime(value?: string | null): string {
  const raw = (value || '').trim();
  if (!raw) return '—';
  const match24 = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match24) return raw;
  const h = Number(match24[1]);
  const m = match24[2];
  if (!Number.isFinite(h) || h < 0 || h > 23) return raw;
  const period = h >= 12 ? 'م' : 'ص';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12).padStart(2, '0')}:${m} ${period}`;
}

/**
 * Normalizes Arabic-Indic (٠-٩) and Persian (۰-۹) digits to ASCII 0-9.
 */
export function normalizeArabicDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
}

/**
 * Normalizes user search queries across Arabic digits, whitespace, and casing.
 */
export function normalizeLookupText(value?: string | null): string {
  return normalizeArabicDigits(String(value || ''))
    .trim()
    .toLowerCase();
}

/**
 * Returns today's YYYY-MM-DD date string in Africa/Cairo timezone (avoiding UTC midnight drift).
 */
export function getLocalTodayDateString(): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Cairo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
}

/**
 * Normalizes "HH:MM" or Arabic "02:30 م" to "HH:MM" so <input type="time"> always populates cleanly.
 */
export function normalizeTimeInputValue(value?: string | null): string {
  const raw = normalizeArabicDigits(value || '').trim();
  if (!raw) return '';
  const match24 = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (match24) {
    return `${match24[1].padStart(2, '0')}:${match24[2]}`;
  }
  const matchAr = raw.match(/^(\d{1,2}):(\d{2})\s*(ص|م|AM|PM|am|pm)$/);
  if (matchAr) {
    let h = Number(matchAr[1]);
    const m = matchAr[2];
    const p = matchAr[3].toLowerCase();
    if ((p === 'م' || p === 'pm') && h < 12) h += 12;
    if ((p === 'ص' || p === 'am') && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m}`;
  }
  return '';
}

/**
 * Formats an ISO timestamp into Arabic 12-hour Cairo time (e.g. "06:45 ص" / "02:30 م").
 */
export function formatArabicTimestampTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Africa/Cairo',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const hRaw = Number(parts.find((p) => p.type === 'hour')?.value ?? d.getHours());
    const mStr = parts.find((p) => p.type === 'minute')?.value ?? String(d.getMinutes()).padStart(2, '0');
    const h = hRaw % 24;
    const period = h >= 12 ? 'م' : 'ص';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${String(h12).padStart(2, '0')}:${mStr} ${period}`;
  } catch {
    const h = d.getHours();
    const mStr = String(d.getMinutes()).padStart(2, '0');
    const period = h >= 12 ? 'م' : 'ص';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${String(h12).padStart(2, '0')}:${mStr} ${period}`;
  }
}
