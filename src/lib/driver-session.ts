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

const TOKEN_PREFIX = 'drv_';
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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

  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', getSigningSecret())
    .update(payloadB64)
    .digest('base64url');

  return `${TOKEN_PREFIX}${payloadB64}.${signature}`;
}

export function verifyDriverSessionToken(token: string): DriverSessionPayload | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const body = token.slice(TOKEN_PREFIX.length);
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
    const parsed = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8')
    ) as DriverSessionPayload;

    if (
      parsed.typ !== 'driver_session' ||
      typeof parsed.userId !== 'number' ||
      typeof parsed.driverId !== 'number' ||
      typeof parsed.exp !== 'number' ||
      parsed.exp <= Date.now()
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}
