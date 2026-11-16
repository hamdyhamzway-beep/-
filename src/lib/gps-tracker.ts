import { apiFetch } from './api';
import {
  enqueueGpsPoint,
  getQueuedGpsPoints,
  removeQueuedGpsPoints,
} from './local-store';

export const TRACKING_START_HOUR = 6; // 06:00 AM daily
export const TRACKING_END_HOUR = 16; // 04:00 PM (16:00) daily

export const HIGH_ACCURACY_GPS_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 10000,
};

export interface ScheduleWindowStatus {
  isWithinWindow: boolean;
  windowLabelAr: string;
  statusLabelAr: string;
  msUntilNextTransition: number;
}

/**
 * Checks whether local time is within the daily tracking window:
 * 06:00 AM (06:00) to 04:00 PM (16:00) every day year-round.
 */
export function isWithinDailyTrackingWindow(now: Date = new Date()): boolean {
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= TRACKING_START_HOUR * 60 && mins < TRACKING_END_HOUR * 60;
}

export function getDailyScheduleStatus(now: Date = new Date()): ScheduleWindowStatus {
  const mins = now.getHours() * 60 + now.getMinutes();
  const secs = now.getSeconds();
  const startMins = TRACKING_START_HOUR * 60;
  const endMins = TRACKING_END_HOUR * 60;
  const isWithin = mins >= startMins && mins < endMins;

  let msUntilNextTransition = 60_000;
  if (isWithin) {
    const remainingSecs = (endMins - mins) * 60 - secs;
    msUntilNextTransition = Math.max(5_000, remainingSecs * 1000);
  } else {
    const minsUntilStart = mins < startMins ? startMins - mins : 24 * 60 - mins + startMins;
    const remainingSecs = minsUntilStart * 60 - secs;
    msUntilNextTransition = Math.max(5_000, remainingSecs * 1000);
  }

  return {
    isWithinWindow: isWithin,
    windowLabelAr: '06:00 صباحاً – 04:00 عصراً (يومياً)',
    statusLabelAr: isWithin
      ? 'ضمن ساعات العمل المجدولة (بث تلقائي نشط)'
      : 'خارج ساعات العمل المجدولة (يبدأ تلقائياً 06:00 ص)',
    msUntilNextTransition,
  };
}

export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface SpeedEstimateResult {
  speedKmh: number;
  heading: number;
  accuracyMeters: number;
  source: 'doppler' | 'haversine' | 'stationary';
}

/**
 * High-precision real-time speed calculator combining native GPS Doppler velocity
 * with Haversine Δdistance/Δtime fallback and stationary GPS-drift suppression.
 */
export class HighPrecisionSpeedEstimator {
  private prevFix: {
    lat: number;
    lng: number;
    timestampMs: number;
    accuracy: number;
  } | null = null;
  private smoothedSpeedKmh = 0;

  reset() {
    this.prevFix = null;
    this.smoothedSpeedKmh = 0;
  }

  compute(coords: GeolocationCoordinates, timestampMs: number): SpeedEstimateResult {
    const accuracy = Number.isFinite(coords.accuracy) ? Math.max(1, coords.accuracy) : 25;
    const heading =
      coords.heading !== null && Number.isFinite(coords.heading) && coords.heading >= 0
        ? Math.round(coords.heading)
        : 0;

    let rawSpeedKmh = 0;
    let source: SpeedEstimateResult['source'] = 'stationary';

    const hasValidDoppler =
      coords.speed !== null &&
      Number.isFinite(coords.speed) &&
      coords.speed >= 0 &&
      accuracy <= 40;

    if (hasValidDoppler) {
      rawSpeedKmh = coords.speed! * 3.6;
      source = rawSpeedKmh >= 2 ? 'doppler' : 'stationary';
    } else if (this.prevFix && accuracy <= 55) {
      const dtSec = (timestampMs - this.prevFix.timestampMs) / 1000;
      if (dtSec >= 1.2 && dtSec <= 45) {
        const distM = haversineMeters(
          this.prevFix.lat,
          this.prevFix.lng,
          coords.latitude,
          coords.longitude
        );
        // Reject jitter smaller than combined GPS accuracy radius
        const noiseFloorM = Math.max(3.5, Math.min(25, Math.max(accuracy, this.prevFix.accuracy) * 0.55));
        if (distM >= noiseFloorM) {
          const calcKmh = (distM / dtSec) * 3.6;
          if (calcKmh <= 160) {
            rawSpeedKmh = calcKmh;
            source = calcKmh >= 2 ? 'haversine' : 'stationary';
          }
        }
      }
    }

    if (accuracy <= 65) {
      this.prevFix = {
        lat: coords.latitude,
        lng: coords.longitude,
        timestampMs,
        accuracy,
      };
    }

    // Dead-zone filter: below 2.0 km/h treated as stationary
    if (rawSpeedKmh < 2.0) {
      this.smoothedSpeedKmh = 0;
      return {
        speedKmh: 0,
        heading,
        accuracyMeters: Math.round(accuracy),
        source: 'stationary',
      };
    }

    // Exponential moving average for smooth real-time display without lag
    this.smoothedSpeedKmh =
      this.smoothedSpeedKmh === 0
        ? rawSpeedKmh
        : this.smoothedSpeedKmh * 0.45 + rawSpeedKmh * 0.55;

    const clamped = Math.min(180, Math.max(0, Number(this.smoothedSpeedKmh.toFixed(1))));

    return {
      speedKmh: clamped,
      heading,
      accuracyMeters: Math.round(accuracy),
      source,
    };
  }
}

