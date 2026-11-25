import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Bell,
  BellRing,
  Bus,
  Check,
  CheckCheck,
  Clock,
  Compass,
  FileText,
  Gauge,
  Home,
  LogOut,
  MapPin,
  MessageSquare,
  Navigation,
  PauseCircle,
  Phone,
  PlayCircle,
  RadioTower,
  RefreshCw,
  ShieldAlert,
  UserCheck,
  Volume2,
  VolumeX,
  Wallet,
  Wifi,
  WifiOff,
  Wrench,
  X,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { AppVersionBadge } from '../AppVersionBadge';
import {
  ApiHttpError,
  apiFetch,
  formatArabicTripTime,
  formatEGP,
  formatRelativeArabicTime,
} from '../../lib/api';
import {
  flushQueuedGpsPoints,
  getDailyScheduleStatus,
  HIGH_ACCURACY_GPS_OPTIONS,
  HighPrecisionSpeedEstimator,
  requestBackgroundSyncRegistration,
  transmitOrQueueGpsFix,
  type ScheduleWindowStatus,
} from '../../lib/gps-tracker';
import {
  getCachedDriverProfile,
  getPendingLicenseSyncs,
  getQueuedGpsPoints,
  queuePendingLicenseSync,
  removePendingLicenseSync,
  saveCachedDriverProfile,
} from '../../lib/local-store';
import {
  ensureDriverNotificationSwRegistered,
  getAnnouncedNotificationIds,
  getBgNotifyEnabled,
  getBgVoiceEnabled,
  getNotificationPermission,
  isSpeechSynthesisAvailable,
  playNotificationChime,
  requestDriverNotificationPermission,
  saveAnnouncedNotificationIds,
  setBgNotifyEnabledPref,
  setBgVoiceEnabledPref,
  showSystemNotification,
  speakArabicText,
  speakNotificationsQueue,
  stopArabicSpeech,
} from '../../lib/background-notifications';
import { AppLogoBackdrop } from '../AppLogoBackdrop';
import { ChatHubModule } from '../chat/ChatHubModule';
import { CompanyLegalFooter } from '../CompanyLegalFooter';
import { DriverAvatar } from '../DriverAvatar';
import { DriverLicensesSection } from '../DriverLicensesSection';
import { MorningSpiritualRibbon } from '../MorningSpiritualRibbon';
import { SpeedometerGauge } from './SpeedometerGauge';
import { DriverMaintenanceVoiceModule } from './DriverMaintenanceVoiceModule';
import { EmployeeDailyReportModal } from '../employee/EmployeeDailyReportModal';
import { PWAInstallButton } from '../PWAInstall';
import { SplashScreen } from '../SplashScreen';
import splashScreenImg from '../../assets/images/alwaleed_splash_screen_1794752422708.jpg';
import travelBackdropImg from '../../assets/images/alwaleed_travel_backdrop_1794752421692.jpg';
import type {
  AdvanceRecord,
  CoverageRecord,
  DriverLicensePhoto,
  EnrichedDriver,
  FinancialTransaction,
  NotificationItem,
  SalaryRecord,
  SchoolBillingRange,
} from '../../types';

interface DriverAppResponse {
  linked: boolean;
  period?: { month: number; year: number; startDate?: string; endDate?: string };
  billingRange?: SchoolBillingRange;
  driver: EnrichedDriver | null;
  salary?: SalaryRecord;
  advances?: AdvanceRecord[];
  coverages?: CoverageRecord[];
  transactions?: FinancialTransaction[];
  notifications?: NotificationItem[];
  gps?: {
    vehicleGpsStatus: string;
    latestGps: {
      id: number;
      lat: number;
      lng: number;
      speedKmh: number;
      accuracyMeters: number | null;
      recordedAt: string;
      isLive: boolean;
    } | null;
  };
}

type DriverTab = 'home' | 'finance' | 'chat' | 'location' | 'notifications' | 'maintenance';

const ARABIC_MONTHS = [
  'يناير',
  'فبراير',
  'مارس',
  'أبريل',
  'مايو',
  'يونيو',
  'يوليو',
  'أغسطس',
  'سبتمبر',
  'أكتوبر',
  'نوفمبر',
  'ديسمبر',
];

