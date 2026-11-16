import crypto from 'crypto';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };

export interface DriverSessionPayload {
  typ: 'driver_session';
  userId: number;
  driverId: number;
  driverCode: string;
  iat: number;
  exp: number;
}

export interface SupervisorSessionPayload {
  typ: 'supervisor_session';
  userId: number;
  supervisorId: number;
  supervisorCode: string;
  iat: number;
  exp: number;
}

const DRIVER_PREFIX = 'drv_';
const SUPERVISOR_PREFIX = 'sup_';
const DEFAULT_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days persistent session for installed app
const REFRESH_THRESHOLD_MS = 150 * 24 * 60 * 60 * 1000; // Sliding refresh if <150 days remain

function getSigningSecret(): Buffer {
  const rawSecret = [
    process.env.DRIVER_AUTH_SECRET ||
      process.env.SESSION_SECRET ||
      process.env.SQL_PASSWORD ||
      process.env.GEMINI_API_KEY ||
      'alwaleed-driver-session-key',
    firebaseConfig.projectId,
    firebaseConfig.appId,
  ].join(':');

  return crypto.createHash('sha256').update(rawSecret).digest();
}

export function normalizeArabicDigits(input: string): string {
  return input
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
}

export function normalizeDriverCode(raw: unknown): string {
  if (typeof raw !== 'string' && typeof raw !== 'number') return '';
  return normalizeArabicDigits(String(raw)).trim();
}

export function normalizeArabicName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function normalizeEgyptPhone(raw: unknown): string {
  if (typeof raw !== 'string' && typeof raw !== 'number') return '';
  let cleaned = normalizeArabicDigits(String(raw)).replace(/[\u200e\u200f\u202a-\u202e\s\-().]/g, '');

  if (cleaned.startsWith('+20')) {
    cleaned = '0' + cleaned.slice(3);
  } else if (cleaned.startsWith('0020')) {
    cleaned = '0' + cleaned.slice(4);
  } else if (cleaned.startsWith('201') && cleaned.length === 12) {
    cleaned = '0' + cleaned.slice(2);
  }

  return cleaned;
}

function signPayload<T extends object>(prefix: string, payload: T): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', getSigningSecret())
    .update(payloadB64)
    .digest('base64url');

  return `${prefix}${payloadB64}.${signature}`;
}

function verifySignedPayload<T>(token: string, prefix: string): T | null {
  if (!token.startsWith(prefix)) return null;
  const body = token.slice(prefix.length);
  const dotIndex = body.indexOf('.');
  if (dotIndex === -1) return null;

  const payloadB64 = body.slice(0, dotIndex);
  const sigB64 = body.slice(dotIndex + 1);
  if (!payloadB64 || !sigB64) return null;

  const expectedSig = crypto
    .createHmac('sha256', getSigningSecret())
    .update(payloadB64)
    .digest();

  let actualSig: Buffer;
  try {
    actualSig = Buffer.from(sigB64, 'base64url');
  } catch {
    return null;
  }

  if (actualSig.length !== expectedSig.length || !crypto.timingSafeEqual(actualSig, expectedSig)) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function issueDriverSessionToken(input: {
  userId: number;
  driverId: number;
  driverCode: string;
}): string {
  const now = Date.now();
  const payload: DriverSessionPayload = {
    typ: 'driver_session',
    userId: input.userId,
    driverId: input.driverId,
    driverCode: input.driverCode,
    iat: now,
    exp: now + DEFAULT_TTL_MS,
  };
  return signPayload(DRIVER_PREFIX, payload);
}

export function verifyDriverSessionToken(token: string): DriverSessionPayload | null {
  const parsed = verifySignedPayload<DriverSessionPayload>(token, DRIVER_PREFIX);
  if (
    !parsed ||
    parsed.typ !== 'driver_session' ||
    typeof parsed.userId !== 'number' ||
    typeof parsed.driverId !== 'number' ||
    typeof parsed.exp !== 'number' ||
    parsed.exp <= Date.now()
  ) {
    return null;
  }
  return parsed;
}

export function issueSupervisorSessionToken(input: {
  userId: number;
  supervisorId: number;
  supervisorCode: string;
}): string {
  const now = Date.now();
  const payload: SupervisorSessionPayload = {
    typ: 'supervisor_session',
    userId: input.userId,
    supervisorId: input.supervisorId,
    supervisorCode: input.supervisorCode,
    iat: now,
    exp: now + DEFAULT_TTL_MS,
  };
  return signPayload(SUPERVISOR_PREFIX, payload);
}

export function verifySupervisorSessionToken(token: string): SupervisorSessionPayload | null {
  const parsed = verifySignedPayload<SupervisorSessionPayload>(token, SUPERVISOR_PREFIX);
  if (
    !parsed ||
    parsed.typ !== 'supervisor_session' ||
    typeof parsed.userId !== 'number' ||
    typeof parsed.supervisorId !== 'number' ||
    typeof parsed.exp !== 'number' ||
    parsed.exp <= Date.now()
  ) {
    return null;
  }
  return parsed;
}

export function shouldRefreshSessionToken(expMs: number): boolean {
  return expMs - Date.now() < REFRESH_THRESHOLD_MS;
}
