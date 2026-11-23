import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  BookOpen,
  CheckCircle2,
  Clock,
  Coins,
  Edit3,
  Eye,
  FileSpreadsheet,
  HandCoins,
  Layers,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Trash2,
  Wallet,
  X,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import {
  apiFetch,
  exportRowsToExcel,
  formatEGP,
  getLocalTodayDateString,
  normalizeLookupText,
} from '../../lib/api';
import { useEscapeKey } from '../../lib/useEscapeKey';
import type {
  CustodyLookupData,
  ExternalAccountEntryRecord,
  ExternalAccountEntryType,
  ExternalAccountKind,
  ExternalAccountPartyType,
  ExternalAccountRecord,
  ExternalAccountsStats,
  FinancialCustodyRecord,
  FinancialCustodyStats,
} from '../../types';

export type CustodiesSectionTab = 'custodies' | 'debts' | 'external';

interface CustodiesAndExternalAccountsModuleProps {
  initialSection?: CustodiesSectionTab;
}

const CUSTODY_PURPOSE_PRESETS = [
  'مصاريف شخصية وإكراميات',
  'مصاريف تشغيل وبنزين',
  'صيانة طارئة وقطع غيار',
  'مصاريف رحلة خاصة',
  'مصاريف نثرية وطوارئ',
];

const EXTERNAL_CATEGORIES = [
  'مصاريف شخصية وإكراميات',
  'صيانة وقطع غيار',
  'وقود وسولار',
  'رحلات خاصة وتأجير',
  'سلف وتسهيلات خارجية',
  'إيجارات ومصروفات إدارية',
  'تسويات شركاء وأفراد',
  'مصاريف نثرية وطوارئ',
  'أخرى',
];

const PAYMENT_METHODS = ['كاش', 'تحويل بنكي', 'إنستاباي / محفظة', 'شيك', 'مقاصة'];

