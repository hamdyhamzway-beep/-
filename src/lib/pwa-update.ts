import { flushQueuedGpsPoints } from './gps-tracker';

export type UpdateSWFn = (reloadPage?: boolean) => Promise<void>;

export type UpdateCheckResult = 'update-available' | 'up-to-date' | 'offline' | 'unsupported';

declare global {
  interface Window {
    __updateSW?: UpdateSWFn;
  }
}

let updateSWHandler: UpdateSWFn | null = null;
let swRegistrationRef: ServiceWorkerRegistration | null = null;
let updateAvailableFlag = false;
let isApplyingUpdate = false;

export const PWA_NEED_REFRESH_EVENT = 'pwa-need-refresh';

export function setUpdateSWHandler(fn: UpdateSWFn) {
  updateSWHandler = fn;
  if (typeof window !== 'undefined') {
    window.__updateSW = fn;
  }
}

export function setRegisteredSW(registration: ServiceWorkerRegistration | undefined) {
  swRegistrationRef = registration ?? null;
  if (registration?.waiting) {
    notifyUpdateNeeded(false);
  }
}

export function notifyUpdateNeeded(forceShow = false) {
  updateAvailableFlag = true;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(PWA_NEED_REFRESH_EVENT, {
        detail: { forceShow },
      })
    );
  }
}

export function hasWaitingUpdate(): boolean {
  return updateAvailableFlag || Boolean(swRegistrationRef?.waiting);
}

async function resolveRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (swRegistrationRef) return swRegistrationRef;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) swRegistrationRef = reg;
    return reg ?? null;
  } catch {
    return null;
  }
}

function waitForInstallingWorker(
  worker: ServiceWorker,
  timeoutMs = 3500
): Promise<'installed' | 'timeout'> {
  return new Promise((resolve) => {
    if (worker.state === 'installed') {
      resolve('installed');
      return;
    }
    let settled = false;
    const finish = (outcome: 'installed' | 'timeout') => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      worker.removeEventListener('statechange', onStateChange);
      resolve(outcome);
    };
    const onStateChange = () => {
      if (worker.state === 'installed' || worker.state === 'redundant') {
        finish(worker.state === 'installed' ? 'installed' : 'timeout');
      }
    };
    const timer = window.setTimeout(() => finish('timeout'), timeoutMs);
    worker.addEventListener('statechange', onStateChange);
  });
}

export async function checkForAppUpdate(): Promise<UpdateCheckResult> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'offline';
  }
  const registration = await resolveRegistration();
  if (!registration) {
    return 'unsupported';
  }

  if (registration.waiting) {
    notifyUpdateNeeded(true);
    return 'update-available';
  }

  try {
    await registration.update();
  } catch {
    // ignore transient update fetch errors and inspect current registration state
  }

  if (registration.waiting) {
    notifyUpdateNeeded(true);
    return 'update-available';
  }

  if (registration.installing) {
    await waitForInstallingWorker(registration.installing);
    if (registration.waiting || updateAvailableFlag) {
      notifyUpdateNeeded(true);
      return 'update-available';
    }
  }

  if (updateAvailableFlag) {
    notifyUpdateNeeded(true);
    return 'update-available';
  }

  return 'up-to-date';
}

export async function applyAppUpdate(): Promise<void> {
  if (isApplyingUpdate) return;
  isApplyingUpdate = true;

  try {
    // 1. Flush any queued GPS points first while online so trips are never interrupted mid-sync
    if (typeof navigator === 'undefined' || navigator.onLine !== false) {
      await Promise.race([
        flushQueuedGpsPoints().catch(() => undefined),
        new Promise<void>((resolve) => {
          window.setTimeout(resolve, 2500);
        }),
      ]);
    }

    // 2. Guard against reload loops using a one-time controllerchange listener
    let didReload = false;
    const reloadOnce = () => {
      if (didReload) return;
      didReload = true;
      window.location.reload();
    };

    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true });
    }

    const fn =
      updateSWHandler ?? (typeof window !== 'undefined' ? window.__updateSW : undefined) ?? null;

    if (fn) {
      await fn(true);
    } else {
      const reg = await resolveRegistration();
      if (reg?.waiting) {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      } else {
        reloadOnce();
        return;
      }
    }

    // Fallback in case controllerchange does not fire promptly after SKIP_WAITING
    window.setTimeout(() => {
      reloadOnce();
    }, 1800);
  } catch {
    isApplyingUpdate = false;
    throw new Error('UPDATE_APPLY_FAILED');
  }
}

export function getAppVersionInfo(): {
  version: string;
  buildTimeIso: string;
  formattedBuildTime: string;
} {
  const version = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0';
  const buildTimeIso =
    typeof __APP_BUILD_TIME__ !== 'undefined' ? __APP_BUILD_TIME__ : new Date().toISOString();

  let formattedBuildTime = buildTimeIso;
  try {
    const dt = new Date(buildTimeIso);
    if (!Number.isNaN(dt.getTime())) {
      const dateStr = new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
        timeZone: 'Africa/Cairo',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }).format(dt);
      const timeStr = new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
        timeZone: 'Africa/Cairo',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(dt);
      formattedBuildTime = `${dateStr} – ${timeStr}`;
    }
  } catch {
    // keep ISO fallback
  }

  return { version, buildTimeIso, formattedBuildTime };
}
