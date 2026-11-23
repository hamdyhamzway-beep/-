import { toBlob } from 'html-to-image';
import { formatEGP } from './api';
import type { EnrichedDriver, FinancialTransaction, SalaryRecord } from '../types';

export interface StatementFallbackData {
  driver: EnrichedDriver;
  period: { month: number; year: number; startDate?: string; endDate?: string };
  salary: SalaryRecord;
  transactions: FinancialTransaction[];
}

export interface CapturePngOptions {
  width?: number;
  backgroundColor?: string;
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

async function waitForFontsAndImages(root: HTMLElement): Promise<void> {
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    await Promise.race([
      document.fonts.ready.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ]);
  }

  const images = Array.from(root.querySelectorAll('img'));
  await Promise.all(
    images.map(async (img) => {
      if (!img.complete) {
        await Promise.race([
          new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true });
            img.addEventListener('error', () => resolve(), { once: true });
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 2500)),
        ]);
      }
      if (typeof img.decode === 'function') {
        await Promise.race([
          img.decode().catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 1000)),
        ]);
      }
    })
  );
}

function nextAnimationFrames(count = 2): Promise<void> {
  return new Promise((resolve) => {
    let remaining = count;
    const step = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/**
 * Captures the full rendered DOM container into an unclipped high-DPI PNG blob
 * via an offscreen full-size clone (immune to modal scroll, mobile width, and overflow-hidden).
 */
export async function captureElementAsPngBlob(
  element: HTMLElement,
  options: CapturePngOptions = {}
): Promise<Blob> {
  await waitForFontsAndImages(element);

  const computed = getComputedStyle(element);
  const bg = options.backgroundColor || '#ffffff';
  const rect = element.getBoundingClientRect();
  const targetWidth = Math.max(
    options.width ?? 0,
    element.scrollWidth,
    Math.ceil(rect.width),
    920
  );

  const host = document.createElement('div');
  host.setAttribute('dir', computed.direction || 'rtl');
  host.style.position = 'fixed';
  host.style.top = '0';
  host.style.left = '-99999px';
  host.style.width = `${targetWidth}px`;
  host.style.height = 'auto';
  host.style.overflow = 'visible';
  host.style.backgroundColor = bg;
  host.style.pointerEvents = 'none';
  host.style.zIndex = '-1';
  host.style.opacity = '1';

  const clone = element.cloneNode(true) as HTMLElement;

  // Strip elements marked as excluded from capture
  clone.querySelectorAll('[data-no-capture="true"]').forEach((node) => node.remove());

  // Ensure the root clone and any overflow/scroll descendants expand completely without clipping
  clone.style.width = `${targetWidth}px`;
  clone.style.minWidth = `${targetWidth}px`;
  clone.style.maxWidth = 'none';
  clone.style.height = 'auto';
  clone.style.maxHeight = 'none';
  clone.style.overflow = 'visible';
  clone.style.margin = '0';
  clone.style.transform = 'none';
  clone.style.boxShadow = 'none';
  clone.style.backgroundColor = bg;

  const descendants = clone.querySelectorAll<HTMLElement>('*');
  descendants.forEach((node) => {
    const cls = node.className && typeof node.className === 'string' ? node.className : '';
    if (
      cls.includes('overflow-') ||
      cls.includes('max-h-') ||
      node.style.overflow ||
      node.style.overflowX ||
      node.style.overflowY ||
      node.style.maxHeight
    ) {
      node.style.overflow = 'visible';
      node.style.overflowX = 'visible';
      node.style.overflowY = 'visible';
      node.style.maxHeight = 'none';
    }
    node.scrollTop = 0;
    node.scrollLeft = 0;
  });

  host.appendChild(clone);
  document.body.appendChild(host);

  try {
    await nextAnimationFrames(2);
    await waitForFontsAndImages(clone);

    const fullWidth = Math.ceil(Math.max(clone.scrollWidth, clone.offsetWidth, targetWidth));
    if (fullWidth > targetWidth) {
      host.style.width = `${fullWidth}px`;
      clone.style.width = `${fullWidth}px`;
      clone.style.minWidth = `${fullWidth}px`;
      await nextAnimationFrames(1);
    }
    const fullHeight = Math.ceil(Math.max(clone.scrollHeight, clone.offsetHeight));

    const baseCaptureOpts = {
      pixelRatio: 2,
      backgroundColor: bg,
      cacheBust: true,
      width: fullWidth,
      height: fullHeight,
      style: {
        margin: '0',
        transform: 'none',
        overflow: 'visible',
      },
    };

    let blob: Blob | null = null;
    try {
      blob = await toBlob(clone, { ...baseCaptureOpts, skipFonts: false });
    } catch {
      blob = await toBlob(clone, { ...baseCaptureOpts, skipFonts: true });
    }

    if (!blob) {
      throw new Error('تعذر التقاط صورة الكشف');
    }
    return blob;
  } finally {
    if (host.parentNode) {
      host.parentNode.removeChild(host);
    }
  }
}

function wrapCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const words = String(text || '—').trim().split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : ['—'];
}

/**
 * Deterministic high-DPI Canvas 2D renderer for complete Arabic driver statements
 * (renders all 7 financial breakdown cards + full transaction history without clipping).
 */
export async function renderStatementFallbackBlob(
  data: StatementFallbackData
): Promise<Blob> {
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    await Promise.race([
      document.fonts.ready.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 1200)),
    ]);
  }

  const fontStack = '"Cairo", "Tajawal", Tahoma, Arial, sans-serif';
  const rows = data.transactions || [];
  const width = 1120;
  const pad = 44;
  const innerW = width - pad * 2;

  const headerHeight = 148;
  const infoHeight = 114;
  const cardGap = 14;
  const cardH = 82;
  const cardsSectionHeight = cardH * 2 + cardGap + 28;
  const tableTitleHeight = 46;
  const tableHeaderHeight = 48;

  // Measure wrapped description rows cleanly before allocating final canvas height
  const measureCanvas = document.createElement('canvas');
  const mCtx = measureCanvas.getContext('2d');
  const descColMaxW = 470;
  if (mCtx) {
    mCtx.font = `500 18px ${fontStack}`;
  }
  const wrappedRows = rows.map((t) => {
    const descLines = mCtx ? wrapCanvasText(mCtx, t.description, descColMaxW) : [t.description || '—'];
    const rowH = Math.max(48, descLines.length * 26 + 22);
    return { t, descLines, rowH };
  });

  const rowsTotalHeight =
    wrappedRows.length === 0
      ? 68
      : wrappedRows.reduce((sum, r) => sum + r.rowH, 0);

  const footerHeight = 56;
  const height =
    headerHeight +
    infoHeight +
    cardsSectionHeight +
    tableTitleHeight +
    tableHeaderHeight +
    rowsTotalHeight +
    footerHeight;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');

  // Background
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  // Header masthead
  ctx.fillStyle = '#0B1F3A';
  ctx.fillRect(0, 0, width, headerHeight);
  ctx.fillStyle = '#C89B3C';
  ctx.fillRect(0, headerHeight - 6, width, 6);

  ctx.direction = 'rtl';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#C89B3C';
  ctx.font = `700 18px ${fontStack}`;
  ctx.fillText('الوليد ترافيل — كشف حساب السائق الشهري', width - pad, 46);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = `800 30px ${fontStack}`;
  ctx.fillText(`${data.driver.fullName} · كود ${data.driver.driverCode}`, width - pad, 92);

  ctx.fillStyle = '#CBD5E1';
  ctx.font = `600 18px ${fontStack}`;
  const periodRangeTxt =
    data.period.startDate && data.period.endDate
      ? ` (${data.period.startDate} → ${data.period.endDate})`
      : '';
  ctx.fillText(
    `الفترة المحاسبية: شهر ${data.period.month} / ${data.period.year}${periodRangeTxt}`,
    width - pad,
    126
  );

  // Driver info strip
  let y = headerHeight + 36;
  ctx.fillStyle = '#F8FAFC';
  ctx.strokeStyle = '#E2E8F0';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(pad, y - 18, innerW, 80, 12);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#0B1F3A';
  ctx.font = `700 20px ${fontStack}`;
  ctx.fillText(
    `المدرسة: ${data.driver.schoolName || '—'}   ·   المركبة: باص ${data.driver.busNumber || '—'}   ·   الخط: ${
      data.driver.routeName || '—'
    }`,
    width - pad - 20,
    y + 18
  );
  ctx.fillStyle = '#475569';
  ctx.font = `500 17px ${fontStack}`;
  ctx.fillText(
    `رقم الهاتف: ${data.driver.phone || '—'}`,
    width - pad - 20,
    y + 46
  );

  // All 7 summary cards (Row 1: 4 cards, Row 2: 3 cards including highlighted Net)
  y += 88;
  const coverageAdditions = Number(
    (data.salary as { totalCoverageAdditions?: number }).totalCoverageAdditions || 0
  );
  const topRowCards = [
    { label: 'الراتب الأساسي', value: formatEGP(data.salary.baseSalary), color: '#0F172A', bg: '#F8FAFC' },
    { label: 'إجمالي السلف', value: `− ${formatEGP(data.salary.totalAdvances)}`, color: '#B91C1C', bg: '#FEF2F2' },
    {
      label: 'خصم التغطيات',
      value: `− ${formatEGP(data.salary.totalCoverageDeductions)}`,
      color: '#B91C1C',
      bg: '#FEF2F2',
    },
    {
      label: 'مستحق التغطيات',
      value: `+ ${formatEGP(coverageAdditions)}`,
      color: '#047857',
      bg: '#ECFDF5',
    },
  ];
  const bottomRowCards = [
    {
      label: 'خصومات أخرى',
      value: `− ${formatEGP(data.salary.otherDeductions)}`,
      color: '#B91C1C',
      bg: '#FEF2F2',
    },
    {
      label: 'المكافآت',
      value: `+ ${formatEGP(data.salary.bonuses)}`,
      color: '#047857',
      bg: '#ECFDF5',
    },
    {
      label: 'صافي المستحق',
      value: formatEGP(data.salary.netSalary),
      color: '#C89B3C',
      bg: '#0B1F3A',
      dark: true,
    },
  ];

  const topCardW = (innerW - cardGap * 3) / 4;
  topRowCards.forEach((c, idx) => {
    const cx = width - pad - (idx + 1) * topCardW - idx * cardGap;
    const cy = y;
    ctx.fillStyle = c.bg;
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(cx, cy, topCardW, cardH, 12);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#64748B';
    ctx.font = `600 17px ${fontStack}`;
    ctx.fillText(c.label, cx + topCardW - 16, cy + 30);

    ctx.fillStyle = c.color;
    ctx.font = `800 22px ${fontStack}`;
    ctx.fillText(c.value, cx + topCardW - 16, cy + 62);
  });

  const bottomCardW = (innerW - cardGap * 2) / 3;
  const row2Y = y + cardH + cardGap;
  bottomRowCards.forEach((c, idx) => {
    const cx = width - pad - (idx + 1) * bottomCardW - idx * cardGap;
    const cy = row2Y;
    ctx.fillStyle = c.bg;
    ctx.strokeStyle = c.dark ? '#0B1F3A' : '#CBD5E1';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(cx, cy, bottomCardW, cardH, 12);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = c.dark ? '#CBD5E1' : '#64748B';
    ctx.font = `600 17px ${fontStack}`;
    ctx.fillText(c.label, cx + bottomCardW - 18, cy + 30);

    ctx.fillStyle = c.color;
    ctx.font = `800 24px ${fontStack}`;
    ctx.fillText(c.value, cx + bottomCardW - 18, cy + 64);
  });

  y = row2Y + cardH + 34;

  // Transactions title
  ctx.fillStyle = '#0B1F3A';
  ctx.font = `800 22px ${fontStack}`;
  ctx.fillText(`سجل الحركات المالية للشهر (${rows.length})`, width - pad, y);
  y += 16;

  // Table header
  ctx.fillStyle = '#F1F5F9';
  ctx.fillRect(pad, y, innerW, tableHeaderHeight);
  ctx.strokeStyle = '#CBD5E1';
  ctx.lineWidth = 1;
  ctx.strokeRect(pad, y, innerW, tableHeaderHeight);

  ctx.fillStyle = '#475569';
  ctx.font = `700 18px ${fontStack}`;
  ctx.fillText('التاريخ', width - pad - 18, y + 31);
  ctx.fillText('النوع', width - pad - 190, y + 31);
  ctx.fillText('البيان', width - pad - 380, y + 31);
  ctx.textAlign = 'left';
  ctx.fillText('المبلغ', pad + 18, y + 31);
  ctx.textAlign = 'right';
  y += tableHeaderHeight;

  if (wrappedRows.length === 0) {
    ctx.strokeStyle = '#E2E8F0';
    ctx.strokeRect(pad, y, innerW, 68);
    ctx.fillStyle = '#64748B';
    ctx.font = `600 19px ${fontStack}`;
    ctx.textAlign = 'center';
    ctx.fillText('لا توجد حركات مالية مسجلة في هذا الشهر', width / 2, y + 40);
    ctx.textAlign = 'right';
    y += 68;
  } else {
    wrappedRows.forEach(({ t, descLines, rowH }, idx) => {
      if (idx % 2 === 1) {
        ctx.fillStyle = '#F8FAFC';
        ctx.fillRect(pad, y, innerW, rowH);
      }
      ctx.strokeStyle = '#E2E8F0';
      ctx.strokeRect(pad, y, innerW, rowH);

      const typeLabel =
        t.type === 'advance'
          ? 'سلفة'
          : t.type === 'coverage_deduction'
          ? 'خصم تغطية'
          : t.type === 'coverage_credit'
          ? 'مستحق تغطية'
          : t.type === 'bonus'
          ? 'مكافأة'
          : t.type === 'reversal'
          ? 'عكس قيد'
          : 'خصم إداري';

      ctx.fillStyle = '#475569';
      ctx.font = `600 17px ${fontStack}`;
      ctx.fillText(
        new Date(t.createdAt).toLocaleDateString('ar-EG', { timeZone: 'Africa/Cairo' }),
        width - pad - 18,
        y + 30
      );

      ctx.fillStyle = '#0F172A';
      ctx.font = `700 17px ${fontStack}`;
      ctx.fillText(typeLabel, width - pad - 190, y + 30);

      ctx.fillStyle = '#334155';
      ctx.font = `500 17px ${fontStack}`;
      descLines.forEach((line, li) => {
        ctx.fillText(line, width - pad - 380, y + 30 + li * 26);
      });

      ctx.textAlign = 'left';
      ctx.fillStyle = t.direction === 'credit' ? '#047857' : '#B91C1C';
      ctx.font = `800 18px ${fontStack}`;
      ctx.fillText(
        `${t.direction === 'credit' ? '+' : '−'} ${formatEGP(t.amount)}`,
        pad + 18,
        y + 30
      );
      ctx.textAlign = 'right';
      y += rowH;
    });
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('تعذر توليد صورة الكشف'));
    }, 'image/png');
  });
}