export const DriverApp: React.FC<{
  allowDriverSelector?: boolean;
  hasPreviewBar?: boolean;
}> = ({
  allowDriverSelector = false,
  hasPreviewBar = false,
}) => {
  const { dbUser, driverRecord, logout } = useAuth();
  const now = new Date();
  const [activeTab, setActiveTab] = useState<DriverTab>('home');
  const [tabHistory, setTabHistory] = useState<DriverTab[]>([]);
  const [chatInitialRoomKey, setChatInitialRoomKey] = useState<string | undefined>(undefined);
  const [month, setMonth] = useState<number>(now.getMonth() + 1);
  const [year, setYear] = useState<number>(now.getFullYear());

  const tabHistoryRef = useRef<DriverTab[]>([]);
  tabHistoryRef.current = tabHistory;
  const activeTabRef = useRef<DriverTab>('home');
  activeTabRef.current = activeTab;

  const navigateTab = useCallback((nextTab: DriverTab, chatRoomKey?: string) => {
    if (chatRoomKey !== undefined) {
      setChatInitialRoomKey(chatRoomKey);
    }
    if (nextTab !== activeTabRef.current) {
      setTabHistory((prev) => [...prev.slice(-19), activeTabRef.current]);
      setActiveTab(nextTab);
      try {
        window.history.pushState({ alwaleedDriverTab: nextTab }, '');
      } catch {
        // ignore history errors
      }
    }
  }, []);

  const goBackTab = useCallback(() => {
    if (tabHistoryRef.current.length > 0) {
      const next = [...tabHistoryRef.current];
      const prevTab = next.pop()!;
      setTabHistory(next);
      setActiveTab(prevTab);
    } else if (activeTabRef.current !== 'home') {
      setActiveTab('home');
    }
  }, []);

  useEffect(() => {
    const onPopState = () => {
      if (tabHistoryRef.current.length > 0) {
        const next = [...tabHistoryRef.current];
        const prevTab = next.pop()!;
        setTabHistory(next);
        setActiveTab(prevTab);
      } else if (activeTabRef.current !== 'home') {
        setActiveTab('home');
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const [allDrivers, setAllDrivers] = useState<EnrichedDriver[]>([]);
  const [driversLoaded, setDriversLoaded] = useState(!allowDriverSelector);
  const [selectedDriverId, setSelectedDriverId] = useState<string>('');
  const [data, setData] = useState<DriverAppResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Connectivity & Offline Queues
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine !== false : true
  );
  const [queuedGpsCount, setQueuedGpsCount] = useState<number>(0);
  const [pendingLicensesCount, setPendingLicensesCount] = useState<number>(0);

  // Live GPS transmission + High-precision speed + Daily schedule (06:00 AM - 04:00 PM)
  const [gpsConsent, setGpsConsent] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('alwaleed_gps_consent');
      if (saved === 'false') return false;
      if (saved === 'true') return true;
      const isStandalone =
        typeof window !== 'undefined' &&
        (window.matchMedia('(display-mode: standalone)').matches ||
          (window.navigator as unknown as { standalone?: boolean }).standalone === true ||
          localStorage.getItem('alwaleed_pwa_installed') === 'true');
      return isStandalone;
    } catch {
      return false;
    }
  });
  const [geoPermState, setGeoPermState] = useState<'granted' | 'prompt' | 'denied' | 'unknown'>(
    'unknown'
  );
  const [scheduleStatus, setScheduleStatus] = useState<ScheduleWindowStatus>(() =>
    getDailyScheduleStatus()
  );
  const [isStreamingGps, setIsStreamingGps] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [gpsSending, setGpsSending] = useState(false);
  const [lastLocalPingAt, setLastLocalPingAt] = useState<string | null>(null);
  const [liveSpeedKmh, setLiveSpeedKmh] = useState<number>(0);
  const [liveAccuracyM, setLiveAccuracyM] = useState<number | null>(null);
  const [speedSource, setSpeedSource] = useState<'doppler' | 'haversine' | 'stationary'>(
    'stationary'
  );

  // Background Notifications & Voice Readout state
  const [bgNotifyEnabled, setBgNotifyEnabled] = useState<boolean>(() => getBgNotifyEnabled());
  const [bgVoiceEnabled, setBgVoiceEnabled] = useState<boolean>(() => getBgVoiceEnabled());
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    getNotificationPermission()
  );
  const [isSpeakingNotifs, setIsSpeakingNotifs] = useState(false);
  const [speakingNotifId, setSpeakingNotifId] = useState<number | null>(null);
  const initialNotifSyncDoneRef = useRef<boolean>(false);

  const watchIdRef = useRef<number | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const lastSentMsRef = useRef<number>(0);
  const initialPeriodSyncedRef = useRef(false);
  const speedEstimatorRef = useRef<HighPrecisionSpeedEstimator>(new HighPrecisionSpeedEstimator());
  const hasDataRef = useRef(false);
  hasDataRef.current = Boolean(data);

  const refreshQueueCounts = useCallback(async () => {
    const [pts, lics] = await Promise.all([getQueuedGpsPoints(), getPendingLicenseSyncs()]);
    setQueuedGpsCount(pts.length);
    setPendingLicensesCount(lics.length);
  }, []);

  // Keep daily 06:00 - 16:00 schedule updated accurately with exact transition timers
  useEffect(() => {
    let timerId: number | null = null;
    const scheduleTick = () => {
      const nextStatus = getDailyScheduleStatus();
      setScheduleStatus(nextStatus);
      timerId = window.setTimeout(scheduleTick, Math.min(nextStatus.msUntilNextTransition, 60_000));
    };
    scheduleTick();
    return () => {
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, []);

  // Instant IndexedDB profile hydration so personal details & license images never vanish offline
  useEffect(() => {
    if (allowDriverSelector || !driverRecord?.id) return;
    let active = true;
    getCachedDriverProfile<DriverAppResponse>(driverRecord.id).then((cached) => {
      if (!active || !cached) return;
      setData((prev) => prev || cached);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [allowDriverSelector, driverRecord?.id]);

  // Load driver selector list if super_admin is previewing
  useEffect(() => {
    if (!allowDriverSelector) {
      setDriversLoaded(true);
      return;
    }
    let cancelled = false;
    setDriversLoaded(false);
    apiFetch<{ drivers: EnrichedDriver[] }>('/api/drivers?includeArchived=true')
      .then((res) => {
        if (cancelled) return;
        const sorted = [...(res.drivers || [])].sort((a, b) => {
          const aActive = a.accountStatus === 'active' ? 0 : 1;
          const bActive = b.accountStatus === 'active' ? 0 : 1;
          return aActive - bActive;
        });
        setAllDrivers(sorted);
        if (sorted.length > 0) {
          setSelectedDriverId((prev) =>
            prev && sorted.some((d) => String(d.id) === prev) ? prev : String(sorted[0].id)
          );
        } else {
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'تعذر تحميل قائمة السائقين للمعاينة');
        setLoading(false);
      })
      .finally(() => {
        if (!cancelled) setDriversLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [allowDriverSelector]);

  const loadDriverData = useCallback(
    async (silent = false) => {
      if (allowDriverSelector && (!driversLoaded || !selectedDriverId)) {
        if (driversLoaded && !selectedDriverId) {
          setLoading(false);
        }
        return;
      }
      if (!silent && !hasDataRef.current) {
        setLoading(true);
      }
      setError(null);
      try {
        const params = new URLSearchParams();
        if (initialPeriodSyncedRef.current) {
          params.set('month', String(month));
          params.set('year', String(year));
        }
        if (allowDriverSelector && selectedDriverId) {
          params.set('asDriverId', selectedDriverId);
        }
        const res = await apiFetch<DriverAppResponse>(`/api/driver-app/me?${params.toString()}`);
        if (!initialPeriodSyncedRef.current && res.period) {
          initialPeriodSyncedRef.current = true;
          setMonth(res.period.month);
          setYear(res.period.year);
        }
        setData(res);
        if (!allowDriverSelector && res.driver?.id) {
          await saveCachedDriverProfile(res.driver.id, res);
        }
      } catch (err: unknown) {
        const fallbackId = allowDriverSelector ? Number(selectedDriverId) : driverRecord?.id;
        if (fallbackId) {
          const cached = await getCachedDriverProfile<DriverAppResponse>(fallbackId);
          if (cached) {
            setData((prev) => prev || cached);
            setError(null);
            return;
          }
        }
        setError(err instanceof Error ? err.message : 'تعذر تحميل بيانات السائق');
      } finally {
        setLoading(false);
      }
    },
    [month, year, allowDriverSelector, driversLoaded, selectedDriverId, driverRecord?.id]
  );

  useEffect(() => {
    loadDriverData();
    refreshQueueCounts();
  }, [month, year, allowDriverSelector, driversLoaded, selectedDriverId]);

  // Register Service Worker & handle notification click deep-links
  useEffect(() => {
    if (allowDriverSelector) return;
    ensureDriverNotificationSwRegistered();
    setNotifPermission(getNotificationPermission());

    const openNotifs = () => navigateTab('notifications');
    window.addEventListener('alwaleed-open-notifications', openNotifs);

    const onSwMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === 'OPEN_DRIVER_NOTIFICATIONS') {
        navigateTab('notifications');
      }
    };
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', onSwMessage);
    }

    return () => {
      window.removeEventListener('alwaleed-open-notifications', openNotifs);
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('message', onSwMessage);
      }
      stopArabicSpeech();
    };
  }, [allowDriverSelector, navigateTab]);

  // Background polling every 15s + visibility/focus refresh so new notifications arrive in background
  useEffect(() => {
    if (allowDriverSelector) return;
    const poll = () => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      loadDriverData(true);
    };
    const intervalId = window.setInterval(poll, 15000);
    const onFocusOrVisible = () => {
      if (document.visibilityState === 'visible') {
        poll();
      }
    };
    window.addEventListener('focus', onFocusOrVisible);
    document.addEventListener('visibilitychange', onFocusOrVisible);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', onFocusOrVisible);
      document.removeEventListener('visibilitychange', onFocusOrVisible);
    };
  }, [allowDriverSelector, loadDriverData]);

  // Announce newly arrived unread notifications in background (System Notification + Chime + Voice Readout)
  useEffect(() => {
    if (allowDriverSelector || !data?.driver?.id) return;
    const list = data.notifications || [];
    if (!list.length) {
      initialNotifSyncDoneRef.current = true;
      return;
    }

    const driverId = data.driver.id;
    const announced = getAnnouncedNotificationIds(driverId);

    // On very first boot for a driver with no history yet, seed existing old IDs
    // so only genuinely new incoming notifications get spoken/pushed automatically.
    if (!initialNotifSyncDoneRef.current && announced.size === 0) {
      initialNotifSyncDoneRef.current = true;
      const seeded = new Set(list.map((n) => n.id));
      saveAnnouncedNotificationIds(driverId, seeded);
      return;
    }
    initialNotifSyncDoneRef.current = true;

    const freshUnread = list.filter((n) => !n.isRead && !announced.has(n.id));
    if (freshUnread.length === 0) return;

    freshUnread.forEach((n) => announced.add(n.id));
    saveAnnouncedNotificationIds(driverId, announced);

    if (!bgNotifyEnabled) return;

    playNotificationChime();
    if (notifPermission === 'granted') {
      freshUnread.slice(0, 3).forEach((n) => {
        showSystemNotification({ id: n.id, title: n.title, body: n.body });
      });
    }
    if (bgVoiceEnabled && isSpeechSynthesisAvailable()) {
      setIsSpeakingNotifs(true);
      speakNotificationsQueue(freshUnread.slice(0, 3), () => setIsSpeakingNotifs(false));
    }
  }, [
    allowDriverSelector,
    data?.driver?.id,
    data?.notifications,
    bgNotifyEnabled,
    bgVoiceEnabled,
    notifPermission,
  ]);

  const syncPendingItems = useCallback(async () => {
    if (allowDriverSelector || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      return;
    }
    const gpsResult = await flushQueuedGpsPoints();
    const pendingLicenses = await getPendingLicenseSyncs();
    for (const item of pendingLicenses) {
      try {
        await apiFetch('/api/driver-app/licenses', {
          method: 'PUT',
          body: JSON.stringify({
            licensePhotos: item.licensePhotos,
            driverId: item.driverId,
          }),
        });
        await removePendingLicenseSync(item.id);
      } catch {
        // Retry on next reconnect
      }
    }
    await refreshQueueCounts();
    if (gpsResult.flushed > 0 || pendingLicenses.length > 0) {
      await loadDriverData(true);
    }
  }, [allowDriverSelector, loadDriverData, refreshQueueCounts]);

  // Monitor network connectivity and automatically flush buffered GPS + offline license edits
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      syncPendingItems();
    };
    const handleOffline = () => {
      setIsOnline(false);
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    if (navigator.onLine !== false) {
      syncPendingItems();
    }
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [syncPendingItems]);

  const stopGpsWatch = useCallback(() => {
    if (watchIdRef.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (heartbeatTimerRef.current !== null) {
      window.clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => undefined);
      wakeLockRef.current = null;
    }
    setIsStreamingGps(false);
  }, []);

  const processAndSendPosition = useCallback(
    async (
      pos: GeolocationPosition,
      options: { forceSend?: boolean; source?: 'live' | 'manual' } = {}
    ) => {
      if (!data?.driver?.vehicleId) return;
      const estimate = speedEstimatorRef.current.compute(pos.coords, pos.timestamp || Date.now());
      setLiveSpeedKmh(estimate.speedKmh);
      setLiveAccuracyM(estimate.accuracyMeters);
      setSpeedSource(estimate.source);

      const nowMs = Date.now();
      if (!options.forceSend && nowMs - lastSentMsRef.current < 5000) {
        return;
      }

      if (options.forceSend) setGpsSending(true);
      try {
        const result = await transmitOrQueueGpsFix({
          vehicleId: data.driver.vehicleId,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          speedKmh: estimate.speedKmh,
          heading: estimate.heading,
          accuracyMeters: estimate.accuracyMeters,
          recordedAt: new Date(pos.timestamp || nowMs).toISOString(),
          source: options.source || 'live',
        });

        lastSentMsRef.current = nowMs;
        setLastLocalPingAt(new Date().toISOString());
        setGpsError(null);

        if (result.queued) {
          await refreshQueueCounts();
          await requestBackgroundSyncRegistration();
        } else {
          // Periodically flush any older backlog when live transmission succeeds
          const pts = await getQueuedGpsPoints();
          if (pts.length > 0) {
            await flushQueuedGpsPoints();
          }
          await refreshQueueCounts();
          if (options.forceSend) {
            await loadDriverData(true);
          }
        }
      } catch (err: unknown) {
        setGpsError(err instanceof Error ? err.message : 'تعذر معالجة إحداثيات الموقع');
      } finally {
        if (options.forceSend) setGpsSending(false);
      }
    },
    [data?.driver?.vehicleId, loadDriverData, refreshQueueCounts]
  );

  // Sync with browser Permissions API so once granted (or upon PWA install), it stays enabled across restarts
  useEffect(() => {
    if (allowDriverSelector || typeof navigator === 'undefined') return;
    let cancelled = false;
    let permStatus: PermissionStatus | null = null;

    const applyPermissionState = (state: PermissionState) => {
      if (cancelled) return;
      setGeoPermState(state);
      try {
        const explicitlyDisabled = localStorage.getItem('alwaleed_gps_consent') === 'false';
        if (state === 'granted' && !explicitlyDisabled) {
          localStorage.setItem('alwaleed_gps_consent', 'true');
          setGpsConsent(true);
        } else if (state === 'denied') {
          setGpsError(
            'تم حظر إذن الموقع من إعدادات المتصفح/الهاتف. يرجى تفعيله مرة واحدة فقط للسماح بالتشغيل التلقائي.'
          );
        }
      } catch {
        // ignore storage errors
      }
    };

    const handlePwaInstalled = () => {
      try {
        if (localStorage.getItem('alwaleed_gps_consent') !== 'false') {
          localStorage.setItem('alwaleed_gps_consent', 'true');
          setGpsConsent(true);
        }
      } catch {
        // ignore
      }
    };

    window.addEventListener('alwaleed-pwa-installed', handlePwaInstalled);

    if (navigator.permissions && typeof navigator.permissions.query === 'function') {
      navigator.permissions
        .query({ name: 'geolocation' })
        .then((status) => {
          if (cancelled) return;
          permStatus = status;
          applyPermissionState(status.state);
          status.onchange = () => applyPermissionState(status.state);
        })
        .catch(() => {
          setGeoPermState('unknown');
        });
    }

    return () => {
      cancelled = true;
      window.removeEventListener('alwaleed-pwa-installed', handlePwaInstalled);
      if (permStatus) permStatus.onchange = null;
    };
  }, [allowDriverSelector]);

  // Persistent High-Accuracy GPS Watch strictly scheduled daily 06:00 AM - 04:00 PM year-round
  useEffect(() => {
    const isPaused = data?.gps?.vehicleGpsStatus === 'paused';
    const hasVehicle = Boolean(data?.linked && data?.driver?.vehicleId);
    const shouldAutoRun =
      gpsConsent &&
      !isPaused &&
      hasVehicle &&
      !allowDriverSelector &&
      scheduleStatus.isWithinWindow;

    if (!shouldAutoRun) {
      stopGpsWatch();
      return;
    }

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsError('متصفح هذا الجهاز لا يدعم خدمة تحديد الموقع GPS.');
      return;
    }

    setGpsError(null);
    setIsStreamingGps(true);

    const requestImmediateHighAccuracyFix = () => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setGeoPermState('granted');
          try {
            localStorage.setItem('alwaleed_gps_consent', 'true');
          } catch {
            // ignore
          }
          processAndSendPosition(pos, { forceSend: true, source: 'live' });
        },
        (geoErr) => {
          if (geoErr.code === geoErr.PERMISSION_DENIED) {
            setGeoPermState('denied');
            setIsStreamingGps(false);
            setGpsError(
              'تم رفض إذن الوصول للموقع. يرجى السماح بالموقع مرة واحدة من إعدادات التطبيق/المتصفح.'
            );
          }
        },
        HIGH_ACCURACY_GPS_OPTIONS
      );
    };

    if (Date.now() - lastSentMsRef.current > 8000) {
      requestImmediateHighAccuracyFix();
    }

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setGeoPermState('granted');
        processAndSendPosition(pos, { source: 'live' });
      },
      (geoErr) => {
        if (geoErr.code === geoErr.PERMISSION_DENIED) {
          setIsStreamingGps(false);
          setGeoPermState('denied');
          setGpsError(
            'تم رفض إذن الوصول للموقع من المتصفح. يرجى تفعيل الموقع من إعدادات المتصفح.'
          );
        } else if (geoErr.code === geoErr.POSITION_UNAVAILABLE) {
          setGpsError('تعذر تحديد الموقع الحالي بدقة، تأكد من تشغيل GPS في الجهاز.');
        } else {
          setGpsError('جاري إعادة التقاط إشارة GPS عالية الدقة...');
        }
      },
      HIGH_ACCURACY_GPS_OPTIONS
    );

    // 25s foreground heartbeat & visibility resume sync
    heartbeatTimerRef.current = window.setInterval(() => {
      if (document.visibilityState === 'visible' && Date.now() - lastSentMsRef.current >= 25000) {
        requestImmediateHighAccuracyFix();
      }
    }, 25000);

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        syncPendingItems();
        if (Date.now() - lastSentMsRef.current >= 8000) {
          requestImmediateHighAccuracyFix();
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    let effectActive = true;
    const navWithWakeLock = navigator as unknown as {
      wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
    };
    if (navWithWakeLock.wakeLock && document.visibilityState === 'visible') {
      navWithWakeLock.wakeLock
        .request('screen')
        .then((lock) => {
          if (!effectActive) {
            lock.release().catch(() => undefined);
            return;
          }
          wakeLockRef.current = lock;
        })
        .catch(() => undefined);
    }

    return () => {
      effectActive = false;
      document.removeEventListener('visibilitychange', handleVisibility);
      stopGpsWatch();
    };
  }, [
    gpsConsent,
    scheduleStatus.isWithinWindow,
    data?.gps?.vehicleGpsStatus,
    data?.linked,
    data?.driver?.vehicleId,
    allowDriverSelector,
    processAndSendPosition,
    stopGpsWatch,
    syncPendingItems,
  ]);

  const handleToggleConsent = async () => {
    const next = !gpsConsent;
    setGpsConsent(next);
    try {
      localStorage.setItem('alwaleed_gps_consent', String(next));
    } catch {
      // ignore storage errors
    }
    if (!next) {
      stopGpsWatch();
    } else {
      if (data?.gps?.vehicleGpsStatus === 'paused') {
        await handleTogglePause(false);
      }
      if (typeof navigator !== 'undefined' && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            setGeoPermState('granted');
            processAndSendPosition(pos, { forceSend: true, source: 'manual' });
          },
          () => undefined,
          HIGH_ACCURACY_GPS_OPTIONS
        );
      }
    }
  };

  const handleManualPing = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsError('الجهاز لا يدعم خدمة GPS.');
      return;
    }
    setGpsSending(true);
    setGpsError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeoPermState('granted');
        processAndSendPosition(pos, { forceSend: true, source: 'manual' });
      },
      (err) => {
        setGpsSending(false);
        setGpsError(
          err.code === err.PERMISSION_DENIED
            ? 'يرجى السماح بالوصول للموقع الجغرافي من إعدادات المتصفح.'
            : 'تعذر قراءة الموقع الجغرافي الحالي.'
        );
      },
      HIGH_ACCURACY_GPS_OPTIONS
    );
  };

  const handleTogglePause = async (paused: boolean) => {
    if (!data?.driver) return;
    setError(null);
    try {
      await apiFetch('/api/driver-app/gps-pause', {
        method: 'POST',
        body: JSON.stringify({
          paused,
          driverId: allowDriverSelector ? data.driver.id : undefined,
        }),
      });
      if (paused) stopGpsWatch();
      await loadDriverData(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحديث حالة الموقع');
    }
  };

  const handleSaveDriverLicenses = async (nextPhotos: DriverLicensePhoto[]) => {
    if (!data?.driver) return;
    const optimisticRes: DriverAppResponse = {
      ...data,
      driver: {
        ...data.driver,
        licensePhotos: nextPhotos,
      },
    };
    setData(optimisticRes);
    if (!allowDriverSelector) {
      await saveCachedDriverProfile(data.driver.id, optimisticRes);
    }

    try {
      await apiFetch('/api/driver-app/licenses', {
        method: 'PUT',
        body: JSON.stringify({
          licensePhotos: nextPhotos,
          driverId: allowDriverSelector ? data.driver.id : undefined,
        }),
      });
      await loadDriverData(true);
    } catch (err: unknown) {
      const status = err instanceof ApiHttpError ? err.status : 0;
      if (!allowDriverSelector && (status === 0 || !navigator.onLine)) {
        await queuePendingLicenseSync({
          type: 'licenses',
          driverId: data.driver.id,
          licensePhotos: nextPhotos,
        });
        await refreshQueueCounts();
        return;
      }
      throw err;
    }
  };

  const handleMarkNotificationRead = async (id: number) => {
    try {
      await apiFetch(`/api/notifications/${id}/read`, { method: 'PATCH' });
      await loadDriverData(true);
    } catch {
      // ignore
    }
  };

  const handleMarkAllNotificationsRead = async () => {
    try {
      await apiFetch('/api/notifications/mark-all-read', { method: 'POST' });
      await loadDriverData(true);
    } catch {
      // ignore
    }
  };

  const handleToggleBgNotify = async () => {
    const next = !bgNotifyEnabled;
    setBgNotifyEnabled(next);
    setBgNotifyEnabledPref(next);
    if (next && getNotificationPermission() === 'default') {
      const perm = await requestDriverNotificationPermission();
      setNotifPermission(perm);
    }
  };

  const handleToggleBgVoice = () => {
    const next = !bgVoiceEnabled;
    setBgVoiceEnabled(next);
    setBgVoiceEnabledPref(next);
    if (!next) {
      stopArabicSpeech();
      setIsSpeakingNotifs(false);
      setSpeakingNotifId(null);
    }
  };

  const handleRequestNotifPermission = async () => {
    const perm = await requestDriverNotificationPermission();
    setNotifPermission(perm);
    if (perm === 'granted') {
      setBgNotifyEnabled(true);
      setBgNotifyEnabledPref(true);
      showSystemNotification({
        title: 'تم تفعيل إشعارات الخلفية',
        body: 'ستصلك تنبيهات الإدارة والرسائل الجماعية في الخلفية فور وصولها.',
      });
    }
  };

  const handleReadSingleNotification = (n: NotificationItem) => {
    if (speakingNotifId === n.id) {
      stopArabicSpeech();
      setSpeakingNotifId(null);
      setIsSpeakingNotifs(false);
      return;
    }
    setSpeakingNotifId(n.id);
    setIsSpeakingNotifs(true);
    const ok = speakArabicText(`${n.title}. ${n.body}`, {
      onEnd: () => {
        setSpeakingNotifId(null);
        setIsSpeakingNotifs(false);
      },
    });
    if (!ok) {
      setSpeakingNotifId(null);
      setIsSpeakingNotifs(false);
    }
  };

  const handleReadUnreadAloud = () => {
    if (isSpeakingNotifs) {
      stopArabicSpeech();
      setIsSpeakingNotifs(false);
      setSpeakingNotifId(null);
      return;
    }
    const targets = (data?.notifications || []).filter((n) => !n.isRead);
    const listToSpeak = targets.length > 0 ? targets : (data?.notifications || []).slice(0, 3);
    if (!listToSpeak.length) return;
    setIsSpeakingNotifs(true);
    const ok = speakNotificationsQueue(listToSpeak, () => {
      setIsSpeakingNotifs(false);
      setSpeakingNotifId(null);
    });
    if (!ok) setIsSpeakingNotifs(false);
  };

  const unreadCount = (data?.notifications || []).filter((n) => !n.isRead).length;
  const driver = data?.driver;
  const salary = data?.salary;
  const latestGps = data?.gps?.latestGps;
  const vehicleGpsStatus = data?.gps?.vehicleGpsStatus || 'offline';
  const isLiveSharing =
    vehicleGpsStatus !== 'paused' && (isStreamingGps || Boolean(latestGps?.isLive));
  const displayedSpeed = isStreamingGps
    ? liveSpeedKmh
    : latestGps?.isLive
    ? latestGps.speedKmh
    : 0;

  return (
    <div className="min-h-screen bg-[#eef2f7] relative flex flex-col">
      <AppLogoBackdrop />

      {/* Sticky Top Header */}
      <header
        className={`sticky ${
          hasPreviewBar ? 'top-12' : 'top-0'
        } z-30 h-14 bg-[#0B1F3A] text-white border-b border-slate-800 px-4`}
      >
        <div className="max-w-3xl mx-auto h-full flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            {driver ? (
              <DriverAvatar
                name={driver.fullName}
                photoUrl={driver.photoUrl}
                size="sm"
                variant="dark"
              />
            ) : (
              <div className="w-8 h-8 rounded-lg bg-[#C89B3C] text-[#0B1F3A] flex items-center justify-center shrink-0">
                <Bus className="w-4 h-4" />
              </div>
            )}
            <div className="min-w-0">
              <div className="font-display text-sm font-bold truncate">
                {driver ? driver.fullName : 'تطبيق السائق · الوليد ترافيل'}
              </div>
              {driver && (
                <div className="text-[11px] text-slate-300 font-mono tabular-nums truncate">
                  كود {driver.driverCode} · باص {driver.busNumber}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {(activeTab !== 'home' || tabHistory.length > 0) && (
              <button
                type="button"
                onClick={goBackTab}
                title="العودة للقائمة السابقة دون الخروج"
                className="min-h-[38px] inline-flex items-center gap-1.5 rounded-lg bg-white/10 hover:bg-white/20 px-2.5 py-1.5 text-xs font-bold text-[#ebd089] transition-colors cursor-pointer"
              >
                <ArrowRight className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">العودة للقائمة السابقة</span>
                <span className="sm:hidden">رجوع</span>
              </button>
            )}

            {allowDriverSelector && allDrivers.length > 0 && (
              <select
                value={selectedDriverId}
                onChange={(e) => setSelectedDriverId(e.target.value)}
                aria-label="اختيار سائق للمعاينة"
                className="rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#C89B3C]"
              >
                {allDrivers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.fullName} ({d.driverCode}){d.accountStatus !== 'active' ? ' - مؤرشف' : ''}
                  </option>
                ))}
              </select>
            )}

            {!allowDriverSelector && <PWAInstallButton variant="dark" />}

            {!allowDriverSelector && (
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
      <main className="app-glass-cards relative z-10 flex-1 w-full max-w-3xl mx-auto px-4 pt-4 pb-24 space-y-4">
        {allowDriverSelector && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900 flex items-center justify-between gap-3">
            <span>وضع معاينة تطبيق السائق (حساب المدير العام)</span>
            <span className="font-semibold">عرض مطابق تماماً لشاشة السائق</span>
          </div>
        )}

        {!isOnline && !allowDriverSelector && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs text-amber-900 flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 font-semibold">
              <WifiOff className="w-4 h-4 text-amber-700 shrink-0" />
              وضع عدم الاتصال: بياناتك محفوظة محلياً ويتم تخزين نقاط GPS للرفع فور عودة الشبكة
            </span>
            {queuedGpsCount > 0 && (
              <span className="font-mono font-bold tabular-nums">{queuedGpsCount} نقطة</span>
            )}
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
          allowDriverSelector ? (
            <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-sm text-slate-500">
              جاري تحميل ملف السائق للمعاينة...
            </div>
          ) : (
            <SplashScreen message="جاري تحميل ملف السائق وكشف الحساب..." />
          )
        ) : allowDriverSelector && driversLoaded && allDrivers.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 text-center space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-amber-50 text-[#C89B3C] flex items-center justify-center mx-auto border border-amber-200">
              <UserCheck className="w-6 h-6" />
            </div>
            <h2 className="font-display text-lg font-bold text-[#0B1F3A]">
              لا يوجد سائقون مسجلون للمعاينة حالياً
            </h2>
            <p className="text-sm text-slate-600 leading-relaxed max-w-md mx-auto">
              يرجى إضافة سائق واحد على الأقل من قسم «إدارة السائقين» أولاً لتتمكن من معاينة واجهة
              تطبيق السائق الكاملة هنا.
            </p>
          </div>
        ) : !data?.linked || !driver ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 text-center space-y-4">
            <div className="w-12 h-12 rounded-2xl bg-amber-50 text-[#C89B3C] flex items-center justify-center mx-auto border border-amber-200">
              <UserCheck className="w-6 h-6" />
            </div>
            <h2 className="font-display text-lg font-bold text-[#0B1F3A]">
              الحساب غير مرتبط بملف سائق بعد
            </h2>
            <p className="text-sm text-slate-600 leading-relaxed max-w-md mx-auto">
              تم تسجيل دخولك بالبريد{' '}
              <span className="font-mono font-semibold text-[#0B1F3A]">{dbUser?.email}</span>، ولكن
              لم يتم ربط هذا البريد بملف سائق حتى الآن.
            </p>
            <div className="pt-2 flex items-center justify-center gap-3">
              <button
                onClick={() => loadDriverData()}
                className="min-h-[44px] inline-flex items-center gap-2 rounded-xl bg-[#0B1F3A] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#13325c] cursor-pointer"
              >
                <RefreshCw className="w-4 h-4" />
                إعادة التحقق
              </button>
              {!allowDriverSelector && (
                <button
                  onClick={logout}
                  className="min-h-[44px] inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  تسجيل الخروج
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* TAB 1: HOME */}
            {activeTab === 'home' && (
              <div className="space-y-4">
                {/* Identity & Salary Hero */}
                <section className="relative overflow-hidden rounded-2xl bg-[#0B1F3A] text-white p-5">
                  <img
                    src={travelBackdropImg}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="absolute inset-0 w-full h-full object-cover opacity-30 pointer-events-none select-none"
                  />
                  <div
                    aria-hidden="true"
                    className="hidden sm:block absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none select-none"
                  >
                    <div className="w-40 h-40 rounded-full overflow-hidden opacity-45 ring-1 ring-[#C89B3C]/40 shadow-2xl">
                      <img
                        src={splashScreenImg}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover object-center scale-110"
                      />
                    </div>
                  </div>
                  <div className="absolute inset-0 bg-gradient-to-l from-[#0B1F3A]/90 via-[#0B1F3A]/60 to-transparent pointer-events-none" />

                  <div className="relative z-10 space-y-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-center gap-3.5 min-w-0">
                        <DriverAvatar
                          name={driver.fullName}
                          photoUrl={driver.photoUrl}
                          size="lg"
                          variant="dark"
                        />
                        <div className="min-w-0">
                          <p className="text-[11px] text-[#ebd089] font-semibold">
                            ملف السائق · الوليد ترافيل
                          </p>
                          <h1 className="font-display text-xl font-bold mt-0.5 truncate">
                            {driver.fullName}
                          </h1>
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-200 tabular-nums">
                            <span className="font-mono">كود {driver.driverCode}</span>
                            <span className="text-white/30">·</span>
                            <span className="flex items-center gap-1 font-mono" dir="ltr">
                              <Phone className="w-3.5 h-3.5 text-[#C89B3C]" />
                              {driver.phone}
                            </span>
                          </div>
                        </div>
                      </div>
                      <span
                        className={`text-xs font-bold shrink-0 ${
                          driver.accountStatus === 'active' ? 'text-[#C89B3C]' : 'text-amber-300'
                        }`}
                      >
                        {driver.accountStatus === 'active' ? 'حساب نشط' : 'مؤرشف'}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-4 pt-4 border-t border-white/15">
                      <div>
                        <p className="text-xs text-slate-300">الراتب المتفق عليه</p>
                        <p className="text-lg sm:text-xl font-bold tabular-nums mt-0.5">
                          {formatEGP(driver.monthlyAgreedSalary)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-slate-300">
                          صافي المستحق ({ARABIC_MONTHS[month - 1]})
                        </p>
                        <p className="text-lg sm:text-xl font-bold text-[#C89B3C] tabular-nums mt-0.5">
                          {formatEGP(salary?.netSalary || 0)}
                        </p>
                      </div>
                    </div>
                  </div>
                </section>

                {/* Automatic Morning Quran & Hadith Section */}
                <MorningSpiritualRibbon compact />

                {/* Clean Operational Details (Hairline structured list - zero nested subcards) */}
                <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                    <h2 className="font-display text-base font-bold text-[#0B1F3A]">
                      بيانات المدرسة والمركبة وخط السير
                    </h2>
                    <Bus className="w-4 h-4 text-[#C89B3C]" />
                  </div>

                  <dl className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 divide-slate-100 text-sm">
                    <div className="px-5 py-3.5 sm:border-b sm:border-l border-slate-100">
                      <dt className="text-xs text-slate-500">المدرسة المعينة</dt>
                      <dd className="font-bold text-[#0B1F3A] mt-1">{driver.schoolName}</dd>
                    </div>
                    <div className="px-5 py-3.5 sm:border-b border-slate-100">
                      <dt className="text-xs text-slate-500">رقم الباص واللوحة</dt>
                      <dd className="font-bold text-[#0B1F3A] mt-1 tabular-nums">
                        {driver.busNumber} ·{' '}
                        <span className="font-mono text-xs text-slate-600">
                          {driver.registrationNumber}
                        </span>
                      </dd>
                    </div>
                    <div className="px-5 py-3.5 sm:col-span-2">
                      <dt className="text-xs text-slate-500">خط السير والمواعيد</dt>
                      <dd className="font-bold text-[#0B1F3A] mt-1">{driver.routeName}</dd>
                      {(driver.pickupArea ||
                        driver.dropoffArea ||
                        driver.pickupTime ||
                        driver.dropoffTime) && (
                        <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-slate-600 tabular-nums">
                          <span className="flex items-center gap-1">
                            <Clock className="w-3.5 h-3.5 text-[#C89B3C]" />
                            بداية الرحلة: {driver.pickupArea ? `${driver.pickupArea} · ` : ''}
                            {formatArabicTripTime(driver.pickupTime)}
                          </span>
                          <span>
                            نهاية الرحلة: {driver.dropoffArea ? `${driver.dropoffArea} · ` : ''}
                            {formatArabicTripTime(driver.dropoffTime)}
                          </span>
                        </div>
                      )}
                    </div>
                  </dl>
                </section>

                {/* Live Telemetry & Speed Strip (06:00 AM - 04:00 PM Daily Window) */}
                <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                          isLiveSharing
                            ? 'bg-emerald-50 text-emerald-700'
                            : vehicleGpsStatus === 'paused'
                            ? 'bg-amber-50 text-amber-700'
                            : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        <Compass className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-[#0B1F3A] truncate">
                          التتبع التلقائي:{' '}
                          {vehicleGpsStatus === 'paused'
                            ? 'متوقف مؤقتاً'
                            : !scheduleStatus.isWithinWindow
                            ? 'خارج ساعات العمل المجدولة'
                            : isLiveSharing
                            ? 'بث مباشر عالي الدقة نشط'
                            : 'بانتظار إشارة GPS'}
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
                          الجدول اليومي: {scheduleStatus.windowLabelAr}
                        </p>
                      </div>
                    </div>

                    {!allowDriverSelector && (!gpsConsent || geoPermState !== 'granted') ? (
                      <button
                        onClick={handleToggleConsent}
                        className="min-h-[44px] rounded-xl bg-[#0B1F3A] hover:bg-[#13325c] px-4 py-2 text-xs font-bold text-white shrink-0 cursor-pointer"
                      >
                        تفعيل الموقع الدائم
                      </button>
                    ) : (
                      <button
                        onClick={() => navigateTab('location')}
                        className="min-h-[44px] rounded-xl bg-slate-100 hover:bg-slate-200 px-3.5 py-2 text-xs font-semibold text-[#0B1F3A] shrink-0 cursor-pointer"
                      >
                        تفاصيل التتبع
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-3 divide-x divide-x-reverse divide-slate-100 border-t border-slate-100 pt-3 text-center">
                    <div className="px-2">
                      <p className="text-[11px] text-slate-500">السرعة الحالية</p>
                      <p className="text-lg font-bold text-[#0B1F3A] tabular-nums mt-0.5">
                        {Math.round(displayedSpeed)}{' '}
                        <span className="text-xs font-normal text-slate-500">كم/س</span>
                      </p>
                    </div>
                    <div className="px-2">
                      <p className="text-[11px] text-slate-500">دقة الإشارة</p>
                      <p className="text-sm font-bold text-slate-800 tabular-nums mt-1">
                        {liveAccuracyM !== null
                          ? `±${liveAccuracyM} م`
                          : latestGps?.accuracyMeters
                          ? `±${Math.round(latestGps.accuracyMeters)} م`
                          : '—'}
                      </p>
                    </div>
                    <div className="px-2">
                      <p className="text-[11px] text-slate-500">آخر تحديث</p>
                      <p className="text-xs font-semibold text-slate-700 mt-1.5 truncate">
                        {lastLocalPingAt || latestGps?.recordedAt
                          ? formatRelativeArabicTime(lastLocalPingAt || latestGps!.recordedAt)
                          : 'لا يوجد'}
                      </p>
                    </div>
                  </div>

                  {(queuedGpsCount > 0 || pendingLicensesCount > 0) && (
                    <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-xs text-amber-800">
                      <span>بيانات بانتظار المزامنة عند استقرار الإنترنت</span>
                      <span className="font-mono font-bold tabular-nums">
                        {queuedGpsCount} نقطة موقع
                        {pendingLicensesCount > 0 ? ` · ${pendingLicensesCount} رخص` : ''}
                      </span>
                    </div>
                  )}
                </section>

                {/* Driver License Photos Upload & View Section (Offline-Resilient) */}
                <DriverLicensesSection
                  photos={driver.licensePhotos || []}
                  viewerRole={allowDriverSelector ? 'admin' : 'driver'}
                  compact
                  onSavePhotos={handleSaveDriverLicenses}
                />

                {/* Quick Communication Shortcut */}
                <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() =>
                      navigateTab('chat', data.driver?.routeId ? `route_${data.driver.routeId}` : 'broadcast')
                    }
                    className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white hover:bg-slate-50 p-4 text-right transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-xl bg-[#0B1F3A] text-[#C89B3C] flex items-center justify-center shrink-0">
                        <MessageSquare className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-[#0B1F3A] truncate">محادثة الإدارة والمشرفة</p>
                        <p className="text-[11px] text-slate-500 truncate">رسائل نصية ورسائل صوتية واتصال</p>
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => navigateTab('chat', 'drivers_broadcast')}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-[#C89B3C]/40 bg-amber-50/70 hover:bg-amber-50 p-4 text-right transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-xl bg-[#C89B3C] text-[#0B1F3A] flex items-center justify-center shrink-0">
                        <RadioTower className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-[#0B1F3A] truncate">رسائل الإدارة للسائقين</p>
                        <p className="text-[11px] text-amber-900 truncate">قناة التعليمات والتوجيهات الجماعية</p>
                      </div>
                    </div>
                  </button>
                </section>

                {/* Recent Notifications Preview */}
                <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2">
                    <h2 className="font-display text-base font-bold text-[#0B1F3A]">
                      أحدث التنبيهات ({unreadCount} غير مقروء)
                    </h2>
                    <div className="flex items-center gap-2">
                      {!allowDriverSelector && notifPermission === 'default' && (
                        <button
                          type="button"
                          onClick={handleRequestNotifPermission}
                          className="rounded-lg bg-amber-50 border border-amber-200 px-2.5 py-1 text-[11px] font-bold text-amber-900 hover:bg-amber-100 cursor-pointer"
                        >
                          تفعيل بالخلفية
                        </button>
                      )}
                      {isSpeechSynthesisAvailable() && (data.notifications || []).length > 0 && (
                        <button
                          type="button"
                          onClick={handleReadUnreadAloud}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-[#0B1F3A] cursor-pointer"
                        >
                          {isSpeakingNotifs ? (
                            <>
                              <VolumeX className="w-3 h-3 text-red-600" />
                              إيقاف
                            </>
                          ) : (
                            <>
                              <Volume2 className="w-3 h-3 text-[#C89B3C]" />
                              قراءة صوتية
                            </>
                          )}
                        </button>
                      )}
                      <button
                        onClick={() => navigateTab('notifications')}
                        className="text-xs font-semibold text-[#C89B3C] hover:underline cursor-pointer"
                      >
                        عرض الكل
                      </button>
                    </div>
                  </div>
                  {(data.notifications || []).slice(0, 2).length === 0 ? (
                    <p className="px-5 py-4 text-xs text-slate-500">لا توجد إشعارات جديدة حالياً.</p>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {(data.notifications || []).slice(0, 2).map((n) => (
                        <div
                          key={n.id}
                          className={`px-5 py-3.5 text-xs ${
                            n.isRead ? 'text-slate-600' : 'bg-amber-50/40 text-amber-950'
                          }`}
                        >
                          <p className="font-bold text-[#0B1F3A]">{n.title}</p>
                          <p className="mt-1 leading-relaxed">{n.body}</p>
                          {n.type === 'drivers_broadcast' && (
                            <button
                              type="button"
                              onClick={() => {
                                if (!n.isRead) handleMarkNotificationRead(n.id);
                                navigateTab('chat', 'drivers_broadcast');
                              }}
                              className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-[#0B1F3A] px-2.5 py-1 text-[11px] font-bold text-[#C89B3C] hover:bg-[#13325c] cursor-pointer"
                            >
                              <RadioTower className="w-3 h-3" />
                              فتح في قناة السائقين
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}

            {/* TAB 2: FINANCE (STRICTLY READ-ONLY) */}
            {activeTab === 'finance' && (
              <div className="space-y-4">
                <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                  <div className="p-5 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div>
                      <h1 className="font-display text-lg font-bold text-[#0B1F3A]">
                        كشف الحساب المالي الشهري
                      </h1>
                      <p className="text-xs text-slate-500 mt-0.5">
                        بيان مالي موثق للقراءة فقط — يتم تحديثه تلقائياً من إدارة الوليد ترافيل
                      </p>
                      {data.billingRange && (
                        <p className="text-[11px] font-bold text-[#0B1F3A] mt-1 font-mono tabular-nums">
                          نطاق دورة {data.driver?.schoolName || 'المدرسة'}: {data.billingRange.labelAr}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        value={month}
                        onChange={(e) => setMonth(Number(e.target.value))}
                        className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-800"
                      >
                        {ARABIC_MONTHS.map((mName, idx) => (
                          <option key={idx + 1} value={idx + 1}>
                            {mName}
                          </option>
                        ))}
                      </select>
                      <select
                        value={year}
                        onChange={(e) => setYear(Number(e.target.value))}
                        className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-800 font-mono"
                      >
                        {[2024, 2025, 2026, 2027].map((y) => (
                          <option key={y} value={y}>
                            {y}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Clean Ledger Summary Grid with Hairline Dividers */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 divide-y divide-x divide-x-reverse divide-slate-100">
                    <div className="p-4">
                      <p className="text-xs text-slate-500">الراتب الأساسي</p>
                      <p className="text-base font-bold text-[#0B1F3A] tabular-nums mt-1">
                        {formatEGP(salary?.baseSalary || 0)}
                      </p>
                    </div>
                    <div className="p-4">
                      <p className="text-xs text-red-700">إجمالي السلف (-)</p>
                      <p className="text-base font-bold text-red-700 tabular-nums mt-1">
                        {formatEGP(salary?.totalAdvances || 0)}
                      </p>
                    </div>
                    <div className="p-4">
                      <p className="text-xs text-red-700">خصم التغطيات (-)</p>
                      <p className="text-base font-bold text-red-700 tabular-nums mt-1">
                        {formatEGP(salary?.totalCoverageDeductions || 0)}
                      </p>
                    </div>
                    <div className="p-4">
                      <p className="text-xs text-emerald-800">مستحق التغطيات (+)</p>
                      <p className="text-base font-bold text-emerald-700 tabular-nums mt-1">
                        {formatEGP(salary?.totalCoverageAdditions || 0)}
                      </p>
                    </div>
                    <div className="p-4">
                      <p className="text-xs text-slate-500">خصومات أخرى (-)</p>
                      <p className="text-base font-bold text-slate-800 tabular-nums mt-1">
                        {formatEGP(salary?.otherDeductions || 0)}
                      </p>
                    </div>
                    <div className="p-4">
                      <p className="text-xs text-emerald-800">المكافآت (+)</p>
                      <p className="text-base font-bold text-emerald-700 tabular-nums mt-1">
                        {formatEGP(salary?.bonuses || 0)}
                      </p>
                    </div>
                    <div className="p-4 bg-[#0B1F3A] text-white col-span-2 sm:col-span-3">
                      <p className="text-xs text-slate-300">صافي الراتب المستحق</p>
                      <p className="text-base font-bold text-[#C89B3C] tabular-nums mt-1">
                        {formatEGP(salary?.netSalary || 0)}
                      </p>
                    </div>
                  </div>
                </section>

                {/* Advances List */}
                <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
                  <h2 className="font-display text-base font-bold text-[#0B1F3A]">
                    السلف المسجلة هذا الشهر ({(data.advances || []).length})
                  </h2>
                  {(data.advances || []).length === 0 ? (
                    <p className="text-xs text-slate-500">لا توجد سلف مسجلة في هذا الشهر.</p>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {(data.advances || []).map((a) => (
                        <div key={a.id} className="py-3 flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-[#0B1F3A]">
                              {a.reason}{' '}
                              {a.isReversed && (
                                <span className="text-xs text-slate-400">(تم عكس القيد)</span>
                              )}
                            </p>
                            <p className="text-xs text-slate-500 font-mono mt-0.5">{a.date}</p>
                          </div>
                          <span
                            className={`text-sm font-bold tabular-nums ${
                              a.isReversed ? 'line-through text-slate-400' : 'text-red-700'
                            }`}
                          >
                            {formatEGP(a.amount)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                {/* Coverages List (Absent Deductions & Replacement Credits) */}
                <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
                  <h2 className="font-display text-base font-bold text-[#0B1F3A]">
                    سجل التغطيات ({(data.coverages || []).length})
                  </h2>
                  {(data.coverages || []).length === 0 ? (
                    <p className="text-xs text-slate-500">لا توجد تغطيات مسجلة في هذا الشهر.</p>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {(data.coverages || []).map((c) => {
                        const isReplacement = c.coverageRole === 'replacement';
                        const covVal = Number(
                          c.coverageAmount ?? c.absentDriverDeduction ?? c.actualReplacementCost ?? 0
                        );
                        return (
                          <div key={c.id} className="py-3 flex items-center justify-between gap-3">
                            <div>
                              <p className="text-sm font-semibold text-[#0B1F3A]">
                                {isReplacement
                                  ? `تغطية عن: ${c.absentDriverName || '—'}`
                                  : `البديل: ${c.replacementDriverName || c.replacementExternalName || '—'}`}
                                {c.reason ? ` · ${c.reason}` : ''}{' '}
                                {c.isReversed && (
                                  <span className="text-xs text-slate-400">(تم عكس القيد)</span>
                                )}
                              </p>
                              <p className="text-xs text-slate-500 font-mono mt-0.5">{c.date}</p>
                            </div>
                            <span
                              className={`text-sm font-bold tabular-nums ${
                                c.isReversed
                                  ? 'line-through text-slate-400'
                                  : isReplacement
                                  ? 'text-emerald-700'
                                  : 'text-red-700'
                              }`}
                            >
                              {isReplacement ? '+' : '−'} {formatEGP(covVal)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                {/* Transaction History */}
                <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
                  <h2 className="font-display text-base font-bold text-[#0B1F3A]">
                    سجل الحركات المالية ({(data.transactions || []).length})
                  </h2>
                  {(data.transactions || []).length === 0 ? (
                    <p className="text-xs text-slate-500">لا توجد حركات مالية مسجلة لهذا الشهر.</p>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {(data.transactions || []).map((t) => (
                        <div key={t.id} className="py-3 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-[#0B1F3A] truncate">
                              {t.description}
                            </p>
                            <p className="text-xs text-slate-500 mt-0.5">
                              {new Date(t.createdAt).toLocaleString('ar-EG')}
                            </p>
                          </div>
                          <span
                            className={`text-sm font-bold tabular-nums shrink-0 ${
                              t.direction === 'credit' ? 'text-emerald-700' : 'text-red-700'
                            }`}
                          >
                            {t.direction === 'credit' ? '+' : '-'}
                            {formatEGP(t.amount)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}

            {/* TAB: MAINTENANCE & VOICE ASSISTANT */}
            {activeTab === 'maintenance' && (
              <DriverMaintenanceVoiceModule busNumber={driver.busNumber} schoolName={driver.schoolName} />
            )}

            {/* TAB 3: LOCATION, HIGH-PRECISION SPEED & SCHEDULE */}
            {activeTab === 'location' && (
              <div className="space-y-4">
                <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h1 className="font-display text-lg font-bold text-[#0B1F3A]">
                        التتبع المباشر والسرعة (GPS)
                      </h1>
                      <p className="text-xs text-slate-500 mt-1">
                        الباص رقم {driver.busNumber} · {driver.schoolName}
                      </p>
                    </div>
                    <span
                      className={`text-xs font-bold shrink-0 ${
                        isLiveSharing
                          ? 'text-emerald-700'
                          : vehicleGpsStatus === 'paused'
                          ? 'text-amber-700'
                          : 'text-slate-500'
                      }`}
                    >
                      {isLiveSharing
                        ? 'بث مباشر نشط'
                        : vehicleGpsStatus === 'paused'
                        ? 'متوقف مؤقتاً'
                        : scheduleStatus.isWithinWindow
                        ? 'غير متصل (مخزن)'
                        : 'خارج ساعات العمل'}
                    </span>
                  </div>

                  {/* Visual Speedometer Gauge */}
                  <SpeedometerGauge currentSpeed={displayedSpeed} speedLimit={80} maxSpeed={Math.round(displayedSpeed)} />

                  {/* GPS Accuracy & Network Status Readout */}
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs tabular-nums text-slate-700">
                    <div className="flex items-center gap-2">
                      {isOnline ? (
                        <Wifi className="w-4 h-4 text-emerald-600" />
                      ) : (
                        <WifiOff className="w-4 h-4 text-amber-600" />
                      )}
                      <span className="font-semibold">
                        {isOnline ? 'إنترنت نشط (بث فوري عبر الشبكة)' : 'تخزين محلي مؤقت لحين عودة الشبكة'}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 text-slate-500">
                      <span>
                        دقة التحديد:{' '}
                        {liveAccuracyM !== null
                          ? `±${liveAccuracyM} متر`
                          : latestGps?.accuracyMeters
                          ? `±${Math.round(latestGps.accuracyMeters)} متر`
                          : 'قيد المعايرة'}
                        {speedSource === 'doppler'
                          ? ' · حساس السرعة المباشر'
                          : speedSource === 'haversine'
                          ? ' · حساب المسافة/الزمن'
                          : ''}
                      </span>
                      <span className="text-[#C89B3C] font-semibold">· {scheduleStatus.statusLabelAr}</span>
                    </div>
                  </div>

                  {gpsError && (
                    <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700 flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{gpsError}</span>
                    </div>
                  )}

                  {/* Controls */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {!allowDriverSelector && (
                      <button
                        onClick={handleToggleConsent}
                        className={`min-h-[48px] flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold transition-colors cursor-pointer ${
                          gpsConsent
                            ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                            : 'bg-[#0B1F3A] text-white hover:bg-[#13325c]'
                        }`}
                      >
                        <Navigation className="w-4 h-4" />
                        {gpsConsent
                          ? 'إيقاف البث التلقائي من هذا الجهاز'
                          : 'الموافقة وتفعيل التتبع الدائم'}
                      </button>
                    )}

                    <button
                      onClick={() => handleTogglePause(vehicleGpsStatus !== 'paused')}
                      className={`min-h-[48px] flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-bold transition-colors cursor-pointer ${
                        vehicleGpsStatus === 'paused'
                          ? 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                          : 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100'
                      }`}
                    >
                      {vehicleGpsStatus === 'paused' ? (
                        <>
                          <PlayCircle className="w-4 h-4" />
                          استئناف مشاركة الموقع
                        </>
                      ) : (
                        <>
                          <PauseCircle className="w-4 h-4" />
                          إيقاف مشاركة الموقع مؤقتاً
                        </>
                      )}
                    </button>

                    {!allowDriverSelector && (
                      <button
                        onClick={handleManualPing}
                        disabled={gpsSending || !driver.vehicleId}
                        className="sm:col-span-2 min-h-[44px] flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
                      >
                        <RefreshCw className={`w-4 h-4 ${gpsSending ? 'animate-spin' : ''}`} />
                        إرسال تحديث موقع فوري الآن
                      </button>
                    )}
                  </div>

                  {/* Telemetry Details (Hairline rows instead of nested grey box) */}
                  <div className="border-t border-slate-100 divide-y divide-slate-100 text-xs">
                    <div className="py-2.5 flex items-center justify-between gap-3">
                      <span className="text-slate-500">ساعات العمل المجدولة يومياً:</span>
                      <span className="font-bold text-[#0B1F3A] tabular-nums">
                        {scheduleStatus.windowLabelAr}
                      </span>
                    </div>
                    <div className="py-2.5 flex items-center justify-between gap-3">
                      <span className="text-slate-500">حالة البيانات المعروضة للإدارة والمشرفة:</span>
                      <span className="font-bold text-[#0B1F3A]">
                        {isLiveSharing
                          ? 'موقع حي ومباشر'
                          : vehicleGpsStatus === 'paused'
                          ? 'متوقف بناءً على طلب السائق'
                          : 'آخر موقع مسجل'}
                      </span>
                    </div>
                    {latestGps && (
                      <>
                        <div className="py-2.5 flex items-center justify-between gap-3">
                          <span className="text-slate-500">الإحداثيات:</span>
                          <span className="font-mono text-slate-800" dir="ltr">
                            {latestGps.lat.toFixed(5)}, {latestGps.lng.toFixed(5)}
                          </span>
                        </div>
                        <div className="py-2.5 flex items-center justify-between gap-3">
                          <span className="text-slate-500">توقيت آخر تسجيل:</span>
                          <span className="text-slate-800">
                            {formatRelativeArabicTime(lastLocalPingAt || latestGps.recordedAt)}
                          </span>
                        </div>
                      </>
                    )}
                    {queuedGpsCount > 0 && (
                      <div className="py-2.5 flex items-center justify-between gap-3 text-amber-800">
                        <span>نقاط مخزنة محلياً للمزامنة:</span>
                        <span className="font-mono font-bold tabular-nums">{queuedGpsCount} نقطة</span>
                      </div>
                    )}
                  </div>
                </section>

                {/* Privacy Notice */}
                <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-2">
                  <div className="flex items-center gap-2 font-display text-sm font-bold text-[#0B1F3A]">
                    <ShieldAlert className="w-4 h-4 text-[#C89B3C]" />
                    <span>إشعار الخصوصية وجدولة التتبع</span>
                  </div>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    يعمل التتبع التلقائي يومياً خلال ساعات الرحلات المدرسية من 06:00 صباحاً حتى 04:00
                    عصراً طوال العام عند تفعيل الإنترنت وبيانات الهاتف، مع حفظ النقاط مؤقتاً عند
                    ضعف الشبكة وإرسالها تلقائياً فور عودة الاتصال. يمكنك إيقاف المشاركة مؤقتاً في أي
                    وقت عبر الزر أعلاه.
                  </p>
                </section>
              </div>
            )}

            {/* TAB 4: NOTIFICATIONS */}
            {activeTab === 'notifications' && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h1 className="font-display text-lg font-bold text-[#0B1F3A]">
                    الإشعارات والتنبيهات ({(data.notifications || []).length})
                  </h1>
                  <div className="flex flex-wrap items-center gap-2">
                    {unreadCount > 0 && (
                      <button
                        type="button"
                        onClick={handleMarkAllNotificationsRead}
                        className="min-h-[38px] inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-[#0B1F3A] hover:bg-slate-50 cursor-pointer"
                      >
                        <CheckCheck className="w-3.5 h-3.5 text-emerald-600" />
                        تحديد الكل كمقروء
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => loadDriverData()}
                      className="min-h-[38px] flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      تحديث
                    </button>
                  </div>
                </div>

                {/* Background Notification & Voice Reader Controls */}
                <section className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-9 h-9 rounded-xl bg-[#0B1F3A] text-[#C89B3C] flex items-center justify-center shrink-0">
                        <BellRing className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <h2 className="font-display text-sm font-bold text-[#0B1F3A]">
                          قراءة الإشعارات في الخلفية (تلقائياً)
                        </h2>
                        <p className="text-[11px] text-slate-500">
                          مزامنة تلقائية للإشعارات في الخلفية مع قراءة صوتية عربية أثناء القيادة
                        </p>
                      </div>
                    </div>

                    {isSpeechSynthesisAvailable() && (data.notifications || []).length > 0 && (
                      <button
                        type="button"
                        onClick={handleReadUnreadAloud}
                        className={`min-h-[38px] inline-flex items-center gap-1.5 rounded-xl px-3.5 text-xs font-bold cursor-pointer transition-colors ${
                          isSpeakingNotifs
                            ? 'bg-red-600 text-white hover:bg-red-700'
                            : 'bg-[#0B1F3A] text-white hover:bg-[#13325c]'
                        }`}
                      >
                        {isSpeakingNotifs ? (
                          <>
                            <VolumeX className="w-3.5 h-3.5" />
                            إيقاف القراءة الصوتية
                          </>
                        ) : (
                          <>
                            <Volume2 className="w-3.5 h-3.5 text-[#C89B3C]" />
                            {unreadCount > 0
                              ? `قراءة غير المقروء (${unreadCount})`
                              : 'قراءة أحدث الإشعارات'}
                          </>
                        )}
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-2 border-t border-slate-100 text-xs">
                    <button
                      type="button"
                      onClick={handleToggleBgNotify}
                      className={`flex items-center justify-between rounded-xl border px-3.5 py-2.5 font-semibold cursor-pointer transition-colors ${
                        bgNotifyEnabled
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                          : 'border-slate-200 bg-slate-50 text-slate-600'
                      }`}
                    >
                      <span>التنبيه التلقائي في الخلفية</span>
                      <span>{bgNotifyEnabled ? 'مفعل' : 'متوقف'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={handleToggleBgVoice}
                      className={`flex items-center justify-between rounded-xl border px-3.5 py-2.5 font-semibold cursor-pointer transition-colors ${
                        bgVoiceEnabled
                          ? 'border-amber-200 bg-amber-50 text-amber-950'
                          : 'border-slate-200 bg-slate-50 text-slate-600'
                      }`}
                    >
                      <span>القراءة الصوتية التلقائية للإشعارات</span>
                      <span>{bgVoiceEnabled ? 'مفعل' : 'متوقف'}</span>
                    </button>
                  </div>

                  {!allowDriverSelector && notifPermission !== 'granted' && notifPermission !== 'unsupported' && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3.5 py-2.5 text-xs text-amber-950">
                      <span>
                        {notifPermission === 'denied'
                          ? 'تم حظر إشعارات المتصفح من إعدادات الجهاز — يمكن تفعيلها من إعدادات الموقع في المتصفح.'
                          : 'فعّل إذن إشعارات النظام ليصلك التنبيه في شريط الهاتف حتى عند تصغير التطبيق.'}
                      </span>
                      {notifPermission === 'default' && (
                        <button
                          type="button"
                          onClick={handleRequestNotifPermission}
                          className="rounded-lg bg-[#0B1F3A] hover:bg-[#13325c] px-3 py-1.5 text-[11px] font-bold text-[#C89B3C] cursor-pointer shrink-0"
                        >
                          تفعيل إشعارات الهاتف
                        </button>
                      )}
                    </div>
                  )}
                </section>

                {(data.notifications || []).length === 0 ? (
                  <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-sm text-slate-500">
                    لا توجد إشعارات مسجلة لحسابك حتى الآن.
                  </div>
                ) : (
                  (data.notifications || []).map((n) => (
                    <div
                      key={n.id}
                      className={`rounded-2xl border p-4 space-y-2 ${
                        n.isRead
                          ? 'border-slate-200 bg-white'
                          : 'border-amber-200 bg-amber-50/60'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <h3 className="text-sm font-bold text-[#0B1F3A]">{n.title}</h3>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {isSpeechSynthesisAvailable() && (
                            <button
                              type="button"
                              onClick={() => handleReadSingleNotification(n)}
                              className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-semibold cursor-pointer ${
                                speakingNotifId === n.id
                                  ? 'border-red-200 bg-red-50 text-red-700'
                                  : 'border-slate-200 bg-white text-[#0B1F3A] hover:bg-slate-50'
                              }`}
                            >
                              {speakingNotifId === n.id ? (
                                <>
                                  <VolumeX className="w-3 h-3" />
                                  إيقاف
                                </>
                              ) : (
                                <>
                                  <Volume2 className="w-3 h-3 text-[#C89B3C]" />
                                  استماع
                                </>
                              )}
                            </button>
                          )}
                          {!n.isRead && (
                            <button
                              onClick={() => handleMarkNotificationRead(n.id)}
                              className="inline-flex items-center gap-1 rounded-lg bg-[#0B1F3A] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#13325c] cursor-pointer"
                            >
                              <Check className="w-3 h-3" />
                              تمت القراءة
                            </button>
                          )}
                        </div>
                      </div>
                      <p className="text-xs text-slate-700 leading-relaxed">{n.body}</p>
                      <div className="flex items-center justify-between gap-2 pt-1">
                        <p className="text-[11px] text-slate-400">
                          {formatRelativeArabicTime(n.createdAt)}
                        </p>
                        {n.type === 'drivers_broadcast' && (
                          <button
                            type="button"
                            onClick={() => {
                              if (!n.isRead) handleMarkNotificationRead(n.id);
                              navigateTab('chat', 'drivers_broadcast');
                            }}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-[#0B1F3A] px-3 py-1 text-[11px] font-bold text-[#C89B3C] hover:bg-[#13325c] cursor-pointer"
                          >
                            <RadioTower className="w-3 h-3" />
                            فتح رسالة الإدارة
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
            {/* TAB: CHAT & VOICE HUB */}
            {activeTab === 'chat' && (
              <div className="space-y-3">
                <ChatHubModule
                  currentRole="driver"
                  initialRoomKey={
                    chatInitialRoomKey || (data.driver?.routeId ? `route_${data.driver.routeId}` : 'broadcast')
                  }
                  compact={false}
                  onClose={goBackTab}
                />
              </div>
            )}
          </>
        )}

        <CompanyLegalFooter
          variant="light"
          compact
          className="rounded-2xl border border-slate-200 shadow-xs mt-6"
        />
        <AppVersionBadge variant="light" className="mt-3 px-1" />
      </main>

      {/* Bottom Thumb-Zone Navigation Bar */}
      <nav className="fixed bottom-0 inset-x-0 z-30 h-16 bg-white border-t border-slate-200">
        <div className="max-w-3xl mx-auto h-full grid grid-cols-6">
          <button
            onClick={() => navigateTab('home')}
            className={`min-h-[44px] flex flex-col items-center justify-center gap-1 text-xs font-semibold transition-colors cursor-pointer ${
              activeTab === 'home' ? 'text-[#0B1F3A]' : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <Home className={`w-5 h-5 ${activeTab === 'home' ? 'text-[#C89B3C]' : ''}`} />
            <span>الرئيسية</span>
          </button>

          <button
            onClick={() => navigateTab('finance')}
            className={`min-h-[44px] flex flex-col items-center justify-center gap-1 text-xs font-semibold transition-colors cursor-pointer ${
              activeTab === 'finance' ? 'text-[#0B1F3A]' : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <Wallet className={`w-5 h-5 ${activeTab === 'finance' ? 'text-[#C89B3C]' : ''}`} />
            <span>المالية</span>
          </button>

          <button
            onClick={() => navigateTab('chat')}
            className={`min-h-[44px] flex flex-col items-center justify-center gap-1 text-xs font-semibold transition-colors cursor-pointer ${
              activeTab === 'chat' ? 'text-[#0B1F3A]' : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <MessageSquare className={`w-5 h-5 ${activeTab === 'chat' ? 'text-[#C89B3C]' : ''}`} />
            <span>المحادثات</span>
          </button>

          <button
            onClick={() => navigateTab('location')}
            className={`min-h-[44px] flex flex-col items-center justify-center gap-1 text-xs font-semibold transition-colors cursor-pointer ${
              activeTab === 'location' ? 'text-[#0B1F3A]' : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <MapPin className={`w-5 h-5 ${activeTab === 'location' ? 'text-[#C89B3C]' : ''}`} />
            <span>الموقع</span>
          </button>

          <button
            onClick={() => navigateTab('maintenance')}
            className={`min-h-[44px] flex flex-col items-center justify-center gap-1 text-xs font-semibold transition-colors cursor-pointer ${
              activeTab === 'maintenance' ? 'text-[#0B1F3A]' : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <Wrench className={`w-5 h-5 ${activeTab === 'maintenance' ? 'text-[#C89B3C]' : ''}`} />
            <span>الصيانة</span>
          </button>

          <button
            onClick={() => navigateTab('notifications')}
            className={`relative min-h-[44px] flex flex-col items-center justify-center gap-1 text-xs font-semibold transition-colors cursor-pointer ${
              activeTab === 'notifications'
                ? 'text-[#0B1F3A]'
                : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <div className="relative">
              <Bell
                className={`w-5 h-5 ${activeTab === 'notifications' ? 'text-[#C89B3C]' : ''}`}
              />
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-2 min-w-[16px] h-4 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center px-1 tabular-nums">
                  {unreadCount}
                </span>
              )}
            </div>
            <span>الإشعارات</span>
          </button>
        </div>
      </nav>
    </div>
  );
};
