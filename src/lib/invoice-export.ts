import { jsPDF } from 'jspdf';
import {
  getArabicMonthName,
  INVOICE_COMPANY_META,
  tafqeetEGP,
} from './arabic-tafqeet';
import type { InvoiceRecord } from '../types';

export type InvoicePaperSize = 'A4' | 'A5';

export interface InvoiceDraftInput {
  invoiceCode: string;
  issueDate: string;
  billToName: string;
  billingMonth: number;
  billingYear: number;
  vehicleCount: number;
  schoolName: string;
  statementText: string;
  totalAmount: number;
  amountInWords?: string;
  status?: 'issued' | 'cancelled';
  cancelledReason?: string;
}

export function formatInvoiceNumericTotal(amount: number): string {
  const num = Number(amount || 0);
  if (!Number.isFinite(num)) return '0';
  const hasDecimals = Math.abs(num - Math.round(num)) > 0.001;
  return num.toLocaleString('en-US', {
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

function formatDisplayDateAr(isoDate: string): string {
  if (!isoDate) return '—';
  const parts = isoDate.split('-');
  if (parts.length === 3) {
    return `${parts[2]} / ${parts[1]} / ${parts[0]}`;
  }
  return isoDate;
}

function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function wrapRtlText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const paragraphs = String(text || '').split(/\r?\n/);
  const lines: string[] = [];

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) {
      lines.push('');
      continue;
    }
    const words = trimmed.split(/\s+/);
    let currentLine = '';

    for (const word of words) {
      const candidate = currentLine ? `${currentLine} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth) {
        currentLine = candidate;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
  }

  return lines.length ? lines : ['—'];
}

async function renderInvoiceCanvas(
  invoice: InvoiceDraftInput | InvoiceRecord,
  pageSize: InvoicePaperSize = 'A4'
): Promise<HTMLCanvasElement> {
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    try {
      await document.fonts.ready;
    } catch {
      // ignore font loading timeout
    }
  }

  const isA5 = pageSize === 'A5';
  // 1:1.4142 ISO A-series aspect ratio
  const width = 1240;
  const height = 1754;
  const pad = isA5 ? 72 : 84;
  const innerW = width - pad * 2;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('تعذر تهيئة لوحة الرسم');

  const fontDisplay = '"Cairo", "Tajawal", Tahoma, Arial, sans-serif';
  const amountWords = invoice.amountInWords || tafqeetEGP(invoice.totalAmount);
  const totalFormatted = `${formatInvoiceNumericTotal(invoice.totalAmount)} ج.م`;
  const isCancelled = invoice.status === 'cancelled';

  // Crisp paper background
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  // Subtle double formal border
  ctx.strokeStyle = '#0B1F3A';
  ctx.lineWidth = 3;
  ctx.strokeRect(32, 32, width - 64, height - 64);

  ctx.strokeStyle = '#C89B3C';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(42, 42, width - 84, height - 84);

  // Top dark navy masthead band
  const headerH = 225;
  ctx.fillStyle = '#0B1F3A';
  ctx.fillRect(42, 42, width - 84, headerH);

  // Gold bottom accent under masthead
  ctx.fillStyle = '#C89B3C';
  ctx.fillRect(42, 42 + headerH - 7, width - 84, 7);

  ctx.direction = 'rtl';

  // Right side of masthead: Establishment Name & Legal Registry
  ctx.textAlign = 'right';
  ctx.fillStyle = '#C89B3C';
  ctx.font = `700 22px ${fontDisplay}`;
  ctx.fillText('فاتورة مطالبة مالية — مستند رسمي', width - pad, 102);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = `800 36px ${fontDisplay}`;
  ctx.fillText(INVOICE_COMPANY_META.companyName, width - pad, 154);

  ctx.fillStyle = '#CBD5E1';
  ctx.font = `600 20px ${fontDisplay}`;
  ctx.fillText(
    `سجل تجاري: ${INVOICE_COMPANY_META.commercialRegister}   |   تسجيل ضريبي: ${INVOICE_COMPANY_META.taxId}   |   هاتف: ${INVOICE_COMPANY_META.phone}`,
    width - pad,
    206
  );

  // Left side of masthead: Invoice number badge
  const badgeW = 250;
  const badgeH = 128;
  const badgeX = pad;
  const badgeY = 84;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.strokeStyle = '#C89B3C';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 12);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillStyle = '#CBD5E1';
  ctx.font = `600 18px ${fontDisplay}`;
  ctx.fillText('رقم الفاتورة التسلسلي', badgeX + badgeW / 2, badgeY + 38);

  ctx.fillStyle = '#C89B3C';
  ctx.font = `800 40px ${fontDisplay}`;
  ctx.fillText(`#${invoice.invoiceCode}`, badgeX + badgeW / 2, badgeY + 86);

  ctx.fillStyle = '#E2E8F0';
  ctx.font = `600 17px ${fontDisplay}`;
  ctx.fillText(`شهر ${getArabicMonthName(invoice.billingMonth)} ${invoice.billingYear}`, badgeX + badgeW / 2, badgeY + 114);

  // Meta Info Row: Issue Date & Period
  let y = 42 + headerH + 46;
  ctx.fillStyle = '#F8FAFC';
  ctx.strokeStyle = '#CBD5E1';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(pad, y, innerW, 88, 10);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'right';
  ctx.fillStyle = '#64748B';
  ctx.font = `600 20px ${fontDisplay}`;
  ctx.fillText('تاريخ الإصدار:', width - pad - 24, y + 36);
  ctx.fillStyle = '#0B1F3A';
  ctx.font = `700 24px ${fontDisplay}`;
  ctx.fillText(formatDisplayDateAr(invoice.issueDate), width - pad - 24, y + 70);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#64748B';
  ctx.font = `600 20px ${fontDisplay}`;
  ctx.fillText('الجهة / المدرسة المعنية:', pad + 24, y + 36);
  ctx.fillStyle = '#0B1F3A';
  ctx.font = `700 23px ${fontDisplay}`;
  ctx.fillText(
    `${invoice.schoolName || 'مدرسة إشراقة الغد'} · (${invoice.vehicleCount || 35} سيارة)`,
    pad + 24,
    y + 70
  );

  // Bill To Card ("المطلوب من")
  y += 116;
  ctx.fillStyle = '#FFFDF7';
  ctx.strokeStyle = '#C89B3C';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(pad, y, innerW, 120, 12);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'right';
  ctx.fillStyle = '#926F21';
  ctx.font = `700 20px ${fontDisplay}`;
  ctx.fillText('المطلوب من السيد / السادة:', width - pad - 28, y + 40);

  ctx.fillStyle = '#0B1F3A';
  ctx.font = `800 30px ${fontDisplay}`;
  ctx.fillText(invoice.billToName, width - pad - 28, y + 90);

  // Statement & Total Only Table
  y += 156;
  const colIndexW = 90;
  const colTotalW = 290;
  const colStmtW = innerW - colIndexW - colTotalW;

  // Table header
  ctx.fillStyle = '#0B1F3A';
  ctx.fillRect(pad, y, innerW, 64);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = `700 22px ${fontDisplay}`;
  ctx.textAlign = 'center';
  ctx.fillText('م', width - pad - colIndexW / 2, y + 41);

  ctx.textAlign = 'right';
  ctx.fillText('البيــــــــان المحاسبي', width - pad - colIndexW - 24, y + 41);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#C89B3C';
  ctx.fillText('الإجمالي (ج.م)', pad + colTotalW / 2, y + 41);

  y += 64;

  // Measure wrapped statement lines
  ctx.font = `600 24px ${fontDisplay}`;
  const stmtLines = wrapRtlText(ctx, invoice.statementText, colStmtW - 48);
  const lineH = 44;
  const rowH = Math.max(220, stmtLines.length * lineH + 76);

  // Row body
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(pad, y, innerW, rowH);
  ctx.strokeStyle = '#CBD5E1';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(pad, y, innerW, rowH);

  // Vertical dividers
  ctx.beginPath();
  ctx.moveTo(width - pad - colIndexW, y);
  ctx.lineTo(width - pad - colIndexW, y + rowH);
  ctx.moveTo(pad + colTotalW, y);
  ctx.lineTo(pad + colTotalW, y + rowH);
  ctx.stroke();

  // Cell 1: index
  ctx.textAlign = 'center';
  ctx.fillStyle = '#0B1F3A';
  ctx.font = `700 24px ${fontDisplay}`;
  ctx.fillText('1', width - pad - colIndexW / 2, y + 58);

  // Cell 2: statement lines
  ctx.textAlign = 'right';
  ctx.fillStyle = '#0F172A';
  ctx.font = `600 24px ${fontDisplay}`;
  stmtLines.forEach((line, idx) => {
    ctx.fillText(line, width - pad - colIndexW - 24, y + 58 + idx * lineH);
  });

  // Cell 3: total numeric (ONLY Total)
  ctx.textAlign = 'center';
  ctx.fillStyle = '#0B1F3A';
  ctx.font = `800 30px ${fontDisplay}`;
  ctx.fillText(totalFormatted, pad + colTotalW / 2, y + rowH / 2 + 10);

  y += rowH + 34;

  // Grand Total Strip + Tafqeet ("فقط وقدره")
  ctx.fillStyle = '#0B1F3A';
  ctx.beginPath();
  ctx.roundRect(pad, y, innerW, 92, 10);
  ctx.fill();

  ctx.textAlign = 'right';
  ctx.fillStyle = '#E2E8F0';
  ctx.font = `700 25px ${fontDisplay}`;
  ctx.fillText('الإجمــــالي المستحق', width - pad - 28, y + 55);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#C89B3C';
  ctx.font = `800 36px ${fontDisplay}`;
  ctx.fillText(totalFormatted, pad + 28, y + 58);

  y += 110;

  // Tafqeet box
  ctx.font = `700 23px ${fontDisplay}`;
  const tafqeetLines = wrapRtlText(ctx, amountWords, innerW - 210);
  const tafqeetH = Math.max(88, tafqeetLines.length * 38 + 38);

  ctx.fillStyle = '#F8FAFC';
  ctx.strokeStyle = '#0B1F3A';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(pad, y, innerW, tafqeetH, 10);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'right';
  ctx.fillStyle = '#64748B';
  ctx.font = `700 22px ${fontDisplay}`;
  ctx.fillText('فقط وقدره:', width - pad - 24, y + 50);

  ctx.fillStyle = '#0B1F3A';
  ctx.font = `700 24px ${fontDisplay}`;
  tafqeetLines.forEach((line, idx) => {
    ctx.fillText(line, width - pad - 160, y + 50 + idx * 38);
  });

  // Watermark if cancelled
  if (isCancelled) {
    ctx.save();
    ctx.translate(width / 2, height / 2 - 40);
    ctx.rotate(-0.28);
    ctx.strokeStyle = 'rgba(185, 28, 28, 0.72)';
    ctx.lineWidth = 8;
    ctx.strokeRect(-220, -68, 440, 136);
    ctx.fillStyle = 'rgba(185, 28, 28, 0.10)';
    ctx.fillRect(-220, -68, 440, 136);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(185, 28, 28, 0.85)';
    ctx.font = `800 54px ${fontDisplay}`;
    ctx.fillText('فاتورة ملغاة', 0, 18);
    ctx.restore();
  }

  // Footer: Fixed at bottom with ONLY Office Signature + Address
  const footerTop = height - 310;
  ctx.strokeStyle = '#E2E8F0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pad, footerTop);
  ctx.lineTo(width - pad, footerTop);
  ctx.stroke();

  // Office Address on the right
  ctx.textAlign = 'right';
  ctx.fillStyle = '#64748B';
  ctx.font = `700 19px ${fontDisplay}`;
  ctx.fillText('عنوان المكتب:', width - pad, footerTop + 50);

  ctx.fillStyle = '#0B1F3A';
  ctx.font = `700 22px ${fontDisplay}`;
  const addressLines = wrapRtlText(ctx, INVOICE_COMPANY_META.address, innerW - 380);
  addressLines.forEach((line, idx) => {
    ctx.fillText(line, width - pad, footerTop + 88 + idx * 34);
  });

  ctx.fillStyle = '#475569';
  ctx.font = `600 18px ${fontDisplay}`;
  ctx.fillText(
    `هاتف الإدارة: ${INVOICE_COMPANY_META.phone}  ·  س.ت: ${INVOICE_COMPANY_META.commercialRegister}`,
    width - pad,
    footerTop + 170
  );

  // ONLY ONE Signature Box on the left: "توقيع وختم المكتب"
  const sigBoxW = 320;
  const sigBoxH = 175;
  const sigBoxX = pad;
  const sigBoxY = footerTop + 34;

  ctx.fillStyle = '#F8FAFC';
  ctx.strokeStyle = '#0B1F3A';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(sigBoxX, sigBoxY, sigBoxW, sigBoxH, 12);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillStyle = '#0B1F3A';
  ctx.font = `800 22px ${fontDisplay}`;
  ctx.fillText(INVOICE_COMPANY_META.signatureTitle, sigBoxX + sigBoxW / 2, sigBoxY + 42);

  ctx.strokeStyle = '#CBD5E1';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(sigBoxX + 36, sigBoxY + sigBoxH - 38);
  ctx.lineTo(sigBoxX + sigBoxW - 36, sigBoxY + sigBoxH - 38);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#94A3B8';
  ctx.font = `600 15px ${fontDisplay}`;
  ctx.fillText(INVOICE_COMPANY_META.companyName, sigBoxX + sigBoxW / 2, sigBoxY + sigBoxH - 14);

  return canvas;
}

export async function renderInvoiceAsPngBlob(
  invoice: InvoiceDraftInput | InvoiceRecord,
  pageSize: InvoicePaperSize = 'A4'
): Promise<Blob> {
  const canvas = await renderInvoiceCanvas(invoice, pageSize);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('تعذر تصدير الفاتورة كصورة PNG'));
    }, 'image/png');
  });
}

