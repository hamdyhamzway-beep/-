import React, { useCallback, useEffect, useState } from 'react';
import {
  APIProvider,
  AdvancedMarker,
  InfoWindow,
  Map as GoogleMap,
  useAdvancedMarkerRef,
  useMap,
} from '@vis.gl/react-google-maps';
import { Bus, Navigation, RefreshCw, Signal, SignalZero } from 'lucide-react';
import { apiFetch, formatRelativeArabicTime } from '../../lib/api';
import type { FleetVehicle } from '../../types';

interface GpsHistoryPoint {
  id: number;
  lat: number;
  lng: number;
  speedKmh: number;
  recordedAt: string;
  isLive: boolean;
}

const AdvancedMarkerWithRef: React.FC<{
  position: { lat: number; lng: number };
  zIndex?: number;
  onMarkerClick: (marker: google.maps.marker.AdvancedMarkerElement) => void;
  children: React.ReactNode;
}> = ({ position, zIndex, onMarkerClick, children }) => {
  const [markerRef, marker] = useAdvancedMarkerRef();
  return (
    <AdvancedMarker
      ref={markerRef}
      position={position}
      zIndex={zIndex}
      onClick={() => {
        if (marker) onMarkerClick(marker);
      }}
    >
      {children}
    </AdvancedMarker>
  );
};

const RouteTrailOverlay: React.FC<{ points: GpsHistoryPoint[] }> = ({ points }) => {
  const map = useMap();
  useEffect(() => {
    if (!map || points.length < 2 || typeof google === 'undefined') return;
    const path = [...points]
      .reverse()
      .map((p) => ({ lat: p.lat, lng: p.lng }));
    const polyline = new google.maps.Polyline({
      path,
      geodesic: true,
      strokeColor: '#0B1F3A',
      strokeOpacity: 0.75,
      strokeWeight: 4,
    });
    polyline.setMap(map);
    return () => {
      polyline.setMap(null);
    };
  }, [map, points]);
  return null;
};