export async function requestBackgroundSyncRegistration() {
  try {
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      const reg = await navigator.serviceWorker.ready;
      const syncReg = reg as ServiceWorkerRegistration & {
        sync?: { register: (tag: string) => Promise<void> };
      };
      if (syncReg.sync) {
        await syncReg.sync.register('alwaleed-gps-sync');
      }
    }
  } catch {
    // Background Sync API is optional across browsers
  }
}

export function isValidGpsCoordinate(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  if (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) return false;
  return true;
}

export async function transmitOrQueueGpsFix(input: {
  vehicleId: number;
  lat: number;
  lng: number;
  speedKmh: number;
  heading: number;
  accuracyMeters: number;
  recordedAt?: string;
  source?: 'live' | 'manual';
}): Promise<{ delivered: boolean; queued: boolean }> {
  if (!isValidGpsCoordinate(input.lat, input.lng)) {
    return { delivered: false, queued: false };
  }

  const recordedAt = input.recordedAt || new Date().toISOString();

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    await enqueueGpsPoint({
      vehicleId: input.vehicleId,
      lat: input.lat,
      lng: input.lng,
      speedKmh: input.speedKmh,
      heading: input.heading,
      accuracyMeters: input.accuracyMeters,
      recordedAt,
    });
    await requestBackgroundSyncRegistration();
    return { delivered: false, queued: true };
  }

  try {
    await apiFetch('/api/gps/update', {
      method: 'POST',
      body: JSON.stringify({
        vehicleId: input.vehicleId,
        lat: input.lat,
        lng: input.lng,
        speedKmh: Number(input.speedKmh.toFixed(1)),
        heading: input.heading,
        accuracyMeters: Math.round(input.accuracyMeters),
        recordedAt,
        source: input.source || 'live',
      }),
    });
    return { delivered: true, queued: false };
  } catch {
    await enqueueGpsPoint({
      vehicleId: input.vehicleId,
      lat: input.lat,
      lng: input.lng,
      speedKmh: input.speedKmh,
      heading: input.heading,
      accuracyMeters: input.accuracyMeters,
      recordedAt,
    });
    await requestBackgroundSyncRegistration();
    return { delivered: false, queued: true };
  }
}

export async function flushQueuedGpsPoints(): Promise<{
  flushed: number;
  remaining: number;
}> {
  let all = await getQueuedGpsPoints();
  if (all.length === 0) return { flushed: 0, remaining: 0 };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { flushed: 0, remaining: all.length };
  }

  let totalFlushed = 0;
  let batchesProcessed = 0;
  const maxBatches = 6;

  while (all.length > 0 && batchesProcessed < maxBatches) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) break;
    const batch = all.slice(0, 100);
    const validBatch = batch.filter((p) => isValidGpsCoordinate(p.lat, p.lng));
    try {
      if (validBatch.length > 0) {
        await apiFetch('/api/gps/sync-batch', {
          method: 'POST',
          body: JSON.stringify({ points: validBatch }),
        });
      }
      const idsToDelete = batch
        .map((p) => p.id)
        .filter((id): id is number => typeof id === 'number');
      await removeQueuedGpsPoints(idsToDelete);
      totalFlushed += validBatch.length;
      all = all.slice(batch.length);
      batchesProcessed += 1;
    } catch {
      return { flushed: totalFlushed, remaining: all.length };
    }
  }

  return { flushed: totalFlushed, remaining: all.length };
}
