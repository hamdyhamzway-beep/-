import React, { useCallback, useEffect, useState } from 'react';
import { Building2, Bus, Plus, Route, User, X } from 'lucide-react';
import { apiFetch, formatEGP } from '../../lib/api';
import { ContactPhoneInput } from '../ContactPhoneInput';
import type { FleetVehicle, RouteItem, SchoolItem, VehicleOwner } from '../../types';

export const SchoolsVehiclesModule: React.FC = () => {
  const [tab, setTab] = useState<'schools' | 'vehicles' | 'owners' | 'routes'>('schools');
  const [schoolsList, setSchoolsList] = useState<SchoolItem[]>([]);
  const [routesList, setRoutesList] = useState<RouteItem[]>([]);
  const [vehiclesList, setVehiclesList] = useState<FleetVehicle[]>([]);
  const [ownersList, setOwnersList] = useState<VehicleOwner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modals
  const [showSchoolModal, setShowSchoolModal] = useState(false);
  const [showVehicleModal, setShowVehicleModal] = useState(false);
  const [showOwnerModal, setShowOwnerModal] = useState(false);
  const [showRouteModal, setShowRouteModal] = useState(false);

  const [schoolForm, setSchoolForm] = useState({
    name: '',
    contactName: '',
    contactPhone: '',
    address: '',
    monthlyContractValue: '',
    contractStartDate: '2026-09-01',
    contractEndDate: '2027-06-30',
    notes: '',
  });

  const [vehicleForm, setVehicleForm] = useState({
    busNumber: '',
    registrationNumber: '',
    vehicleType: 'تويوتا هايس سقف عالي 14 راكب',
    ownerId: '',
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
    schoolId: '',
    pickupArea: '',
    dropoffArea: '',
    pickupTime: '06:45',
    dropoffTime: '14:30',
    estimatedDistanceKm: '15',
  });

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sRes, vRes, oRes] = await Promise.all([
        apiFetch<{ schools: SchoolItem[]; routes: RouteItem[] }>('/api/schools'),
        apiFetch<{ vehicles: FleetVehicle[] }>('/api/vehicles'),
        apiFetch<{ owners: VehicleOwner[] }>('/api/owners'),
      ]);
      setSchoolsList(sRes.schools);
      setRoutesList(sRes.routes);
      setVehiclesList(vRes.vehicles);
      setOwnersList(oRes.owners);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل بيانات المدارس والمركبات');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleAddSchool = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/api/schools', {
      method: 'POST',
      body: JSON.stringify({
        ...schoolForm,
        monthlyContractValue: Number(schoolForm.monthlyContractValue || 0),
      }),
    });
    setShowSchoolModal(false);
    setSchoolForm({
      name: '',
      contactName: '',
      contactPhone: '',
      address: '',
      monthlyContractValue: '',
      contractStartDate: '2026-09-01',
      contractEndDate: '2027-06-30',
      notes: '',
    });
    await loadData();
  };

  const handleAddVehicle = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/api/vehicles', {
      method: 'POST',
      body: JSON.stringify({
        ...vehicleForm,
        ownerId: vehicleForm.ownerId ? Number(vehicleForm.ownerId) : null,
        monthlyOwnerCost: Number(vehicleForm.monthlyOwnerCost || 0),
      }),
    });
    setShowVehicleModal(false);
    setVehicleForm({
      busNumber: '',
      registrationNumber: '',
      vehicleType: 'تويوتا هايس سقف عالي 14 راكب',
      ownerId: '',
      monthlyOwnerCost: '',
      operationalStatus: 'active',
    });
    await loadData();
  };

  const handleAddOwner = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/api/owners', { method: 'POST', body: JSON.stringify(ownerForm) });
    setShowOwnerModal(false);
    setOwnerForm({ fullName: '', phone: '', nationalId: '', notes: '' });
    await loadData();
  };

  const handleAddRoute = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/api/routes', {
      method: 'POST',
      body: JSON.stringify({
        ...routeForm,
        schoolId: Number(routeForm.schoolId),
        estimatedDistanceKm: Number(routeForm.estimatedDistanceKm || 0),
      }),
    });
    setShowRouteModal(false);
    setRouteForm({
      name: '',
      schoolId: '',
      pickupArea: '',
      dropoffArea: '',
      pickupTime: '06:45',
      dropoffTime: '14:30',
      estimatedDistanceKm: '15',
    });
    await loadData();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#0B1F3A]">
            المدارس والمركبات وخطوط السير
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            عقود المدارس الشهرية، تكاليف ملاك الباصات، صافي هامش الربح، وإدارة خطوط التوصيل
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {tab === 'schools' && (
            <button
              onClick={() => setShowSchoolModal(true)}
              className="flex items-center gap-2 rounded-lg bg-[#0B1F3A] px-4 py-2 text-xs font-semibold text-white hover:bg-[#13325c] cursor-pointer"
            >
              <Plus className="w-4 h-4 text-[#C89B3C]" />
              إضافة مدرسة
            </button>
          )}
          {tab === 'vehicles' && (
            <button
              onClick={() => {
                setVehicleForm((f) => ({
                  ...f,
                  ownerId: ownersList[0]?.id ? String(ownersList[0].id) : '',
                }));
                setShowVehicleModal(true);
              }}
              className="flex items-center gap-2 rounded-lg bg-[#0B1F3A] px-4 py-2 text-xs font-semibold text-white hover:bg-[#13325c] cursor-pointer"
            >
              <Plus className="w-4 h-4 text-[#C89B3C]" />
              إضافة مركبة
            </button>
          )}
          {tab === 'owners' && (
            <button
              onClick={() => setShowOwnerModal(true)}
              className="flex items-center gap-2 rounded-lg bg-[#0B1F3A] px-4 py-2 text-xs font-semibold text-white hover:bg-[#13325c] cursor-pointer"
            >
              <Plus className="w-4 h-4 text-[#C89B3C]" />
              إضافة مالك باص
            </button>
          )}
          {tab === 'routes' && (
            <button
              onClick={() => {
                setRouteForm((f) => ({
                  ...f,
                  schoolId: schoolsList[0]?.id ? String(schoolsList[0].id) : '',
                }));
                setShowRouteModal(true);
              }}
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
        {[
          { id: 'schools', label: 'المدارس والعقود', icon: Building2 },
          { id: 'vehicles', label: 'المركبات والباصات', icon: Bus },
          { id: 'owners', label: 'ملاك الباصات', icon: User },
          { id: 'routes', label: 'خطوط السير', icon: Route },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => setTab(item.id as typeof tab)}
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
                <div className="text-left shrink-0">
                  <div className="text-[11px] text-slate-500">قيمة العقد الشهري</div>
                  <div className="font-mono text-base font-bold text-[#0B1F3A] tabular-nums">
                    {formatEGP(s.monthlyContractValue)}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 border-t border-slate-100 pt-3 text-xs">
                <div>
                  <div className="text-slate-500">المركبات / السائقون</div>
                  <div className="font-mono font-semibold text-slate-900 mt-0.5 tabular-nums">
                    {s.vehicleCount ?? 0} باص · {s.driverCount ?? 0} سائق
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">تكلفة الملاك</div>
                  <div className="font-mono font-semibold text-slate-900 mt-0.5 tabular-nums">
                    {formatEGP(s.ownerCost ?? 0)}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">صافي ربح المكتب</div>
                  <div className="font-mono font-bold text-emerald-700 mt-0.5 tabular-nums">
                    {formatEGP(s.estimatedProfit ?? 0)}
                  </div>
                </div>
              </div>

              <div className="text-[11px] text-slate-400 border-t border-slate-100 pt-2.5 flex items-center justify-between">
                <span className="font-mono tabular-nums">
                  العقد: {s.contractStartDate} إلى {s.contractEndDate}
                </span>
                <span>{s.isActive ? 'عقد ساري' : 'غير نشط'}</span>
              </div>
            </div>
          ))}
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
                  <th className="py-3 px-4 font-semibold">التكلفة الشهرية للمالك</th>
                  <th className="py-3 px-4 font-semibold">المدرسة والسائق</th>
                  <th className="py-3 px-4 font-semibold">حالة التشغيل و GPS</th>
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
                    <td className="py-3.5 px-4 font-mono font-semibold text-slate-900 tabular-nums">
                      {formatEGP(v.monthlyOwnerCost)}
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : tab === 'owners' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {ownersList.map((o) => (
            <div key={o.id} className="bg-white border border-slate-200 rounded-xl p-5">
              <h3 className="font-bold text-[#0B1F3A] text-sm">{o.fullName}</h3>
              <div className="mt-1 font-mono text-xs text-slate-600">{o.phone}</div>
              {o.nationalId && (
                <div className="mt-1 font-mono text-xs text-slate-500">الرقم القومي/السجل: {o.nationalId}</div>
              )}
              {o.notes && <p className="mt-2 text-xs text-slate-500">{o.notes}</p>}
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <table className="w-full text-right text-xs">
            <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
              <tr>
                <th className="py-3 px-4 font-semibold">اسم الخط</th>
                <th className="py-3 px-4 font-semibold">المدرسة</th>
                <th className="py-3 px-4 font-semibold">نقطة التجمع / الانطلاق</th>
                <th className="py-3 px-4 font-semibold">مواعيد الذهاب والعودة</th>
                <th className="py-3 px-4 font-semibold">المسافة التقديرية</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {routesList.map((r) => {
                const school = schoolsList.find((s) => s.id === r.schoolId);
                return (
                  <tr key={r.id}>
                    <td className="py-3 px-4 font-semibold text-[#0B1F3A]">{r.name}</td>
                    <td className="py-3 px-4 text-slate-700">{school?.name || '—'}</td>
                    <td className="py-3 px-4 text-slate-600">{r.pickupArea}</td>
                    <td className="py-3 px-4 font-mono tabular-nums text-slate-700">
                      {r.pickupTime} — {r.dropoffTime}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-slate-700">
                      {r.estimatedDistanceKm} كم
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Add School Modal */}
      {showSchoolModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-lg bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
            <div className="px-6 py-4 bg-[#0B1F3A] text-white flex items-center justify-between">
              <h3 className="font-bold text-sm">إضافة مدرسة وعقد شهري جديد</h3>
              <button onClick={() => setShowSchoolModal(false)} className="cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleAddSchool} className="p-6 space-y-3 text-xs">
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

      {/* Add Vehicle Modal */}
      {showVehicleModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-lg bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
            <div className="px-6 py-4 bg-[#0B1F3A] text-white flex items-center justify-between">
              <h3 className="font-bold text-sm">إضافة مركبة / باص جديد</h3>
              <button onClick={() => setShowVehicleModal(false)} className="cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleAddVehicle} className="p-6 space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <input
                  required
                  placeholder="رقم الباص (مثال: B-104) *"
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
                placeholder="نوع المركبة (مثال: تويوتا هايس سقف عالي)"
                value={vehicleForm.vehicleType}
                onChange={(e) => setVehicleForm({ ...vehicleForm, vehicleType: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2"
              />
              <div className="grid grid-cols-2 gap-3">
                <select
                  value={vehicleForm.ownerId}
                  onChange={(e) => setVehicleForm({ ...vehicleForm, ownerId: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                >
                  <option value="">اختر مالك المركبة</option>
                  {ownersList.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.fullName}
                    </option>
                  ))}
                </select>
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

      {/* Add Owner Modal */}
      {showOwnerModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
            <div className="px-6 py-4 bg-[#0B1F3A] text-white flex items-center justify-between">
              <h3 className="font-bold text-sm">إضافة مالك مركبة</h3>
              <button onClick={() => setShowOwnerModal(false)} className="cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleAddOwner} className="p-6 space-y-3 text-xs">
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
              <button
                type="submit"
                className="w-full rounded-lg bg-[#0B1F3A] py-2.5 font-semibold text-white hover:bg-[#13325c] cursor-pointer"
              >
                حفظ المالك
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Add Route Modal */}
      {showRouteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
            <div className="px-6 py-4 bg-[#0B1F3A] text-white flex items-center justify-between">
              <h3 className="font-bold text-sm">إضافة خط سير جديد</h3>
              <button onClick={() => setShowRouteModal(false)} className="cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleAddRoute} className="p-6 space-y-3 text-xs">
              <input
                required
                placeholder="اسم الخط *"
                value={routeForm.name}
                onChange={(e) => setRouteForm({ ...routeForm, name: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2"
              />
              <select
                required
                value={routeForm.schoolId}
                onChange={(e) => setRouteForm({ ...routeForm, schoolId: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2"
              >
                <option value="">اختر المدرسة</option>
                {schoolsList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <input
                placeholder="منطقة الانطلاق / التجمع"
                value={routeForm.pickupArea}
                onChange={(e) => setRouteForm({ ...routeForm, pickupArea: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2"
              />
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="time"
                  value={routeForm.pickupTime}
                  onChange={(e) => setRouteForm({ ...routeForm, pickupTime: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                />
                <input
                  type="time"
                  value={routeForm.dropoffTime}
                  onChange={(e) => setRouteForm({ ...routeForm, dropoffTime: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                />
              </div>
              <button
                type="submit"
                className="w-full rounded-lg bg-[#0B1F3A] py-2.5 font-semibold text-white hover:bg-[#13325c] cursor-pointer"
              >
                حفظ الخط
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
