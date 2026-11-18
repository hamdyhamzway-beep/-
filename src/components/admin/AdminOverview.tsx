import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Archive,
  ArrowRight,
  Briefcase,
  Bus,
  CalendarCheck,
  CheckCircle2,
  Edit3,
  MapPin,
  MessageCircle,
  Mic,
  Phone,
  Plus,
  RadioTower,
  RefreshCw,
  Search,
  Send,
  Trash2,
  TrendingUp,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import {
  apiFetch,
  formatArabicTripTime,
  formatEGP,
  getLocalTodayDateString,
  normalizeLookupText,
  normalizeTimeInputValue,
} from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import { useEscapeKey } from '../../lib/useEscapeKey';
import {
  buildWhatsAppUrl,
  captureElementAsPngBlob,
  copyPngBlobToClipboard,
  downloadBlob,
  renderStatementFallbackBlob,
  shareImageFileViaWebShare,
} from '../../lib/whatsapp-statement';
import { BrandLogo } from '../BrandLogo';
import { ContactPhoneInput } from '../ContactPhoneInput';
import { DriverAvatar } from '../DriverAvatar';
import { DriverBroadcastModal } from './DriverBroadcastModal';
import { DriverLicensesSection } from '../DriverLicensesSection';
import { DriverPhotoUploader } from '../DriverPhotoUploader';
import { MorningSpiritualRibbon } from '../MorningSpiritualRibbon';
import splashScreenImg from '../../assets/images/alwaleed_splash_screen_1794752422708.jpg';
import travelBackdropImg from '../../assets/images/alwaleed_travel_backdrop_1794752421692.jpg';
import type {
  AdvanceRecord,
  CoverageRecord,
  DriverLicensePhoto,
  EmployeeRecord,
  EnrichedDriver,
  FinancialTransaction,
  FleetVehicle,
  NotificationItem,
  SalaryRecord,
  SchoolItem,
} from '../../types';

interface DashboardData {
  period: { month: number; year: number; date: string };
  activePeriod?: { month: number; year: number };
  isMonthClosed?: boolean;
  kpis: {
    totalRegisteredDrivers: number;
    totalEmployeesCount: number;
    activeEmployeesCount: number;
    totalActiveVehicles: number;
    vehiclesOnline: number;
    vehiclesOffline: number;
    driversActive: number;
    driversAbsent: number;
    totalDriverSalaries: number;
    totalEmployeeSalaries: number;
    totalMonthlySalaries: number;
    totalAdvances: number;
    totalCoverageDeductions: number;
    totalOutstandingPayments: number;
    totalSchoolContracts: number;
    totalOwnerCosts: number;
    monthlyBusinessProfit: number;
  };
  drivers: EnrichedDriver[];
  employees: EmployeeRecord[];
  fleet: FleetVehicle[];
  schools: SchoolItem[];
  recentNotifications: NotificationItem[];
}

interface DriverStatementResponse {
  driver: EnrichedDriver;
  period: { month: number; year: number };
  salary: SalaryRecord;
  advances: AdvanceRecord[];
  coverages: CoverageRecord[];
  transactions: FinancialTransaction[];
}

