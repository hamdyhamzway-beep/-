import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  APIProvider,
  AdvancedMarker,
  InfoWindow,
  Map as GoogleMap,
} from '@vis.gl/react-google-maps';
import {
  AlertCircle,
  ArrowRight,
  BatteryCharging,
  Bus,
  CheckCircle2,
  Loader2,
  LogOut,
  MapPin,
  Moon,
  Navigation,
  Phone,
  PowerOff,
  RadioTower,
  MessageSquare,
  RefreshCw,
  Route,
  School,
  Signal,
  SignalZero,
  Sun,
  UserCheck,
  X,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import {
  apiFetch,
  formatArabicTimestampTime,
  formatRelativeArabicTime,
} from '../../lib/api';
import {
  HIGH_ACCURACY_GPS_OPTIONS,
  HighPrecisionSpeedEstimator,
  isWithinDailyTrackingWindow,
  isValidGpsCoordinate,
} from '../../lib/gps-tracker';
import { AppLogoBackdrop } from '../AppLogoBackdrop';
import { ChatHubModule } from '../chat/ChatHubModule';
import { CompanyLegalFooter } from '../CompanyLegalFooter';
import { DriverAvatar } from '../DriverAvatar';
import { MorningSpiritualRibbon } from '../MorningSpiritualRibbon';
import {
  ALEXANDRIA_CENTER,
  AdvancedMarkerWithRef,
  MapPanController,
  RouteTrailOverlay,
  getGoogleMapsApiKey,
  hasValidGoogleMapsKey,
} from '../MapPrimitives';
import { PWAInstallButton } from '../PWAInstall';
import { SplashScreen } from '../SplashScreen';
import splashScreenImg from '../../assets/images/alwaleed_splash_screen_1794752422708.jpg';
import travelBackdropImg from '../../assets/images/alwaleed_travel_backdrop_1794752421692.jpg';
import type {
  SupervisorAppResponse,
  SupervisorLiveLocation,
  SupervisorRecord,
  SupervisorTripRecord,
} from '../../types';

const SUPERVISOR_GPS_PREF_KEY = 'alwaleed_supervisor_live_gps_enabled';
const SUPERVISOR_GPS_ECONOMY_KEY = 'alwaleed_supervisor_gps_economy';

const ECONOMY_GPS_OPTIONS: PositionOptions = {
  enableHighAccuracy: false,
  timeout: 15000,
  maximumAge: 60000,
};

/**
 * Dedicated Supervisor App ("نسخة المشرفة")
 * Strictly restricted to: Supervisor Name, Photo, Mobile, Assigned Code,
 * Auto-started Live Location, Two Daily Trip Missions (Morning Start / Evening End),
 * Route Details, and Live Tracking Map.
 * Zero financial data, salaries, advances, coverage deductions, contracts, or accounting modules.
 */
export const SupervisorApp: React.FC<{
  allowSupervisorSelector?: boolean;
  initialSupervisorId?: string;
  hasPreviewBar?: boolean;
}> = ({
  allowSupervisorSelector = false,
  initialSupervisorId = '',
  hasPreviewBar = false,
}) => {
  const { dbUser, supervisorRecord, logout } = useAuth();
  const apiKey = getGoogleMapsApiKey();
  const hasValidApiKey = hasValidGoogleMapsKey(apiKey);

  const [allSupervisors, setAllSupervisors] = useState<SupervisorRecord[]>([]);
  const [supervisorsLoaded, setSupervisorsLoaded] = useState(!allowSupervisorSelector);
  const [selectedSupervisorId, setSelectedSupervisorId] = useState<string>(initialSupervisorId);
  const [data, setData] = useState<SupervisorAppResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [activeVehicleId, setActiveVehicleId] = useState<number | null>(null);
  const [selectedMarker, setSelectedMarker] =
    useState<google.maps.marker.AdvancedMarkerElement | null>(null);
  const [panTarget, setPanTarget] = useState<{ lat: number; lng: number; zoom?: number } | null>(
    null
  );

  // Auto-started Live Location state
  const [gpsEnabled, setGpsEnabled] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(SUPERVISOR_GPS_PREF_KEY);
      return saved === null ? true : saved === 'true';
    } catch {
      return true;
    }
  });
  const [gpsEconomyMode, setGpsEconomyMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SUPERVISOR_GPS_ECONOMY_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [gpsPermissionError, setGpsPermissionError] = useState<string | null>(null);
  const [wakeLockActive, setWakeLockActive] = useState<boolean>(false);
  const [livePosition, setLivePosition] = useState<SupervisorLiveLocation | null>(null);
  const [gpsSending, setGpsSending] = useState(false);
  const speedEstimatorRef = useRef(new HighPrecisionSpeedEstimator());
  const lastGpsSentAtRef = useRef<number>(0);
  const latestCoordsRef = useRef<{ lat: number; lng: number; speedKmh: number; accuracyMeters: number } | null>(null);

  // Daily 2 trip missions state
  const [actionBusy, setActionBusy] = useState<'start_morning' | 'end_evening' | null>(null);
  const [actionBanner, setActionBanner] = useState<string | null>(null);
  const [showChatHub, setShowChatHub] = useState<boolean>(false);

  const openChatHub = useCallback(() => {
    if (!showChatHub && typeof window !== 'undefined') {
      try {
        window.history.pushState({ alwaleedSupervisorChat: true }, '');
      } catch {
        // ignore
      }
    }
    setShowChatHub(true);
  }, [showChatHub]);

  const closeChatHub = useCallback(() => {
    setShowChatHub(false);
  }, []);

  useEffect(() => {
    const onPopState = () => {
      if (showChatHub) {
        setShowChatHub(false);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [showChatHub]);

  const hasDataRef = useRef(false);
  hasDataRef.current = Boolean(data);

  const cacheKey = useMemo(() => {
    const id = allowSupervisorSelector ? selectedSupervisorId : String(supervisorRecord?.id || 'me');
    return `alwaleed_supervisor_cache_${id}`;
  }, [allowSupervisorSelector, selectedSupervisorId, supervisorRecord?.id]);

  // Load selector list when Super Admin previews Supervisor App
  useEffect(() => {
    if (!allowSupervisorSelector) {
      setSupervisorsLoaded(true);
      return;
    }
    let cancelled = false;
    setSupervisorsLoaded(false);
    apiFetch<{ supervisors: SupervisorRecord[] }>('/api/supervisors')
      .then((res) => {
        if (cancelled) return;
        const list = res.supervisors || [];
        setAllSupervisors(list);
        if (list.length > 0) {
          setSelectedSupervisorId((prev) => {
            if (initialSupervisorId && list.some((s) => String(s.id) === initialSupervisorId)) {
              return initialSupervisorId;
            }
            return prev && list.some((s) => String(s.id) === prev) ? prev : String(list[0].id);
          });
        } else {
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'تعذر تحميل قائمة المشرفات للمعاينة');
        setLoading(false);
      })
      .finally(() => {
        if (!cancelled) setSupervisorsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [allowSupervisorSelector, initialSupervisorId]);

  const loadSupervisorData = useCallback(
    async (silent = false) => {
      if (allowSupervisorSelector && (!supervisorsLoaded || !selectedSupervisorId)) {
        if (supervisorsLoaded && !selectedSupervisorId) setLoading(false);
        return;
      }
      if (silent) setRefreshing(true);
      else if (!hasDataRef.current) setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams();
        if (allowSupervisorSelector && selectedSupervisorId) {
          params.set('asSupervisorId', selectedSupervisorId);
        }
        const res = await apiFetch<SupervisorAppResponse>(
          `/api/supervisor-app/me${params.toString() ? `?${params.toString()}` : ''}`
        );
        setData(res);
        if (res.supervisor?.liveLocation) {
          setLivePosition((prev) => {
            if (!prev) return res.supervisor!.liveLocation!;
            const prevTime = new Date(prev.recordedAt).getTime();
            const srvTime = new Date(res.supervisor!.liveLocation!.recordedAt).getTime();
            return srvTime > prevTime ? res.supervisor!.liveLocation! : prev;
          });
        }
        try {
          localStorage.setItem(cacheKey, JSON.stringify(res));
        } catch {
          // ignore storage limits
        }
        const firstVeh = res.trackedVehicles?.[0];
        if (firstVeh) {
          setActiveVehicleId((prev) =>
            prev && res.trackedVehicles.some((v) => v.vehicleId === prev)
              ? prev
              : firstVeh.vehicleId
          );
        } else {
          setActiveVehicleId(null);
          setSelectedMarker(null);
        }
      } catch (err: unknown) {
        try {
          const cachedRaw = localStorage.getItem(cacheKey);
          if (cachedRaw) {
            setData(JSON.parse(cachedRaw) as SupervisorAppResponse);
            setError(null);
            return;
          }
        } catch {
          // ignore
        }
        setError(err instanceof Error ? err.message : 'تعذر تحميل بيانات المشرفة');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [allowSupervisorSelector, supervisorsLoaded, selectedSupervisorId, cacheKey]
  );

  // Initial load + 10-second visibility-aware live map polling
  useEffect(() => {
    loadSupervisorData();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadSupervisorData(true);
      }
    }, 10000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        loadSupervisorData(true);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [loadSupervisorData]);

  const supervisor = data?.supervisor;
  const school = data?.school;
  const route = data?.route;
  const todayTrip = data?.todayTrip;
  const trackedVehicles = data?.trackedVehicles || [];
  const activeVehicle =
    trackedVehicles.find((v) => v.vehicleId === activeVehicleId) || trackedVehicles[0] || null;

  const transmitSupervisorGps = useCallback(
    async (
      coords: {
        lat: number;
        lng: number;
        speedKmh: number;
        heading: number;
        accuracyMeters: number;
      },
      force = false
    ) => {
      if (!gpsEnabled) return;
      if (!isValidGpsCoordinate(coords.lat, coords.lng)) return;
      const nowMs = Date.now();
      const minInterval = gpsEconomyMode ? 55000 : 4800;
      if (!force && nowMs - lastGpsSentAtRef.current < minInterval) return;
      lastGpsSentAtRef.current = nowMs;

      latestCoordsRef.current = {
        lat: coords.lat,
        lng: coords.lng,
        speedKmh: coords.speedKmh,
        accuracyMeters: coords.accuracyMeters,
      };

      const optimisticLoc: SupervisorLiveLocation = {
        lat: coords.lat,
        lng: coords.lng,
        speedKmh: Math.round(coords.speedKmh),
        accuracyMeters: Math.round(coords.accuracyMeters),
        recordedAt: new Date().toISOString(),
        isLive: true,
      };
      setLivePosition(optimisticLoc);

      setGpsSending(true);
      try {
        const params = new URLSearchParams();
        if (allowSupervisorSelector && selectedSupervisorId) {
          params.set('asSupervisorId', selectedSupervisorId);
        }
        const res = await apiFetch<{ ok: boolean; liveLocation?: SupervisorLiveLocation }>(
          `/api/supervisor-app/gps${params.toString() ? `?${params.toString()}` : ''}`,
          {
            method: 'POST',
            body: JSON.stringify({ ...coords, economyMode: gpsEconomyMode }),
          }
        );
        if (res.liveLocation) {
          setLivePosition(res.liveLocation);
        }
        setGpsPermissionError(null);
      } catch (err: unknown) {
        console.warn('[SupervisorApp] GPS upload warning:', err);
      } finally {
        setGpsSending(false);
      }
    },
    [allowSupervisorSelector, selectedSupervisorId, gpsEnabled, gpsEconomyMode]
  );

  // Auto-Start Live Location (or Economy snapshot) when supervisor has GPS enabled
  useEffect(() => {
    if (allowSupervisorSelector || !data?.linked || !supervisor?.id || !gpsEnabled) {
      return;
    }
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setGpsPermissionError('المتصفح الحالي لا يدعم خدمة تحديد الموقع الجغرافي (GPS).');
      return;
    }

    const estimator = speedEstimatorRef.current;
    estimator.reset();
    let watchId: number | null = null;
    let firstFixCentered = false;
    const geoOptions = gpsEconomyMode ? ECONOMY_GPS_OPTIONS : HIGH_ACCURACY_GPS_OPTIONS;

    const handlePosition = (pos: GeolocationPosition, forceSend: boolean) => {
      setGpsPermissionError(null);
      const est = estimator.compute(pos.coords, pos.timestamp || Date.now());
      const payload = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        speedKmh: est.speedKmh,
        heading: est.heading,
        accuracyMeters: est.accuracyMeters,
      };
      if (!firstFixCentered) {
        firstFixCentered = true;
        setPanTarget({ lat: payload.lat, lng: payload.lng, zoom: 14 });
      }
      transmitSupervisorGps(payload, forceSend);
    };

    const handleGpsError = (err: GeolocationPositionError) => {
      if (err.code === err.PERMISSION_DENIED) {
        setGpsPermissionError('يرجى السماح بالوصول إلى الموقع (GPS) لتشغيل اللايف لوكيشن تلقائياً.');
      } else if (err.code === err.POSITION_UNAVAILABLE) {
        setGpsPermissionError('إشارة الـ GPS غير متاحة حالياً، جاري إعادة المحاولة...');
      }
    };

    navigator.geolocation.getCurrentPosition(
      (pos) => handlePosition(pos, true),
      handleGpsError,
      geoOptions
    );

    // In Economy mode, skip continuous watchPosition to save battery & GPS radio
    if (!gpsEconomyMode) {
      watchId = navigator.geolocation.watchPosition(
        (pos) => handlePosition(pos, false),
        handleGpsError,
        HIGH_ACCURACY_GPS_OPTIONS
      );
    }

    return () => {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
      }
    };
  }, [allowSupervisorSelector, data?.linked, supervisor?.id, gpsEnabled, gpsEconomyMode, transmitSupervisorGps]);

  // Persistent Background Service & WakeLock (disabled in Economy mode to conserve battery)
  useEffect(() => {
    if (allowSupervisorSelector || !data?.linked || !supervisor?.id || !gpsEnabled) {
      setWakeLockActive(false);
      return;
    }

    let wakeLockObj: any = null;
    const requestWakeLock = async () => {
      if (gpsEconomyMode) {
        setWakeLockActive(false);
        return;
      }
      try {
        if ('wakeLock' in navigator && (navigator as any).wakeLock?.request) {
          wakeLockObj = await (navigator as any).wakeLock.request('screen');
          setWakeLockActive(true);
          wakeLockObj.addEventListener('release', () => {
            setWakeLockActive(false);
          });
        }
      } catch {
        setWakeLockActive(false);
      }
    };
    requestWakeLock();

    const intervalMs = gpsEconomyMode ? 60000 : 15000;
    const pollOptions = gpsEconomyMode ? ECONOMY_GPS_OPTIONS : HIGH_ACCURACY_GPS_OPTIONS;

    const bgInterval = window.setInterval(() => {
      if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const est = speedEstimatorRef.current.compute(pos.coords, pos.timestamp || Date.now());
          const payload = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            speedKmh: est.speedKmh,
            heading: est.heading,
            accuracyMeters: est.accuracyMeters,
          };
          transmitSupervisorGps(payload, gpsEconomyMode);
        },
        () => {},
        pollOptions
      );
    }, intervalMs);

    return () => {
      window.clearInterval(bgInterval);
      if (wakeLockObj && typeof wakeLockObj.release === 'function') {
        wakeLockObj.release().catch(() => {});
      }
      setWakeLockActive(false);
    };
  }, [allowSupervisorSelector, data?.linked, supervisor?.id, gpsEnabled, gpsEconomyMode, transmitSupervisorGps]);

  const toggleLiveGps = async () => {
    const next = !gpsEnabled;
    setGpsEnabled(next);
    setGpsPermissionError(null);
    try {
      localStorage.setItem(SUPERVISOR_GPS_PREF_KEY, String(next));
    } catch {
      // ignore
    }

    if (!next) {
      setWakeLockActive(false);
      setLivePosition(null);
      latestCoordsRef.current = null;
      setData((prev) =>
        prev && prev.supervisor
          ? { ...prev, supervisor: { ...prev.supervisor, liveLocation: null } }
          : prev
      );
      try {
        const params = new URLSearchParams();
        if (allowSupervisorSelector && selectedSupervisorId) {
          params.set('asSupervisorId', selectedSupervisorId);
        }
        await apiFetch(
          `/api/supervisor-app/gps/stop${params.toString() ? `?${params.toString()}` : ''}`,
          { method: 'POST' }
        );
      } catch {
        // ignore network errors on stop
      }
    }
  };

  const toggleEconomyMode = () => {
    const next = !gpsEconomyMode;
    setGpsEconomyMode(next);
    try {
      localStorage.setItem(SUPERVISOR_GPS_ECONOMY_KEY, String(next));
    } catch {
      // ignore
    }
  };

  const requestInstantLocationFix = () => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return;
    setGpsPermissionError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const est = speedEstimatorRef.current.compute(pos.coords, pos.timestamp || Date.now());
        const next = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          speedKmh: est.speedKmh,
          heading: est.heading,
          accuracyMeters: est.accuracyMeters,
        };
        setPanTarget({ lat: next.lat, lng: next.lng, zoom: 15 });
        transmitSupervisorGps(next, true);
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setGpsPermissionError('تم رفض إذن الموقع من المتصفح، يرجى تفعيله من إعدادات الموقع ثم إعادة المحاولة.');
        } else {
          setGpsPermissionError('تعذر التقاط إشارة GPS حالياً، تأكدي من تفعيل الموقع بالهاتف.');
        }
      },
      HIGH_ACCURACY_GPS_OPTIONS
    );
  };

  // Capture latest GPS quickly (up to 2s) without blocking mission recording
  const getQuickCoords = async (): Promise<{ lat?: number; lng?: number }> => {
    if (latestCoordsRef.current && isValidGpsCoordinate(latestCoordsRef.current.lat, latestCoordsRef.current.lng)) {
      return { lat: latestCoordsRef.current.lat, lng: latestCoordsRef.current.lng };
    }
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      return {};
    }
    return new Promise((resolve) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({});
        }
      }, 2000);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        },
        () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve({});
        },
        { enableHighAccuracy: true, timeout: 1800, maximumAge: 15000 }
      );
    });
  };

  const handleTripAction = async (action: 'start_morning' | 'end_evening') => {
    if (!supervisor) return;
    setActionBusy(action);
    setActionBanner(null);
    setError(null);

    // Ensure Live Location turns back on when morning trip begins (for real supervisor device)
    if (action === 'start_morning' && !gpsEnabled && !allowSupervisorSelector) {
      setGpsEnabled(true);
      try {
        localStorage.setItem(SUPERVISOR_GPS_PREF_KEY, 'true');
      } catch {
        // ignore
      }
    }

    try {
      const coords = await getQuickCoords();
      const params = new URLSearchParams();
      if (allowSupervisorSelector && selectedSupervisorId) {
        params.set('asSupervisorId', selectedSupervisorId);
      }

      const res = await apiFetch<{ ok: boolean; todayTrip: SupervisorTripRecord }>(
        `/api/supervisor-app/trip-action${params.toString() ? `?${params.toString()}` : ''}`,
        {
          method: 'POST',
          body: JSON.stringify({ action, ...coords }),
        }
      );

      setData((prev) => (prev ? { ...prev, todayTrip: res.todayTrip } : prev));
      const loggedTime =
        action === 'start_morning'
          ? formatArabicTimestampTime(res.todayTrip.morningStartedAt)
          : formatArabicTimestampTime(res.todayTrip.eveningEndedAt);
      setActionBanner(
        action === 'start_morning'
          ? `تم تسجيل (بدأت الرحلة) بنجاح الساعة ${loggedTime}`
          : `تم تسجيل (انتهاء الرحلة) بنجاح الساعة ${loggedTime}`
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تسجيل حالة الرحلة');
    } finally {
      setActionBusy(null);
    }
  };

  const effectiveLiveLocation = livePosition || supervisor?.liveLocation || null;

  const initialMapCenter = useMemo(() => {
    if (effectiveLiveLocation && isValidGpsCoordinate(effectiveLiveLocation.lat, effectiveLiveLocation.lng)) {
      return { lat: effectiveLiveLocation.lat, lng: effectiveLiveLocation.lng };
    }
    if (activeVehicle?.gps) {
      return { lat: activeVehicle.gps.lat, lng: activeVehicle.gps.lng };
    }
    if (school && school.lat && school.lng) {
      return { lat: school.lat, lng: school.lng };
    }
    return ALEXANDRIA_CENTER;
  }, [
    effectiveLiveLocation?.lat,
    effectiveLiveLocation?.lng,
    activeVehicle?.gps?.lat,
    activeVehicle?.gps?.lng,
    school?.lat,
    school?.lng,
  ]);

  return (
    <div className="min-h-screen bg-[#eef2f7] relative flex flex-col">
      <AppLogoBackdrop />

      {/* Top Navigation Shell */}
      <header
        className={`sticky ${
          hasPreviewBar ? 'top-12' : 'top-0'
        } z-30 h-14 bg-[#0B1F3A] text-white border-b border-slate-800 px-4`}
      >
        <div className="max-w-4xl mx-auto h-full flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <DriverAvatar
              name={supervisor?.fullName || 'مشرفة'}
              photoUrl={supervisor?.photoUrl}
              size="sm"
              variant="dark"
            />
            <div className="min-w-0">
              <div className="font-display text-sm font-bold truncate">
                {supervisor ? supervisor.fullName : 'بوابة المشرفة · الوليد ترافيل'}
              </div>
              {supervisor && (
                <div className="text-[11px] text-slate-300 font-mono tabular-nums truncate">
                  كود المشرفة: {supervisor.supervisorCode}
                  {school ? ` · ${school.name}` : ''}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {showChatHub ? (
              <button
                type="button"
                onClick={closeChatHub}
                className="min-h-[38px] inline-flex items-center gap-1.5 rounded-lg bg-[#C89B3C] hover:bg-[#d8ac4e] px-3 text-xs font-bold text-[#0B1F3A] cursor-pointer"
              >
                <ArrowRight className="w-4 h-4" />
                <span>العودة للقائمة السابقة</span>
              </button>
            ) : (
              data?.linked && (
                <button
                  type="button"
                  onClick={openChatHub}
                  className="min-h-[38px] inline-flex items-center gap-1.5 rounded-lg bg-white/10 hover:bg-white/20 px-3 text-xs font-semibold text-white cursor-pointer"
                >
                  <MessageSquare className="w-4 h-4 text-[#C89B3C]" />
                  <span>المحادثات</span>
                </button>
              )
            )}

            {allowSupervisorSelector && allSupervisors.length > 0 && (
              <select
                value={selectedSupervisorId}
                onChange={(e) => {
                  setSelectedMarker(null);
                  setLivePosition(null);
                  setSelectedSupervisorId(e.target.value);
                }}
                aria-label="اختيار مشرفة للمعاينة"
                className="rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#C89B3C]"
              >
                {allSupervisors.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fullName} ({s.supervisorCode})
                  </option>
                ))}
              </select>
            )}

            {!allowSupervisorSelector && <PWAInstallButton variant="dark" />}

            {!allowSupervisorSelector && (
              <button
                onClick={logout}
                title="تسجيل الخروج"
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-200 transition-colors cursor-pointer"
              >
                <LogOut className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="app-glass-cards relative z-10 flex-1 w-full max-w-4xl mx-auto px-4 py-5 space-y-5">
        {allowSupervisorSelector && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900 flex items-center justify-between gap-3">
            <span>وضع معاينة نسخة المشرفة (حساب المدير العام)</span>
            <span className="font-semibold">عرض معزول بدون أي بيانات مالية</span>
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700 flex items-center justify-between gap-2">
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

        {loading && !data ? (
          allowSupervisorSelector ? (
            <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-sm text-slate-500">
              جاري تحميل ملف المشرفة للمعاينة...
            </div>
          ) : (
            <SplashScreen message="جاري تحميل بيانات المشرفة وتشغيل اللايف لوكيشن..." />
          )
        ) : allowSupervisorSelector && supervisorsLoaded && allSupervisors.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-amber-50 text-[#C89B3C] flex items-center justify-center mx-auto border border-amber-200">
              <UserCheck className="w-6 h-6" />
            </div>
            <h2 className="font-display text-lg font-bold text-[#0B1F3A]">
              لا توجد مشرفات مسجلات للمعاينة حالياً
            </h2>
            <p className="text-sm text-slate-600 max-w-md mx-auto">
              يمكنك إضافة حساب مشرفة من قسم «إدارة المشرفات» وتعيين المدرسة والباص وخط السير لها.
            </p>
          </div>
        ) : !data?.linked || !supervisor ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center space-y-4">
            <div className="w-12 h-12 rounded-2xl bg-amber-50 text-[#C89B3C] flex items-center justify-center mx-auto border border-amber-200">
              <UserCheck className="w-6 h-6" />
            </div>
            <h2 className="font-display text-lg font-bold text-[#0B1F3A]">
              الحساب غير مرتبط بملف مشرفة بعد
            </h2>
            <p className="text-sm text-slate-600 max-w-md mx-auto">
              تم التحقق من الحساب ({dbUser?.email})، ولكن لم يتم ربطه بسجل مشرفة في النظام.
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => loadSupervisorData()}
                className="min-h-[44px] inline-flex items-center gap-2 rounded-xl bg-[#0B1F3A] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#13325c] cursor-pointer"
              >
                <RefreshCw className="w-4 h-4" />
                إعادة التحقق
              </button>
              {!allowSupervisorSelector && (
                <button
                  onClick={logout}
                  className="min-h-[44px] inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  تسجيل الخروج
                </button>
              )}
            </div>
          </div>
        ) : showChatHub ? (
          <div className="space-y-4">
            <ChatHubModule
              currentRole="supervisor"
              initialRoomKey={route ? `route_${route.id}` : 'broadcast'}
              onClose={closeChatHub}
            />
          </div>
        ) : (
          <>
            {/* 1. Supervisor Identity Card (Photo, Name, Mobile, Code ONLY) */}
            <section className="relative overflow-hidden rounded-2xl bg-[#0B1F3A] text-white p-5 sm:p-6">
              <img
                src={travelBackdropImg}
                alt=""
                referrerPolicy="no-referrer"
                className="absolute inset-0 w-full h-full object-cover opacity-30 pointer-events-none select-none"
              />
              <div
                aria-hidden="true"
                className="hidden sm:block absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none select-none"
              >
                <div className="w-36 h-36 rounded-full overflow-hidden opacity-45 ring-1 ring-[#C89B3C]/40 shadow-2xl">
                  <img
                    src={splashScreenImg}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover object-center scale-110"
                  />
                </div>
              </div>
              <div className="absolute inset-0 bg-gradient-to-l from-[#0B1F3A]/90 via-[#0B1F3A]/60 to-transparent pointer-events-none" />

              <div className="relative z-10 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center gap-3.5">
                    <DriverAvatar
                      name={supervisor.fullName}
                      photoUrl={supervisor.photoUrl}
                      size="lg"
                      variant="dark"
                    />
                    <div className="space-y-1">
                      <p className="text-xs font-semibold text-[#ebd089]">
                        نسخة المشرفة · الوليد ترافيل
                      </p>
                      <h1 className="font-display text-2xl font-bold">{supervisor.fullName}</h1>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={openChatHub}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-[#C89B3C] hover:bg-[#d8ac4e] px-3.5 py-2 text-xs font-bold text-[#0B1F3A] cursor-pointer"
                    >
                      <RadioTower className="w-4 h-4" />
                      غرفة محادثة الخط
                    </button>
                    <span
                      className={`text-xs font-bold ${
                        supervisor.accountStatus === 'active' ? 'text-emerald-300' : 'text-amber-300'
                      }`}
                    >
                      {supervisor.accountStatus === 'active' ? 'حساب نشط' : 'غير نشط'}
                    </span>
                  </div>
                </div>

                <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4 pt-4 border-t border-white/15 text-sm">
                  <div>
                    <dt className="text-xs text-slate-300">الكود المخصص</dt>
                    <dd className="font-mono font-bold text-[#C89B3C] text-base tabular-nums mt-0.5">
                      {supervisor.supervisorCode}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-300">رقم الموبايل</dt>
                    <dd className="mt-0.5 font-mono font-semibold tabular-nums" dir="ltr">
                      <a
                        href={`tel:${supervisor.phone}`}
                        className="inline-flex items-center gap-1.5 text-white hover:text-[#ebd089]"
                      >
                        <Phone className="w-3.5 h-3.5 text-[#C89B3C]" />
                        {supervisor.phone}
                      </a>
                    </dd>
                  </div>
                  {school && (
                    <div className="col-span-2 sm:col-span-1">
                      <dt className="text-xs text-slate-300">المدرسة</dt>
                      <dd className="font-semibold text-white mt-0.5 truncate">{school.name}</dd>
                    </div>
                  )}
                </dl>
              </div>
            </section>

            <MorningSpiritualRibbon compact />

            {/* 2. Live Location Control Card (Auto-Start + Close Option + Economy Mode) */}
            <section className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                      !allowSupervisorSelector && gpsEnabled && !gpsPermissionError
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        : effectiveLiveLocation?.isLive
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        : 'bg-slate-100 text-slate-500 border border-slate-200'
                    }`}
                  >
                    {!allowSupervisorSelector && gpsEnabled && !gpsPermissionError ? (
                      <Signal className="w-5 h-5" />
                    ) : effectiveLiveLocation?.isLive ? (
                      <Signal className="w-5 h-5" />
                    ) : (
                      <SignalZero className="w-5 h-5" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-[#0B1F3A] flex flex-wrap items-center gap-2">
                      <span>اللايف لوكيشن (الموقع المباشر)</span>
                      {gpsEnabled && gpsEconomyMode && (
                        <span className="text-[11px] font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-md">
                          وضع الاقتصاد نشط
                        </span>
                      )}
                      {gpsSending && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#C89B3C]" />}
                    </div>
                    <p className="text-xs text-slate-600 mt-0.5 tabular-nums">
                      {allowSupervisorSelector
                        ? effectiveLiveLocation?.recordedAt
                          ? `آخر موقع مسجل للمشرفة ${formatRelativeArabicTime(effectiveLiveLocation.recordedAt)}`
                          : 'اللايف لوكيشن مغلق أو لم يتم تسجيل موقع بعد'
                        : !gpsEnabled
                        ? 'تم إغلاق اللايف لوكيشن بناءً على رغبتك — يمكنك إعادة تشغيله في أي وقت'
                        : gpsPermissionError
                        ? gpsPermissionError
                        : effectiveLiveLocation?.recordedAt
                        ? `${gpsEconomyMode ? 'وضع اقتصاد البطارية (تحديث كل 60ث)' : 'بث فوري عالي الدقة'} · آخر تحديث ${formatRelativeArabicTime(effectiveLiveLocation.recordedAt)} (دقة ${effectiveLiveLocation.accuracyMeters ?? 15} م)`
                        : 'جاري تشغيل اللايف لوكيشن وتحديد الموقع تلقائياً...'}
                    </p>
                  </div>
                </div>

                {!allowSupervisorSelector && (
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {gpsEnabled && (
                      <button
                        type="button"
                        onClick={requestInstantLocationFix}
                        className="min-h-[40px] inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 px-3 text-xs font-semibold text-[#0B1F3A] cursor-pointer"
                      >
                        <Navigation className="w-3.5 h-3.5 text-[#C89B3C]" />
                        تحديث الموقع
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={toggleEconomyMode}
                      className={`min-h-[40px] inline-flex items-center gap-1.5 rounded-xl border px-3 text-xs font-bold cursor-pointer transition-colors ${
                        gpsEconomyMode
                          ? 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                      title="تقليل استهلاك البطارية والإنترنت بتحديث الموقع كل 60 ثانية"
                    >
                      <BatteryCharging className="w-3.5 h-3.5" />
                      {gpsEconomyMode ? 'إلغاء وضع الاقتصاد' : 'اقتصاد اللوكيشن'}
                    </button>

                    <button
                      type="button"
                      onClick={toggleLiveGps}
                      className={`min-h-[40px] inline-flex items-center gap-1.5 rounded-xl px-3.5 text-xs font-bold cursor-pointer transition-colors ${
                        gpsEnabled
                          ? 'border border-red-200 bg-red-50 hover:bg-red-100 text-red-700'
                          : 'bg-emerald-600 hover:bg-emerald-700 text-white'
                      }`}
                    >
                      {gpsEnabled ? (
                        <>
                          <PowerOff className="w-3.5 h-3.5" />
                          <span>إغلاق اللايف لوكيشن</span>
                        </>
                      ) : (
                        <>
                          <Signal className="w-3.5 h-3.5" />
                          <span>تشغيل اللايف لوكيشن</span>
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            </section>

            {/* Background Location Tracking / Economy Persistence Notice */}
            {gpsEnabled && (
              <div className="rounded-xl border border-blue-200 bg-blue-50/70 p-3.5 text-xs text-blue-900 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  {gpsEconomyMode ? (
                    <BatteryCharging className="w-4 h-4 text-emerald-700 shrink-0" />
                  ) : (
                    <Navigation className="w-4 h-4 text-[#C89B3C] shrink-0" />
                  )}
                  <span>
                    {gpsEconomyMode ? (
                      <>
                        <strong>وضع اقتصاد اللوكيشن مفعل:</strong> يتم إرسال الموقع كل 60 ثانية بدقة اقتصادية للحفاظ على شحن البطارية والباقة.
                      </>
                    ) : (
                      <>
                        <strong>تتبع الموقع في الخلفية نشط (06:00 ص – 04:00 م):</strong> يستمر إرسال الإحداثيات تلقائياً حتى عند تصغير التطبيق.
                      </>
                    )}
                  </span>
                </div>
                <span className="text-[11px] font-mono font-semibold bg-blue-100 text-blue-800 px-2 py-0.5 rounded shrink-0">
                  {gpsEconomyMode
                    ? 'اقتصادي · 60ث'
                    : wakeLockActive
                    ? 'حماية السبات نشطة'
                    : 'وضع الخلفية'}
                </span>
              </div>
            )}

            {/* 3. Two Daily Trip Missions When Boarding the Bus */}
            <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="font-display text-base font-bold text-[#0B1F3A]">
                    مهام الرحلة اليومية عند ركوب الباص
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    اختاري المهمة المطلوبة فور ركوب الباص لتسجيل الوقت والموقع تلقائياً
                  </p>
                </div>
                {todayTrip?.tripDate && (
                  <span className="font-mono text-xs text-slate-500 tabular-nums">
                    {todayTrip.tripDate}
                  </span>
                )}
              </div>

              {actionBanner && (
                <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-2.5 text-xs font-semibold text-emerald-800 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span>{actionBanner}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActionBanner(null)}
                    aria-label="إغلاق"
                    className="p-1 text-emerald-600 hover:text-emerald-900 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                {/* Mission 1: Start Trip Morning */}
                <button
                  type="button"
                  disabled={actionBusy !== null}
                  onClick={() => handleTripAction('start_morning')}
                  className={`min-h-[76px] w-full text-right rounded-2xl border-2 p-4 transition-all cursor-pointer disabled:opacity-60 flex items-center justify-between gap-3 ${
                    todayTrip?.morningStartedAt
                      ? 'border-emerald-500 bg-emerald-50/70 hover:bg-emerald-50'
                      : 'border-[#0B1F3A] bg-[#0B1F3A] text-white hover:bg-[#13325c]'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${
                        todayTrip?.morningStartedAt
                          ? 'bg-emerald-600 text-white'
                          : 'bg-[#C89B3C] text-[#0B1F3A]'
                      }`}
                    >
                      {actionBusy === 'start_morning' ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : todayTrip?.morningStartedAt ? (
                        <CheckCircle2 className="w-5 h-5" />
                      ) : (
                        <Sun className="w-5 h-5" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div
                        className={`font-display text-base font-bold ${
                          todayTrip?.morningStartedAt ? 'text-emerald-950' : 'text-white'
                        }`}
                      >
                        بدأت الرحلة
                      </div>
                      <div
                        className={`text-xs mt-0.5 tabular-nums ${
                          todayTrip?.morningStartedAt ? 'text-emerald-700 font-semibold' : 'text-slate-200'
                        }`}
                      >
                        {todayTrip?.morningStartedAt
                          ? `تم التسجيل الساعة ${formatArabicTimestampTime(todayTrip.morningStartedAt)}`
                          : 'اضغطي عند ركوب الباص'}
                      </div>
                    </div>
                  </div>
                </button>

                {/* Mission 2: End Trip Evening */}
                <button
                  type="button"
                  disabled={actionBusy !== null}
                  onClick={() => handleTripAction('end_evening')}
                  className={`min-h-[76px] w-full text-right rounded-2xl border-2 p-4 transition-all cursor-pointer disabled:opacity-60 flex items-center justify-between gap-3 ${
                    todayTrip?.eveningEndedAt
                      ? 'border-emerald-500 bg-emerald-50/70 hover:bg-emerald-50'
                      : 'border-[#C89B3C] bg-amber-50 hover:bg-amber-100/80 text-[#0B1F3A]'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${
                        todayTrip?.eveningEndedAt
                          ? 'bg-emerald-600 text-white'
                          : 'bg-[#0B1F3A] text-[#C89B3C]'
                      }`}
                    >
                      {actionBusy === 'end_evening' ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : todayTrip?.eveningEndedAt ? (
                        <CheckCircle2 className="w-5 h-5" />
                      ) : (
                        <Moon className="w-5 h-5" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div
                        className={`font-display text-base font-bold ${
                          todayTrip?.eveningEndedAt ? 'text-emerald-950' : 'text-[#0B1F3A]'
                        }`}
                      >
                        انتهاء الرحلة
                      </div>
                      <div
                        className={`text-xs mt-0.5 tabular-nums ${
                          todayTrip?.eveningEndedAt ? 'text-emerald-700 font-semibold' : 'text-slate-600'
                        }`}
                      >
                        {todayTrip?.eveningEndedAt
                          ? `تم التسجيل الساعة ${formatArabicTimestampTime(todayTrip.eveningEndedAt)}`
                          : 'اضغطي عند انتهاء الرحلة'}
                      </div>
                    </div>
                  </div>
                </button>
              </div>
            </section>

            {/* 4. Route, School & Bus Assignment Card (Clean Operational View) */}
            <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Route className="w-4 h-4 text-[#C89B3C]" />
                  <h2 className="font-display text-base font-bold text-[#0B1F3A]">
                    تفاصيل خط السير والباص
                  </h2>
                </div>
                {route?.estimatedDistanceKm ? (
                  <span className="text-xs font-mono font-semibold text-slate-500 tabular-nums">
                    المسافة التقريبية: {route.estimatedDistanceKm} كم
                  </span>
                ) : null}
              </div>

              <dl className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 divide-slate-100 text-sm">
                <div className="px-5 py-3.5 sm:border-b sm:border-l border-slate-100">
                  <dt className="text-xs text-slate-500">خط السير المعين</dt>
                  <dd className="font-bold text-[#0B1F3A] mt-1">
                    {route?.name || activeVehicle?.routeName || 'غير محدد'}
                  </dd>
                  {(route?.pickupArea || route?.dropoffArea) && (
                    <p className="text-xs text-slate-500 mt-1">
                      {route?.pickupArea ? `الانطلاق: ${route.pickupArea}` : ''}
                      {route?.pickupArea && route?.dropoffArea ? ' · ' : ''}
                      {route?.dropoffArea ? `الوصول: ${route.dropoffArea}` : ''}
                    </p>
                  )}
                </div>

                <div className="px-5 py-3.5 sm:border-b border-slate-100">
                  <dt className="text-xs text-slate-500">المدرسة والموقع</dt>
                  <dd className="font-bold text-[#0B1F3A] mt-1">{school?.name || 'غير محدد'}</dd>
                  {school?.address && (
                    <p className="text-xs text-slate-500 mt-0.5">{school.address}</p>
                  )}
                </div>

                <div className="px-5 py-3.5 sm:col-span-2">
                  <dt className="text-xs text-slate-500">الباص والسائق المسؤول</dt>
                  {activeVehicle ? (
                    <dd className="mt-1 flex flex-wrap items-center justify-between gap-2">
                      <div className="font-bold text-[#0B1F3A] tabular-nums">
                        باص {activeVehicle.busNumber} ·{' '}
                        <span className="font-mono text-xs text-slate-600">
                          {activeVehicle.registrationNumber}
                        </span>
                      </div>
                      <div className="text-xs text-slate-600 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span>السائق: {activeVehicle.driverName}</span>
                        {activeVehicle.driverPhone && (
                          <a
                            href={`tel:${activeVehicle.driverPhone}`}
                            className="font-mono font-semibold text-[#0B1F3A] hover:text-[#C89B3C] inline-flex items-center gap-1"
                            dir="ltr"
                          >
                            <Phone className="w-3 h-3 text-[#C89B3C]" />
                            {activeVehicle.driverPhone}
                          </a>
                        )}
                      </div>
                    </dd>
                  ) : (
                    <dd className="text-xs text-slate-500 mt-1">لم يتم ربط مركبة بالخط بعد</dd>
                  )}
                </div>
              </dl>
            </section>

            {/* 5. Live Location Tracking Map */}
            <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-display text-base font-bold text-[#0B1F3A]">
                    خريطة التتبع المباشر
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    عرض موقع المشرفة المباشر وحركة الباص والمدرسة لحظياً
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {trackedVehicles.length > 1 && (
                    <select
                      value={activeVehicle?.vehicleId || ''}
                      onChange={(e) => {
                        const id = Number(e.target.value);
                        setSelectedMarker(null);
                        setActiveVehicleId(id);
                        const matched = trackedVehicles.find((v) => v.vehicleId === id);
                        if (matched?.gps) {
                          setPanTarget({ lat: matched.gps.lat, lng: matched.gps.lng, zoom: 14 });
                        }
                      }}
                      className="min-h-[40px] rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-[#0B1F3A]"
                    >
                      {trackedVehicles.map((v) => (
                        <option key={v.vehicleId} value={v.vehicleId}>
                          باص {v.busNumber} ({v.driverName})
                        </option>
                      ))}
                    </select>
                  )}

                  {effectiveLiveLocation && (
                    <button
                      type="button"
                      onClick={() =>
                        setPanTarget({
                          lat: effectiveLiveLocation.lat,
                          lng: effectiveLiveLocation.lng,
                          zoom: 15,
                        })
                      }
                      className="min-h-[40px] inline-flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 font-semibold text-emerald-800 hover:bg-emerald-100 cursor-pointer"
                    >
                      <MapPin className="w-3.5 h-3.5" />
                      موقعي الآن
                    </button>
                  )}

                  {activeVehicle?.gps && (
                    <button
                      type="button"
                      onClick={() =>
                        setPanTarget({
                          lat: activeVehicle.gps!.lat,
                          lng: activeVehicle.gps!.lng,
                          zoom: 15,
                        })
                      }
                      className="min-h-[40px] inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 font-semibold text-[#0B1F3A] hover:bg-slate-50 cursor-pointer"
                    >
                      <Navigation className="w-3.5 h-3.5 text-[#C89B3C]" />
                      تركيز على الباص
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => loadSupervisorData(true)}
                    className="min-h-[40px] inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                    تحديث
                  </button>
                </div>
              </div>

              {/* Active Vehicle Telemetry Strip */}
              {activeVehicle && (
                <div className="px-5 py-3 bg-slate-50/70 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3 text-xs tabular-nums">
                  <div className="flex items-center gap-2.5">
                    {activeVehicle.isOnline ? (
                      <span className="inline-flex items-center gap-1 font-bold text-emerald-700">
                        <Signal className="w-3.5 h-3.5" />
                        متصل مباشر
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 font-bold text-amber-700">
                        <SignalZero className="w-3.5 h-3.5" />
                        {activeVehicle.gps?.statusLabel || 'غير متصل حالياً'}
                      </span>
                    )}
                    <span className="text-slate-300">|</span>
                    <span className="font-mono font-bold text-[#0B1F3A]">
                      باص {activeVehicle.busNumber}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-4 text-slate-600">
                    <span>
                      السرعة:{' '}
                      <strong className="font-mono text-[#0B1F3A]">
                        {activeVehicle.gps ? activeVehicle.gps.speedKmh : 0} كم/س
                      </strong>
                    </span>
                    <span>
                      آخر تحديث:{' '}
                      <strong>
                        {activeVehicle.gps?.recordedAt
                          ? formatRelativeArabicTime(activeVehicle.gps.recordedAt)
                          : 'لا يوجد'}
                      </strong>
                    </span>
                  </div>
                </div>
              )}

              {/* Explicit Height Container for Google Maps */}
              <div className="h-[380px] sm:h-[460px] w-full relative">
                {!hasValidApiKey ? (
                  <div className="h-full flex flex-col items-center justify-center p-6 text-center text-sm text-slate-500">
                    مفتاح خرائط جوجل (VITE_GOOGLE_MAPS_API_KEY) غير متوفر أو غير صالح في البيئة.
                  </div>
                ) : (
                  <APIProvider apiKey={apiKey} libraries={['marker']} language="ar" region="EG">
                    <GoogleMap
                      mapId="DEMO_MAP_ID"
                      defaultCenter={initialMapCenter}
                      defaultZoom={13}
                      gestureHandling="greedy"
                      internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
                      style={{ width: '100%', height: '100%' }}
                    >
                      <MapPanController target={panTarget} />

                      {/* Supervisor Live Position Marker */}
                      {effectiveLiveLocation &&
                        isValidGpsCoordinate(effectiveLiveLocation.lat, effectiveLiveLocation.lng) && (
                          <AdvancedMarker
                            position={{
                              lat: effectiveLiveLocation.lat,
                              lng: effectiveLiveLocation.lng,
                            }}
                            zIndex={1200}
                            title={`موقع المشرفة: ${supervisor.fullName}`}
                          >
                            <div className="px-2.5 py-1.5 rounded-xl bg-emerald-600 text-white border-2 border-white shadow-lg flex items-center gap-1.5 text-[11px] font-bold">
                              <MapPin className="w-3.5 h-3.5" />
                              <span>موقع المشرفة المباشر</span>
                            </div>
                          </AdvancedMarker>
                        )}

                      {/* School Marker */}
                      {school && Number.isFinite(school.lat) && Number.isFinite(school.lng) && (
                        <AdvancedMarker
                          position={{ lat: school.lat, lng: school.lng }}
                          zIndex={10}
                          title={school.name}
                        >
                          <div className="px-2.5 py-1 rounded-lg bg-white text-[#0B1F3A] border-2 border-[#C89B3C] shadow-md flex items-center gap-1.5 text-[11px] font-bold">
                            <School className="w-3.5 h-3.5 text-[#C89B3C]" />
                            <span>{school.name}</span>
                          </div>
                        </AdvancedMarker>
                      )}

                      {/* Tracked Vehicles Markers */}
                      {trackedVehicles
                        .filter((v) => v.gps)
                        .map((v, idx) => (
                          <AdvancedMarkerWithRef
                            key={v.vehicleId}
                            position={{ lat: v.gps!.lat, lng: v.gps!.lng }}
                            zIndex={activeVehicle?.vehicleId === v.vehicleId ? 1000 : 100 + idx}
                            onMarkerClick={(marker) => {
                              setActiveVehicleId(v.vehicleId);
                              setSelectedMarker(marker);
                            }}
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

                      {activeVehicle && selectedMarker && activeVehicle.gps && (
                        <InfoWindow
                          anchor={selectedMarker}
                          onCloseClick={() => setSelectedMarker(null)}
                        >
                          <div className="p-1 text-right text-xs min-w-[200px]" dir="rtl">
                            <div className="font-bold text-[#0B1F3A] text-sm">
                              باص {activeVehicle.busNumber} · {activeVehicle.routeName}
                            </div>
                            <div className="mt-1 text-slate-700">
                              السائق: {activeVehicle.driverName}
                            </div>
                            <div className="mt-1 font-semibold">
                              الحالة: {activeVehicle.gps.statusLabel}
                            </div>
                            <div className="mt-1 font-mono text-slate-600 tabular-nums">
                              السرعة: {activeVehicle.gps.speedKmh} كم/س
                            </div>
                            <div className="mt-1 text-slate-500">
                              آخر تحديث: {formatRelativeArabicTime(activeVehicle.gps.recordedAt)}
                            </div>
                          </div>
                        </InfoWindow>
                      )}

                      {activeVehicle && activeVehicle.trail.length >= 2 && (
                        <RouteTrailOverlay points={activeVehicle.trail} />
                      )}
                    </GoogleMap>
                  </APIProvider>
                )}
              </div>
            </section>
          </>
        )}
      </main>

      <CompanyLegalFooter variant="light" className="mt-auto" />
    </div>
  );
};