export async function exportInvoiceAsPdf(
  invoice: InvoiceDraftInput | InvoiceRecord,
  pageSize: InvoicePaperSize = 'A4'
): Promise<void> {
  const canvas = await renderInvoiceCanvas(invoice, pageSize);
  const dataUrl = canvas.toDataURL('image/png');
  const format = pageSize === 'A5' ? 'a5' : 'a4';
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format,
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  doc.addImage(dataUrl, 'PNG', 0, 0, pageWidth, pageHeight, undefined, 'FAST');
  doc.save(`invoice-${invoice.invoiceCode}-${pageSize}.pdf`);
}

export function printInvoiceViaIframe(
  invoice: InvoiceDraftInput | InvoiceRecord,
  pageSize: InvoicePaperSize = 'A4'
): void {
  const amountWords = invoice.amountInWords || tafqeetEGP(invoice.totalAmount);
  const totalFormatted = `${formatInvoiceNumericTotal(invoice.totalAmount)} ج.م`;
  const isA5 = pageSize === 'A5';
  const isCancelled = invoice.status === 'cancelled';

  const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>فاتورة رقم ${escapeHtml(invoice.invoiceCode)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@500;600;700;800&family=Tajawal:wght@500;700;800&display=swap" rel="stylesheet" />
  <style>
    @page {
      size: ${pageSize} portrait;
      margin: ${isA5 ? '7mm' : '10mm'};
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: 'Cairo', 'Tajawal', Tahoma, Arial, sans-serif;
      color: #0F172A;
      background: #FFFFFF;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .sheet {
      position: relative;
      border: 2px solid #0B1F3A;
      outline: 1px solid #C89B3C;
      outline-offset: -6px;
      padding: ${isA5 ? '14px' : '22px'};
      min-height: ${isA5 ? '194mm' : '274mm'};
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .masthead {
      background: #0B1F3A;
      color: #FFFFFF;
      padding: ${isA5 ? '14px 16px' : '20px 24px'};
      border-bottom: 4px solid #C89B3C;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .eyebrow {
      color: #C89B3C;
      font-size: ${isA5 ? '10px' : '12px'};
      font-weight: 700;
      margin-bottom: 4px;
    }
    .company-name {
      font-size: ${isA5 ? '16px' : '22px'};
      font-weight: 800;
      margin: 0;
    }
    .legal-line {
      color: #CBD5E1;
      font-size: ${isA5 ? '9.5px' : '11.5px'};
      margin-top: 6px;
    }
    .inv-badge {
      border: 1.5px solid #C89B3C;
      background: rgba(255,255,255,0.08);
      border-radius: 8px;
      padding: ${isA5 ? '8px 12px' : '10px 18px'};
      text-align: center;
      min-width: ${isA5 ? '105px' : '140px'};
      flex-shrink: 0;
    }
    .inv-badge-label { font-size: ${isA5 ? '9px' : '11px'}; color: #CBD5E1; }
    .inv-badge-num { font-size: ${isA5 ? '18px' : '24px'}; font-weight: 800; color: #C89B3C; line-height: 1.2; }
    .inv-badge-period { font-size: ${isA5 ? '9px' : '11px'}; color: #E2E8F0; margin-top: 2px; }
    .meta-strip {
      margin-top: ${isA5 ? '12px' : '18px'};
      background: #F8FAFC;
      border: 1px solid #CBD5E1;
      border-radius: 8px;
      padding: ${isA5 ? '8px 12px' : '12px 16px'};
      display: flex;
      justify-content: space-between;
      font-size: ${isA5 ? '11px' : '13px'};
    }
    .meta-label { color: #64748B; font-size: ${isA5 ? '10px' : '11px'}; }
    .meta-val { font-weight: 700; color: #0B1F3A; margin-top: 2px; }
    .bill-to {
      margin-top: ${isA5 ? '10px' : '16px'};
      background: #FFFDF7;
      border: 1.5px solid #C89B3C;
      border-radius: 10px;
      padding: ${isA5 ? '10px 14px' : '14px 18px'};
    }
    .bill-to-label { color: #926F21; font-size: ${isA5 ? '10px' : '12px'}; font-weight: 700; }
    .bill-to-name { color: #0B1F3A; font-size: ${isA5 ? '14px' : '18px'}; font-weight: 800; margin-top: 4px; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: ${isA5 ? '12px' : '18px'};
    }
    th {
      background: #0B1F3A;
      color: #FFFFFF;
      padding: ${isA5 ? '8px 10px' : '11px 14px'};
      font-size: ${isA5 ? '11px' : '13px'};
      text-align: right;
    }
    th.center, td.center { text-align: center; }
    th.total-head { color: #C89B3C; text-align: center; width: ${isA5 ? '110px' : '160px'}; }
    td {
      border: 1px solid #CBD5E1;
      padding: ${isA5 ? '16px 12px' : '24px 16px'};
      font-size: ${isA5 ? '12px' : '14px'};
      line-height: 1.75;
      vertical-align: middle;
    }
    td.total-cell {
      font-size: ${isA5 ? '15px' : '19px'};
      font-weight: 800;
      color: #0B1F3A;
      text-align: center;
      white-space: nowrap;
    }
    .total-bar {
      margin-top: ${isA5 ? '12px' : '18px'};
      background: #0B1F3A;
      color: #FFFFFF;
      border-radius: 8px;
      padding: ${isA5 ? '10px 14px' : '14px 18px'};
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .total-bar-label { font-size: ${isA5 ? '12px' : '15px'}; font-weight: 700; }
    .total-bar-val { font-size: ${isA5 ? '16px' : '22px'}; font-weight: 800; color: #C89B3C; }
    .tafqeet-box {
      margin-top: ${isA5 ? '8px' : '12px'};
      background: #F8FAFC;
      border: 1px solid #0B1F3A;
      border-radius: 8px;
      padding: ${isA5 ? '10px 14px' : '12px 16px'};
      font-size: ${isA5 ? '11.5px' : '14px'};
    }
    .tafqeet-label { color: #64748B; font-weight: 700; margin-left: 8px; }
    .tafqeet-words { color: #0B1F3A; font-weight: 700; }
    .footer {
      margin-top: ${isA5 ? '18px' : '28px'};
      border-top: 1.5px solid #E2E8F0;
      padding-top: ${isA5 ? '12px' : '18px'};
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 16px;
    }
    .address-block { font-size: ${isA5 ? '10.5px' : '12.5px'}; line-height: 1.7; }
    .address-title { color: #64748B; font-weight: 700; }
    .address-val { color: #0B1F3A; font-weight: 700; }
    .sig-box {
      width: ${isA5 ? '155px' : '200px'};
      height: ${isA5 ? '84px' : '106px'};
      border: 1px solid #0B1F3A;
      background: #F8FAFC;
      border-radius: 8px;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      text-align: center;
      flex-shrink: 0;
    }
    .sig-title { font-size: ${isA5 ? '11px' : '13px'}; font-weight: 800; color: #0B1F3A; }
    .sig-line { border-top: 1px dashed #CBD5E1; padding-top: 4px; font-size: 9.5px; color: #94A3B8; }
    .cancelled-stamp {
      position: absolute;
      top: 44%;
      left: 50%;
      transform: translate(-50%, -50%) rotate(-16deg);
      border: 4px solid rgba(185, 28, 28, 0.8);
      background: rgba(185, 28, 28, 0.08);
      color: rgba(185, 28, 28, 0.9);
      padding: 10px 32px;
      font-size: ${isA5 ? '26px' : '34px'};
      font-weight: 800;
      pointer-events: none;
    }
  </style>
</head>
<body>
  <div class="sheet">
    ${isCancelled ? '<div class="cancelled-stamp">فاتورة ملغاة</div>' : ''}
    <div>
      <div class="masthead">
        <div>
          <div class="eyebrow">فاتورة مطالبة مالية — مستند رسمي</div>
          <h1 class="company-name">${escapeHtml(INVOICE_COMPANY_META.companyName)}</h1>
          <div class="legal-line">
            سجل تجاري: <span dir="ltr">${escapeHtml(INVOICE_COMPANY_META.commercialRegister)}</span> &nbsp;|&nbsp;
            تسجيل ضريبي: <span dir="ltr">${escapeHtml(INVOICE_COMPANY_META.taxId)}</span> &nbsp;|&nbsp;
            هاتف: <span dir="ltr">${escapeHtml(INVOICE_COMPANY_META.phone)}</span>
          </div>
        </div>
        <div class="inv-badge">
          <div class="inv-badge-label">رقم الفاتورة التسلسلي</div>
          <div class="inv-badge-num">#${escapeHtml(invoice.invoiceCode)}</div>
          <div class="inv-badge-period">شهر ${escapeHtml(getArabicMonthName(invoice.billingMonth))} ${invoice.billingYear}</div>
        </div>
      </div>

      <div class="meta-strip">
        <div>
          <div class="meta-label">تاريخ الإصدار</div>
          <div class="meta-val">${escapeHtml(formatDisplayDateAr(invoice.issueDate))}</div>
        </div>
        <div style="text-align:left">
          <div class="meta-label">الجهة / المدرسة</div>
          <div class="meta-val">${escapeHtml(invoice.schoolName || 'مدرسة إشراقة الغد')} (${invoice.vehicleCount || 35} سيارة)</div>
        </div>
      </div>

      <div class="bill-to">
        <div class="bill-to-label">المطلوب من السيد / السادة</div>
        <div class="bill-to-name">${escapeHtml(invoice.billToName)}</div>
      </div>

      <table>
        <thead>
          <tr>
            <th class="center" style="width:46px">م</th>
            <th>البيان المحاسبي</th>
            <th class="total-head">الإجمالي (ج.م)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="center" style="font-weight:700">1</td>
            <td style="font-weight:600">${escapeHtml(invoice.statementText).replace(/\n/g, '<br />')}</td>
            <td class="total-cell">${escapeHtml(totalFormatted)}</td>
          </tr>
        </tbody>
      </table>

      <div class="total-bar">
        <span class="total-bar-label">الإجمالي المستحق</span>
        <span class="total-bar-val">${escapeHtml(totalFormatted)}</span>
      </div>

      <div class="tafqeet-box">
        <span class="tafqeet-label">فقط وقدره:</span>
        <span class="tafqeet-words">${escapeHtml(amountWords)}</span>
      </div>
    </div>

    <div class="footer">
      <div class="address-block">
        <div class="address-title">عنوان المكتب:</div>
        <div class="address-val">${escapeHtml(INVOICE_COMPANY_META.address)}</div>
        <div style="color:#475569;margin-top:4px">
          هاتف الإدارة: ${escapeHtml(INVOICE_COMPANY_META.phone)} &nbsp;·&nbsp; س.ت: ${escapeHtml(INVOICE_COMPANY_META.commercialRegister)}
        </div>
      </div>
      <div class="sig-box">
        <div class="sig-title">${escapeHtml(INVOICE_COMPANY_META.signatureTitle)}</div>
        <div class="sig-line">${escapeHtml(INVOICE_COMPANY_META.companyName)}</div>
      </div>
    </div>
  </div>
</body>
</html>`;

  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.setAttribute('aria-hidden', 'true');
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!doc || !iframe.contentWindow) {
    document.body.removeChild(iframe);
    throw new Error('تعذر تهيئة إطار الطباعة');
  }

  doc.open();
  doc.write(html);
  doc.close();

  const triggerPrint = () => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } finally {
      window.setTimeout(() => {
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      }, 2000);
    }
  };

  if (iframe.contentDocument?.fonts?.ready) {
    Promise.race([
      iframe.contentDocument.fonts.ready,
      new Promise((resolve) => window.setTimeout(resolve, 450)),
    ]).then(triggerPrint);
  } else {
    window.setTimeout(triggerPrint, 350);
  }
}
