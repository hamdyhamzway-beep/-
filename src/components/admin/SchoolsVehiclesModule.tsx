import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  Bus,
  Edit3,
  Plus,
  Route,
  Trash2,
  User,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch, formatArabicTripTime, formatEGP, normalizeTimeInputValue } from '../../lib/api';
import { useEscapeKey } from '../../lib/useEscapeKey';
import { ContactPhoneInput } from '../ContactPhoneInput';
import type { FleetVehicle, RouteItem, SchoolItem, VehicleOwner } from '../../types';

type SubTabId = 'schools' | 'vehicles' | 'owners' | 'routes';

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
  const restrictedSchoolCount = dbUser?.assignedSchoolIds?.length || 0;

  const allowedSubTabs: Array<{ id: SubTabId; label: string; icon: typeof Building2 }> = [
    ...(canSchoolsRead ? [{ id: 'schools' as const, label: 'المدارس والعقود', icon: Building2 }] : []),
    ...(canVehiclesRead ? [{ id: 'vehicles' as const, label: 'المركبات والباصات', icon: Bus }] : []),
    ...(canVehiclesRead || canSchoolsRead
      ? [{ id: 'owners' as const, label: 'ملاك الباصات', icon: User }]
      : []),
    ...(canSchoolsRead || canRoutesWrite
      ? [{ id: 'routes' as const, label: 'خطوط السير', icon: Route }]
      : []),
  ];

  const [tab, setTab] = useState<SubTabId>(() => allowedSubTabs[0]?.id || 'schools');
  const [tabHistory, setTabHistory] = useState<Array<{ tab: SubTabId; schoolId: number | 'all' }>>([]);
  const [selectedSchoolId, setSelectedSchoolId] = useState<number | 'all'>('all');
  const [billingPeriod, setBillingPeriod] = useState<{ month: number; year: number } | null>(null);
  const [schoolsList, setSchoolsList] = useState<SchoolItem[]>([]);
  const [routesList, setRoutesList] = useState<RouteItem[]>([]);
  const [vehiclesList, setVehiclesList] = useState<FleetVehicle[]>([]);
  const [ownersList, setOwnersList] = useState<VehicleOwner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modals & Editing state
  const [showSchoolModal, setShowSchoolModal] = useState(false);
  const [editingSchoolId, setEditingSchoolId] = useState<number | null>(null);
  const [showVehicleModal, setShowVehicleModal] = useState(false);
  const [editingVehicleId, setEditingVehicleId] = useState<number | null>(null);
  const [showOwnerModal, setShowOwnerModal] = useState(false);
  const [editingOwnerId, setEditingOwnerId] = useState<number | null>(null);
  const [deletingOwner, setDeletingOwner] = useState<VehicleOwner | null>(null);
  const [deletingOwnerBusy, setDeletingOwnerBusy] = useState(false);
  const [showRouteModal, setShowRouteModal] = useState(false);
  const [editingRouteId, setEditingRouteId] = useState<number | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [savingModal, setSavingModal] = useState(false);

  useEscapeKey(
    Boolean(deletingOwner || showRouteModal || showOwnerModal || showVehicleModal || showSchoolModal),
    () => {
      if (deletingOwner) setDeletingOwner(null);
      else if (showRouteModal) setShowRouteModal(false);
      else if (showOwnerModal) setShowOwnerModal(false);
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
    notes: '',
  });

  const [vehicleForm, setVehicleForm] = useState({
    busNumber: '',
    registrationNumber: '',
    vehicleType: '',
    ownerName: '',
    monthlyOwnerCost: '',
    operationalStatus: 'active',
  });

  const [ownerForm, setOwnerForm] = useState({
    fullName: '',
    phone: '',
    nationalId: '',
    notes: '',
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
      const [sRes, vRes, oRes] = await Promise.all([
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
        canVehiclesRead || canSchoolsRead
          ? apiFetch<{ owners: VehicleOwner[] }>('/api/owners')
          : Promise.resolve({ owners: [] as VehicleOwner[] }),
      ]);
      setSchoolsList(sRes.schools);
      setRoutesList(sRes.routes);
      if (sRes.billingPeriod) setBillingPeriod(sRes.billingPeriod);
      setVehiclesList(vRes.vehicles);
      setOwnersList(oRes.owners);
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

  const navigateSubView = (nextTab: SubTabId, nextSchoolId: number | 'all' = selectedSchoolId) => {
    if (nextTab === tab && nextSchoolId === selectedSchoolId) return;
    setTabHistory((prev) => [...prev.slice(-14), { tab, schoolId: selectedSchoolId }]);
    setTab(nextTab);
    setSelectedSchoolId(nextSchoolId);
  };

  const goBackSubView = () => {
    setTabHistory((prev) => {
      if (prev.length === 0) {
        if (selectedSchoolId !== 'all') setSelectedSchoolId('all');
        return prev;
      }
      const last = prev[prev.length - 1];
      setTab(last.tab);
      setSelectedSchoolId(last.schoolId);
      return prev.slice(0, -1);
    });
  };

  const handleAddSchool = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalError(null);
    setSavingModal(true);
    try {
      const payload = {
        ...schoolForm,
        monthlyContractValue: Number(schoolForm.monthlyContractValue || 0),
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
        notes: '',
      });
      await loadData();
    } catch (err: unknown) {
      setModalError(err instanceof Error ? err.message : 'تعذر حفظ بيانات المدرسة');
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
        ownerName: vehicleForm.ownerName.trim(),
        monthlyOwnerCost: Number(vehicleForm.monthlyOwnerCost || 0),
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
        ownerName: '',
        monthlyOwnerCost: '',
        operationalStatus: 'active',
      });
      await loadData();
    } catch (err: unknown) {
      setModalError(err instanceof Error ? err.message : 'تعذر حفظ بيانات المركبة');
    } finally {
      setSavingModal(false);
    }
  };

  const handleSaveOwner = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalError(null);
    setSavingModal(true);
    try {
      if (editingOwnerId) {
        await apiFetch(`/api/owners/${editingOwnerId}`, {
          method: 'PATCH',
          body: JSON.stringify(ownerForm),
        });
      } else {
        await apiFetch('/api/owners', {
          method: 'POST',
          body: JSON.stringify(ownerForm),
        });
      }
      setShowOwnerModal(false);
      setEditingOwnerId(null);
      setOwnerForm({ fullName: '', phone: '', nationalId: '', notes: '' });
      await loadData();
    } catch (err: unknown) {
      setModalError(
        err instanceof Error ? err.message : editingOwnerId ? 'تعذر تعديل بيانات المالك' : 'تعذر إضافة مالك المركبة'
      );
    } finally {
      setSavingModal(false);
    }
  };

  const handleDeleteOwner = async () => {
    if (!deletingOwner) return;
    setDeletingOwnerBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/owners/${deletingOwner.id}`, { method: 'DELETE' });
      setDeletingOwner(null);
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر حذف مالك المركبة');
    } finally {
      setDeletingOwnerBusy(false);
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
      notes: '',
    });
    setShowSchoolModal(true);
  };

  const openEditSchool = (s: SchoolItem) => {
    setModalError(null);
    setEditingSchoolId(s.id);
    setSchoolForm({
      name: s.name,
      contactName: s.contactName || '',
      contactPhone: s.contactPhone || '',
      address: s.address || '',
      monthlyContractValue: String(s.monthlyContractValue || 0),
      contractStartDate: s.contractStartDate || '',
      contractEndDate: s.contractEndDate || '',
      notes: s.notes || '',
    });
    setShowSchoolModal(true);
  };

  const openAddVehicle = () => {
    setModalError(null);
    setEditingVehicleId(null);
    setVehicleForm({
      busNumber: '',
      registrationNumber: '',
      vehicleType: '',
      ownerName: '',
      monthlyOwnerCost: '',
      operationalStatus: 'active',
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
      ownerName: v.ownerName && v.ownerName !== '—' ? v.ownerName : '',
      monthlyOwnerCost: String(v.monthlyOwnerCost || 0),
      operationalStatus: v.operationalStatus || 'active',
    });
    setShowVehicleModal(true);
  };

  const openAddOwner = () => {
    setModalError(null);
    setEditingOwnerId(null);
    setOwnerForm({ fullName: '', phone: '', nationalId: '', notes: '' });
    setShowOwnerModal(true);
  };

  const openEditOwner = (o: VehicleOwner) => {
    setModalError(null);
    setEditingOwnerId(o.id);
    setOwnerForm({
      fullName: o.fullName,
      phone: o.phone,
      nationalId: o.nationalId || '',
      notes: o.notes || '',
    });
    setShowOwnerModal(true);
  };

  const openAddRoute = () => {
    setModalError(null);
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
            عقود المدارس مقسمة حسب كل مدرسة بسائقيها ورواتبهم وأرباحها، وإدارة الملاك والمركبات
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
          {tab === 'owners' && canVehiclesWrite && (
            <button
              onClick={openAddOwner}
              className="flex items-center gap-2 rounded-lg bg-[#0B1F3A] px-4 py-2 text-xs font-semibold text-white hover:bg-[#13325c] cursor-pointer"
            >
              <Plus className="w-4 h-4 text-[#C89B3C]" />
              إضافة مالك باص
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
              onClick={() => navigateSubView(item.id, item.id === 'schools' ? selectedSchoolId : 'all')}
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
                    <div className="flex items-center gap-2">
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
                    <div className="flex items-center gap-2">
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
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 pt-4 border-t border-slate-100">
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
                    <div className="rounded-xl bg-slate-50 border border-slate-200/70 p-3.5">
                      <div className="text-[11px] text-slate-500">
                        تكلفة ملاك الباصات ({selectedSchoolObj.vehicleCount ?? 0})
                      </div>
                      <div className="font-mono text-lg font-bold text-slate-800 mt-1 tabular-nums">
                        {formatEGP(selectedSchoolObj.ownerCost ?? 0)}
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
                                باص {drv.busNumber || '—'}
                              </div>
                              <div className="text-slate-500">{drv.routeName || '—'}</div>
                            </td>
                            {canFinanceRead && (
                              <>
                                <td className="py-3 px-4 font-mono font-semibold text-slate-900 tabular-nums">
                                  {formatEGP(drv.baseSalary)}
                                </td>
                                <td className="py-3 px-4 font-mono text-red-700 tabular-nums">
                                  {formatEGP(drv.totalAdvances + drv.totalCoverageDeductions)}
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

              {/* Isolated School Vehicles & Owner Costs */}
              <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-2">
                  <Bus className="w-4 h-4 text-[#C89B3C]" />
                  <h3 className="font-display text-sm font-bold text-[#0B1F3A]">
                    المركبات والملاك المخصصون لـ {selectedSchoolObj.name} ({(selectedSchoolObj.vehicles || []).length})
                  </h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-right text-xs">
                    <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                      <tr>
                        <th className="py-3 px-4 font-semibold">رقم الباص</th>
                        <th className="py-3 px-4 font-semibold">اللوحة والنوع</th>
                        <th className="py-3 px-4 font-semibold">المالك</th>
                        {canFinanceRead && (
                          <th className="py-3 px-4 font-semibold">التكلفة الشهرية للمالك</th>
                        )}
                        <th className="py-3 px-4 font-semibold">السائق</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(selectedSchoolObj.vehicles || []).length === 0 ? (
                        <tr>
                          <td colSpan={canFinanceRead ? 5 : 4} className="py-8 text-center text-slate-400">
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
                            <td className="py-3 px-4">
                              <div className="text-slate-800">{v.ownerName}</div>
                              <div className="font-mono text-slate-500">{v.ownerPhone}</div>
                            </td>
                            {canFinanceRead && (
                              <td className="py-3 px-4 font-mono font-semibold text-slate-900 tabular-nums">
                                {formatEGP(v.monthlyOwnerCost)}
                              </td>
                            )}
                            <td className="py-3 px-4 text-slate-700">{v.driverName}</td>
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
                      <h3 className="font-display text-base font-bold text-[#0B1F3A]">{s.name}</h3>
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

                  <div className={`grid ${canFinanceRead ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-1'} gap-3 border-t border-slate-100 pt-3 text-xs`}>
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
                          <div className="text-slate-500">تكلفة الملاك</div>
                          <div className="font-mono font-semibold text-slate-900 mt-0.5 tabular-nums">
                            {formatEGP(s.ownerCost ?? 0)}
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
                              {drv.fullName} ({drv.busNumber || '—'})
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
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => navigateSubView('schools', s.id)}
                        className="inline-flex items-center gap-1 rounded-md bg-[#0B1F3A] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#13325c] cursor-pointer"
                      >
                        <Users className="w-3 h-3 text-[#C89B3C]" />
                        {canFinanceRead ? 'عرض العقد والسائقين والربح' : 'عرض السائقين والمركبات'}
                      </button>
                      {canSchoolsWrite && (
                        <button
                          onClick={() => openEditSchool(s)}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold text-[#0B1F3A] hover:bg-slate-50 cursor-pointer"
                        >
                          <Edit3 className="w-3 h-3" />
                          تعديل
                        </button>
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
                  <th className="py-3 px-4 font-semibold">مالك المركبة</th>
                  {canFinanceRead && (
                    <th className="py-3 px-4 font-semibold">التكلفة الشهرية للمالك</th>
                  )}
                  <th className="py-3 px-4 font-semibold">المدرسة والسائق</th>
                  <th className="py-3 px-4 font-semibold">حالة التشغيل و GPS</th>
                  {canVehiclesWrite && <th className="py-3 px-4 font-semibold">تعديل</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {vehiclesList.map((v) => (
                  <tr key={v.id} className="hover:bg-slate-50/70">
                    <td className="py-3.5 px-4 font-mono font-bold text-[#0B1F3A]">{v.busNumber}</td>
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-slate-900">{v.registrationNumber}</div>
                      <div className="text-slate-500">{v.vehicleType}</div>
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="text-slate-800">{v.ownerName}</div>
                      <div className="text-slate-500 font-mono">{v.ownerPhone}</div>
                    </td>
                    {canFinanceRead && (
                      <td className="py-3.5 px-4 font-mono font-semibold text-slate-900 tabular-nums">
                        {formatEGP(v.monthlyOwnerCost)}
                      </td>
                    )}
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
              </tbody>
            </table>
          </div>
        </div>
      ) : tab === 'owners' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {ownersList.map((o) => {
            const linkedVehicles = vehiclesList.filter((v) => v.ownerId === o.id);
            return (
              <div
                key={o.id}
                className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-bold text-[#0B1F3A] text-sm">{o.fullName}</h3>
                    <span className="font-mono text-[11px] text-slate-500 tabular-nums shrink-0">
                      {linkedVehicles.length} مركبة
                    </span>
                  </div>
                  <div className="mt-1 font-mono text-xs text-slate-600" dir="ltr">
                    {o.phone}
                  </div>
                  {o.nationalId && (
                    <div className="mt-1 font-mono text-xs text-slate-500">
                      الرقم القومي/السجل: {o.nationalId}
                    </div>
                  )}
                  {linkedVehicles.length > 0 && (
                    <div className="mt-2 text-[11px] text-slate-600">
                      الباصات: {linkedVehicles.map((v) => v.busNumber).join('، ')}
                    </div>
                  )}
                  {o.notes && <p className="mt-2 text-xs text-slate-500">{o.notes}</p>}
                </div>

                {canVehiclesWrite && (
                  <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
                    <button
                      type="button"
                      onClick={() => openEditOwner(o)}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-[#0B1F3A] hover:bg-slate-50 cursor-pointer"
                    >
                      <Edit3 className="w-3 h-3 text-[#C89B3C]" />
                      تعديل
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeletingOwner(o)}
                      className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] font-semibold text-red-700 hover:bg-red-100 cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                      حذف
                    </button>
                  </div>
                )}
              </div>
            );
          })}
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
                  <th className="py-3 px-4 font-semibold">اسم الخط</th>
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
                      <td className="py-3 px-4 font-semibold text-[#0B1F3A]">{r.name}</td>
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
                onChange={(e) => setSchoolForm({ ...schoolForm, name: e.target.value })}
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
                className="w-full rounded-lg bg-[#0B1F3A] py-2.5 font-semibold text-white hover:bg-[#13325c] cursor-pointer"
              >
                حفظ المدرسة
              </button>
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
              <div className="grid grid-cols-2 gap-3">
                <input
                  required
                  placeholder="رقم الباص *"
                  value={vehicleForm.busNumber}
                  onChange={(e) => setVehicleForm({ ...vehicleForm, busNumber: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                />
                <input
                  required
                  placeholder="رقم اللوحة المعدنية *"
                  value={vehicleForm.registrationNumber}
                  onChange={(e) =>
                    setVehicleForm({ ...vehicleForm, registrationNumber: e.target.value })
                  }
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
              </div>
              <input
                placeholder="نوع المركبة"
                value={vehicleForm.vehicleType}
                onChange={(e) => setVehicleForm({ ...vehicleForm, vehicleType: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2"
              />
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="text"
                  placeholder="اكتب اسم مالك المركبة"
                  value={vehicleForm.ownerName}
                  onChange={(e) => setVehicleForm({ ...vehicleForm, ownerName: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                />
                <input
                  type="number"
                  required
                  placeholder="التكلفة الشهرية للمالك (ج.م)"
                  value={vehicleForm.monthlyOwnerCost}
                  onChange={(e) =>
                    setVehicleForm({ ...vehicleForm, monthlyOwnerCost: e.target.value })
                  }
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                />
              </div>
              <button
                type="submit"
                className="w-full rounded-lg bg-[#0B1F3A] py-2.5 font-semibold text-white hover:bg-[#13325c] cursor-pointer"
              >
                حفظ المركبة
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Add/Edit Owner Modal */}
      {showOwnerModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
            <div className="px-6 py-4 bg-[#0B1F3A] text-white flex items-center justify-between">
              <h3 className="font-bold text-sm">
                {editingOwnerId ? 'تعديل بيانات مالك المركبة' : 'إضافة مالك مركبة'}
              </h3>
              <button
                type="button"
                onClick={() => {
                  setShowOwnerModal(false);
                  setEditingOwnerId(null);
                }}
                className="cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveOwner} className="p-6 space-y-3 text-xs">
              {modalError && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-red-800">
                  {modalError}
                </div>
              )}
              <input
                required
                placeholder="الاسم الكامل للمالك *"
                value={ownerForm.fullName}
                onChange={(e) => setOwnerForm({ ...ownerForm, fullName: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2"
              />
              <ContactPhoneInput
                required
                placeholder="رقم الهاتف *"
                value={ownerForm.phone}
                onChange={(phone) => setOwnerForm((prev) => ({ ...prev, phone }))}
                onPickContact={({ phone, name }) =>
                  setOwnerForm((prev) => ({
                    ...prev,
                    phone,
                    fullName: prev.fullName.trim() ? prev.fullName : name || prev.fullName,
                  }))
                }
              />
              <input
                placeholder="الرقم القومي / السجل التجاري"
                value={ownerForm.nationalId}
                onChange={(e) => setOwnerForm({ ...ownerForm, nationalId: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
              />
              <textarea
                rows={2}
                placeholder="ملاحظات إضافية (اختياري)"
                value={ownerForm.notes}
                onChange={(e) => setOwnerForm({ ...ownerForm, notes: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2"
              />
              <button
                type="submit"
                disabled={savingModal}
                className="w-full rounded-lg bg-[#0B1F3A] py-2.5 font-semibold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
              >
                {savingModal ? 'جاري الحفظ...' : editingOwnerId ? 'حفظ التعديلات' : 'حفظ المالك'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Delete Owner Confirmation Modal */}
      {deletingOwner && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-sm bg-white rounded-2xl border border-slate-200 shadow-xl p-5 space-y-4 text-xs">
            <div className="flex items-center gap-2 text-red-700 font-bold text-sm">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <span>تأكيد حذف مالك المركبة</span>
            </div>
            <p className="text-slate-600 leading-relaxed">
              هل تريد حذف المالك <strong>{deletingOwner.fullName}</strong>؟ سيتم فك ارتباطه بأي باصات مسجلة باسمه دون حذف الباصات نفسها.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={deletingOwnerBusy}
                onClick={() => setDeletingOwner(null)}
                className="rounded-lg border border-slate-200 px-4 py-2 font-semibold text-slate-700 cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={deletingOwnerBusy}
                onClick={handleDeleteOwner}
                className="rounded-lg bg-red-600 px-4 py-2 font-bold text-white hover:bg-red-700 disabled:opacity-50 cursor-pointer"
              >
                {deletingOwnerBusy ? 'جاري الحذف...' : 'تأكيد الحذف'}
              </button>
            </div>
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
              <input
                type="text"
                placeholder="اكتب اسم المدرسة (اختياري)"
                value={routeForm.schoolName}
                onChange={(e) => setRouteForm({ ...routeForm, schoolName: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2"
              />
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
