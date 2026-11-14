import { auth } from './firebase';

const DRIVER_TOKEN_KEY = 'alwaleed_driver_token';

export function getDriverSessionToken(): string | null {
  try {
    return localStorage.getItem(DRIVER_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setDriverSessionToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(DRIVER_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(DRIVER_TOKEN_KEY);
    }
  } catch {
    // ignore storage failures
  }
}

export async function apiFetch<T = unknown>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const user = auth.currentUser;
  const driverToken = user ? null : getDriverSessionToken();
  const token = user ? await user.getIdToken() : driverToken;

  if (!token) {
    throw new Error('يجب تسجيل الدخول أولاً');
  }

  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(url, {
    ...options,
    headers,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && driverToken) {
      setDriverSessionToken(null);
    }
    throw new Error(data.error || `خطأ في الخادم (${res.status})`);
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
