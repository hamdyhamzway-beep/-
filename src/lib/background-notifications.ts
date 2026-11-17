import type { NotificationItem } from '../types';

const BG_NOTIFY_PREF_KEY = 'alwaleed_driver_bg_notify_enabled';
const BG_VOICE_PREF_KEY = 'alwaleed_driver_voice_read_enabled';
const SEEN_NOTIFS_PREFIX = 'alwaleed_driver_announced_notifs_';

export function getBgNotifyEnabled(): boolean {
  try {
    const val = localStorage.getItem(BG_NOTIFY_PREF_KEY);
    return val === null ? true : val === 'true';
  } catch {
    return true;
  }
}

export function setBgNotifyEnabledPref(enabled: boolean): void {
  try {
    localStorage.setItem(BG_NOTIFY_PREF_KEY, String(enabled));
  } catch {
    // ignore storage errors
  }
}

export function getBgVoiceEnabled(): boolean {
  try {
    const val = localStorage.getItem(BG_VOICE_PREF_KEY);
    return val === null ? true : val === 'true';
  } catch {
    return true;
  }
}

export function setBgVoiceEnabledPref(enabled: boolean): void {
  try {
    localStorage.setItem(BG_VOICE_PREF_KEY, String(enabled));
  } catch {
    // ignore storage errors
  }
}

export function getAnnouncedNotificationIds(driverId: number): Set<number> {
  try {
    const raw = localStorage.getItem(`${SEEN_NOTIFS_PREFIX}${driverId}`);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((x) => typeof x === 'number'));
    }
  } catch {
    // ignore
  }
  return new Set();
}

export function saveAnnouncedNotificationIds(driverId: number, ids: Set<number>): void {
  try {
    const trimmed = Array.from(ids).slice(-120);
    localStorage.setItem(`${SEEN_NOTIFS_PREFIX}${driverId}`, JSON.stringify(trimmed));
  } catch {
    // ignore
  }
}

export function getNotificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission;
}

export async function ensureDriverNotificationSwRegistered(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }
  try {
    const existing = await navigator.serviceWorker.getRegistration('/');
    if (existing) return existing;
    const reg = await navigator.serviceWorker.register('/sw-gps-sync.js', { scope: '/' });
    return reg;
  } catch {
    return null;
  }
}

export async function requestDriverNotificationPermission(): Promise<
  NotificationPermission | 'unsupported'
> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  try {
    await ensureDriverNotificationSwRegistered();
    if (Notification.permission === 'granted') return 'granted';
    const result = await Notification.requestPermission();
    return result;
  } catch {
    return getNotificationPermission();
  }
}

export function playNotificationChime(): void {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(660, now);
    osc1.frequency.exponentialRampToValueAtTime(880, now + 0.14);
    gain1.gain.setValueAtTime(0.001, now);
    gain1.gain.exponentialRampToValueAtTime(0.12, now + 0.03);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.32);

    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.34);

    window.setTimeout(() => {
      ctx.close().catch(() => undefined);
    }, 600);
  } catch {
    // ignore audio autoplay restrictions
  }
}

export function isSpeechSynthesisAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

function pickArabicVoice(): SpeechSynthesisVoice | null {
  if (!isSpeechSynthesisAvailable()) return null;
  try {
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return null;
    return (
      voices.find((v) => v.lang.toLowerCase().startsWith('ar-eg')) ||
      voices.find((v) => v.lang.toLowerCase().startsWith('ar-sa')) ||
      voices.find((v) => v.lang.toLowerCase().startsWith('ar')) ||
      null
    );
  } catch {
    return null;
  }
}

export function stopArabicSpeech(): void {
  if (!isSpeechSynthesisAvailable()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // ignore
  }
}

export function speakArabicText(
  text: string,
  options: { interrupt?: boolean; rate?: number; onEnd?: () => void } = {}
): boolean {
  if (!isSpeechSynthesisAvailable() || !text.trim()) return false;
  try {
    if (options.interrupt !== false) {
      window.speechSynthesis.cancel();
    }
    const utterance = new SpeechSynthesisUtterance(text.trim());
    utterance.lang = 'ar-EG';
    utterance.rate = options.rate ?? 0.96;
    utterance.pitch = 1;
    const voice = pickArabicVoice();
    if (voice) {
      utterance.voice = voice;
    }
    if (options.onEnd) {
      utterance.onend = options.onEnd;
      utterance.onerror = options.onEnd;
    }
    window.speechSynthesis.speak(utterance);
    return true;
  } catch {
    return false;
  }
}

export function speakNotificationsQueue(
  items: NotificationItem[],
  onFinished?: () => void
): boolean {
  if (!isSpeechSynthesisAvailable() || items.length === 0) {
    onFinished?.();
    return false;
  }
  try {
    window.speechSynthesis.cancel();
    const voice = pickArabicVoice();
    items.forEach((n, idx) => {
      const spokenText = `${n.title}. ${n.body}`;
      const utterance = new SpeechSynthesisUtterance(spokenText);
      utterance.lang = 'ar-EG';
      utterance.rate = 0.95;
      if (voice) utterance.voice = voice;
      if (idx === items.length - 1 && onFinished) {
        utterance.onend = onFinished;
        utterance.onerror = onFinished;
      }
      window.speechSynthesis.speak(utterance);
    });
    return true;
  } catch {
    onFinished?.();
    return false;
  }
}

export async function showSystemNotification(n: {
  id?: number;
  title: string;
  body: string;
}): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  if (Notification.permission !== 'granted') return false;

  const payload = {
    id: n.id,
    title: n.title || 'إشعار جديد · الوليد ترافيل',
    body: n.body || '',
    tag: `alwaleed-driver-notif-${n.id ?? Date.now()}`,
    url: '/',
  };

  try {
    if ('serviceWorker' in navigator) {
      const reg = await ensureDriverNotificationSwRegistered();
      if (reg && typeof reg.showNotification === 'function') {
        await reg.showNotification(payload.title, {
          body: payload.body,
          icon: '/pwa-192x192.png',
          badge: '/pwa-192x192.png',
          dir: 'rtl',
          lang: 'ar',
          tag: payload.tag,
          data: { url: payload.url, notificationId: payload.id ?? null },
        });
        return true;
      }
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: 'SHOW_BG_NOTIFICATION',
          payload,
        });
        return true;
      }
    }
  } catch {
    // Fallback to direct Notification constructor below
  }

  try {
    const notif = new Notification(payload.title, {
      body: payload.body,
      icon: '/pwa-192x192.png',
      dir: 'rtl',
      lang: 'ar',
      tag: payload.tag,
    });
    notif.onclick = () => {
      try {
        window.focus();
        window.dispatchEvent(new CustomEvent('alwaleed-open-notifications'));
      } catch {
        // ignore
      }
      notif.close();
    };
    return true;
  } catch {
    return false;
  }
}
