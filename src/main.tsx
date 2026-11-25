import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';
import {
  notifyUpdateNeeded,
  setRegisteredSW,
  setUpdateSWHandler,
} from './lib/pwa-update';

// Tier 1: Google Maps Platform Demo Key Quota / Auth Failure Listener
(window as unknown as { gm_authFailure?: () => void }).gm_authFailure = () => {
  window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
};

const origConsoleError = console.error;
console.error = (...args: unknown[]) => {
  origConsoleError.apply(console, args);
  const msg = args.map((a) => String(a)).join(' ');
  if (msg.includes('OverQuotaMapError') || msg.includes('QuotaExceededError')) {
    window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
  }
};

if (import.meta.env.DEV && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((regs) => {
      regs.forEach((reg) => {
        if (reg.active?.scriptURL?.includes('dev-sw')) {
          reg.unregister().catch(() => undefined);
        }
      });
    })
    .catch(() => undefined);
} else {
  let updateCheckTimerId: number | undefined;
  let visibilityListenerBound = false;

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      notifyUpdateNeeded(false);
    },
    onRegisteredSW(_swUrl, registration) {
      setRegisteredSW(registration);
      if (!registration) return;

      const triggerUpdateCheck = () => {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        registration.update().catch(() => undefined);
      };

      if (updateCheckTimerId) {
        window.clearInterval(updateCheckTimerId);
      }
      updateCheckTimerId = window.setInterval(triggerUpdateCheck, 15 * 60 * 1000);

      if (!visibilityListenerBound) {
        visibilityListenerBound = true;
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            triggerUpdateCheck();
          }
        });
      }
    },
  });

  setUpdateSWHandler(updateSW);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