export const AdminOverview: React.FC<{
  onNavigate: (tab: string, chatRoomKey?: string) => void;
}> = ({ onNavigate }) => {
  const { dbUser } = useAuth();
  const perms = dbUser?.permissions || [];
  const isSuperAdmin = dbUser?.roleSlug === 'super_admin' || perms.includes('*');
  const can = (perm: string) => isSuperAdmin || perms.includes('*') || perms.includes(perm);

  const canDriversWrite = can('drivers:write');
  const canAttendanceWrite = can('attendance:write');
  const canAdvancesWrite = can('advances:write') || can('finance:write');
  const canCoverageWrite = can('coverage:write') || can('finance:write');
  const canFinanceWrite = can('finance:write');
  const canFinanceRead = can('finance:read') || canFinanceWrite;
  const canViewFinancialDetails = canFinanceRead || canAdvancesWrite || canCoverageWrite;
  const canEmployeesAccess = can('employees:read') || can('employees:write');
  const canSchoolsOrVehicles = can('schools:read') || can('vehicles:read');
  const canGpsRead = can('gps:read');
  const restrictedSchoolIds = dbUser?.assignedSchoolIds || [];
  const isSingleSchoolRestricted = !isSuperAdmin && restrictedSchoolIds.length === 1;

  const now = new Date();
  const today = getLocalTodayDateString();

  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const initialPeriodSyncedRef = useRef(false);
  const [showCloseMonthModal, setShowCloseMonthModal] = useState(false);
  const [closeMonthSchoolId, setCloseMonthSchoolId] = useState<string>(() =>
    isSingleSchoolRestricted ? String(restrictedSchoolIds[0]) : 'all'
  );
  const [showDriversBroadcastModal, setShowDriversBroadcastModal] = useState(false);
  const [closeMonthNotes, setCloseMonthNotes] = useState('');
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Primary Driver Search (Name / Code / Mobile)
  const [driverLookup, setDriverLookup] = useState('');
  const [quickSwitchLookup, setQuickSwitchLookup] = useState('');

  // Active Driver Page ("صفحة السائق")
  const [selectedDriverId, setSelectedDriverId] = useState<number | null>(null);
  const [driverSectionTab, setDriverSectionTab] = useState<
    'advances' | 'coverage' | 'adjustments'
  >(() => (canAdvancesWrite || canFinanceRead ? 'advances' : canCoverageWrite ? 'coverage' : 'adjustments'));
  const [statement, setStatement] = useState<DriverStatementResponse | null>(null);
  const [loadingStatement, setLoadingStatement] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [sendingWhatsApp, setSendingWhatsApp] = useState(false);
  const [whatsappHref, setWhatsappHref] = useState<string | null>(null);
  const statementRef = useRef<HTMLDivElement>(null);

  // Add Advance Form inside Driver Page
  const [advForm, setAdvForm] = useState({
    amount: '',
    date: today,
    paymentMethod: '',
    reason: '',
    notes: '',
  });

  // Add Coverage Form inside Driver Page
  const [covForm, setCovForm] = useState({
    replacementQuery: '',
    date: today,
    actualReplacementCost: '',
    absentDriverDeduction: '',
    reason: '',
    notes: '',
  });

  // Add Bonus/Deduction Form inside Driver Page
  const [adjForm, setAdjForm] = useState({
    type: 'bonus' as 'bonus' | 'other_deduction',
    amount: '',
    description: '',
  });

  // Edit / Delete Advance Modals
  const [editingAdvance, setEditingAdvance] = useState<AdvanceRecord | null>(null);
  const [editAdvForm, setEditAdvForm] = useState({
    amount: '',
    date: '',
    paymentMethod: '',
    reason: '',
    notes: '',
  });
  const [deletingAdvance, setDeletingAdvance] = useState<AdvanceRecord | null>(null);

  // Edit / Delete Coverage Modals
  const [editingCoverage, setEditingCoverage] = useState<CoverageRecord | null>(null);
  const [editCovForm, setEditCovForm] = useState({
    replacementQuery: '',
    date: '',
    actualReplacementCost: '',
    absentDriverDeduction: '',
    reason: '',
    notes: '',
  });
  const [deletingCoverage, setDeletingCoverage] = useState<CoverageRecord | null>(null);

  // Edit / Delete Adjustment (Bonus / Other Deduction) Modals
  const [editingAdjustment, setEditingAdjustment] = useState<FinancialTransaction | null>(null);
  const [editAdjForm, setEditAdjForm] = useState({
    type: 'bonus' as 'bonus' | 'other_deduction',
    amount: '',
    description: '',
  });
  const [deletingAdjustment, setDeletingAdjustment] = useState<FinancialTransaction | null>(null);

  // Full Driver Profile Edit Modal inside Driver Page
  const [showEditDriverModal, setShowEditDriverModal] = useState(false);
  const [editDriverForm, setEditDriverForm] = useState({
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
    routeName: '',
    routePickupArea: '',
    routePickupTime: '',
    routeDropoffTime: '',
  });

  useEscapeKey(
    Boolean(
      showCloseMonthModal ||
        deletingAdjustment ||
        editingAdjustment ||
        deletingCoverage ||
        editingCoverage ||
        deletingAdvance ||
        editingAdvance ||
        showEditDriverModal
    ),
    () => {
      if (showCloseMonthModal) setShowCloseMonthModal(false);
      else if (deletingAdjustment) setDeletingAdjustment(null);
      else if (editingAdjustment) setEditingAdjustment(null);
      else if (deletingCoverage) setDeletingCoverage(null);
      else if (editingCoverage) setEditingCoverage(null);
      else if (deletingAdvance) setDeletingAdvance(null);
      else if (editingAdvance) setEditingAdvance(null);
      else if (showEditDriverModal) setShowEditDriverModal(false);
    }
  );

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = initialPeriodSyncedRef.current
        ? `/api/dashboard?month=${month}&year=${year}`
        : `/api/dashboard`;
      const res = await apiFetch<DashboardData>(url);
      if (!initialPeriodSyncedRef.current) {
        initialPeriodSyncedRef.current = true;
        setMonth(res.period.month);
        setYear(res.period.year);
      }
      setData(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل لوحة التحكم');
    } finally {
      setLoading(false);
    }
  }, [month, year]);

  useEffect(() => {
    if (isSingleSchoolRestricted && restrictedSchoolIds[0]) {
      setCloseMonthSchoolId(String(restrictedSchoolIds[0]));
    } else if (!isSuperAdmin && restrictedSchoolIds.length > 1 && closeMonthSchoolId === 'all') {
      setCloseMonthSchoolId(String(restrictedSchoolIds[0]));
    }
  }, [isSingleSchoolRestricted, isSuperAdmin, restrictedSchoolIds, closeMonthSchoolId]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  const loadDriverPage = useCallback(
    async (driverId: number, m = month, y = year) => {
      setSelectedDriverId(driverId);
      setLoadingStatement(true);
      setActionErr(null);
      try {
        const res = await apiFetch<DriverStatementResponse>(
          `/api/drivers/${driverId}/statement?month=${m}&year=${y}`
        );
        setStatement(res);
      } catch (err: unknown) {
        setActionErr(err instanceof Error ? err.message : 'تعذر تحميل صفحة السائق');
      } finally {
        setLoadingStatement(false);
      }
    },
    [month, year]
  );

  useEffect(() => {
    const allowed: Array<'advances' | 'coverage' | 'adjustments'> = [];
    if (canAdvancesWrite || canFinanceRead) allowed.push('advances');
    if (canCoverageWrite || canFinanceRead) allowed.push('coverage');
    if (canFinanceRead) allowed.push('adjustments');
    if (allowed.length > 0 && !allowed.includes(driverSectionTab)) {
      setDriverSectionTab(allowed[0]);
    }
  }, [canAdvancesWrite, canCoverageWrite, canFinanceRead, driverSectionTab]);

  // Refresh active driver page when month or year changes
  useEffect(() => {
    const curNow = new Date();
    const targetDate =
      month === curNow.getMonth() + 1 && year === curNow.getFullYear()
        ? getLocalTodayDateString()
        : `${year}-${String(month).padStart(2, '0')}-01`;
    setAdvForm((f) => (f.date.startsWith(`${year}-${String(month).padStart(2, '0')}`) ? f : { ...f, date: targetDate }));
    setCovForm((f) => (f.date.startsWith(`${year}-${String(month).padStart(2, '0')}`) ? f : { ...f, date: targetDate }));
    if (selectedDriverId) {
      loadDriverPage(selectedDriverId, month, year);
    }
  }, [selectedDriverId, month, year, loadDriverPage]);

  const filterDriversByQuery = useCallback(
    (rawQuery: string) => {
      const list = data?.drivers || [];
      const q = normalizeLookupText(rawQuery);
      if (!q) return list;
      const digitsOnly = q.replace(/\D/g, '');
      return list.filter((d) => {
        const nameNorm = normalizeLookupText(d.fullName || '');
        const codeNorm = normalizeLookupText(d.driverCode || '');
        const phoneNorm = normalizeLookupText(d.phone || '').replace(/\D/g, '');
        const schoolNorm = normalizeLookupText(d.schoolName || '');
        const busNorm = normalizeLookupText(d.busNumber || '');
        return (
          nameNorm.includes(q) ||
          codeNorm.includes(q) ||
          (digitsOnly.length >= 2 && phoneNorm.includes(digitsOnly)) ||
          normalizeLookupText(d.phone || '').includes(q) ||
          schoolNorm.includes(q) ||
          busNorm.includes(q)
        );
      });
    },
    [data?.drivers]
  );

  const matchedDrivers = useMemo(
    () => filterDriversByQuery(driverLookup),
    [filterDriversByQuery, driverLookup]
  );

  const quickSwitchMatches = useMemo(
    () => (quickSwitchLookup.trim() ? filterDriversByQuery(quickSwitchLookup).slice(0, 5) : []),
    [filterDriversByQuery, quickSwitchLookup]
  );

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = normalizeLookupText(driverLookup);
    if (!q || !data?.drivers.length) return;
    const digitsOnly = q.replace(/\D/g, '');
    const exactCode = data.drivers.find((d) => normalizeLookupText(d.driverCode) === q);
    const exactPhone = digitsOnly
      ? data.drivers.find((d) => normalizeLookupText(d.phone).replace(/\D/g, '') === digitsOnly)
      : undefined;
    const exactName = data.drivers.find((d) => normalizeLookupText(d.fullName) === q);
    const target = exactCode || exactPhone || exactName || matchedDrivers[0];
    if (target) {
      setActionMsg(null);
      setWhatsappHref(null);
      if (target.id === selectedDriverId) {
        loadDriverPage(target.id, month, year);
      } else {
        setStatement(null);
        setSelectedDriverId(target.id);
      }
    } else {
      setError(`لم يتم العثور على سائق مطابق لـ "${driverLookup.trim()}"`);
    }
  };

  const openDriverWorkspace = (d: EnrichedDriver) => {
    setActionMsg(null);
    setActionErr(null);
    setWhatsappHref(null);
    setQuickSwitchLookup('');
    if (!selectedDriverId && typeof window !== 'undefined') {
      try {
        window.history.pushState({ alwaleedDriverWorkspace: d.id }, '');
      } catch {
        // ignore
      }
    }
    if (d.id === selectedDriverId) {
      loadDriverPage(d.id, month, year);
    } else {
      setStatement(null);
      setSelectedDriverId(d.id);
    }
  };

  useEffect(() => {
    const onPopState = () => {
      if (selectedDriverId) {
        setSelectedDriverId(null);
        setStatement(null);
        setActionMsg(null);
        setActionErr(null);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [selectedDriverId]);

  const refreshAllForDriver = async (driverId: number) => {
    await Promise.all([loadDashboard(), loadDriverPage(driverId, month, year)]);
  };

  const activeDriver = statement?.driver || null;

  // Quick Attendance Toggle
  const handleAttendance = async (status: 'present' | 'absent' | 'leave') => {
    if (!activeDriver) return;
    setBusyAction(true);
    setActionErr(null);
    setActionMsg(null);
    try {
      await apiFetch('/api/attendance', {
        method: 'POST',
        body: JSON.stringify({ driverId: activeDriver.id, date: today, status }),
      });
      setActionMsg(
        status === 'present'
          ? 'تم تسجيل حضور السائق اليوم.'
          : status === 'absent'
          ? 'تم تسجيل غياب السائق اليوم.'
          : 'تم تسجيل إجازة للسائق اليوم.'
      );
      await refreshAllForDriver(activeDriver.id);
    } catch (err: unknown) {
      setActionErr(err instanceof Error ? err.message : 'تعذر تحديث الحضور');
    } finally {
      setBusyAction(false);
    }
  };

  // Salary Status Toggle
  const handleSalaryStatus = async (status: 'open' | 'approved' | 'paid') => {
    if (!statement?.salary?.id || !activeDriver) return;
    setBusyAction(true);
    setActionErr(null);
    setActionMsg(null);
    try {
      await apiFetch(`/api/finance/salaries/${statement.salary.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setActionMsg('تم تحديث حالة صرف الراتب.');
      await refreshAllForDriver(activeDriver.id);
    } catch (err: unknown) {
      setActionErr(err instanceof Error ? err.message : 'تعذر تحديث حالة الصرف');
    } finally {
      setBusyAction(false);
    }
  };

  // Add Advance
  const handleAddAdvance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeDriver) return;
    setBusyAction(true);
    setActionErr(null);
    setActionMsg(null);
    try {
      await apiFetch('/api/finance/advances', {
        method: 'POST',
        body: JSON.stringify({
          driverId: activeDriver.id,
          amount: Number(advForm.amount),
          date: advForm.date,
          paymentMethod: advForm.paymentMethod.trim(),
          reason: advForm.reason.trim(),
          notes: advForm.notes.trim(),
          idempotencyKey: `dp-adv-${activeDriver.id}-${advForm.amount}-${Date.now()}`,
        }),
      });
      setAdvForm((f) => ({ ...f, amount: '', paymentMethod: '', reason: '', notes: '' }));
      setActionMsg('تم تسجيل السلفة وتحديث صافي راتب السائق تلقائياً.');
      await refreshAllForDriver(activeDriver.id);
    } catch (err: unknown) {
      setActionErr(err instanceof Error ? err.message : 'تعذر تسجيل السلفة');
    } finally {
      setBusyAction(false);
    }
  };

  // Save Edited Advance
  const handleSaveAdvanceEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingAdvance || !activeDriver) return;
    setBusyAction(true);
    setActionErr(null);
    try {
      await apiFetch(`/api/finance/advances/${editingAdvance.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          amount: Number(editAdvForm.amount),
          date: editAdvForm.date,
          paymentMethod: editAdvForm.paymentMethod.trim(),
          reason: editAdvForm.reason.trim(),
          notes: editAdvForm.notes.trim(),
        }),
      });
      setEditingAdvance(null);
      setActionMsg('تم تعديل السلفة وإعادة احتساب صافي المستحق.');
      await refreshAllForDriver(activeDriver.id);
    } catch (err: unknown) {
      setActionErr(err instanceof Error ? err.message : 'تعذر تعديل السلفة');
    } finally {
      setBusyAction(false);
    }
  };

  // Confirm Delete Advance
  const handleDeleteAdvance = async () => {
    if (!deletingAdvance || !activeDriver) return;
    setBusyAction(true);
    setActionErr(null);
    try {
      await apiFetch(`/api/finance/advances/${deletingAdvance.id}`, { method: 'DELETE' });
      setDeletingAdvance(null);
      setActionMsg('تم حذف السلفة وتحديث صافي الراتب تلقائياً.');
      await refreshAllForDriver(activeDriver.id);
    } catch (err: unknown) {
      setActionErr(err instanceof Error ? err.message : 'تعذر حذف السلفة');
    } finally {
      setBusyAction(false);
    }
  };

  // Add Coverage
  const handleAddCoverage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeDriver) return;
    setBusyAction(true);
    setActionErr(null);
    setActionMsg(null);
    try {
      await apiFetch('/api/finance/coverage', {
        method: 'POST',
        body: JSON.stringify({
          absentDriverId: activeDriver.id,
          replacementQuery: covForm.replacementQuery.trim(),
          date: covForm.date,
          actualReplacementCost: Number(covForm.actualReplacementCost || 0),
          absentDriverDeduction: Number(covForm.absentDriverDeduction || 0),
          reason: covForm.reason.trim(),
          notes: covForm.notes.trim(),
          idempotencyKey: `dp-cov-${activeDriver.id}-${covForm.date}-${Date.now()}`,
        }),
      });
      setCovForm((f) => ({
        ...f,
        replacementQuery: '',
        actualReplacementCost: '',
        absentDriverDeduction: '',
        reason: '',
        notes: '',
      }));
      setActionMsg('تم تسجيل تغطية الغياب وتحديث حساب السائق.');
      await refreshAllForDriver(activeDriver.id);
    } catch (err: unknown) {
      setActionErr(err instanceof Error ? err.message : 'تعذر تسجيل التغطية');
    } finally {
      setBusyAction(false);
    }
  };

  // Save Edited Coverage
  const handleSaveCoverageEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingCoverage || !activeDriver) return;
    setBusyAction(true);
    setActionErr(null);
    try {
      await apiFetch(`/api/finance/coverage/${editingCoverage.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          replacementQuery: editCovForm.replacementQuery.trim(),
          date: editCovForm.date,
          actualReplacementCost: Number(editCovForm.actualReplacementCost || 0),
          absentDriverDeduction: Number(editCovForm.absentDriverDeduction || 0),
          reason: editCovForm.reason.trim(),
          notes: editCovForm.notes.trim(),
        }),
      });
      setEditingCoverage(null);
      setActionMsg('تم تعديل سجل التغطية وإعادة احتساب الراتب.');
      await refreshAllForDriver(activeDriver.id);
    } catch (err: unknown) {
      setActionErr(err instanceof Error ? err.message : 'تعذر تعديل التغطية');
    } finally {
      setBusyAction(false);
    }
  };

  // Confirm Delete Coverage
  const handleDeleteCoverage = async () => {
    if (!deletingCoverage || !activeDriver) return;
    setBusyAction(true);
    setActionErr(null);
    try {
      await apiFetch(`/api/finance/coverage/${deletingCoverage.id}`, { method: 'DELETE' });
      setDeletingCoverage(null);
      setActionMsg('تم حذف التغطية وإعادة احتساب صافي المستحق.');
      await refreshAllForDriver(activeDriver.id);
    } catch (err: unknown) {
      setActionErr(err instanceof Error ? err.message : 'تعذر حذف التغطية');
    } finally {
      setBusyAction(false);
    }
  };

  // Add Bonus / Other Deduction
  const handleAddAdjustment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeDriver) return;
    setBusyAction(true);
    setActionErr(null);
    setActionMsg(null);
    try {
      await apiFetch('/api/finance/adjustments', {
        method: 'POST',
        body: JSON.stringify({
          driverId: activeDriver.id,
          month,
          year,
          type: adjForm.type,
          amount: Number(adjForm.amount),
          description: adjForm.description.trim(),
        }),
      });
      setAdjForm((f) => ({ ...f, amount: '', description: '' }));
      setActionMsg('تم تسجيل التسوية المالية وتحديث الراتب.');
      await refreshAllForDriver(activeDriver.id);
    } catch (err: unknown) {
      setActionErr(err instanceof Error ? err.message : 'تعذر تسجيل التسوية');
    } finally {
      setBusyAction(false);
    }
  };

  // Save Edited Bonus/Deduction
  const handleSaveAdjustmentEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingAdjustment || !activeDriver) return;
    setBusyAction(true);
    setActionErr(null);
    try {
      await apiFetch(`/api/finance/adjustments/${editingAdjustment.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          type: editAdjForm.type,
          amount: Number(editAdjForm.amount),
          description: editAdjForm.description.trim(),
        }),
      });
      setEditingAdjustment(null);
      setActionMsg('تم تعديل المكافأة/الخصم وتحديث صافي الراتب.');
      await refreshAllForDriver(activeDriver.id);
    } catch (err: unknown) {
      setActionErr(err instanceof Error ? err.message : 'تعذر تعديل التسوية');
    } finally {
      setBusyAction(false);
    }
  };

  // Confirm Delete Bonus/Deduction
  const handleDeleteAdjustment = async () => {
    if (!deletingAdjustment || !activeDriver) return;
    setBusyAction(true);
    setActionErr(null);
    try {
      await apiFetch(`/api/finance/adjustments/${deletingAdjustment.id}`, { method: 'DELETE' });
      setDeletingAdjustment(null);
      setActionMsg('تم حذف التسوية وإعادة احتساب الراتب.');
      await refreshAllForDriver(activeDriver.id);
    } catch (err: unknown) {
      setActionErr(err instanceof Error ? err.message : 'تعذر حذف التسوية');
    } finally {
      setBusyAction(false);
    }
  };

  // Open Full Driver Edit Modal
  const openEditDriverModal = () => {
    if (!activeDriver) return;
    setEditDriverForm({
      driverCode: activeDriver.driverCode,
      fullName: activeDriver.fullName,
      phone: activeDriver.phone,
      emergencyContact: activeDriver.emergencyContact || '',
      linkedEmail: activeDriver.linkedEmail || '',
      monthlyAgreedSalary: String(activeDriver.monthlyAgreedSalary),
      employmentStartDate: activeDriver.employmentStartDate || '',
      accountStatus: activeDriver.accountStatus || 'active',
      photoUrl: activeDriver.photoUrl || '',
      licensePhotos: activeDriver.licensePhotos || [],
      notes: activeDriver.notes || '',
      schoolName:
        activeDriver.schoolId && activeDriver.schoolName && activeDriver.schoolName !== 'غير معين'
          ? activeDriver.schoolName
          : '',
      busNumber:
        activeDriver.vehicleId && activeDriver.busNumber && activeDriver.busNumber !== '—'
          ? activeDriver.busNumber
          : '',
      routeName:
        activeDriver.routeId && activeDriver.routeName && activeDriver.routeName !== '—'
          ? activeDriver.routeName
          : '',
      routePickupArea: activeDriver.pickupArea || '',
      routePickupTime: normalizeTimeInputValue(activeDriver.pickupTime),
      routeDropoffTime: normalizeTimeInputValue(activeDriver.dropoffTime),
    });
    setShowEditDriverModal(true);
  };

  const handleSaveDriverProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeDriver) return;
    setBusyAction(true);
    setActionErr(null);
    try {
      await apiFetch(`/api/drivers/${activeDriver.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...editDriverForm,
          monthlyAgreedSalary: Number(editDriverForm.monthlyAgreedSalary || 0),
          schoolName: editDriverForm.schoolName.trim(),
          busNumber: editDriverForm.busNumber.trim(),
          routeName: editDriverForm.routeName.trim(),
        }),
      });
      setShowEditDriverModal(false);
      if (editDriverForm.accountStatus !== 'active') {
        setSelectedDriverId(null);
        setStatement(null);
        setWhatsappHref(null);
        setActionMsg('تم نقل السائق إلى قسم الأرشفة وإخفاؤه من القوائم النشطة.');
        await loadDashboard();
      } else {
        setActionMsg('تم حفظ جميع تعديلات بيانات السائق وتحديث راتبه.');
        await refreshAllForDriver(activeDriver.id);
      }
    } catch (err: unknown) {
      setActionErr(err instanceof Error ? err.message : 'تعذر حفظ تعديلات السائق');
    } finally {
      setBusyAction(false);
    }
  };

  const handleArchiveSelectedDriver = async () => {
    if (!activeDriver) return;
    setBusyAction(true);
    setActionErr(null);
    try {
      await apiFetch(`/api/drivers/${activeDriver.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ accountStatus: 'inactive' }),
      });
      setSelectedDriverId(null);
      setStatement(null);
      setWhatsappHref(null);
      setActionMsg(`تم نقل السائق ${activeDriver.fullName} إلى قسم الأرشفة وإخفاؤه من القوائم النشطة.`);
      await loadDashboard();
    } catch (err: unknown) {
      setActionErr(err instanceof Error ? err.message : 'تعذر أرشفة السائق');
    } finally {
      setBusyAction(false);
    }
  };

  // Send Statement Image to WhatsApp
  const handleSendWhatsApp = async () => {
    if (!statement) return;
    setSendingWhatsApp(true);
    setActionErr(null);
    setActionMsg(null);
    setWhatsappHref(null);
    try {
      let blob: Blob;
      if (statementRef.current) {
        try {
          blob = await captureElementAsPngBlob(statementRef.current);
        } catch {
          blob = await renderStatementFallbackBlob({
            driver: statement.driver,
            period: statement.period,
            salary: statement.salary,
            transactions: statement.transactions,
          });
        }
      } else {
        blob = await renderStatementFallbackBlob({
          driver: statement.driver,
          period: statement.period,
          salary: statement.salary,
          transactions: statement.transactions,
        });
      }

      const fileName = `statement-${statement.driver.driverCode}-${statement.period.month}-${statement.period.year}.png`;
      const shareText = `كشف حساب السائق ${statement.driver.fullName} (كود ${statement.driver.driverCode}) - شهر ${statement.period.month}/${statement.period.year} - صافي المستحق: ${formatEGP(statement.salary.netSalary)}`;
      const waLink = buildWhatsAppUrl(statement.driver.phone, shareText);

      const webShareStatus = await shareImageFileViaWebShare(
        blob,
        fileName,
        `كشف حساب ${statement.driver.fullName}`,
        shareText
      );
      if (webShareStatus === 'shared') {
        setActionMsg('تمت مشاركة صورة كشف الحساب بنجاح.');
        return;
      }

      const copied = await copyPngBlobToClipboard(blob);
      downloadBlob(blob, fileName);
      setWhatsappHref(waLink);
      setActionMsg(
        copied
          ? 'تم نسخ صورة كشف الحساب وتنزيلها — اضغط «فتح محادثة واتساب» لإرسالها للسائق.'
          : 'تم تنزيل صورة كشف الحساب — اضغط «فتح محادثة واتساب» وأرفق الصورة.'
      );
    } catch (err: unknown) {
      setActionErr(err instanceof Error ? err.message : 'تعذر تجهيز صورة كشف الحساب للواتساب');
    } finally {
      setSendingWhatsApp(false);
    }
  };

  const kpis = data?.kpis;
  const profit = kpis?.monthlyBusinessProfit ?? 0;

  return (
    <div className="space-y-6">
      {/* Brand Hero + Instant Driver Lookup Bar */}
      <section className="relative overflow-hidden bg-[#0B1F3A] text-white rounded-2xl p-5 sm:p-6 border border-[#0B1F3A]">
        <img
          src={travelBackdropImg}
          alt=""
          referrerPolicy="no-referrer"
          className="absolute inset-0 w-full h-full object-cover opacity-30 pointer-events-none select-none"
        />
        <div
          aria-hidden="true"
          className="hidden sm:flex absolute left-6 top-1/2 -translate-y-1/2 pointer-events-none select-none"
        >
          <div className="w-44 h-44 rounded-full overflow-hidden opacity-55 ring-1 ring-[#C89B3C]/40 shadow-2xl">
            <img
              src={splashScreenImg}
              alt=""
              referrerPolicy="no-referrer"
              className="w-full h-full object-cover object-center scale-110"
            />
          </div>
        </div>
        <div className="absolute inset-0 bg-gradient-to-l from-[#0B1F3A]/85 via-[#0B1F3A]/45 to-transparent pointer-events-none" />
        <div className="relative z-10 space-y-5">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <BrandLogo size="xl" />
            <div className="min-w-0">
              <h1 className="font-display text-2xl sm:text-3xl font-bold text-white truncate">
                الوليد ترافيل
              </h1>
              <p className="text-xs sm:text-sm text-slate-300 mt-1">
                {canFinanceRead && (
                  <>
                    صافي الربحية:{' '}
                    <span className="font-mono font-bold text-[#C89B3C] tabular-nums">
                      {kpis ? formatEGP(profit) : '—'}
                    </span>
                    <span className="mx-2 text-slate-500">·</span>
                  </>
                )}
                السائقون:{' '}
                <span className="font-mono font-semibold text-white tabular-nums">
                  {kpis?.totalRegisteredDrivers ?? 0}
                </span>
                {canEmployeesAccess && (
                  <>
                    <span className="mx-2 text-slate-500">·</span>
                    الموظفون:{' '}
                    <span className="font-mono font-semibold text-white tabular-nums">
                      {kpis?.totalEmployeesCount ?? 0}
                    </span>
                  </>
                )}
              </p>
            </div>
          </div>

          {/* Period & Global Quick Tools */}
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <div className="flex items-center gap-1.5 rounded-lg border border-white/20 bg-white/10 px-2.5 py-1.5 text-xs">
              <span className="text-slate-300">الشهر</span>
              <input
                type="number"
                min={1}
                max={12}
                value={month}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (v >= 1 && v <= 12) {
                    initialPeriodSyncedRef.current = true;
                    setMonth(v);
                  }
                }}
                className="w-10 bg-transparent font-mono font-bold text-center text-[#C89B3C] focus:outline-none"
              />
              <span className="text-slate-400">/</span>
              <input
                type="number"
                min={2020}
                max={2099}
                value={year}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (v >= 2020 && v <= 2099) {
                    initialPeriodSyncedRef.current = true;
                    setYear(v);
                  }
                }}
                className="w-14 bg-transparent font-mono font-bold text-center text-[#C89B3C] focus:outline-none"
              />
            </div>

            <button
              type="button"
              onClick={() => {
                loadDashboard();
                if (selectedDriverId) loadDriverPage(selectedDriverId, month, year);
              }}
              className="flex items-center gap-1.5 rounded-lg border border-white/20 bg-white/10 hover:bg-white/20 px-3 py-2 text-xs font-semibold text-white cursor-pointer whitespace-nowrap"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              تحديث
            </button>

            {canFinanceWrite && (
              <button
                type="button"
                onClick={() => setShowCloseMonthModal(true)}
                className="flex items-center gap-1.5 rounded-lg border border-[#C89B3C]/60 bg-[#C89B3C]/15 hover:bg-[#C89B3C]/25 px-3 py-2 text-xs font-bold text-[#C89B3C] cursor-pointer whitespace-nowrap"
              >
                <CalendarCheck className="w-3.5 h-3.5" />
                تصفية الشهر
              </button>
            )}

            {isSuperAdmin && (
              <>
                <button
                  type="button"
                  onClick={() => setShowDriversBroadcastModal(true)}
                  className="flex items-center gap-1.5 rounded-lg border border-emerald-400/50 bg-emerald-500/20 hover:bg-emerald-500/30 px-3 py-2 text-xs font-bold text-emerald-100 cursor-pointer whitespace-nowrap"
                >
                  <RadioTower className="w-3.5 h-3.5 text-emerald-300" />
                  رسائل جماعية للسائقين
                </button>

                <button
                  type="button"
                  onClick={() => onNavigate('voice')}
                  className="flex items-center gap-1.5 rounded-lg bg-[#C89B3C] hover:bg-[#d8ac4e] px-3.5 py-2 text-xs font-bold text-[#0B1F3A] cursor-pointer whitespace-nowrap"
                >
                  <Mic className="w-3.5 h-3.5" />
                  أمر صوتي
                </button>
              </>
            )}
          </div>
        </div>

        {/* Central Driver Search (Name / Code / Mobile) */}
        {!selectedDriverId && (
          <form onSubmit={handleSearchSubmit} className="space-y-3">
            <div className="flex flex-col sm:flex-row gap-2.5">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute right-3.5 top-3.5 pointer-events-none" />
                <input
                  type="text"
                  value={driverLookup}
                  onChange={(e) => setDriverLookup(e.target.value)}
                  placeholder="ابحث باسم السائق، أو الكود، أو رقم الموبايل لفتح صفحته وتعديل كل بياناته..."
                  className="w-full rounded-xl border border-white/20 bg-white text-slate-900 pr-10 pl-9 py-3 text-sm placeholder:text-slate-400 focus:border-[#C89B3C] focus:outline-none"
                />
                {driverLookup && (
                  <button
                    type="button"
                    onClick={() => setDriverLookup('')}
                    aria-label="مسح البحث"
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
              <button
                type="submit"
                className="rounded-xl bg-[#C89B3C] hover:bg-[#d8ac4e] text-[#0B1F3A] px-6 py-3 text-xs font-bold cursor-pointer whitespace-nowrap shrink-0"
              >
                فتح صفحة السائق
              </button>
            </div>
          </form>
        )}
        </div>
      </section>

      {!selectedDriverId && <MorningSpiritualRibbon />}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-800 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
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

      {!selectedDriverId && actionMsg && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-800 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{actionMsg}</span>
          </div>
          {canDriversWrite && (
            <button
              type="button"
              onClick={() => onNavigate('archive')}
              className="rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-[11px] font-bold text-emerald-800 hover:bg-emerald-100 cursor-pointer shrink-0"
            >
              فتح قسم الأرشفة
            </button>
          )}
        </div>
      )}

      {/* ================================================================= */}
      {/* VIEW A: FULL DRIVER WORKSPACE ("صفحة السائق")                      */}
      {/* ================================================================= */}
      {selectedDriverId ? (
        <div className="space-y-5">
          {/* Workspace Navigation & Quick Switcher */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <button
              type="button"
              onClick={() => {
                setSelectedDriverId(null);
                setStatement(null);
                setActionMsg(null);
                setActionErr(null);
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 px-3.5 py-2 text-xs font-bold text-[#0B1F3A] cursor-pointer w-fit"
            >
              <ArrowRight className="w-4 h-4" />
              العودة لقائمة السائقين ولوحة التحكم
            </button>

            <div className="relative w-full md:w-96">
              <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5 pointer-events-none" />
              <input
                type="text"
                value={quickSwitchLookup}
                onChange={(e) => setQuickSwitchLookup(e.target.value)}
                placeholder="انتقال سريع لسائق آخر بالاسم أو الكود أو الموبايل..."
                className="w-full rounded-lg border border-slate-200 bg-slate-50 pr-9 pl-8 py-2 text-xs text-slate-900 focus:border-[#0B1F3A] focus:outline-none"
              />
              {quickSwitchLookup && (
                <button
                  type="button"
                  onClick={() => setQuickSwitchLookup('')}
                  aria-label="مسح البحث"
                  className="absolute left-2.5 top-2 text-slate-400 hover:text-slate-700 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
              {quickSwitchMatches.length > 0 && (
                <div className="absolute left-0 right-0 top-full mt-1 z-30 bg-white border border-slate-200 rounded-xl shadow-lg divide-y divide-slate-100 overflow-hidden">
                  {quickSwitchMatches.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => openDriverWorkspace(d)}
                      className="w-full px-3.5 py-2.5 text-right text-xs hover:bg-slate-50 flex items-center justify-between gap-2 cursor-pointer"
                    >
                      <div>
                        <div className="font-bold text-[#0B1F3A]">{d.fullName}</div>
                        <div className="text-[11px] text-slate-500">
                          كود {d.driverCode} · {d.phone}
                        </div>
                      </div>
                      <span className="font-mono text-[11px] font-semibold text-slate-600">
                        {d.schoolName}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {actionErr && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-800 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{actionErr}</span>
            </div>
          )}

          {actionMsg && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-800 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{actionMsg}</span>
              </div>
              {whatsappHref && (
                <a
                  href={whatsappHref}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3.5 py-1.5 text-xs font-bold text-white hover:bg-emerald-800"
                >
                  <MessageCircle className="w-4 h-4" />
                  فتح محادثة واتساب
                </a>
              )}
            </div>
          )}

          {loadingStatement || !statement || !activeDriver ? (
            <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-sm text-slate-500">
              جاري تحميل صفحة السائق...
            </div>
          ) : (
            <>
              {/* Driver Header Profile + Edit Everything + Attendance + WhatsApp */}
              <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-5">
                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                  <div className="flex items-start gap-4 min-w-0">
                    <DriverAvatar
                      name={activeDriver.fullName}
                      photoUrl={activeDriver.photoUrl}
                      size="lg"
                    />
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="font-display text-xl font-bold text-[#0B1F3A]">
                          {activeDriver.fullName}
                        </h2>
                      </div>
                      <div className="text-xs text-slate-600 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="font-mono font-bold text-[#0B1F3A]">
                          كود: {activeDriver.driverCode}
                        </span>
                        <span className="text-slate-300">·</span>
                        <span className="font-mono" dir="ltr">
                          {activeDriver.phone}
                        </span>
                        <span className="text-slate-300">·</span>
                        <span>المدرسة: {activeDriver.schoolName || 'غير معين'}</span>
                        <span className="text-slate-300">·</span>
                        <span>باص: {activeDriver.busNumber || '—'}</span>
                        {activeDriver.routeName && activeDriver.routeName !== '—' && (
                          <>
                            <span className="text-slate-300">·</span>
                            <span className="tabular-nums">
                              خط: {activeDriver.routeName}
                              {activeDriver.pickupTime
                                ? ` (${formatArabicTripTime(activeDriver.pickupTime)}`
                                : ''}
                              {activeDriver.dropoffTime
                                ? `${activeDriver.pickupTime ? ' - ' : ' ('}${formatArabicTripTime(activeDriver.dropoffTime)})`
                                : activeDriver.pickupTime
                                ? ')'
                                : ''}
                            </span>
                          </>
                        )}
                      </div>
                      {activeDriver.notes && (
                        <p className="text-xs text-slate-500">ملاحظات: {activeDriver.notes}</p>
                      )}
                    </div>
                  </div>

                  {/* Direct Driver Actions */}
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {canDriversWrite && (
                      <button
                        type="button"
                        onClick={openEditDriverModal}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[#0B1F3A] hover:bg-[#13325c] px-4 py-2 text-xs font-bold text-white cursor-pointer"
                      >
                        <Edit3 className="w-3.5 h-3.5 text-[#C89B3C]" />
                        تعديل بيانات السائق
                      </button>
                    )}

                    {activeDriver.phone && (
                      <>
                        <a
                          href={`tel:${activeDriver.phone}`}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700"
                        >
                          <Phone className="w-3.5 h-3.5 text-[#0B1F3A]" />
                          اتصال
                        </a>
                        <a
                          href={buildWhatsAppUrl(activeDriver.phone)}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 px-3 py-2 text-xs font-semibold text-white"
                        >
                          <MessageCircle className="w-3.5 h-3.5" />
                          واتساب
                        </a>
                      </>
                    )}

                    {canViewFinancialDetails && (
                      <button
                        type="button"
                        disabled={sendingWhatsApp}
                        onClick={handleSendWhatsApp}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-[#0B1F3A] bg-white hover:bg-slate-50 px-3.5 py-2 text-xs font-bold text-[#0B1F3A] disabled:opacity-50 cursor-pointer"
                      >
                        <Send className="w-3.5 h-3.5 text-[#C89B3C]" />
                        {sendingWhatsApp ? 'جاري التجهيز...' : 'إرسال كشف الحساب للواتساب (صورة)'}
                      </button>
                    )}

                    {canDriversWrite && (
                      <button
                        type="button"
                        disabled={busyAction}
                        onClick={handleArchiveSelectedDriver}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 hover:bg-amber-100 px-3 py-2 text-xs font-semibold text-amber-800 disabled:opacity-50 cursor-pointer"
                      >
                        <Archive className="w-3.5 h-3.5" />
                        نقل للأرشفة
                      </button>
                    )}
                  </div>
                </div>

                {/* Attendance & Salary Status Strip */}
                {(canAttendanceWrite || canFinanceRead) && (
                  <div className="pt-4 border-t border-slate-100 flex flex-wrap items-center justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-semibold text-slate-600">حضور اليوم:</span>
                      {canAttendanceWrite ? (
                        [
                          { status: 'present' as const, label: 'حاضر' },
                          { status: 'absent' as const, label: 'غائب' },
                          { status: 'leave' as const, label: 'إجازة' },
                        ].map((opt) => (
                          <button
                            key={opt.status}
                            type="button"
                            disabled={busyAction}
                            onClick={() => handleAttendance(opt.status)}
                            className={`rounded-lg border px-3 py-1.5 text-xs font-semibold cursor-pointer ${
                              activeDriver.todayAttendance === opt.status
                                ? 'border-[#0B1F3A] bg-[#0B1F3A] text-white'
                                : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))
                      ) : (
                        <span className="font-semibold text-[#0B1F3A]">
                          {activeDriver.todayAttendance === 'absent'
                            ? 'غائب'
                            : activeDriver.todayAttendance === 'leave'
                            ? 'إجازة'
                            : 'حاضر'}
                        </span>
                      )}
                    </div>

                    {canFinanceRead && (
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-semibold text-slate-600">حالة صرف راتب الشهر:</span>
                        {canFinanceWrite ? (
                          [
                            { value: 'open' as const, label: 'قيد التشغيل' },
                            { value: 'approved' as const, label: 'معتمد' },
                            { value: 'paid' as const, label: 'تم الصرف' },
                          ].map((st) => (
                            <button
                              key={st.value}
                              type="button"
                              disabled={busyAction}
                              onClick={() => handleSalaryStatus(st.value)}
                              className={`rounded-lg border px-3 py-1.5 text-xs font-semibold cursor-pointer ${
                                statement.salary.status === st.value
                                  ? 'border-[#0B1F3A] bg-[#0B1F3A] text-white'
                                  : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                              }`}
                            >
                              {st.label}
                            </button>
                          ))
                        ) : (
                          <span className="font-bold text-[#0B1F3A]">
                            {statement.salary.status === 'paid'
                              ? 'تم الصرف'
                              : statement.salary.status === 'approved'
                              ? 'معتمد'
                              : 'قيد التشغيل'}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Driver License Photos Section */}
              <DriverLicensesSection
                photos={activeDriver.licensePhotos || []}
                viewerRole="admin"
                readOnly={!canDriversWrite}
                onSavePhotos={
                  canDriversWrite
                    ? async (nextPhotos) => {
                        await apiFetch(`/api/drivers/${activeDriver.id}/licenses`, {
                          method: 'PUT',
                          body: JSON.stringify({ licensePhotos: nextPhotos }),
                        });
                        await refreshAllForDriver(activeDriver.id);
                      }
                    : undefined
                }
              />

              {/* Capturable Salary Statement Breakdown */}
              {canViewFinancialDetails && (
                <div
                  ref={statementRef}
                  className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4"
                >
                  <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                    <div>
                      <div className="font-display text-base font-bold text-[#0B1F3A]">
                        كشف راتب شهر {statement.period.month} / {statement.period.year} —{' '}
                        {activeDriver.fullName}
                      </div>
                      <div className="text-xs text-slate-500">
                        كود {activeDriver.driverCode} · {activeDriver.schoolName || '—'} · باص{' '}
                        {activeDriver.busNumber || '—'}
                      </div>
                    </div>
                    <div className="text-left font-mono font-bold text-lg text-[#0B1F3A] tabular-nums">
                      {formatEGP(statement.salary.netSalary)}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs">
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <div className="text-slate-500">الراتب الأساسي</div>
                      <div className="mt-1 font-mono text-base font-bold text-[#0B1F3A] tabular-nums">
                        {formatEGP(statement.salary.baseSalary)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-red-50/70 p-3">
                      <div className="text-slate-600">إجمالي السلف</div>
                      <div className="mt-1 font-mono text-base font-bold text-red-700 tabular-nums">
                        − {formatEGP(statement.salary.totalAdvances)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-red-50/70 p-3">
                      <div className="text-slate-600">خصم التغطيات</div>
                      <div className="mt-1 font-mono text-base font-bold text-red-700 tabular-nums">
                        − {formatEGP(statement.salary.totalCoverageDeductions)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-red-50/70 p-3">
                      <div className="text-slate-600">خصومات أخرى</div>
                      <div className="mt-1 font-mono text-base font-bold text-red-700 tabular-nums">
                        − {formatEGP(statement.salary.otherDeductions)}
                      </div>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-emerald-50/70 p-3">
                      <div className="text-slate-600">المكافآت</div>
                      <div className="mt-1 font-mono text-base font-bold text-emerald-700 tabular-nums">
                        + {formatEGP(statement.salary.bonuses)}
                      </div>
                    </div>
                    <div className="rounded-xl bg-[#0B1F3A] text-white p-3">
                      <div className="text-slate-300">صافي المستحق</div>
                      <div className="mt-1 font-mono text-base font-bold text-[#C89B3C] tabular-nums">
                        {formatEGP(statement.salary.netSalary)}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Driver Management Sections: Advances | Coverage | Bonuses & Deductions */}
              {canViewFinancialDetails && (
                <div className="flex flex-wrap items-center gap-1.5 p-1 bg-slate-200/70 rounded-xl w-fit">
                  {[
                    {
                      id: 'advances' as const,
                      label: `السلف (${statement.advances.length})`,
                      visible: canAdvancesWrite || canFinanceRead,
                    },
                    {
                      id: 'coverage' as const,
                      label: `التغطيات (${statement.coverages.length})`,
                      visible: canCoverageWrite || canFinanceRead,
                    },
                    {
                      id: 'adjustments' as const,
                      label: `المكافآت والخصومات والحركات (${statement.transactions.length})`,
                      visible: canFinanceRead,
                    },
                  ]
                    .filter((t) => t.visible)
                    .map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setDriverSectionTab(t.id)}
                        className={`px-4 py-2 text-xs font-bold rounded-lg transition-colors cursor-pointer ${
                          driverSectionTab === t.id
                            ? 'bg-white text-[#0B1F3A] shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                </div>
              )}

              {/* SECTION 1: ADVANCES (ADD + EDIT + DELETE) */}
              {canViewFinancialDetails &&
                driverSectionTab === 'advances' &&
                (canAdvancesWrite || canFinanceRead) && (
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                    {canAdvancesWrite && (
                      <form
                        onSubmit={handleAddAdvance}
                        className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5 space-y-3 text-xs h-fit"
                      >
                    <h3 className="font-display text-sm font-bold text-[#0B1F3A] flex items-center gap-2">
                      <Plus className="w-4 h-4 text-[#C89B3C]" />
                      إضافة سلفة جديدة لـ {activeDriver.fullName}
                    </h3>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block font-semibold text-slate-700 mb-1">
                          المبلغ (ج.م) *
                        </label>
                        <input
                          type="number"
                          required
                          min={1}
                          value={advForm.amount}
                          onChange={(e) => setAdvForm({ ...advForm, amount: e.target.value })}
                          placeholder="0"
                          className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                        />
                      </div>
                      <div>
                        <label className="block font-semibold text-slate-700 mb-1">التاريخ *</label>
                        <input
                          type="date"
                          required
                          value={advForm.date}
                          onChange={(e) => setAdvForm({ ...advForm, date: e.target.value })}
                          className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">طريقة الدفع</label>
                      <input
                        type="text"
                        value={advForm.paymentMethod}
                        onChange={(e) => setAdvForm({ ...advForm, paymentMethod: e.target.value })}
                        placeholder="اكتب طريقة الدفع"
                        className="w-full rounded-lg border border-slate-200 px-3 py-2"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">السبب</label>
                      <input
                        type="text"
                        value={advForm.reason}
                        onChange={(e) => setAdvForm({ ...advForm, reason: e.target.value })}
                        placeholder="اكتب السبب"
                        className="w-full rounded-lg border border-slate-200 px-3 py-2"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">ملاحظات</label>
                      <textarea
                        rows={2}
                        value={advForm.notes}
                        onChange={(e) => setAdvForm({ ...advForm, notes: e.target.value })}
                        className="w-full rounded-lg border border-slate-200 px-3 py-2"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={busyAction}
                      className="w-full rounded-lg bg-[#0B1F3A] py-2.5 font-bold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
                    >
                      اعتماد وتسجيل السلفة
                      </button>
                    </form>
                    )}

                    <div
                      className={`${
                        canAdvancesWrite ? 'lg:col-span-8' : 'lg:col-span-12'
                      } bg-white border border-slate-200 rounded-xl overflow-hidden`}
                    >
                      <div className="px-5 py-4 border-b border-slate-200 font-bold text-sm text-[#0B1F3A]">
                        سلف السائق لشهر {month} / {year}
                      </div>
                      <div className="md:hidden divide-y divide-slate-100">
                        {statement.advances.length === 0 ? (
                          <div className="p-6 text-center text-xs text-slate-400">
                            لا توجد سلف مسجلة لهذا السائق في هذا الشهر
                          </div>
                        ) : (
                          statement.advances.map((a) => (
                            <div key={a.id} className={`p-4 space-y-2 text-xs ${a.isReversed ? 'opacity-60' : ''}`}>
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-mono text-slate-500">{a.date}</span>
                                <span className={`font-mono font-bold text-red-700 ${a.isReversed ? 'line-through' : ''}`}>
                                  {formatEGP(a.amount)}
                                </span>
                              </div>
                              <div className="text-slate-700">
                                {a.reason || 'سلفة'} {a.paymentMethod ? `· ${a.paymentMethod}` : ''}
                              </div>
                              {canAdvancesWrite && (
                                <div className="flex items-center gap-2 pt-1">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingAdvance(a);
                                      setEditAdvForm({
                                        amount: String(a.amount),
                                        date: a.date,
                                        paymentMethod: a.paymentMethod || '',
                                        reason: a.reason || '',
                                        notes: a.notes || '',
                                      });
                                    }}
                                    className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg bg-[#0B1F3A] px-3 py-1.5 text-[11px] font-semibold text-white cursor-pointer"
                                  >
                                    <Edit3 className="w-3 h-3 text-[#C89B3C]" />
                                    تعديل
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setDeletingAdvance(a)}
                                    className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-[11px] font-semibold text-red-700 cursor-pointer"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                    حذف
                                  </button>
                                </div>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                      <div className="hidden md:block overflow-x-auto">
                        <table className="w-full text-right text-xs">
                          <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                            <tr>
                              <th className="py-3 px-4">التاريخ</th>
                              <th className="py-3 px-4">السبب والطريقة</th>
                              <th className="py-3 px-4">المبلغ</th>
                              {canAdvancesWrite && <th className="py-3 px-4">تعديل / حذف</th>}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {statement.advances.length === 0 ? (
                              <tr>
                                <td colSpan={canAdvancesWrite ? 4 : 3} className="py-8 text-center text-slate-400">
                                  لا توجد سلف مسجلة لهذا السائق في هذا الشهر
                                </td>
                              </tr>
                            ) : (
                              statement.advances.map((a) => (
                                <tr key={a.id} className={a.isReversed ? 'opacity-60' : ''}>
                                  <td className="py-3 px-4 font-mono tabular-nums">{a.date}</td>
                                  <td className="py-3 px-4">
                                    <div>{a.reason || '—'}</div>
                                    <div className="text-slate-400">{a.paymentMethod || '—'}</div>
                                  </td>
                                  <td
                                    className={`py-3 px-4 font-mono font-bold text-red-700 tabular-nums ${
                                      a.isReversed ? 'line-through' : ''
                                    }`}
                                  >
                                    {formatEGP(a.amount)}
                                  </td>
                                  {canAdvancesWrite && (
                                    <td className="py-3 px-4">
                                      <div className="flex items-center gap-1.5">
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setEditingAdvance(a);
                                            setEditAdvForm({
                                              amount: String(a.amount),
                                              date: a.date,
                                              paymentMethod: a.paymentMethod || '',
                                              reason: a.reason || '',
                                              notes: a.notes || '',
                                            });
                                          }}
                                          className="inline-flex items-center gap-1 rounded-md bg-[#0B1F3A] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#13325c] cursor-pointer"
                                        >
                                          <Edit3 className="w-3 h-3 text-[#C89B3C]" />
                                          تعديل
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => setDeletingAdvance(a)}
                                          className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100 cursor-pointer"
                                        >
                                          <Trash2 className="w-3 h-3" />
                                          حذف
                                        </button>
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
                  </div>
                )}

              {/* SECTION 2: COVERAGES (ADD + EDIT + DELETE) */}
              {canViewFinancialDetails &&
                driverSectionTab === 'coverage' &&
                (canCoverageWrite || canFinanceRead) && (
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                    {canCoverageWrite && (
                      <form
                        onSubmit={handleAddCoverage}
                        className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5 space-y-3 text-xs h-fit"
                      >
                    <h3 className="font-display text-sm font-bold text-[#0B1F3A] flex items-center gap-2">
                      <Plus className="w-4 h-4 text-[#C89B3C]" />
                      تسجيل تغطية غياب لـ {activeDriver.fullName}
                    </h3>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">
                        السائق البديل
                      </label>
                      <input
                        type="text"
                        value={covForm.replacementQuery}
                        onChange={(e) =>
                          setCovForm({ ...covForm, replacementQuery: e.target.value })
                        }
                        placeholder="اكتب اسم أو كود السائق البديل"
                        className="w-full rounded-lg border border-slate-200 px-3 py-2"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">
                        تاريخ التغطية *
                      </label>
                      <input
                        type="date"
                        required
                        value={covForm.date}
                        onChange={(e) => setCovForm({ ...covForm, date: e.target.value })}
                        className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block font-semibold text-slate-700 mb-1">
                          تكلفة البديل (ج.م)
                        </label>
                        <input
                          type="number"
                          required
                          min={0}
                          value={covForm.actualReplacementCost}
                          onChange={(e) =>
                            setCovForm({ ...covForm, actualReplacementCost: e.target.value })
                          }
                          placeholder="0"
                          className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                        />
                      </div>
                      <div>
                        <label className="block font-semibold text-slate-700 mb-1">
                          الخصم من السائق (ج.م)
                        </label>
                        <input
                          type="number"
                          required
                          min={0}
                          value={covForm.absentDriverDeduction}
                          onChange={(e) =>
                            setCovForm({ ...covForm, absentDriverDeduction: e.target.value })
                          }
                          placeholder="0"
                          className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">السبب</label>
                      <input
                        type="text"
                        value={covForm.reason}
                        onChange={(e) => setCovForm({ ...covForm, reason: e.target.value })}
                        placeholder="اكتب السبب"
                        className="w-full rounded-lg border border-slate-200 px-3 py-2"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={busyAction}
                      className="w-full rounded-lg bg-[#0B1F3A] py-2.5 font-bold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
                    >
                      تسجيل التغطية
                      </button>
                    </form>
                    )}

                    <div
                      className={`${
                        canCoverageWrite ? 'lg:col-span-8' : 'lg:col-span-12'
                      } bg-white border border-slate-200 rounded-xl overflow-hidden`}
                    >
                      <div className="px-5 py-4 border-b border-slate-200 font-bold text-sm text-[#0B1F3A]">
                        سجل تغطيات السائق لشهر {month} / {year}
                      </div>
                      <div className="md:hidden divide-y divide-slate-100">
                        {statement.coverages.length === 0 ? (
                          <div className="p-6 text-center text-xs text-slate-400">
                            لا توجد تغطيات مسجلة لهذا السائق في هذا الشهر
                          </div>
                        ) : (
                          statement.coverages.map((c) => (
                            <div key={c.id} className={`p-4 space-y-2 text-xs ${c.isReversed ? 'opacity-60' : ''}`}>
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-mono text-slate-500">{c.date}</span>
                                <span className={`font-mono font-bold text-red-700 ${c.isReversed ? 'line-through' : ''}`}>
                                  خصم: {formatEGP(c.absentDriverDeduction)}
                                </span>
                              </div>
                              <div className="font-semibold text-slate-800">
                                البديل: {c.replacementDriverName || c.replacementExternalName || '—'} · تكلفة {formatEGP(c.actualReplacementCost)}
                              </div>
                              {c.reason && <div className="text-slate-500">{c.reason}</div>}
                              {canCoverageWrite && (
                                <div className="flex items-center gap-2 pt-1">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingCoverage(c);
                                      setEditCovForm({
                                        replacementQuery:
                                          c.replacementDriverId &&
                                          c.replacementDriverName &&
                                          c.replacementDriverName !== '—'
                                            ? c.replacementDriverName
                                            : c.replacementExternalName || '',
                                        date: c.date,
                                        actualReplacementCost: String(c.actualReplacementCost ?? 0),
                                        absentDriverDeduction: String(c.absentDriverDeduction ?? 0),
                                        reason: c.reason || '',
                                        notes: c.notes || '',
                                      });
                                    }}
                                    className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg bg-[#0B1F3A] px-3 py-1.5 text-[11px] font-semibold text-white cursor-pointer"
                                  >
                                    <Edit3 className="w-3 h-3 text-[#C89B3C]" />
                                    تعديل
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setDeletingCoverage(c)}
                                    className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-[11px] font-semibold text-red-700 cursor-pointer"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                    حذف
                                  </button>
                                </div>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                      <div className="hidden md:block overflow-x-auto">
                        <table className="w-full text-right text-xs">
                          <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                            <tr>
                              <th className="py-3 px-4">التاريخ</th>
                              <th className="py-3 px-4">البديل والسبب</th>
                              <th className="py-3 px-4">تكلفة البديل</th>
                              <th className="py-3 px-4">خصم السائق</th>
                              {canCoverageWrite && <th className="py-3 px-4">تعديل / حذف</th>}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {statement.coverages.length === 0 ? (
                              <tr>
                                <td colSpan={canCoverageWrite ? 5 : 4} className="py-8 text-center text-slate-400">
                                  لا توجد تغطيات مسجلة لهذا السائق في هذا الشهر
                                </td>
                              </tr>
                            ) : (
                              statement.coverages.map((c) => (
                                <tr key={c.id} className={c.isReversed ? 'opacity-60' : ''}>
                                  <td className="py-3 px-4 font-mono tabular-nums">{c.date}</td>
                                  <td className="py-3 px-4">
                                    <div className="font-semibold text-slate-800">
                                      {c.replacementDriverName || c.replacementExternalName || '—'}
                                    </div>
                                    <div className="text-slate-400">{c.reason || '—'}</div>
                                  </td>
                                  <td className="py-3 px-4 font-mono tabular-nums">
                                    {formatEGP(c.actualReplacementCost)}
                                  </td>
                                  <td
                                    className={`py-3 px-4 font-mono font-bold text-red-700 tabular-nums ${
                                      c.isReversed ? 'line-through' : ''
                                    }`}
                                  >
                                    {formatEGP(c.absentDriverDeduction)}
                                  </td>
                                  {canCoverageWrite && (
                                    <td className="py-3 px-4">
                                      <div className="flex items-center gap-1.5">
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setEditingCoverage(c);
                                            setEditCovForm({
                                              replacementQuery:
                                                c.replacementDriverId &&
                                                c.replacementDriverName &&
                                                c.replacementDriverName !== '—'
                                                  ? c.replacementDriverName
                                                  : c.replacementExternalName || '',
                                              date: c.date,
                                              actualReplacementCost: String(
                                                c.actualReplacementCost ?? 0
                                              ),
                                              absentDriverDeduction: String(
                                                c.absentDriverDeduction ?? 0
                                              ),
                                              reason: c.reason || '',
                                              notes: c.notes || '',
                                            });
                                          }}
                                          className="inline-flex items-center gap-1 rounded-md bg-[#0B1F3A] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#13325c] cursor-pointer"
                                        >
                                          <Edit3 className="w-3 h-3 text-[#C89B3C]" />
                                          تعديل
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => setDeletingCoverage(c)}
                                          className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100 cursor-pointer"
                                        >
                                          <Trash2 className="w-3 h-3" />
                                          حذف
                                        </button>
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
                  </div>
                )}

              {/* SECTION 3: BONUSES, DEDUCTIONS & FULL MONTH TRANSACTIONS */}
              {canViewFinancialDetails &&
                driverSectionTab === 'adjustments' &&
                canFinanceRead && (
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                    {canFinanceWrite && (
                      <form
                        onSubmit={handleAddAdjustment}
                        className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5 space-y-3 text-xs h-fit"
                      >
                        <h3 className="font-display text-sm font-bold text-[#0B1F3A]">
                          إضافة مكافأة أو خصم إداري
                        </h3>
                        <div className="grid grid-cols-2 gap-2">
                          {[
                            { value: 'bonus' as const, label: 'مكافأة (+)' },
                            { value: 'other_deduction' as const, label: 'خصم (−)' },
                          ].map((opt) => (
                            <button
                              key={opt.value}
                              type="button"
                              onClick={() => setAdjForm({ ...adjForm, type: opt.value })}
                              className={`rounded-lg border px-3 py-2 font-semibold cursor-pointer ${
                                adjForm.type === opt.value
                                  ? 'border-[#0B1F3A] bg-[#0B1F3A] text-white'
                                  : 'border-slate-200 bg-white text-slate-700'
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                        <div>
                          <label className="block font-semibold text-slate-700 mb-1">
                            المبلغ (ج.م) *
                          </label>
                          <input
                            type="number"
                            required
                            min={1}
                            value={adjForm.amount}
                            onChange={(e) => setAdjForm({ ...adjForm, amount: e.target.value })}
                            placeholder="0"
                            className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                          />
                        </div>
                        <div>
                          <label className="block font-semibold text-slate-700 mb-1">
                            السبب / البيان *
                          </label>
                          <input
                            type="text"
                            required
                            value={adjForm.description}
                            onChange={(e) => setAdjForm({ ...adjForm, description: e.target.value })}
                            placeholder="اكتب السبب"
                            className="w-full rounded-lg border border-slate-200 px-3 py-2"
                          />
                        </div>
                        <button
                          type="submit"
                          disabled={busyAction}
                          className="w-full rounded-lg bg-[#0B1F3A] py-2.5 font-bold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
                        >
                          حفظ التسوية
                        </button>
                      </form>
                    )}

                    <div
                      className={`${
                        canFinanceWrite ? 'lg:col-span-8' : 'lg:col-span-12'
                      } bg-white border border-slate-200 rounded-xl overflow-hidden`}
                    >
                      <div className="px-5 py-4 border-b border-slate-200 font-bold text-sm text-[#0B1F3A]">
                        سجل حركات السائق لشهر {month} / {year}
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-right text-xs">
                          <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                            <tr>
                              <th className="py-3 px-4">التاريخ</th>
                              <th className="py-3 px-4">النوع</th>
                              <th className="py-3 px-4">البيان</th>
                              <th className="py-3 px-4">القيمة</th>
                              {canFinanceWrite && <th className="py-3 px-4">تعديل / حذف</th>}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {statement.transactions.length === 0 ? (
                              <tr>
                                <td colSpan={canFinanceWrite ? 5 : 4} className="py-8 text-center text-slate-400">
                                  لا توجد حركات مسجلة في هذا الشهر
                                </td>
                              </tr>
                            ) : (
                              statement.transactions.map((t) => {
                                const isAdjustable =
                                  t.type === 'bonus' || t.type === 'other_deduction';
                                return (
                                  <tr key={t.id}>
                                    <td className="py-3 px-4 font-mono text-slate-500">
                                      {new Date(t.createdAt).toLocaleDateString('ar-EG')}
                                    </td>
                                    <td className="py-3 px-4 font-semibold">
                                      {t.type === 'advance'
                                        ? 'سلفة'
                                        : t.type === 'coverage_deduction'
                                        ? 'خصم تغطية'
                                        : t.type === 'bonus'
                                        ? 'مكافأة'
                                        : t.type === 'other_deduction'
                                        ? 'خصم إداري'
                                        : t.type}
                                    </td>
                                    <td className="py-3 px-4">{t.description}</td>
                                    <td
                                      className={`py-3 px-4 font-mono font-bold tabular-nums ${
                                        t.direction === 'credit' ? 'text-emerald-700' : 'text-red-700'
                                      }`}
                                    >
                                      {t.direction === 'credit' ? '+' : '−'} {formatEGP(t.amount)}
                                    </td>
                                    {canFinanceWrite && (
                                      <td className="py-3 px-4">
                                        {isAdjustable ? (
                                          <div className="flex items-center gap-1.5">
                                            <button
                                              type="button"
                                              onClick={() => {
                                                setEditingAdjustment(t);
                                                setEditAdjForm({
                                                  type:
                                                    t.type === 'bonus' ? 'bonus' : 'other_deduction',
                                                  amount: String(t.amount),
                                                  description: t.description,
                                                });
                                              }}
                                              className="inline-flex items-center gap-1 rounded-md bg-[#0B1F3A] px-2 py-1 text-[11px] font-semibold text-white hover:bg-[#13325c] cursor-pointer"
                                            >
                                              <Edit3 className="w-3 h-3 text-[#C89B3C]" />
                                              تعديل
                                            </button>
                                            <button
                                              type="button"
                                              onClick={() => setDeletingAdjustment(t)}
                                              className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100 cursor-pointer"
                                            >
                                              <Trash2 className="w-3 h-3" />
                                              حذف
                                            </button>
                                          </div>
                                        ) : (
                                          <span className="text-[11px] text-slate-400">
                                            من تبويب السلف/التغطيات
                                          </span>
                                        )}
                                      </td>
                                    )}
                                  </tr>
                                );
                              })
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )}
            </>
          )}
        </div>
      ) : (
        /* ================================================================= */
        /* VIEW B: PRACTICAL OVERVIEW & CLICKABLE DRIVER DIRECTORY           */
        /* ================================================================= */
        <div className="space-y-6">
          {/* 4-Card Essential KPI Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {canFinanceRead && (
              <>
                <div className="bg-white rounded-xl p-5 border border-slate-200">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>صافي الربحية الشهرية</span>
                    <TrendingUp className="w-4 h-4 text-[#C89B3C]" />
                  </div>
                  <div
                    className={`mt-2 font-mono text-2xl font-bold tabular-nums ${
                      profit >= 0 ? 'text-[#0B1F3A]' : 'text-red-700'
                    }`}
                  >
                    {loading || !kpis ? '—' : formatEGP(profit)}
                  </div>
                  <div className="mt-2 text-xs text-slate-500 tabular-nums">
                    عقود {kpis ? formatEGP(kpis.totalSchoolContracts) : '—'} − رواتب{' '}
                    {kpis ? formatEGP(kpis.totalMonthlySalaries) : '—'}
                  </div>
                </div>

                <div className="bg-white rounded-xl p-5 border border-slate-200">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>إجمالي الرواتب (سائقين + موظفين)</span>
                    <Wallet className="w-4 h-4 text-slate-400" />
                  </div>
                  <div className="mt-2 font-mono text-2xl font-bold text-[#0B1F3A] tabular-nums">
                    {loading || !kpis ? '—' : formatEGP(kpis.totalMonthlySalaries)}
                  </div>
                  <div className="mt-2 text-xs text-slate-500 tabular-nums">
                    سائقين {kpis ? formatEGP(kpis.totalDriverSalaries) : '—'} · موظفين{' '}
                    {kpis ? formatEGP(kpis.totalEmployeeSalaries) : '—'}
                  </div>
                </div>
              </>
            )}

            <div className="bg-white rounded-xl p-5 border border-slate-200">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>جاهزية الأسطول والسائقين</span>
                <Bus className="w-4 h-4 text-emerald-600" />
              </div>
              <div className="mt-2 font-mono text-2xl font-bold text-slate-900 tabular-nums">
                {loading || !kpis
                  ? '—'
                  : `${kpis.vehiclesOnline} / ${kpis.totalActiveVehicles} متصل`}
              </div>
              <div className="mt-2 text-xs text-slate-500 tabular-nums">
                نشطين: {kpis?.driversActive ?? 0} · غياب اليوم: {kpis?.driversAbsent ?? 0}
              </div>
            </div>

            {canEmployeesAccess ? (
              <button
                type="button"
                onClick={() => onNavigate('employees')}
                className="bg-white hover:bg-slate-50 rounded-xl p-5 border border-slate-200 text-right transition-colors cursor-pointer"
              >
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>الموظفون (غير السائقين)</span>
                  <Briefcase className="w-4 h-4 text-[#C89B3C]" />
                </div>
                <div className="mt-2 font-mono text-2xl font-bold text-[#0B1F3A] tabular-nums">
                  {loading || !kpis ? '—' : `${kpis.totalEmployeesCount} موظف`}
                </div>
                <div className="mt-2 text-xs font-semibold text-[#0B1F3A]">
                  اضغط لإدارة الموظفين ورواتبهم ←
                </div>
              </button>
            ) : canViewFinancialDetails ? (
              <div className="bg-white rounded-xl p-5 border border-slate-200 text-right">
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>إجمالي السلف والتغطيات</span>
                  <Wallet className="w-4 h-4 text-[#C89B3C]" />
                </div>
                <div className="mt-2 font-mono text-2xl font-bold text-[#0B1F3A] tabular-nums">
                  {loading || !kpis
                    ? '—'
                    : formatEGP(kpis.totalAdvances + kpis.totalCoverageDeductions)}
                </div>
                <div className="mt-2 text-xs text-slate-500 tabular-nums">
                  سلف {kpis ? formatEGP(kpis.totalAdvances) : '—'} · تغطيات{' '}
                  {kpis ? formatEGP(kpis.totalCoverageDeductions) : '—'}
                </div>
              </div>
            ) : (
              <div className="bg-white rounded-xl p-5 border border-slate-200 text-right">
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>نطاق المدارس المسموح</span>
                  <Users className="w-4 h-4 text-[#C89B3C]" />
                </div>
                <div className="mt-2 font-mono text-2xl font-bold text-[#0B1F3A] tabular-nums">
                  {loading || !data ? '—' : `${data.schools.length} مدرسة`}
                </div>
                <div className="mt-2 text-xs text-slate-500 tabular-nums">
                  إجمالي السائقين المتاحين: {data?.drivers.length ?? 0}
                </div>
              </div>
            )}
          </div>

          {/* Clickable Driver Directory (Instant Match Results or All Drivers) */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-base font-bold text-[#0B1F3A]">
                  {driverLookup.trim()
                    ? `نتائج البحث (${matchedDrivers.length})`
                    : `السائقون المسجلون (${matchedDrivers.length})`}
                </h2>
                <p className="text-xs text-slate-500">
                  اضغط على أي سائق لفتح صفحته لمتابعة بياناته وتسجيل السلف والتغطيات وفق صلاحياتك
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {isSuperAdmin && (
                  <button
                    type="button"
                    onClick={() => setShowDriversBroadcastModal(true)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 px-3.5 py-2 text-xs font-bold text-white cursor-pointer"
                  >
                    <RadioTower className="w-3.5 h-3.5" />
                    رسائل جماعية للسائقين
                  </button>
                )}
                {canDriversWrite && (
                  <button
                    type="button"
                    onClick={() => onNavigate('drivers')}
                    className="rounded-lg bg-[#0B1F3A] hover:bg-[#13325c] px-3.5 py-2 text-xs font-semibold text-white cursor-pointer"
                  >
                    إضافة سائق جديد
                  </button>
                )}
                {canSchoolsOrVehicles && (
                  <button
                    type="button"
                    onClick={() => onNavigate('schools')}
                    className="rounded-lg border border-slate-200 bg-white hover:bg-slate-50 px-3.5 py-2 text-xs font-semibold text-slate-700 cursor-pointer"
                  >
                    المدارس والعقود
                  </button>
                )}
                {canGpsRead && (
                  <button
                    type="button"
                    onClick={() => onNavigate('map')}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 px-3.5 py-2 text-xs font-semibold text-slate-700 cursor-pointer"
                  >
                    <MapPin className="w-3.5 h-3.5 text-[#C89B3C]" />
                    الخريطة
                  </button>
                )}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-4 font-semibold">الكود</th>
                    <th className="py-3 px-4 font-semibold">السائق والموبايل</th>
                    <th className="py-3 px-4 font-semibold">المدرسة والباص</th>
                    {canFinanceRead && (
                      <th className="py-3 px-4 font-semibold">الأساسي</th>
                    )}
                    {(canFinanceRead || canAdvancesWrite) && (
                      <th className="py-3 px-4 font-semibold">السلف</th>
                    )}
                    {(canFinanceRead || canCoverageWrite) && (
                      <th className="py-3 px-4 font-semibold">التغطيات</th>
                    )}
                    {canFinanceRead && (
                      <th className="py-3 px-4 font-semibold">صافي المستحق</th>
                    )}
                    <th className="py-3 px-4 font-semibold">فتح الصفحة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {loading ? (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-slate-400">
                        جاري تحميل البيانات...
                      </td>
                    </tr>
                  ) : matchedDrivers.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-slate-400">
                        لا يوجد سائقون مطابقون للبحث
                      </td>
                    </tr>
                  ) : (
                    matchedDrivers.map((d) => {
                      const sal = d.currentSalary;
                      return (
                        <tr
                          key={d.id}
                          onClick={() => openDriverWorkspace(d)}
                          className="hover:bg-slate-50 cursor-pointer transition-colors"
                        >
                          <td className="py-3 px-4 font-mono font-bold text-[#0B1F3A] tabular-nums">
                            {d.driverCode}
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-2.5">
                              <DriverAvatar name={d.fullName} photoUrl={d.photoUrl} size="xs" />
                              <div>
                                <div className="font-bold text-slate-900">{d.fullName}</div>
                                <div className="font-mono text-slate-500 tabular-nums" dir="ltr">
                                  {d.phone}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="py-3 px-4">
                            <div className="text-slate-800">{d.schoolName || '—'}</div>
                            <div className="text-slate-500 font-mono">{d.busNumber || '—'}</div>
                          </td>
                          {canFinanceRead && (
                            <td className="py-3 px-4 font-mono tabular-nums">
                              {formatEGP(sal?.baseSalary ?? d.monthlyAgreedSalary)}
                            </td>
                          )}
                          {(canFinanceRead || canAdvancesWrite) && (
                            <td className="py-3 px-4 font-mono text-red-700 tabular-nums">
                              {formatEGP(sal?.totalAdvances ?? 0)}
                            </td>
                          )}
                          {(canFinanceRead || canCoverageWrite) && (
                            <td className="py-3 px-4 font-mono text-red-700 tabular-nums">
                              {formatEGP(sal?.totalCoverageDeductions ?? 0)}
                            </td>
                          )}
                          {canFinanceRead && (
                            <td className="py-3 px-4 font-mono font-bold text-[#0B1F3A] tabular-nums">
                              {formatEGP(sal?.netSalary ?? d.monthlyAgreedSalary)}
                            </td>
                          )}
                          <td className="py-3 px-4">
                            <span className="inline-flex items-center gap-1 rounded-lg bg-[#0B1F3A] px-3 py-1.5 text-[11px] font-semibold text-white">
                              <Users className="w-3 h-3 text-[#C89B3C]" />
                              إدارة السائق
                            </span>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* MODALS INSIDE DRIVER PAGE                                         */}
      {/* ================================================================= */}

      {/* Full Driver Profile Edit Modal */}
      {showEditDriverModal && activeDriver && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-2xl bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden max-h-[92vh] flex flex-col">
            <div className="px-6 py-4 bg-[#0B1F3A] text-white flex items-center justify-between">
              <h3 className="font-display text-base font-bold">
                تعديل بيانات السائق — {activeDriver.fullName}
              </h3>
              <button
                type="button"
                onClick={() => setShowEditDriverModal(false)}
                className="text-slate-300 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveDriverProfile} className="p-6 overflow-y-auto space-y-4 text-xs">
              <DriverPhotoUploader
                driverName={editDriverForm.fullName || activeDriver.fullName}
                photoUrl={editDriverForm.photoUrl}
                onChange={(photoUrl) => setEditDriverForm((p) => ({ ...p, photoUrl }))}
              />

              <DriverLicensesSection
                compact
                viewerRole="admin"
                photos={editDriverForm.licensePhotos}
                onChange={(licensePhotos) => setEditDriverForm((p) => ({ ...p, licensePhotos }))}
              />

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">كود السائق *</label>
                  <input
                    required
                    value={editDriverForm.driverCode}
                    onChange={(e) =>
                      setEditDriverForm({ ...editDriverForm, driverCode: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">الاسم الكامل *</label>
                  <input
                    required
                    value={editDriverForm.fullName}
                    onChange={(e) =>
                      setEditDriverForm({ ...editDriverForm, fullName: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">رقم الموبايل *</label>
                  <ContactPhoneInput
                    value={editDriverForm.phone}
                    required
                    onChange={(phone) => setEditDriverForm((p) => ({ ...p, phone }))}
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">رقم الطوارئ</label>
                  <ContactPhoneInput
                    value={editDriverForm.emergencyContact}
                    onChange={(emergencyContact) =>
                      setEditDriverForm((p) => ({ ...p, emergencyContact }))
                    }
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    الراتب الشهري الأساسي (ج.م) *
                  </label>
                  <input
                    type="number"
                    required
                    min={0}
                    value={editDriverForm.monthlyAgreedSalary}
                    onChange={(e) =>
                      setEditDriverForm({ ...editDriverForm, monthlyAgreedSalary: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">تاريخ التعيين</label>
                  <input
                    type="date"
                    value={editDriverForm.employmentStartDate}
                    onChange={(e) =>
                      setEditDriverForm({ ...editDriverForm, employmentStartDate: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    المدرسة {!isSuperAdmin && restrictedSchoolIds.length > 0 ? '*' : ''}
                  </label>
                  {data?.schools && data.schools.length > 0 ? (
                    <select
                      required={!isSuperAdmin && restrictedSchoolIds.length > 0}
                      disabled={isSingleSchoolRestricted}
                      value={editDriverForm.schoolName}
                      onChange={(e) =>
                        setEditDriverForm({ ...editDriverForm, schoolName: e.target.value })
                      }
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-semibold text-[#0B1F3A] disabled:bg-slate-100"
                    >
                      {(isSuperAdmin || restrictedSchoolIds.length === 0) && (
                        <option value="">غير معين بمدرسة</option>
                      )}
                      {data.schools.map((s) => (
                        <option key={s.id} value={s.name}>
                          {s.name}
                        </option>
                      ))}
                      {isSuperAdmin &&
                        editDriverForm.schoolName &&
                        !data.schools.some((s) => s.name === editDriverForm.schoolName) && (
                          <option value={editDriverForm.schoolName}>
                            {editDriverForm.schoolName}
                          </option>
                        )}
                    </select>
                  ) : (
                    <input
                      value={editDriverForm.schoolName}
                      onChange={(e) =>
                        setEditDriverForm({ ...editDriverForm, schoolName: e.target.value })
                      }
                      placeholder="اكتب اسم المدرسة"
                      className="w-full rounded-lg border border-slate-200 px-3 py-2"
                    />
                  )}
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">رقم الباص</label>
                  <input
                    value={editDriverForm.busNumber}
                    onChange={(e) =>
                      setEditDriverForm({ ...editDriverForm, busNumber: e.target.value })
                    }
                    placeholder="اكتب رقم الباص"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">اسم خط السير</label>
                  <input
                    value={editDriverForm.routeName}
                    onChange={(e) =>
                      setEditDriverForm({ ...editDriverForm, routeName: e.target.value })
                    }
                    placeholder="اكتب اسم خط السير"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">منطقة التحرك</label>
                  <input
                    value={editDriverForm.routePickupArea}
                    onChange={(e) =>
                      setEditDriverForm({ ...editDriverForm, routePickupArea: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">وقت بداية الرحلة</label>
                  <input
                    type="time"
                    value={editDriverForm.routePickupTime}
                    onChange={(e) =>
                      setEditDriverForm({ ...editDriverForm, routePickupTime: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">وقت نهاية الرحلة</label>
                  <input
                    type="time"
                    value={editDriverForm.routeDropoffTime}
                    onChange={(e) =>
                      setEditDriverForm({ ...editDriverForm, routeDropoffTime: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono tabular-nums"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">حالة الحساب</label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { value: 'active', label: 'نشط' },
                    { value: 'inactive', label: 'نقل للأرشفة' },
                  ].map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() =>
                        setEditDriverForm({ ...editDriverForm, accountStatus: opt.value })
                      }
                      className={`rounded-lg border px-3 py-2 font-semibold cursor-pointer ${
                        editDriverForm.accountStatus === opt.value
                          ? 'border-[#0B1F3A] bg-[#0B1F3A] text-white'
                          : 'border-slate-200 bg-white text-slate-700'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">ملاحظات</label>
                <textarea
                  rows={2}
                  value={editDriverForm.notes}
                  onChange={(e) => setEditDriverForm({ ...editDriverForm, notes: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowEditDriverModal(false)}
                  className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={busyAction}
                  className="rounded-lg bg-[#0B1F3A] px-5 py-2 font-bold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
                >
                  {busyAction ? 'جاري الحفظ...' : 'حفظ جميع التعديلات'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Advance Modal */}
      {editingAdvance && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
            <div className="px-5 py-4 bg-[#0B1F3A] text-white flex items-center justify-between">
              <h3 className="font-display text-sm font-bold">تعديل السلفة</h3>
              <button
                type="button"
                onClick={() => setEditingAdvance(null)}
                className="text-slate-300 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveAdvanceEdit} className="p-5 space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">المبلغ (ج.م) *</label>
                  <input
                    type="number"
                    required
                    min={1}
                    value={editAdvForm.amount}
                    onChange={(e) => setEditAdvForm({ ...editAdvForm, amount: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">التاريخ *</label>
                  <input
                    type="date"
                    required
                    value={editAdvForm.date}
                    onChange={(e) => setEditAdvForm({ ...editAdvForm, date: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">طريقة الدفع</label>
                <input
                  value={editAdvForm.paymentMethod}
                  onChange={(e) =>
                    setEditAdvForm({ ...editAdvForm, paymentMethod: e.target.value })
                  }
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">السبب</label>
                <input
                  value={editAdvForm.reason}
                  onChange={(e) => setEditAdvForm({ ...editAdvForm, reason: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setEditingAdvance(null)}
                  className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={busyAction}
                  className="rounded-lg bg-[#0B1F3A] px-5 py-2 font-bold text-white cursor-pointer"
                >
                  حفظ التعديل
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Advance Confirmation */}
      {deletingAdvance && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-sm bg-white rounded-2xl border border-slate-200 shadow-xl p-5 space-y-4 text-xs">
            <h3 className="font-bold text-sm text-[#0B1F3A]">تأكيد حذف السلفة</h3>
            <p className="text-slate-600">
              هل تريد حذف السلفة بقيمة{' '}
              <strong className="font-mono">{formatEGP(deletingAdvance.amount)}</strong> بتاريخ{' '}
              <strong className="font-mono">{deletingAdvance.date}</strong>؟
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeletingAdvance(null)}
                className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={busyAction}
                onClick={handleDeleteAdvance}
                className="rounded-lg bg-red-600 px-4 py-2 font-bold text-white hover:bg-red-700 cursor-pointer"
              >
                حذف السلفة
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Coverage Modal */}
      {editingCoverage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
            <div className="px-5 py-4 bg-[#0B1F3A] text-white flex items-center justify-between">
              <h3 className="font-display text-sm font-bold">تعديل تغطية الغياب</h3>
              <button
                type="button"
                onClick={() => setEditingCoverage(null)}
                className="text-slate-300 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveCoverageEdit} className="p-5 space-y-3 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">السائق البديل</label>
                <input
                  value={editCovForm.replacementQuery}
                  onChange={(e) =>
                    setEditCovForm({ ...editCovForm, replacementQuery: e.target.value })
                  }
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">تاريخ التغطية *</label>
                <input
                  type="date"
                  required
                  value={editCovForm.date}
                  onChange={(e) => setEditCovForm({ ...editCovForm, date: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    تكلفة البديل (ج.م)
                  </label>
                  <input
                    type="number"
                    required
                    min={0}
                    value={editCovForm.actualReplacementCost}
                    onChange={(e) =>
                      setEditCovForm({ ...editCovForm, actualReplacementCost: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    خصم السائق (ج.م)
                  </label>
                  <input
                    type="number"
                    required
                    min={0}
                    value={editCovForm.absentDriverDeduction}
                    onChange={(e) =>
                      setEditCovForm({ ...editCovForm, absentDriverDeduction: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">السبب</label>
                <input
                  value={editCovForm.reason}
                  onChange={(e) => setEditCovForm({ ...editCovForm, reason: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setEditingCoverage(null)}
                  className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={busyAction}
                  className="rounded-lg bg-[#0B1F3A] px-5 py-2 font-bold text-white cursor-pointer"
                >
                  حفظ التعديل
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Coverage Confirmation */}
      {deletingCoverage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-sm bg-white rounded-2xl border border-slate-200 shadow-xl p-5 space-y-4 text-xs">
            <h3 className="font-bold text-sm text-[#0B1F3A]">تأكيد حذف التغطية</h3>
            <p className="text-slate-600">
              هل تريد حذف سجل التغطية بتاريخ{' '}
              <strong className="font-mono">{deletingCoverage.date}</strong> (خصم{' '}
              <strong className="font-mono">
                {formatEGP(deletingCoverage.absentDriverDeduction)}
              </strong>
              )؟
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeletingCoverage(null)}
                className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={busyAction}
                onClick={handleDeleteCoverage}
                className="rounded-lg bg-red-600 px-4 py-2 font-bold text-white hover:bg-red-700 cursor-pointer"
              >
                حذف التغطية
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Bonus/Deduction Modal */}
      {editingAdjustment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
            <div className="px-5 py-4 bg-[#0B1F3A] text-white flex items-center justify-between">
              <h3 className="font-display text-sm font-bold">تعديل المكافأة / الخصم الإداري</h3>
              <button
                type="button"
                onClick={() => setEditingAdjustment(null)}
                className="text-slate-300 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveAdjustmentEdit} className="p-5 space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-2">
                {[
                  { value: 'bonus' as const, label: 'مكافأة (+)' },
                  { value: 'other_deduction' as const, label: 'خصم (−)' },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setEditAdjForm({ ...editAdjForm, type: opt.value })}
                    className={`rounded-lg border px-3 py-2 font-semibold cursor-pointer ${
                      editAdjForm.type === opt.value
                        ? 'border-[#0B1F3A] bg-[#0B1F3A] text-white'
                        : 'border-slate-200 bg-white text-slate-700'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">المبلغ (ج.م) *</label>
                <input
                  type="number"
                  required
                  min={1}
                  value={editAdjForm.amount}
                  onChange={(e) => setEditAdjForm({ ...editAdjForm, amount: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">البيان *</label>
                <input
                  required
                  value={editAdjForm.description}
                  onChange={(e) => setEditAdjForm({ ...editAdjForm, description: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setEditingAdjustment(null)}
                  className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={busyAction}
                  className="rounded-lg bg-[#0B1F3A] px-5 py-2 font-bold text-white cursor-pointer"
                >
                  حفظ التعديل
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Bonus/Deduction Confirmation */}
      {deletingAdjustment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-sm bg-white rounded-2xl border border-slate-200 shadow-xl p-5 space-y-4 text-xs">
            <h3 className="font-bold text-sm text-[#0B1F3A]">تأكيد الحذف</h3>
            <p className="text-slate-600">
              هل تريد حذف الحركة <strong>{deletingAdjustment.description}</strong> بقيمة{' '}
              <strong className="font-mono">{formatEGP(deletingAdjustment.amount)}</strong>؟
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeletingAdjustment(null)}
                className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={busyAction}
                onClick={handleDeleteAdjustment}
                className="rounded-lg bg-red-600 px-4 py-2 font-bold text-white hover:bg-red-700 cursor-pointer"
              >
                حذف نهائي
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Quick Monthly Closing & Fresh-Month Rollover Modal */}
      {showCloseMonthModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-xl p-6 space-y-4 text-xs">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-[#0B1F3A]">
                <CalendarCheck className="w-5 h-5 text-[#C89B3C]" />
                <h3 className="font-display text-base font-bold">
                  تصفية شهر {month}/{year} وبدء شهر جديد على بياض
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowCloseMonthModal(false)}
                className="text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-slate-600 leading-relaxed">
              سيتم إغلاق شهر <strong>{month}/{year}</strong> (
              <strong>
                {closeMonthSchoolId === 'all'
                  ? 'جميع المدارس'
                  : data?.schools.find((s) => String(s.id) === closeMonthSchoolId)?.name ||
                    dbUser?.assignedSchoolNames?.[0] ||
                    'المدرسة المحددة'}
              </strong>
              ) وحفظ تقريره الختامي وتحديد رواتبه كـ «تم الصرف»، وتصفير السلف والتغطيات والمكافآت والخصومات لبداية الشهر الجديد{' '}
              <strong>
                {month === 12 ? 1 : month + 1}/{month === 12 ? year + 1 : year}
              </strong>{' '}
              على بياض بنفس السائقين والموظفين والمدارس والمركبات.
            </p>
            {data?.schools && data.schools.length > 0 && (
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  نطاق المدرسة للتصفية
                </label>
                <select
                  disabled={isSingleSchoolRestricted}
                  value={closeMonthSchoolId}
                  onChange={(e) => setCloseMonthSchoolId(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-bold text-[#0B1F3A] disabled:opacity-80"
                >
                  {isSuperAdmin && <option value="all">جميع المدارس (تصفية شاملة)</option>}
                  {data.schools.map((s) => (
                    <option key={s.id} value={String(s.id)}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block font-semibold text-slate-700 mb-1">ملاحظات (اختياري)</label>
              <input
                type="text"
                value={closeMonthNotes}
                onChange={(e) => setCloseMonthNotes(e.target.value)}
                placeholder="اكتب ملاحظة للتصفية إن وجدت"
                className="w-full rounded-lg border border-slate-200 px-3 py-2"
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => {
                  setShowCloseMonthModal(false);
                  onNavigate('finance');
                }}
                className="text-[11px] font-semibold text-[#0B1F3A] underline cursor-pointer"
              >
                فتح سجل التصفيات وتصفير الشهر في المالية
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busyAction}
                  onClick={() => setShowCloseMonthModal(false)}
                  className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="button"
                  disabled={busyAction}
                  onClick={async () => {
                    setBusyAction(true);
                    setError(null);
                    try {
                      const targetSchoolId =
                        closeMonthSchoolId && closeMonthSchoolId !== 'all'
                          ? Number(closeMonthSchoolId)
                          : null;
                      const res = await apiFetch<{ nextPeriod: { month: number; year: number } }>(
                        '/api/finance/close-month',
                        {
                          method: 'POST',
                          body: JSON.stringify({
                            month,
                            year,
                            schoolId: targetSchoolId,
                            markAllPaid: true,
                            notes: closeMonthNotes.trim(),
                          }),
                        }
                      );
                      setShowCloseMonthModal(false);
                      setCloseMonthNotes('');
                      initialPeriodSyncedRef.current = true;
                      setMonth(res.nextPeriod.month);
                      setYear(res.nextPeriod.year);
                      setSelectedDriverId(null);
                      setStatement(null);
                      setActionMsg(
                        `تمت تصفية شهر ${month}/${year} وبدء شهر ${res.nextPeriod.month}/${res.nextPeriod.year} على بياض بنفس السائقين والمركبات والمدارس.`
                      );
                    } catch (err: unknown) {
                      setError(err instanceof Error ? err.message : 'تعذر تنفيذ التصفية الشهرية');
                    } finally {
                      setBusyAction(false);
                    }
                  }}
                  className="rounded-lg bg-[#0B1F3A] px-4 py-2 font-bold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
                >
                  {busyAction ? 'جاري التصفية...' : 'تصفية وبدء الشهر الجديد'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <DriverBroadcastModal
        open={showDriversBroadcastModal}
        onClose={() => setShowDriversBroadcastModal(false)}
        onOpenDriversChat={() => onNavigate('chat', 'drivers_broadcast')}
      />
    </div>
  );
};
