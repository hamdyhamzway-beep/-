import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Ban,
  Building2,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Edit3,
  Eye,
  FileDown,
  FileText,
  Image as ImageIcon,
  MessageCircle,
  Plus,
  Printer,
  RotateCcw,
  Search,
  Share2,
  X,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch, formatEGP, getLocalTodayDateString } from '../../lib/api';
import {
  ARABIC_MONTH_NAMES,
  buildDefaultInvoiceStatement,
  DEFAULT_INVOICE_BILL_TO,
  DEFAULT_INVOICE_SCHOOL_NAME,
  DEFAULT_INVOICE_VEHICLE_COUNT,
  formatInvoiceCode,
  getArabicMonthName,
  INVOICE_COMPANY_META,
  tafqeetEGP,
} from '../../lib/arabic-tafqeet';
import {
  exportInvoiceAsPdf,
  formatInvoiceNumericTotal,
  type InvoiceDraftInput,
  type InvoicePaperSize,
  printInvoiceViaIframe,
  renderInvoiceAsPngBlob,
} from '../../lib/invoice-export';
import {
  buildWhatsAppUrl,
  copyPngBlobToClipboard,
  downloadBlob,
  shareImageFileViaWebShare,
} from '../../lib/whatsapp-statement';
import { useEscapeKey } from '../../lib/useEscapeKey';
import type { InvoiceRecord } from '../../types';

export interface InvoicesModuleProps {
  initialView?: 'create' | 'archive';
}

interface InvoicesApiResponse {
  invoices: InvoiceRecord[];
  nextNumber: number;
  nextCode: string;
  summary: {
    totalCount: number;
    issuedCount: number;
    cancelledCount: number;
    issuedTotalAmount: number;
  };
}

interface InvoicePaperPreviewProps {
  invoice: InvoiceDraftInput | InvoiceRecord;
  paperSize: InvoicePaperSize;
}

