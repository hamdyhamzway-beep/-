import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  Bus,
  Calendar,
  Edit3,
  Plus,
  Route,
  Trash2,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch, formatArabicTripTime, formatEGP, normalizeTimeInputValue } from '../../lib/api';
import { useEscapeKey } from '../../lib/useEscapeKey';
import { formatBusBadgeLabel, groupBySchoolSortedByBus } from '../../lib/bus-sorting';
import { ContactPhoneInput } from '../ContactPhoneInput';
import type { FleetVehicle, RouteItem, SchoolItem } from '../../types';

type SubTabId = 'schools' | 'vehicles' | 'routes';

export const SchoolsVehiclesModule: React.FC = () => {
  const { dbUser } = useAuth();
  const perms = dbUser?.permissions || [];
  const isSuperAdmin = dbUser?.roleSlug === 'super_admin' || perms.includes('*');
  const can = (perm: string) => isSuperAdmin || perms.includes('*') || perms.includes(perm);

  const canSchoolsWrite = can('schools:write');
  const canSchoolsRead = can('schools:read') || canSchoolsWrite;
  const canVehiclesWrite = can('vehicles:write');
  const canVehiclesRead = can('vehicles:read') || canVehiclesWrite;
  const canRoutesWrite = can('routes:write');
  const canFinanceRead = can('finance:read') || can('finance:write');
  const restrictedSchoolIds = dbUser?.assignedSchoolIds || [];
  const restrictedSchoolCount = restrictedSchoolIds.length;
  const isSingleSchoolRestricted = !isSuperAdmin && restrictedSchoolCount === 1;

  const allowedSubTabs: Array<{ id: SubTabId; label: string; icon: typeof Building2 }> = [
    ...(canSchoolsRead ? [{ id: 'schools' as const, label: 'المدارس والعقود', icon: Building2 }] : []),
    ...(canVehiclesRead ? [{ id: 'vehicles' as const, label: 'المركبات والباصات', icon: Bus }] : []),
    ...(canSchoolsRead || canRoutesWrite
      ? [{ id: 'routes' as const, label: 'خطوط السير', icon: Route }]
      : []),
  ];

  const [tab, setTab] = useState<SubTabId>(() => allowedSubTabs[0]?.id || 'schools');
  const [tabHistory, setTabHistory] = useState<Array<{ tab: SubTabId; schoolId: number | 'all' }>>([]);
  const [selectedSchoolId, setSelectedSchoolId] = useState<number | 'all'>(() =>
    isSingleSchoolRestricted ? restrictedSchoolIds[0] : 'all'
  );
  const [billingPeriod, setBillingPeriod] = useState<{ month: number; year: number } | null>(null);
  const [schoolsList, setSchoolsList] = useState<SchoolItem[]>([]);
  const [routesList, setRoutesList] = useState<RouteItem[]>([]);
  const [vehiclesList, setVehiclesList] = useState<FleetVehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modals & Editing state
  const [showSchoolModal, setShowSchoolModal] = useState(false);
  const [editingSchoolId, setEditingSchoolId] = useState<number | null>(null);
  const [showVehicleModal, setShowVehicleModal] = useState(false);
  const [editingVehicleId, setEditingVehicleId] = useState<number | null>(null);
  const [showRouteModal, setShowRouteModal] = useState(false);
  const [editingRouteId, setEditingRouteId] = useState<number | null>(null);
  const [showBillingModal, setShowBillingModal] = useState(false);
  const [billingTargetSchool, setBillingTargetSchool] = useState<SchoolItem | null>(null);
  const [billingForm, setBillingForm] = useState({
    cycleType: 'calendar' as 'calendar' | 'shifted',
    startDay: '1',
    endDay: '31',
    activeMonth: '',
    activeYear: '',
    customStartDate: '',
    customEndDate: '',
  });
  const [modalError, setModalError] = useState<string | null>(null);
  const [savingModal, setSavingModal] = useState(false);

  useEscapeKey(
    Boolean(showBillingModal || showRouteModal || showVehicleModal || showSchoolModal),
    () => {
      if (showBillingModal) setShowBillingModal(false);
      else if (showRouteModal) setShowRouteModal(false);
      else if (showVehicleModal) setShowVehicleModal(false);
      else if (showSchoolModal) setShowSchoolModal(false);
    }
  );

  const [schoolForm, setSchoolForm] = useState({
    name: '',
    contactName: '',
    contactPhone: '',
    address: '',
    monthlyContractValue: '',
    contractStartDate: '',
    contractEndDate: '',
    billingCycleType: 'calendar' as 'calendar' | 'shifted',
    billingCycleStartDay: '1',
    billingCycleEndDay: '31',
    notes: '',
  });

  const [vehicleForm, setVehicleForm] = useState({
    busNumber: '',
    registrationNumber: '',
    vehicleType: '',
    operationalStatus: 'active',
    schoolId: '',
  });

  const [routeForm, setRouteForm] = useState({
    name: '',
    schoolName: '',
    pickupArea: '',
    dropoffArea: '',
    pickupTime: '',
    dropoffTime: '',
    estimatedDistanceKm: '',
  });

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sRes, vRes] = await Promise.all([
        canSchoolsRead
          ? apiFetch<{
              schools: SchoolItem[];
              routes: RouteItem[];
              billingPeriod?: { month: number; year: number };
            }>('/api/schools')
          : Promise.resolve({
              schools: [] as SchoolItem[],
              routes: [] as RouteItem[],
              billingPeriod: undefined as { month: number; year: number } | undefined,
            }),
        canVehiclesRead
          ? apiFetch<{ vehicles: FleetVehicle[] }>('/api/vehicles')
          : Promise.resolve({ vehicles: [] as FleetVehicle[] }),
      ]);
      setSchoolsList(sRes.schools);
      setRoutesList(sRes.routes);
      if (sRes.billingPeriod) setBillingPeriod(sRes.billingPeriod);
      setVehiclesList(vRes.vehicles);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل بيانات المدارس والمركبات');
    } finally {
      setLoading(false);
    }
  }, [canSchoolsRead, canVehiclesRead]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (allowedSubTabs.length > 0 && !allowedSubTabs.some((t) => t.id === tab)) {
      setTab(allowedSubTabs[0].id);
    }
  }, [tab, canSchoolsRead, canVehiclesRead, canRoutesWrite]);

  useEffect(() => {
    if (isSingleSchoolRestricted && restrictedSchoolIds[0]) {
      setSelectedSchoolId(restrictedSchoolIds[0]);
    } else if (!isSuperAdmin && schoolsList.length === 1) {
      setSelectedSchoolId(schoolsList[0].id);
    }
  }, [isSingleSchoolRestricted, isSuperAdmin, restrictedSchoolIds, schoolsList]);

  const navigateSubView = (nextTab: SubTabId, nextSchoolId: number | 'all' = selectedSchoolId) => {
    const safeSchoolId =
      isSingleSchoolRestricted && nextSchoolId === 'all' ? restrictedSchoolIds[0] : nextSchoolId;
    if (nextTab === tab && safeSchoolId === selectedSchoolId) return;
    setTabHistory((prev) => [...prev.slice(-14), { tab, schoolId: selectedSchoolId }]);
    setTab(nextTab);
    setSelectedSchoolId(safeSchoolId);
  };

  const goBackSubView = () => {
    setTabHistory((prev) => {
      if (prev.length === 0) {
        if (selectedSchoolId !== 'all' && !isSingleSchoolRestricted) setSelectedSchoolId('all');
        return prev;
      }
      const last = prev[prev.length - 1];
      setTab(last.tab);
      setSelectedSchoolId(
        isSingleSchoolRestricted && last.schoolId === 'all' ? restrictedSchoolIds[0] : last.schoolId
      );
      return prev.slice(0, -1);
    });
  };

  const handleAddSchool = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalError(null);
    setSavingModal(true);
    try {
      const startDay =
        schoolForm.billingCycleType === 'calendar'
          ? 1
          : Math.min(28, Math.max(2, Number(schoolForm.billingCycleStartDay || 13)));
      const endDay =
        schoolForm.billingCycleType === 'calendar'
          ? Math.min(31, Math.max(1, Number(schoolForm.billingCycleEndDay || 31)))
          : Math.min(28, Math.max(1, Number(schoolForm.billingCycleEndDay || Math.max(1, startDay - 1))));
      const payload = {
        ...schoolForm,
        monthlyContractValue: Number(schoolForm.monthlyContractValue || 0),
        billingCycleStartDay: startDay,
        billingCycleEndDay: endDay,
      };
      if (editingSchoolId) {
        await apiFetch(`/api/schools/${editingSchoolId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch('/api/schools', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      setShowSchoolModal(false);
      setEditingSchoolId(null);
      setSchoolForm({
        name: '',
        contactName: '',
        contactPhone: '',
        address: '',
        monthlyContractValue: '',
        contractStartDate: '',
        contractEndDate: '',
        billingCycleType: 'calendar',
        billingCycleStartDay: '1',
        billingCycleEndDay: '31',
        notes: '',
      });
      await loadData();
    } catch (err: unknown) {
      setModalError(err instanceof Error ? err.message : 'تعذر حفظ بيانات المدرسة');
    } finally {
      setSavingModal(false);
    }
  };

  const openBillingPeriodModal = (s: SchoolItem) => {
    setModalError(null);
    setBillingTargetSchool(s);
    const resolvedType = s.billingCycleType === 'shifted' ? 'shifted' : 'calendar';
    const startDayNum =
      resolvedType === 'shifted'
        ? s.billingCycleStartDay && s.billingCycleStartDay > 1
          ? s.billingCycleStartDay
          : 13
        : s.billingCycleStartDay || 1;
    const endDayNum =
      resolvedType === 'shifted'
        ? s.billingCycleEndDay || Math.max(1, startDayNum - 1)
        : s.billingCycleEndDay || 31;
    setBillingForm({
      cycleType: resolvedType,
      startDay: String(startDayNum),
      endDay: String(endDayNum),
      activeMonth: String(s.activePeriod?.month || s.currentBillingRange?.month || billingPeriod?.month || new Date().getMonth() + 1),
      activeYear: String(s.activePeriod?.year || s.currentBillingRange?.year || billingPeriod?.year || new Date().getFullYear()),
      customStartDate: s.customStartDate || '',
      customEndDate: s.customEndDate || '',
    });
    setShowBillingModal(true);
  };

  const handleSaveBillingPeriod = async (e: React.FormEvent, resetCustomOnly = false) => {
    e.preventDefault();
    if (!billingTargetSchool) return;
    setModalError(null);
    setSavingModal(true);
    try {
      await apiFetch(`/api/schools/${billingTargetSchool.id}/billing-period`, {
        method: 'PUT',
        body: JSON.stringify({
          cycleType: billingForm.cycleType,
          startDay: Number(billingForm.startDay),
          endDay: Number(billingForm.endDay),
          activeMonth: Number(billingForm.activeMonth) || undefined,
          activeYear: Number(billingForm.activeYear) || undefined,
          customStartDate: resetCustomOnly ? null : billingForm.customStartDate || null,
          customEndDate: resetCustomOnly ? null : billingForm.customEndDate || null,
        }),
      });
      setShowBillingModal(false);
      setBillingTargetSchool(null);
      await loadData();
    } catch (err: unknown) {
      setModalError(err instanceof Error ? err.message : 'تعذر حفظ إعدادات الفترة الشهرية للمدرسة');
    } finally {
      setSavingModal(false);
    }
  };

  const handleAddVehicle = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalError(null);
    setSavingModal(true);
    try {
      const payload = {
        ...vehicleForm,
        schoolId: vehicleForm.schoolId ? Number(vehicleForm.schoolId) : null,
      };
      if (editingVehicleId) {
        await apiFetch(`/api/vehicles/${editingVehicleId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch('/api/vehicles', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      setShowVehicleModal(false);
      setEditingVehicleId(null);
      setVehicleForm({
        busNumber: '',
        registrationNumber: '',
        vehicleType: '',
        operationalStatus: 'active',
        schoolId: '',
      });
      await loadData();
    } catch (err: unknown) {
      setModalError(err instanceof Error ? err.message : 'تعذر حفظ بيانات المركبة');
    } finally {
      setSavingModal(false);
    }
  };

  const handleAddRoute = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalError(null);
    setSavingModal(true);
    try {
      const payload = {
        ...routeForm,
        schoolName: routeForm.schoolName.trim(),
        estimatedDistanceKm: Number(routeForm.estimatedDistanceKm || 0),
      };
      if (editingRouteId) {
        await apiFetch(`/api/routes/${editingRouteId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch('/api/routes', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      setShowRouteModal(false);
      setEditingRouteId(null);
      setRouteForm({
        name: '',
        schoolName: '',
        pickupArea: '',
        dropoffArea: '',
        pickupTime: '',
        dropoffTime: '',
        estimatedDistanceKm: '',
      });
      await loadData();
    } catch (err: unknown) {
      setModalError(err instanceof Error ? err.message : 'تعذر حفظ خط السير');
    } finally {
      setSavingModal(false);
    }
  };

  const handleDeleteRoute = async (id: number) => {
    try {
      await apiFetch(`/api/routes/${id}`, { method: 'DELETE' });
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر حذف خط السير');
    }
  };

  const openAddSchool = () => {
    setModalError(null);
    setEditingSchoolId(null);
    setSchoolForm({
      name: '',
      contactName: '',
      contactPhone: '',
      address: '',
      monthlyContractValue: '',
      contractStartDate: '',
      contractEndDate: '',
      billingCycleType: 'calendar',
      billingCycleStartDay: '1',
      billingCycleEndDay: '31',
      notes: '',
    });
    setShowSchoolModal(true);
  };

  const openEditSchool = (s: SchoolItem) => {
    setModalError(null);
    setEditingSchoolId(s.id);
    const resolvedType = s.billingCycleType === 'shifted' ? 'shifted' : 'calendar';
    const resolvedStartNum =
      resolvedType === 'shifted'
        ? s.billingCycleStartDay && s.billingCycleStartDay > 1
          ? s.billingCycleStartDay
          : 13
        : s.billingCycleStartDay || 1;
    const resolvedEndNum =
      resolvedType === 'shifted'
        ? s.billingCycleEndDay || Math.max(1, resolvedStartNum - 1)
        : s.billingCycleEndDay || 31;
    setSchoolForm({
      name: s.name,
      contactName: s.contactName || '',
      contactPhone: s.contactPhone || '',
      address: s.address || '',
      monthlyContractValue: String(s.monthlyContractValue || 0),
      contractStartDate: s.contractStartDate || '',
      contractEndDate: s.contractEndDate || '',
      billingCycleType: resolvedType,
      billingCycleStartDay: String(resolvedStartNum),
      billingCycleEndDay: String(resolvedEndNum),
      notes: s.notes || '',
    });
    setShowSchoolModal(true);
  };

  const openAddVehicle = () => {
    setModalError(null);
    setEditingVehicleId(null);
    const defaultSchoolId = isSingleSchoolRestricted
      ? String(restrictedSchoolIds[0])
      : selectedSchoolId !== 'all'
      ? String(selectedSchoolId)
      : !isSuperAdmin && schoolsList.length > 0
      ? String(schoolsList[0].id)
      : '';
    setVehicleForm({
      busNumber: '',
      registrationNumber: '',
      vehicleType: '',
      operationalStatus: 'active',
      schoolId: defaultSchoolId,
    });
    setShowVehicleModal(true);
  };

  const openEditVehicle = (v: FleetVehicle) => {
    setModalError(null);
    setEditingVehicleId(v.id);
    setVehicleForm({
      busNumber: v.busNumber,
      registrationNumber: v.registrationNumber,
      vehicleType: v.vehicleType || '',
      operationalStatus: v.operationalStatus || 'active',
      schoolId: v.schoolId
        ? String(v.schoolId)
        : isSingleSchoolRestricted
        ? String(restrictedSchoolIds[0])
        : '',
    });
    setShowVehicleModal(true);
  };

  const openAddRoute = () => {
    setModalError(null);
    setEditingRouteId(null);
    const defaultSchoolName = isSingleSchoolRestricted
      ? schoolsList.find((s) => s.id === restrictedSchoolIds[0])?.name || schoolsList[0]?.name || ''
      : selectedSchoolId !== 'all'
      ? schoolsList.find((s) => s.id === selectedSchoolId)?.name || ''
      : !isSuperAdmin && schoolsList.length > 0
      ? schoolsList[0].name
      : '';
    setRouteForm({
      name: '',
      schoolName: defaultSchoolName,
      pickupArea: '',
      dropoffArea: '',
      pickupTime: '',
      dropoffTime: '',
      estimatedDistanceKm: '',
    });
    setShowRouteModal(true);
  };

  const openEditRoute = (r: RouteItem) => {
    setModalError(null);
    setEditingRouteId(r.id);
    const linkedSchool = schoolsList.find((s) => s.id === r.schoolId);
    setRouteForm({
      name: r.name,
      schoolName: linkedSchool?.name || '',
      pickupArea: r.pickupArea || '',
      dropoffArea: r.dropoffArea || '',
      pickupTime: normalizeTimeInputValue(r.pickupTime),
      dropoffTime: normalizeTimeInputValue(r.dropoffTime),
      estimatedDistanceKm: r.estimatedDistanceKm ? String(r.estimatedDistanceKm) : '',
    });
    setShowRouteModal(true);
  };

  const selectedSchoolObj =
    selectedSchoolId === 'all'
      ? null
      : schoolsList.find((s) => s.id === selectedSchoolId) || null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#0B1F3A]">
            المدارس والمركبات وخطوط السير
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            عقود المدارس مقسمة حسب كل مدرسة بسائقيها ورواتبهم وأرباحها، وإدارة أسطول المركبات
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {!isSuperAdmin && restrictedSchoolCount > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] font-semibold text-amber-900">
              نطاق صلاحيتك: {restrictedSchoolCount} مدرسة محددة
            </div>
          )}
          {(tabHistory.length > 0 || (tab === 'schools' && selectedSchoolObj)) && (
            <button
              type="button"
              onClick={goBackSubView}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-3.5 py-2 text-xs font-bold text-[#0B1F3A] cursor-pointer"
            >
              <ArrowRight className="w-3.5 h-3.5 text-[#C89B3C]" />
              رجوع للقائمة السابقة
            </button>
          )}
          {tab === 'schools' && canSchoolsWrite && (
            <button
              onClick={openAddSchool}
              className="flex items-center gap-2 rounded-lg bg-[#0B1F3A] px-4 py-2 text-xs font-semibold text-white hover:bg-[#13325c] cursor-pointer"
            >
              <Plus className="w-4 h-4 text-[#C89B3C]" />
              إضافة مدرسة
            </button>
          )}
          {tab === 'vehicles' && canVehiclesWrite && (
            <button
              onClick={openAddVehicle}
              className="flex items-center gap-2 rounded-lg bg-[#0B1F3A] px-4 py-2 text-xs font-semibold text-white hover:bg-[#13325c] cursor-pointer"
            >
              <Plus className="w-4 h-4 text-[#C89B3C]" />
              إضافة مركبة
            </button>
          )}
          {tab === 'routes' && canRoutesWrite && (
            <button
              onClick={openAddRoute}
              className="flex items-center gap-2 rounded-lg bg-[#0B1F3A] px-4 py-2 text-xs font-semibold text-white hover:bg-[#13325c] cursor-pointer"
            >
              <Plus className="w-4 h-4 text-[#C89B3C]" />
              إضافة خط سير
            </button>
          )}
        </div>
      </div>

      {/* Sub-navigation tabs */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-xl w-fit">
        {allowedSubTabs.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() =>
                navigateSubView(
                  item.id,
                  item.id === 'schools'
                    ? selectedSchoolId
                    : isSingleSchoolRestricted
                    ? restrictedSchoolIds[0]
                    : 'all'
                )
              }
              className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
                tab === item.id
                  ? 'bg-white text-[#0B1F3A] shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Icon className="w-4 h-4" />
              {item.label}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-800">
          {error}
        </div>
      )}

      {loading ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-xs text-slate-400">
          جاري التحميل...
        </div>
      ) : tab === 'schools' ? (
        <div className="space-y-5">
          {/* School Selector Bar (Isolate per school or view all) */}
          <div className="bg-white border border-slate-200 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {(isSuperAdmin || (restrictedSchoolCount !== 1 && schoolsList.length > 1)) && (
                <button
                  type="button"
                  onClick={() => navigateSubView('schools', 'all')}
                  className={`px-3.5 py-2 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                    selectedSchoolId === 'all'
                      ? 'bg-[#0B1F3A] text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  كل المدارس ({schoolsList.length})
                </button>
              )}
              {schoolsList.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => navigateSubView('schools', s.id)}
                  className={`px-3.5 py-2 rounded-lg text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${
                    selectedSchoolId === s.id
                      ? 'bg-[#0B1F3A] text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  <span>{s.name}</span>
                  <span
                    className={`font-mono text-[11px] tabular-nums ${
                      selectedSchoolId === s.id ? 'text-[#C89B3C]' : 'text-slate-500'
                    }`}
                  >
                    ({s.driverCount ?? 0} سائق)
                  </span>
                </button>
              ))}
            </div>
            {billingPeriod && (
              <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                الفترة المالية: {billingPeriod.month}/{billingPeriod.year}
              </span>
            )}
          </div>

          {selectedSchoolObj ? (
            /* ISOLATED SINGLE-SCHOOL CONTRACT, DRIVERS, SALARIES & PROFIT VIEW */
            <div className="space-y-5">
              {/* Isolated School Contract Header & P&L KPIs */}
              <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Building2 className="w-5 h-5 text-[#C89B3C]" />
                      <h2 className="font-display text-xl font-bold text-[#0B1F3A]">
                        {selectedSchoolObj.name}
                      </h2>
                      <span
                        className={`text-[11px] font-bold px-2 py-0.5 rounded-md ${
                          selectedSchoolObj.isActive
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {selectedSchoolObj.isActive ? 'عقد ساري' : 'غير نشط'}
                      </span>
                      {selectedSchoolObj.currentBillingRange && (
                        <span
                          className={`text-[11px] font-bold px-2.5 py-0.5 rounded-md ${
                            selectedSchoolObj.currentBillingRange.cycleType === 'shifted'
                              ? 'bg-amber-50 text-amber-800 border border-amber-200'
                              : 'bg-slate-100 text-slate-700 border border-slate-200'
                          }`}
                        >
                          {selectedSchoolObj.currentBillingRange.labelAr}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 mt-1.5 flex flex-wrap items-center gap-3">
                      {selectedSchoolObj.contactName && <span>المسؤول: {selectedSchoolObj.contactName}</span>}
                      {selectedSchoolObj.contactPhone && (
                        <span className="font-mono" dir="ltr">
                          {selectedSchoolObj.contactPhone}
                        </span>
                      )}
                      {selectedSchoolObj.address && <span>{selectedSchoolObj.address}</span>}
                    </div>
                  </div>

                  {canSchoolsWrite && (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => openBillingPeriodModal(selectedSchoolObj)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[#C89B3C] px-3 py-2 text-xs font-bold text-[#0B1F3A] hover:bg-[#d8ac4e] cursor-pointer"
                      >
                        <Calendar className="w-3.5 h-3.5" />
                        تخصيص الفترة الشهرية
                      </button>
                      <button
                        type="button"
                        onClick={() => openEditSchool(selectedSchoolObj)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-[#0B1F3A] hover:bg-slate-50 cursor-pointer"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        تعديل العقد
                      </button>
                    </div>
                  )}
                </div>

                {canFinanceRead && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-4 border-t border-slate-100">
                    <div className="rounded-xl bg-slate-50 border border-slate-200/70 p-3.5">
                      <div className="text-[11px] text-slate-500">قيمة العقد الشهري</div>
                      <div className="font-mono text-lg font-bold text-[#0B1F3A] mt-1 tabular-nums">
                        {formatEGP(selectedSchoolObj.monthlyContractValue)}
                      </div>
                    </div>
                    <div className="rounded-xl bg-slate-50 border border-slate-200/70 p-3.5">
                      <div className="text-[11px] text-slate-500">
                        رواتب سائقين المدرسة ({selectedSchoolObj.driverCount ?? 0})
                      </div>
                      <div className="font-mono text-lg font-bold text-red-700 mt-1 tabular-nums">
                        {formatEGP(selectedSchoolObj.totalDriverSalaries ?? 0)}
                      </div>
                    </div>
                    <div className="rounded-xl bg-emerald-50/70 border border-emerald-200 p-3.5">
                      <div className="text-[11px] text-emerald-800 font-semibold">
                        صافي ربح المدرسة الشهري
                      </div>
                      <div
                        className={`font-mono text-lg font-bold mt-1 tabular-nums ${
                          (selectedSchoolObj.estimatedProfit ?? 0) >= 0
                            ? 'text-emerald-700'
                            : 'text-red-700'
                        }`}
                      >
                        {formatEGP(selectedSchoolObj.estimatedProfit ?? 0)}
                      </div>
                    </div>
                  </div>
                )}

                {(selectedSchoolObj.contractStartDate || selectedSchoolObj.contractEndDate) && (
                  <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                    مدة التعاقد: {selectedSchoolObj.contractStartDate || '—'} إلى{' '}
                    {selectedSchoolObj.contractEndDate || '—'}
                  </div>
                )}
              </div>

              {/* Isolated School Drivers & Salaries Table */}
              <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-[#C89B3C]" />
                    <h3 className="font-display text-sm font-bold text-[#0B1F3A]">
                      سائقو {selectedSchoolObj.name} ({(selectedSchoolObj.drivers || []).length})
                    </h3>
                  </div>
                  {canFinanceRead && (
                    <div className="text-xs font-mono text-slate-600 tabular-nums">
                      صافي مستحقات السائقين بعد السلف والتسويات:{' '}
                      <strong className="text-[#0B1F3A]">
                        {formatEGP(selectedSchoolObj.totalNetDriverSalaries ?? 0)}
                      </strong>
                    </div>
                  )}
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-right text-xs">
                    <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                      <tr>
                        <th className="py-3 px-4 font-semibold">الكود</th>
                        <th className="py-3 px-4 font-semibold">السائق والموبايل</th>
                        <th className="py-3 px-4 font-semibold">الباص وخط السير</th>
                        {canFinanceRead && (
                          <>
                            <th className="py-3 px-4 font-semibold">الراتب الأساسي</th>
                            <th className="py-3 px-4 font-semibold">السلف / التغطيات</th>
                            <th className="py-3 px-4 font-semibold">مكافآت / خصومات</th>
                            <th className="py-3 px-4 font-semibold">صافي المستحق</th>
                          </>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(selectedSchoolObj.drivers || []).length === 0 ? (
                        <tr>
                          <td colSpan={canFinanceRead ? 7 : 3} className="py-8 text-center text-slate-400">
                            لا يوجد سائقون معينون لهذه المدرسة حالياً
                          </td>
                        </tr>
                      ) : (
                        (selectedSchoolObj.drivers || []).map((drv) => (
                          <tr key={drv.id} className="hover:bg-slate-50/70">
                            <td className="py-3 px-4 font-mono font-bold text-[#0B1F3A] tabular-nums">
                              {drv.driverCode}
                            </td>
                            <td className="py-3 px-4">
                              <div className="font-bold text-slate-900">{drv.fullName}</div>
                              <div className="font-mono text-slate-500 tabular-nums" dir="ltr">
                                {drv.phone}
                              </div>
                            </td>
                            <td className="py-3 px-4">
                              <div className="font-mono font-semibold text-slate-800">
                                {formatBusBadgeLabel(drv.busNumber, drv.vehicleId)}
                              </div>
                              <div className="text-slate-500">{drv.routeName || '—'}</div>
                            </td>
                            {canFinanceRead && (
                              <>
                                <td className="py-3 px-4 font-mono font-semibold text-slate-900 tabular-nums">
                                  {formatEGP(drv.baseSalary)}
                                </td>
                                <td className="py-3 px-4 font-mono tabular-nums">
                                  <div className="text-red-700">
                                    {formatEGP(drv.totalAdvances + drv.totalCoverageDeductions)}
                                  </div>
                                  {Number(drv.totalCoverageAdditions || 0) > 0 && (
                                    <div className="text-[11px] font-semibold text-emerald-700">
                                      +{formatEGP(drv.totalCoverageAdditions || 0)} بديل
                                    </div>
                                  )}
                                </td>
                                <td className="py-3 px-4 font-mono tabular-nums">
                                  <span className="text-emerald-700">+{formatEGP(drv.bonuses)}</span>
                                  {' / '}
                                  <span className="text-red-700">−{formatEGP(drv.otherDeductions)}</span>
                                </td>
                                <td className="py-3 px-4 font-mono font-bold text-[#0B1F3A] tabular-nums">
                                  {formatEGP(drv.netSalary)}
                                </td>
                              </>
                            )}
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Isolated School Vehicles */}
              <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-2">
                  <Bus className="w-4 h-4 text-[#C89B3C]" />
                  <h3 className="font-display text-sm font-bold text-[#0B1F3A]">
                    المركبات المخصصة لـ {selectedSchoolObj.name} ({(selectedSchoolObj.vehicles || []).length})
                  </h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-right text-xs">
                    <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                      <tr>
                        <th className="py-3 px-4 font-semibold">رقم الباص</th>
                        <th className="py-3 px-4 font-semibold">اللوحة والنوع</th>
                        <th className="py-3 px-4 font-semibold">السائق</th>
                        <th className="py-3 px-4 font-semibold">حالة التشغيل و GPS</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(selectedSchoolObj.vehicles || []).length === 0 ? (
                        <tr>
                          <td colSpan={4} className="py-8 text-center text-slate-400">
                            لا توجد مركبات مربوطة بهذه المدرسة حالياً
                          </td>
                        </tr>
                      ) : (
                        (selectedSchoolObj.vehicles || []).map((v) => (
                          <tr key={v.id} className="hover:bg-slate-50/70">
                            <td className="py-3 px-4 font-mono font-bold text-[#0B1F3A]">
                              {v.busNumber}
                            </td>
                            <td className="py-3 px-4">
                              <div className="font-semibold text-slate-800">{v.registrationNumber}</div>
                              <div className="text-slate-500">{v.vehicleType || '—'}</div>
                            </td>
                            <td className="py-3 px-4 text-slate-700">
                              <div className="font-semibold text-slate-800">{v.driverName}</div>
                              <div className="text-slate-500 font-mono">{v.driverPhone}</div>
                            </td>
                            <td className="py-3 px-4">
                              <div className="font-semibold text-slate-800">
                                {v.operationalStatus === 'active'
                                  ? 'بالخدمة'
                                  : v.operationalStatus === 'maintenance'
                                  ? 'صيانة'
                                  : 'متوقفة'}
                              </div>
                              <div
                                className={`text-[11px] font-medium ${
                                  v.isOnline ? 'text-emerald-700' : 'text-amber-700'
                                }`}
                              >
                                {v.isOnline ? 'GPS متصل مباشر' : 'GPS غير متصل'}
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : (
            /* ALL SCHOOLS CONTRACTS OVERVIEW — EACH CARD ISOLATED WITH DRIVERS, SALARIES & NET PROFIT */
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {schoolsList.map((s) => (
                <div key={s.id} className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-display text-base font-bold text-[#0B1F3A]">{s.name}</h3>
                        {s.currentBillingRange && (
                          <span
                            className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${
                              s.currentBillingRange.cycleType === 'shifted'
                                ? 'bg-amber-50 text-amber-800 border border-amber-200'
                                : 'bg-slate-100 text-slate-700 border border-slate-200'
                            }`}
                          >
                            {s.currentBillingRange.cycleType === 'shifted'
                              ? `دورة مرحّلة (${s.currentBillingRange.shortLabelAr})`
                              : `دورة ميلادية (${s.currentBillingRange.shortLabelAr})`}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-500 mt-1">
                        {s.contactName} · <span className="font-mono">{s.contactPhone}</span>
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">{s.address}</div>
                    </div>
                    {canFinanceRead && (
                      <div className="text-left shrink-0">
                        <div className="text-[11px] text-slate-500">قيمة العقد الشهري</div>
                        <div className="font-mono text-base font-bold text-[#0B1F3A] tabular-nums">
                          {formatEGP(s.monthlyContractValue)}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className={`grid ${canFinanceRead ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-1'} gap-3 border-t border-slate-100 pt-3 text-xs`}>
                    <div>
                      <div className="text-slate-500">السائقون / الباصات</div>
                      <div className="font-mono font-semibold text-slate-900 mt-0.5 tabular-nums">
                        {s.driverCount ?? 0} سائق · {s.vehicleCount ?? 0} باص
                      </div>
                    </div>
                    {canFinanceRead && (
                      <>
                        <div>
                          <div className="text-slate-500">رواتب السائقين</div>
                          <div className="font-mono font-semibold text-red-700 mt-0.5 tabular-nums">
                            {formatEGP(s.totalDriverSalaries ?? 0)}
                          </div>
                        </div>
                        <div>
                          <div className="text-slate-500">صافي ربح المدرسة</div>
                          <div
                            className={`font-mono font-bold mt-0.5 tabular-nums ${
                              (s.estimatedProfit ?? 0) >= 0 ? 'text-emerald-700' : 'text-red-700'
                            }`}
                          >
                            {formatEGP(s.estimatedProfit ?? 0)}
                          </div>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Quick preview of this school's drivers & salaries */}
                  {(s.drivers || []).length > 0 && (
                    <div className="rounded-lg bg-slate-50 border border-slate-100 p-3 space-y-1.5">
                      <div className="text-[11px] font-bold text-slate-600 flex items-center gap-1.5">
                        <Wallet className="w-3.5 h-3.5 text-[#C89B3C]" />
                        <span>{canFinanceRead ? 'سائقو المدرسة ورواتبهم:' : 'سائقو المدرسة:'}</span>
                      </div>
                      <div className="divide-y divide-slate-200/60 text-[11px]">
                        {(s.drivers || []).slice(0, 4).map((drv) => (
                          <div key={drv.id} className="py-1 flex items-center justify-between gap-2">
                            <span className="font-semibold text-slate-800 truncate">
                              {drv.fullName} ({formatBusBadgeLabel(drv.busNumber, drv.vehicleId)})
                            </span>
                            {canFinanceRead && (
                              <span className="font-mono font-bold text-[#0B1F3A] tabular-nums shrink-0">
                                أساسي {formatEGP(drv.baseSalary)} · صافي {formatEGP(drv.netSalary)}
                              </span>
                            )}
                          </div>
                        ))}
                        {(s.drivers || []).length > 4 && (
                          <div className="pt-1 text-[10px] text-slate-500">
                            + {(s.drivers || []).length - 4} سائقين آخرين...
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="text-[11px] text-slate-400 border-t border-slate-100 pt-2.5 flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono tabular-nums">
                      العقد: {s.contractStartDate || '—'} إلى {s.contractEndDate || '—'}
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => navigateSubView('schools', s.id)}
                        className="inline-flex items-center gap-1 rounded-md bg-[#0B1F3A] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#13325c] cursor-pointer"
                      >
                        <Users className="w-3 h-3 text-[#C89B3C]" />
                        {canFinanceRead ? 'عرض العقد والسائقين والربح' : 'عرض السائقين والمركبات'}
                      </button>
                      {canSchoolsWrite && (
                        <>
                          <button
                            type="button"
                            onClick={() => openBillingPeriodModal(s)}
                            className="inline-flex items-center gap-1 rounded-md bg-amber-50 border border-amber-200 px-2 py-1 text-[11px] font-bold text-[#0B1F3A] hover:bg-amber-100 cursor-pointer"
                          >
                            <Calendar className="w-3 h-3 text-[#C89B3C]" />
                            بداية ونهاية الشهر
                          </button>
                          <button
                            onClick={() => openEditSchool(s)}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold text-[#0B1F3A] hover:bg-slate-50 cursor-pointer"
                          >
                            <Edit3 className="w-3 h-3" />
                            تعديل
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : tab === 'vehicles' ? (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4 font-semibold">رقم الباص</th>
                  <th className="py-3 px-4 font-semibold">رقم اللوحة والنوع</th>
                  <th className="py-3 px-4 font-semibold">المدرسة والسائق</th>
                  <th className="py-3 px-4 font-semibold">حالة التشغيل و GPS</th>
                  {canVehiclesWrite && <th className="py-3 px-4 font-semibold">تعديل</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {groupBySchoolSortedByBus(vehiclesList).map((grp) => (
                  <React.Fragment key={grp.schoolKey}>
                    <tr className="bg-slate-100/90 border-y border-slate-200">
                      <td colSpan={canVehiclesWrite ? 5 : 4} className="py-2 px-4 font-bold text-[#0B1F3A] text-xs">
                        <span>{grp.schoolName}</span>
                        <span className="mr-2 font-mono text-[11px] font-semibold text-slate-500">
                          ({grp.items.length} باص)
                        </span>
                      </td>
                    </tr>
                    {grp.items.map((v) => (
                      <tr key={v.id} className="hover:bg-slate-50/70">
                        <td className="py-3.5 px-4 font-mono font-bold text-[#0B1F3A]">
                          باص {v.busNumber}
                        </td>
                        <td className="py-3.5 px-4">
                          <div className="font-semibold text-slate-900">{v.registrationNumber}</div>
                          <div className="text-slate-500">{v.vehicleType}</div>
                        </td>
                        <td className="py-3.5 px-4">
                          <div className="text-slate-800">{v.schoolName}</div>
                          <div className="text-slate-500">
                            {v.driverName} ({v.driverCode})
                          </div>
                        </td>
                        <td className="py-3.5 px-4">
                          <div className="font-semibold text-slate-800">
                            {v.operationalStatus === 'active'
                              ? 'بالخدمة'
                              : v.operationalStatus === 'maintenance'
                              ? 'صيانة'
                              : 'متوقفة'}
                          </div>
                          <div
                            className={`text-[11px] font-medium ${
                              v.isOnline ? 'text-emerald-700' : 'text-amber-700'
                            }`}
                          >
                            {v.isOnline ? 'GPS متصل مباشر' : 'GPS غير متصل'}
                          </div>
                        </td>
                        {canVehiclesWrite && (
                          <td className="py-3.5 px-4">
                            <button
                              onClick={() => openEditVehicle(v)}
                              className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-[#0B1F3A] hover:bg-slate-100 cursor-pointer"
                            >
                              <Edit3 className="w-3 h-3" />
                              تعديل
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-3">
            <span className="font-bold text-xs text-[#0B1F3A]">
              خطوط السير المسجلة ({routesList.length})
            </span>
            {canRoutesWrite && (
              <button
                onClick={openAddRoute}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#0B1F3A] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#13325c] cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5 text-[#C89B3C]" />
                إضافة خط سير جديد
              </button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4 font-semibold">اسم الخط والباص</th>
                  <th className="py-3 px-4 font-semibold">المدرسة</th>
                  <th className="py-3 px-4 font-semibold">نقطة بداية الرحلة</th>
                  <th className="py-3 px-4 font-semibold">بداية ونهاية الرحلة بالوقت</th>
                  <th className="py-3 px-4 font-semibold">المسافة التقديرية</th>
                  {canRoutesWrite && <th className="py-3 px-4 font-semibold">الإجراءات</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {routesList.map((r) => {
                  const school = schoolsList.find((s) => s.id === r.schoolId);
                  return (
                    <tr key={r.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4">
                        <div className="font-semibold text-[#0B1F3A] flex items-center gap-2 flex-wrap">
                          <span>{r.name}</span>
                          {r.busNumber && (
                            <span className="px-1.5 py-0.5 rounded bg-[#0B1F3A]/10 text-[#0B1F3A] font-mono text-[11px] font-bold">
                              باص {r.busNumber}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-slate-700">{school?.name || '—'}</td>
                      <td className="py-3 px-4 text-slate-600">
                        <div>{r.pickupArea || '—'}</div>
                        {r.dropoffArea && (
                          <div className="text-[11px] text-slate-400 mt-0.5">
                            نهاية: {r.dropoffArea}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-slate-700">
                        <div>بداية: {formatArabicTripTime(r.pickupTime)}</div>
                        <div className="text-slate-500 mt-0.5">
                          نهاية: {formatArabicTripTime(r.dropoffTime)}
                        </div>
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-slate-700">
                        {r.estimatedDistanceKm} كم
                      </td>
                      {canRoutesWrite && (
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => openEditRoute(r)}
                              className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-[#0B1F3A] hover:bg-slate-100 cursor-pointer"
                            >
                              <Edit3 className="w-3 h-3" />
                              تعديل
                            </button>
                            <button
                              onClick={() => handleDeleteRoute(r.id)}
                              className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100 cursor-pointer"
                            >
                              <Trash2 className="w-3 h-3" />
                              حذف
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add/Edit School Modal */}
      {showSchoolModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-lg bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
            <div className="px-6 py-4 bg-[#0B1F3A] text-white flex items-center justify-between">
              <h3 className="font-bold text-sm">
                {editingSchoolId ? 'تعديل بيانات المدرسة' : 'إضافة مدرسة وعقد شهري جديد'}
              </h3>
              <button onClick={() => setShowSchoolModal(false)} className="cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleAddSchool} className="p-6 space-y-3 text-xs">
              {modalError && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-red-800">
                  {modalError}
                </div>
              )}
              <input
                required
                placeholder="اسم المدرسة *"
                value={schoolForm.name}
                onChange={(e) => {
                  const nextName = e.target.value;
                  setSchoolForm((prev) => {
                    const isHilal =
                      !editingSchoolId &&
                      (nextName.includes('هلالي') || nextName.toLowerCase().includes('hilal'));
                    return {
                      ...prev,
                      name: nextName,
                      ...(isHilal && prev.billingCycleType === 'calendar'
                        ? {
                            billingCycleType: 'shifted' as const,
                            billingCycleStartDay: '13',
                            billingCycleEndDay: '12',
                          }
                        : {}),
                    };
                  });
                }}
                className="w-full rounded-lg border border-slate-200 px-3 py-2"
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  placeholder="اسم مسؤول التعاقد"
                  value={schoolForm.contactName}
                  onChange={(e) => setSchoolForm({ ...schoolForm, contactName: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
                <ContactPhoneInput
                  placeholder="هاتف المدرسة"
                  value={schoolForm.contactPhone}
                  onChange={(contactPhone) =>
                    setSchoolForm((prev) => ({ ...prev, contactPhone }))
                  }
                  onPickContact={({ phone, name }) =>
                    setSchoolForm((prev) => ({
                      ...prev,
                      contactPhone: phone,
                      contactName: prev.contactName.trim()
                        ? prev.contactName
                        : name || prev.contactName,
                    }))
                  }
                />
              </div>
              <input
                placeholder="العنوان"
                value={schoolForm.address}
                onChange={(e) => setSchoolForm({ ...schoolForm, address: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2"
              />
              <input
                type="number"
                required
                placeholder="قيمة العقد الشهري بالجنيه *"
                value={schoolForm.monthlyContractValue}
                onChange={(e) =>
                  setSchoolForm({ ...schoolForm, monthlyContractValue: e.target.value })
                }
                className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
              />
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2.5">
                <div className="font-bold text-[#0B1F3A]">نظام إغلاق الشهر المالي للمدرسة</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setSchoolForm((prev) => ({
                        ...prev,
                        billingCycleType: 'calendar',
                        billingCycleStartDay: '1',
                        billingCycleEndDay: '31',
                      }))
                    }
                    className={`rounded-lg border p-2.5 text-right transition-colors cursor-pointer ${
                      schoolForm.billingCycleType === 'calendar'
                        ? 'border-[#0B1F3A] bg-[#0B1F3A] text-white'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <div className="font-bold">دورة ميلادية عادية</div>
                    <div
                      className={`text-[10px] mt-0.5 ${
                        schoolForm.billingCycleType === 'calendar' ? 'text-slate-300' : 'text-slate-500'
                      }`}
                    >
                      من يوم 1 إلى آخر الشهر (مثل: إشراقة الغد)
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setSchoolForm((prev) => ({
                        ...prev,
                        billingCycleType: 'shifted',
                        billingCycleStartDay:
                          Number(prev.billingCycleStartDay) > 1 ? prev.billingCycleStartDay : '13',
                        billingCycleEndDay:
                          Number(prev.billingCycleEndDay) >= 1 && Number(prev.billingCycleEndDay) <= 28
                            ? prev.billingCycleEndDay
                            : '12',
                      }))
                    }
                    className={`rounded-lg border p-2.5 text-right transition-colors cursor-pointer ${
                      schoolForm.billingCycleType === 'shifted'
                        ? 'border-[#0B1F3A] bg-[#0B1F3A] text-white'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <div className="font-bold">دورة مرحّلة (نصف شهرية)</div>
                    <div
                      className={`text-[10px] mt-0.5 ${
                        schoolForm.billingCycleType === 'shifted' ? 'text-[#ebd089]' : 'text-slate-500'
                      }`}
                    >
                      من يوم 13 الشهر الحالي إلى 12 الشهر التالي · 11:59 م (مثل: الهلالية)
                    </div>
                  </button>
                </div>
                {schoolForm.billingCycleType === 'shifted' && (
                  <div className="grid grid-cols-2 gap-3 pt-1">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        يوم البداية (الشهر الحالي)
                      </label>
                      <input
                        type="number"
                        min={2}
                        max={28}
                        value={schoolForm.billingCycleStartDay}
                        onChange={(e) => {
                          const sVal = Number(e.target.value) || 13;
                          setSchoolForm((prev) => ({
                            ...prev,
                            billingCycleStartDay: e.target.value,
                            billingCycleEndDay: String(Math.max(1, sVal - 1)),
                          }));
                        }}
                        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-center font-mono font-bold"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        يوم النهاية (الشهر التالي)
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={28}
                        value={schoolForm.billingCycleEndDay}
                        onChange={(e) =>
                          setSchoolForm((prev) => ({
                            ...prev,
                            billingCycleEndDay: e.target.value,
                          }))
                        }
                        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-center font-mono font-bold"
                      />
                    </div>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="date"
                  value={schoolForm.contractStartDate}
                  onChange={(e) =>
                    setSchoolForm({ ...schoolForm, contractStartDate: e.target.value })
                  }
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                />
                <input
                  type="date"
                  value={schoolForm.contractEndDate}
                  onChange={(e) =>
                    setSchoolForm({ ...schoolForm, contractEndDate: e.target.value })
                  }
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                />
              </div>
              <button
                type="submit"
                disabled={savingModal}
                className="w-full rounded-lg bg-[#0B1F3A] py-2.5 font-semibold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
              >
                حفظ المدرسة
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Custom Per-School Billing Period Modal */}
      {showBillingModal && billingTargetSchool && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-lg bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
            <div className="px-6 py-4 bg-[#0B1F3A] text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-[#C89B3C]" />
                <h3 className="font-bold text-sm">
                  التحكم في بداية ونهاية الفترة الشهرية — {billingTargetSchool.name}
                </h3>
              </div>
              <button onClick={() => setShowBillingModal(false)} className="cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={(e) => handleSaveBillingPeriod(e, false)} className="p-6 space-y-4 text-xs">
              {modalError && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-red-800">
                  {modalError}
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setBillingForm((prev) => ({
                      ...prev,
                      cycleType: 'calendar',
                      startDay: '1',
                      endDay: '31',
                    }))
                  }
                  className={`rounded-lg border p-2.5 text-right cursor-pointer ${
                    billingForm.cycleType === 'calendar'
                      ? 'border-[#0B1F3A] bg-[#0B1F3A] text-white'
                      : 'border-slate-200 bg-slate-50 text-slate-700'
                  }`}
                >
                  <div className="font-bold">دورة ميلادية عادية</div>
                  <div className="text-[10px] opacity-80 mt-0.5">من 1 إلى آخر الشهر</div>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setBillingForm((prev) => ({
                      ...prev,
                      cycleType: 'shifted',
                      startDay: Number(prev.startDay) > 1 ? prev.startDay : '13',
                      endDay:
                        Number(prev.endDay) >= 1 && Number(prev.endDay) <= 28
                          ? prev.endDay
                          : '12',
                    }))
                  }
                  className={`rounded-lg border p-2.5 text-right cursor-pointer ${
                    billingForm.cycleType === 'shifted'
                      ? 'border-[#0B1F3A] bg-[#0B1F3A] text-white'
                      : 'border-slate-200 bg-slate-50 text-slate-700'
                  }`}
                >
                  <div className="font-bold">دورة مرحّلة (نصف شهرية)</div>
                  <div className="text-[10px] opacity-80 mt-0.5">من يوم 13 الحالي إلى 12 التالي</div>
                </button>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">يوم البداية</label>
                  <input
                    type="number"
                    min={1}
                    max={28}
                    required
                    value={billingForm.startDay}
                    onChange={(e) => setBillingForm({ ...billingForm, startDay: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-center font-bold"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">يوم النهاية</label>
                  <input
                    type="number"
                    min={1}
                    max={31}
                    required
                    value={billingForm.endDay}
                    onChange={(e) => setBillingForm({ ...billingForm, endDay: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-center font-bold"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">الشهر النشط</label>
                  <input
                    type="number"
                    min={1}
                    max={12}
                    required
                    value={billingForm.activeMonth}
                    onChange={(e) => setBillingForm({ ...billingForm, activeMonth: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-center font-bold"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">السنة</label>
                  <input
                    type="number"
                    min={2020}
                    max={2099}
                    required
                    value={billingForm.activeYear}
                    onChange={(e) => setBillingForm({ ...billingForm, activeYear: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-center font-bold"
                  />
                </div>
              </div>

              <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3.5 space-y-2.5">
                <div className="font-bold text-[#0B1F3A]">
                  تاريخ بداية ونهاية مخصص لهذه الفترة فقط (اختياري)
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      تاريخ البداية المخصص
                    </label>
                    <input
                      type="date"
                      value={billingForm.customStartDate}
                      onChange={(e) =>
                        setBillingForm({ ...billingForm, customStartDate: e.target.value })
                      }
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      تاريخ النهاية المخصص
                    </label>
                    <input
                      type="date"
                      value={billingForm.customEndDate}
                      onChange={(e) =>
                        setBillingForm({ ...billingForm, customEndDate: e.target.value })
                      }
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono"
                    />
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                {(billingForm.customStartDate || billingForm.customEndDate) && (
                  <button
                    type="button"
                    disabled={savingModal}
                    onClick={(e) => handleSaveBillingPeriod(e, true)}
                    className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                  >
                    إلغاء التاريخ المخصص
                  </button>
                )}
                <button
                  type="submit"
                  disabled={savingModal}
                  className="flex-1 rounded-lg bg-[#0B1F3A] py-2.5 font-bold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
                >
                  {savingModal ? 'جاري الحفظ...' : 'حفظ الفترة الشهرية للمدرسة'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add/Edit Vehicle Modal */}
      {showVehicleModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-lg bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
            <div className="px-6 py-4 bg-[#0B1F3A] text-white flex items-center justify-between">
              <h3 className="font-bold text-sm">
                {editingVehicleId ? 'تعديل بيانات المركبة' : 'إضافة مركبة / باص جديد'}
              </h3>
              <button onClick={() => setShowVehicleModal(false)} className="cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleAddVehicle} className="p-6 space-y-3 text-xs">
              {modalError && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-red-800">
                  {modalError}
                </div>
              )}
              {schoolsList.length > 0 && (
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    المدرسة التابع لها المركبة {!isSuperAdmin && restrictedSchoolCount > 0 ? '*' : ''}
                  </label>
                  <select
                    required={!isSuperAdmin && restrictedSchoolCount > 0}
                    disabled={isSingleSchoolRestricted}
                    value={vehicleForm.schoolId}
                    onChange={(e) => setVehicleForm({ ...vehicleForm, schoolId: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-semibold text-[#0B1F3A] disabled:bg-slate-100"
                  >
                    {(isSuperAdmin || restrictedSchoolCount === 0) && (
                      <option value="">غير معينة بمدرسة محددة</option>
                    )}
                    {schoolsList.map((s) => (
                      <option key={s.id} value={String(s.id)}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <label className="text-[11px] font-semibold text-slate-700">رقم الباص *</label>
                    <span className="text-[10px] font-semibold text-[#0B1F3A] bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 truncate max-w-[160px]">
                      {schoolsList.find((s) => String(s.id) === vehicleForm.schoolId)?.name || 'بدون مدرسة'}
                    </span>
                  </div>
                  <input
                    required
                    placeholder="مثال: 2 أو 10"
                    value={vehicleForm.busNumber}
                    onChange={(e) => setVehicleForm({ ...vehicleForm, busNumber: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono font-bold text-[#0B1F3A]"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    رقم اللوحة المعدنية *
                  </label>
                  <input
                    required
                    placeholder="أ ب ج 1234"
                    value={vehicleForm.registrationNumber}
                    onChange={(e) =>
                      setVehicleForm({ ...vehicleForm, registrationNumber: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">نوع المركبة</label>
                <input
                  placeholder="مثال: تويوتا هاي إس / مرسيدس"
                  value={vehicleForm.vehicleType}
                  onChange={(e) => setVehicleForm({ ...vehicleForm, vehicleType: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>

              <button
                type="submit"
                disabled={savingModal}
                className="w-full rounded-lg bg-[#0B1F3A] py-2.5 font-semibold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
              >
                {savingModal ? 'جاري الحفظ...' : 'حفظ المركبة'}
              </button>
            </form>
          </div>
        </div>
      )}



      {/* Add/Edit Route Modal */}
      {showRouteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
            <div className="px-6 py-4 bg-[#0B1F3A] text-white flex items-center justify-between">
              <h3 className="font-bold text-sm">
                {editingRouteId ? 'تعديل خط السير' : 'إضافة خط سير جديد'}
              </h3>
              <button onClick={() => setShowRouteModal(false)} className="cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleAddRoute} className="p-6 space-y-3 text-xs">
              {modalError && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-red-800">
                  {modalError}
                </div>
              )}
              <input
                required
                placeholder="اسم الخط *"
                value={routeForm.name}
                onChange={(e) => setRouteForm({ ...routeForm, name: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2"
              />
              {schoolsList.length > 0 ? (
                <select
                  required={!isSuperAdmin && restrictedSchoolCount > 0}
                  disabled={isSingleSchoolRestricted}
                  value={routeForm.schoolName}
                  onChange={(e) => setRouteForm({ ...routeForm, schoolName: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-semibold text-[#0B1F3A] disabled:bg-slate-100"
                >
                  {(isSuperAdmin || restrictedSchoolCount === 0) && (
                    <option value="">بدون ربط بمدرسة (اختياري)</option>
                  )}
                  {schoolsList.map((s) => (
                    <option key={s.id} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  placeholder="اكتب اسم المدرسة (اختياري)"
                  value={routeForm.schoolName}
                  onChange={(e) => setRouteForm({ ...routeForm, schoolName: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              )}
              <input
                placeholder="نقطة بداية الرحلة (التجمع / الانطلاق)"
                value={routeForm.pickupArea}
                onChange={(e) => setRouteForm({ ...routeForm, pickupArea: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2"
              />
              <input
                placeholder="نقطة نهاية الرحلة (الوصول)"
                value={routeForm.dropoffArea}
                onChange={(e) => setRouteForm({ ...routeForm, dropoffArea: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2"
              />
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">وقت بداية الرحلة</label>
                  <input
                    type="time"
                    value={routeForm.pickupTime}
                    onChange={(e) => setRouteForm({ ...routeForm, pickupTime: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-2.5 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">وقت نهاية الرحلة</label>
                  <input
                    type="time"
                    value={routeForm.dropoffTime}
                    onChange={(e) => setRouteForm({ ...routeForm, dropoffTime: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-2.5 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">المسافة (كم)</label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    value={routeForm.estimatedDistanceKm}
                    onChange={(e) =>
                      setRouteForm({ ...routeForm, estimatedDistanceKm: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-2.5 py-2 font-mono"
                  />
                </div>
              </div>
              <button
                type="submit"
                className="w-full rounded-lg bg-[#0B1F3A] py-2.5 font-semibold text-white hover:bg-[#13325c] cursor-pointer"
              >
                {editingRouteId ? 'حفظ التعديلات' : 'حفظ الخط'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
