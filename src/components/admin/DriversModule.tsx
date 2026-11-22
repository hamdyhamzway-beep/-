import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Check,
  Copy,
  Download,
  FileText,
  Loader2,
  MessageCircle,
  Plus,
  RadioTower,
  Search,
  Trash2,
  Edit3,
  Wallet,
  X,
} from 'lucide-react';
import {
  apiFetch,
  formatEGP,
  getLocalTodayDateString,
  normalizeLookupText,
  normalizeTimeInputValue,
} from '../../lib/api';
import { useEscapeKey } from '../../lib/useEscapeKey';
import {
  buildWhatsAppUrl,
  captureElementAsPngBlob,
  copyPngBlobToClipboard,
  downloadBlob,
  renderStatementFallbackBlob,
  shareImageFileViaWebShare,
} from '../../lib/whatsapp-statement';
import { useAuth } from '../../contexts/AuthContext';
import { ContactPhoneInput } from '../ContactPhoneInput';
import { DriverAvatar } from '../DriverAvatar';
import { DriverBroadcastModal } from './DriverBroadcastModal';
import { DriverLicensesSection } from '../DriverLicensesSection';
import { DriverPhotoUploader } from '../DriverPhotoUploader';
import type {
  AdvanceRecord,
  CoverageRecord,
  DriverLicensePhoto,
  EnrichedDriver,
  FinancialTransaction,
  SalaryRecord,
} from '../../types';

interface StatementResponse {
  driver: EnrichedDriver;
  period: {
    month: number;
    year: number;
    startDate?: string;
    endDate?: string;
    labelAr?: string;
    shortLabelAr?: string;
  };
  salary: SalaryRecord;
  advances: AdvanceRecord[];
  coverages: CoverageRecord[];
  transactions: FinancialTransaction[];
}