const InvoicePaperPreview: React.FC<InvoicePaperPreviewProps> = ({ invoice, paperSize }) => {
  const words = invoice.amountInWords || tafqeetEGP(invoice.totalAmount);
  const formattedTotal = `${formatInvoiceNumericTotal(invoice.totalAmount)} ج.م`;
  const isCancelled = invoice.status === 'cancelled';

  const formatIssueDate = (d: string) => {
    const parts = (d || '').split('-');
    if (parts.length === 3) return `${parts[2]} / ${parts[1]} / ${parts[0]}`;
    return d || '—';
  };

  return (
    <div
      dir="rtl"
      className={`relative bg-white text-slate-900 border-2 border-[#0B1F3A] shadow-sm mx-auto transition-all ${
        paperSize === 'A5' ? 'max-w-lg text-[11px]' : 'w-full text-xs'
      }`}
    >
      {/* Inner double border accent */}
      <div className="m-1.5 border border-[#C89B3C]/70 flex flex-col justify-between min-h-[560px]">
        {isCancelled && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <div className="-rotate-12 border-4 border-red-700/80 bg-red-50/85 px-8 py-2.5 text-2xl sm:text-3xl font-extrabold text-red-700 shadow-sm">
              فاتورة ملغاة
            </div>
          </div>
        )}

        <div>
          {/* Masthead */}
          <div className="bg-[#0B1F3A] text-white px-5 py-4 border-b-4 border-[#C89B3C] flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="text-[11px] font-bold text-[#C89B3C]">
                فاتورة مطالبة مالية — مستند رسمي
              </div>
              <h2 className="font-display text-base sm:text-lg font-extrabold text-white">
                {INVOICE_COMPANY_META.companyName}
              </h2>
              <div className="text-[11px] text-slate-300 flex flex-wrap items-center gap-x-3 gap-y-0.5 tabular-nums">
                <span>
                  سجل تجاري: <span dir="ltr" className="font-mono">{INVOICE_COMPANY_META.commercialRegister}</span>
                </span>
                <span>|</span>
                <span>
                  تسجيل ضريبي: <span dir="ltr" className="font-mono">{INVOICE_COMPANY_META.taxId}</span>
                </span>
                <span>|</span>
                <span>
                  هاتف: <span dir="ltr" className="font-mono">{INVOICE_COMPANY_META.phone}</span>
                </span>
              </div>
            </div>

            <div className="rounded-lg border border-[#C89B3C] bg-white/10 px-4 py-2 text-center shrink-0 min-w-[130px]">
              <div className="text-[10px] text-slate-300">رقم الفاتورة التسلسلي</div>
              <div className="font-mono text-xl font-extrabold text-[#C89B3C] tabular-nums leading-tight mt-0.5">
                #{invoice.invoiceCode}
              </div>
              <div className="text-[10px] text-slate-200 mt-0.5">
                شهر {getArabicMonthName(invoice.billingMonth)} {invoice.billingYear}
              </div>
            </div>
          </div>

          <div className="p-4 sm:p-5 space-y-4">
            {/* Issue Date & School Meta Row */}
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-[10px] text-slate-500 font-semibold">تاريخ الإصدار</div>
                <div className="font-mono font-bold text-[#0B1F3A] text-sm tabular-nums mt-0.5">
                  {formatIssueDate(invoice.issueDate)}
                </div>
              </div>
              <div className="text-left">
                <div className="text-[10px] text-slate-500 font-semibold">الجهة / المدرسة المعنية</div>
                <div className="font-bold text-[#0B1F3A] text-xs mt-0.5">
                  {invoice.schoolName || DEFAULT_INVOICE_SCHOOL_NAME} ({invoice.vehicleCount || 35} سيارة)
                </div>
              </div>
            </div>

            {/* Bill To Box ("المطلوب من") */}
            <div className="rounded-lg border border-[#C89B3C] bg-[#FFFDF7] px-4 py-3">
              <div className="text-[11px] font-bold text-[#926F21]">المطلوب من السيد / السادة:</div>
              <div className="font-display text-sm sm:text-base font-extrabold text-[#0B1F3A] mt-1">
                {invoice.billToName || DEFAULT_INVOICE_BILL_TO}
              </div>
            </div>

            {/* Statement & Total Only Table (Strict Rule: NO pre-discount, post-discount, tax or extra breakdown rows) */}
            <div className="overflow-hidden border border-slate-300">
              <table className="w-full text-right border-collapse">
                <thead>
                  <tr className="bg-[#0B1F3A] text-white">
                    <th className="py-2.5 px-3 text-center w-10 font-bold">م</th>
                    <th className="py-2.5 px-3 font-bold">البيان المحاسبي</th>
                    <th className="py-2.5 px-3 text-center text-[#C89B3C] font-bold w-36">
                      الإجمالي (ج.م)
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="bg-white">
                    <td className="py-6 px-3 text-center font-mono font-bold text-[#0B1F3A] border-l border-slate-200">
                      1
                    </td>
                    <td className="py-6 px-4 font-semibold text-slate-900 leading-relaxed whitespace-pre-line border-l border-slate-200">
                      {invoice.statementText || '—'}
                    </td>
                    <td className="py-6 px-3 text-center font-mono text-sm sm:text-base font-extrabold text-[#0B1F3A] tabular-nums whitespace-nowrap">
                      {formattedTotal}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Total Strip & Arabic Tafqeet ("فقط وقدره") */}
            <div className="space-y-2.5">
              <div className="rounded-lg bg-[#0B1F3A] text-white px-4 py-3 flex items-center justify-between gap-4">
                <span className="font-bold text-xs sm:text-sm">الإجمالي المستحق</span>
                <span className="font-mono text-base sm:text-lg font-extrabold text-[#C89B3C] tabular-nums whitespace-nowrap">
                  {formattedTotal}
                </span>
              </div>

              <div className="rounded-lg border border-[#0B1F3A]/80 bg-slate-50 px-4 py-2.5 flex flex-wrap items-baseline gap-2">
                <span className="text-slate-500 font-bold shrink-0">فقط وقدره:</span>
                <span className="font-bold text-[#0B1F3A] leading-relaxed">{words}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer: Address + ONLY Office Signature & Stamp ("توقيع وختم المكتب") */}
        <div className="px-4 sm:px-5 pb-4 pt-3 border-t border-slate-200 flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1 max-w-sm">
            <div className="text-[11px] font-bold text-slate-500">عنوان المكتب:</div>
            <div className="font-bold text-[#0B1F3A] leading-relaxed">
              {INVOICE_COMPANY_META.address}
            </div>
            <div className="text-[11px] text-slate-500 tabular-nums">
              هاتف الإدارة: {INVOICE_COMPANY_META.phone} · س.ت: {INVOICE_COMPANY_META.commercialRegister}
            </div>
          </div>

          <div className="w-44 h-24 rounded-lg border border-[#0B1F3A] bg-slate-50 p-2.5 flex flex-col justify-between text-center shrink-0">
            <div className="font-bold text-[#0B1F3A] text-xs">
              {INVOICE_COMPANY_META.signatureTitle}
            </div>
            <div className="border-t border-dashed border-slate-300 pt-1 text-[10px] text-slate-400">
              {INVOICE_COMPANY_META.companyName}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export const InvoicesModule: React.FC<InvoicesModuleProps> = ({ initialView = 'create' }) => {
  const { dbUser } = useAuth();
  const perms = dbUser?.permissions || [];
  const isSuperAdmin = dbUser?.roleSlug === 'super_admin' || perms.includes('*');
  const canFinanceWrite = isSuperAdmin || perms.includes('*') || perms.includes('finance:write');

  const [view, setView] = useState<'create' | 'archive'>(initialView);
  useEffect(() => {
    setView(initialView);
  }, [initialView]);

  const [invoicesList, setInvoicesList] = useState<InvoiceRecord[]>([]);
  const [nextNumber, setNextNumber] = useState<number>(1);
  const [nextCode, setNextCode] = useState<string>('0001');
  const [summary, setSummary] = useState({
    totalCount: 0,
    issuedCount: 0,
    cancelledCount: 0,
    issuedTotalAmount: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Paper size preference for Print / PDF / Preview
  const [paperSize, setPaperSize] = useState<InvoicePaperSize>('A4');

  // Create Form State
  const currentNow = new Date();
  const [issueDate, setIssueDate] = useState<string>(getLocalTodayDateString());
  const [billToName, setBillToName] = useState<string>(DEFAULT_INVOICE_BILL_TO);
  const [billingMonth, setBillingMonth] = useState<number>(currentNow.getMonth() + 1);
  const [billingYear, setBillingYear] = useState<number>(currentNow.getFullYear());
  const [vehicleCount, setVehicleCount] = useState<number>(DEFAULT_INVOICE_VEHICLE_COUNT);
  const [schoolName, setSchoolName] = useState<string>(DEFAULT_INVOICE_SCHOOL_NAME);
  const [statementText, setStatementText] = useState<string>(() =>
    buildDefaultInvoiceStatement(
      currentNow.getMonth() + 1,
      DEFAULT_INVOICE_VEHICLE_COUNT,
      DEFAULT_INVOICE_SCHOOL_NAME
    )
  );
  const [statementManuallyEdited, setStatementManuallyEdited] = useState(false);
  const [totalAmountInput, setTotalAmountInput] = useState<string>('185000');
  const [notesInput, setNotesInput] = useState<string>('');
  const [savingInvoice, setSavingInvoice] = useState(false);
  const [justIssuedInvoice, setJustIssuedInvoice] = useState<InvoiceRecord | null>(null);

  // Archive Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'issued' | 'cancelled'>('all');

  // Inspect / Edit / Cancel / WhatsApp Modals
  const [inspectInvoice, setInspectInvoice] = useState<InvoiceRecord | null>(null);
  const [editingInvoice, setEditingInvoice] = useState<InvoiceRecord | null>(null);
  const [editForm, setEditForm] = useState({
    issueDate: '',
    billToName: '',
    billingMonth: 1,
    billingYear: 2026,
    vehicleCount: 35,
    schoolName: DEFAULT_INVOICE_SCHOOL_NAME,
    statementText: '',
    totalAmount: '',
    notes: '',
  });
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [cancellingInvoice, setCancellingInvoice] = useState<InvoiceRecord | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [busyCancel, setBusyCancel] = useState(false);

  const [exportBusy, setExportBusy] = useState(false);

  // WhatsApp Share Modal
  const [waModalOpen, setWaModalOpen] = useState(false);
  const [waTargetInvoice, setWaTargetInvoice] = useState<InvoiceDraftInput | InvoiceRecord | null>(null);
  const [waPhone, setWaPhone] = useState('');
  const [waPreviewUrl, setWaPreviewUrl] = useState<string | null>(null);
  const [waImageBlob, setWaImageBlob] = useState<Blob | null>(null);
  const [waStatusMsg, setWaStatusMsg] = useState<string | null>(null);
  const [waCopied, setWaCopied] = useState(false);

  useEscapeKey(Boolean(inspectInvoice), () => setInspectInvoice(null));
  useEscapeKey(Boolean(editingInvoice), () => setEditingInvoice(null));
  useEscapeKey(Boolean(cancellingInvoice), () => setCancellingInvoice(null));
  useEscapeKey(waModalOpen, () => setWaModalOpen(false));

  // Revoke object URL cleanly on close/change
  useEffect(() => {
    return () => {
      if (waPreviewUrl) URL.revokeObjectURL(waPreviewUrl);
    };
  }, [waPreviewUrl]);

  // Keep statement synchronized with selected month / vehicle count / school unless manually customized
  useEffect(() => {
    if (!statementManuallyEdited) {
      setStatementText(buildDefaultInvoiceStatement(billingMonth, vehicleCount, schoolName));
    }
  }, [billingMonth, vehicleCount, schoolName, statementManuallyEdited]);

  const loadInvoices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<InvoicesApiResponse>('/api/finance/invoices');
      setInvoicesList(res.invoices || []);
      setNextNumber(res.nextNumber || 1);
      setNextCode(res.nextCode || formatInvoiceCode(res.nextNumber || 1));
      setSummary(
        res.summary || {
          totalCount: 0,
          issuedCount: 0,
          cancelledCount: 0,
          issuedTotalAmount: 0,
        }
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل سجل الفواتير');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInvoices();
  }, [loadInvoices]);

  const numericTotal = Number(totalAmountInput || 0);
  const liveTafqeet = useMemo(() => tafqeetEGP(numericTotal), [numericTotal]);

  const activeDraftPreview: InvoiceDraftInput = useMemo(
    () =>
      justIssuedInvoice || {
        invoiceCode: nextCode,
        issueDate,
        billToName,
        billingMonth,
        billingYear,
        vehicleCount,
        schoolName,
        statementText,
        totalAmount: Number.isFinite(numericTotal) && numericTotal >= 0 ? numericTotal : 0,
        amountInWords: liveTafqeet,
        status: 'issued',
      },
    [
      justIssuedInvoice,
      nextCode,
      issueDate,
      billToName,
      billingMonth,
      billingYear,
      vehicleCount,
      schoolName,
      statementText,
      numericTotal,
      liveTafqeet,
    ]
  );

  const handleResetNewDraft = () => {
    setJustIssuedInvoice(null);
    setStatementManuallyEdited(false);
    setBillToName(DEFAULT_INVOICE_BILL_TO);
    setSchoolName(DEFAULT_INVOICE_SCHOOL_NAME);
    setVehicleCount(DEFAULT_INVOICE_VEHICLE_COUNT);
    setIssueDate(getLocalTodayDateString());
    setStatementText(
      buildDefaultInvoiceStatement(billingMonth, DEFAULT_INVOICE_VEHICLE_COUNT, DEFAULT_INVOICE_SCHOOL_NAME)
    );
    setNotesInput('');
    setSuccessMsg(null);
    setError(null);
  };

  const handleIssueInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canFinanceWrite) return;
    setError(null);
    setSuccessMsg(null);

    if (!Number.isFinite(numericTotal) || numericTotal <= 0) {
      setError('يرجى إدخال قيمة إجمالية صحيحة أكبر من صفر');
      return;
    }

    setSavingInvoice(true);
    try {
      const res = await apiFetch<{
        invoice: InvoiceRecord;
        nextNumber: number;
        nextCode: string;
      }>('/api/finance/invoices', {
        method: 'POST',
        body: JSON.stringify({
          issueDate,
          billToName: billToName.trim() || DEFAULT_INVOICE_BILL_TO,
          billingMonth,
          billingYear,
          vehicleCount,
          schoolName: schoolName.trim() || DEFAULT_INVOICE_SCHOOL_NAME,
          statementText:
            statementText.trim() ||
            buildDefaultInvoiceStatement(billingMonth, vehicleCount, schoolName),
          totalAmount: numericTotal,
          notes: notesInput.trim(),
        }),
      });

      setJustIssuedInvoice(res.invoice);
      setNextNumber(res.nextNumber);
      setNextCode(res.nextCode);
      setSuccessMsg(
        `تم إصدار وحفظ الفاتورة التسلسلية رقم #${res.invoice.invoiceCode} بمبلغ ${formatEGP(
          res.invoice.totalAmount
        )} بنجاح.`
      );
      await loadInvoices();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر إصدار وحفظ الفاتورة');
    } finally {
      setSavingInvoice(false);
    }
  };

  const handlePrint = (inv: InvoiceDraftInput | InvoiceRecord) => {
    setError(null);
    try {
      printInvoiceViaIframe(inv, paperSize);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر بدء طباعة الفاتورة');
    }
  };

  const handleDownloadPdf = async (inv: InvoiceDraftInput | InvoiceRecord) => {
    setExportBusy(true);
    setError(null);
    try {
      await exportInvoiceAsPdf(inv, paperSize);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تصدير الفاتورة بصيغة PDF');
    } finally {
      setExportBusy(false);
    }
  };

  const handleDownloadPng = async (inv: InvoiceDraftInput | InvoiceRecord) => {
    setExportBusy(true);
    setError(null);
    try {
      const blob = await renderInvoiceAsPngBlob(inv, paperSize);
      downloadBlob(blob, `invoice-${inv.invoiceCode}-${paperSize}.png`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تصدير الفاتورة كصورة PNG');
    } finally {
      setExportBusy(false);
    }
  };

  const handleOpenWhatsAppModal = async (inv: InvoiceDraftInput | InvoiceRecord) => {
    setExportBusy(true);
    setError(null);
    setWaStatusMsg(null);
    setWaCopied(false);
    try {
      const blob = await renderInvoiceAsPngBlob(inv, paperSize);
      if (waPreviewUrl) URL.revokeObjectURL(waPreviewUrl);
      const url = URL.createObjectURL(blob);
      setWaTargetInvoice(inv);
      setWaImageBlob(blob);
      setWaPreviewUrl(url);
      setWaModalOpen(true);

      const copied = await copyPngBlobToClipboard(blob);
      if (copied) {
        setWaCopied(true);
        setWaStatusMsg('تم نسخ صورة الفاتورة تلقائياً — يمكنك لصقها (Ctrl+V) مباشرة داخل محادثة واتساب.');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تجهيز الفاتورة للمشاركة عبر واتساب');
    } finally {
      setExportBusy(false);
    }
  };

  const handleWebShareWa = async () => {
    if (!waImageBlob || !waTargetInvoice) return;
    const result = await shareImageFileViaWebShare(
      waImageBlob,
      `invoice-${waTargetInvoice.invoiceCode}.png`,
      `فاتورة رقم #${waTargetInvoice.invoiceCode}`,
      `فاتورة رقم #${waTargetInvoice.invoiceCode} — ${waTargetInvoice.billToName} — الإجمالي: ${formatEGP(
        waTargetInvoice.totalAmount
      )}`
    );
    if (result === 'shared') {
      setWaStatusMsg('تمت مشاركة الفاتورة بنجاح عبر قائمة المشاركة.');
    } else if (result === 'unsupported') {
      downloadBlob(waImageBlob, `invoice-${waTargetInvoice.invoiceCode}-${paperSize}.png`);
      setWaStatusMsg('المتصفح الحالي لا يدعم الإرسال المباشر — تم تنزيل صورة الفاتورة لإرفاقها يدوياً.');
    }
  };

  const openEditModal = (inv: InvoiceRecord) => {
    setEditError(null);
    setEditingInvoice(inv);
    setEditForm({
      issueDate: inv.issueDate,
      billToName: inv.billToName,
      billingMonth: inv.billingMonth,
      billingYear: inv.billingYear,
      vehicleCount: inv.vehicleCount,
      schoolName: inv.schoolName,
      statementText: inv.statementText,
      totalAmount: String(inv.totalAmount),
      notes: inv.notes || '',
    });
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingInvoice) return;
    setEditError(null);
    const numTotal = Number(editForm.totalAmount || 0);
    if (!Number.isFinite(numTotal) || numTotal <= 0) {
      setEditError('يجب أن يكون الإجمالي أكبر من صفر');
      return;
    }

    setSavingEdit(true);
    try {
      const res = await apiFetch<{ invoice: InvoiceRecord }>(
        `/api/finance/invoices/${editingInvoice.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            issueDate: editForm.issueDate,
            billToName: editForm.billToName,
            billingMonth: editForm.billingMonth,
            billingYear: editForm.billingYear,
            vehicleCount: editForm.vehicleCount,
            schoolName: editForm.schoolName,
            statementText: editForm.statementText,
            totalAmount: numTotal,
            notes: editForm.notes,
          }),
        }
      );
      setEditingInvoice(null);
      if (inspectInvoice?.id === res.invoice.id) {
        setInspectInvoice(res.invoice);
      }
      setSuccessMsg(`تم تحديث بيانات الفاتورة رقم #${res.invoice.invoiceCode} بنجاح.`);
      await loadInvoices();
    } catch (err: unknown) {
      setEditError(err instanceof Error ? err.message : 'تعذر تعديل بيانات الفاتورة');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleConfirmCancelInvoice = async () => {
    if (!cancellingInvoice) return;
    setBusyCancel(true);
    setError(null);
    try {
      const res = await apiFetch<{ invoice: InvoiceRecord }>(
        `/api/finance/invoices/${cancellingInvoice.id}/cancel`,
        {
          method: 'POST',
          body: JSON.stringify({
            reason: cancelReason.trim() || 'إلغاء محاسبي مع حفظ الرقم التسلسلي بالسجل',
          }),
        }
      );
      setCancellingInvoice(null);
      setCancelReason('');
      if (inspectInvoice?.id === res.invoice.id) {
        setInspectInvoice(res.invoice);
      }
      setSuccessMsg(
        `تم وسم الفاتورة رقم #${res.invoice.invoiceCode} كـ «ملغاة» وبقيت محفوظة في الأرشيف لحماية تسلسل الترقيم.`
      );
      await loadInvoices();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر إلغاء الفاتورة');
    } finally {
      setBusyCancel(false);
    }
  };

  const filteredArchive = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return invoicesList.filter((inv) => {
      if (statusFilter !== 'all' && inv.status !== statusFilter) return false;
      if (!q) return true;
      const hay = `${inv.invoiceCode} ${inv.billToName} ${inv.schoolName} ${inv.statementText} ${inv.issueDate} ${getArabicMonthName(
        inv.billingMonth
      )}`.toLowerCase();
      return hay.includes(q);
    });
  }, [invoicesList, searchQuery, statusFilter]);

  const whatsAppShareText = waTargetInvoice
    ? `فاتورة رقم #${waTargetInvoice.invoiceCode}\n${INVOICE_COMPANY_META.companyName}\nالمطلوب من: ${waTargetInvoice.billToName}\nالبيان: ${waTargetInvoice.statementText}\nالإجمالي: ${formatEGP(
        waTargetInvoice.totalAmount
      )}\nفقط وقدره: ${waTargetInvoice.amountInWords || tafqeetEGP(waTargetInvoice.totalAmount)}`
    : '';

  return (
    <div className="space-y-5">
      {/* Top Action Header & Sub-View Switcher */}
      <div className="bg-white border border-slate-200 rounded-xl px-5 py-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-[#0B1F3A] text-[#C89B3C] flex items-center justify-center shrink-0">
            <FileText className="w-4 h-4" />
          </div>
          <div>
            <h2 className="font-display text-base font-bold text-[#0B1F3A]">
              وحدة الفواتير الرسمية وأرشيف الفواتير الصادرة
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              إصدار فاتورة بترقيم تسلسلي غير مكرر وتفقيط تلقائي للعملة المصرية مع أرشفة دائمة
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Paper size selector */}
          <div className="inline-flex items-center rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-xs">
            <span className="px-2 text-[11px] font-semibold text-slate-500">حجم الورق:</span>
            {(['A4', 'A5'] as const).map((sz) => (
              <button
                key={sz}
                type="button"
                onClick={() => setPaperSize(sz)}
                className={`px-2.5 py-1 rounded-md font-mono font-bold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  paperSize === sz
                    ? 'bg-[#0B1F3A] text-[#C89B3C]'
                    : 'text-slate-600 hover:text-[#0B1F3A]'
                }`}
              >
                {sz}
              </button>
            ))}
          </div>

          {/* Sub-view switcher */}
          <div className="inline-flex items-center gap-1 rounded-lg bg-slate-100 p-1 text-xs">
            <button
              type="button"
              onClick={() => setView('create')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 font-bold whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                view === 'create'
                  ? 'bg-white text-[#0B1F3A] shadow-xs'
                  : 'text-slate-600 hover:text-[#0B1F3A]'
              }`}
            >
              <Plus className="w-3.5 h-3.5 text-[#C89B3C]" />
              إصدار فاتورة جديدة
            </button>
            <button
              type="button"
              onClick={() => setView('archive')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 font-bold whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                view === 'archive'
                  ? 'bg-white text-[#0B1F3A] shadow-xs'
                  : 'text-slate-600 hover:text-[#0B1F3A]'
              }`}
            >
              <FileText className="w-3.5 h-3.5 text-[#C89B3C]" />
              سجل الفواتير ({summary.totalCount})
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800 flex items-center justify-between gap-2">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-red-500 hover:text-red-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {successMsg && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-900 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
            <span className="font-semibold">{successMsg}</span>
          </div>
          <div className="flex items-center gap-2">
            {justIssuedInvoice && (
              <button
                type="button"
                onClick={handleResetNewDraft}
                className="rounded-md bg-[#0B1F3A] text-white px-3 py-1 text-[11px] font-bold hover:bg-[#13325c] whitespace-nowrap shrink-0 cursor-pointer"
              >
                فتح فاتورة جديدة (#{nextCode})
              </button>
            )}
            <button
              type="button"
              onClick={() => setSuccessMsg(null)}
              className="text-emerald-600 hover:text-emerald-900 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {view === 'create' && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          {/* Form Column */}
          <form
            onSubmit={handleIssueInvoice}
            className="xl:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4 text-xs"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="font-display text-sm font-bold text-[#0B1F3A]">
                  {justIssuedInvoice
                    ? `تم حفظ الفاتورة رقم #${justIssuedInvoice.invoiceCode}`
                    : 'بيانات الفاتورة الجديدة'}
                </h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  الترقيم التسلسلي محسوب تلقائياً: أقصى رقم محفوظ + 1
                </p>
              </div>
              <div className="rounded-lg bg-[#0B1F3A] text-[#C89B3C] px-3 py-1.5 font-mono text-sm font-extrabold tabular-nums">
                #{activeDraftPreview.invoiceCode}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  رقم الفاتورة (تلقائي مقفل)
                </label>
                <input
                  type="text"
                  readOnly
                  value={`#${activeDraftPreview.invoiceCode}`}
                  className="w-full rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 font-mono font-bold text-[#0B1F3A] cursor-not-allowed tabular-nums"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">تاريخ الإصدار *</label>
                <input
                  type="date"
                  required
                  disabled={Boolean(justIssuedInvoice)}
                  value={issueDate}
                  onChange={(e) => setIssueDate(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono disabled:bg-slate-50"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="font-semibold text-slate-700">المطلوب من *</label>
                {billToName !== DEFAULT_INVOICE_BILL_TO && !justIssuedInvoice && (
                  <button
                    type="button"
                    onClick={() => setBillToName(DEFAULT_INVOICE_BILL_TO)}
                    className="text-[11px] font-semibold text-[#0B1F3A] hover:underline cursor-pointer"
                  >
                    استعادة الافتراضي
                  </button>
                )}
              </div>
              <input
                type="text"
                required
                disabled={Boolean(justIssuedInvoice)}
                value={billToName}
                onChange={(e) => setBillToName(e.target.value)}
                placeholder={DEFAULT_INVOICE_BILL_TO}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 font-semibold text-[#0B1F3A] disabled:bg-slate-50"
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">الشهر *</label>
                <select
                  disabled={Boolean(justIssuedInvoice)}
                  value={billingMonth}
                  onChange={(e) => setBillingMonth(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 font-semibold text-[#0B1F3A] disabled:bg-slate-50"
                >
                  {Object.entries(ARABIC_MONTH_NAMES).map(([mNum, mLabel]) => (
                    <option key={mNum} value={Number(mNum)}>
                      {mNum} — {mLabel}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">السنة *</label>
                <input
                  type="number"
                  min={2020}
                  max={2099}
                  required
                  disabled={Boolean(justIssuedInvoice)}
                  value={billingYear}
                  onChange={(e) => setBillingYear(Number(e.target.value) || currentNow.getFullYear())}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-center disabled:bg-slate-50"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">عدد السيارات *</label>
                <input
                  type="number"
                  min={1}
                  max={999}
                  required
                  disabled={Boolean(justIssuedInvoice)}
                  value={vehicleCount}
                  onChange={(e) => setVehicleCount(Math.max(1, Number(e.target.value) || 1))}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-center disabled:bg-slate-50"
                />
              </div>
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">المدرسة / الجهة</label>
              <input
                type="text"
                disabled={Boolean(justIssuedInvoice)}
                value={schoolName}
                onChange={(e) => setSchoolName(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 disabled:bg-slate-50"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="font-semibold text-slate-700">البيان المحاسبي *</label>
                {statementManuallyEdited && !justIssuedInvoice && (
                  <button
                    type="button"
                    onClick={() => {
                      setStatementManuallyEdited(false);
                      setStatementText(
                        buildDefaultInvoiceStatement(billingMonth, vehicleCount, schoolName)
                      );
                    }}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#0B1F3A] hover:underline cursor-pointer"
                  >
                    <RotateCcw className="w-3 h-3" />
                    تحديث تلقائي مع الشهر
                  </button>
                )}
              </div>
              <textarea
                rows={3}
                required
                disabled={Boolean(justIssuedInvoice)}
                value={statementText}
                onChange={(e) => {
                  setStatementManuallyEdited(true);
                  setStatementText(e.target.value);
                }}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 leading-relaxed disabled:bg-slate-50"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                الإجمالي المطلوب (جنيه مصري) *
              </label>
              <input
                type="number"
                required
                min={1}
                step="0.01"
                disabled={Boolean(justIssuedInvoice)}
                value={totalAmountInput}
                onChange={(e) => setTotalAmountInput(e.target.value)}
                placeholder="مثال: 185000"
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 font-mono text-base font-bold text-[#0B1F3A] tabular-nums disabled:bg-slate-50"
              />
              <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <span className="text-[11px] text-slate-500 font-semibold">فقط وقدره: </span>
                <span className="font-bold text-[#0B1F3A]">{liveTafqeet}</span>
              </div>
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                ملاحظات إدارية داخلية (لا تظهر في طباعة الفاتورة)
              </label>
              <input
                type="text"
                disabled={Boolean(justIssuedInvoice)}
                value={notesInput}
                onChange={(e) => setNotesInput(e.target.value)}
                placeholder="اختياري للأرشفة الداخلية فقط"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 disabled:bg-slate-50"
              />
            </div>

            <div className="pt-2 flex flex-wrap gap-2">
              {canFinanceWrite && !justIssuedInvoice && (
                <button
                  type="submit"
                  disabled={savingInvoice}
                  className="flex-1 rounded-lg bg-[#0B1F3A] hover:bg-[#13325c] text-white py-2.5 px-4 font-bold whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                >
                  {savingInvoice
                    ? 'جاري الإصدار والحفظ...'
                    : `اعتماد وإصدار فاتورة رقم #${nextCode}`}
                </button>
              )}
              {justIssuedInvoice && (
                <button
                  type="button"
                  onClick={handleResetNewDraft}
                  className="flex-1 rounded-lg bg-[#C89B3C] hover:bg-[#d8ac4e] text-[#0B1F3A] py-2.5 px-4 font-bold whitespace-nowrap shrink-0 cursor-pointer"
                >
                  + إصدار فاتورة جديدة (#{nextCode})
                </button>
              )}
            </div>
          </form>

          {/* Live Preview & Export Column */}
          <div className="xl:col-span-7 space-y-3">
            <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-bold text-[#0B1F3A]">
                <Building2 className="w-4 h-4 text-[#C89B3C]" />
                <span>المعاينة الحية للفاتورة ({paperSize})</span>
                {justIssuedInvoice ? (
                  <span className="text-[11px] font-semibold text-emerald-700">· محفوظة بالسجل</span>
                ) : (
                  <span className="text-[11px] font-normal text-slate-500">· مسودة قبل الاعتماد</span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={exportBusy}
                  onClick={() => handlePrint(activeDraftPreview)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#0B1F3A] hover:bg-[#13325c] text-white px-3 py-1.5 text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                >
                  <Printer className="w-3.5 h-3.5 text-[#C89B3C]" />
                  طباعة ({paperSize})
                </button>
                <button
                  type="button"
                  disabled={exportBusy}
                  onClick={() => handleDownloadPdf(activeDraftPreview)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-[#0B1F3A] px-3 py-1.5 text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                >
                  <FileDown className="w-3.5 h-3.5 text-[#C89B3C]" />
                  PDF ({paperSize})
                </button>
                <button
                  type="button"
                  disabled={exportBusy}
                  onClick={() => handleDownloadPng(activeDraftPreview)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-[#0B1F3A] px-3 py-1.5 text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                >
                  <ImageIcon className="w-3.5 h-3.5 text-[#C89B3C]" />
                  صورة PNG
                </button>
                <button
                  type="button"
                  disabled={exportBusy}
                  onClick={() => handleOpenWhatsAppModal(activeDraftPreview)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                >
                  <MessageCircle className="w-3.5 h-3.5" />
                  واتساب
                </button>
              </div>
            </div>

            <div className="bg-slate-100/80 border border-slate-200 rounded-xl p-3 sm:p-5 overflow-x-auto">
              <InvoicePaperPreview invoice={activeDraftPreview} paperSize={paperSize} />
            </div>
          </div>
        </div>
      )}

      {view === 'archive' && (
        <div className="space-y-4">
          {/* Archive Summary Row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-[11px] text-slate-500">إجمالي الفواتير بالسجل</div>
              <div className="font-mono text-lg font-bold text-[#0B1F3A] mt-1 tabular-nums">
                {summary.totalCount}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
                الرقم التالي: #{nextCode}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-[11px] text-slate-500">فواتير صادرة معتمدة</div>
              <div className="font-mono text-lg font-bold text-emerald-700 mt-1 tabular-nums">
                {summary.issuedCount}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-[11px] text-slate-500">فواتير ملغاة (محفوظة التسلسل)</div>
              <div className="font-mono text-lg font-bold text-red-700 mt-1 tabular-nums">
                {summary.cancelledCount}
              </div>
            </div>
            <div className="bg-[#0B1F3A] text-white rounded-xl p-4">
              <div className="text-[11px] text-slate-300">إجمالي قيمة الفواتير الصادرة</div>
              <div className="font-mono text-lg font-bold text-[#C89B3C] mt-1 tabular-nums">
                {formatEGP(summary.issuedTotalAmount)}
              </div>
            </div>
          </div>

          {/* Search & Filter Toolbar */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="بحث برقم الفاتورة أو اسم الجهة المطلوب منها أو الشهر أو البيان..."
                className="w-full rounded-lg border border-slate-200 pr-9 pl-3 py-2 text-xs focus:outline-none focus:border-[#C89B3C]"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              {(
                [
                  { id: 'all', label: `الكل (${summary.totalCount})` },
                  { id: 'issued', label: `صادرة (${summary.issuedCount})` },
                  { id: 'cancelled', label: `ملغاة (${summary.cancelledCount})` },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setStatusFilter(item.id)}
                  className={`px-3 py-1.5 rounded-lg border font-semibold whitespace-nowrap shrink-0 cursor-pointer ${
                    statusFilter === item.id
                      ? 'border-[#0B1F3A] bg-[#0B1F3A] text-white'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {item.label}
                </button>
              ))}
              {canFinanceWrite && (
                <button
                  type="button"
                  onClick={() => {
                    handleResetNewDraft();
                    setView('create');
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#C89B3C] hover:bg-[#d8ac4e] text-[#0B1F3A] px-3.5 py-1.5 font-bold whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  فاتورة جديدة (#{nextCode})
                </button>
              )}
            </div>
          </div>

          {/* Archive Table */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-4">رقم الفاتورة</th>
                    <th className="py-3 px-4">التاريخ</th>
                    <th className="py-3 px-4">المطلوب من</th>
                    <th className="py-3 px-4">البيان / الشهر</th>
                    <th className="py-3 px-4">الإجمالي</th>
                    <th className="py-3 px-4">الحالة</th>
                    <th className="py-3 px-4">الإجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {loading && !invoicesList.length ? (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-slate-400">
                        جاري تحميل سجل الفواتير الصادرة...
                      </td>
                    </tr>
                  ) : !filteredArchive.length ? (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-slate-400">
                        لا توجد فواتير مطابقة لمعايير البحث الحالية.
                      </td>
                    </tr>
                  ) : (
                    filteredArchive.map((inv) => {
                      const isCancelled = inv.status === 'cancelled';
                      return (
                        <tr
                          key={inv.id}
                          className={isCancelled ? 'bg-red-50/35 text-slate-500' : 'hover:bg-slate-50'}
                        >
                          <td className="py-3 px-4 font-mono font-bold text-[#0B1F3A] tabular-nums whitespace-nowrap">
                            #{inv.invoiceCode}
                          </td>
                          <td className="py-3 px-4 font-mono tabular-nums whitespace-nowrap">
                            {inv.issueDate}
                          </td>
                          <td className="py-3 px-4 font-semibold text-slate-900 min-w-[180px]">
                            {inv.billToName}
                          </td>
                          <td className="py-3 px-4 max-w-md">
                            <div className="font-semibold text-[#0B1F3A]">
                              شهر {getArabicMonthName(inv.billingMonth)} {inv.billingYear} ·{' '}
                              {inv.vehicleCount} سيارة
                            </div>
                            <div className="text-[11px] text-slate-500 line-clamp-2 mt-0.5">
                              {inv.statementText}
                            </div>
                          </td>
                          <td
                            className={`py-3 px-4 font-mono font-bold tabular-nums whitespace-nowrap ${
                              isCancelled ? 'line-through text-red-700' : 'text-[#0B1F3A]'
                            }`}
                          >
                            {formatEGP(inv.totalAmount)}
                          </td>
                          <td className="py-3 px-4 whitespace-nowrap">
                            {isCancelled ? (
                              <div>
                                <span className="inline-block rounded-md border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-bold text-red-700">
                                  ملغاة
                                </span>
                                {inv.cancelledReason && (
                                  <div className="text-[10px] text-red-600 mt-0.5 max-w-[140px] truncate">
                                    {inv.cancelledReason}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span className="inline-block rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700">
                                صادرة
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => setInspectInvoice(inv)}
                                className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white hover:bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-[#0B1F3A] whitespace-nowrap shrink-0 cursor-pointer"
                              >
                                <Eye className="w-3 h-3 text-[#C89B3C]" />
                                معاينة
                              </button>
                              <button
                                type="button"
                                onClick={() => handlePrint(inv)}
                                className="inline-flex items-center gap-1 rounded-md bg-[#0B1F3A] hover:bg-[#13325c] px-2.5 py-1 text-[11px] font-semibold text-white whitespace-nowrap shrink-0 cursor-pointer"
                              >
                                <Printer className="w-3 h-3 text-[#C89B3C]" />
                                طباعة
                              </button>
                              <button
                                type="button"
                                disabled={exportBusy}
                                onClick={() => handleDownloadPdf(inv)}
                                className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white hover:bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-[#0B1F3A] whitespace-nowrap shrink-0 cursor-pointer"
                              >
                                <FileDown className="w-3 h-3 text-[#C89B3C]" />
                                PDF
                              </button>
                              <button
                                type="button"
                                disabled={exportBusy}
                                onClick={() => handleOpenWhatsAppModal(inv)}
                                className="inline-flex items-center gap-1 rounded-md bg-emerald-600 hover:bg-emerald-700 px-2.5 py-1 text-[11px] font-semibold text-white whitespace-nowrap shrink-0 cursor-pointer"
                              >
                                <MessageCircle className="w-3 h-3" />
                                واتساب
                              </button>
                              {canFinanceWrite && !isCancelled && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => openEditModal(inv)}
                                    className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 hover:bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-[#0B1F3A] whitespace-nowrap shrink-0 cursor-pointer"
                                  >
                                    <Edit3 className="w-3 h-3" />
                                    تعديل
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setCancelReason('');
                                      setCancellingInvoice(inv);
                                    }}
                                    className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 hover:bg-red-100 px-2.5 py-1 text-[11px] font-semibold text-red-700 whitespace-nowrap shrink-0 cursor-pointer"
                                  >
                                    <Ban className="w-3 h-3" />
                                    إلغاء
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-200 text-[11px] text-slate-500">
              ملاحظة محاسبية: الفواتير الملغاة تبقى محفوظة في السجل تحت حالة «ملغاة» لضمان عدم تكرار أو سقوط أي رقم تسلسلي.
            </div>
          </div>
        </div>
      )}

      {/* Inspect Full Invoice Modal */}
      {inspectInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 p-3 sm:p-5 backdrop-blur-xs">
          <div className="w-full max-w-4xl max-h-[92vh] bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden flex flex-col">
            <div className="px-5 py-3.5 bg-[#0B1F3A] text-white flex flex-wrap items-center justify-between gap-2 shrink-0">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-[#C89B3C]" />
                <span className="font-display font-bold text-sm">
                  فاتورة رقم #{inspectInvoice.invoiceCode} ({paperSize})
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => handlePrint(inspectInvoice)}
                  className="inline-flex items-center gap-1 rounded-lg bg-[#C89B3C] text-[#0B1F3A] px-3 py-1.5 text-xs font-bold whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Printer className="w-3.5 h-3.5" />
                  طباعة ({paperSize})
                </button>
                <button
                  type="button"
                  disabled={exportBusy}
                  onClick={() => handleDownloadPdf(inspectInvoice)}
                  className="inline-flex items-center gap-1 rounded-lg bg-white/10 hover:bg-white/20 text-white px-3 py-1.5 text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <FileDown className="w-3.5 h-3.5" />
                  PDF
                </button>
                <button
                  type="button"
                  disabled={exportBusy}
                  onClick={() => handleDownloadPng(inspectInvoice)}
                  className="inline-flex items-center gap-1 rounded-lg bg-white/10 hover:bg-white/20 text-white px-3 py-1.5 text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <ImageIcon className="w-3.5 h-3.5" />
                  PNG
                </button>
                <button
                  type="button"
                  disabled={exportBusy}
                  onClick={() => handleOpenWhatsAppModal(inspectInvoice)}
                  className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <MessageCircle className="w-3.5 h-3.5" />
                  واتساب
                </button>
                <button
                  type="button"
                  onClick={() => setInspectInvoice(null)}
                  aria-label="إغلاق المعاينة"
                  className="p-1 text-slate-300 hover:text-white cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="p-4 sm:p-6 overflow-y-auto bg-slate-100">
              <InvoicePaperPreview invoice={inspectInvoice} paperSize={paperSize} />
            </div>
          </div>
        </div>
      )}

      {/* Edit Issued Invoice Modal */}
      {editingInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-xl bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
            <div className="px-5 py-3.5 bg-[#0B1F3A] text-white flex items-center justify-between">
              <h3 className="font-display text-sm font-bold">
                تعديل الفاتورة رقم #{editingInvoice.invoiceCode}
              </h3>
              <button
                type="button"
                onClick={() => setEditingInvoice(null)}
                className="cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveEdit} className="p-5 space-y-3 text-xs">
              {editError && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-red-800">
                  {editError}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">تاريخ الإصدار</label>
                  <input
                    type="date"
                    required
                    value={editForm.issueDate}
                    onChange={(e) => setEditForm({ ...editForm, issueDate: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">عدد السيارات</label>
                  <input
                    type="number"
                    min={1}
                    required
                    value={editForm.vehicleCount}
                    onChange={(e) =>
                      setEditForm({ ...editForm, vehicleCount: Math.max(1, Number(e.target.value) || 1) })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">المطلوب من</label>
                <input
                  type="text"
                  required
                  value={editForm.billToName}
                  onChange={(e) => setEditForm({ ...editForm, billToName: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 font-semibold"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">الشهر</label>
                  <select
                    value={editForm.billingMonth}
                    onChange={(e) => {
                      const nextM = Number(e.target.value);
                      setEditForm((prev) => ({
                        ...prev,
                        billingMonth: nextM,
                        statementText: buildDefaultInvoiceStatement(
                          nextM,
                          prev.vehicleCount,
                          prev.schoolName
                        ),
                      }));
                    }}
                    className="w-full rounded-lg border border-slate-200 bg-white px-2 py-2"
                  >
                    {Object.entries(ARABIC_MONTH_NAMES).map(([mNum, mLabel]) => (
                      <option key={mNum} value={Number(mNum)}>
                        {mNum} — {mLabel}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">السنة</label>
                  <input
                    type="number"
                    min={2020}
                    max={2099}
                    required
                    value={editForm.billingYear}
                    onChange={(e) =>
                      setEditForm({ ...editForm, billingYear: Number(e.target.value) || 2026 })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">المدرسة</label>
                  <input
                    type="text"
                    value={editForm.schoolName}
                    onChange={(e) => setEditForm({ ...editForm, schoolName: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">البيان المحاسبي</label>
                <textarea
                  rows={3}
                  required
                  value={editForm.statementText}
                  onChange={(e) => setEditForm({ ...editForm, statementText: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 leading-relaxed"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">الإجمالي (ج.م)</label>
                <input
                  type="number"
                  step="0.01"
                  min={1}
                  required
                  value={editForm.totalAmount}
                  onChange={(e) => setEditForm({ ...editForm, totalAmount: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono font-bold"
                />
                <div className="mt-1.5 text-[11px] text-[#0B1F3A] font-semibold">
                  فقط وقدره: {tafqeetEGP(Number(editForm.totalAmount || 0))}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  disabled={savingEdit}
                  onClick={() => setEditingInvoice(null)}
                  className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 cursor-pointer"
                >
                  إغلاق
                </button>
                <button
                  type="submit"
                  disabled={savingEdit}
                  className="rounded-lg bg-[#0B1F3A] px-5 py-2 font-bold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
                >
                  {savingEdit ? 'جاري الحفظ...' : 'حفظ التعديلات'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Cancel Invoice Confirmation Modal (No Hard Delete) */}
      {cancellingInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md bg-white rounded-2xl border border-red-200 shadow-xl p-6 space-y-4 text-xs">
            <div className="flex items-center gap-2 text-red-700">
              <Ban className="w-5 h-5" />
              <h3 className="font-display text-base font-bold">
                تأكيد إلغاء الفاتورة رقم #{cancellingInvoice.invoiceCode}
              </h3>
            </div>
            <p className="text-slate-600 leading-relaxed">
              لن يتم حذف الفاتورة من قاعدة البيانات حفاظاً على التسلسل المحاسبي؛ بل ستتحول حالتها في سجل الفواتير إلى{' '}
              <strong className="text-red-700">«ملغاة»</strong> وتُخصم من إجمالي الفواتير المعتمدة.
            </p>
            <div>
              <label className="block font-semibold text-slate-700 mb-1">سبب الإلغاء</label>
              <input
                type="text"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="مثال: تصحيح بيانات الشهر وإعادة الإصدار برقم جديد"
                className="w-full rounded-lg border border-slate-200 px-3 py-2"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                disabled={busyCancel}
                onClick={() => setCancellingInvoice(null)}
                className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 cursor-pointer"
              >
                تراجع
              </button>
              <button
                type="button"
                disabled={busyCancel}
                onClick={handleConfirmCancelInvoice}
                className="rounded-lg bg-red-600 px-4 py-2 font-bold text-white hover:bg-red-700 disabled:opacity-50 cursor-pointer"
              >
                {busyCancel ? 'جاري الإلغاء...' : 'تأكيد وسم الفاتورة كـ «ملغاة»'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* WhatsApp Share Modal */}
      {waModalOpen && waTargetInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 p-4 backdrop-blur-xs">
          <div className="w-full max-w-lg bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-5 py-3.5 bg-[#0B1F3A] text-white flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <MessageCircle className="w-4 h-4 text-emerald-400" />
                <span className="font-display font-bold text-sm">
                  إرسال فاتورة #{waTargetInvoice.invoiceCode} عبر واتساب
                </span>
              </div>
              <button
                type="button"
                onClick={() => setWaModalOpen(false)}
                className="cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-4 overflow-y-auto text-xs">
              {waStatusMsg && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-900 font-semibold">
                  {waStatusMsg}
                </div>
              )}

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  رقم واتساب المستلم (اختياري — مثال: 010xxxxxxxx)
                </label>
                <input
                  type="tel"
                  dir="ltr"
                  value={waPhone}
                  onChange={(e) => setWaPhone(e.target.value)}
                  placeholder="01016815939"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                />
              </div>

              {waPreviewUrl && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-2 max-h-64 overflow-y-auto">
                  <img
                    src={waPreviewUrl}
                    alt={`معاينة الفاتورة #${waTargetInvoice.invoiceCode}`}
                    className="w-full h-auto rounded-lg"
                  />
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    if (!waImageBlob) return;
                    const ok = await copyPngBlobToClipboard(waImageBlob);
                    setWaCopied(ok);
                    setWaStatusMsg(
                      ok
                        ? 'تم نسخ صورة الفاتورة للحافظة.'
                        : 'لم يدعم المتصفح نسخ الصورة مباشرة — يمكنك تحميلها أدناه.'
                    );
                  }}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 py-2 px-3 font-bold text-[#0B1F3A] cursor-pointer"
                >
                  {waCopied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  {waCopied ? 'تم نسخ الصورة' : 'نسخ صورة الفاتورة'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!waImageBlob) return;
                    downloadBlob(waImageBlob, `invoice-${waTargetInvoice.invoiceCode}-${paperSize}.png`);
                  }}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 py-2 px-3 font-bold text-[#0B1F3A] cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 text-[#C89B3C]" />
                  تنزيل الصورة
                </button>
              </div>

              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleWebShareWa}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#0B1F3A] hover:bg-[#13325c] text-white py-2.5 px-3 font-bold cursor-pointer"
                >
                  <Share2 className="w-3.5 h-3.5 text-[#C89B3C]" />
                  مشاركة مباشرة كصورة
                </button>
                <a
                  href={buildWhatsAppUrl(waPhone, whatsAppShareText)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white py-2.5 px-3 font-bold text-center"
                >
                  <MessageCircle className="w-3.5 h-3.5" />
                  فتح محادثة واتساب
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