function escapeHtml(val: string | number | null | undefined): string {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function printHtmlViaHiddenIframe(html: string): void {
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
    throw new Error('تعذر تهيئة نافذة الطباعة');
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

function daysBetweenDates(startIso: string, endIso: string): number {
  const s = new Date(`${startIso}T00:00:00`);
  const e = new Date(`${endIso}T00:00:00`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 0;
  return Math.max(0, Math.floor((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)));
}

export const CustodiesAndExternalAccountsModule: React.FC<
  CustodiesAndExternalAccountsModuleProps
> = ({ initialSection = 'custodies' }) => {
  const { dbUser } = useAuth();
  const perms = dbUser?.permissions || [];
  const isSuperAdmin = dbUser?.roleSlug === 'super_admin' || perms.includes('*');
  const canWrite = isSuperAdmin || perms.includes('*') || perms.includes('finance:write');

  const [section, setSection] = useState<CustodiesSectionTab>(initialSection);
  const [lookups, setLookups] = useState<CustodyLookupData>({
    schools: [],
    drivers: [],
    supervisors: [],
    employees: [],
  });

  // Global feedback
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Custodies state
  const [custodies, setCustodies] = useState<FinancialCustodyRecord[]>([]);
  const [custodyStats, setCustodyStats] = useState<FinancialCustodyStats | null>(null);
  const [custodiesLoading, setCustodiesLoading] = useState(true);
  const [custodyStatusFilter, setCustodyStatusFilter] = useState<string>('all');
  const [custodyTypeFilter, setCustodyTypeFilter] = useState<string>('all');
  const [custodyPurposeFilter, setCustodyPurposeFilter] = useState<string>('all');
  const [custodySearch, setCustodySearch] = useState<string>('');

  // External accounts & Debts state
  const [accounts, setAccounts] = useState<ExternalAccountRecord[]>([]);
  const [accountStats, setAccountStats] = useState<ExternalAccountsStats | null>(null);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [debtKindFilter, setDebtKindFilter] = useState<'all' | 'debt_receivable' | 'debt_payable'>(
    'all'
  );
  const [accountStatusFilter, setAccountStatusFilter] = useState<string>('all');
  const [accountSearch, setAccountSearch] = useState<string>('');

  // New Custody Modal
  const [newCustodyOpen, setNewCustodyOpen] = useState(false);
  const [newCustodyForm, setNewCustodyForm] = useState({
    beneficiaryType: 'driver' as 'driver' | 'supervisor' | 'employee' | 'other',
    driverId: '',
    supervisorId: '',
    employeeId: '',
    beneficiaryName: '',
    beneficiaryPhone: '',
    schoolId: '',
    amount: '',
    handoverDate: getLocalTodayDateString(),
    purpose: '',
    paymentMethod: 'كاش',
    handedByName: dbUser?.fullName || 'الإدارة المالية',
    notes: '',
  });
  const [savingCustody, setSavingCustody] = useState(false);
  const [custodyModalError, setCustodyModalError] = useState<string | null>(null);

  // Settle Custody Modal
  const [settlingCustody, setSettlingCustody] = useState<FinancialCustodyRecord | null>(null);
  const [settleForm, setSettleForm] = useState({
    spentAmount: '',
    returnedAmount: '',
    settlementDate: getLocalTodayDateString(),
    settledByName: dbUser?.fullName || 'الإدارة المالية',
    notes: '',
  });
  const [savingSettle, setSavingSettle] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);

  // Edit / Delete Custody Modals
  const [editingCustody, setEditingCustody] = useState<FinancialCustodyRecord | null>(null);
  const [editCustodyForm, setEditCustodyForm] = useState({
    beneficiaryName: '',
    beneficiaryPhone: '',
    schoolId: '',
    amount: '',
    handoverDate: '',
    purpose: '',
    paymentMethod: 'كاش',
    handedByName: '',
    notes: '',
  });
  const [deletingCustody, setDeletingCustody] = useState<FinancialCustodyRecord | null>(null);

  // Create / Edit External Account or Debt Modal
  const [accountModalMode, setAccountModalMode] = useState<'create' | 'edit' | null>(null);
  const [editingAccount, setEditingAccount] = useState<ExternalAccountRecord | null>(null);
  const [accountForm, setAccountForm] = useState({
    accountKind: 'debt_receivable' as ExternalAccountKind,
    category: 'سلف وتسهيلات خارجية',
    partyType: 'external' as ExternalAccountPartyType,
    driverId: '',
    supervisorId: '',
    employeeId: '',
    schoolId: '',
    partyName: '',
    partyPhone: '',
    title: '',
    principalAmount: '',
    initialSettledAmount: '',
    openedDate: getLocalTodayDateString(),
    dueDate: '',
    paymentMethod: 'كاش',
    notes: '',
  });
  const [savingAccount, setSavingAccount] = useState(false);
  const [accountModalError, setAccountModalError] = useState<string | null>(null);

  // Add Entry / Payment Modal
  const [entryTargetAccount, setEntryTargetAccount] = useState<ExternalAccountRecord | null>(null);
  const [entryForm, setEntryForm] = useState({
    entryType: 'payment' as ExternalAccountEntryType,
    amount: '',
    entryDate: getLocalTodayDateString(),
    paymentMethod: 'كاش',
    notes: '',
  });
  const [savingEntry, setSavingEntry] = useState(false);
  const [entryError, setEntryError] = useState<string | null>(null);

  // Detail Statement Modal
  const [detailAccount, setDetailAccount] = useState<ExternalAccountRecord | null>(null);
  const [detailEntries, setDetailEntries] = useState<ExternalAccountEntryRecord[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  // Delete External Account Confirmation
  const [deletingAccount, setDeletingAccount] = useState<ExternalAccountRecord | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);

  useEscapeKey(
    Boolean(
      newCustodyOpen ||
        settlingCustody ||
        editingCustody ||
        deletingCustody ||
        accountModalMode ||
        entryTargetAccount ||
        detailAccount ||
        deletingAccount
    ),
    () => {
      if (entryTargetAccount) setEntryTargetAccount(null);
      else if (detailAccount) setDetailAccount(null);
      else if (accountModalMode) setAccountModalMode(null);
      else if (deletingAccount) setDeletingAccount(null);
      else if (settlingCustody) setSettlingCustody(null);
      else if (editingCustody) setEditingCustody(null);
      else if (deletingCustody) setDeletingCustody(null);
      else if (newCustodyOpen) setNewCustodyOpen(false);
    }
  );

  const loadLookups = useCallback(async () => {
    try {
      const res = await apiFetch<CustodyLookupData>('/api/finance/custodies-lookups');
      setLookups(res);
    } catch {
      // non-blocking
    }
  }, []);

  const loadCustodies = useCallback(async () => {
    setCustodiesLoading(true);
    try {
      const res = await apiFetch<{
        custodies: FinancialCustodyRecord[];
        stats: FinancialCustodyStats;
      }>('/api/finance/custodies');
      setCustodies(res.custodies || []);
      setCustodyStats(res.stats || null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل العهد المالية');
    } finally {
      setCustodiesLoading(false);
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true);
    try {
      const res = await apiFetch<{
        accounts: ExternalAccountRecord[];
        stats: ExternalAccountsStats;
      }>('/api/finance/external-accounts');
      setAccounts(res.accounts || []);
      setAccountStats(res.stats || null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل المديونيات والحسابات الخارجية');
    } finally {
      setAccountsLoading(false);
    }
  }, []);

  const reloadAll = useCallback(async () => {
    setError(null);
    await Promise.all([loadCustodies(), loadAccounts()]);
  }, [loadCustodies, loadAccounts]);

  useEffect(() => {
    loadLookups();
    reloadAll();
  }, [loadLookups, reloadAll]);

  const todayIso = getLocalTodayDateString();

  // Overdue custodies (> 7 days active/partial)
  const overdueCustodies = useMemo(
    () =>
      custodies.filter(
        (c) => c.status !== 'settled' && daysBetweenDates(c.handoverDate, todayIso) >= 7
      ),
    [custodies, todayIso]
  );

  const personalTipsCustodyTotal = useMemo(
    () =>
      custodies
        .filter((c) => {
          const norm = normalizeLookupText(c.purpose);
          return norm.includes('شخصية') || norm.includes('اكراميات') || norm.includes('إكراميات');
        })
        .reduce((sum, c) => sum + Number(c.amount || 0), 0),
    [custodies]
  );

  const filteredCustodies = useMemo(() => {
    const q = normalizeLookupText(custodySearch);
    return custodies.filter((c) => {
      if (custodyStatusFilter !== 'all' && c.status !== custodyStatusFilter) return false;
      if (custodyTypeFilter !== 'all' && c.beneficiaryType !== custodyTypeFilter) return false;
      if (custodyPurposeFilter === 'personal_tips') {
        const pNorm = normalizeLookupText(c.purpose);
        if (!pNorm.includes('شخصية') && !pNorm.includes('اكراميات') && !pNorm.includes('إكراميات')) {
          return false;
        }
      } else if (custodyPurposeFilter !== 'all') {
        if (normalizeLookupText(c.purpose) !== normalizeLookupText(custodyPurposeFilter)) {
          return false;
        }
      }
      if (q) {
        const hay = normalizeLookupText(
          `${c.custodyCode} ${c.beneficiaryName} ${c.beneficiaryPhone} ${c.purpose} ${c.schoolName} ${c.notes}`
        );
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [custodies, custodyStatusFilter, custodyTypeFilter, custodyPurposeFilter, custodySearch]);

  const debtAccounts = useMemo(() => {
    const q = normalizeLookupText(accountSearch);
    return accounts.filter((a) => {
      if (a.accountKind !== 'debt_receivable' && a.accountKind !== 'debt_payable') return false;
      if (debtKindFilter !== 'all' && a.accountKind !== debtKindFilter) return false;
      if (accountStatusFilter === 'overdue') {
        if (!a.isOverdue) return false;
      } else if (accountStatusFilter !== 'all' && a.status !== accountStatusFilter) {
        return false;
      }
      if (q) {
        const hay = normalizeLookupText(
          `${a.accountCode} ${a.partyName} ${a.partyPhone} ${a.title} ${a.category} ${a.notes}`
        );
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [accounts, debtKindFilter, accountStatusFilter, accountSearch]);

  const externalOnlyAccounts = useMemo(() => {
    const q = normalizeLookupText(accountSearch);
    return accounts.filter((a) => {
      if (a.accountKind !== 'external_account') return false;
      if (accountStatusFilter === 'overdue') {
        if (!a.isOverdue) return false;
      } else if (accountStatusFilter !== 'all' && a.status !== accountStatusFilter) {
        return false;
      }
      if (q) {
        const hay = normalizeLookupText(
          `${a.accountCode} ${a.partyName} ${a.partyPhone} ${a.title} ${a.category} ${a.notes}`
        );
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [accounts, accountStatusFilter, accountSearch]);

  const totalDebtsCount = useMemo(
    () =>
      accounts.filter(
        (a) => a.accountKind === 'debt_receivable' || a.accountKind === 'debt_payable'
      ).length,
    [accounts]
  );
  const totalExternalOnlyCount = useMemo(
    () => accounts.filter((a) => a.accountKind === 'external_account').length,
    [accounts]
  );

  // --- Custody Handlers ---
  const openCreateCustodyModal = () => {
    setCustodyModalError(null);
    setNewCustodyForm({
      beneficiaryType: 'driver',
      driverId: '',
      supervisorId: '',
      employeeId: '',
      beneficiaryName: '',
      beneficiaryPhone: '',
      schoolId: '',
      amount: '',
      handoverDate: getLocalTodayDateString(),
      purpose: '',
      paymentMethod: 'كاش',
      handedByName: dbUser?.fullName || 'الإدارة المالية',
      notes: '',
    });
    setNewCustodyOpen(true);
  };

  const handleSelectCustodyBeneficiary = (
    type: 'driver' | 'supervisor' | 'employee' | 'other',
    idStr: string
  ) => {
    if (type === 'driver') {
      const d = lookups.drivers.find((x) => String(x.id) === idStr);
      setNewCustodyForm((f) => ({
        ...f,
        driverId: idStr,
        beneficiaryName: d ? d.fullName : '',
        beneficiaryPhone: d?.phone || '',
        schoolId: d?.schoolId ? String(d.schoolId) : f.schoolId,
      }));
    } else if (type === 'supervisor') {
      const sv = lookups.supervisors.find((x) => String(x.id) === idStr);
      setNewCustodyForm((f) => ({
        ...f,
        supervisorId: idStr,
        beneficiaryName: sv ? sv.fullName : '',
        beneficiaryPhone: sv?.phone || '',
        schoolId: sv?.schoolId ? String(sv.schoolId) : f.schoolId,
      }));
    } else if (type === 'employee') {
      const em = lookups.employees.find((x) => String(x.id) === idStr);
      setNewCustodyForm((f) => ({
        ...f,
        employeeId: idStr,
        beneficiaryName: em ? em.fullName : '',
        beneficiaryPhone: em?.phone || '',
        schoolId: em?.schoolId ? String(em.schoolId) : f.schoolId,
      }));
    }
  };

  const handleCreateCustody = async (e: React.FormEvent) => {
    e.preventDefault();
    setCustodyModalError(null);
    setSavingCustody(true);
    try {
      await apiFetch('/api/finance/custodies', {
        method: 'POST',
        body: JSON.stringify({
          beneficiaryType: newCustodyForm.beneficiaryType,
          driverId:
            newCustodyForm.beneficiaryType === 'driver' && newCustodyForm.driverId
              ? Number(newCustodyForm.driverId)
              : null,
          supervisorId:
            newCustodyForm.beneficiaryType === 'supervisor' && newCustodyForm.supervisorId
              ? Number(newCustodyForm.supervisorId)
              : null,
          employeeId:
            newCustodyForm.beneficiaryType === 'employee' && newCustodyForm.employeeId
              ? Number(newCustodyForm.employeeId)
              : null,
          beneficiaryName: newCustodyForm.beneficiaryName.trim(),
          beneficiaryPhone: newCustodyForm.beneficiaryPhone.trim(),
          schoolId: newCustodyForm.schoolId ? Number(newCustodyForm.schoolId) : null,
          amount: Number(newCustodyForm.amount),
          handoverDate: newCustodyForm.handoverDate,
          purpose: newCustodyForm.purpose.trim(),
          paymentMethod: newCustodyForm.paymentMethod,
          handedByName: newCustodyForm.handedByName.trim(),
          notes: newCustodyForm.notes.trim(),
        }),
      });
      setNewCustodyOpen(false);
      setSuccessMsg('تم تسجيل تسليم العهدة المالية بنجاح.');
      await loadCustodies();
    } catch (err: unknown) {
      setCustodyModalError(err instanceof Error ? err.message : 'تعذر تسجيل العهدة');
    } finally {
      setSavingCustody(false);
    }
  };

  const openSettleModal = (c: FinancialCustodyRecord) => {
    setSettleError(null);
    setSettlingCustody(c);
    setSettleForm({
      spentAmount: String(c.spentAmount || 0),
      returnedAmount: String(c.returnedAmount || 0),
      settlementDate: c.settlementDate || getLocalTodayDateString(),
      settledByName: dbUser?.fullName || 'الإدارة المالية',
      notes: '',
    });
  };

  const handleSettleCustody = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settlingCustody) return;
    setSettleError(null);
    setSavingSettle(true);
    try {
      await apiFetch(`/api/finance/custodies/${settlingCustody.id}/settle`, {
        method: 'POST',
        body: JSON.stringify({
          spentAmount: Number(settleForm.spentAmount || 0),
          returnedAmount: Number(settleForm.returnedAmount || 0),
          settlementDate: settleForm.settlementDate,
          settledByName: settleForm.settledByName.trim(),
          notes: settleForm.notes.trim(),
        }),
      });
      setSettlingCustody(null);
      setSuccessMsg(`تم حفظ تصفية العهدة (${settlingCustody.custodyCode}) بنجاح.`);
      await loadCustodies();
    } catch (err: unknown) {
      setSettleError(err instanceof Error ? err.message : 'تعذر تصفية العهدة');
    } finally {
      setSavingSettle(false);
    }
  };

  const openEditCustodyModal = (c: FinancialCustodyRecord) => {
    setCustodyModalError(null);
    setEditingCustody(c);
    setEditCustodyForm({
      beneficiaryName: c.beneficiaryName,
      beneficiaryPhone: c.beneficiaryPhone || '',
      schoolId: c.schoolId ? String(c.schoolId) : '',
      amount: String(c.amount),
      handoverDate: c.handoverDate,
      purpose: c.purpose,
      paymentMethod: c.paymentMethod || 'كاش',
      handedByName: c.handedByName || '',
      notes: c.notes || '',
    });
  };

  const handleUpdateCustody = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingCustody) return;
    setCustodyModalError(null);
    setSavingCustody(true);
    try {
      await apiFetch(`/api/finance/custodies/${editingCustody.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          beneficiaryName: editCustodyForm.beneficiaryName.trim(),
          beneficiaryPhone: editCustodyForm.beneficiaryPhone.trim(),
          schoolId: editCustodyForm.schoolId ? Number(editCustodyForm.schoolId) : null,
          amount: Number(editCustodyForm.amount),
          handoverDate: editCustodyForm.handoverDate,
          purpose: editCustodyForm.purpose.trim(),
          paymentMethod: editCustodyForm.paymentMethod,
          handedByName: editCustodyForm.handedByName.trim(),
          notes: editCustodyForm.notes.trim(),
        }),
      });
      setEditingCustody(null);
      setSuccessMsg('تم تعديل بيانات العهدة بنجاح.');
      await loadCustodies();
    } catch (err: unknown) {
      setCustodyModalError(err instanceof Error ? err.message : 'تعذر تعديل العهدة');
    } finally {
      setSavingCustody(false);
    }
  };

  const handleDeleteCustody = async () => {
    if (!deletingCustody) return;
    setDeletingBusy(true);
    try {
      await apiFetch(`/api/finance/custodies/${deletingCustody.id}`, { method: 'DELETE' });
      setDeletingCustody(null);
      setSuccessMsg('تم حذف العهدة المالية من السجل.');
      await loadCustodies();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر حذف العهدة');
    } finally {
      setDeletingBusy(false);
    }
  };

  // --- External Accounts / Debts Handlers ---
  const openCreateAccountModal = (defaultKind: ExternalAccountKind) => {
    setAccountModalError(null);
    setEditingAccount(null);
    setAccountForm({
      accountKind: defaultKind,
      category:
        defaultKind === 'external_account' ? 'مصاريف نثرية وطوارئ' : 'سلف وتسهيلات خارجية',
      partyType: 'external',
      driverId: '',
      supervisorId: '',
      employeeId: '',
      schoolId: '',
      partyName: '',
      partyPhone: '',
      title: '',
      principalAmount: '',
      initialSettledAmount: '',
      openedDate: getLocalTodayDateString(),
      dueDate: '',
      paymentMethod: 'كاش',
      notes: '',
    });
    setAccountModalMode('create');
  };

  const openEditAccountModal = (acc: ExternalAccountRecord) => {
    setAccountModalError(null);
    setEditingAccount(acc);
    setAccountForm({
      accountKind: acc.accountKind,
      category: acc.category || 'أخرى',
      partyType: acc.partyType || 'external',
      driverId: acc.driverId ? String(acc.driverId) : '',
      supervisorId: acc.supervisorId ? String(acc.supervisorId) : '',
      employeeId: acc.employeeId ? String(acc.employeeId) : '',
      schoolId: acc.schoolId ? String(acc.schoolId) : '',
      partyName: acc.partyName,
      partyPhone: acc.partyPhone || '',
      title: acc.title,
      principalAmount: String(acc.principalAmount),
      initialSettledAmount: String(acc.settledAmount),
      openedDate: acc.openedDate,
      dueDate: acc.dueDate || '',
      paymentMethod: acc.paymentMethod || 'كاش',
      notes: acc.notes || '',
    });
    setAccountModalMode('edit');
  };

  const handleSelectAccountParty = (partyType: ExternalAccountPartyType, idStr: string) => {
    if (partyType === 'driver') {
      const d = lookups.drivers.find((x) => String(x.id) === idStr);
      setAccountForm((f) => ({
        ...f,
        driverId: idStr,
        partyName: d ? d.fullName : '',
        partyPhone: d?.phone || '',
        schoolId: d?.schoolId ? String(d.schoolId) : f.schoolId,
      }));
    } else if (partyType === 'supervisor') {
      const sv = lookups.supervisors.find((x) => String(x.id) === idStr);
      setAccountForm((f) => ({
        ...f,
        supervisorId: idStr,
        partyName: sv ? sv.fullName : '',
        partyPhone: sv?.phone || '',
        schoolId: sv?.schoolId ? String(sv.schoolId) : f.schoolId,
      }));
    } else if (partyType === 'employee') {
      const em = lookups.employees.find((x) => String(x.id) === idStr);
      setAccountForm((f) => ({
        ...f,
        employeeId: idStr,
        partyName: em ? em.fullName : '',
        partyPhone: em?.phone || '',
        schoolId: em?.schoolId ? String(em.schoolId) : f.schoolId,
      }));
    } else if (partyType === 'school') {
      const sc = lookups.schools.find((x) => String(x.id) === idStr);
      setAccountForm((f) => ({
        ...f,
        schoolId: idStr,
        partyName: sc ? sc.name : '',
      }));
    }
  };

  const handleSaveAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setAccountModalError(null);
    setSavingAccount(true);
    try {
      if (accountModalMode === 'create') {
        await apiFetch('/api/finance/external-accounts', {
          method: 'POST',
          body: JSON.stringify({
            accountKind: accountForm.accountKind,
            category: accountForm.category,
            partyType: accountForm.partyType,
            driverId:
              accountForm.partyType === 'driver' && accountForm.driverId
                ? Number(accountForm.driverId)
                : null,
            supervisorId:
              accountForm.partyType === 'supervisor' && accountForm.supervisorId
                ? Number(accountForm.supervisorId)
                : null,
            employeeId:
              accountForm.partyType === 'employee' && accountForm.employeeId
                ? Number(accountForm.employeeId)
                : null,
            schoolId: accountForm.schoolId ? Number(accountForm.schoolId) : null,
            partyName: accountForm.partyName.trim(),
            partyPhone: accountForm.partyPhone.trim(),
            title: accountForm.title.trim(),
            principalAmount: Number(accountForm.principalAmount),
            initialSettledAmount: Number(accountForm.initialSettledAmount || 0),
            openedDate: accountForm.openedDate,
            dueDate: accountForm.dueDate || null,
            paymentMethod: accountForm.paymentMethod,
            notes: accountForm.notes.trim(),
          }),
        });
        setSuccessMsg('تم حفظ السجل في سجل المديونيات والحسابات الخارجية بنجاح.');
      } else if (accountModalMode === 'edit' && editingAccount) {
        await apiFetch(`/api/finance/external-accounts/${editingAccount.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            accountKind: accountForm.accountKind,
            category: accountForm.category,
            partyType: accountForm.partyType,
            schoolId: accountForm.schoolId ? Number(accountForm.schoolId) : null,
            partyName: accountForm.partyName.trim(),
            partyPhone: accountForm.partyPhone.trim(),
            title: accountForm.title.trim(),
            principalAmount: Number(accountForm.principalAmount),
            openedDate: accountForm.openedDate,
            dueDate: accountForm.dueDate || null,
            paymentMethod: accountForm.paymentMethod,
            notes: accountForm.notes.trim(),
          }),
        });
        setSuccessMsg('تم تعديل بيانات الحساب بنجاح.');
      }
      setAccountModalMode(null);
      setEditingAccount(null);
      await loadAccounts();
      if (accountForm.accountKind === 'external_account') setSection('external');
      else setSection('debts');
    } catch (err: unknown) {
      setAccountModalError(err instanceof Error ? err.message : 'تعذر حفظ الحساب');
    } finally {
      setSavingAccount(false);
    }
  };

  const openAddEntryModal = (acc: ExternalAccountRecord, defaultType: ExternalAccountEntryType = 'payment') => {
    setEntryError(null);
    setEntryTargetAccount(acc);
    setEntryForm({
      entryType: defaultType,
      amount: defaultType === 'payment' && acc.remainingAmount > 0 ? String(acc.remainingAmount) : '',
      entryDate: getLocalTodayDateString(),
      paymentMethod: 'كاش',
      notes: '',
    });
  };

  const handleSaveEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!entryTargetAccount) return;
    setEntryError(null);
    setSavingEntry(true);
    try {
      await apiFetch(`/api/finance/external-accounts/${entryTargetAccount.id}/entries`, {
        method: 'POST',
        body: JSON.stringify({
          entryType: entryForm.entryType,
          amount: Number(entryForm.amount),
          entryDate: entryForm.entryDate,
          paymentMethod: entryForm.paymentMethod,
          notes: entryForm.notes.trim(),
        }),
      });
      const targetId = entryTargetAccount.id;
      setEntryTargetAccount(null);
      setSuccessMsg('تم تسجيل الحركة وتحديث رصيد الحساب بنجاح.');
      await loadAccounts();
      if (detailAccount && detailAccount.id === targetId) {
        await openDetailModal({ ...detailAccount });
      }
    } catch (err: unknown) {
      setEntryError(err instanceof Error ? err.message : 'تعذر تسجيل الحركة');
    } finally {
      setSavingEntry(false);
    }
  };

  const openDetailModal = async (acc: ExternalAccountRecord) => {
    setDetailAccount(acc);
    setDetailLoading(true);
    try {
      const res = await apiFetch<{
        account: ExternalAccountRecord;
        entries: ExternalAccountEntryRecord[];
      }>(`/api/finance/external-accounts/${acc.id}`);
      setDetailAccount({ ...acc, ...res.account });
      setDetailEntries(res.entries || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل كشف الحساب');
    } finally {
      setDetailLoading(false);
    }
  };

  const handleDeleteEntry = async (accountId: number, entryId: number) => {
    try {
      await apiFetch(`/api/finance/external-accounts/${accountId}/entries/${entryId}`, {
        method: 'DELETE',
      });
      setSuccessMsg('تم حذف الحركة وإعادة احتساب الرصيد المتبقي.');
      await loadAccounts();
      if (detailAccount && detailAccount.id === accountId) {
        await openDetailModal(detailAccount);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر حذف الحركة');
    }
  };

  const handleDeleteAccount = async () => {
    if (!deletingAccount) return;
    setDeletingBusy(true);
    try {
      await apiFetch(`/api/finance/external-accounts/${deletingAccount.id}`, {
        method: 'DELETE',
      });
      setDeletingAccount(null);
      if (detailAccount?.id === deletingAccount.id) setDetailAccount(null);
      setSuccessMsg('تم حذف الحساب من السجل.');
      await loadAccounts();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر حذف الحساب');
    } finally {
      setDeletingBusy(false);
    }
  };

  // --- Print & Excel Export Helpers ---
  const handlePrintCustodyReceipt = (c: FinancialCustodyRecord) => {
    const statusAr =
      c.status === 'settled' ? 'مصفاة بالكامل' : c.status === 'partial' ? 'مصفاة جزئياً' : 'نشطة (باليد)';
    const html = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8" />
<title>إيصال عهدة مالية ${escapeHtml(c.custodyCode)}</title>
<style>
  @page { size: A5 portrait; margin: 12mm; }
  body { font-family: 'Cairo', 'Tajawal', Tahoma, Arial, sans-serif; color: #0f172a; direction: rtl; margin: 0; }
  .card { border: 2px solid #0B1F3A; border-radius: 12px; padding: 18px; }
  .hdr { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #C89B3C; padding-bottom: 10px; margin-bottom: 14px; }
  .title { font-size: 18px; font-weight: 800; color: #0B1F3A; }
  .code { background: #0B1F3A; color: #C89B3C; padding: 5px 12px; border-radius: 8px; font-weight: 800; font-size: 13px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 12px; margin-bottom: 14px; }
  .box { border: 1px solid #cbd5e1; border-radius: 8px; padding: 8px 10px; background: #f8fafc; }
  .lbl { color: #64748b; font-size: 10px; }
  .val { font-weight: 700; margin-top: 2px; color: #0B1F3A; }
  .totals { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 18px; text-align: center; }
  .tot { border: 1px solid #cbd5e1; border-radius: 8px; padding: 8px; }
  .tot.dark { background: #0B1F3A; color: #fff; border-color: #0B1F3A; }
  .sigs { display: flex; justify-content: space-between; margin-top: 26px; font-size: 12px; text-align: center; }
  .sig { width: 42%; border-top: 1px dashed #94a3b8; padding-top: 6px; font-weight: 700; }
</style></head>
<body>
<div class="card">
  <div class="hdr">
    <div>
      <div class="title">الوليد ترافيل — إيصال تسليم / تصفية عهدة مالية</div>
      <div style="font-size:11px;color:#475569;margin-top:3px">الحالة: ${escapeHtml(statusAr)} · طريقة الدفع: ${escapeHtml(c.paymentMethod)}</div>
    </div>
    <div class="code">${escapeHtml(c.custodyCode)}</div>
  </div>
  <div class="grid">
    <div class="box"><div class="lbl">المستلم</div><div class="val">${escapeHtml(c.beneficiaryName)}</div></div>
    <div class="box"><div class="lbl">الهاتف / المدرسة</div><div class="val">${escapeHtml(c.beneficiaryPhone || '—')} · ${escapeHtml(c.schoolName)}</div></div>
    <div class="box"><div class="lbl">تاريخ التسليم</div><div class="val">${escapeHtml(c.handoverDate)}</div></div>
    <div class="box"><div class="lbl">تاريخ التصفية</div><div class="val">${escapeHtml(c.settlementDate || 'لم تُصفَّ بعد')}</div></div>
    <div class="box" style="grid-column: span 2"><div class="lbl">الغرض من العهدة</div><div class="val">${escapeHtml(c.purpose)}</div></div>
    ${c.notes ? `<div class="box" style="grid-column: span 2"><div class="lbl">ملاحظات</div><div class="val">${escapeHtml(c.notes)}</div></div>` : ''}
  </div>
  <div class="totals">
    <div class="tot"><div class="lbl">أصل العهدة</div><div class="val">${escapeHtml(formatEGP(c.amount))}</div></div>
    <div class="tot"><div class="lbl">المصروف</div><div class="val">${escapeHtml(formatEGP(c.spentAmount))}</div></div>
    <div class="tot"><div class="lbl">المرتجع</div><div class="val">${escapeHtml(formatEGP(c.returnedAmount))}</div></div>
    <div class="tot dark"><div class="lbl" style="color:#cbd5e1">المتبقي باليد</div><div class="val" style="color:#C89B3C">${escapeHtml(formatEGP(c.remainingAmount))}</div></div>
  </div>
  <div class="sigs">
    <div class="sig">توقيع المستلم (${escapeHtml(c.beneficiaryName)})</div>
    <div class="sig">توقيع الإدارة المالية (${escapeHtml(c.handedByName || 'المحاسب')})</div>
  </div>
</div>
</body></html>`;
    printHtmlViaHiddenIframe(html);
  };

  const handlePrintAccountStatement = (
    acc: ExternalAccountRecord,
    entries: ExternalAccountEntryRecord[]
  ) => {
    const kindLabel =
      acc.accountKind === 'debt_receivable'
        ? 'مديونية لنا عند الغير'
        : acc.accountKind === 'debt_payable'
        ? 'مديونية علينا للغير'
        : 'حساب خاص خارجي';
    const rowsHtml =
      entries.length === 0
        ? `<tr><td colspan="5" style="text-align:center;color:#64748b;padding:14px">لا توجد حركات مسجلة بعد</td></tr>`
        : entries
            .map((e) => {
              const typeAr =
                e.entryType === 'addition'
                  ? 'إضافة على الأصل'
                  : e.entryType === 'adjustment'
                  ? 'خصم / تسوية'
                  : 'سداد / تحصيل';
              return `<tr>
                <td>${escapeHtml(e.entryDate)}</td>
                <td>${escapeHtml(typeAr)}</td>
                <td>${escapeHtml(e.paymentMethod)}</td>
                <td>${escapeHtml(e.notes || '—')}</td>
                <td style="font-weight:700">${escapeHtml(formatEGP(e.amount))}</td>
              </tr>`;
            })
            .join('');

    const html = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8" />
<title>كشف حساب ${escapeHtml(acc.accountCode)}</title>
<style>
  @page { size: A4 portrait; margin: 14mm; }
  body { font-family: 'Cairo', 'Tajawal', Tahoma, Arial, sans-serif; color: #0f172a; direction: rtl; margin: 0; }
  .hdr { display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid #C89B3C; padding-bottom: 12px; margin-bottom: 16px; }
  .title { font-size: 20px; font-weight: 800; color: #0B1F3A; }
  .code { background: #0B1F3A; color: #C89B3C; padding: 6px 14px; border-radius: 8px; font-weight: 800; }
  .meta { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 16px; font-size: 12px; }
  .box { border: 1px solid #cbd5e1; border-radius: 8px; padding: 8px 10px; background: #f8fafc; }
  .lbl { color: #64748b; font-size: 10px; }
  .val { font-weight: 700; margin-top: 2px; color: #0B1F3A; }
  .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 18px; text-align: center; }
  .kpi { border: 1px solid #cbd5e1; border-radius: 10px; padding: 10px; }
  .kpi.dark { background: #0B1F3A; color: #fff; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #cbd5e1; padding: 8px 10px; text-align: right; }
  th { background: #f1f5f9; color: #334155; }
</style></head>
<body>
  <div class="hdr">
    <div>
      <div class="title">الوليد ترافيل — كشف ${escapeHtml(kindLabel)}</div>
      <div style="font-size:12px;color:#475569;margin-top:4px">${escapeHtml(acc.title)}</div>
    </div>
    <div class="code">${escapeHtml(acc.accountCode)}</div>
  </div>
  <div class="meta">
    <div class="box"><div class="lbl">الطرف / الجهة</div><div class="val">${escapeHtml(acc.partyName)}</div></div>
    <div class="box"><div class="lbl">التصنيف والهاتف</div><div class="val">${escapeHtml(acc.category)} · ${escapeHtml(acc.partyPhone || '—')}</div></div>
    <div class="box"><div class="lbl">تاريخ الفتح / الاستحقاق</div><div class="val">${escapeHtml(acc.openedDate)} · ${escapeHtml(acc.dueDate || 'مفتوح')}</div></div>
  </div>
  <div class="kpis">
    <div class="kpi"><div class="lbl">إجمالي الأصل</div><div class="val" style="font-size:16px">${escapeHtml(formatEGP(acc.principalAmount))}</div></div>
    <div class="kpi"><div class="lbl">إجمالي المسدد / المحصل</div><div class="val" style="font-size:16px;color:#047857">${escapeHtml(formatEGP(acc.settledAmount))}</div></div>
    <div class="kpi dark"><div class="lbl" style="color:#cbd5e1">المتبقي الحالي</div><div class="val" style="font-size:16px;color:#C89B3C">${escapeHtml(formatEGP(acc.remainingAmount))}</div></div>
  </div>
  <table>
    <thead><tr><th>التاريخ</th><th>نوع الحركة</th><th>طريقة الدفع</th><th>ملاحظات</th><th>المبلغ</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</body></html>`;
    printHtmlViaHiddenIframe(html);
  };

  const handlePrintCurrentTable = () => {
    const today = getLocalTodayDateString();
    let title = 'سجل العهد المالية';
    let headers: string[] = [];
    let rows: string[][] = [];

    if (section === 'custodies') {
      title = 'كشف العهد المالية المسلمة والمصفاة';
      headers = ['الكود', 'المستلم', 'الغرض', 'التاريخ', 'الأصل', 'المصروف', 'المرتجع', 'المتبقي', 'الحالة'];
      rows = filteredCustodies.map((c) => [
        c.custodyCode,
        c.beneficiaryName,
        c.purpose,
        c.handoverDate,
        formatEGP(c.amount),
        formatEGP(c.spentAmount),
        formatEGP(c.returnedAmount),
        formatEGP(c.remainingAmount),
        c.status === 'settled' ? 'مصفاة' : c.status === 'partial' ? 'جزئية' : 'نشطة',
      ]);
    } else {
      const list = section === 'debts' ? debtAccounts : externalOnlyAccounts;
      title = section === 'debts' ? 'كشف المديونيات والذمم (لنا / علينا)' : 'كشف الحسابات الخاصة والخارجية';
      headers = ['الكود', 'النوع', 'الطرف', 'البيان', 'التاريخ', 'الأصل', 'المسدد', 'المتبقي', 'الحالة'];
      rows = list.map((a) => [
        a.accountCode,
        a.accountKind === 'debt_receivable'
          ? 'مديونية لنا'
          : a.accountKind === 'debt_payable'
          ? 'مديونية علينا'
          : 'حساب خاص',
        a.partyName,
        a.title,
        a.openedDate,
        formatEGP(a.principalAmount),
        formatEGP(a.settledAmount),
        formatEGP(a.remainingAmount),
        a.status === 'settled' ? 'مسدد' : a.status === 'partial' ? 'سداد جزئي' : 'مفتوح',
      ]);
    }

    const html = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font-family: 'Cairo', 'Tajawal', Tahoma, Arial, sans-serif; color: #0f172a; direction: rtl; margin: 0; }
  h1 { font-size: 18px; color: #0B1F3A; margin: 0 0 4px 0; }
  .sub { font-size: 11px; color: #64748b; margin-bottom: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: right; }
  th { background: #0B1F3A; color: #fff; }
  tr:nth-child(even) td { background: #f8fafc; }
</style></head>
<body>
  <h1>الوليد ترافيل — ${escapeHtml(title)}</h1>
  <div class="sub">تاريخ الطباعة: ${escapeHtml(today)} · إجمالي السجلات: ${rows.length}</div>
  <table>
    <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
    <tbody>${
      rows.length === 0
        ? `<tr><td colspan="${headers.length}" style="text-align:center;padding:16px">لا توجد سجلات مطابقة</td></tr>`
        : rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')
    }</tbody>
  </table>
</body></html>`;
    printHtmlViaHiddenIframe(html);
  };

  const handleExportCurrentExcel = () => {
    if (section === 'custodies') {
      exportRowsToExcel(
        `custodies-${todayIso}`,
        ['الكود', 'المستلم', 'نوع المستلم', 'الهاتف', 'المدرسة', 'الغرض', 'تاريخ التسليم', 'أصل العهدة', 'المصروف', 'المرتجع', 'المتبقي', 'الحالة'],
        filteredCustodies.map((c) => [
          c.custodyCode,
          c.beneficiaryName,
          c.beneficiaryType,
          c.beneficiaryPhone || '',
          c.schoolName,
          c.purpose,
          c.handoverDate,
          c.amount,
          c.spentAmount,
          c.returnedAmount,
          c.remainingAmount,
          c.status,
        ])
      );
      return;
    }
    const list = section === 'debts' ? debtAccounts : externalOnlyAccounts;
    exportRowsToExcel(
      `${section}-${todayIso}`,
      ['الكود', 'النوع', 'التصنيف', 'الطرف', 'الهاتف', 'البيان', 'تاريخ الفتح', 'تاريخ الاستحقاق', 'أصل المبلغ', 'المسدد', 'المتبقي', 'الحالة'],
      list.map((a) => [
        a.accountCode,
        a.accountKind === 'debt_receivable'
          ? 'مديونية لنا'
          : a.accountKind === 'debt_payable'
          ? 'مديونية علينا'
          : 'حساب خاص خارجي',
        a.category,
        a.partyName,
        a.partyPhone || '',
        a.title,
        a.openedDate,
        a.dueDate || '',
        a.principalAmount,
        a.settledAmount,
        a.remainingAmount,
        a.status,
      ])
    );
  };

  const renderStatusBadge = (status: 'active' | 'open' | 'partial' | 'settled', isOverdue = false) => {
    if (status === 'settled') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-bold text-emerald-800">
          <CheckCircle2 className="w-3 h-3" />
          مصفاة / مسددة
        </span>
      );
    }
    if (status === 'partial') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-bold text-amber-900">
          <Clock className="w-3 h-3" />
          {isOverdue ? 'جزئية (متأخرة)' : 'تصفية / سداد جزئي'}
        </span>
      );
    }
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold ${
          isOverdue ? 'bg-red-100 text-red-800' : 'bg-sky-100 text-sky-900'
        }`}
      >
        {isOverdue && <AlertTriangle className="w-3 h-3" />}
        {isOverdue ? 'مفتوحة (متأخرة)' : 'مفتوحة / نشطة'}
      </span>
    );
  };

  const settledPreviewNum = settlingCustody
    ? (Number(settleForm.spentAmount) || 0) + (Number(settleForm.returnedAmount) || 0)
    : 0;
  const custodyRemainingPreview = settlingCustody
    ? Math.max(0, Number(settlingCustody.amount) - settledPreviewNum)
    : 0;

  return (
    <div dir="rtl" className="space-y-6">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 bg-white border border-slate-200 rounded-2xl p-5 shadow-xs">
        <div>
          <div className="inline-flex items-center gap-1.5 text-[11px] font-bold text-[#C89B3C] mb-1">
            <HandCoins className="w-3.5 h-3.5" />
            دفتر مستقل خارج الحسابات الأساسية
          </div>
          <h1 className="font-display text-xl sm:text-2xl font-bold text-[#0B1F3A]">
            العهد المالية والمديونيات والحسابات الخارجية
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            سجل مخصص للعهد، المديونيات (لنا وعلينا)، وأي حساب خاص خارج عن رواتب السائقين وعقود المدارس الأساسية — دون التأثير على كشوف المرتبات الشهرية.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {canWrite && (
            <>
              <button
                type="button"
                onClick={openCreateCustodyModal}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#0B1F3A] hover:bg-[#13325c] px-3.5 py-2 text-xs font-bold text-white shadow-xs cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5 text-[#C89B3C]" />
                تسليم عهدة
              </button>
              <button
                type="button"
                onClick={() => openCreateAccountModal('debt_receivable')}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#C89B3C] hover:bg-[#b58a30] px-3.5 py-2 text-xs font-bold text-[#0B1F3A] shadow-xs cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                تسجيل مديونية
              </button>
              <button
                type="button"
                onClick={() => openCreateAccountModal('external_account')}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[#0B1F3A] bg-white hover:bg-slate-50 px-3.5 py-2 text-xs font-bold text-[#0B1F3A] cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5 text-[#C89B3C]" />
                حساب خارجي خاص
              </button>
            </>
          )}
          <button
            type="button"
            onClick={handlePrintCurrentTable}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 cursor-pointer"
          >
            <Printer className="w-3.5 h-3.5" />
            طباعة الكشف
          </button>
          <button
            type="button"
            onClick={handleExportCurrentExcel}
            className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 px-3 py-2 text-xs font-semibold text-emerald-900 cursor-pointer"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            تصدير Excel
          </button>
          <button
            type="button"
            onClick={reloadAll}
            aria-label="تحديث البيانات"
            className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 p-2 text-slate-600 cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${custodiesLoading || accountsLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Global KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div
          onClick={() => setSection('custodies')}
          className={`rounded-2xl border p-4 cursor-pointer transition-all ${
            section === 'custodies'
              ? 'bg-[#0B1F3A] text-white border-[#0B1F3A] shadow-md'
              : 'bg-white text-slate-900 border-slate-200 hover:border-[#C89B3C]'
          }`}
        >
          <div className="flex items-center justify-between text-xs">
            <span className={section === 'custodies' ? 'text-slate-300' : 'text-slate-500'}>
              العهد المالية المفتوحة (باليد)
            </span>
            <HandCoins className="w-4 h-4 text-[#C89B3C]" />
          </div>
          <div
            className={`mt-2 font-mono text-xl font-bold tabular-nums ${
              section === 'custodies' ? 'text-[#C89B3C]' : 'text-[#0B1F3A]'
            }`}
          >
            {formatEGP(custodyStats?.totalActiveAmount ?? 0)}
          </div>
          <div
            className={`mt-1 text-[11px] flex items-center justify-between ${
              section === 'custodies' ? 'text-slate-300' : 'text-slate-500'
            }`}
          >
            <span>
              نشطة: {(custodyStats?.activeCount ?? 0) + (custodyStats?.partialCount ?? 0)} من أصل{' '}
              {custodyStats?.totalCount ?? 0}
            </span>
            {overdueCustodies.length > 0 && (
              <span className="text-amber-400 font-bold">
                {overdueCustodies.length} متأخرة
              </span>
            )}
          </div>
        </div>

        <div
          onClick={() => {
            setSection('debts');
            setDebtKindFilter('debt_receivable');
          }}
          className={`rounded-2xl border p-4 cursor-pointer transition-all ${
            section === 'debts' && debtKindFilter === 'debt_receivable'
              ? 'bg-emerald-950 text-white border-emerald-900 shadow-md'
              : 'bg-white text-slate-900 border-slate-200 hover:border-emerald-400'
          }`}
        >
          <div className="flex items-center justify-between text-xs">
            <span
              className={
                section === 'debts' && debtKindFilter === 'debt_receivable'
                  ? 'text-emerald-200'
                  : 'text-slate-500'
              }
            >
              مديونيات لنا (عند الغير)
            </span>
            <ArrowDownLeft className="w-4 h-4 text-emerald-500" />
          </div>
          <div
            className={`mt-2 font-mono text-xl font-bold tabular-nums ${
              section === 'debts' && debtKindFilter === 'debt_receivable'
                ? 'text-emerald-300'
                : 'text-emerald-700'
            }`}
          >
            {formatEGP(accountStats?.receivableTotalRemaining ?? 0)}
          </div>
          <div
            className={`mt-1 text-[11px] ${
              section === 'debts' && debtKindFilter === 'debt_receivable'
                ? 'text-emerald-200'
                : 'text-slate-500'
            }`}
          >
            مفتوحة للتحصيل: {accountStats?.receivableOpenCount ?? 0} · محصّل:{' '}
            {formatEGP(accountStats?.receivableTotalSettled ?? 0)}
          </div>
        </div>

        <div
          onClick={() => {
            setSection('debts');
            setDebtKindFilter('debt_payable');
          }}
          className={`rounded-2xl border p-4 cursor-pointer transition-all ${
            section === 'debts' && debtKindFilter === 'debt_payable'
              ? 'bg-rose-950 text-white border-rose-900 shadow-md'
              : 'bg-white text-slate-900 border-slate-200 hover:border-rose-400'
          }`}
        >
          <div className="flex items-center justify-between text-xs">
            <span
              className={
                section === 'debts' && debtKindFilter === 'debt_payable'
                  ? 'text-rose-200'
                  : 'text-slate-500'
              }
            >
              مديونيات علينا (للغير)
            </span>
            <ArrowUpRight className="w-4 h-4 text-rose-500" />
          </div>
          <div
            className={`mt-2 font-mono text-xl font-bold tabular-nums ${
              section === 'debts' && debtKindFilter === 'debt_payable'
                ? 'text-rose-300'
                : 'text-rose-700'
            }`}
          >
            {formatEGP(accountStats?.payableTotalRemaining ?? 0)}
          </div>
          <div
            className={`mt-1 text-[11px] ${
              section === 'debts' && debtKindFilter === 'debt_payable'
                ? 'text-rose-200'
                : 'text-slate-500'
            }`}
          >
            مفتوحة للسداد: {accountStats?.payableOpenCount ?? 0} · مسدد:{' '}
            {formatEGP(accountStats?.payableTotalSettled ?? 0)}
          </div>
        </div>

        <div
          onClick={() => setSection('external')}
          className={`rounded-2xl border p-4 cursor-pointer transition-all ${
            section === 'external'
              ? 'bg-[#0B1F3A] text-white border-[#0B1F3A] shadow-md'
              : 'bg-white text-slate-900 border-slate-200 hover:border-[#C89B3C]'
          }`}
        >
          <div className="flex items-center justify-between text-xs">
            <span className={section === 'external' ? 'text-slate-300' : 'text-slate-500'}>
              الحسابات الخاصة والخارجية
            </span>
            <Layers className="w-4 h-4 text-[#C89B3C]" />
          </div>
          <div
            className={`mt-2 font-mono text-xl font-bold tabular-nums ${
              section === 'external' ? 'text-[#C89B3C]' : 'text-[#0B1F3A]'
            }`}
          >
            {formatEGP(accountStats?.externalTotalRemaining ?? 0)}
          </div>
          <div
            className={`mt-1 text-[11px] ${
              section === 'external' ? 'text-slate-300' : 'text-slate-500'
            }`}
          >
            حسابات مفتوحة: {accountStats?.externalOpenCount ?? 0} · مصفى:{' '}
            {formatEGP(accountStats?.externalTotalSettled ?? 0)}
          </div>
        </div>
      </div>

      {/* Feedback Alerts */}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3.5 text-xs text-red-800 flex items-center justify-between gap-2">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="p-1 text-red-500 hover:text-red-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
      {successMsg && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 text-xs text-emerald-800 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{successMsg}</span>
          </div>
          <button
            type="button"
            onClick={() => setSuccessMsg(null)}
            className="p-1 text-emerald-600 hover:text-emerald-900 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Overdue Warnings */}
      {section === 'custodies' && overdueCustodies.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-950 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
            <div>
              <div className="font-bold">
                تنبيه: توجد {overdueCustodies.length} عهدة مالية مفتوحة منذ 7 أيام أو أكثر ولم تُصفَّ بالكامل
              </div>
              <div className="text-amber-800 mt-0.5">
                {overdueCustodies
                  .slice(0, 3)
                  .map((c) => `${c.custodyCode} (${c.beneficiaryName} - متبقي ${formatEGP(c.remainingAmount)})`)
                  .join(' · ')}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setCustodyStatusFilter('active')}
            className="rounded-lg bg-amber-900 text-white px-3 py-1.5 text-[11px] font-bold cursor-pointer"
          >
            عرض العهد النشطة
          </button>
        </div>
      )}

      {(accountStats?.overdueCount ?? 0) > 0 && section !== 'custodies' && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3.5 text-xs text-red-900 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
            <span>
              توجد <strong>{accountStats?.overdueCount}</strong> حسابات/مديونيات تجاوزت تاريخ الاستحقاق ولم تُسدد بالكامل بعد.
            </span>
          </div>
          <button
            type="button"
            onClick={() => setAccountStatusFilter('overdue')}
            className="rounded-lg bg-red-700 text-white px-3 py-1 text-[11px] font-bold cursor-pointer"
          >
            تصفية المتأخر
          </button>
        </div>
      )}

      {/* Section Switcher Tabs */}
      <div className="flex flex-wrap items-center gap-1.5 p-1 bg-slate-200/70 rounded-xl w-fit">
        <button
          type="button"
          onClick={() => setSection('custodies')}
          className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-lg transition-colors cursor-pointer ${
            section === 'custodies'
              ? 'bg-white text-[#0B1F3A] shadow-xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <HandCoins className="w-4 h-4 text-[#C89B3C]" />
          العهد المالية ({custodies.length})
        </button>
        <button
          type="button"
          onClick={() => setSection('debts')}
          className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-lg transition-colors cursor-pointer ${
            section === 'debts'
              ? 'bg-white text-[#0B1F3A] shadow-xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <Coins className="w-4 h-4 text-[#C89B3C]" />
          المديونيات والذمم ({totalDebtsCount})
        </button>
        <button
          type="button"
          onClick={() => setSection('external')}
          className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-lg transition-colors cursor-pointer ${
            section === 'external'
              ? 'bg-white text-[#0B1F3A] shadow-xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <BookOpen className="w-4 h-4 text-[#C89B3C]" />
          حسابات خارجية وخاصة ({totalExternalOnlyCount})
        </button>
      </div>

      {/* SECTION 1: FINANCIAL CUSTODIES */}
      {section === 'custodies' && (
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
          <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 bg-slate-50/70">
            <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[240px]">
              <div className="relative flex-1 max-w-xs">
                <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
                <input
                  value={custodySearch}
                  onChange={(e) => setCustodySearch(e.target.value)}
                  placeholder="بحث بالكود أو المستلم أو الغرض..."
                  className="w-full rounded-xl border border-slate-200 bg-white pr-9 pl-3 py-2 text-xs focus:outline-none focus:border-[#C89B3C]"
                />
              </div>
              <select
                value={custodyStatusFilter}
                onChange={(e) => setCustodyStatusFilter(e.target.value)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700"
              >
                <option value="all">كل الحالات</option>
                <option value="active">نشطة (لم تُصفَّ)</option>
                <option value="partial">مصفاة جزئياً</option>
                <option value="settled">مصفاة بالكامل</option>
              </select>
              <select
                value={custodyTypeFilter}
                onChange={(e) => setCustodyTypeFilter(e.target.value)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700"
              >
                <option value="all">كل المستلمين</option>
                <option value="driver">سائق</option>
                <option value="supervisor">مشرفة</option>
                <option value="employee">موظف إداري</option>
                <option value="other">طرف خارجي</option>
              </select>
              <select
                value={custodyPurposeFilter}
                onChange={(e) => setCustodyPurposeFilter(e.target.value)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700"
              >
                <option value="all">كل بنود العهد</option>
                <option value="personal_tips">مصاريف شخصية وإكراميات</option>
                {CUSTODY_PURPOSE_PRESETS.filter((p) => p !== 'مصاريف شخصية وإكراميات').map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              {personalTipsCustodyTotal > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    setCustodyPurposeFilter((cur) =>
                      cur === 'personal_tips' ? 'all' : 'personal_tips'
                    )
                  }
                  className={`rounded-xl border px-3 py-1.5 text-[11px] font-bold cursor-pointer transition-colors ${
                    custodyPurposeFilter === 'personal_tips'
                      ? 'bg-[#0B1F3A] text-[#C89B3C] border-[#0B1F3A]'
                      : 'bg-amber-50 text-amber-900 border-amber-200 hover:bg-amber-100'
                  }`}
                >
                  مصاريف شخصية وإكراميات: {formatEGP(personalTipsCustodyTotal)}
                </button>
              )}
            </div>
            {canWrite && (
              <button
                type="button"
                onClick={openCreateCustodyModal}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#0B1F3A] hover:bg-[#13325c] px-4 py-2 text-xs font-bold text-white cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5 text-[#C89B3C]" />
                تسليم عهدة جديدة
              </button>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4">الكود</th>
                  <th className="py-3 px-4">المستلم والجهة</th>
                  <th className="py-3 px-4">الغرض والبيان</th>
                  <th className="py-3 px-4">تاريخ التسليم</th>
                  <th className="py-3 px-4">أصل العهدة</th>
                  <th className="py-3 px-4">المصروف</th>
                  <th className="py-3 px-4">المرتجع</th>
                  <th className="py-3 px-4">المتبقي</th>
                  <th className="py-3 px-4">الحالة</th>
                  <th className="py-3 px-4">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {custodiesLoading ? (
                  <tr>
                    <td colSpan={10} className="py-12 text-center text-slate-400">
                      جاري تحميل سجل العهد المالية...
                    </td>
                  </tr>
                ) : filteredCustodies.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="py-12 text-center text-slate-400">
                      لا توجد عهد مالية مسجلة حتى الآن — اضغط «تسليم عهدة جديدة» لبدء التسجيل.
                    </td>
                  </tr>
                ) : (
                  filteredCustodies.map((c) => {
                    const daysOpen = daysBetweenDates(c.handoverDate, todayIso);
                    const isAged = c.status !== 'settled' && daysOpen >= 7;
                    const typeAr =
                      c.beneficiaryType === 'driver'
                        ? 'سائق'
                        : c.beneficiaryType === 'supervisor'
                        ? 'مشرفة'
                        : c.beneficiaryType === 'employee'
                        ? 'موظف'
                        : 'طرف خارجي';
                    return (
                      <tr key={c.id} className="hover:bg-slate-50/70">
                        <td className="py-3 px-4 font-mono font-bold text-[#0B1F3A]">
                          {c.custodyCode}
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-bold text-slate-900">{c.beneficiaryName}</div>
                          <div className="text-[11px] text-slate-500">
                            {typeAr} · {c.schoolName}
                            {c.beneficiaryPhone ? ` · ${c.beneficiaryPhone}` : ''}
                          </div>
                        </td>
                        <td className="py-3 px-4 max-w-xs">
                          <div className="font-semibold text-slate-800">{c.purpose}</div>
                          {c.notes && (
                            <div className="text-[11px] text-slate-400 truncate">{c.notes}</div>
                          )}
                        </td>
                        <td className="py-3 px-4 font-mono text-slate-600 tabular-nums">
                          <div>{c.handoverDate}</div>
                          {c.status !== 'settled' && (
                            <div
                              className={`text-[10px] font-sans ${
                                isAged ? 'text-amber-700 font-bold' : 'text-slate-400'
                              }`}
                            >
                              منذ {daysOpen} يوم
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 font-mono font-bold text-[#0B1F3A] tabular-nums">
                          {formatEGP(c.amount)}
                        </td>
                        <td className="py-3 px-4 font-mono text-slate-700 tabular-nums">
                          {formatEGP(c.spentAmount)}
                        </td>
                        <td className="py-3 px-4 font-mono text-emerald-700 tabular-nums">
                          {formatEGP(c.returnedAmount)}
                        </td>
                        <td className="py-3 px-4 font-mono font-bold text-amber-800 tabular-nums">
                          {formatEGP(c.remainingAmount)}
                        </td>
                        <td className="py-3 px-4">{renderStatusBadge(c.status, isAged)}</td>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-1">
                            {canWrite && (
                              <button
                                type="button"
                                onClick={() => openSettleModal(c)}
                                className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-2.5 py-1 text-[11px] font-bold text-emerald-800 cursor-pointer"
                              >
                                <CheckCircle2 className="w-3 h-3" />
                                تصفية
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handlePrintCustodyReceipt(c)}
                              title="طباعة إيصال العهدة"
                              className="p-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 cursor-pointer"
                            >
                              <Printer className="w-3.5 h-3.5" />
                            </button>
                            {canWrite && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => openEditCustodyModal(c)}
                                  title="تعديل العهدة"
                                  className="p-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 cursor-pointer"
                                >
                                  <Edit3 className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDeletingCustody(c)}
                                  title="حذف العهدة"
                                  className="p-1.5 rounded-lg border border-red-200 bg-red-50 hover:bg-red-100 text-red-700 cursor-pointer"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
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
        </div>
      )}

      {/* SECTION 2 & 3: DEBTS (RECEIVABLE / PAYABLE) & EXTERNAL ACCOUNTS */}
      {(section === 'debts' || section === 'external') && (
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
          <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 bg-slate-50/70">
            <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[240px]">
              <div className="relative flex-1 max-w-xs">
                <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
                <input
                  value={accountSearch}
                  onChange={(e) => setAccountSearch(e.target.value)}
                  placeholder="بحث بالكود أو الاسم أو البيان أو التصنيف..."
                  className="w-full rounded-xl border border-slate-200 bg-white pr-9 pl-3 py-2 text-xs focus:outline-none focus:border-[#C89B3C]"
                />
              </div>

              {section === 'debts' && (
                <select
                  value={debtKindFilter}
                  onChange={(e) =>
                    setDebtKindFilter(
                      e.target.value as 'all' | 'debt_receivable' | 'debt_payable'
                    )
                  }
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700"
                >
                  <option value="all">كل المديونيات (لنا وعلينا)</option>
                  <option value="debt_receivable">مديونيات لنا (عند الغير)</option>
                  <option value="debt_payable">مديونيات علينا (للغير)</option>
                </select>
              )}

              <select
                value={accountStatusFilter}
                onChange={(e) => setAccountStatusFilter(e.target.value)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700"
              >
                <option value="all">كل الحالات</option>
                <option value="open">مفتوحة</option>
                <option value="partial">سداد / تحصيل جزئي</option>
                <option value="settled">مسددة / مقفلة بالكامل</option>
                <option value="overdue">متأخرة عن الاستحقاق</option>
              </select>
            </div>

            {canWrite && (
              <div className="flex flex-wrap items-center gap-2">
                {section === 'debts' ? (
                  <>
                    <button
                      type="button"
                      onClick={() => openCreateAccountModal('debt_receivable')}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 px-3.5 py-2 text-xs font-bold text-white cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      مديونية لنا (عند الغير)
                    </button>
                    <button
                      type="button"
                      onClick={() => openCreateAccountModal('debt_payable')}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-rose-700 hover:bg-rose-800 px-3.5 py-2 text-xs font-bold text-white cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      مديونية علينا (للغير)
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => openCreateAccountModal('external_account')}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-[#0B1F3A] hover:bg-[#13325c] px-4 py-2 text-xs font-bold text-white cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5 text-[#C89B3C]" />
                    إضافة حساب خارجي / خاص
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4">الكود</th>
                  <th className="py-3 px-4">النوع والتصنيف</th>
                  <th className="py-3 px-4">الطرف / الجهة</th>
                  <th className="py-3 px-4">البيان</th>
                  <th className="py-3 px-4">تاريخ الفتح / الاستحقاق</th>
                  <th className="py-3 px-4">إجمالي الأصل</th>
                  <th className="py-3 px-4">المسدد / المحصل</th>
                  <th className="py-3 px-4">المتبقي</th>
                  <th className="py-3 px-4">الحالة</th>
                  <th className="py-3 px-4">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {accountsLoading ? (
                  <tr>
                    <td colSpan={10} className="py-12 text-center text-slate-400">
                      جاري تحميل السجلات...
                    </td>
                  </tr>
                ) : (section === 'debts' ? debtAccounts : externalOnlyAccounts).length === 0 ? (
                  <tr>
                    <td colSpan={10} className="py-12 text-center text-slate-400">
                      {section === 'debts'
                        ? 'لا توجد مديونيات مسجلة — استخدم الأزرار أعلاه لتسجيل مديونية لنا أو علينا.'
                        : 'لا توجد حسابات خارجية مسجلة — اضغط «إضافة حساب خارجي / خاص» لتسجيل أي حساب خارج عن الحسابات الأساسية.'}
                    </td>
                  </tr>
                ) : (
                  (section === 'debts' ? debtAccounts : externalOnlyAccounts).map((acc) => (
                    <tr key={acc.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 font-mono font-bold text-[#0B1F3A]">
                        {acc.accountCode}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-bold ${
                            acc.accountKind === 'debt_receivable'
                              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                              : acc.accountKind === 'debt_payable'
                              ? 'bg-rose-50 text-rose-800 border border-rose-200'
                              : 'bg-slate-100 text-[#0B1F3A] border border-slate-200'
                          }`}
                        >
                          {acc.accountKind === 'debt_receivable'
                            ? 'مديونية لنا'
                            : acc.accountKind === 'debt_payable'
                            ? 'مديونية علينا'
                            : 'حساب خاص'}
                        </span>
                        <div className="text-[11px] text-slate-500 mt-1">{acc.category}</div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-bold text-slate-900">{acc.partyName}</div>
                        <div className="text-[11px] text-slate-500">
                          {acc.schoolName}
                          {acc.partyPhone ? ` · ${acc.partyPhone}` : ''}
                        </div>
                      </td>
                      <td className="py-3 px-4 max-w-xs">
                        <div className="font-semibold text-slate-800">{acc.title}</div>
                        {acc.notes && (
                          <div className="text-[11px] text-slate-400 truncate">{acc.notes}</div>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-600 tabular-nums">
                        <div>{acc.openedDate}</div>
                        {acc.dueDate && (
                          <div
                            className={`text-[10px] ${
                              acc.isOverdue ? 'text-red-600 font-bold' : 'text-slate-400'
                            }`}
                          >
                            استحقاق: {acc.dueDate}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono font-bold text-[#0B1F3A] tabular-nums">
                        {formatEGP(acc.principalAmount)}
                      </td>
                      <td className="py-3 px-4 font-mono font-semibold text-emerald-700 tabular-nums">
                        {formatEGP(acc.settledAmount)}
                        <div className="text-[10px] font-sans text-slate-400">
                          {acc.entriesCount} حركة
                        </div>
                      </td>
                      <td className="py-3 px-4 font-mono font-bold text-amber-800 tabular-nums">
                        {formatEGP(acc.remainingAmount)}
                      </td>
                      <td className="py-3 px-4">{renderStatusBadge(acc.status, acc.isOverdue)}</td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1">
                          {canWrite && (
                            <button
                              type="button"
                              onClick={() =>
                                openAddEntryModal(
                                  acc,
                                  acc.remainingAmount > 0 ? 'payment' : 'addition'
                                )
                              }
                              className="inline-flex items-center gap-1 rounded-lg bg-[#0B1F3A] hover:bg-[#13325c] px-2.5 py-1 text-[11px] font-bold text-white cursor-pointer"
                            >
                              <Wallet className="w-3 h-3 text-[#C89B3C]" />
                              سداد / حركة
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => openDetailModal(acc)}
                            title="عرض كشف الحركات والطباعة"
                            className="p-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 cursor-pointer"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                          {canWrite && (
                            <>
                              <button
                                type="button"
                                onClick={() => openEditAccountModal(acc)}
                                title="تعديل"
                                className="p-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 cursor-pointer"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setDeletingAccount(acc)}
                                title="حذف"
                                className="p-1.5 rounded-lg border border-red-200 bg-red-50 hover:bg-red-100 text-red-700 cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MODAL: NEW CUSTODY */}
      {newCustodyOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <form
            onSubmit={handleCreateCustody}
            className="w-full max-w-xl bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden"
          >
            <div className="px-5 py-3.5 bg-[#0B1F3A] text-white flex items-center justify-between">
              <span className="font-display font-bold text-sm">تسليم عهدة مالية جديدة</span>
              <button
                type="button"
                onClick={() => setNewCustodyOpen(false)}
                className="text-slate-300 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-3 text-xs max-h-[78vh] overflow-y-auto">
              {custodyModalError && (
                <div className="rounded-lg bg-red-50 border border-red-200 p-2.5 text-red-800">
                  {custodyModalError}
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">نوع المستلم</label>
                  <select
                    value={newCustodyForm.beneficiaryType}
                    onChange={(e) =>
                      setNewCustodyForm({
                        ...newCustodyForm,
                        beneficiaryType: e.target.value as
                          | 'driver'
                          | 'supervisor'
                          | 'employee'
                          | 'other',
                        driverId: '',
                        supervisorId: '',
                        employeeId: '',
                        beneficiaryName: '',
                        beneficiaryPhone: '',
                      })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2"
                  >
                    <option value="driver">سائق</option>
                    <option value="supervisor">مشرفة</option>
                    <option value="employee">موظف إداري</option>
                    <option value="other">شخص / جهة خارجية</option>
                  </select>
                </div>

                {newCustodyForm.beneficiaryType === 'driver' && (
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">اختر السائق</label>
                    <select
                      value={newCustodyForm.driverId}
                      onChange={(e) => handleSelectCustodyBeneficiary('driver', e.target.value)}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2"
                    >
                      <option value="">-- اختر السائق --</option>
                      {lookups.drivers.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.fullName} ({d.driverCode})
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {newCustodyForm.beneficiaryType === 'supervisor' && (
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">اختر المشرفة</label>
                    <select
                      value={newCustodyForm.supervisorId}
                      onChange={(e) => handleSelectCustodyBeneficiary('supervisor', e.target.value)}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2"
                    >
                      <option value="">-- اختر المشرفة --</option>
                      {lookups.supervisors.map((sv) => (
                        <option key={sv.id} value={sv.id}>
                          {sv.fullName}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {newCustodyForm.beneficiaryType === 'employee' && (
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">اختر الموظف</label>
                    <select
                      value={newCustodyForm.employeeId}
                      onChange={(e) => handleSelectCustodyBeneficiary('employee', e.target.value)}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2"
                    >
                      <option value="">-- اختر الموظف --</option>
                      {lookups.employees.map((em) => (
                        <option key={em.id} value={em.id}>
                          {em.fullName} {em.jobTitle ? `(${em.jobTitle})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">اسم المستلم *</label>
                  <input
                    required
                    value={newCustodyForm.beneficiaryName}
                    onChange={(e) =>
                      setNewCustodyForm({ ...newCustodyForm, beneficiaryName: e.target.value })
                    }
                    placeholder="اسم المستلم"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">رقم الهاتف</label>
                  <input
                    value={newCustodyForm.beneficiaryPhone}
                    onChange={(e) =>
                      setNewCustodyForm({ ...newCustodyForm, beneficiaryPhone: e.target.value })
                    }
                    placeholder="01xxxxxxxxx"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">المدرسة / الجهة</label>
                  <select
                    value={newCustodyForm.schoolId}
                    onChange={(e) =>
                      setNewCustodyForm({ ...newCustodyForm, schoolId: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2"
                  >
                    <option value="">الإدارة العامة / بدون مدرسة محددة</option>
                    {lookups.schools.map((sc) => (
                      <option key={sc.id} value={sc.id}>
                        {sc.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">مبلغ العهدة (ج.م) *</label>
                  <input
                    type="number"
                    required
                    min={1}
                    step="any"
                    value={newCustodyForm.amount}
                    onChange={(e) =>
                      setNewCustodyForm({ ...newCustodyForm, amount: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">تاريخ التسليم *</label>
                  <input
                    type="date"
                    required
                    value={newCustodyForm.handoverDate}
                    onChange={(e) =>
                      setNewCustodyForm({ ...newCustodyForm, handoverDate: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">طريقة التسليم</label>
                  <select
                    value={newCustodyForm.paymentMethod}
                    onChange={(e) =>
                      setNewCustodyForm({ ...newCustodyForm, paymentMethod: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2"
                  >
                    {PAYMENT_METHODS.map((pm) => (
                      <option key={pm} value={pm}>
                        {pm}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">بند / الغرض من العهدة *</label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {CUSTODY_PURPOSE_PRESETS.map((preset) => {
                    const selected = newCustodyForm.purpose.trim() === preset;
                    return (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setNewCustodyForm({ ...newCustodyForm, purpose: preset })}
                        className={`rounded-lg border px-2.5 py-1 text-[11px] font-semibold cursor-pointer transition-colors ${
                          selected
                            ? 'bg-[#0B1F3A] text-[#C89B3C] border-[#0B1F3A]'
                            : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        {preset}
                      </button>
                    );
                  })}
                </div>
                <input
                  required
                  value={newCustodyForm.purpose}
                  onChange={(e) =>
                    setNewCustodyForm({ ...newCustodyForm, purpose: e.target.value })
                  }
                  placeholder="اختر البند أعلاه أو اكتب الغرض من العهدة (مثل: مصاريف شخصية وإكراميات)"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">تم التسليم بواسطة</label>
                  <input
                    value={newCustodyForm.handedByName}
                    onChange={(e) =>
                      setNewCustodyForm({ ...newCustodyForm, handedByName: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">ملاحظات</label>
                  <input
                    value={newCustodyForm.notes}
                    onChange={(e) =>
                      setNewCustodyForm({ ...newCustodyForm, notes: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2"
                  />
                </div>
              </div>
            </div>
            <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setNewCustodyOpen(false)}
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={savingCustody}
                className="rounded-lg bg-[#0B1F3A] px-5 py-2 text-xs font-bold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
              >
                {savingCustody ? 'جاري الحفظ...' : 'حفظ وتسليم العهدة'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL: SETTLE CUSTODY */}
      {settlingCustody && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <form
            onSubmit={handleSettleCustody}
            className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden"
          >
            <div className="px-5 py-3.5 bg-[#0B1F3A] text-white flex items-center justify-between">
              <span className="font-display font-bold text-sm">
                تصفية واستلام عهدة ({settlingCustody.custodyCode})
              </span>
              <button
                type="button"
                onClick={() => setSettlingCustody(null)}
                className="text-slate-300 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-3 text-xs">
              {settleError && (
                <div className="rounded-lg bg-red-50 border border-red-200 p-2.5 text-red-800">
                  {settleError}
                </div>
              )}
              <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 space-y-1">
                <div className="font-bold text-[#0B1F3A]">
                  {settlingCustody.beneficiaryName} — {settlingCustody.purpose}
                </div>
                <div className="text-slate-600">
                  أصل العهدة: <strong className="font-mono">{formatEGP(settlingCustody.amount)}</strong>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setSettleForm((f) => ({
                      ...f,
                      spentAmount: String(settlingCustody.amount),
                      returnedAmount: '0',
                    }))
                  }
                  className="rounded-lg bg-slate-100 hover:bg-slate-200 px-2.5 py-1 text-[11px] font-semibold text-[#0B1F3A] cursor-pointer"
                >
                  صُرفت بالكامل
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setSettleForm((f) => ({
                      ...f,
                      spentAmount: '0',
                      returnedAmount: String(settlingCustody.amount),
                    }))
                  }
                  className="rounded-lg bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-2.5 py-1 text-[11px] font-semibold text-emerald-800 cursor-pointer"
                >
                  رُدّت كاش بالكامل
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">إجمالي المصروف بالفواتير</label>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    value={settleForm.spentAmount}
                    onChange={(e) => setSettleForm({ ...settleForm, spentAmount: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">المرتجع النقدي</label>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    value={settleForm.returnedAmount}
                    onChange={(e) =>
                      setSettleForm({ ...settleForm, returnedAmount: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono font-bold text-emerald-700"
                  />
                </div>
              </div>

              <div className="rounded-xl bg-[#0B1F3A] text-white p-3 flex items-center justify-between">
                <span className="text-slate-300">المتبقي باليد بعد التصفية:</span>
                <span className="font-mono font-bold text-[#C89B3C] text-sm">
                  {formatEGP(custodyRemainingPreview)}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">تاريخ التصفية</label>
                  <input
                    type="date"
                    required
                    value={settleForm.settlementDate}
                    onChange={(e) =>
                      setSettleForm({ ...settleForm, settlementDate: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">تمت التصفية بواسطة</label>
                  <input
                    value={settleForm.settledByName}
                    onChange={(e) =>
                      setSettleForm({ ...settleForm, settledByName: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">ملاحظات التصفية</label>
                <input
                  value={settleForm.notes}
                  onChange={(e) => setSettleForm({ ...settleForm, notes: e.target.value })}
                  placeholder="رقم الإيصال أو تفاصيل الصرف..."
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
            </div>
            <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setSettlingCustody(null)}
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={savingSettle}
                className="rounded-lg bg-emerald-700 px-5 py-2 text-xs font-bold text-white hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
              >
                {savingSettle ? 'جاري الحفظ...' : 'اعتماد التصفية'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL: EDIT CUSTODY */}
      {editingCustody && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <form
            onSubmit={handleUpdateCustody}
            className="w-full max-w-lg bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden"
          >
            <div className="px-5 py-3.5 bg-[#0B1F3A] text-white flex items-center justify-between">
              <span className="font-display font-bold text-sm">
                تعديل عهدة ({editingCustody.custodyCode})
              </span>
              <button
                type="button"
                onClick={() => setEditingCustody(null)}
                className="text-slate-300 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-3 text-xs">
              {custodyModalError && (
                <div className="rounded-lg bg-red-50 border border-red-200 p-2.5 text-red-800">
                  {custodyModalError}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">اسم المستلم *</label>
                  <input
                    required
                    value={editCustodyForm.beneficiaryName}
                    onChange={(e) =>
                      setEditCustodyForm({ ...editCustodyForm, beneficiaryName: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">الهاتف</label>
                  <input
                    value={editCustodyForm.beneficiaryPhone}
                    onChange={(e) =>
                      setEditCustodyForm({ ...editCustodyForm, beneficiaryPhone: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">أصل المبلغ *</label>
                  <input
                    type="number"
                    required
                    min={1}
                    step="any"
                    value={editCustodyForm.amount}
                    onChange={(e) =>
                      setEditCustodyForm({ ...editCustodyForm, amount: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">تاريخ التسليم *</label>
                  <input
                    type="date"
                    required
                    value={editCustodyForm.handoverDate}
                    onChange={(e) =>
                      setEditCustodyForm({ ...editCustodyForm, handoverDate: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">بند / الغرض من العهدة *</label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {CUSTODY_PURPOSE_PRESETS.map((preset) => {
                    const selected = editCustodyForm.purpose.trim() === preset;
                    return (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setEditCustodyForm({ ...editCustodyForm, purpose: preset })}
                        className={`rounded-lg border px-2.5 py-1 text-[11px] font-semibold cursor-pointer transition-colors ${
                          selected
                            ? 'bg-[#0B1F3A] text-[#C89B3C] border-[#0B1F3A]'
                            : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        {preset}
                      </button>
                    );
                  })}
                </div>
                <input
                  required
                  value={editCustodyForm.purpose}
                  onChange={(e) =>
                    setEditCustodyForm({ ...editCustodyForm, purpose: e.target.value })
                  }
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">ملاحظات</label>
                <input
                  value={editCustodyForm.notes}
                  onChange={(e) =>
                    setEditCustodyForm({ ...editCustodyForm, notes: e.target.value })
                  }
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
            </div>
            <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingCustody(null)}
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={savingCustody}
                className="rounded-lg bg-[#0B1F3A] px-5 py-2 text-xs font-bold text-white cursor-pointer"
              >
                {savingCustody ? 'جاري الحفظ...' : 'حفظ التعديل'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL: CREATE / EDIT EXTERNAL ACCOUNT OR DEBT */}
      {accountModalMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <form
            onSubmit={handleSaveAccount}
            className="w-full max-w-xl bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden"
          >
            <div className="px-5 py-3.5 bg-[#0B1F3A] text-white flex items-center justify-between">
              <span className="font-display font-bold text-sm">
                {accountModalMode === 'create'
                  ? 'تسجيل مديونية / حساب خارج عن الحسابات الأساسية'
                  : `تعديل الحساب (${editingAccount?.accountCode})`}
              </span>
              <button
                type="button"
                onClick={() => setAccountModalMode(null)}
                className="text-slate-300 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-3 text-xs max-h-[78vh] overflow-y-auto">
              {accountModalError && (
                <div className="rounded-lg bg-red-50 border border-red-200 p-2.5 text-red-800">
                  {accountModalError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">طبيعة السجل *</label>
                  <select
                    value={accountForm.accountKind}
                    onChange={(e) =>
                      setAccountForm({
                        ...accountForm,
                        accountKind: e.target.value as ExternalAccountKind,
                      })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-bold text-[#0B1F3A]"
                  >
                    <option value="debt_receivable">مديونية لنا (مستحق عند الغير)</option>
                    <option value="debt_payable">مديونية علينا (التزام للغير)</option>
                    <option value="external_account">حساب خاص / خارجي مستقل</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">التصنيف</label>
                  <select
                    value={accountForm.category}
                    onChange={(e) => setAccountForm({ ...accountForm, category: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2"
                  >
                    {EXTERNAL_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">نوع الطرف</label>
                  <select
                    value={accountForm.partyType}
                    onChange={(e) =>
                      setAccountForm({
                        ...accountForm,
                        partyType: e.target.value as ExternalAccountPartyType,
                        driverId: '',
                        supervisorId: '',
                        employeeId: '',
                      })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2"
                  >
                    <option value="external">شخص / حساب حر خارجي</option>
                    <option value="supplier">مورّد / ورشة / محطة وقود</option>
                    <option value="school">مدرسة / شركة</option>
                    <option value="driver">سائق (خارج كشف الراتب)</option>
                    <option value="supervisor">مشرفة</option>
                    <option value="employee">موظف إداري</option>
                  </select>
                </div>

                {accountForm.partyType === 'driver' && accountModalMode === 'create' && (
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">اختر السائق</label>
                    <select
                      value={accountForm.driverId}
                      onChange={(e) => handleSelectAccountParty('driver', e.target.value)}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2"
                    >
                      <option value="">-- اختر --</option>
                      {lookups.drivers.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.fullName} ({d.driverCode})
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {accountForm.partyType === 'supervisor' && accountModalMode === 'create' && (
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">اختر المشرفة</label>
                    <select
                      value={accountForm.supervisorId}
                      onChange={(e) => handleSelectAccountParty('supervisor', e.target.value)}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2"
                    >
                      <option value="">-- اختر --</option>
                      {lookups.supervisors.map((sv) => (
                        <option key={sv.id} value={sv.id}>
                          {sv.fullName}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {accountForm.partyType === 'employee' && accountModalMode === 'create' && (
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">اختر الموظف</label>
                    <select
                      value={accountForm.employeeId}
                      onChange={(e) => handleSelectAccountParty('employee', e.target.value)}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2"
                    >
                      <option value="">-- اختر --</option>
                      {lookups.employees.map((em) => (
                        <option key={em.id} value={em.id}>
                          {em.fullName}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">اسم الطرف / صاحب الحساب *</label>
                  <input
                    required
                    value={accountForm.partyName}
                    onChange={(e) => setAccountForm({ ...accountForm, partyName: e.target.value })}
                    placeholder="الاسم أو الجهة أو الورشة..."
                    className="w-full rounded-lg border border-slate-200 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">رقم الهاتف</label>
                  <input
                    value={accountForm.partyPhone}
                    onChange={(e) => setAccountForm({ ...accountForm, partyPhone: e.target.value })}
                    placeholder="01xxxxxxxxx"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">البيان / سبب المديونية أو الحساب *</label>
                <input
                  required
                  value={accountForm.title}
                  onChange={(e) => setAccountForm({ ...accountForm, title: e.target.value })}
                  placeholder="مثال: حساب صيانة باص خارجي / مديونية رحلة خاصة / تسوية خارجية"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">إجمالي المبلغ (ج.م) *</label>
                  <input
                    type="number"
                    required
                    min={1}
                    step="any"
                    value={accountForm.principalAmount}
                    onChange={(e) =>
                      setAccountForm({ ...accountForm, principalAmount: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono font-bold"
                  />
                </div>
                {accountModalMode === 'create' && (
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">مسدد مقدماً (اختياري)</label>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={accountForm.initialSettledAmount}
                      onChange={(e) =>
                        setAccountForm({ ...accountForm, initialSettledAmount: e.target.value })
                      }
                      placeholder="0"
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                    />
                  </div>
                )}
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">طريقة التعامل</label>
                  <select
                    value={accountForm.paymentMethod}
                    onChange={(e) =>
                      setAccountForm({ ...accountForm, paymentMethod: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2"
                  >
                    {PAYMENT_METHODS.map((pm) => (
                      <option key={pm} value={pm}>
                        {pm}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">تاريخ التسجيل *</label>
                  <input
                    type="date"
                    required
                    value={accountForm.openedDate}
                    onChange={(e) => setAccountForm({ ...accountForm, openedDate: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">تاريخ الاستحقاق (اختياري)</label>
                  <input
                    type="date"
                    value={accountForm.dueDate}
                    onChange={(e) => setAccountForm({ ...accountForm, dueDate: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">ربط بمدرسة (اختياري)</label>
                  <select
                    value={accountForm.schoolId}
                    onChange={(e) => setAccountForm({ ...accountForm, schoolId: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2"
                  >
                    <option value="">حساب حر / الإدارة العامة</option>
                    {lookups.schools.map((sc) => (
                      <option key={sc.id} value={sc.id}>
                        {sc.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">ملاحظات تفصيلية</label>
                <textarea
                  rows={2}
                  value={accountForm.notes}
                  onChange={(e) => setAccountForm({ ...accountForm, notes: e.target.value })}
                  placeholder="أي تفاصيل إضافية تخص هذا الحساب أو المديونية..."
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
            </div>
            <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAccountModalMode(null)}
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={savingAccount}
                className="rounded-lg bg-[#0B1F3A] px-5 py-2 text-xs font-bold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
              >
                {savingAccount ? 'جاري الحفظ...' : 'حفظ السجل'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL: ADD ENTRY / PAYMENT */}
      {entryTargetAccount && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <form
            onSubmit={handleSaveEntry}
            className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden"
          >
            <div className="px-5 py-3.5 bg-[#0B1F3A] text-white flex items-center justify-between">
              <span className="font-display font-bold text-sm">
                تسجيل حركة / سداد ({entryTargetAccount.accountCode})
              </span>
              <button
                type="button"
                onClick={() => setEntryTargetAccount(null)}
                className="text-slate-300 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-3 text-xs">
              {entryError && (
                <div className="rounded-lg bg-red-50 border border-red-200 p-2.5 text-red-800">
                  {entryError}
                </div>
              )}
              <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 space-y-1">
                <div className="font-bold text-[#0B1F3A]">
                  {entryTargetAccount.partyName} — {entryTargetAccount.title}
                </div>
                <div className="text-slate-600 flex items-center justify-between">
                  <span>الأصل: {formatEGP(entryTargetAccount.principalAmount)}</span>
                  <span className="font-bold text-amber-800">
                    المتبقي: {formatEGP(entryTargetAccount.remainingAmount)}
                  </span>
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">نوع الحركة</label>
                <select
                  value={entryForm.entryType}
                  onChange={(e) =>
                    setEntryForm({
                      ...entryForm,
                      entryType: e.target.value as ExternalAccountEntryType,
                    })
                  }
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 font-bold text-[#0B1F3A]"
                >
                  <option value="payment">سداد / تحصيل دفعة (يُخصم من المتبقي)</option>
                  <option value="addition">إضافة مبلغ جديد على نفس الحساب (يزيد الأصل)</option>
                  <option value="adjustment">خصم / تسوية سماح</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">المبلغ (ج.م) *</label>
                  <input
                    type="number"
                    required
                    min={0.01}
                    step="any"
                    value={entryForm.amount}
                    onChange={(e) => setEntryForm({ ...entryForm, amount: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">التاريخ *</label>
                  <input
                    type="date"
                    required
                    value={entryForm.entryDate}
                    onChange={(e) => setEntryForm({ ...entryForm, entryDate: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">طريقة الدفع</label>
                <select
                  value={entryForm.paymentMethod}
                  onChange={(e) => setEntryForm({ ...entryForm, paymentMethod: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                >
                  {PAYMENT_METHODS.map((pm) => (
                    <option key={pm} value={pm}>
                      {pm}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">ملاحظات الحركة</label>
                <input
                  value={entryForm.notes}
                  onChange={(e) => setEntryForm({ ...entryForm, notes: e.target.value })}
                  placeholder="تفاصيل الدفعة أو رقم التحويل..."
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
            </div>
            <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEntryTargetAccount(null)}
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={savingEntry}
                className="rounded-lg bg-[#0B1F3A] px-5 py-2 text-xs font-bold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
              >
                {savingEntry ? 'جاري التسجيل...' : 'تأكيد الحركة'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL: ACCOUNT STATEMENT & ENTRIES HISTORY */}
      {detailAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-2xl max-h-[90vh] bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden flex flex-col">
            <div className="px-5 py-3.5 bg-[#0B1F3A] text-white flex items-center justify-between shrink-0">
              <div>
                <div className="font-display font-bold text-sm">
                  كشف حركات الحساب ({detailAccount.accountCode}) — {detailAccount.partyName}
                </div>
                <div className="text-[11px] text-slate-300 mt-0.5">{detailAccount.title}</div>
              </div>
              <button
                type="button"
                onClick={() => setDetailAccount(null)}
                className="text-slate-300 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-4 text-xs">
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div className="text-slate-500">أصل الحساب</div>
                  <div className="mt-1 font-mono font-bold text-sm text-[#0B1F3A]">
                    {formatEGP(detailAccount.principalAmount)}
                  </div>
                </div>
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                  <div className="text-emerald-700">المسدد / المحصل</div>
                  <div className="mt-1 font-mono font-bold text-sm text-emerald-800">
                    {formatEGP(detailAccount.settledAmount)}
                  </div>
                </div>
                <div className="rounded-xl bg-[#0B1F3A] text-white p-3">
                  <div className="text-slate-300">المتبقي الحالي</div>
                  <div className="mt-1 font-mono font-bold text-sm text-[#C89B3C]">
                    {formatEGP(detailAccount.remainingAmount)}
                  </div>
                </div>
              </div>

              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <table className="w-full text-right text-xs">
                  <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="py-2.5 px-3">التاريخ</th>
                      <th className="py-2.5 px-3">النوع</th>
                      <th className="py-2.5 px-3">المبلغ</th>
                      <th className="py-2.5 px-3">الطريقة / الملاحظات</th>
                      <th className="py-2.5 px-3">المسجل</th>
                      {canWrite && <th className="py-2.5 px-3">حذف</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {detailLoading ? (
                      <tr>
                        <td colSpan={6} className="py-6 text-center text-slate-400">
                          جاري تحميل سجل الحركات...
                        </td>
                      </tr>
                    ) : detailEntries.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-6 text-center text-slate-400">
                          لا توجد حركات مسجلة على هذا الحساب بعد
                        </td>
                      </tr>
                    ) : (
                      detailEntries.map((ent) => (
                        <tr key={ent.id}>
                          <td className="py-2.5 px-3 font-mono text-slate-600">{ent.entryDate}</td>
                          <td className="py-2.5 px-3 font-semibold">
                            {ent.entryType === 'addition'
                              ? 'إضافة مبلغ'
                              : ent.entryType === 'adjustment'
                              ? 'تسوية / خصم'
                              : 'سداد / تحصيل'}
                          </td>
                          <td
                            className={`py-2.5 px-3 font-mono font-bold ${
                              ent.entryType === 'addition' ? 'text-amber-700' : 'text-emerald-700'
                            }`}
                          >
                            {formatEGP(ent.amount)}
                          </td>
                          <td className="py-2.5 px-3 text-slate-600">
                            {ent.paymentMethod} {ent.notes ? `— ${ent.notes}` : ''}
                          </td>
                          <td className="py-2.5 px-3 text-slate-500">{ent.recordedByName || '—'}</td>
                          {canWrite && (
                            <td className="py-2.5 px-3">
                              <button
                                type="button"
                                onClick={() => handleDeleteEntry(detailAccount.id, ent.id)}
                                className="p-1 text-red-600 hover:text-red-800 cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          )}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2 shrink-0">
              <div className="flex items-center gap-2">
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => openAddEntryModal(detailAccount)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#0B1F3A] px-3.5 py-2 text-xs font-bold text-white cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5 text-[#C89B3C]" />
                    تسجيل حركة جديدة
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handlePrintAccountStatement(detailAccount, detailEntries)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 cursor-pointer"
                >
                  <Printer className="w-3.5 h-3.5" />
                  طباعة كشف الحساب
                </button>
              </div>
              <button
                type="button"
                onClick={() => setDetailAccount(null)}
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 cursor-pointer"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CONFIRM DELETE CUSTODY OR EXTERNAL ACCOUNT */}
      {(deletingCustody || deletingAccount) && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-sm bg-white rounded-2xl border border-slate-200 shadow-2xl p-5 space-y-4">
            <div className="flex items-center gap-2 text-red-700 font-bold text-sm">
              <AlertTriangle className="w-5 h-5" />
              تأكيد الحذف
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              {deletingCustody
                ? `هل أنت متأكد من حذف العهدة (${deletingCustody.custodyCode} — ${deletingCustody.beneficiaryName})؟ لا يمكن التراجع عن الحذف.`
                : `هل أنت متأكد من حذف الحساب (${deletingAccount?.accountCode} — ${deletingAccount?.partyName}) وكافة حركاته؟`}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setDeletingCustody(null);
                  setDeletingAccount(null);
                }}
                className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 cursor-pointer"
              >
                تراجع
              </button>
              <button
                type="button"
                disabled={deletingBusy}
                onClick={deletingCustody ? handleDeleteCustody : handleDeleteAccount}
                className="rounded-lg bg-red-600 hover:bg-red-700 px-4 py-2 text-xs font-bold text-white cursor-pointer"
              >
                {deletingBusy ? 'جاري الحذف...' : 'حذف نهائياً'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
