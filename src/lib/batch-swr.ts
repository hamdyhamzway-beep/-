/**
 * Stale-While-Revalidate (SWR) Batch Data Fetching Cache for Dashboard & Admin Modules
 */
import { apiFetch, registerApiMutationListener } from './api';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const memoryCache = new Map<string, CacheEntry<unknown>>();
const inFlightRequests = new Map<string, Promise<unknown>>();

const DEFAULT_TTL_MS = 60 * 1000; // 60 seconds stale TTL

// Automatically clear in-memory SWR cache when any POST/PATCH/DELETE mutation succeeds
registerApiMutationListener(() => {
  clearSwrCache();
});

export interface SwrOptions<T> {
  ttlMs?: number;
  forceRefresh?: boolean;
  onRevalidate?: (freshData: T) => void;
}

/**
 * Fetches data using Stale-While-Revalidate strategy:
 * 1. If cached data exists in memory, returns it immediately (stale).
 * 2. In the background (or foreground if no cache), fetches fresh data from the server.
 * 3. Updates cache and invokes onRevalidate when fresh data arrives.
 */
export async function fetchWithSWR<T>(
  url: string,
  options: RequestInit = {},
  swrOptions: SwrOptions<T> = {}
): Promise<{ data: T; isStale: boolean }> {
  const ttl = swrOptions.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();
  const cached = memoryCache.get(url) as CacheEntry<T> | undefined;

  const fetchFresh = async (): Promise<T> => {
    // Deduplicate in-flight requests for the same URL
    if (inFlightRequests.has(url)) {
      return inFlightRequests.get(url) as Promise<T>;
    }

    const promise = apiFetch<T>(url, options)
      .then((freshData) => {
        memoryCache.set(url, { data: freshData, timestamp: Date.now() });
        inFlightRequests.delete(url);
        if (swrOptions.onRevalidate) {
          try {
            swrOptions.onRevalidate(freshData);
          } catch {
            // ignore revalidate callback error
          }
        }
        return freshData;
      })
      .catch((err) => {
        inFlightRequests.delete(url);
        throw err;
      });

    inFlightRequests.set(url, promise);
    return promise;
  };

  if (cached && !swrOptions.forceRefresh) {
    const isStale = now - cached.timestamp > ttl;
    if (isStale) {
      // Revalidate in background without blocking
      fetchFresh().catch(() => {});
    }
    return { data: cached.data, isStale };
  }

  // No cache available: block until fresh data loads
  const freshData = await fetchFresh();
  return { data: freshData, isStale: false };
}

/**
 * Batch fetches multiple API endpoints in parallel using SWR optimization.
 */
export async function batchFetchSWR<TMap extends Record<string, string>>(
  urlsMap: TMap,
  options: RequestInit = {}
): Promise<{ [K in keyof TMap]: unknown }> {
  const keys = Object.keys(urlsMap) as Array<keyof TMap>;
  const promises = keys.map(async (key) => {
    const url = urlsMap[key];
    const { data } = await fetchWithSWR(url, options);
    return [key, data] as const;
  });

  const results = await Promise.all(promises);
  return Object.fromEntries(results) as { [K in keyof TMap]: unknown };
}

/**
 * Clears the SWR memory cache (e.g. after mutations or logouts).
 */
export function clearSwrCache(): void {
  memoryCache.clear();
  inFlightRequests.clear();
}
