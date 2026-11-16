import type { DbUser, DriverLicensePhoto } from '../types';

const DB_NAME = 'alwaleed_local_store';
const DB_VERSION = 1;

const STORE_SESSION = 'session_cache';
const STORE_PROFILES = 'driver_profiles';
const STORE_PENDING_SYNC = 'pending_sync';
const STORE_GPS_QUEUE = 'gps_queue';
const STORE_AUTH_META = 'auth_meta';

export interface CachedSessionRecord {
  key: 'active_session';
  dbUser: DbUser;
  driverRecord: { id: number; driverCode: string; fullName: string } | null;
  supervisorRecord: { id: number; supervisorCode: string; fullName: string; phone: string } | null;
  cachedAt: string;
}

export interface QueuedGpsPoint {
  id?: number;
  vehicleId: number;
  lat: number;
  lng: number;
  speedKmh: number;
  heading: number;
  accuracyMeters: number;
  recordedAt: string;
}

export interface PendingLicenseSync {
  id: string;
  type: 'licenses';
  driverId?: number;
  licensePhotos: DriverLicensePhoto[];
  createdAt: string;
}

function openLocalDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SESSION)) {
        db.createObjectStore(STORE_SESSION, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_PROFILES)) {
        db.createObjectStore(STORE_PROFILES, { keyPath: 'driverId' });
      }
      if (!db.objectStoreNames.contains(STORE_PENDING_SYNC)) {
        db.createObjectStore(STORE_PENDING_SYNC, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_GPS_QUEUE)) {
        db.createObjectStore(STORE_GPS_QUEUE, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_AUTH_META)) {
        db.createObjectStore(STORE_AUTH_META, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
  });
}

async function idbGet<T>(storeName: string, key: IDBValidKey): Promise<T | null> {
  try {
    const db = await openLocalDb();
    return await new Promise<T | null>((resolve) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve((req.result as T) || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function idbPut<T>(storeName: string, value: T): Promise<void> {
  try {
    const db = await openLocalDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // ignore storage quota errors cleanly
  }
}

async function idbDelete(storeName: string, key: IDBValidKey): Promise<void> {
  try {
    const db = await openLocalDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // ignore
  }
}

async function idbGetAll<T>(storeName: string): Promise<T[]> {
  try {
    const db = await openLocalDb();
    return await new Promise<T[]>((resolve) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? (req.result as T[]) : []);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

// 1. Session Cache (for instant zero-flicker offline-capable auto-login)
export async function saveCachedSession(session: Omit<CachedSessionRecord, 'key' | 'cachedAt'>) {
  await idbPut<CachedSessionRecord>(STORE_SESSION, {
    key: 'active_session',
    ...session,
    cachedAt: new Date().toISOString(),
  });
}

export async function getCachedSession(): Promise<CachedSessionRecord | null> {
  return idbGet<CachedSessionRecord>(STORE_SESSION, 'active_session');
}

export async function clearCachedSession() {
  await idbDelete(STORE_SESSION, 'active_session');
}

// Mirror token into IndexedDB so Service Worker can flush GPS queue in background
export async function saveSessionTokenMeta(token: string | null) {
  if (token) {
    await idbPut(STORE_AUTH_META, { key: 'session_token', token, updatedAt: Date.now() });
  } else {
    await idbDelete(STORE_AUTH_META, 'session_token');
  }
}

// 2. Robust Driver Profile + Avatar + License Photos Cache
export async function saveCachedDriverProfile<T extends { driver?: { id?: number } | null }>(
  driverId: number,
  payload: T
) {
  await idbPut(STORE_PROFILES, {
    driverId,
    payload,
    updatedAt: new Date().toISOString(),
  });
}

export async function getCachedDriverProfile<T>(driverId: number): Promise<T | null> {
  const row = await idbGet<{ driverId: number; payload: T }>(STORE_PROFILES, driverId);
  return row?.payload || null;
}

// 3. Pending Offline License/Document Sync Queue
export async function queuePendingLicenseSync(entry: Omit<PendingLicenseSync, 'id' | 'createdAt'>) {
  const id = `lic_sync_${entry.driverId || 'self'}`;
  await idbPut<PendingLicenseSync>(STORE_PENDING_SYNC, {
    ...entry,
    id,
    createdAt: new Date().toISOString(),
  });
}

export async function getPendingLicenseSyncs(): Promise<PendingLicenseSync[]> {
  return idbGetAll<PendingLicenseSync>(STORE_PENDING_SYNC);
}

export async function removePendingLicenseSync(id: string) {
  await idbDelete(STORE_PENDING_SYNC, id);
}

// 4. Offline GPS Queue (flushed automatically when connectivity restores or via SW Sync)
export async function enqueueGpsPoint(point: Omit<QueuedGpsPoint, 'id'>): Promise<void> {
  try {
    const db = await openLocalDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_GPS_QUEUE, 'readwrite');
      const store = tx.objectStore(STORE_GPS_QUEUE);
      const countReq = store.count();
      countReq.onsuccess = () => {
        if ((countReq.result || 0) >= 500) {
          // Cap queue at 500 points (oldest dropped via cursor)
          const cursorReq = store.openCursor();
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor) cursor.delete();
            store.add(point);
          };
        } else {
          store.add(point);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // ignore
  }
}

export async function getQueuedGpsPoints(): Promise<QueuedGpsPoint[]> {
  return idbGetAll<QueuedGpsPoint>(STORE_GPS_QUEUE);
}

export async function removeQueuedGpsPoints(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const db = await openLocalDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_GPS_QUEUE, 'readwrite');
      const store = tx.objectStore(STORE_GPS_QUEUE);
      for (const id of ids) {
        store.delete(id);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // ignore
  }
}
