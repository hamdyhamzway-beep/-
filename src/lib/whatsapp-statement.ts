import { toBlob } from 'html-to-image';
import { formatEGP } from './api';
import type { EnrichedDriver, FinancialTransaction, SalaryRecord } from '../types';

export interface StatementFallbackData {
  driver: EnrichedDriver;
  period: { month: number; year: number };
  salary: SalaryRecord;
  transactions: FinancialTransaction[];
}

/**
 * Normalizes Egyptian & international phone numbers for https://wa.me/<digits>
 */
export function formatWhatsAppPhone(phone?: string | null): string {
  if (!phone) return '';
  let digits = phone.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }
  // Egyptian mobile numbers: 010/011/012/015 (11 digits) -> 201...
  if (digits.length === 11 && digits.startsWith('01')) {
    return `2${digits}`;
  }
  // Egyptian mobile without leading 0: 10 digits starting with 1
  if (digits.length === 10 && digits.startsWith('1')) {
    return `20${digits}`;
  }
  // Egyptian landline or general 0-prefixed number
  if (digits.startsWith('0') && digits.length >= 9) {
    return `20${digits.slice(1)}`;
  }
  return digits;
}

export function buildWhatsAppUrl(phone?: string | null, text?: string): string {
  const normalized = formatWhatsAppPhone(phone);
  const base = normalized ? `https://wa.me/${normalized}` : 'https://wa.me/';
  if (!text) return base;
  return `${base}?text=${encodeURIComponent(text)}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

export async function copyPngBlobToClipboard(blob: Blob): Promise<boolean> {
  try {
    if (
      typeof navigator === 'undefined' ||
      !navigator.clipboard?.write ||
      typeof ClipboardItem === 'undefined'
    ) {
      return false;
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
}

export async function shareImageFileViaWebShare(
  blob: Blob,
  filename: string,
  title: string,
  text: string
): Promise<'shared' | 'cancelled' | 'unsupported'> {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
      return 'unsupported';
    }
    const file = new File([blob], filename, { type: 'image/png' });
    if (typeof navigator.canShare === 'function' && !navigator.canShare({ files: [file] })) {
      return 'unsupported';
    }
    await navigator.share({
      files: [file],
      title,
      text,
    });
    return 'shared';
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return 'cancelled';
    }
    return 'unsupported';
  }
}

/**
 * Captures the rendered DOM element as a high-DPI PNG image.
 */
export async function captureElementAsPngBlob(element: HTMLElement): Promise<Blob> {
  const blob = await toBlob(element, {
    pixelRatio: 2,
    backgroundColor: '#ffffff',
    cacheBust: true,
    skipFonts: true,
    width: element.scrollWidth,
    height: element.scrollHeight,
    filter: (node) => {
      if (node instanceof HTMLElement && node.dataset.noCapture === 'true') {
        return false;
      }
      return true;
    },
  });
  if (!blob) {
    throw new Error('تعذر التقاط صورة الكشف');
  }
  return blob;
}

/**
 * Deterministic Canvas 2D fallback renderer for Arabic driver statements
 * in case DOM capture encounters cross-origin image constraints.
 */
export async function renderStatementFallbackBlob(
  data: StatementFallbackData
): Promise<Blob> {
  const rows = data.transactions.slice(0, 18);
  const width = 1080;
  const headerHeight = 140;
  const infoHeight = 120;
  const cardsHeight = 180;
  const tableHeaderHeight = 56;
  const rowHeight = 46;
  const tableHeight = tableHeaderHeight + Math.max(1, rows.length) * rowHeight + 40;
  const height = headerHeight + infoHeight + cardsHeight + tableHeight + 80;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');

  // Background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // Header bar
  ctx.fillStyle = '#0B1F3A';
  ctx.fillRect(0, 0, width, headerHeight);
  ctx.fillStyle = '#C89B3C';
  ctx.fillRect(0, headerHeight - 6, width, 6);

  ctx.direction = 'rtl';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 34px Tahoma, Arial, sans-serif';
  ctx.fillText('الوليد ترافيل — كشف حساب السائق الشهري', width - 48, 62);
  ctx.fillStyle = '#E2E8F0';
  ctx.font = '22px Tahoma, Arial, sans-serif';
  ctx.fillText(`الفترة: شهر ${data.period.month} / ${data.period.year}`, width - 48, 104);

  // Driver info strip
  let y = headerHeight + 48;
  ctx.fillStyle = '#0B1F3A';
  ctx.font = 'bold 28px Tahoma, Arial, sans-serif';
  ctx.fillText(`${data.driver.fullName} · كود ${data.driver.driverCode}`, width - 48, y);
  y += 38;
  ctx.fillStyle = '#475569';
  ctx.font = '20px Tahoma, Arial, sans-serif';
  ctx.fillText(
    `${data.driver.schoolName || '—'} · باص ${data.driver.busNumber || '—'} · ${data.driver.routeName || '—'}`,
    width - 48,
    y
  );

  // Summary cards (2 rows of 3)
  y += 42;
  const cards = [
    { label: 'الراتب الأساسي', value: formatEGP(data.salary.baseSalary), color: '#0F172A', bg: '#F8FAFC' },
    { label: 'إجمالي السلف', value: `− ${formatEGP(data.salary.totalAdvances)}`, color: '#B91C1C', bg: '#FEF2F2' },
    {
      label: 'خصم التغطيات',
      value: `− ${formatEGP(data.salary.totalCoverageDeductions)}`,
      color: '#B91C1C',
      bg: '#FEF2F2',
    },
    { label: 'خصومات أخرى', value: `− ${formatEGP(data.salary.otherDeductions)}`, color: '#B91C1C', bg: '#FEF2F2' },
    { label: 'المكافآت', value: `+ ${formatEGP(data.salary.bonuses)}`, color: '#047857', bg: '#ECFDF5' },
    { label: 'صافي المستحق', value: formatEGP(data.salary.netSalary), color: '#C89B3C', bg: '#0B1F3A', dark: true },
  ];

  const gap = 16;
  const cardW = (width - 96 - gap * 2) / 3;
  const cardH = 74;

  cards.forEach((c, idx) => {
    const row = Math.floor(idx / 3);
    const col = idx % 3;
    const cx = width - 48 - (col + 1) * cardW - col * gap;
    const cy = y + row * (cardH + gap);

    ctx.fillStyle = c.bg;
    ctx.strokeStyle = c.dark ? '#0B1F3A' : '#CBD5E1';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(cx, cy, cardW, cardH, 12);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = c.dark ? '#CBD5E1' : '#64748B';
    ctx.font = '18px Tahoma, Arial, sans-serif';
    ctx.fillText(c.label, cx + cardW - 18, cy + 28);

    ctx.fillStyle = c.color;
    ctx.font = 'bold 22px Tahoma, Arial, sans-serif';
    ctx.fillText(c.value, cx + cardW - 18, cy + 58);
  });

  y += cardH * 2 + gap + 40;

  // Transactions title
  ctx.fillStyle = '#0B1F3A';
  ctx.font = 'bold 24px Tahoma, Arial, sans-serif';
  ctx.fillText('سجل الحركات المالية للشهر', width - 48, y);
  y += 18;

  // Table header
  ctx.fillStyle = '#F1F5F9';
  ctx.fillRect(48, y, width - 96, tableHeaderHeight);
  ctx.fillStyle = '#475569';
  ctx.font = 'bold 19px Tahoma, Arial, sans-serif';
  ctx.fillText('التاريخ', width - 68, y + 35);
  ctx.fillText('النوع', width - 260, y + 35);
  ctx.fillText('البيان', width - 430, y + 35);
  ctx.textAlign = 'left';
  ctx.fillText('المبلغ', 68, y + 35);
  ctx.textAlign = 'right';
  y += tableHeaderHeight;

  if (rows.length === 0) {
    ctx.fillStyle = '#64748B';
    ctx.font = '20px Tahoma, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('لا توجد حركات مالية مسجلة في هذا الشهر', width / 2, y + 38);
  } else {
    rows.forEach((t, idx) => {
      if (idx % 2 === 1) {
        ctx.fillStyle = '#F8FAFC';
        ctx.fillRect(48, y, width - 96, rowHeight);
      }
      const typeLabel =
        t.type === 'advance'
          ? 'سلفة'
          : t.type === 'coverage_deduction'
          ? 'خصم تغطية'
          : t.type === 'bonus'
          ? 'مكافأة'
          : t.type === 'reversal'
          ? 'عكس قيد'
          : 'خصم إداري';

      ctx.fillStyle = '#475569';
      ctx.font = '18px Tahoma, Arial, sans-serif';
      ctx.fillText(new Date(t.createdAt).toLocaleDateString('ar-EG'), width - 68, y + 30);

      ctx.fillStyle = '#0F172A';
      ctx.fillText(typeLabel, width - 260, y + 30);

      const desc = t.description.length > 36 ? `${t.description.slice(0, 35)}…` : t.description;
      ctx.fillText(desc, width - 430, y + 30);

      ctx.textAlign = 'left';
      ctx.fillStyle = t.direction === 'credit' ? '#047857' : '#B91C1C';
      ctx.font = 'bold 19px Tahoma, Arial, sans-serif';
      ctx.fillText(
        `${t.direction === 'credit' ? '+' : '−'} ${formatEGP(t.amount)}`,
        68,
        y + 30
      );
      ctx.textAlign = 'right';
      y += rowHeight;
    });
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('تعذر توليد صورة الكشف'));
    }, 'image/png');
  });
}