export const LiveMapModule: React.FC = () => {
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
  const [fleet, setFleet] = useState<FleetVehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedVehicle, setSelectedVehicle] = useState<FleetVehicle | null>(null);
  const [selectedMarker, setSelectedMarker] =
    useState<google.maps.marker.AdvancedMarkerElement | null>(null);
  const [history, setHistory] = useState<GpsHistoryPoint[]>([]);
  const [distanceKm, setDistanceKm] = useState<number>(0);

  const loadFleet = useCallback(async () => {
    try {
      const res = await apiFetch<{ fleet: FleetVehicle[] }>('/api/gps/fleet');
      setFleet(res.fleet);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل مواقع الأسطول');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFleet();
    const timer = setInterval(loadFleet, 15000);
    return () => clearInterval(timer);
  }, [loadFleet]);

  const handleSelectVehicle = async (
    v: FleetVehicle,
    marker?: google.maps.marker.AdvancedMarkerElement
  ) => {
    setSelectedVehicle(v);
    if (marker) setSelectedMarker(marker);
    try {
      const res = await apiFetch<{ history: GpsHistoryPoint[]; distanceKm: number }>(
        `/api/gps/vehicle/${v.id}/history`
      );
      setHistory(res.history);
      setDistanceKm(res.distanceKm);
    } catch {
      setHistory([]);
      setDistanceKm(0);
    }
  };

  const simulateMovementPing = async (v: FleetVehicle) => {
    const baseLat = v.gps?.lat ?? 30.0444;
    const baseLng = v.gps?.lng ?? 31.3457;
    const nextLat = baseLat + (Math.random() - 0.5) * 0.008;
    const nextLng = baseLng + (Math.random() - 0.5) * 0.008;
    const speedKmh = Math.floor(25 + Math.random() * 40);
    await apiFetch('/api/gps/update', {
      method: 'POST',
      body: JSON.stringify({
        vehicleId: v.id,
        lat: nextLat,
        lng: nextLng,
        speedKmh,
        accuracyMeters: 8,
      }),
    });
    await loadFleet();
    await handleSelectVehicle(v);
  };

  const onlineCount = fleet.filter((v) => v.isOnline).length;
  const offlineCount = fleet.filter((v) => !v.isOnline).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#0B1F3A]">
            التتبع المباشر للأسطول (GPS)
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            خرائط جوجل المباشرة · تمييز صريح بين الموقع المباشر وآخر موقع مسجل للمركبات غير المتصلة
          </p>
        </div>

        <div className="flex items-center gap-3 text-xs shrink-0">
          <span className="font-semibold text-emerald-700">متصل مباشر: {onlineCount}</span>
          <span className="text-slate-300">|</span>
          <span className="font-semibold text-amber-700">غير متصل / مخزن: {offlineCount}</span>
          <button
            onClick={loadFleet}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            تحديث
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-800">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Fleet Sidebar List */}
        <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col max-h-[640px]">
          <div className="px-4 py-3.5 border-b border-slate-200 font-bold text-sm text-[#0B1F3A]">
            قائمة الباصات ({fleet.length})
          </div>
          <div className="divide-y divide-slate-100 overflow-y-auto flex-1">
            {fleet.map((v) => {
              const isSelected = selectedVehicle?.id === v.id;
              return (
                <button
                  key={v.id}
                  onClick={() => handleSelectVehicle(v)}
                  className={`w-full text-right p-4 transition-colors cursor-pointer ${
                    isSelected ? 'bg-slate-100' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Bus className="w-4 h-4 text-[#0B1F3A]" />
                      <span className="font-mono font-bold text-sm text-[#0B1F3A]">
                        {v.busNumber}
                      </span>
                      <span className="text-xs text-slate-500">· {v.schoolName}</span>
                    </div>
                    {v.isOnline ? (
                      <span className="flex items-center gap-1 text-[11px] font-semibold text-emerald-700">
                        <Signal className="w-3.5 h-3.5" />
                        مباشر
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-[11px] font-semibold text-amber-700">
                        <SignalZero className="w-3.5 h-3.5" />
                        غير متصل
                      </span>
                    )}
                  </div>
                  <div className="mt-1.5 text-xs text-slate-700">
                    السائق: {v.driverName} (كود {v.driverCode})
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500 tabular-nums">
                    <span>
                      {v.gps
                        ? v.isOnline
                          ? `السرعة: ${v.gps.speedKmh} كم/س`
                          : 'آخر موقع مسجل (غير متصل)'
                        : 'لم يرسل موقعاً بعد'}
                    </span>
                    <span>{v.gps ? formatRelativeArabicTime(v.gps.recordedAt) : ''}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Google Map Area */}
        <div className="lg:col-span-8 space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden h-[480px] relative">
            {!apiKey ? (
              <div className="h-full flex flex-col items-center justify-center p-6 text-center text-sm text-slate-500">
                مفتاح خرائط جوجل (VITE_GOOGLE_MAPS_API_KEY) غير متوفر في البيئة.
              </div>
            ) : (
              <APIProvider apiKey={apiKey} libraries={['marker']} language="ar" region="EG">
                <GoogleMap
                  mapId="DEMO_MAP_ID"
                  defaultCenter={{ lat: 30.03, lng: 31.38 }}
                  defaultZoom={11}
                  gestureHandling="greedy"
                  internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
                  style={{ width: '100%', height: '100%' }}
                >
                  {fleet
                    .filter((v) => v.gps)
                    .map((v, idx) => (
                      <AdvancedMarkerWithRef
                        key={v.id}
                        position={{ lat: v.gps!.lat, lng: v.gps!.lng }}
                        zIndex={selectedVehicle?.id === v.id ? 1000 : idx + 1}
                        onMarkerClick={(marker) => handleSelectVehicle(v, marker)}
                      >
                        <div
                          className={`px-2.5 py-1.5 rounded-lg border shadow-md flex items-center gap-1.5 text-[11px] font-bold ${
                            v.isOnline
                              ? 'bg-[#0B1F3A] text-white border-[#C89B3C]'
                              : 'bg-slate-200 text-slate-700 border-slate-400'
                          }`}
                        >
                          <Bus className="w-3.5 h-3.5" />
                          <span className="font-mono">{v.busNumber}</span>
                          {v.isOnline && (
                            <span className="text-[#C89B3C] font-mono tabular-nums">
                              {v.gps!.speedKmh} كم/س
                            </span>
                          )}
                        </div>
                      </AdvancedMarkerWithRef>
                    ))}

                  {selectedVehicle && selectedMarker && selectedVehicle.gps && (
                    <InfoWindow
                      anchor={selectedMarker}
                      onCloseClick={() => {
                        setSelectedMarker(null);
                      }}
                    >
                      <div className="p-1 text-right text-xs min-w-[210px]" dir="rtl">
                        <div className="font-bold text-[#0B1F3A] text-sm">
                          باص {selectedVehicle.busNumber} · {selectedVehicle.schoolName}
                        </div>
                        <div className="mt-1 text-slate-700">
                          السائق: {selectedVehicle.driverName} (كود {selectedVehicle.driverCode})
                        </div>
                        <div className="mt-1 font-semibold">
                          الحالة: {selectedVehicle.gps.statusLabel}
                        </div>
                        <div className="mt-1 font-mono text-slate-600 tabular-nums">
                          السرعة: {selectedVehicle.gps.speedKmh} كم/س
                        </div>
                        <div className="mt-1 text-slate-500">
                          آخر تحديث: {formatRelativeArabicTime(selectedVehicle.gps.recordedAt)}
                        </div>
                      </div>
                    </InfoWindow>
                  )}

                  {history.length >= 2 && <RouteTrailOverlay points={history} />}
                </GoogleMap>
              </APIProvider>
            )}
          </div>

          {/* Selected Vehicle Telemetry Panel */}
          {selectedVehicle && (
            <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-xs">
              <div className="space-y-1">
                <div className="font-bold text-sm text-[#0B1F3A]">
                  تفاصيل المركبة {selectedVehicle.busNumber} ({selectedVehicle.registrationNumber})
                </div>
                <div className="text-slate-600">
                  السائق: {selectedVehicle.driverName} (كود {selectedVehicle.driverCode}) · المدرسة:{' '}
                  {selectedVehicle.schoolName} · الخط: {selectedVehicle.routeName}
                </div>
                <div className="text-slate-500 font-mono tabular-nums">
                  {selectedVehicle.gps
                    ? `الإحداثيات: ${selectedVehicle.gps.lat.toFixed(5)}, ${selectedVehicle.gps.lng.toFixed(5)} · المسافة المسجلة بالسجل: ${distanceKm} كم · ${selectedVehicle.gps.statusLabel}`
                    : 'لا توجد إحداثيات مسجلة'}
                </div>
              </div>
              <button
                onClick={() => simulateMovementPing(selectedVehicle)}
                className="flex items-center gap-2 rounded-lg bg-[#0B1F3A] px-3.5 py-2 font-semibold text-white hover:bg-[#13325c] cursor-pointer shrink-0"
              >
                <Navigation className="w-3.5 h-3.5 text-[#C89B3C]" />
                تحديث نبضة GPS للمركبة
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