export const DriversModule: React.FC<{
  onOpenDriversChat?: () => void;
}> = ({ onOpenDriversChat }) => {
  const { dbUser } = useAuth();
  const perms = dbUser?.permissions || [];
  const isSuperAdmin = dbUser?.roleSlug === 'super_admin' || perms.includes('*');
  const can = (perm: string) => isSuperAdmin || perms.includes('*') || perms.includes(perm);

  const canDriversWrite = can('drivers:write');
  const canAdvancesWrite = can('advances:write') || can('finance:write');
  const canCoverageWrite = can('coverage:write') || can('finance:write');
  const canFinanceWrite = can('finance:write');
  const canFinanceRead = can('finance:read') || canFinanceWrite;
  const canViewFinancialDetails = canFinanceRead || canAdvancesWrite || canCoverageWrite;
  const restrictedSchoolIds = dbUser?.assignedSchoolIds || [];
  const restrictedSchoolCount = restrictedSchoolIds.length;
  const isSingleSchoolRestricted = !isSuperAdmin && restrictedSchoolCount === 1;

  const [driversList, setDriversList] = useState<EnrichedDriver[]>([]);
  const [mySchools, setMySchools] = useState<Array<{ id: number; name: string }>>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [showBroadcastModal, setShowBroadcastModal] = useState(false);

  // Add/Edit Modal
  const [showForm, setShowForm] = useState(false);
  const [editingDriver, setEditingDriver] = useState<EnrichedDriver | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [formState, setFormState] = useState({
    driverCode: '',
    fullName: '',
    phone: '',
    emergencyContact: '',
    linkedEmail: '',
    monthlyAgreedSalary: '',
    employmentStartDate: '',
    accountStatus: 'active',
    photoUrl: '',
    licensePhotos: [] as DriverLicensePhoto[],
    notes: '',
    schoolName: '',
    busNumber: '',
    routeId: '',
    routeName: '',
    routePickupArea: '',
    routePickupTime: '',
    routeDropoffTime: '',
  });

  // Optional route timings section inside Driver Modal
  const [showRouteTimings, setShowRouteTimings] = useState(false);

  // Driver Financial / Statement / Advances & Coverages Modal
  const [statementDriverId, setStatementDriverId] = useState<number | null>(null);
  const [statementTab, setStatementTab] = useState<
    'statement' | 'advances' | 'coverage' | 'adjustments'
  >('statement');
  const [statementMonth, setStatementMonth] = useState(new Date().getMonth() + 1);
  const [statementYear, setStatementYear] = useState(new Date().getFullYear());
  const [statementData, setStatementData] = useState<StatementResponse | null>(null);
  const [statementLoading, setStatementLoading] = useState(false);
  const pendingAutoPeriodRef = useRef(false);
  const skipNextAutoFetchRef = useRef(false);
  const [financeBusy, setFinanceBusy] = useState(false);
  const [financeNotice, setFinanceNotice] = useState<string | null>(null);
  const [financeErr, setFinanceErr] = useState<string | null>(null);
  const statementCaptureRef = useRef<HTMLDivElement | null>(null);
  const [sharingWhatsApp, setSharingWhatsApp] = useState(false);
  const [whatsappPreview, setWhatsappPreview] = useState<{
    blob: Blob;
    url: string;
    filename: string;
    copied: boolean;
    statusText: string;
    whatsappUrl: string;
    driverPhone: string;
  } | null>(null);

  const todayStr = getLocalTodayDateString();
  const [newAdv, setNewAdv] = useState({
    amount: '',
    date: todayStr,
    paymentMethod: '',
    reason: '',
  });
  const [editingAdvId, setEditingAdvId] = useState<number | null>(null);
  const [editAdv, setEditAdv] = useState({
    amount: '',
    date: '',
    paymentMethod: '',
    reason: '',
    notes: '',
  });

  const [newCov, setNewCov] = useState({
    replacementQuery: '',
    date: todayStr,
    coverageAmount: '',
    reason: '',
  });
  const [editingCovId, setEditingCovId] = useState<number | null>(null);
  const [editCov, setEditCov] = useState({
    replacementQuery: '',
    date: '',
    coverageAmount: '',
    reason: '',
    notes: '',
  });

  const [newAdj, setNewAdj] = useState({
    type: 'bonus' as 'bonus' | 'other_deduction',
    amount: '',
    description: '',
  });
  const [editingAdjId, setEditingAdjId] = useState<number | null>(null);
  const [editAdj, setEditAdj] = useState({
    type: 'bonus' as 'bonus' | 'other_deduction',
    amount: '',
    description: '',
  });

  // Delete Confirmation Modal
  const [deleteTarget, setDeleteTarget] = useState<EnrichedDriver | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEscapeKey(Boolean(deleteTarget || statementDriverId || showForm), () => {
    if (deleteTarget) setDeleteTarget(null);
    else if (statementDriverId) setStatementDriverId(null);
    else if (showForm) setShowForm(false);
  });

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [dRes, schoolsRes] = await Promise.all([
        apiFetch<{ drivers: EnrichedDriver[] }>('/api/drivers'),
        apiFetch<{ schools: Array<{ id: number; name: string }> }>('/api/my-schools').catch(() => ({
          schools: [],
        })),
      ]);
      setDriversList(dRes.drivers);
      setMySchools(schoolsRes.schools || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل بيانات السائقين');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const openAdd = () => {
    setEditingDriver(null);
    setFormError(null);
    setShowRouteTimings(false);
    const defaultSchoolName = isSingleSchoolRestricted
      ? mySchools.find((s) => s.id === restrictedSchoolIds[0])?.name ||
        dbUser?.assignedSchoolNames?.[0] ||
        ''
      : !isSuperAdmin && mySchools.length > 0
      ? mySchools[0].name
      : '';
    setFormState({
      driverCode: '',
      fullName: '',
      phone: '',
      emergencyContact: '',
      linkedEmail: '',
      monthlyAgreedSalary: '',
      employmentStartDate: '',
      accountStatus: 'active',
      photoUrl: '',
      licensePhotos: [] as DriverLicensePhoto[],
      notes: '',
      schoolName: defaultSchoolName,
      busNumber: '',
      routeId: '',
      routeName: '',
      routePickupArea: '',
      routePickupTime: '',
      routeDropoffTime: '',
    });
    setShowForm(true);
  };

  const openEdit = (d: EnrichedDriver) => {
    setEditingDriver(d);
    setFormError(null);
    setShowRouteTimings(false);
    setFormState({
      driverCode: d.driverCode,
      fullName: d.fullName,
      phone: d.phone,
      emergencyContact: d.emergencyContact || '',
      linkedEmail: d.linkedEmail || '',
      monthlyAgreedSalary: String(d.monthlyAgreedSalary),
      employmentStartDate: d.employmentStartDate,
      accountStatus: d.accountStatus,
      photoUrl: d.photoUrl || '',
      licensePhotos: d.licensePhotos || [],
      notes: d.notes || '',
      schoolName: d.schoolId && d.schoolName && d.schoolName !== 'غير معين' ? d.schoolName : '',
      busNumber: d.vehicleId && d.busNumber && d.busNumber !== '—' ? d.busNumber : '',
      routeId: d.routeId ? String(d.routeId) : '',
      routeName: d.routeId && d.routeName && d.routeName !== '—' ? d.routeName : '',
      routePickupArea: d.pickupArea || '',
      routePickupTime: normalizeTimeInputValue(d.pickupTime),
      routeDropoffTime: normalizeTimeInputValue(d.dropoffTime),
    });
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      const payload = {
        ...formState,
        monthlyAgreedSalary: Number(formState.monthlyAgreedSalary || 0),
        schoolName: formState.schoolName.trim(),
        busNumber: formState.busNumber.trim(),
        routeId: formState.routeId ? Number(formState.routeId) : null,
        routeName: formState.routeName.trim(),
      };
      if (editingDriver) {
        await apiFetch(`/api/drivers/${editingDriver.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch('/api/drivers', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      setShowForm(false);
      await loadAll();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'تعذر حفظ بيانات السائق');
    } finally {
      setSaving(false);
    }
  };

  const archiveDriver = async (d: EnrichedDriver) => {
    setError(null);
    setSuccessMsg(null);
    try {
      await apiFetch(`/api/drivers/${d.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ accountStatus: 'inactive' }),
      });
      setSuccessMsg(`تم نقل السائق ${d.fullName} إلى قسم الأرشفة.`);
      await loadAll();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر أرشفة السائق');
    }
  };

  const openDeleteModal = (d: EnrichedDriver) => {
    setDeleteError(null);
    setDeleteTarget(d);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiFetch(`/api/drivers/${deleteTarget.id}`, { method: 'DELETE' });
      setDeleteTarget(null);
      setShowForm(false);
      await loadAll();
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : 'تعذر حذف السائق');
    } finally {
      setDeleting(false);
    }
  };

  const handleDeactivateFromDeleteModal = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiFetch(`/api/drivers/${deleteTarget.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ accountStatus: 'inactive' }),
      });
      setDeleteTarget(null);
      setShowForm(false);
      await loadAll();
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : 'تعذر إيقاف الحساب');
    } finally {
      setDeleting(false);
    }
  };

  const loadStatement = useCallback(
    async (id: number, month: number, year: number, useAuto = false) => {
      setStatementLoading(true);
      try {
        const res = await apiFetch<StatementResponse>(
          `/api/drivers/${id}/statement?month=${month}&year=${year}${useAuto ? '&autoPeriod=true' : ''}`
        );
        setStatementData(res);
        if (res.period && (res.period.month !== month || res.period.year !== year)) {
          skipNextAutoFetchRef.current = true;
          setStatementMonth(res.period.month);
          setStatementYear(res.period.year);
        }
        const pStart = res.period?.startDate;
        const pEnd = res.period?.endDate;
        if (pStart && pEnd) {
          const today = getLocalTodayDateString();
          const preferredDate = today >= pStart && today <= pEnd ? today : pStart;
          setNewAdv((prev) =>
            prev.date && prev.date >= pStart && prev.date <= pEnd
              ? prev
              : { ...prev, date: preferredDate }
          );
          setNewCov((prev) =>
            prev.date && prev.date >= pStart && prev.date <= pEnd
              ? prev
              : { ...prev, date: preferredDate }
          );
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'تعذر تحميل كشف الحساب');
      } finally {
        setStatementLoading(false);
      }
    },
    []
  );

  const clearWhatsappPreview = useCallback(() => {
    setWhatsappPreview((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return null;
    });
  }, []);

  const getAllowedStatementTab = useCallback(
    (preferred: 'statement' | 'advances' | 'coverage' | 'adjustments') => {
      const allowedTabs: Array<'statement' | 'advances' | 'coverage' | 'adjustments'> = [];
      if (canViewFinancialDetails) allowedTabs.push('statement');
      if (canAdvancesWrite || canFinanceRead) allowedTabs.push('advances');
      if (canCoverageWrite || canFinanceRead) allowedTabs.push('coverage');
      if (canFinanceRead) allowedTabs.push('adjustments');
      if (allowedTabs.includes(preferred)) return preferred;
      return allowedTabs[0] || 'statement';
    },
    [canViewFinancialDetails, canAdvancesWrite, canCoverageWrite, canFinanceRead]
  );

  const openStatement = (
    id: number,
    initialTab: 'statement' | 'advances' | 'coverage' | 'adjustments' = 'statement'
  ) => {
    if (!canViewFinancialDetails) return;
    clearWhatsappPreview();
    setFinanceNotice(null);
    setFinanceErr(null);
    setEditingAdvId(null);
    setEditingCovId(null);
    setEditingAdjId(null);
    setStatementTab(getAllowedStatementTab(initialTab));
    if (id === statementDriverId) {
      loadStatement(id, statementMonth, statementYear, true);
    } else {
      pendingAutoPeriodRef.current = true;
      setStatementData(null);
      setStatementDriverId(id);
    }
  };

  const handleAddDriverAdvance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!statementDriverId) return;
    setFinanceBusy(true);
    setFinanceErr(null);
    setFinanceNotice(null);
    try {
      const res = await apiFetch<{
        period?: { month: number; year: number };
        billingRange?: { startDate?: string; endDate?: string };
      }>('/api/finance/advances', {
        method: 'POST',
        body: JSON.stringify({
          driverId: statementDriverId,
          schoolId: statementData?.driver?.schoolId ?? null,
          schoolName:
            statementData?.driver?.schoolName && statementData.driver.schoolName !== 'غير معين'
              ? statementData.driver.schoolName
              : undefined,
          amount: Number(newAdv.amount),
          date: newAdv.date,
          paymentMethod: newAdv.paymentMethod.trim(),
          reason: newAdv.reason.trim(),
          idempotencyKey: `drv-adv-${statementDriverId}-${newAdv.amount}-${Date.now()}`,
        }),
      });
      const targetMonth = res.period?.month || statementMonth;
      const targetYear = res.period?.year || statementYear;
      if (targetMonth !== statementMonth || targetYear !== statementYear) {
        skipNextAutoFetchRef.current = true;
        setStatementMonth(targetMonth);
        setStatementYear(targetYear);
      }
      setNewAdv((p) => ({ ...p, amount: '', paymentMethod: '', reason: '' }));
      setFinanceNotice(
        `تمت إضافة السلفة وتحديث صافي الراتب (فترة شهر ${targetMonth} / ${targetYear}).`
      );
      await Promise.all([loadStatement(statementDriverId, targetMonth, targetYear), loadAll()]);
    } catch (err: unknown) {
      setFinanceErr(err instanceof Error ? err.message : 'تعذر إضافة السلفة');
    } finally {
      setFinanceBusy(false);
    }
  };

  const handleSaveDriverAdvanceEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!statementDriverId || !editingAdvId) return;
    setFinanceBusy(true);
    setFinanceErr(null);
    setFinanceNotice(null);
    try {
      const res = await apiFetch<{ period?: { month: number; year: number } }>(
        `/api/finance/advances/${editingAdvId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            amount: Number(editAdv.amount),
            date: editAdv.date,
            paymentMethod: editAdv.paymentMethod.trim(),
            reason: editAdv.reason.trim(),
            notes: editAdv.notes.trim(),
          }),
        }
      );
      const targetMonth = res.period?.month || statementMonth;
      const targetYear = res.period?.year || statementYear;
      if (targetMonth !== statementMonth || targetYear !== statementYear) {
        skipNextAutoFetchRef.current = true;
        setStatementMonth(targetMonth);
        setStatementYear(targetYear);
      }
      setEditingAdvId(null);
      setFinanceNotice('تم تعديل السلفة وإعادة احتساب الراتب.');
      await Promise.all([loadStatement(statementDriverId, targetMonth, targetYear), loadAll()]);
    } catch (err: unknown) {
      setFinanceErr(err instanceof Error ? err.message : 'تعذر تعديل السلفة');
    } finally {
      setFinanceBusy(false);
    }
  };

  const handleDeleteDriverAdvance = async (advId: number) => {
    if (!statementDriverId) return;
    setFinanceBusy(true);
    setFinanceErr(null);
    setFinanceNotice(null);
    try {
      await apiFetch(`/api/finance/advances/${advId}`, { method: 'DELETE' });
      if (editingAdvId === advId) setEditingAdvId(null);
      setFinanceNotice('تم حذف السلفة وتحديث صافي الراتب.');
      await Promise.all([loadStatement(statementDriverId, statementMonth, statementYear), loadAll()]);
    } catch (err: unknown) {
      setFinanceErr(err instanceof Error ? err.message : 'تعذر حذف السلفة');
    } finally {
      setFinanceBusy(false);
    }
  };

  const handleAddDriverCoverage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!statementDriverId) return;
    setFinanceBusy(true);
    setFinanceErr(null);
    setFinanceNotice(null);
    try {
      const res = await apiFetch<{ period?: { month: number; year: number } }>(
        '/api/finance/coverage',
        {
          method: 'POST',
          body: JSON.stringify({
            absentDriverId: statementDriverId,
            schoolId: statementData?.driver?.schoolId ?? null,
            schoolName:
              statementData?.driver?.schoolName && statementData.driver.schoolName !== 'غير معين'
                ? statementData.driver.schoolName
                : undefined,
            replacementQuery: newCov.replacementQuery.trim(),
            date: newCov.date,
            coverageAmount: Number(newCov.coverageAmount || 0),
            reason: newCov.reason.trim(),
            idempotencyKey: `drv-cov-${statementDriverId}-${newCov.date}-${Date.now()}`,
          }),
        }
      );
      const targetMonth = res.period?.month || statementMonth;
      const targetYear = res.period?.year || statementYear;
      if (targetMonth !== statementMonth || targetYear !== statementYear) {
        skipNextAutoFetchRef.current = true;
        setStatementMonth(targetMonth);
        setStatementYear(targetYear);
      }
      setNewCov((p) => ({
        ...p,
        replacementQuery: '',
        coverageAmount: '',
        reason: '',
      }));
      setFinanceNotice(
        `تم تسجيل التغطية وتحديث صافي الراتب (فترة شهر ${targetMonth} / ${targetYear}).`
      );
      await Promise.all([loadStatement(statementDriverId, targetMonth, targetYear), loadAll()]);
    } catch (err: unknown) {
      setFinanceErr(err instanceof Error ? err.message : 'تعذر تسجيل التغطية');
    } finally {
      setFinanceBusy(false);
    }
  };

  const handleSaveDriverCoverageEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!statementDriverId || !editingCovId) return;
    setFinanceBusy(true);
    setFinanceErr(null);
    setFinanceNotice(null);
    try {
      const res = await apiFetch<{ period?: { month: number; year: number } }>(
        `/api/finance/coverage/${editingCovId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            replacementQuery: editCov.replacementQuery.trim(),
            date: editCov.date,
            coverageAmount: Number(editCov.coverageAmount || 0),
            reason: editCov.reason.trim(),
            notes: editCov.notes.trim(),
          }),
        }
      );
      const targetMonth = res.period?.month || statementMonth;
      const targetYear = res.period?.year || statementYear;
      if (targetMonth !== statementMonth || targetYear !== statementYear) {
        skipNextAutoFetchRef.current = true;
        setStatementMonth(targetMonth);
        setStatementYear(targetYear);
      }
      setEditingCovId(null);
      setFinanceNotice('تم تعديل سجل التغطية وإعادة احتساب الراتب.');
      await Promise.all([loadStatement(statementDriverId, targetMonth, targetYear), loadAll()]);
    } catch (err: unknown) {
      setFinanceErr(err instanceof Error ? err.message : 'تعذر تعديل التغطية');
    } finally {
      setFinanceBusy(false);
    }
  };

  const handleDeleteDriverCoverage = async (covId: number) => {
    if (!statementDriverId) return;
    setFinanceBusy(true);
    setFinanceErr(null);
    setFinanceNotice(null);
    try {
      await apiFetch(`/api/finance/coverage/${covId}`, { method: 'DELETE' });
      if (editingCovId === covId) setEditingCovId(null);
      setFinanceNotice('تم حذف التغطية وتحديث صافي الراتب.');
      await Promise.all([loadStatement(statementDriverId, statementMonth, statementYear), loadAll()]);
    } catch (err: unknown) {
      setFinanceErr(err instanceof Error ? err.message : 'تعذر حذف التغطية');
    } finally {
      setFinanceBusy(false);
    }
  };

  const handleAddDriverAdjustment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!statementDriverId) return;
    setFinanceBusy(true);
    setFinanceErr(null);
    setFinanceNotice(null);
    try {
      await apiFetch('/api/finance/adjustments', {
        method: 'POST',
        body: JSON.stringify({
          driverId: statementDriverId,
          month: statementMonth,
          year: statementYear,
          type: newAdj.type,
          amount: Number(newAdj.amount),
          description: newAdj.description.trim(),
        }),
      });
      setNewAdj((p) => ({ ...p, amount: '', description: '' }));
      setFinanceNotice('تم حفظ التسوية وتحديث الراتب.');
      await Promise.all([loadStatement(statementDriverId, statementMonth, statementYear), loadAll()]);
    } catch (err: unknown) {
      setFinanceErr(err instanceof Error ? err.message : 'تعذر تسجيل التسوية');
    } finally {
      setFinanceBusy(false);
    }
  };

  const handleSaveDriverAdjEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!statementDriverId || !editingAdjId) return;
    setFinanceBusy(true);
    setFinanceErr(null);
    setFinanceNotice(null);
    try {
      await apiFetch(`/api/finance/adjustments/${editingAdjId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          type: editAdj.type,
          amount: Number(editAdj.amount),
          description: editAdj.description.trim(),
        }),
      });
      setEditingAdjId(null);
      setFinanceNotice('تم تعديل التسوية وتحديث صافي الراتب.');
      await Promise.all([loadStatement(statementDriverId, statementMonth, statementYear), loadAll()]);
    } catch (err: unknown) {
      setFinanceErr(err instanceof Error ? err.message : 'تعذر تعديل التسوية');
    } finally {
      setFinanceBusy(false);
    }
  };

  const handleDeleteDriverAdj = async (adjId: number) => {
    if (!statementDriverId) return;
    setFinanceBusy(true);
    setFinanceErr(null);
    setFinanceNotice(null);
    try {
      await apiFetch(`/api/finance/adjustments/${adjId}`, { method: 'DELETE' });
      if (editingAdjId === adjId) setEditingAdjId(null);
      setFinanceNotice('تم حذف التسوية وتحديث الراتب.');
      await Promise.all([loadStatement(statementDriverId, statementMonth, statementYear), loadAll()]);
    } catch (err: unknown) {
      setFinanceErr(err instanceof Error ? err.message : 'تعذر حذف التسوية');
    } finally {
      setFinanceBusy(false);
    }
  };

  useEffect(() => {
    if (statementDriverId) {
      clearWhatsappPreview();
      if (skipNextAutoFetchRef.current) {
        skipNextAutoFetchRef.current = false;
        return;
      }
      const useAuto = pendingAutoPeriodRef.current;
      pendingAutoPeriodRef.current = false;
      loadStatement(statementDriverId, statementMonth, statementYear, useAuto);
    }
  }, [statementDriverId, statementMonth, statementYear, loadStatement, clearWhatsappPreview]);

  useEffect(() => {
    const safeTab = getAllowedStatementTab(statementTab);
    if (safeTab !== statementTab) {
      setStatementTab(safeTab);
    }
  }, [statementTab, getAllowedStatementTab]);

  useEffect(() => {
    return () => {
      if (whatsappPreview?.url) URL.revokeObjectURL(whatsappPreview.url);
    };
  }, [whatsappPreview]);

  const handleSendStatementToWhatsApp = async () => {
    if (!statementData) return;
    setSharingWhatsApp(true);
    setError(null);
    try {
      let blob: Blob;
      if (statementCaptureRef.current) {
        try {
          blob = await captureElementAsPngBlob(statementCaptureRef.current);
        } catch {
          blob = await renderStatementFallbackBlob(statementData);
        }
      } else {
        blob = await renderStatementFallbackBlob(statementData);
      }

      const safeName = statementData.driver.fullName.replace(/[^\u0600-\u06FFa-zA-Z0-9_-]+/g, '-');
      const filename = `كشف-حساب-${safeName}-${statementData.period.month}-${statementData.period.year}.png`;
      const caption = `كشف حساب ${statementData.driver.fullName} (كود ${statementData.driver.driverCode}) - شهر ${statementData.period.month}/${statementData.period.year} - صافي المستحق: ${formatEGP(statementData.salary.netSalary)}`;
      const whatsappUrl = buildWhatsAppUrl(statementData.driver.phone, caption);

      const webShareResult = await shareImageFileViaWebShare(
        blob,
        filename,
        `كشف حساب ${statementData.driver.fullName}`,
        caption
      );

      if (webShareResult === 'shared') {
        clearWhatsappPreview();
        const url = URL.createObjectURL(blob);
        setWhatsappPreview({
          blob,
          url,
          filename,
          copied: false,
          statusText: 'تم فتح المشاركة بالصورة بنجاح.',
          whatsappUrl,
          driverPhone: statementData.driver.phone || '',
        });
        return;
      }

      const copied = await copyPngBlobToClipboard(blob);
      downloadBlob(blob, filename);

      clearWhatsappPreview();
      const url = URL.createObjectURL(blob);
      setWhatsappPreview({
        blob,
        url,
        filename,
        copied,
        statusText: copied
          ? 'تم تجهيز صورة كشف الحساب ونسخها للحافظة وتحميلها — اضغط فتح الواتساب ثم الصق الصورة (Ctrl+V) أو أرفقها.'
          : 'تم تجهيز صورة كشف الحساب وتحميلها — اضغط فتح الواتساب وأرفق الصورة المحمّلة داخل المحادثة.',
        whatsappUrl,
        driverPhone: statementData.driver.phone || '',
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تجهيز صورة كشف الحساب للواتساب');
    } finally {
      setSharingWhatsApp(false);
    }
  };

  const handleRecopyWhatsappImage = async () => {
    if (!whatsappPreview) return;
    const copied = await copyPngBlobToClipboard(whatsappPreview.blob);
    setWhatsappPreview((prev) =>
      prev
        ? {
            ...prev,
            copied,
            statusText: copied
              ? 'تم نسخ صورة كشف الحساب للحافظة — الصقها مباشرة داخل الواتساب.'
              : 'المتصفح لا يدعم نسخ الصور للحافظة، يمكنك إرفاق الصورة المحمّلة.',
          }
        : null
    );
  };

  const filtered = driversList.filter((d) => {
    const q = normalizeLookupText(search);
    if (!q) return true;
    const digitsOnly = q.replace(/\D/g, '');
    return (
      normalizeLookupText(d.fullName).includes(q) ||
      normalizeLookupText(d.driverCode).includes(q) ||
      normalizeLookupText(d.phone).includes(q) ||
      (digitsOnly.length >= 2 && normalizeLookupText(d.phone).replace(/\D/g, '').includes(digitsOnly)) ||
      normalizeLookupText(d.schoolName).includes(q) ||
      normalizeLookupText(d.busNumber).includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#0B1F3A]">إدارة السائقين</h1>
          <p className="text-sm text-slate-500 mt-1">
            السائقون النشطون، تعديل البيانات، إدارة السلف والتغطيات لكل سائق، وكشوف الحساب الشهرية
          </p>
          {!isSuperAdmin && restrictedSchoolCount > 0 && (
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-900">
              عرض مقيّد بنطاق {restrictedSchoolCount} مدرسة مخصصة لك
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {isSuperAdmin && (
            <button
              type="button"
              onClick={() => setShowBroadcastModal(true)}
              className="flex items-center gap-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 px-4 py-2.5 text-xs font-bold text-white cursor-pointer whitespace-nowrap"
            >
              <RadioTower className="w-4 h-4" />
              رسائل جماعية للسائقين
            </button>
          )}
          {canDriversWrite && (
            <button
              onClick={openAdd}
              className="flex items-center gap-2 rounded-lg bg-[#0B1F3A] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#13325c] cursor-pointer whitespace-nowrap"
            >
              <Plus className="w-4 h-4 text-[#C89B3C]" />
              إضافة سائق جديد
            </button>
          )}
        </div>
      </div>

      {/* Search */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="بحث بالاسم، كود السائق، الهاتف، المدرسة، أو رقم الباص..."
            className="w-full rounded-lg border border-slate-200 bg-slate-50 pr-9 pl-8 py-2 text-xs focus:border-[#0B1F3A] focus:outline-none"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="مسح البحث"
              className="absolute left-2.5 top-2 text-slate-400 hover:text-slate-700 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div className="text-xs font-semibold text-slate-500">
          إجمالي السائقين النشطين: <span className="font-mono text-[#0B1F3A]">{filtered.length}</span>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-800 flex items-center justify-between gap-2">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="إغلاق التنبيه"
            className="p-1 text-red-500 hover:text-red-800 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {successMsg && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs font-semibold text-emerald-900 flex items-center justify-between gap-2">
          <span>{successMsg}</span>
          <button
            type="button"
            onClick={() => setSuccessMsg(null)}
            aria-label="إغلاق التنبيه"
            className="p-1 text-emerald-600 hover:text-emerald-900 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Mobile Cards View (Actions always visible on phone screens) */}
      <div className="md:hidden space-y-3">
        {loading ? (
          <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-xs text-slate-400">
            جاري تحميل قائمة السائقين...
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-xs text-slate-400">
            لا يوجد سائقون مطابقون لخيارات البحث
          </div>
        ) : (
          filtered.map((d) => (
            <div key={d.id} className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <DriverAvatar name={d.fullName} photoUrl={d.photoUrl} size="md" />
                  <div className="min-w-0">
                    <div className="font-bold text-sm text-[#0B1F3A] truncate">{d.fullName}</div>
                    <div className="text-xs text-slate-500 font-mono mt-0.5">
                      كود {d.driverCode} · {d.phone}
                    </div>
                  </div>
                </div>
                <span className="text-[11px] font-bold px-2 py-0.5 rounded-md shrink-0 bg-emerald-50 text-emerald-700">
                  نشط
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-2.5 text-[11px]">
                <div className={canFinanceRead ? '' : 'col-span-2'}>
                  <span className="text-slate-500">المدرسة والباص: </span>
                  <span className="font-semibold text-slate-800">
                    {d.schoolName} ({d.busNumber})
                  </span>
                </div>
                {canFinanceRead && (
                  <div className="text-left">
                    <span className="text-slate-500">الراتب: </span>
                    <span className="font-mono font-bold text-[#0B1F3A] tabular-nums">
                      {formatEGP(d.monthlyAgreedSalary)}
                    </span>
                  </div>
                )}
                <div className="col-span-2">
                  <span className="text-slate-500">خط السير: </span>
                  <span className="font-semibold text-[#0B1F3A]">{d.routeName || '—'}</span>
                </div>
              </div>

              {(canViewFinancialDetails || canDriversWrite) && (
                <div className="grid grid-cols-2 gap-2 pt-1">
                  {(canAdvancesWrite || canCoverageWrite || canFinanceRead) && (
                    <button
                      onClick={() =>
                        openStatement(d.id, canAdvancesWrite || canFinanceRead ? 'advances' : 'coverage')
                      }
                      className="flex items-center justify-center gap-1.5 rounded-lg bg-[#C89B3C] px-2.5 py-2 text-xs font-bold text-[#0B1F3A] hover:bg-[#d8ac4e] cursor-pointer"
                    >
                      <Wallet className="w-3.5 h-3.5" />
                      السلف والتغطيات
                    </button>
                  )}
                  {canDriversWrite && (
                    <button
                      onClick={() => openEdit(d)}
                      className="flex items-center justify-center gap-1.5 rounded-lg bg-[#0B1F3A] px-2.5 py-2 text-xs font-semibold text-white hover:bg-[#13325c] cursor-pointer"
                    >
                      <Edit3 className="w-3.5 h-3.5 text-[#C89B3C]" />
                      تعديل البيانات
                    </button>
                  )}
                  {canViewFinancialDetails && (
                    <button
                      onClick={() => openStatement(d.id, 'statement')}
                      className="flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-semibold text-[#0B1F3A] hover:bg-slate-50 cursor-pointer"
                    >
                      <FileText className="w-3.5 h-3.5" />
                      كشف حساب
                    </button>
                  )}
                  {canDriversWrite && (
                    <button
                      onClick={() => archiveDriver(d)}
                      className="flex items-center justify-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs font-semibold text-amber-800 hover:bg-amber-100 cursor-pointer"
                    >
                      <Archive className="w-3.5 h-3.5" />
                      أرشفة
                    </button>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Desktop Drivers Table */}
      <div className="hidden md:block bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
              <tr>
                <th className="py-3 px-4 font-semibold">الكود</th>
                <th className="py-3 px-4 font-semibold">بيانات السائق</th>
                <th className="py-3 px-4 font-semibold">المدرسة والخط</th>
                <th className="py-3 px-4 font-semibold">الباص والمالك</th>
                {canFinanceRead && <th className="py-3 px-4 font-semibold">الراتب المتفق عليه</th>}
                {(canViewFinancialDetails || canDriversWrite) && (
                  <th className="py-3 px-4 font-semibold">الإجراءات</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-slate-400">
                    جاري تحميل قائمة السائقين...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-slate-400">
                    لا يوجد سائقون مطابقون لخيارات البحث
                  </td>
                </tr>
              ) : (
                filtered.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50/70">
                    <td className="py-3.5 px-4 font-mono font-bold text-[#0B1F3A] tabular-nums">
                      {d.driverCode}
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="flex items-center gap-3">
                        <DriverAvatar name={d.fullName} photoUrl={d.photoUrl} size="sm" />
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-900 truncate">{d.fullName}</div>
                          <div className="text-slate-500 tabular-nums mt-0.5 truncate">
                            {d.phone}
                            {d.linkedEmail ? ` · ${d.linkedEmail}` : ''}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="font-medium text-slate-800">{d.schoolName}</div>
                      <div className="text-slate-500 mt-0.5">{d.routeName}</div>
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="font-mono font-medium text-slate-800">
                        {d.busNumber} · {d.registrationNumber}
                      </div>
                    </td>
                    {canFinanceRead && (
                      <td className="py-3.5 px-4 font-mono font-semibold text-slate-900 tabular-nums">
                        {formatEGP(d.monthlyAgreedSalary)}
                      </td>
                    )}
                    {(canViewFinancialDetails || canDriversWrite) && (
                      <td className="py-3.5 px-4">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {(canAdvancesWrite || canCoverageWrite || canFinanceRead) && (
                            <button
                              onClick={() =>
                                openStatement(
                                  d.id,
                                  canAdvancesWrite || canFinanceRead ? 'advances' : 'coverage'
                                )
                              }
                              className="flex items-center gap-1 rounded-md bg-[#C89B3C] px-2.5 py-1.5 text-[11px] font-bold text-[#0B1F3A] hover:bg-[#d8ac4e] cursor-pointer whitespace-nowrap"
                              title="إضافة وتعديل السلف والتغطيات"
                            >
                              <Wallet className="w-3.5 h-3.5" />
                              السلف والتغطيات
                            </button>
                          )}
                          {canDriversWrite && (
                            <button
                              onClick={() => openEdit(d)}
                              className="flex items-center gap-1 rounded-md bg-[#0B1F3A] px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-[#13325c] cursor-pointer whitespace-nowrap"
                              title="تعديل الاسم والبيانات والصورة"
                            >
                              <Edit3 className="w-3.5 h-3.5 text-[#C89B3C]" />
                              تعديل
                            </button>
                          )}
                          {canViewFinancialDetails && (
                            <button
                              onClick={() => openStatement(d.id, 'statement')}
                              className="flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-[#0B1F3A] hover:bg-slate-100 cursor-pointer whitespace-nowrap"
                            >
                              <FileText className="w-3.5 h-3.5" />
                              كشف حساب
                            </button>
                          )}
                          {canDriversWrite && (
                            <>
                              <button
                                onClick={() => archiveDriver(d)}
                                className="flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 cursor-pointer whitespace-nowrap"
                                title="نقل إلى الأرشفة"
                              >
                                <Archive className="w-3.5 h-3.5" />
                                أرشفة
                              </button>
                              <button
                                onClick={() => openDeleteModal(d)}
                                className="flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] font-semibold text-red-700 hover:bg-red-100 cursor-pointer whitespace-nowrap"
                                title="حذف السائق"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                حذف
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add/Edit Driver Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-2xl bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden max-h-[90vh] flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-[#0B1F3A] text-white">
              <h2 className="font-display text-base font-bold">
                {editingDriver ? `تعديل بيانات السائق (${editingDriver.driverCode})` : 'إضافة سائق جديد'}
              </h2>
              <button onClick={() => setShowForm(false)} className="text-slate-300 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-4 text-xs">
              {formError && (
                <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-red-800">
                  {formError}
                </div>
              )}

              <DriverPhotoUploader
                photoUrl={formState.photoUrl}
                driverName={formState.fullName}
                onChange={(photoUrl) => setFormState((prev) => ({ ...prev, photoUrl }))}
              />

              <DriverLicensesSection
                compact
                viewerRole="admin"
                photos={formState.licensePhotos}
                onChange={(licensePhotos) => setFormState((prev) => ({ ...prev, licensePhotos }))}
              />

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">كود السائق (فريد) *</label>
                  <input
                    required
                    value={formState.driverCode}
                    onChange={(e) => setFormState({ ...formState, driverCode: e.target.value })}
                    placeholder="اكتب كود السائق"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono focus:border-[#0B1F3A] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">الاسم الكامل *</label>
                  <input
                    required
                    value={formState.fullName}
                    onChange={(e) => setFormState({ ...formState, fullName: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 focus:border-[#0B1F3A] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">رقم الهاتف *</label>
                  <ContactPhoneInput
                    required
                    value={formState.phone}
                    onChange={(phone) => setFormState((prev) => ({ ...prev, phone }))}
                    onPickContact={({ phone, name }) =>
                      setFormState((prev) => ({
                        ...prev,
                        phone,
                        fullName: prev.fullName.trim() ? prev.fullName : name || prev.fullName,
                      }))
                    }
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">رقم الطوارئ</label>
                  <ContactPhoneInput
                    value={formState.emergencyContact}
                    placeholder="اكتب رقم الطوارئ"
                    onChange={(emergencyContact) =>
                      setFormState((prev) => ({ ...prev, emergencyContact }))
                    }
                    onPickContact={({ phone, name }) =>
                      setFormState((prev) => ({
                        ...prev,
                        emergencyContact: name ? `${phone} (${name})` : phone,
                      }))
                    }
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    الراتب الشهري المتفق عليه (ج.م) *
                  </label>
                  <input
                    type="number"
                    required
                    min={0}
                    placeholder="اكتب الراتب الشهري"
                    value={formState.monthlyAgreedSalary}
                    onChange={(e) =>
                      setFormState({ ...formState, monthlyAgreedSalary: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono focus:border-[#0B1F3A] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">تاريخ بدء العمل</label>
                  <input
                    type="date"
                    value={formState.employmentStartDate}
                    onChange={(e) =>
                      setFormState({ ...formState, employmentStartDate: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono focus:border-[#0B1F3A] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    البريد الإلكتروني (اختياري — للدخول بحساب Google)
                  </label>
                  <input
                    type="email"
                    value={formState.linkedEmail}
                    onChange={(e) => setFormState({ ...formState, linkedEmail: e.target.value })}
                    placeholder="اكتب البريد الإلكتروني (اختياري)"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono focus:border-[#0B1F3A] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">الوضع</label>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { value: 'active', label: 'نشط' },
                      { value: 'inactive', label: 'نقل للأرشفة' },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setFormState({ ...formState, accountStatus: opt.value })}
                        className={`rounded-lg border px-3 py-2 text-xs font-semibold cursor-pointer transition-colors ${
                          formState.accountStatus === opt.value
                            ? 'border-[#0B1F3A] bg-[#0B1F3A] text-white'
                            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="border-t border-slate-200 pt-4">
                <h3 className="font-semibold text-slate-800 mb-3">التعيين التشغيلي</h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-slate-600 mb-1">
                      المدرسة {!isSuperAdmin && restrictedSchoolCount > 0 ? '*' : ''}
                    </label>
                    <input
                      type="text"
                      list="driver-schools-datalist"
                      required={!isSuperAdmin && restrictedSchoolCount > 0}
                      disabled={isSingleSchoolRestricted}
                      value={formState.schoolName}
                      onChange={(e) =>
                        setFormState({ ...formState, schoolName: e.target.value })
                      }
                      placeholder="اختر مدرسة أو اكتب مدرسة أخرى..."
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-semibold text-[#0B1F3A] focus:border-[#0B1F3A] focus:outline-none disabled:bg-slate-100"
                    />
                    <datalist id="driver-schools-datalist">
                      {mySchools.map((s) => (
                        <option key={s.id} value={s.name} />
                      ))}
                    </datalist>
                  </div>
                  <div>
                    <label className="block text-slate-600 mb-1">الباص / المركبة</label>
                    <input
                      type="text"
                      value={formState.busNumber}
                      onChange={(e) =>
                        setFormState({ ...formState, busNumber: e.target.value })
                      }
                      placeholder="اكتب رقم الباص أو اللوحة"
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 focus:border-[#0B1F3A] focus:outline-none"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <label className="block text-slate-600">خط السير</label>
                      <button
                        type="button"
                        onClick={() => setShowRouteTimings((v) => !v)}
                        className="text-[11px] font-semibold text-[#0B1F3A] hover:text-[#C89B3C] cursor-pointer"
                      >
                        {showRouteTimings ? 'إخفاء المواعيد' : 'تحديد المواعيد'}
                      </button>
                    </div>
                    <input
                      type="text"
                      value={formState.routeName}
                      onChange={(e) =>
                        setFormState({ ...formState, routeName: e.target.value, routeId: '' })
                      }
                      placeholder="اكتب خط السير"
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 focus:border-[#0B1F3A] focus:outline-none"
                    />
                  </div>
                </div>

                {showRouteTimings && (
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2.5 rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">
                        نقطة بداية الرحلة
                      </label>
                      <input
                        placeholder="اكتب نقطة بداية الرحلة"
                        value={formState.routePickupArea}
                        onChange={(e) =>
                          setFormState({ ...formState, routePickupArea: e.target.value })
                        }
                        className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs focus:border-[#0B1F3A] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">
                        وقت بداية الرحلة
                      </label>
                      <input
                        type="time"
                        value={formState.routePickupTime}
                        onChange={(e) =>
                          setFormState({ ...formState, routePickupTime: e.target.value })
                        }
                        className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">
                        وقت نهاية الرحلة
                      </label>
                      <input
                        type="time"
                        value={formState.routeDropoffTime}
                        onChange={(e) =>
                          setFormState({ ...formState, routeDropoffTime: e.target.value })
                        }
                        className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-mono tabular-nums"
                      />
                    </div>
                  </div>
                )}
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">ملاحظات ومستندات</label>
                <textarea
                  rows={2}
                  value={formState.notes}
                  onChange={(e) => setFormState({ ...formState, notes: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 focus:border-[#0B1F3A] focus:outline-none"
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100">
                <div>
                  {editingDriver && (
                    <button
                      type="button"
                      onClick={() => openDeleteModal(editingDriver)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      حذف السائق نهائياً
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setShowForm(false)}
                    className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                  >
                    إلغاء
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="rounded-lg bg-[#0B1F3A] px-5 py-2 text-xs font-semibold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
                  >
                    {saving ? 'جاري الحفظ...' : 'حفظ البيانات'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Driver Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/65 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
            <div className="px-5 py-4 bg-red-700 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5" />
                <h3 className="font-display text-sm font-bold">تأكيد حذف السائق</h3>
              </div>
              <button
                onClick={() => setDeleteTarget(null)}
                className="text-red-100 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4 text-xs">
              <div className="flex items-center gap-3 rounded-xl bg-slate-50 border border-slate-200 p-3">
                <DriverAvatar
                  name={deleteTarget.fullName}
                  photoUrl={deleteTarget.photoUrl}
                  size="md"
                />
                <div>
                  <div className="font-bold text-sm text-[#0B1F3A]">{deleteTarget.fullName}</div>
                  <div className="text-slate-500 font-mono mt-0.5">
                    كود: {deleteTarget.driverCode} · {deleteTarget.phone}
                  </div>
                </div>
              </div>

              <p className="text-slate-600 leading-relaxed">
                هل أنت متأكد من حذف هذا السائق نهائياً من النظام؟ سيتم حذف ملفه وربطه بالمركبة والمدرسة وسجل الحضور.
              </p>

              {deleteError && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900 space-y-2.5">
                  <p className="leading-relaxed font-medium">{deleteError}</p>
                  <button
                    type="button"
                    disabled={deleting}
                    onClick={handleDeactivateFromDeleteModal}
                    className="w-full rounded-lg bg-[#0B1F3A] px-3 py-2 text-xs font-semibold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
                  >
                    نقل السائق إلى الأرشفة بدلاً من الحذف
                  </button>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => setDeleteTarget(null)}
                  className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={handleConfirmDelete}
                  className="rounded-lg bg-red-600 px-4 py-2 font-semibold text-white hover:bg-red-700 disabled:opacity-50 cursor-pointer"
                >
                  {deleting ? 'جاري الحذف...' : 'حذف نهائي'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Driver Financial Statement & Advances/Coverages Management Modal */}
      {statementDriverId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-4xl bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden max-h-[92vh] flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-[#0B1F3A] text-white">
              <h2 className="font-display text-base font-bold">
                {statementData
                  ? `حساب السائق: ${statementData.driver.fullName} (كود ${statementData.driver.driverCode})`
                  : 'حساب السائق الشهري'}
              </h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={statementLoading || !statementData || sharingWhatsApp}
                  onClick={handleSendStatementToWhatsApp}
                  className="flex items-center gap-1.5 rounded-lg bg-[#25D366] px-3.5 py-1.5 text-xs font-bold text-white hover:bg-[#1ebe5d] disabled:opacity-50 cursor-pointer"
                >
                  {sharingWhatsApp ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <MessageCircle className="w-3.5 h-3.5" />
                  )}
                  {sharingWhatsApp ? 'جاري تجهيز الصورة...' : 'إرسال للواتساب (صورة)'}
                </button>
                <button
                  onClick={() => {
                    clearWhatsappPreview();
                    setStatementDriverId(null);
                    setStatementData(null);
                  }}
                  className="text-slate-300 hover:text-white cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-6 overflow-y-auto space-y-5 text-xs">
              {/* Period + Section Switcher */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
                  {[
                    ...(canViewFinancialDetails
                      ? [{ id: 'statement' as const, label: 'كشف الحساب' }]
                      : []),
                    ...(canAdvancesWrite || canFinanceRead
                      ? [
                          {
                            id: 'advances' as const,
                            label: `${canAdvancesWrite ? 'تعديل وإضافة ' : ''}السلف (${statementData?.advances.length ?? 0})`,
                          },
                        ]
                      : []),
                    ...(canCoverageWrite || canFinanceRead
                      ? [
                          {
                            id: 'coverage' as const,
                            label: `${canCoverageWrite ? 'تعديل وإضافة ' : ''}التغطيات (${statementData?.coverages.length ?? 0})`,
                          },
                        ]
                      : []),
                    ...(canFinanceRead
                      ? [
                          {
                            id: 'adjustments' as const,
                            label: 'المكافآت والخصومات',
                          },
                        ]
                      : []),
                  ].map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setStatementTab(t.id)}
                      className={`px-3 py-1.5 rounded-md text-xs font-bold cursor-pointer transition-colors ${
                        statementTab === t.id
                          ? 'bg-[#0B1F3A] text-white'
                          : 'text-slate-700 hover:bg-white'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {statementData?.period?.startDate && statementData?.period?.endDate && (
                    <span className="rounded-lg bg-amber-50 border border-amber-200 px-2.5 py-1 font-mono text-[11px] font-bold text-[#0B1F3A] tabular-nums">
                      {statementData.period.startDate} → {statementData.period.endDate}
                    </span>
                  )}
                  <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1">
                    <span className="text-[11px] text-slate-500">الشهر</span>
                    <input
                      type="number"
                      min={1}
                      max={12}
                      value={statementMonth}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (v >= 1 && v <= 12) setStatementMonth(v);
                      }}
                      className="w-12 bg-transparent font-mono text-xs font-semibold text-center focus:outline-none"
                    />
                  </div>
                  <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1">
                    <span className="text-[11px] text-slate-500">السنة</span>
                    <input
                      type="number"
                      min={2020}
                      max={2099}
                      value={statementYear}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (v >= 2020 && v <= 2099) setStatementYear(v);
                      }}
                      className="w-16 bg-transparent font-mono text-xs font-semibold text-center focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {financeErr && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-red-800">
                  {financeErr}
                </div>
              )}
              {financeNotice && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 font-semibold text-emerald-900">
                  {financeNotice}
                </div>
              )}

              {/* WhatsApp Image Preview & Send Bar */}
              {whatsappPreview && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50/80 p-4 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="space-y-1">
                      <div className="font-bold text-emerald-900 flex items-center gap-1.5">
                        <MessageCircle className="w-4 h-4 text-[#25D366]" />
                        <span>جاهز للإرسال عبر واتساب</span>
                      </div>
                      <p className="text-[11px] text-emerald-800 leading-relaxed">
                        {whatsappPreview.statusText}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={clearWhatsappPreview}
                      className="self-start text-emerald-700 hover:text-emerald-950 cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
                    <img
                      src={whatsappPreview.url}
                      alt="معاينة صورة كشف الحساب"
                      className="w-full sm:w-80 h-48 sm:h-56 object-contain object-top rounded-xl border border-emerald-300 bg-slate-900 shadow-md shrink-0"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <a
                        href={whatsappPreview.whatsappUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[#25D366] px-4 py-2 text-xs font-bold text-white hover:bg-[#1ebe5d]"
                      >
                        <MessageCircle className="w-4 h-4" />
                        فتح واتساب {whatsappPreview.driverPhone ? `(${whatsappPreview.driverPhone})` : ''}
                      </a>
                      <button
                        type="button"
                        onClick={handleRecopyWhatsappImage}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-white px-3 py-2 text-xs font-semibold text-emerald-900 hover:bg-emerald-100 cursor-pointer"
                      >
                        {whatsappPreview.copied ? (
                          <Check className="w-3.5 h-3.5 text-emerald-600" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                        {whatsappPreview.copied ? 'تم نسخ الصورة' : 'نسخ الصورة'}
                      </button>
                      <button
                        type="button"
                        onClick={() => downloadBlob(whatsappPreview.blob, whatsappPreview.filename)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-white px-3 py-2 text-xs font-semibold text-emerald-900 hover:bg-emerald-100 cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5" />
                        تحميل الصورة
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {statementLoading || !statementData ? (
                <div className="py-10 text-center text-slate-400">جاري تحميل حساب السائق...</div>
              ) : (
                <>
                  {/* TAB 1: FULL PRINTABLE STATEMENT */}
                  {statementTab === 'statement' && (
                    <div
                      ref={statementCaptureRef}
                      dir="rtl"
                      style={{ width: '960px', minWidth: '960px' }}
                      className="bg-white rounded-xl border border-slate-200 p-6 space-y-5 mx-auto shadow-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
                        <div className="flex items-center gap-3">
                          <DriverAvatar
                            name={statementData.driver.fullName}
                            photoUrl={statementData.driver.photoUrl}
                            size="lg"
                          />
                          <div>
                            <div className="text-[11px] font-bold text-[#C89B3C]">
                              الوليد ترافيل — كشف حساب السائق
                            </div>
                            <div className="text-base font-bold text-[#0B1F3A] mt-0.5">
                              {statementData.driver.fullName} · كود{' '}
                              <span className="font-mono">{statementData.driver.driverCode}</span>
                            </div>
                            <div className="text-slate-500 mt-1">
                              {statementData.driver.schoolName} · باص {statementData.driver.busNumber} ·{' '}
                              {statementData.driver.routeName}
                            </div>
                          </div>
                        </div>
                        <div className="rounded-lg bg-[#0B1F3A] text-white px-3.5 py-2 text-center">
                          <div className="text-[10px] text-slate-300">الفترة المحاسبية</div>
                          <div className="font-mono font-bold text-xs text-[#C89B3C] tabular-nums mt-0.5">
                            شهر {statementData.period.month} / {statementData.period.year}
                          </div>
                          {statementData.period.startDate && statementData.period.endDate && (
                            <div className="font-mono text-[10px] text-slate-300 tabular-nums mt-0.5">
                              {statementData.period.startDate} → {statementData.period.endDate}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                        <div className="border border-slate-200 rounded-xl p-3">
                          <div className="text-slate-500">الراتب الأساسي</div>
                          <div className="mt-1 font-mono font-bold text-slate-900 tabular-nums">
                            {formatEGP(statementData.salary.baseSalary)}
                          </div>
                        </div>
                        <div className="border border-slate-200 rounded-xl p-3">
                          <div className="text-slate-500">إجمالي السلف</div>
                          <div className="mt-1 font-mono font-bold text-red-700 tabular-nums">
                            − {formatEGP(statementData.salary.totalAdvances)}
                          </div>
                        </div>
                        <div className="border border-slate-200 rounded-xl p-3">
                          <div className="text-slate-500">خصم التغطيات</div>
                          <div className="mt-1 font-mono font-bold text-red-700 tabular-nums">
                            − {formatEGP(statementData.salary.totalCoverageDeductions)}
                          </div>
                        </div>
                        <div className="border border-slate-200 rounded-xl p-3">
                          <div className="text-slate-500">مستحق التغطيات</div>
                          <div className="mt-1 font-mono font-bold text-emerald-700 tabular-nums">
                            + {formatEGP(statementData.salary.totalCoverageAdditions || 0)}
                          </div>
                        </div>
                        <div className="border border-slate-200 rounded-xl p-3">
                          <div className="text-slate-500">خصومات أخرى</div>
                          <div className="mt-1 font-mono font-bold text-red-700 tabular-nums">
                            − {formatEGP(statementData.salary.otherDeductions)}
                          </div>
                        </div>
                        <div className="border border-slate-200 rounded-xl p-3">
                          <div className="text-slate-500">المكافآت</div>
                          <div className="mt-1 font-mono font-bold text-emerald-700 tabular-nums">
                            + {formatEGP(statementData.salary.bonuses)}
                          </div>
                        </div>
                        <div className="bg-[#0B1F3A] text-white rounded-xl p-3">
                          <div className="text-slate-300">صافي المستحق</div>
                          <div className="mt-1 font-mono font-bold text-[#C89B3C] tabular-nums">
                            {formatEGP(statementData.salary.netSalary)}
                          </div>
                        </div>
                      </div>

                      <div>
                        <h3 className="font-bold text-[#0B1F3A] mb-2">سجل الحركات المالية للشهر</h3>
                        <div className="border border-slate-200 rounded-xl overflow-hidden">
                          <table className="w-full text-right text-xs">
                            <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                              <tr>
                                <th className="py-2.5 px-3">التاريخ</th>
                                <th className="py-2.5 px-3">النوع</th>
                                <th className="py-2.5 px-3">البيان</th>
                                <th className="py-2.5 px-3">المبلغ</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {statementData.transactions.length === 0 ? (
                                <tr>
                                  <td colSpan={4} className="py-6 text-center text-slate-400">
                                    لا توجد حركات مالية مسجلة في هذا الشهر
                                  </td>
                                </tr>
                              ) : (
                                statementData.transactions.map((t) => (
                                  <tr key={t.id}>
                                    <td className="py-2.5 px-3 font-mono text-slate-500 tabular-nums">
                                      {new Date(t.createdAt).toLocaleDateString('ar-EG', {
                                        timeZone: 'Africa/Cairo',
                                      })}
                                    </td>
                                    <td className="py-2.5 px-3 font-semibold text-slate-700">
                                      {t.type === 'advance'
                                        ? 'سلفة'
                                        : t.type === 'coverage_deduction'
                                        ? 'خصم تغطية (من الأساسي)'
                                        : t.type === 'coverage_credit'
                                        ? 'مستحق تغطية (للبديل)'
                                        : t.type === 'bonus'
                                        ? 'مكافأة'
                                        : t.type === 'reversal'
                                        ? 'عكس قيد'
                                        : 'خصم إداري'}
                                    </td>
                                    <td className="py-2.5 px-3 text-slate-700">{t.description}</td>
                                    <td
                                      className={`py-2.5 px-3 font-mono font-bold tabular-nums ${
                                        t.direction === 'credit' ? 'text-emerald-700' : 'text-red-700'
                                      }`}
                                    >
                                      {t.direction === 'credit' ? '+' : '−'} {formatEGP(t.amount)}
                                    </td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* TAB 2: DRIVER ADVANCES (ADD + EDIT + DELETE) */}
                  {statementTab === 'advances' && (
                    <div className="space-y-4">
                      {canAdvancesWrite && (
                        <form
                          onSubmit={handleAddDriverAdvance}
                          className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3"
                        >
                          <div className="font-bold text-[#0B1F3A]">إضافة سلفة جديدة</div>
                          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
                            <input
                              type="number"
                              required
                              min={1}
                              value={newAdv.amount}
                              onChange={(e) => setNewAdv({ ...newAdv, amount: e.target.value })}
                              placeholder="المبلغ (ج.م) *"
                              className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono"
                            />
                            <input
                              type="date"
                              required
                              value={newAdv.date}
                              onChange={(e) => setNewAdv({ ...newAdv, date: e.target.value })}
                              className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono"
                            />
                            <input
                              value={newAdv.paymentMethod}
                              onChange={(e) =>
                                setNewAdv({ ...newAdv, paymentMethod: e.target.value })
                              }
                              placeholder="طريقة الدفع"
                              className="rounded-lg border border-slate-200 bg-white px-3 py-2"
                            />
                            <input
                              value={newAdv.reason}
                              onChange={(e) => setNewAdv({ ...newAdv, reason: e.target.value })}
                              placeholder="السبب"
                              className="rounded-lg border border-slate-200 bg-white px-3 py-2"
                            />
                          </div>
                          <button
                            type="submit"
                            disabled={financeBusy}
                            className="rounded-lg bg-[#0B1F3A] px-4 py-2 font-bold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
                          >
                            تسجيل السلفة
                          </button>
                        </form>
                      )}

                      <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
                        {statementData.advances.length === 0 ? (
                          <div className="p-6 text-center text-slate-400">
                            لا توجد سلف مسجلة لهذا السائق في هذا الشهر
                          </div>
                        ) : (
                          statementData.advances.map((a) =>
                            editingAdvId === a.id ? (
                              <form
                                key={a.id}
                                onSubmit={handleSaveDriverAdvanceEdit}
                                className="p-4 bg-amber-50/60 space-y-3"
                              >
                                <div className="font-bold text-[#0B1F3A]">تعديل السلفة</div>
                                <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
                                  <input
                                    type="number"
                                    required
                                    min={1}
                                    value={editAdv.amount}
                                    onChange={(e) =>
                                      setEditAdv({ ...editAdv, amount: e.target.value })
                                    }
                                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono"
                                  />
                                  <input
                                    type="date"
                                    required
                                    value={editAdv.date}
                                    onChange={(e) =>
                                      setEditAdv({ ...editAdv, date: e.target.value })
                                    }
                                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono"
                                  />
                                  <input
                                    value={editAdv.paymentMethod}
                                    onChange={(e) =>
                                      setEditAdv({ ...editAdv, paymentMethod: e.target.value })
                                    }
                                    placeholder="طريقة الدفع"
                                    className="rounded-lg border border-slate-200 bg-white px-3 py-2"
                                  />
                                  <input
                                    value={editAdv.reason}
                                    onChange={(e) =>
                                      setEditAdv({ ...editAdv, reason: e.target.value })
                                    }
                                    placeholder="السبب"
                                    className="rounded-lg border border-slate-200 bg-white px-3 py-2"
                                  />
                                </div>
                                <div className="flex gap-2">
                                  <button
                                    type="submit"
                                    disabled={financeBusy}
                                    className="rounded-lg bg-[#0B1F3A] px-4 py-1.5 font-bold text-white cursor-pointer"
                                  >
                                    حفظ التعديل
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setEditingAdvId(null)}
                                    className="rounded-lg border border-slate-200 bg-white px-4 py-1.5 font-semibold text-slate-600 cursor-pointer"
                                  >
                                    إلغاء
                                  </button>
                                </div>
                              </form>
                            ) : (
                              <div
                                key={a.id}
                                className="p-3.5 flex flex-wrap items-center justify-between gap-3"
                              >
                                <div>
                                  <div className="font-mono font-bold text-red-700 text-sm">
                                    {formatEGP(a.amount)}
                                  </div>
                                  <div className="text-slate-500 mt-0.5">
                                    <span className="font-mono">{a.date}</span> · {a.reason || '—'} ·{' '}
                                    {a.paymentMethod || '—'}
                                  </div>
                                </div>
                                {canAdvancesWrite && (
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingAdvId(a.id);
                                        setEditAdv({
                                          amount: String(a.amount),
                                          date: a.date,
                                          paymentMethod: a.paymentMethod || '',
                                          reason: a.reason || '',
                                          notes: a.notes || '',
                                        });
                                      }}
                                      className="inline-flex items-center gap-1 rounded-md bg-[#0B1F3A] px-2.5 py-1.5 text-[11px] font-semibold text-white cursor-pointer"
                                    >
                                      <Edit3 className="w-3 h-3 text-[#C89B3C]" />
                                      تعديل
                                    </button>
                                    <button
                                      type="button"
                                      disabled={financeBusy}
                                      onClick={() => handleDeleteDriverAdvance(a.id)}
                                      className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] font-semibold text-red-700 cursor-pointer"
                                    >
                                      <Trash2 className="w-3 h-3" />
                                      حذف
                                    </button>
                                  </div>
                                )}
                              </div>
                            )
                          )
                        )}
                      </div>
                    </div>
                  )}

                  {/* TAB 3: DRIVER COVERAGES (ADD + EDIT + DELETE) */}
                  {statementTab === 'coverage' && (
                    <div className="space-y-4">
                      {canCoverageWrite && (
                        <form
                          onSubmit={handleAddDriverCoverage}
                          className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3"
                        >
                          <div className="font-bold text-[#0B1F3A]">إضافة تغطية غياب جديدة</div>
                          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
                            <input
                              value={newCov.replacementQuery}
                              onChange={(e) =>
                                setNewCov({ ...newCov, replacementQuery: e.target.value })
                              }
                              placeholder="السائق البديل"
                              className="rounded-lg border border-slate-200 bg-white px-3 py-2"
                            />
                            <input
                              type="date"
                              required
                              value={newCov.date}
                              onChange={(e) => setNewCov({ ...newCov, date: e.target.value })}
                              className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono"
                            />
                            <input
                              type="number"
                              required
                              min={0}
                              value={newCov.coverageAmount}
                              onChange={(e) =>
                                setNewCov({ ...newCov, coverageAmount: e.target.value })
                              }
                              placeholder="مبلغ التغطية (ج.م) *"
                              className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono"
                            />
                            <input
                              value={newCov.reason}
                              onChange={(e) => setNewCov({ ...newCov, reason: e.target.value })}
                              placeholder="السبب"
                              className="rounded-lg border border-slate-200 bg-white px-3 py-2"
                            />
                          </div>
                          <p className="text-[11px] text-slate-500">
                            يُخصم مبلغ التغطية من السائق الأساسي ويُضاف تلقائياً لمستحقات السائق البديل.
                          </p>
                          <button
                            type="submit"
                            disabled={financeBusy}
                            className="rounded-lg bg-[#0B1F3A] px-4 py-2 font-bold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
                          >
                            تسجيل التغطية
                          </button>
                        </form>
                      )}

                      <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
                        {statementData.coverages.length === 0 ? (
                          <div className="p-6 text-center text-slate-400">
                            لا توجد تغطيات مسجلة لهذا السائق في هذا الشهر
                          </div>
                        ) : (
                          statementData.coverages.map((c) => {
                            const amt =
                              c.coverageAmount ??
                              c.absentDriverDeduction ??
                              c.actualReplacementCost ??
                              0;
                            const isReplacement = c.coverageRole === 'replacement';
                            return editingCovId === c.id ? (
                              <form
                                key={c.id}
                                onSubmit={handleSaveDriverCoverageEdit}
                                className="p-4 bg-amber-50/60 space-y-3"
                              >
                                <div className="font-bold text-[#0B1F3A]">تعديل سجل التغطية</div>
                                <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
                                  <input
                                    value={editCov.replacementQuery}
                                    onChange={(e) =>
                                      setEditCov({ ...editCov, replacementQuery: e.target.value })
                                    }
                                    placeholder="السائق البديل"
                                    className="rounded-lg border border-slate-200 bg-white px-3 py-2"
                                  />
                                  <input
                                    type="date"
                                    required
                                    value={editCov.date}
                                    onChange={(e) =>
                                      setEditCov({ ...editCov, date: e.target.value })
                                    }
                                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono"
                                  />
                                  <input
                                    type="number"
                                    required
                                    min={0}
                                    value={editCov.coverageAmount}
                                    onChange={(e) =>
                                      setEditCov({
                                        ...editCov,
                                        coverageAmount: e.target.value,
                                      })
                                    }
                                    placeholder="مبلغ التغطية *"
                                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono"
                                  />
                                  <input
                                    value={editCov.reason}
                                    onChange={(e) =>
                                      setEditCov({ ...editCov, reason: e.target.value })
                                    }
                                    placeholder="السبب"
                                    className="rounded-lg border border-slate-200 bg-white px-3 py-2"
                                  />
                                </div>
                                <div className="flex gap-2">
                                  <button
                                    type="submit"
                                    disabled={financeBusy}
                                    className="rounded-lg bg-[#0B1F3A] px-4 py-1.5 font-bold text-white cursor-pointer"
                                  >
                                    حفظ التعديل
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setEditingCovId(null)}
                                    className="rounded-lg border border-slate-200 bg-white px-4 py-1.5 font-semibold text-slate-600 cursor-pointer"
                                  >
                                    إلغاء
                                  </button>
                                </div>
                              </form>
                            ) : (
                              <div
                                key={c.id}
                                className="p-3.5 flex flex-wrap items-center justify-between gap-3"
                              >
                                <div>
                                  <div className="font-bold text-slate-900">
                                    {isReplacement
                                      ? `تغطية بديلة عن: ${c.absentDriverName || '—'}`
                                      : `البديل: ${c.replacementDriverName || c.replacementExternalName || '—'}`}{' '}
                                    ·{' '}
                                    <span
                                      className={`font-mono ${
                                        isReplacement ? 'text-emerald-700' : 'text-red-700'
                                      } ${c.isReversed ? 'line-through opacity-60' : ''}`}
                                    >
                                      {isReplacement ? `+ ${formatEGP(amt)} (مستحق)` : `− ${formatEGP(amt)} (خصم)`}
                                    </span>
                                  </div>
                                  <div className="text-slate-500 mt-0.5">
                                    <span className="font-mono">{c.date}</span> · {c.reason || '—'}
                                  </div>
                                </div>
                                {canCoverageWrite && !isReplacement && (
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingCovId(c.id);
                                        setEditCov({
                                          replacementQuery:
                                            c.replacementDriverName && c.replacementDriverName !== '—'
                                              ? c.replacementDriverName
                                              : c.replacementExternalName || '',
                                          date: c.date,
                                          coverageAmount: String(amt),
                                          reason: c.reason || '',
                                          notes: c.notes || '',
                                        });
                                      }}
                                      className="inline-flex items-center gap-1 rounded-md bg-[#0B1F3A] px-2.5 py-1.5 text-[11px] font-semibold text-white cursor-pointer"
                                    >
                                      <Edit3 className="w-3 h-3 text-[#C89B3C]" />
                                      تعديل
                                    </button>
                                    <button
                                      type="button"
                                      disabled={financeBusy}
                                      onClick={() => handleDeleteDriverCoverage(c.id)}
                                      className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] font-semibold text-red-700 cursor-pointer"
                                    >
                                      <Trash2 className="w-3 h-3" />
                                      حذف
                                    </button>
                                  </div>
                                )}
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}

                  {/* TAB 4: BONUSES & OTHER DEDUCTIONS */}
                  {statementTab === 'adjustments' && (
                    <div className="space-y-4">
                      {canFinanceWrite && (
                        <form
                          onSubmit={handleAddDriverAdjustment}
                          className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3"
                        >
                          <div className="font-bold text-[#0B1F3A]">إضافة مكافأة أو خصم إداري</div>
                          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
                            <div className="grid grid-cols-2 gap-1.5">
                              {[
                                { value: 'bonus' as const, label: 'مكافأة (+)' },
                                { value: 'other_deduction' as const, label: 'خصم (−)' },
                              ].map((opt) => (
                                <button
                                  key={opt.value}
                                  type="button"
                                  onClick={() => setNewAdj({ ...newAdj, type: opt.value })}
                                  className={`rounded-lg border px-2 py-2 font-semibold cursor-pointer ${
                                    newAdj.type === opt.value
                                      ? 'border-[#0B1F3A] bg-[#0B1F3A] text-white'
                                      : 'border-slate-200 bg-white text-slate-700'
                                  }`}
                                >
                                  {opt.label}
                                </button>
                              ))}
                            </div>
                            <input
                              type="number"
                              required
                              min={1}
                              value={newAdj.amount}
                              onChange={(e) => setNewAdj({ ...newAdj, amount: e.target.value })}
                              placeholder="المبلغ (ج.م) *"
                              className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono"
                            />
                            <input
                              required
                              value={newAdj.description}
                              onChange={(e) =>
                                setNewAdj({ ...newAdj, description: e.target.value })
                              }
                              placeholder="السبب / البيان *"
                              className="sm:col-span-2 rounded-lg border border-slate-200 bg-white px-3 py-2"
                            />
                          </div>
                          <button
                            type="submit"
                            disabled={financeBusy}
                            className="rounded-lg bg-[#0B1F3A] px-4 py-2 font-bold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
                          >
                            حفظ التسوية
                          </button>
                        </form>
                      )}

                      <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
                        {statementData.transactions
                          .filter((t) => t.type === 'bonus' || t.type === 'other_deduction')
                          .map((t) =>
                            editingAdjId === t.id ? (
                              <form
                                key={t.id}
                                onSubmit={handleSaveDriverAdjEdit}
                                className="p-4 bg-amber-50/60 space-y-3"
                              >
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                                  <div className="grid grid-cols-2 gap-1.5">
                                    {[
                                      { value: 'bonus' as const, label: 'مكافأة (+)' },
                                      { value: 'other_deduction' as const, label: 'خصم (−)' },
                                    ].map((opt) => (
                                      <button
                                        key={opt.value}
                                        type="button"
                                        onClick={() => setEditAdj({ ...editAdj, type: opt.value })}
                                        className={`rounded-lg border px-2 py-1.5 font-semibold cursor-pointer ${
                                          editAdj.type === opt.value
                                            ? 'border-[#0B1F3A] bg-[#0B1F3A] text-white'
                                            : 'border-slate-200 bg-white text-slate-700'
                                        }`}
                                      >
                                        {opt.label}
                                      </button>
                                    ))}
                                  </div>
                                  <input
                                    type="number"
                                    required
                                    min={1}
                                    value={editAdj.amount}
                                    onChange={(e) =>
                                      setEditAdj({ ...editAdj, amount: e.target.value })
                                    }
                                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono"
                                  />
                                  <input
                                    required
                                    value={editAdj.description}
                                    onChange={(e) =>
                                      setEditAdj({ ...editAdj, description: e.target.value })
                                    }
                                    className="rounded-lg border border-slate-200 bg-white px-3 py-2"
                                  />
                                </div>
                                <div className="flex gap-2">
                                  <button
                                    type="submit"
                                    disabled={financeBusy}
                                    className="rounded-lg bg-[#0B1F3A] px-4 py-1.5 font-bold text-white cursor-pointer"
                                  >
                                    حفظ التعديل
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setEditingAdjId(null)}
                                    className="rounded-lg border border-slate-200 bg-white px-4 py-1.5 font-semibold text-slate-600 cursor-pointer"
                                  >
                                    إلغاء
                                  </button>
                                </div>
                              </form>
                            ) : (
                              <div
                                key={t.id}
                                className="p-3.5 flex flex-wrap items-center justify-between gap-3"
                              >
                                <div>
                                  <div
                                    className={`font-mono font-bold text-sm ${
                                      t.type === 'bonus' ? 'text-emerald-700' : 'text-red-700'
                                    }`}
                                  >
                                    {t.type === 'bonus' ? '+' : '−'} {formatEGP(t.amount)}
                                  </div>
                                  <div className="text-slate-500 mt-0.5">{t.description}</div>
                                </div>
                                {canFinanceWrite && (
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingAdjId(t.id);
                                        setEditAdj({
                                          type: t.type === 'bonus' ? 'bonus' : 'other_deduction',
                                          amount: String(t.amount),
                                          description: t.description,
                                        });
                                      }}
                                      className="inline-flex items-center gap-1 rounded-md bg-[#0B1F3A] px-2.5 py-1.5 text-[11px] font-semibold text-white cursor-pointer"
                                    >
                                      <Edit3 className="w-3 h-3 text-[#C89B3C]" />
                                      تعديل
                                    </button>
                                    <button
                                      type="button"
                                      disabled={financeBusy}
                                      onClick={() => handleDeleteDriverAdj(t.id)}
                                      className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] font-semibold text-red-700 cursor-pointer"
                                    >
                                      <Trash2 className="w-3 h-3" />
                                      حذف
                                    </button>
                                  </div>
                                )}
                              </div>
                            )
                          )}
                        {statementData.transactions.filter(
                          (t) => t.type === 'bonus' || t.type === 'other_deduction'
                        ).length === 0 && (
                          <div className="p-6 text-center text-slate-400">
                            لا توجد مكافآت أو خصومات إدارية في هذا الشهر
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
      <DriverBroadcastModal
        open={showBroadcastModal}
        onClose={() => setShowBroadcastModal(false)}
        onOpenDriversChat={onOpenDriversChat}
      />
    </div>
  );
};
