import 'dotenv/config';
import http from 'http';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { and, desc, eq, gte, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from './src/db/index.ts';
import {
  advances,
  attendance,
  auditLogs,
  coverageRecords,
  driverAssignments,
  drivers,
  employees,
  financialTransactions,
  gpsLocations,
  monthlyClosings,
  notifications,
  routes,
  salaries,
  schools,
  supervisors,
  supervisorTrips,
  userRoles,
  users,
  type DriverLicensePhoto,
  vehicleOwners,
  vehicles,
  voiceCommandLogs,
} from './src/db/schema.ts';
import {
  type AuthRequest,
  ensureRolesExist,
  ensureSeedOwnerUserId,
  hasPermission,
  requireAdminOrStaff,
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from './src/middleware/auth.ts';
import {
  issueDriverSessionToken,
  issueSupervisorSessionToken,
  normalizeArabicDigits,
  normalizeArabicName,
  normalizeDriverCode,
  normalizeEgyptPhone,
} from './src/lib/driver-session.ts';
import { ensureRlsPoliciesApplied } from './src/db/apply-rls-policies.ts';
import { runWithRlsContext } from './src/db/rls-context.ts';
import {
  closeMonthAndStartNext,
  deleteAdjustmentTransaction,
  deleteAdvanceTransaction,
  deleteCoverageTransaction,
  getActiveBillingPeriod,
  getMonthlyClosingsHistory,
  getOrRecalculateDriverSalaryForRead,
  recalculateDriverSalary,
  recordAdjustmentTransaction,
  recordAdvanceTransaction,
  recordCoverageTransaction,
  resetMonthFinancials,
  reverseFinancialRecord,
  updateAdjustmentTransaction,
  updateAdvanceTransaction,
  updateCoverageTransaction,
} from './src/services/finance.ts';
import {
  interpretEgyptianCommand,
  synthesizeArabicSpeech,
  transcribeEgyptianAudio,
} from './src/services/gemini-voice.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GPS_STALE_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes threshold for live vs cached

function isGpsFresh(recordedAt: Date | string | null | undefined, isLiveFlag: boolean): boolean {
  if (!recordedAt || !isLiveFlag) return false;
  const t = new Date(recordedAt).getTime();
  return Date.now() - t <= GPS_STALE_THRESHOLD_MS;
}

function getTodayDateString(): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Cairo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function isValidGpsCoordinate(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  if (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) return false;
  return true;
}

function sanitizeDriverPhotoUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length > 650_000) {
    throw new Error('حجم الصورة كبير جداً، يرجى اختيار صورة أصغر');
  }
  if (
    trimmed.startsWith('data:image/') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('http://')
  ) {
    return trimmed;
  }
  throw new Error('صيغة رابط أو ملف الصورة غير صالحة');
}

function sanitizeLicensePhotos(
  raw: unknown,
  defaultUploadedBy: 'admin' | 'driver'
): DriverLicensePhoto[] {
  if (!Array.isArray(raw)) {
    throw new Error('صيغة قائمة صور الرخص غير صالحة');
  }
  if (raw.length > 10) {
    throw new Error('الحد الأقصى لعدد صور الرخص المحفوظة هو 10 صور');
  }

  return raw.map((item, idx) => {
    if (!item || typeof item !== 'object') {
      throw new Error('بيانات إحدى صور الرخص غير صالحة');
    }
    const obj = item as Record<string, unknown>;
    const imageUrl = typeof obj.imageUrl === 'string' ? obj.imageUrl.trim() : '';
    if (!imageUrl || imageUrl.length > 900_000) {
      throw new Error('حجم إحدى صور الرخص كبير جداً أو غير صالح');
    }
    if (
      !imageUrl.startsWith('data:image/') &&
      !imageUrl.startsWith('https://') &&
      !imageUrl.startsWith('http://')
    ) {
      throw new Error('صيغة صورة الرخصة غير مدعومة');
    }

    const idRaw = typeof obj.id === 'string' ? obj.id.trim() : '';
    const labelRaw = typeof obj.label === 'string' ? obj.label.trim() : '';
    const uploadedBy =
      obj.uploadedBy === 'driver' || obj.uploadedBy === 'admin'
        ? obj.uploadedBy
        : defaultUploadedBy;
    const uploadedAt =
      typeof obj.uploadedAt === 'string' && obj.uploadedAt.trim()
        ? obj.uploadedAt.trim()
        : new Date().toISOString();

    return {
      id: idRaw || `lic_${Date.now()}_${idx}`,
      label: labelRaw.slice(0, 80) || 'صورة رخصة',
      imageUrl,
      uploadedBy,
      uploadedAt,
    };
  });
}

async function getEnrichedDrivers() {
  const [allDrivers, currentAssignments, allSchools, allVehicles, allOwners, allRoutes] =
    await Promise.all([
      db.select().from(drivers).orderBy(drivers.driverCode),
      db.select().from(driverAssignments).where(eq(driverAssignments.isCurrent, true)),
      db.select().from(schools),
      db.select().from(vehicles),
      db.select().from(vehicleOwners),
      db.select().from(routes),
    ]);

  const schoolById: Record<number, typeof schools.$inferSelect> = {};
  for (const s of allSchools) schoolById[s.id] = s;

  const vehicleById: Record<number, typeof vehicles.$inferSelect> = {};
  for (const v of allVehicles) vehicleById[v.id] = v;

  const ownerById: Record<number, typeof vehicleOwners.$inferSelect> = {};
  for (const o of allOwners) ownerById[o.id] = o;

  const routeById: Record<number, typeof routes.$inferSelect> = {};
  for (const r of allRoutes) routeById[r.id] = r;

  const assignByDriver: Record<number, typeof driverAssignments.$inferSelect> = {};
  for (const a of currentAssignments) assignByDriver[a.driverId] = a;

  return allDrivers.map((d) => {
    const assign = assignByDriver[d.id];
    const school = assign?.schoolId ? schoolById[assign.schoolId] : undefined;
    const vehicle = assign?.vehicleId ? vehicleById[assign.vehicleId] : undefined;
    const owner = vehicle?.ownerId ? ownerById[vehicle.ownerId] : undefined;
    const route = assign?.routeId ? routeById[assign.routeId] : undefined;

    return {
      ...d,
      monthlyAgreedSalary: Number(d.monthlyAgreedSalary || 0),
      licensePhotos: Array.isArray(d.licensePhotosJson) ? d.licensePhotosJson : [],
      assignment: assign || null,
      schoolId: school?.id || null,
      schoolName: school?.name || 'غير معين',
      vehicleId: vehicle?.id || null,
      busNumber: vehicle?.busNumber || '—',
      registrationNumber: vehicle?.registrationNumber || '—',
      vehicleOwnerName: owner?.fullName || '—',
      vehicleOwnerPhone: owner?.phone || '—',
      routeId: route?.id || null,
      routeName: route?.name || '—',
      pickupArea: route?.pickupArea || '',
      dropoffArea: route?.dropoffArea || '',
      pickupTime: route?.pickupTime || '',
      dropoffTime: route?.dropoffTime || '',
    };
  });
}

async function getFleetWithLatestGps() {
  const [
    allVehicles,
    allOwners,
    allSchools,
    allRoutes,
    allDrivers,
    currentAssignments,
    latestGpsRows,
  ] = await Promise.all([
    db.select().from(vehicles).orderBy(vehicles.busNumber),
    db.select().from(vehicleOwners),
    db.select().from(schools),
    db.select().from(routes),
    db.select().from(drivers),
    db.select().from(driverAssignments).where(eq(driverAssignments.isCurrent, true)),
    db.select().from(gpsLocations).orderBy(desc(gpsLocations.recordedAt)).limit(500),
  ]);

  const latestByVehicle: Record<number, typeof gpsLocations.$inferSelect> = {};
  for (const g of latestGpsRows) {
    if (g.vehicleId && !latestByVehicle[g.vehicleId]) {
      latestByVehicle[g.vehicleId] = g;
    }
  }

  const ownerById: Record<number, typeof vehicleOwners.$inferSelect> = {};
  for (const o of allOwners) ownerById[o.id] = o;

  const schoolById: Record<number, typeof schools.$inferSelect> = {};
  for (const s of allSchools) schoolById[s.id] = s;

  const routeById: Record<number, typeof routes.$inferSelect> = {};
  for (const r of allRoutes) routeById[r.id] = r;

  const driverById: Record<number, typeof drivers.$inferSelect> = {};
  for (const d of allDrivers) driverById[d.id] = d;

  const assignByVehicle: Record<number, typeof driverAssignments.$inferSelect> = {};
  for (const a of currentAssignments) {
    if (a.vehicleId) assignByVehicle[a.vehicleId] = a;
  }

  return allVehicles.map((v) => {
    const assign = assignByVehicle[v.id];
    const rawDriver = assign ? driverById[assign.driverId] : undefined;
    const driver = rawDriver && rawDriver.accountStatus === 'active' ? rawDriver : undefined;
    const school = assign?.schoolId ? schoolById[assign.schoolId] : undefined;
    const route = assign?.routeId ? routeById[assign.routeId] : undefined;
    const owner = v.ownerId ? ownerById[v.ownerId] : undefined;
    const gps = latestByVehicle[v.id] || null;
    const fresh = gps ? isGpsFresh(gps.recordedAt, gps.isLive) : false;

    return {
      ...v,
      monthlyOwnerCost: Number(v.monthlyOwnerCost || 0),
      ownerName: owner?.fullName || '—',
      ownerPhone: owner?.phone || '—',
      driverId: driver?.id || null,
      driverName: driver?.fullName || 'غير معين',
      driverCode: driver?.driverCode || '—',
      driverPhone: driver?.phone || '',
      schoolId: school?.id || null,
      schoolName: school?.name || 'غير معين',
      routeId: route?.id || null,
      routeName: route?.name || '—',
      gps: gps
        ? {
            lat: gps.lat,
            lng: gps.lng,
            speedKmh: fresh ? Math.round(gps.speedKmh) : 0,
            accuracyMeters: gps.accuracyMeters,
            recordedAt: gps.recordedAt,
            isLive: fresh,
            statusLabel:
              v.gpsStatus === 'paused'
                ? 'متوقف مؤقتاً'
                : fresh
                ? 'متصل مباشر'
                : 'آخر موقع مسجل (غير متصل)',
          }
        : null,
      isOnline: v.gpsStatus !== 'paused' && fresh,
    };
  });
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  // Healthcheck
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'al-waleed-travel' });
  });

  // 0. Driver & Supervisor Code Login (Public endpoints with isolated rate limiting & pruning)
  const codeLoginAttempts: Record<string, { count: number; resetAt: number }> = {};

  function pruneExpiredLoginAttempts(nowMs: number) {
    for (const key of Object.keys(codeLoginAttempts)) {
      if (codeLoginAttempts[key].resetAt <= nowMs) {
        delete codeLoginAttempts[key];
      }
    }
  }

  app.post('/api/auth/driver-login', async (req, res) => {
    const clientIp = req.ip || 'unknown';
    const rateKey = `drv:${clientIp}`;
    const nowMs = Date.now();
    const attempt = codeLoginAttempts[rateKey];
    if (attempt && attempt.resetAt > nowMs && attempt.count >= 15) {
      return res.status(429).json({
        error: 'تم تجاوز الحد المسموح لمحاولات الدخول. يرجى المحاولة بعد 10 دقائق.',
      });
    }

    const recordFailedAttempt = () => {
      pruneExpiredLoginAttempts(nowMs);
      const cur = codeLoginAttempts[rateKey];
      if (!cur || cur.resetAt <= nowMs) {
        codeLoginAttempts[rateKey] = { count: 1, resetAt: nowMs + 10 * 60 * 1000 };
      } else {
        cur.count += 1;
      }
    };

    try {
      const rawIdentifier = String(
        req.body?.identifier ?? req.body?.phone ?? req.body?.name ?? ''
      ).trim();
      const normCode = normalizeDriverCode(req.body?.driverCode);
      const normPhone = normalizeEgyptPhone(rawIdentifier);
      const rawPhoneDigits = normalizeArabicDigits(rawIdentifier).replace(/\D/g, '');
      const normInputName = normalizeArabicName(rawIdentifier);

      if (!normCode || !rawIdentifier) {
        return res.status(400).json({ error: 'يرجى إدخال رقم الموبايل أو الاسم وكود السائق' });
      }

      const result = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        await ensureRolesExist();
        await ensureSeedOwnerUserId();

        let [driver] = await db
          .select()
          .from(drivers)
          .where(eq(drivers.driverCode, normCode))
          .limit(1);

        if (!driver) {
          const allDrivers = await db.select().from(drivers);
          driver = allDrivers.find(
            (d) => normalizeDriverCode(d.driverCode).toLowerCase() === normCode.toLowerCase()
          )!;
        }

        if (!driver) {
          return { status: 401 as const, error: 'الاسم / رقم الموبايل أو كود السائق غير صحيح' };
        }

        const storedPhoneNorm = normalizeEgyptPhone(driver.phone);
        const storedPhoneDigits = normalizeArabicDigits(driver.phone).replace(/\D/g, '');
        const phoneMatches =
          (Boolean(normPhone) && storedPhoneNorm === normPhone) ||
          (rawPhoneDigits.length >= 8 &&
            (storedPhoneDigits === rawPhoneDigits ||
              storedPhoneDigits.endsWith(rawPhoneDigits) ||
              rawPhoneDigits.endsWith(storedPhoneDigits)));

        const normStoredName = normalizeArabicName(driver.fullName);
        const nameMatches =
          normInputName.length >= 2 &&
          (normStoredName === normInputName || normStoredName.includes(normInputName));

        if (!phoneMatches && !nameMatches) {
          return { status: 401 as const, error: 'الاسم / رقم الموبايل أو كود السائق غير صحيح' };
        }

        if (driver.accountStatus !== 'active') {
          return {
            status: 403 as const,
            error: 'تم إيقاف حساب السائق من قبل الإدارة. يرجى التواصل مع المشرف.',
          };
        }

        const [driverRole] = await db
          .select()
          .from(userRoles)
          .where(eq(userRoles.slug, 'driver'))
          .limit(1);

        if (!driverRole) {
          return { status: 500 as const, error: 'تعذر تهيئة صلاحية السائق' };
        }

        let userRow: typeof users.$inferSelect | undefined;
        if (driver.userId) {
          const [found] = await db.select().from(users).where(eq(users.id, driver.userId)).limit(1);
          userRow = found;
        }
        if (!userRow && driver.linkedEmail?.trim()) {
          const [found] = await db
            .select()
            .from(users)
            .where(eq(users.email, driver.linkedEmail.trim().toLowerCase()))
            .limit(1);
          userRow = found;
        }
        if (!userRow) {
          const fallbackUid = `driver_${driver.id}`;
          const [found] = await db
            .select()
            .from(users)
            .where(eq(users.uid, fallbackUid))
            .limit(1);
          userRow = found;
        }

        if (!userRow) {
          const fallbackUid = `driver_${driver.id}`;
          let candidateEmail = `driver.${driver.id}@driver.alwaleed.local`;
          if (driver.linkedEmail?.trim()) {
            const cleanEmail = driver.linkedEmail.trim().toLowerCase();
            const [emailTaken] = await db
              .select({ id: users.id })
              .from(users)
              .where(eq(users.email, cleanEmail))
              .limit(1);
            if (!emailTaken) {
              candidateEmail = cleanEmail;
            }
          }

          const [createdUser] = await db
            .insert(users)
            .values({
              uid: fallbackUid,
              email: candidateEmail,
              fullName: driver.fullName,
              phone: storedPhoneNorm || normPhone,
              roleId: driverRole.id,
              isActive: true,
            })
            .onConflictDoUpdate({
              target: users.uid,
              set: {
                fullName: driver.fullName,
                phone: storedPhoneNorm || normPhone,
                updatedAt: new Date(),
              },
            })
            .returning();
          userRow = createdUser;
        }

        if (!userRow.isActive) {
          return { status: 403 as const, error: 'تم إيقاف هذا الحساب من قبل الإدارة' };
        }

        if (driver.userId !== userRow.id) {
          await db.update(drivers).set({ userId: userRow.id }).where(eq(drivers.id, driver.id));
        }

        const token = issueDriverSessionToken({
          userId: userRow.id,
          driverId: driver.id,
          driverCode: driver.driverCode,
        });

        await db.insert(auditLogs).values({
          actorUserId: userRow.id,
          action: 'DRIVER_PHONE_CODE_LOGIN',
          entityType: 'drivers',
          entityId: String(driver.id),
          afterJson: { driverCode: driver.driverCode },
          ipAddress: clientIp,
        });

        const permissions = Array.isArray(driverRole.permissions) ? driverRole.permissions : [];

        return {
          status: 200 as const,
          payload: {
            token,
            user: {
              id: userRow.id,
              uid: userRow.uid,
              email: userRow.email,
              fullName: driver.fullName,
              phone: driver.phone,
              roleId: userRow.roleId,
              roleSlug: driverRole.slug,
              roleNameAr: driverRole.nameAr,
              permissions,
              isActive: userRow.isActive,
            },
            driver: {
              id: driver.id,
              driverCode: driver.driverCode,
              fullName: driver.fullName,
            },
          },
        };
      });

      if (result.status !== 200) {
        if (result.status === 401) recordFailedAttempt();
        return res.status(result.status).json({ error: result.error });
      }

      delete codeLoginAttempts[rateKey];
      return res.json(result.payload);
    } catch (error) {
      console.error('Driver login error:', error);
      return res.status(500).json({ error: 'تعذر تسجيل دخول السائق، يرجى المحاولة لاحقاً' });
    }
  });

  // 0b. Supervisor Phone/Name + Code Login (نسخة المشرفة - دخول بالكود والموبايل أو الاسم)
  app.post('/api/auth/supervisor-login', async (req, res) => {
    const clientIp = req.ip || 'unknown';
    const rateKey = `sup:${clientIp}`;
    const nowMs = Date.now();
    const attempt = codeLoginAttempts[rateKey];
    if (attempt && attempt.resetAt > nowMs && attempt.count >= 15) {
      return res.status(429).json({
        error: 'تم تجاوز الحد المسموح لمحاولات الدخول. يرجى المحاولة بعد 10 دقائق.',
      });
    }

    const recordFailedAttempt = () => {
      pruneExpiredLoginAttempts(nowMs);
      const cur = codeLoginAttempts[rateKey];
      if (!cur || cur.resetAt <= nowMs) {
        codeLoginAttempts[rateKey] = { count: 1, resetAt: nowMs + 10 * 60 * 1000 };
      } else {
        cur.count += 1;
      }
    };

    try {
      const rawIdentifier = String(
        req.body?.identifier ?? req.body?.phone ?? req.body?.name ?? ''
      ).trim();
      const normCode = normalizeDriverCode(req.body?.supervisorCode ?? req.body?.code);
      const normPhone = normalizeEgyptPhone(rawIdentifier);
      const rawPhoneDigits = normalizeArabicDigits(rawIdentifier).replace(/\D/g, '');
      const normInputName = normalizeArabicName(rawIdentifier);

      if (!normCode || !rawIdentifier) {
        return res.status(400).json({ error: 'يرجى إدخال رقم الموبايل أو الاسم وكود المشرفة' });
      }

      const result = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        await ensureRolesExist();
        await ensureSeedOwnerUserId();

        let [sup] = await db
          .select()
          .from(supervisors)
          .where(eq(supervisors.supervisorCode, normCode))
          .limit(1);

        if (!sup) {
          const allSups = await db.select().from(supervisors);
          sup = allSups.find(
            (s) => normalizeDriverCode(s.supervisorCode).toLowerCase() === normCode.toLowerCase()
          )!;
        }

        if (!sup) {
          return { status: 401 as const, error: 'الاسم / رقم الموبايل أو كود المشرفة غير صحيح' };
        }

        const storedPhoneNorm = normalizeEgyptPhone(sup.phone);
        const storedPhoneDigits = normalizeArabicDigits(sup.phone).replace(/\D/g, '');
        const phoneMatches =
          (Boolean(normPhone) && storedPhoneNorm === normPhone) ||
          (rawPhoneDigits.length >= 8 &&
            (storedPhoneDigits === rawPhoneDigits ||
              storedPhoneDigits.endsWith(rawPhoneDigits) ||
              rawPhoneDigits.endsWith(storedPhoneDigits)));

        const normStoredName = normalizeArabicName(sup.fullName);
        const nameMatches =
          normInputName.length >= 2 &&
          (normStoredName === normInputName || normStoredName.includes(normInputName));

        if (!phoneMatches && !nameMatches) {
          return { status: 401 as const, error: 'الاسم / رقم الموبايل أو كود المشرفة غير صحيح' };
        }

        if (sup.accountStatus !== 'active') {
          return {
            status: 403 as const,
            error: 'تم إيقاف حساب المشرفة من قبل الإدارة. يرجى التواصل مع المسؤول.',
          };
        }

        const [supRole] = await db
          .select()
          .from(userRoles)
          .where(eq(userRoles.slug, 'supervisor'))
          .limit(1);

        if (!supRole) {
          return { status: 500 as const, error: 'تعذر تهيئة صلاحية المشرفة' };
        }

        let userRow: typeof users.$inferSelect | undefined;
        if (sup.userId) {
          const [found] = await db.select().from(users).where(eq(users.id, sup.userId)).limit(1);
          userRow = found;
        }
        if (!userRow && sup.linkedEmail?.trim()) {
          const [found] = await db
            .select()
            .from(users)
            .where(eq(users.email, sup.linkedEmail.trim().toLowerCase()))
            .limit(1);
          userRow = found;
        }
        if (!userRow) {
          const fallbackUid = `supervisor_${sup.id}`;
          const [found] = await db
            .select()
            .from(users)
            .where(eq(users.uid, fallbackUid))
            .limit(1);
          userRow = found;
        }

        if (!userRow) {
          const fallbackUid = `supervisor_${sup.id}`;
          let candidateEmail = `supervisor.${sup.id}@supervisor.alwaleed.local`;
          if (sup.linkedEmail?.trim()) {
            const cleanEmail = sup.linkedEmail.trim().toLowerCase();
            const [emailTaken] = await db
              .select({ id: users.id })
              .from(users)
              .where(eq(users.email, cleanEmail))
              .limit(1);
            if (!emailTaken) {
              candidateEmail = cleanEmail;
            }
          }

          const [createdUser] = await db
            .insert(users)
            .values({
              uid: fallbackUid,
              email: candidateEmail,
              fullName: sup.fullName,
              phone: storedPhoneNorm || normPhone,
              roleId: supRole.id,
              isActive: true,
            })
            .onConflictDoUpdate({
              target: users.uid,
              set: {
                fullName: sup.fullName,
                phone: storedPhoneNorm || normPhone,
                updatedAt: new Date(),
              },
            })
            .returning();
          userRow = createdUser;
        }

        if (!userRow.isActive) {
          return { status: 403 as const, error: 'تم إيقاف هذا الحساب من قبل الإدارة' };
        }

        if (sup.userId !== userRow.id) {
          await db.update(supervisors).set({ userId: userRow.id }).where(eq(supervisors.id, sup.id));
        }

        const token = issueSupervisorSessionToken({
          userId: userRow.id,
          supervisorId: sup.id,
          supervisorCode: sup.supervisorCode,
        });

        await db.insert(auditLogs).values({
          actorUserId: userRow.id,
          action: 'SUPERVISOR_CODE_LOGIN',
          entityType: 'supervisors',
          entityId: String(sup.id),
          afterJson: { supervisorCode: sup.supervisorCode },
          ipAddress: clientIp,
        });

        const permissions = Array.isArray(supRole.permissions) ? supRole.permissions : [];

        return {
          status: 200 as const,
          payload: {
            token,
            user: {
              id: userRow.id,
              uid: userRow.uid,
              email: userRow.email,
              fullName: sup.fullName,
              phone: sup.phone,
              roleId: userRow.roleId,
              roleSlug: 'supervisor',
              roleNameAr: supRole.nameAr,
              permissions,
              isActive: userRow.isActive,
            },
            supervisor: {
              id: sup.id,
              supervisorCode: sup.supervisorCode,
              fullName: sup.fullName,
              phone: sup.phone,
            },
          },
        };
      });

      if (result.status !== 200) {
        if (result.status === 401) recordFailedAttempt();
        return res.status(result.status).json({ error: result.error });
      }

      delete codeLoginAttempts[rateKey];
      return res.json(result.payload);
    } catch (error) {
      console.error('Supervisor login error:', error);
      return res.status(500).json({ error: 'تعذر تسجيل دخول المشرفة، يرجى المحاولة لاحقاً' });
    }
  });

  // 1. Current Authenticated User & Bootstrap
  app.get('/api/me', requireAuth, async (req: AuthRequest, res) => {
    try {
      res.json({
        user: req.dbUser,
        driver: req.driverRecord
          ? {
              id: req.driverRecord.id,
              driverCode: req.driverRecord.driverCode,
              fullName: req.driverRecord.fullName,
            }
          : null,
        supervisor: req.supervisorRecord
          ? {
              id: req.supervisorRecord.id,
              supervisorCode: req.supervisorRecord.supervisorCode,
              fullName: req.supervisorRecord.fullName,
              phone: req.supervisorRecord.phone,
            }
          : null,
        refreshedSessionToken: req.refreshedSessionToken || null,
      });
    } catch (error) {
      console.error('Error in /api/me:', error);
      res.status(500).json({ error: 'تعذر تحميل بيانات الحساب' });
    }
  });

  // 2. Dashboard Summary (Admin/Staff only)
  app.get('/api/dashboard', requireAuth, requireAdminOrStaff, requirePermission('dashboard:read'), async (req: AuthRequest, res) => {
    try {
      const activePeriod = await getActiveBillingPeriod();
      const month = Number(req.query.month) || activePeriod.month;
      const year = Number(req.query.year) || activePeriod.year;
      const dateStr = (req.query.date as string) || getTodayDateString();
      const schoolFilter = req.query.schoolId ? Number(req.query.schoolId) : null;
      const driverFilter = req.query.driverId ? Number(req.query.driverId) : null;
      const vehicleFilter = req.query.vehicleId ? Number(req.query.vehicleId) : null;
      const statusFilter = (req.query.status as string) || '';
      const schoolQuery = String(req.query.schoolQuery || '').trim().toLowerCase();
      const driverQuery = String(req.query.driverQuery || '').trim().toLowerCase();
      const vehicleQuery = String(req.query.vehicleQuery || '').trim().toLowerCase();
      const statusQuery = String(req.query.statusQuery || '').trim().toLowerCase();

      const [allEnrichedDrivers, rawFleet, allSchools, todayAttendance, allSalaries, rawEmployees] =
        await Promise.all([
          getEnrichedDrivers(),
          getFleetWithLatestGps(),
          db.select().from(schools),
          db.select().from(attendance).where(eq(attendance.date, dateStr)),
          db.select().from(salaries).where(and(eq(salaries.month, month), eq(salaries.year, year))),
          db.select().from(employees).orderBy(employees.fullName),
        ]);

      let enrichedDrivers = allEnrichedDrivers.filter((d) => d.accountStatus === 'active');
      let fleet = rawFleet.filter((v) => v.operationalStatus !== 'inactive');

      const attByDriver: Record<number, typeof attendance.$inferSelect> = {};
      for (const a of todayAttendance) attByDriver[a.driverId] = a;

      if (schoolFilter) {
        enrichedDrivers = enrichedDrivers.filter((d) => d.schoolId === schoolFilter);
        fleet = fleet.filter((v) => v.schoolId === schoolFilter);
      }
      if (schoolQuery) {
        enrichedDrivers = enrichedDrivers.filter((d) =>
          (d.schoolName || '').toLowerCase().includes(schoolQuery)
        );
        fleet = fleet.filter((v) => (v.schoolName || '').toLowerCase().includes(schoolQuery));
      }
      if (driverFilter) {
        enrichedDrivers = enrichedDrivers.filter((d) => d.id === driverFilter);
        fleet = fleet.filter((v) => v.driverId === driverFilter);
      }
      if (driverQuery) {
        enrichedDrivers = enrichedDrivers.filter(
          (d) =>
            d.fullName.toLowerCase().includes(driverQuery) ||
            d.driverCode.toLowerCase().includes(driverQuery) ||
            d.phone.toLowerCase().includes(driverQuery)
        );
        fleet = fleet.filter(
          (v) =>
            (v.driverName || '').toLowerCase().includes(driverQuery) ||
            (v.driverCode || '').toLowerCase().includes(driverQuery)
        );
      }
      if (vehicleFilter) {
        enrichedDrivers = enrichedDrivers.filter((d) => d.vehicleId === vehicleFilter);
        fleet = fleet.filter((v) => v.id === vehicleFilter);
      }
      if (vehicleQuery) {
        enrichedDrivers = enrichedDrivers.filter(
          (d) =>
            (d.busNumber || '').toLowerCase().includes(vehicleQuery) ||
            (d.registrationNumber || '').toLowerCase().includes(vehicleQuery)
        );
        fleet = fleet.filter(
          (v) =>
            v.busNumber.toLowerCase().includes(vehicleQuery) ||
            v.registrationNumber.toLowerCase().includes(vehicleQuery)
        );
      }
      if (statusFilter) {
        if (statusFilter === 'absent') {
          enrichedDrivers = enrichedDrivers.filter((d) => {
            const st = attByDriver[d.id]?.status;
            return st === 'absent' || st === 'covered';
          });
        } else if (statusFilter === 'active' || statusFilter === 'inactive') {
          enrichedDrivers = enrichedDrivers.filter((d) => d.accountStatus === statusFilter);
        }
      }
      if (statusQuery) {
        enrichedDrivers = enrichedDrivers.filter((d) => {
          const st = attByDriver[d.id]?.status || 'present';
          const statusAr =
            d.accountStatus === 'inactive'
              ? 'مؤرشف'
              : st === 'absent'
              ? 'غائب'
              : st === 'covered'
              ? 'مغطى غائب'
              : 'نشط حاضر';
          return (
            statusAr.includes(statusQuery) ||
            d.accountStatus.toLowerCase().includes(statusQuery) ||
            st.toLowerCase().includes(statusQuery)
          );
        });
      }

      const driverIds = new Set(enrichedDrivers.map((d) => d.id));
      const filteredSalaries = allSalaries.filter((s) => driverIds.has(s.driverId));
      const salaryByDriver: Record<number, typeof salaries.$inferSelect> = {};
      for (const s of filteredSalaries) salaryByDriver[s.driverId] = s;

      let totalMonthlySalaries = 0;
      let totalAdvances = 0;
      let totalCoverageDeductions = 0;
      let totalOutstandingPayments = 0;

      for (const d of enrichedDrivers) {
        const s = salaryByDriver[d.id];
        const base = s ? Number(s.baseSalary) : d.monthlyAgreedSalary;
        const adv = s ? Number(s.totalAdvances) : 0;
        const cov = s ? Number(s.totalCoverageDeductions) : 0;
        const net = s ? Number(s.netSalary) : base;
        totalMonthlySalaries += base;
        totalAdvances += adv;
        totalCoverageDeductions += cov;
        if (!s || s.status !== 'paid') {
          totalOutstandingPayments += Math.max(0, net);
        }
      }

      const activeEmployees = rawEmployees.filter((e) => e.status === 'active');

      // School contract revenue vs total payroll (drivers + non-driver employees)
      const relevantSchools = schoolFilter
        ? allSchools.filter((s) => s.id === schoolFilter && s.isActive)
        : schoolQuery
        ? allSchools.filter((s) => s.isActive && s.name.toLowerCase().includes(schoolQuery))
        : allSchools.filter((s) => s.isActive);
      const totalSchoolContracts = relevantSchools.reduce(
        (sum, s) => sum + Number(s.monthlyContractValue || 0),
        0
      );
      const totalOwnerCosts = fleet
        .filter((v) => v.operationalStatus !== 'inactive')
        .reduce((sum, v) => sum + Number(v.monthlyOwnerCost || 0), 0);

      const totalDriverSalaries = totalMonthlySalaries;
      const totalEmployeeSalaries = activeEmployees.reduce((sum, e) => {
        const net = Math.max(
          0,
          Number(e.monthlySalary || 0) + Number(e.bonuses || 0) - Number(e.deductions || 0)
        );
        return sum + net;
      }, 0);
      const combinedMonthlySalaries = totalDriverSalaries + totalEmployeeSalaries;
      const monthlyBusinessProfit = totalSchoolContracts - combinedMonthlySalaries;

      const activeVehicles = fleet.filter((v) => v.operationalStatus === 'active');
      const onlineVehicles = activeVehicles.filter((v) => v.isOnline);
      const offlineVehicles = activeVehicles.filter((v) => !v.isOnline);

      const activeDriversCount = enrichedDrivers.filter(
        (d) => d.accountStatus === 'active'
      ).length;
      const absentDriversCount = enrichedDrivers.filter((d) => {
        const st = attByDriver[d.id]?.status;
        return st === 'absent' || st === 'covered';
      }).length;

      const recentNotifications = await db
        .select()
        .from(notifications)
        .orderBy(desc(notifications.createdAt))
        .limit(8);

      const [closingRow] = await db
        .select()
        .from(monthlyClosings)
        .where(and(eq(monthlyClosings.month, month), eq(monthlyClosings.year, year)))
        .limit(1);

      const snapshotEmpById: Record<
        number,
        { monthlySalary: number; bonuses: number; deductions: number; netSalary: number }
      > = {};
      if (closingRow?.snapshotJson?.employees) {
        for (const se of closingRow.snapshotJson.employees) {
          snapshotEmpById[se.employeeId] = se;
        }
      }

      const effectiveSchoolContracts = closingRow
        ? Number(closingRow.totalSchoolContracts)
        : totalSchoolContracts;
      const effectiveEmployeeSalaries = closingRow
        ? Number(closingRow.totalEmployeeSalaries)
        : totalEmployeeSalaries;
      const effectiveCombinedSalaries = totalDriverSalaries + effectiveEmployeeSalaries;
      const effectiveProfit = closingRow
        ? Number(closingRow.netProfit)
        : effectiveSchoolContracts - effectiveCombinedSalaries;

      res.json({
        period: { month, year, date: dateStr },
        activePeriod,
        isMonthClosed: Boolean(closingRow),
        kpis: {
          totalRegisteredDrivers: enrichedDrivers.length,
          totalEmployeesCount: closingRow ? closingRow.employeesCount : activeEmployees.length,
          activeEmployeesCount: closingRow ? closingRow.employeesCount : activeEmployees.length,
          totalActiveVehicles: activeVehicles.length,
          vehiclesOnline: onlineVehicles.length,
          vehiclesOffline: offlineVehicles.length,
          driversActive: activeDriversCount,
          driversAbsent: absentDriversCount,
          totalDriverSalaries,
          totalEmployeeSalaries: effectiveEmployeeSalaries,
          totalMonthlySalaries: effectiveCombinedSalaries,
          totalAdvances,
          totalCoverageDeductions,
          totalOutstandingPayments,
          totalSchoolContracts: effectiveSchoolContracts,
          totalOwnerCosts,
          monthlyBusinessProfit: effectiveProfit,
        },
        drivers: enrichedDrivers.map((d) => {
          const s = salaryByDriver[d.id];
          return {
            ...d,
            todayAttendance: attByDriver[d.id]?.status || 'present',
            currentSalary: s
              ? {
                  ...s,
                  baseSalary: Number(s.baseSalary),
                  totalAdvances: Number(s.totalAdvances),
                  totalCoverageDeductions: Number(s.totalCoverageDeductions),
                  otherDeductions: Number(s.otherDeductions),
                  bonuses: Number(s.bonuses),
                  netSalary: Number(s.netSalary),
                }
              : {
                  id: 0,
                  driverId: d.id,
                  month,
                  year,
                  baseSalary: d.monthlyAgreedSalary,
                  totalAdvances: 0,
                  totalCoverageDeductions: 0,
                  otherDeductions: 0,
                  bonuses: 0,
                  netSalary: d.monthlyAgreedSalary,
                  status: 'open',
                },
          };
        }),
        employees: activeEmployees.map((e) => {
          const snap = snapshotEmpById[e.id];
          const mSal = snap ? snap.monthlySalary : Number(e.monthlySalary || 0);
          const bon = snap ? snap.bonuses : Number(e.bonuses || 0);
          const ded = snap ? snap.deductions : Number(e.deductions || 0);
          const net = snap ? snap.netSalary : mSal + bon - ded;
          return {
            ...e,
            monthlySalary: mSal,
            bonuses: bon,
            deductions: ded,
            netSalary: net,
          };
        }),
        fleet,
        schools: allSchools,
        recentNotifications,
      });
    } catch (error) {
      console.error('Dashboard error:', error);
      res.status(500).json({ error: 'تعذر تحميل بيانات لوحة التحكم' });
    }
  });

  // 3. Drivers Management (Active by default — archived drivers live in /api/archive)
  app.get('/api/drivers', requireAuth, requireAdminOrStaff, requirePermission('drivers:read'), async (req: AuthRequest, res) => {
    try {
      const includeArchived = req.query.includeArchived === 'true';
      const all = await getEnrichedDrivers();
      const list = includeArchived ? all : all.filter((d) => d.accountStatus === 'active');
      res.json({ drivers: list });
    } catch (error) {
      console.error('Get drivers error:', error);
      res.status(500).json({ error: 'تعذر تحميل قائمة السائقين' });
    }
  });

  const PLACEHOLDER_ASSIGNMENTS = new Set(['غير معين', 'غير معينة', 'غير محدد', '—', '-']);

  async function resolveSchoolIdForDriver(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    opts: { schoolId?: unknown; schoolName?: unknown }
  ): Promise<number | null> {
    if (opts.schoolName !== undefined) {
      const trimmed = String(opts.schoolName ?? '').trim();
      if (!trimmed || PLACEHOLDER_ASSIGNMENTS.has(trimmed)) return null;

      const [existingByName] = await tx
        .select()
        .from(schools)
        .where(eq(schools.name, trimmed))
        .limit(1);
      if (existingByName) return existingByName.id;

      const [created] = await tx
        .insert(schools)
        .values({
          name: trimmed,
          address: '',
          lat: 31.2156,
          lng: 29.9553,
          isActive: true,
        })
        .returning();
      return created.id;
    }

    return opts.schoolId ? Number(opts.schoolId) : null;
  }

  async function resolveVehicleIdForDriver(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    opts: { vehicleId?: unknown; busNumber?: unknown }
  ): Promise<number | null> {
    if (opts.busNumber !== undefined) {
      const trimmed = normalizeArabicDigits(String(opts.busNumber ?? '')).trim();
      if (!trimmed || PLACEHOLDER_ASSIGNMENTS.has(trimmed)) return null;

      const [existingVehicle] = await tx
        .select()
        .from(vehicles)
        .where(or(eq(vehicles.busNumber, trimmed), eq(vehicles.registrationNumber, trimmed)))
        .limit(1);
      if (existingVehicle) return existingVehicle.id;

      const [created] = await tx
        .insert(vehicles)
        .values({
          busNumber: trimmed,
          registrationNumber: trimmed,
          vehicleType: '',
          operationalStatus: 'active',
        })
        .returning();
      return created.id;
    }

    return opts.vehicleId ? Number(opts.vehicleId) : null;
  }

  async function resolveRouteIdForDriver(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    opts: {
      schoolId: number | null;
      routeId?: unknown;
      routeName?: unknown;
      pickupArea?: unknown;
      pickupTime?: unknown;
      dropoffTime?: unknown;
    }
  ): Promise<number | null> {
    if (opts.routeName !== undefined) {
      const trimmedName = String(opts.routeName || '').trim();
      if (!trimmedName) return null;

      if (opts.routeId) {
        const [byId] = await tx
          .select()
          .from(routes)
          .where(eq(routes.id, Number(opts.routeId)))
          .limit(1);
        if (byId && byId.name.trim() === trimmedName && (byId.schoolId ?? null) === opts.schoolId) {
          return byId.id;
        }
      }

      const [existingByName] = await tx
        .select()
        .from(routes)
        .where(
          opts.schoolId !== null
            ? and(eq(routes.schoolId, opts.schoolId), eq(routes.name, trimmedName))
            : and(isNull(routes.schoolId), eq(routes.name, trimmedName))
        )
        .limit(1);
      if (existingByName) {
        return existingByName.id;
      }

      let schoolRow: typeof schools.$inferSelect | undefined;
      if (opts.schoolId !== null) {
        const [foundSchool] = await tx
          .select()
          .from(schools)
          .where(eq(schools.id, opts.schoolId))
          .limit(1);
        schoolRow = foundSchool;
      }

      const [createdRoute] = await tx
        .insert(routes)
        .values({
          name: trimmedName,
          schoolId: opts.schoolId,
          pickupArea: opts.pickupArea ? String(opts.pickupArea).trim() : '',
          dropoffArea: schoolRow?.name || '',
          pickupTime: opts.pickupTime ? String(opts.pickupTime) : '',
          dropoffTime: opts.dropoffTime ? String(opts.dropoffTime) : '',
          estimatedDistanceKm: 0,
        })
        .returning();

      return createdRoute.id;
    }

    return opts.routeId ? Number(opts.routeId) : null;
  }

  async function resolveOwnerIdForVehicle(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    opts: { ownerId?: unknown; ownerName?: unknown }
  ): Promise<number | null> {
    if (opts.ownerName !== undefined) {
      const trimmed = String(opts.ownerName || '').trim();
      if (!trimmed) return null;

      const [existing] = await tx
        .select()
        .from(vehicleOwners)
        .where(eq(vehicleOwners.fullName, trimmed))
        .limit(1);
      if (existing) return existing.id;

      const [created] = await tx
        .insert(vehicleOwners)
        .values({
          fullName: trimmed,
          phone: '',
          nationalId: '',
          notes: '',
        })
        .returning();
      return created.id;
    }

    return opts.ownerId ? Number(opts.ownerId) : null;
  }

  async function resolveDriverByIdOrQuery(opts: {
    driverId?: unknown;
    driverQuery?: unknown;
  }): Promise<typeof drivers.$inferSelect | null> {
    if (opts.driverId) {
      const [byId] = await db
        .select()
        .from(drivers)
        .where(eq(drivers.id, Number(opts.driverId)))
        .limit(1);
      if (byId) return byId;
    }
    const q = String(opts.driverQuery || '').trim();
    if (!q) return null;
    const normCode = normalizeDriverCode(q);
    const allDrivers = await db.select().from(drivers);
    return (
      allDrivers.find(
        (d) =>
          d.driverCode.toLowerCase() === normCode.toLowerCase() ||
          d.driverCode.toLowerCase() === q.toLowerCase()
      ) ||
      allDrivers.find((d) => d.fullName.trim().toLowerCase() === q.toLowerCase()) ||
      allDrivers.find((d) => d.fullName.toLowerCase().includes(q.toLowerCase())) ||
      null
    );
  }

  app.post(
    '/api/drivers',
    requireAuth,
    requireAdminOrStaff,
    requirePermission('drivers:write'),
    async (req: AuthRequest, res) => {
      try {
        const {
          driverCode,
          fullName,
          phone,
          emergencyContact,
          linkedEmail,
          monthlyAgreedSalary,
          employmentStartDate,
          accountStatus,
          photoUrl,
          licensePhotos,
          notes,
          schoolId,
          schoolName,
          vehicleId,
          busNumber,
          routeId,
          routeName,
          routePickupArea,
          routePickupTime,
          routeDropoffTime,
        } = req.body;

        if (!driverCode || !fullName || !phone) {
          return res.status(400).json({ error: 'كود السائق والاسم الكامل ورقم الهاتف حقول إلزامية' });
        }

        let safePhotoUrl = '';
        let safeLicensePhotos: DriverLicensePhoto[] = [];
        try {
          safePhotoUrl = sanitizeDriverPhotoUrl(photoUrl);
          if (licensePhotos !== undefined) {
            safeLicensePhotos = sanitizeLicensePhotos(licensePhotos, 'admin');
          }
        } catch (photoErr: unknown) {
          return res.status(400).json({
            error: photoErr instanceof Error ? photoErr.message : 'صورة السائق غير صالحة',
          });
        }

        const normalizedCode = normalizeDriverCode(driverCode);
        const normalizedPhone = normalizeEgyptPhone(phone) || String(phone).trim();

        const existingCode = await db
          .select({ id: drivers.id })
          .from(drivers)
          .where(sql`LOWER(TRIM(${drivers.driverCode})) = LOWER(${normalizedCode})`)
          .limit(1);

        if (existingCode[0]) {
          return res.status(409).json({ error: `كود السائق ${normalizedCode} مسجل مسبقاً ولا يمكن تكراره` });
        }

        const created = await db.transaction(async (tx) => {
          const [newDriver] = await tx
            .insert(drivers)
            .values({
              driverCode: normalizedCode,
              fullName: String(fullName).trim(),
              phone: normalizedPhone,
              emergencyContact: emergencyContact || '',
              linkedEmail: linkedEmail ? String(linkedEmail).toLowerCase().trim() : '',
              monthlyAgreedSalary: Number(monthlyAgreedSalary || 0).toFixed(2),
              employmentStartDate: employmentStartDate || getTodayDateString(),
              accountStatus: accountStatus || 'active',
              photoUrl: safePhotoUrl,
              licensePhotosJson: safeLicensePhotos,
              notes: notes || '',
            })
            .returning();

          const resolvedSchoolId = await resolveSchoolIdForDriver(tx, { schoolId, schoolName });
          const resolvedVehicleId = await resolveVehicleIdForDriver(tx, { vehicleId, busNumber });
          const resolvedRouteId = await resolveRouteIdForDriver(tx, {
            schoolId: resolvedSchoolId,
            routeId,
            routeName,
            pickupArea: routePickupArea,
            pickupTime: routePickupTime,
            dropoffTime: routeDropoffTime,
          });

          if (resolvedSchoolId || resolvedVehicleId || resolvedRouteId) {
            await tx.insert(driverAssignments).values({
              driverId: newDriver.id,
              schoolId: resolvedSchoolId,
              vehicleId: resolvedVehicleId,
              routeId: resolvedRouteId,
              isCurrent: true,
            });
          }

          const now = new Date();
          await recalculateDriverSalary(tx, newDriver.id, now.getMonth() + 1, now.getFullYear());

          await tx.insert(auditLogs).values({
            actorUserId: req.dbUser!.id,
            action: 'CREATE_DRIVER',
            entityType: 'drivers',
            entityId: String(newDriver.id),
            afterJson: newDriver,
            ipAddress: req.ip || '',
          });

          return newDriver;
        });

        res.status(201).json({ driver: created });
      } catch (error: unknown) {
        console.error('Create driver error:', error);
        res.status(500).json({ error: 'تعذر إضافة السائق' });
      }
    }
  );

  app.patch('/api/drivers/:id', requireAuth, requireAdminOrStaff, requirePermission('drivers:write'), async (req: AuthRequest, res) => {
    try {
      const driverId = Number(req.params.id);
      const [existing] = await db.select().from(drivers).where(eq(drivers.id, driverId)).limit(1);
      if (!existing) return res.status(404).json({ error: 'السائق غير موجود' });

      const {
        driverCode,
        fullName,
        phone,
        emergencyContact,
        linkedEmail,
        monthlyAgreedSalary,
        employmentStartDate,
        accountStatus,
        photoUrl,
        licensePhotos,
        notes,
        schoolId,
        schoolName,
        vehicleId,
        busNumber,
        routeId,
        routeName,
        routePickupArea,
        routePickupTime,
        routeDropoffTime,
      } = req.body;

      let nextPhotoUrl = existing.photoUrl || '';
      let nextLicensePhotos: DriverLicensePhoto[] = Array.isArray(existing.licensePhotosJson)
        ? existing.licensePhotosJson
        : [];
      try {
        if (photoUrl !== undefined) {
          nextPhotoUrl = sanitizeDriverPhotoUrl(photoUrl);
        }
        if (licensePhotos !== undefined) {
          nextLicensePhotos = sanitizeLicensePhotos(licensePhotos, 'admin');
        }
      } catch (photoErr: unknown) {
        return res.status(400).json({
          error: photoErr instanceof Error ? photoErr.message : 'صورة السائق غير صالحة',
        });
      }

      const nextCode = driverCode ? normalizeDriverCode(driverCode) : existing.driverCode;
      const nextPhone = phone ? normalizeEgyptPhone(phone) || String(phone).trim() : existing.phone;

      if (driverCode && nextCode !== existing.driverCode) {
        const dup = await db
          .select()
          .from(drivers)
          .where(eq(drivers.driverCode, nextCode))
          .limit(1);
        if (dup[0]) {
          return res.status(409).json({ error: `كود السائق ${nextCode} مستخدم لسائق آخر` });
        }
      }

      const hasAssignmentUpdate =
        schoolId !== undefined ||
        schoolName !== undefined ||
        vehicleId !== undefined ||
        busNumber !== undefined ||
        routeId !== undefined ||
        routeName !== undefined;

      const updated = await db.transaction(async (tx) => {
        const [u] = await tx
          .update(drivers)
          .set({
            driverCode: nextCode,
            fullName: fullName ? String(fullName).trim() : existing.fullName,
            phone: nextPhone,
            emergencyContact: emergencyContact ?? existing.emergencyContact,
            linkedEmail:
              linkedEmail !== undefined
                ? String(linkedEmail).toLowerCase().trim()
                : existing.linkedEmail,
            monthlyAgreedSalary:
              monthlyAgreedSalary !== undefined
                ? Number(monthlyAgreedSalary).toFixed(2)
                : existing.monthlyAgreedSalary,
            employmentStartDate: employmentStartDate ?? existing.employmentStartDate,
            accountStatus: accountStatus ?? existing.accountStatus,
            photoUrl: nextPhotoUrl,
            licensePhotosJson: nextLicensePhotos,
            notes: notes ?? existing.notes,
          })
          .where(eq(drivers.id, driverId))
          .returning();

        if (hasAssignmentUpdate) {
          const resolvedSchoolId = await resolveSchoolIdForDriver(tx, { schoolId, schoolName });
          const resolvedVehicleId = await resolveVehicleIdForDriver(tx, { vehicleId, busNumber });
          const resolvedRouteId = await resolveRouteIdForDriver(tx, {
            schoolId: resolvedSchoolId,
            routeId,
            routeName,
            pickupArea: routePickupArea,
            pickupTime: routePickupTime,
            dropoffTime: routeDropoffTime,
          });
          await tx
            .update(driverAssignments)
            .set({ isCurrent: false, endedAt: new Date() })
            .where(and(eq(driverAssignments.driverId, driverId), eq(driverAssignments.isCurrent, true)));

          if (resolvedSchoolId || resolvedVehicleId || resolvedRouteId) {
            await tx.insert(driverAssignments).values({
              driverId,
              schoolId: resolvedSchoolId,
              vehicleId: resolvedVehicleId,
              routeId: resolvedRouteId,
              isCurrent: true,
            });
          }
        }

        if (accountStatus && accountStatus !== existing.accountStatus) {
          await tx.insert(notifications).values({
            recipientDriverId: driverId,
            recipientUserId: u.userId || null,
            type: 'account_status',
            title: accountStatus === 'active' ? 'تم تفعيل حسابك' : 'تم إيقاف حسابك مؤقتاً',
            body:
              accountStatus === 'active'
                ? 'تم تفعيل حسابك في الوليد ترافيل ويمكنك العمل بشكل طبيعي.'
                : 'تم تغيير حالة حسابك من قبل الإدارة. يرجى مراجعة المشرف.',
          });
        }

        const now = new Date();
        await recalculateDriverSalary(tx, driverId, now.getMonth() + 1, now.getFullYear());

        await tx.insert(auditLogs).values({
          actorUserId: req.dbUser!.id,
          action: 'UPDATE_DRIVER',
          entityType: 'drivers',
          entityId: String(driverId),
          beforeJson: existing,
          afterJson: u,
          ipAddress: req.ip || '',
        });

        return u;
      });

      res.json({ driver: updated });
    } catch (error) {
      console.error('Update driver error:', error);
      res.status(500).json({ error: 'تعذر تحديث بيانات السائق' });
    }
  });

  app.delete(
    '/api/drivers/:id',
    requireAuth,
    requireAdminOrStaff,
    requirePermission('drivers:write'),
    async (req: AuthRequest, res) => {
      try {
        const driverId = Number(req.params.id);
        const [existing] = await db
          .select()
          .from(drivers)
          .where(eq(drivers.id, driverId))
          .limit(1);
        if (!existing) {
          return res.status(404).json({ error: 'السائق غير موجود' });
        }

        const [ftRef, advRef, covRef] = await Promise.all([
          db
            .select({ id: financialTransactions.id })
            .from(financialTransactions)
            .where(eq(financialTransactions.driverId, driverId))
            .limit(1),
          db
            .select({ id: advances.id })
            .from(advances)
            .where(eq(advances.driverId, driverId))
            .limit(1),
          db
            .select({ id: coverageRecords.id })
            .from(coverageRecords)
            .where(
              or(
                eq(coverageRecords.absentDriverId, driverId),
                eq(coverageRecords.replacementDriverId, driverId)
              )
            )
            .limit(1),
        ]);

        if (ftRef[0] || advRef[0] || covRef[0]) {
          return res.status(409).json({
            error:
              'لا يمكن حذف هذا السائق نهائياً لوجود سلف أو تغطيات أو حركات مالية مسجلة في دفتر الحسابات غير القابل للحذف. يمكنك إيقاف حسابه أو تعديل اسمه وبياناته بدلاً من الحذف.',
          });
        }

        await db.transaction(async (tx) => {
          await tx
            .update(gpsLocations)
            .set({ driverId: null })
            .where(eq(gpsLocations.driverId, driverId));
          await tx.delete(driverAssignments).where(eq(driverAssignments.driverId, driverId));
          await tx.delete(attendance).where(eq(attendance.driverId, driverId));
          await tx.delete(salaries).where(eq(salaries.driverId, driverId));
          await tx
            .delete(notifications)
            .where(eq(notifications.recipientDriverId, driverId));
          await tx.delete(drivers).where(eq(drivers.id, driverId));

          await tx.insert(auditLogs).values({
            actorUserId: req.dbUser!.id,
            action: 'DELETE_DRIVER',
            entityType: 'drivers',
            entityId: String(driverId),
            beforeJson: existing,
            ipAddress: req.ip || '',
          });
        });

        res.json({ ok: true, deletedId: driverId });
      } catch (error) {
        console.error('Delete driver error:', error);
        res.status(500).json({ error: 'تعذر حذف السائق' });
      }
    }
  );

  app.get('/api/drivers/:id/statement', requireAuth, async (req: AuthRequest, res) => {
    try {
      const driverId = Number(req.params.id);
      // Security: a driver can ONLY read their own statement; staff must hold finance:read
      if (req.dbUser?.roleSlug === 'driver') {
        if (req.driverRecord?.id !== driverId) {
          return res.status(403).json({ error: 'غير مصرح لك بعرض كشف حساب سائق آخر' });
        }
      } else if (!hasPermission(req.dbUser, 'finance:read')) {
        return res.status(403).json({ error: 'ليس لديك صلاحية الاطلاع على الكشوف المالية' });
      }

      const activePeriod = await getActiveBillingPeriod();
      const month = Number(req.query.month) || activePeriod.month;
      const year = Number(req.query.year) || activePeriod.year;

      const allDrivers = await getEnrichedDrivers();
      const driver = allDrivers.find((d) => d.id === driverId);
      if (!driver) return res.status(404).json({ error: 'السائق غير موجود' });

      const salary = await getOrRecalculateDriverSalaryForRead(db, driverId, month, year);
      const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;

      const [driverAdvances, driverCoverages, transactions, todayAttRows] = await Promise.all([
        db
          .select()
          .from(advances)
          .where(and(eq(advances.driverId, driverId), sql`${advances.date} LIKE ${monthPrefix + '%'}`))
          .orderBy(desc(advances.date), desc(advances.id)),
        db
          .select()
          .from(coverageRecords)
          .where(
            and(
              eq(coverageRecords.absentDriverId, driverId),
              sql`${coverageRecords.date} LIKE ${monthPrefix + '%'}`
            )
          )
          .orderBy(desc(coverageRecords.date), desc(coverageRecords.id)),
        db
          .select()
          .from(financialTransactions)
          .where(
            and(
              eq(financialTransactions.driverId, driverId),
              eq(financialTransactions.month, month),
              eq(financialTransactions.year, year)
            )
          )
          .orderBy(desc(financialTransactions.createdAt)),
        db
          .select()
          .from(attendance)
          .where(and(eq(attendance.driverId, driverId), eq(attendance.date, getTodayDateString())))
          .limit(1),
      ]);
      const [todayAtt] = todayAttRows;

      const driverNameById: Record<number, string> = {};
      for (const d of allDrivers) driverNameById[d.id] = d.fullName;

      res.json({
        driver: {
          ...driver,
          todayAttendance: todayAtt?.status || 'present',
        },
        period: { month, year },
        salary: {
          ...salary,
          baseSalary: Number(salary.baseSalary),
          totalAdvances: Number(salary.totalAdvances),
          totalCoverageDeductions: Number(salary.totalCoverageDeductions),
          otherDeductions: Number(salary.otherDeductions),
          bonuses: Number(salary.bonuses),
          netSalary: Number(salary.netSalary),
        },
        advances: driverAdvances.map((a) => ({ ...a, amount: Number(a.amount) })),
        coverages: driverCoverages.map((c) => ({
          ...c,
          replacementDriverName: c.replacementDriverId
            ? driverNameById[c.replacementDriverId] || '—'
            : c.replacementExternalName || 'سائق خارجي',
          actualReplacementCost:
            req.dbUser?.roleSlug === 'driver' ? 0 : Number(c.actualReplacementCost),
          absentDriverDeduction: Number(c.absentDriverDeduction),
        })),
        transactions: transactions.map((t) => ({ ...t, amount: Number(t.amount) })),
      });
    } catch (error) {
      console.error('Statement error:', error);
      res.status(500).json({ error: 'تعذر تحميل كشف حساب السائق' });
    }
  });

  // 4. Schools, Vehicle Owners, Vehicles & Routes
  app.get('/api/schools', requireAuth, requireAdminOrStaff, requirePermission('schools:read'), async (_req: AuthRequest, res) => {
    try {
      const allSchools = await db.select().from(schools).orderBy(schools.name);
      const allRoutes = await db.select().from(routes).orderBy(routes.name);
      const enrichedDrivers = await getEnrichedDrivers();
      const fleet = await getFleetWithLatestGps();

      const data = allSchools.map((s) => {
        const schoolVehicles = fleet.filter((v) => v.schoolId === s.id);
        const schoolDrivers = enrichedDrivers.filter((d) => d.schoolId === s.id);
        const schoolRoutes = allRoutes.filter((r) => r.schoolId === s.id);
        const ownerCost = schoolVehicles.reduce((sum, v) => sum + v.monthlyOwnerCost, 0);
        return {
          ...s,
          monthlyContractValue: Number(s.monthlyContractValue || 0),
          vehicleCount: schoolVehicles.length,
          driverCount: schoolDrivers.length,
          ownerCost,
          estimatedProfit: Number(s.monthlyContractValue || 0) - ownerCost,
          routes: schoolRoutes,
          vehicles: schoolVehicles,
          drivers: schoolDrivers,
        };
      });

      res.json({ schools: data, routes: allRoutes });
    } catch (error) {
      console.error('Get schools error:', error);
      res.status(500).json({ error: 'تعذر تحميل المدارس' });
    }
  });

  app.post('/api/schools', requireAuth, requireAdminOrStaff, requirePermission('schools:write'), async (req: AuthRequest, res) => {
    try {
      const {
        name,
        contactName,
        contactPhone,
        address,
        lat,
        lng,
        monthlyContractValue,
        contractStartDate,
        contractEndDate,
        notes,
      } = req.body;
      const trimmedName = String(name || '').trim();
      if (!trimmedName) return res.status(400).json({ error: 'اسم المدرسة مطلوب' });

      const existingRows = await db
        .select()
        .from(schools)
        .where(sql`LOWER(TRIM(${schools.name})) = LOWER(${trimmedName})`)
        .limit(1);

      if (existingRows[0]) {
        const existing = existingRows[0];
        const isMinimalAutoStub =
          Number(existing.monthlyContractValue || 0) === 0 &&
          !existing.contactName &&
          !existing.contactPhone &&
          !existing.address;

        if (isMinimalAutoStub) {
          const [updated] = await db
            .update(schools)
            .set({
              contactName: contactName || existing.contactName || '',
              contactPhone: contactPhone || existing.contactPhone || '',
              address: address || existing.address || '',
              monthlyContractValue: Number(monthlyContractValue || 0).toFixed(2),
              contractStartDate: contractStartDate || existing.contractStartDate || '',
              contractEndDate: contractEndDate || existing.contractEndDate || '',
              notes: notes || existing.notes || '',
              isActive: true,
            })
            .where(eq(schools.id, existing.id))
            .returning();

          return res.status(200).json({ school: updated, updatedExisting: true });
        }

        return res.status(409).json({
          error: 'هذه المدرسة مسجلة بالفعل — يمكنك تعديل بياناتها وعقدها من بطاقة المدرسة في القائمة.',
        });
      }

      const [created] = await db
        .insert(schools)
        .values({
          name: trimmedName,
          contactName: contactName || '',
          contactPhone: contactPhone || '',
          address: address || '',
          lat: Number(lat || 31.2156),
          lng: Number(lng || 29.9553),
          monthlyContractValue: Number(monthlyContractValue || 0).toFixed(2),
          contractStartDate: contractStartDate || '',
          contractEndDate: contractEndDate || '',
          notes: notes || '',
        })
        .returning();

      await db.insert(auditLogs).values({
        actorUserId: req.dbUser!.id,
        action: 'CREATE_SCHOOL',
        entityType: 'schools',
        entityId: String(created.id),
        afterJson: created,
        ipAddress: req.ip || '',
      });

      res.status(201).json({ school: created });
    } catch (error) {
      console.error('Create school error:', error);
      res.status(500).json({ error: 'تعذر إضافة المدرسة (تأكد من عدم تكرار الاسم)' });
    }
  });

  app.patch('/api/schools/:id', requireAuth, requireAdminOrStaff, requirePermission('schools:write'), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      const [existing] = await db.select().from(schools).where(eq(schools.id, id)).limit(1);
      if (!existing) return res.status(404).json({ error: 'المدرسة غير موجودة' });

      const {
        name,
        contactName,
        contactPhone,
        address,
        monthlyContractValue,
        contractStartDate,
        contractEndDate,
        notes,
        isActive,
      } = req.body;

      const [updated] = await db
        .update(schools)
        .set({
          name: name ?? existing.name,
          contactName: contactName ?? existing.contactName,
          contactPhone: contactPhone ?? existing.contactPhone,
          address: address ?? existing.address,
          monthlyContractValue:
            monthlyContractValue !== undefined
              ? Number(monthlyContractValue).toFixed(2)
              : existing.monthlyContractValue,
          contractStartDate: contractStartDate ?? existing.contractStartDate,
          contractEndDate: contractEndDate ?? existing.contractEndDate,
          notes: notes ?? existing.notes,
          isActive: isActive !== undefined ? Boolean(isActive) : existing.isActive,
        })
        .where(eq(schools.id, id))
        .returning();

      res.json({ school: updated });
    } catch (error) {
      console.error('Update school error:', error);
      res.status(500).json({ error: 'تعذر تحديث المدرسة' });
    }
  });

  app.get('/api/owners', requireAuth, requireAdminOrStaff, requireAnyPermission(['vehicles:read', 'schools:read']), async (_req: AuthRequest, res) => {
    try {
      const owners = await db.select().from(vehicleOwners).orderBy(vehicleOwners.fullName);
      res.json({ owners });
    } catch (error) {
      console.error('Get owners error:', error);
      res.status(500).json({ error: 'تعذر تحميل ملاك المركبات' });
    }
  });

  app.post('/api/owners', requireAuth, requireAdminOrStaff, requirePermission('vehicles:write'), async (req: AuthRequest, res) => {
    try {
      const { fullName, phone, nationalId, notes } = req.body;
      if (!fullName || !phone) {
        return res.status(400).json({ error: 'اسم المالك ورقم الهاتف مطلوبان' });
      }
      const [owner] = await db
        .insert(vehicleOwners)
        .values({ fullName, phone, nationalId: nationalId || '', notes: notes || '' })
        .returning();
      res.status(201).json({ owner });
    } catch (error) {
      console.error('Create owner error:', error);
      res.status(500).json({ error: 'تعذر إضافة مالك المركبة' });
    }
  });

  app.get('/api/vehicles', requireAuth, requireAdminOrStaff, requirePermission('vehicles:read'), async (_req: AuthRequest, res) => {
    try {
      const fleet = await getFleetWithLatestGps();
      const owners = await db.select().from(vehicleOwners).orderBy(vehicleOwners.fullName);
      res.json({ vehicles: fleet, owners });
    } catch (error) {
      console.error('Get vehicles error:', error);
      res.status(500).json({ error: 'تعذر تحميل المركبات' });
    }
  });

  app.post('/api/vehicles', requireAuth, requireAdminOrStaff, requirePermission('vehicles:write'), async (req: AuthRequest, res) => {
    try {
      const {
        busNumber,
        registrationNumber,
        vehicleType,
        ownerId,
        ownerName,
        monthlyOwnerCost,
        operationalStatus,
        notes,
      } = req.body;
      if (!busNumber || !registrationNumber) {
        return res.status(400).json({ error: 'رقم الباص ورقم اللوحة مطلوبان' });
      }
      const created = await db.transaction(async (tx) => {
        const resolvedOwnerId = await resolveOwnerIdForVehicle(tx, { ownerId, ownerName });
        const [v] = await tx
          .insert(vehicles)
          .values({
            busNumber: String(busNumber).trim(),
            registrationNumber: String(registrationNumber).trim(),
            vehicleType: vehicleType || '',
            ownerId: resolvedOwnerId,
            monthlyOwnerCost: Number(monthlyOwnerCost || 0).toFixed(2),
            operationalStatus: operationalStatus || 'active',
            gpsStatus: 'offline',
            notes: notes || '',
          })
          .returning();

        await tx.insert(auditLogs).values({
          actorUserId: req.dbUser!.id,
          action: 'CREATE_VEHICLE',
          entityType: 'vehicles',
          entityId: String(v.id),
          afterJson: v,
          ipAddress: req.ip || '',
        });

        return v;
      });

      res.status(201).json({ vehicle: created });
    } catch (error) {
      console.error('Create vehicle error:', error);
      res.status(500).json({ error: 'تعذر إضافة المركبة (تأكد من عدم تكرار رقم الباص أو اللوحة)' });
    }
  });

  app.patch('/api/vehicles/:id', requireAuth, requireAdminOrStaff, requirePermission('vehicles:write'), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      const [existing] = await db.select().from(vehicles).where(eq(vehicles.id, id)).limit(1);
      if (!existing) return res.status(404).json({ error: 'المركبة غير موجودة' });

      const {
        busNumber,
        registrationNumber,
        vehicleType,
        ownerId,
        ownerName,
        monthlyOwnerCost,
        operationalStatus,
        notes,
      } = req.body;

      const updated = await db.transaction(async (tx) => {
        const nextOwnerId =
          ownerName !== undefined || ownerId !== undefined
            ? await resolveOwnerIdForVehicle(tx, { ownerId, ownerName })
            : existing.ownerId;
        const [v] = await tx
          .update(vehicles)
          .set({
            busNumber: busNumber ?? existing.busNumber,
            registrationNumber: registrationNumber ?? existing.registrationNumber,
            vehicleType: vehicleType ?? existing.vehicleType,
            ownerId: nextOwnerId,
            monthlyOwnerCost:
              monthlyOwnerCost !== undefined
                ? Number(monthlyOwnerCost).toFixed(2)
                : existing.monthlyOwnerCost,
            operationalStatus: operationalStatus ?? existing.operationalStatus,
            notes: notes ?? existing.notes,
          })
          .where(eq(vehicles.id, id))
          .returning();
        return v;
      });

      res.json({ vehicle: updated });
    } catch (error) {
      console.error('Update vehicle error:', error);
      res.status(500).json({ error: 'تعذر تحديث المركبة' });
    }
  });

  app.post('/api/routes', requireAuth, requireAdminOrStaff, requirePermission('routes:write'), async (req: AuthRequest, res) => {
    try {
      const { name, schoolId, schoolName, pickupArea, dropoffArea, pickupTime, dropoffTime, estimatedDistanceKm } =
        req.body;
      if (!name) {
        return res.status(400).json({ error: 'اسم الخط مطلوب' });
      }
      const route = await db.transaction(async (tx) => {
        const resolvedSchoolId = await resolveSchoolIdForDriver(tx, { schoolId, schoolName });
        const [r] = await tx
          .insert(routes)
          .values({
            name: String(name).trim(),
            schoolId: resolvedSchoolId,
            pickupArea: pickupArea || '',
            dropoffArea: dropoffArea || '',
            pickupTime: pickupTime || '',
            dropoffTime: dropoffTime || '',
            estimatedDistanceKm: Number(estimatedDistanceKm || 0),
          })
          .returning();
        return r;
      });
      res.status(201).json({ route });
    } catch (error) {
      console.error('Create route error:', error);
      res.status(500).json({ error: 'تعذر إضافة الخط' });
    }
  });

  app.patch('/api/routes/:id', requireAuth, requireAdminOrStaff, requirePermission('routes:write'), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      const [existing] = await db.select().from(routes).where(eq(routes.id, id)).limit(1);
      if (!existing) return res.status(404).json({ error: 'خط السير غير موجود' });

      const { name, schoolId, schoolName, pickupArea, dropoffArea, pickupTime, dropoffTime, estimatedDistanceKm } =
        req.body;

      const updated = await db.transaction(async (tx) => {
        const nextSchoolId =
          schoolName !== undefined || schoolId !== undefined
            ? await resolveSchoolIdForDriver(tx, { schoolId, schoolName })
            : existing.schoolId;
        const [r] = await tx
          .update(routes)
          .set({
            name: name !== undefined ? String(name).trim() : existing.name,
            schoolId: nextSchoolId,
            pickupArea: pickupArea !== undefined ? String(pickupArea) : existing.pickupArea,
            dropoffArea: dropoffArea !== undefined ? String(dropoffArea) : existing.dropoffArea,
            pickupTime: pickupTime !== undefined ? String(pickupTime) : existing.pickupTime,
            dropoffTime: dropoffTime !== undefined ? String(dropoffTime) : existing.dropoffTime,
            estimatedDistanceKm:
              estimatedDistanceKm !== undefined
                ? Number(estimatedDistanceKm || 0)
                : existing.estimatedDistanceKm,
          })
          .where(eq(routes.id, id))
          .returning();
        return r;
      });

      res.json({ route: updated });
    } catch (error) {
      console.error('Update route error:', error);
      res.status(500).json({ error: 'تعذر تحديث خط السير' });
    }
  });

  app.delete('/api/routes/:id', requireAuth, requireAdminOrStaff, requirePermission('routes:write'), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      const [existing] = await db.select().from(routes).where(eq(routes.id, id)).limit(1);
      if (!existing) return res.status(404).json({ error: 'خط السير غير موجود' });

      await db.transaction(async (tx) => {
        await tx.update(driverAssignments).set({ routeId: null }).where(eq(driverAssignments.routeId, id));
        await tx.delete(routes).where(eq(routes.id, id));
      });

      res.json({ ok: true, deletedId: id });
    } catch (error) {
      console.error('Delete route error:', error);
      res.status(500).json({ error: 'تعذر حذف خط السير' });
    }
  });

  // 5. Financial Management (Advances, Coverages, Adjustments, Reversals, Statements)
  app.get('/api/finance/overview', requireAuth, requireAdminOrStaff, requirePermission('finance:read'), async (req: AuthRequest, res) => {
    try {
      const activePeriod = await getActiveBillingPeriod();
      const month = Number(req.query.month) || activePeriod.month;
      const year = Number(req.query.year) || activePeriod.year;
      const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;

      const closingsHistory = await getMonthlyClosingsHistory();
      const currentClosing =
        closingsHistory.find((c) => c.month === month && c.year === year) || null;

      const allDrivers = await getEnrichedDrivers();
      const activeDrivers = allDrivers.filter((d) => d.accountStatus === 'active');
      const activeDriverIds = new Set(activeDrivers.map((d) => d.id));

      if (!currentClosing) {
        for (const d of activeDrivers) {
          await recalculateDriverSalary(db, d.id, month, year);
        }
      }

      const [rawMonthSalaries, monthAdvances, monthCoverages, monthLedger] = await Promise.all([
        db
          .select()
          .from(salaries)
          .where(and(eq(salaries.month, month), eq(salaries.year, year))),
        db
          .select()
          .from(advances)
          .where(sql`${advances.date} LIKE ${monthPrefix + '%'}`)
          .orderBy(desc(advances.date), desc(advances.id)),
        db
          .select()
          .from(coverageRecords)
          .where(sql`${coverageRecords.date} LIKE ${monthPrefix + '%'}`)
          .orderBy(desc(coverageRecords.date), desc(coverageRecords.id)),
        db
          .select()
          .from(financialTransactions)
          .where(and(eq(financialTransactions.month, month), eq(financialTransactions.year, year)))
          .orderBy(desc(financialTransactions.createdAt)),
      ]);

      // If the month is already closed, keep ALL recorded salaries for that ended month intact;
      // otherwise show active drivers for the open month.
      const monthSalaries = currentClosing
        ? rawMonthSalaries
        : rawMonthSalaries.filter((s) => activeDriverIds.has(s.driverId));

      const driverMap: Record<number, (typeof allDrivers)[number]> = {};
      for (const d of allDrivers) driverMap[d.id] = d;

      res.json({
        period: { month, year },
        activePeriod,
        currentClosing,
        closingsHistory,
        salaries: monthSalaries.map((s) => ({
          ...s,
          baseSalary: Number(s.baseSalary),
          totalAdvances: Number(s.totalAdvances),
          totalCoverageDeductions: Number(s.totalCoverageDeductions),
          otherDeductions: Number(s.otherDeductions),
          bonuses: Number(s.bonuses),
          netSalary: Number(s.netSalary),
          driverName: driverMap[s.driverId]?.fullName || '—',
          driverCode: driverMap[s.driverId]?.driverCode || '—',
          schoolName: driverMap[s.driverId]?.schoolName || '—',
          busNumber: driverMap[s.driverId]?.busNumber || '—',
        })),
        advances: monthAdvances.map((a) => ({
          ...a,
          amount: Number(a.amount),
          driverName: driverMap[a.driverId]?.fullName || '—',
          driverCode: driverMap[a.driverId]?.driverCode || '—',
          schoolName: driverMap[a.driverId]?.schoolName || '—',
        })),
        coverages: monthCoverages.map((c) => ({
          ...c,
          actualReplacementCost: Number(c.actualReplacementCost),
          absentDriverDeduction: Number(c.absentDriverDeduction),
          absentDriverName: driverMap[c.absentDriverId]?.fullName || '—',
          absentDriverCode: driverMap[c.absentDriverId]?.driverCode || '—',
          replacementDriverName: c.replacementDriverId
            ? driverMap[c.replacementDriverId]?.fullName || '—'
            : c.replacementExternalName || 'سائق خارجي',
          schoolName: driverMap[c.absentDriverId]?.schoolName || '—',
          busNumber: driverMap[c.absentDriverId]?.busNumber || '—',
        })),
        ledger: monthLedger.map((t) => ({
          ...t,
          amount: Number(t.amount),
          driverName: driverMap[t.driverId]?.fullName || '—',
          driverCode: driverMap[t.driverId]?.driverCode || '—',
        })),
      });
    } catch (error) {
      console.error('Finance overview error:', error);
      res.status(500).json({ error: 'تعذر تحميل البيانات المالية' });
    }
  });

  app.post('/api/finance/advances', requireAuth, requireAdminOrStaff, requirePermission('finance:write'), async (req: AuthRequest, res) => {
    try {
      const { driverId, driverQuery, amount, date, reason, paymentMethod, notes, idempotencyKey } = req.body;
      const resolvedDriver = await resolveDriverByIdOrQuery({ driverId, driverQuery });
      if (!resolvedDriver || !amount || !date) {
        return res.status(400).json({ error: 'يرجى كتابة اسم أو كود سائق مسجل والمبلغ والتاريخ' });
      }
      const result = await recordAdvanceTransaction({
        driverId: resolvedDriver.id,
        amount: Number(amount),
        date: String(date),
        reason: reason ? String(reason).trim() : '',
        paymentMethod: paymentMethod ? String(paymentMethod).trim() : '',
        notes: notes || '',
        recordedByUserId: req.dbUser!.id,
        idempotencyKey: idempotencyKey ? String(idempotencyKey) : undefined,
        ipAddress: req.ip || '',
      });
      res.status(result.duplicate ? 200 : 201).json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'تعذر تسجيل السلفة';
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/finance/coverage', requireAuth, requireAdminOrStaff, requireAnyPermission(['finance:write', 'coverage:write']), async (req: AuthRequest, res) => {
    try {
      const {
        absentDriverId,
        absentDriverQuery,
        replacementDriverId,
        replacementQuery,
        replacementExternalName,
        vehicleId,
        schoolId,
        date,
        actualReplacementCost,
        absentDriverDeduction,
        reason,
        notes,
        idempotencyKey,
      } = req.body;

      const resolvedAbsent = await resolveDriverByIdOrQuery({
        driverId: absentDriverId,
        driverQuery: absentDriverQuery,
      });
      if (!resolvedAbsent || !date) {
        return res.status(400).json({ error: 'يرجى كتابة اسم أو كود السائق الغائب والتاريخ' });
      }

      const repText = String(replacementQuery || replacementExternalName || '').trim();
      const resolvedRep = replacementDriverId
        ? await resolveDriverByIdOrQuery({ driverId: replacementDriverId })
        : repText
        ? await resolveDriverByIdOrQuery({ driverQuery: repText })
        : null;

      let nextVehicleId = vehicleId ? Number(vehicleId) : null;
      let nextSchoolId = schoolId ? Number(schoolId) : null;
      if (!nextVehicleId || !nextSchoolId) {
        const [assign] = await db
          .select()
          .from(driverAssignments)
          .where(and(eq(driverAssignments.driverId, resolvedAbsent.id), eq(driverAssignments.isCurrent, true)))
          .limit(1);
        if (!nextVehicleId) nextVehicleId = assign?.vehicleId ?? null;
        if (!nextSchoolId) nextSchoolId = assign?.schoolId ?? null;
      }

      const executeCoverage = () =>
        recordCoverageTransaction({
          absentDriverId: resolvedAbsent.id,
          replacementDriverId: resolvedRep ? resolvedRep.id : null,
          replacementExternalName: resolvedRep ? '' : repText,
          vehicleId: nextVehicleId,
          schoolId: nextSchoolId,
          date: String(date),
          actualReplacementCost: Number(actualReplacementCost || 0),
          absentDriverDeduction: Number(absentDriverDeduction || 0),
          reason: reason ? String(reason).trim() : '',
          notes: notes || '',
          recordedByUserId: req.dbUser!.id,
          idempotencyKey: idempotencyKey ? String(idempotencyKey) : undefined,
          ipAddress: req.ip || '',
        });

      const result =
        req.dbUser?.roleSlug === 'movement_manager'
          ? await runWithRlsContext({ role: 'system', driverId: null }, executeCoverage)
          : await executeCoverage();

      res.status(result.duplicate ? 200 : 201).json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'تعذر تسجيل تغطية الغياب';
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/finance/adjustments', requireAuth, requireAdminOrStaff, requirePermission('finance:write'), async (req: AuthRequest, res) => {
    try {
      const { driverId, driverQuery, month, year, type, amount, description } = req.body;
      const resolvedDriver = await resolveDriverByIdOrQuery({ driverId, driverQuery });
      if (!resolvedDriver || !type || !amount || !description) {
        return res.status(400).json({ error: 'يرجى كتابة السائق والنوع والمبلغ والبيان' });
      }
      if (type !== 'bonus' && type !== 'other_deduction') {
        return res.status(400).json({ error: 'نوع التسوية غير صحيح' });
      }
      const result = await recordAdjustmentTransaction({
        driverId: resolvedDriver.id,
        month: Number(month) || new Date().getMonth() + 1,
        year: Number(year) || new Date().getFullYear(),
        type,
        amount: Number(amount),
        description: String(description),
        recordedByUserId: req.dbUser!.id,
        ipAddress: req.ip || '',
      });
      res.status(201).json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'تعذر تسجيل التسوية المالية';
      res.status(400).json({ error: msg });
    }
  });

  app.patch('/api/finance/adjustments/:id', requireAuth, requireAdminOrStaff, requirePermission('finance:write'), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      const { type, amount, description } = req.body;
      if (!id || !amount || (type !== 'bonus' && type !== 'other_deduction')) {
        return res.status(400).json({ error: 'بيانات تعديل التسوية غير مكتملة' });
      }
      const result = await updateAdjustmentTransaction({
        id,
        type,
        amount: Number(amount),
        description: String(description || ''),
        recordedByUserId: req.dbUser!.id,
        ipAddress: req.ip || '',
      });
      res.json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'تعذر تعديل التسوية المالية';
      res.status(400).json({ error: msg });
    }
  });

  app.delete('/api/finance/adjustments/:id', requireAuth, requireAdminOrStaff, requirePermission('finance:write'), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'معرف التسوية غير صالح' });
      const result = await deleteAdjustmentTransaction({
        id,
        recordedByUserId: req.dbUser!.id,
        ipAddress: req.ip || '',
      });
      res.json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'تعذر حذف التسوية المالية';
      res.status(400).json({ error: msg });
    }
  });

  app.patch('/api/finance/advances/:id', requireAuth, requireAdminOrStaff, requirePermission('finance:write'), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      const { amount, date, reason, paymentMethod, notes } = req.body;
      if (!id || !amount || !date) {
        return res.status(400).json({ error: 'بيانات تعديل السلفة غير مكتملة' });
      }
      const result = await updateAdvanceTransaction({
        id,
        amount: Number(amount),
        date: String(date),
        reason: reason !== undefined ? String(reason).trim() : '',
        paymentMethod: paymentMethod !== undefined ? String(paymentMethod).trim() : '',
        notes: notes !== undefined ? String(notes) : '',
        recordedByUserId: req.dbUser!.id,
        ipAddress: req.ip || '',
      });
      res.json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'تعذر تعديل السلفة';
      res.status(400).json({ error: msg });
    }
  });

  app.delete('/api/finance/advances/:id', requireAuth, requireAdminOrStaff, requirePermission('finance:write'), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'معرف السلفة غير صالح' });
      const result = await deleteAdvanceTransaction({
        id,
        recordedByUserId: req.dbUser!.id,
        ipAddress: req.ip || '',
      });
      res.json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'تعذر حذف السلفة';
      res.status(400).json({ error: msg });
    }
  });

  app.patch('/api/finance/coverage/:id', requireAuth, requireAdminOrStaff, requireAnyPermission(['finance:write', 'coverage:write']), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      const {
        replacementDriverId,
        replacementQuery,
        replacementExternalName,
        date,
        actualReplacementCost,
        absentDriverDeduction,
        reason,
        notes,
      } = req.body;
      if (!id || !date) {
        return res.status(400).json({ error: 'بيانات تعديل التغطية غير مكتملة' });
      }
      const repText = String(replacementQuery ?? replacementExternalName ?? '').trim();
      const resolvedRep = replacementDriverId
        ? await resolveDriverByIdOrQuery({ driverId: replacementDriverId })
        : repText
        ? await resolveDriverByIdOrQuery({ driverQuery: repText })
        : null;

      const executeUpdate = () =>
        updateCoverageTransaction({
          id,
          replacementDriverId: resolvedRep ? resolvedRep.id : null,
          replacementExternalName: resolvedRep ? '' : repText,
          date: String(date),
          actualReplacementCost: Number(actualReplacementCost || 0),
          absentDriverDeduction: Number(absentDriverDeduction || 0),
          reason: reason !== undefined ? String(reason).trim() : '',
          notes: notes !== undefined ? String(notes) : '',
          recordedByUserId: req.dbUser!.id,
          ipAddress: req.ip || '',
        });

      const result =
        req.dbUser?.roleSlug === 'movement_manager'
          ? await runWithRlsContext({ role: 'system', driverId: null }, executeUpdate)
          : await executeUpdate();

      res.json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'تعذر تعديل سجل التغطية';
      res.status(400).json({ error: msg });
    }
  });

  app.delete('/api/finance/coverage/:id', requireAuth, requireAdminOrStaff, requireAnyPermission(['finance:write', 'coverage:write']), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'معرف التغطية غير صالح' });
      const executeDelete = () =>
        deleteCoverageTransaction({
          id,
          recordedByUserId: req.dbUser!.id,
          ipAddress: req.ip || '',
        });

      const result =
        req.dbUser?.roleSlug === 'movement_manager'
          ? await runWithRlsContext({ role: 'system', driverId: null }, executeDelete)
          : await executeDelete();

      res.json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'تعذر حذف سجل التغطية';
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/finance/reverse', requireAuth, requireAdminOrStaff, requirePermission('finance:write'), async (req: AuthRequest, res) => {
    try {
      const { targetType, targetId, reason } = req.body;
      if ((targetType !== 'advance' && targetType !== 'coverage') || !targetId) {
        return res.status(400).json({ error: 'بيانات العكس غير مكتملة' });
      }
      const result = await reverseFinancialRecord({
        targetType,
        targetId: Number(targetId),
        reason: reason || 'تصحيح قيد مالي',
        recordedByUserId: req.dbUser!.id,
        ipAddress: req.ip || '',
      });
      res.json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'تعذر تنفيذ قيد العكس';
      res.status(400).json({ error: msg });
    }
  });

  // 5b. Non-Driver Employees Management (الموظفون غير السائقين - نشطون فقط)
  app.get('/api/employees', requireAuth, requireAdminOrStaff, async (req: AuthRequest, res) => {
    try {
      const includeArchived = req.query.includeArchived === 'true';
      const rows = await db.select().from(employees).orderBy(employees.fullName);
      const visible = includeArchived ? rows : rows.filter((e) => e.status === 'active');
      res.json({
        employees: visible.map((e) => ({
          ...e,
          monthlySalary: Number(e.monthlySalary || 0),
          bonuses: Number(e.bonuses || 0),
          deductions: Number(e.deductions || 0),
          netSalary:
            Number(e.monthlySalary || 0) + Number(e.bonuses || 0) - Number(e.deductions || 0),
        })),
      });
    } catch (error) {
      console.error('Get employees error:', error);
      res.status(500).json({ error: 'تعذر تحميل بيانات الموظفين' });
    }
  });

  // 5c. Dedicated Archive Management (الأرشفة)
  app.get('/api/archive', requireAuth, requireAdminOrStaff, async (_req: AuthRequest, res) => {
    try {
      const allDrivers = await getEnrichedDrivers();
      const archivedDrivers = allDrivers.filter((d) => d.accountStatus !== 'active');

      const allEmployees = await db.select().from(employees).orderBy(employees.fullName);
      const archivedEmployees = allEmployees
        .filter((e) => e.status !== 'active')
        .map((e) => ({
          ...e,
          monthlySalary: Number(e.monthlySalary || 0),
          bonuses: Number(e.bonuses || 0),
          deductions: Number(e.deductions || 0),
          netSalary:
            Number(e.monthlySalary || 0) + Number(e.bonuses || 0) - Number(e.deductions || 0),
        }));

      const allVehicles = await getFleetWithLatestGps();
      const archivedVehicles = allVehicles.filter((v) => v.operationalStatus === 'inactive');

      const allSchools = await db.select().from(schools).orderBy(schools.name);
      const archivedSchools = allSchools.filter((s) => !s.isActive);

      res.json({
        drivers: archivedDrivers,
        employees: archivedEmployees,
        vehicles: archivedVehicles,
        schools: archivedSchools,
      });
    } catch (error) {
      console.error('Get archive error:', error);
      res.status(500).json({ error: 'تعذر تحميل بيانات الأرشفة' });
    }
  });

  app.post('/api/archive/drivers/:id/restore', requireAuth, requireAdminOrStaff, requirePermission('drivers:write'), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      const [updated] = await db
        .update(drivers)
        .set({ accountStatus: 'active' })
        .where(eq(drivers.id, id))
        .returning();
      if (!updated) return res.status(404).json({ error: 'السائق غير موجود' });
      await db.insert(auditLogs).values({
        actorUserId: req.dbUser!.id,
        action: 'RESTORE_DRIVER_FROM_ARCHIVE',
        entityType: 'drivers',
        entityId: String(id),
        afterJson: updated,
        ipAddress: req.ip || '',
      });
      res.json({ driver: updated });
    } catch (error) {
      console.error('Restore driver error:', error);
      res.status(500).json({ error: 'تعذر استعادة السائق من الأرشفة' });
    }
  });

  app.post('/api/archive/employees/:id/restore', requireAuth, requireAdminOrStaff, async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      const [updated] = await db
        .update(employees)
        .set({ status: 'active' })
        .where(eq(employees.id, id))
        .returning();
      if (!updated) return res.status(404).json({ error: 'الموظف غير موجود' });
      res.json({ employee: updated });
    } catch (error) {
      res.status(500).json({ error: 'تعذر استعادة الموظف من الأرشفة' });
    }
  });

  app.post('/api/archive/vehicles/:id/restore', requireAuth, requireAdminOrStaff, requirePermission('vehicles:write'), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      const [updated] = await db
        .update(vehicles)
        .set({ operationalStatus: 'active' })
        .where(eq(vehicles.id, id))
        .returning();
      if (!updated) return res.status(404).json({ error: 'المركبة غير موجودة' });
      res.json({ vehicle: updated });
    } catch (error) {
      res.status(500).json({ error: 'تعذر استعادة المركبة' });
    }
  });

  app.post('/api/archive/schools/:id/restore', requireAuth, requireAdminOrStaff, requirePermission('schools:write'), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      const [updated] = await db
        .update(schools)
        .set({ isActive: true })
        .where(eq(schools.id, id))
        .returning();
      if (!updated) return res.status(404).json({ error: 'المدرسة غير موجودة' });
      res.json({ school: updated });
    } catch (error) {
      res.status(500).json({ error: 'تعذر استعادة المدرسة' });
    }
  });

  app.post('/api/employees', requireAuth, requireAdminOrStaff, async (req: AuthRequest, res) => {
    try {
      const {
        employeeCode,
        fullName,
        jobTitle,
        phone,
        monthlySalary,
        bonuses,
        deductions,
        employmentStartDate,
        status,
        notes,
      } = req.body;
      const trimmedName = String(fullName || '').trim();
      if (!trimmedName) {
        return res.status(400).json({ error: 'اسم الموظف مطلوب' });
      }
      const [created] = await db
        .insert(employees)
        .values({
          employeeCode: String(employeeCode || '').trim(),
          fullName: trimmedName,
          jobTitle: String(jobTitle || '').trim(),
          phone: String(phone || '').trim(),
          monthlySalary: Number(monthlySalary || 0).toFixed(2),
          bonuses: Number(bonuses || 0).toFixed(2),
          deductions: Number(deductions || 0).toFixed(2),
          employmentStartDate: String(employmentStartDate || ''),
          status: status === 'inactive' ? 'inactive' : 'active',
          notes: String(notes || ''),
        })
        .returning();

      await db.insert(auditLogs).values({
        actorUserId: req.dbUser!.id,
        action: 'CREATE_EMPLOYEE',
        entityType: 'employees',
        entityId: String(created.id),
        afterJson: created,
        ipAddress: req.ip || '',
      });

      res.status(201).json({
        employee: {
          ...created,
          monthlySalary: Number(created.monthlySalary || 0),
          bonuses: Number(created.bonuses || 0),
          deductions: Number(created.deductions || 0),
          netSalary:
            Number(created.monthlySalary || 0) +
            Number(created.bonuses || 0) -
            Number(created.deductions || 0),
        },
      });
    } catch (error) {
      console.error('Create employee error:', error);
      res.status(500).json({ error: 'تعذر إضافة الموظف' });
    }
  });

  app.patch('/api/employees/:id', requireAuth, requireAdminOrStaff, async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      const [existing] = await db.select().from(employees).where(eq(employees.id, id)).limit(1);
      if (!existing) return res.status(404).json({ error: 'الموظف غير موجود' });

      const {
        employeeCode,
        fullName,
        jobTitle,
        phone,
        monthlySalary,
        bonuses,
        deductions,
        employmentStartDate,
        status,
        notes,
      } = req.body;

      const [updated] = await db
        .update(employees)
        .set({
          employeeCode:
            employeeCode !== undefined ? String(employeeCode).trim() : existing.employeeCode,
          fullName: fullName !== undefined ? String(fullName).trim() : existing.fullName,
          jobTitle: jobTitle !== undefined ? String(jobTitle).trim() : existing.jobTitle,
          phone: phone !== undefined ? String(phone).trim() : existing.phone,
          monthlySalary:
            monthlySalary !== undefined
              ? Number(monthlySalary || 0).toFixed(2)
              : existing.monthlySalary,
          bonuses:
            bonuses !== undefined ? Number(bonuses || 0).toFixed(2) : existing.bonuses,
          deductions:
            deductions !== undefined ? Number(deductions || 0).toFixed(2) : existing.deductions,
          employmentStartDate:
            employmentStartDate !== undefined
              ? String(employmentStartDate)
              : existing.employmentStartDate,
          status: status !== undefined ? String(status) : existing.status,
          notes: notes !== undefined ? String(notes) : existing.notes,
          updatedAt: new Date(),
        })
        .where(eq(employees.id, id))
        .returning();

      res.json({
        employee: {
          ...updated,
          monthlySalary: Number(updated.monthlySalary || 0),
          bonuses: Number(updated.bonuses || 0),
          deductions: Number(updated.deductions || 0),
          netSalary:
            Number(updated.monthlySalary || 0) +
            Number(updated.bonuses || 0) -
            Number(updated.deductions || 0),
        },
      });
    } catch (error) {
      console.error('Update employee error:', error);
      res.status(500).json({ error: 'تعذر تحديث بيانات الموظف' });
    }
  });

  app.delete('/api/employees/:id', requireAuth, requireAdminOrStaff, async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      const [existing] = await db.select().from(employees).where(eq(employees.id, id)).limit(1);
      if (!existing) return res.status(404).json({ error: 'الموظف غير موجود' });
      await db.delete(employees).where(eq(employees.id, id));
      await db.insert(auditLogs).values({
        actorUserId: req.dbUser!.id,
        action: 'DELETE_EMPLOYEE',
        entityType: 'employees',
        entityId: String(id),
        beforeJson: existing,
        ipAddress: req.ip || '',
      });
      res.json({ ok: true, deletedId: id });
    } catch (error) {
      console.error('Delete employee error:', error);
      res.status(500).json({ error: 'تعذر حذف الموظف' });
    }
  });

  app.patch('/api/finance/salaries/:id/status', requireAuth, requireAdminOrStaff, requirePermission('finance:write'), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      const { status } = req.body;
      if (!['open', 'approved', 'paid'].includes(status)) {
        return res.status(400).json({ error: 'حالة الراتب غير صالحة' });
      }
      const [updated] = await db
        .update(salaries)
        .set({ status, updatedAt: new Date() })
        .where(eq(salaries.id, id))
        .returning();
      if (!updated) return res.status(404).json({ error: 'سجل الراتب غير موجود' });

      await db.insert(auditLogs).values({
        actorUserId: req.dbUser!.id,
        action: 'UPDATE_SALARY_STATUS',
        entityType: 'salaries',
        entityId: String(id),
        afterJson: { status },
        ipAddress: req.ip || '',
      });

      res.json({ salary: updated });
    } catch (error) {
      console.error('Salary status error:', error);
      res.status(500).json({ error: 'تعذر تحديث حالة الراتب' });
    }
  });

  // 5d. Monthly Settlement / Closing & Fresh-Month Rollover (التصفية الشهرية وبدء شهر جديد على بياض)
  app.get('/api/finance/period', requireAuth, async (_req: AuthRequest, res) => {
    try {
      const activePeriod = await getActiveBillingPeriod();
      res.json({ activePeriod });
    } catch (error) {
      res.status(500).json({ error: 'تعذر قراءة الشهر المالي المفتوح' });
    }
  });

  app.get('/api/finance/closings', requireAuth, requireAdminOrStaff, requirePermission('finance:read'), async (_req: AuthRequest, res) => {
    try {
      const [activePeriod, closings] = await Promise.all([
        getActiveBillingPeriod(),
        getMonthlyClosingsHistory(),
      ]);
      res.json({ activePeriod, closings });
    } catch (error) {
      console.error('Closings history error:', error);
      res.status(500).json({ error: 'تعذر تحميل سجل التصفيات الشهرية' });
    }
  });

  app.post('/api/finance/close-month', requireAuth, requireAdminOrStaff, requirePermission('finance:write'), async (req: AuthRequest, res) => {
    try {
      const activePeriod = await getActiveBillingPeriod();
      const month = Number(req.body?.month) || activePeriod.month;
      const year = Number(req.body?.year) || activePeriod.year;
      const markAllPaid = req.body?.markAllPaid !== false;
      const notes = String(req.body?.notes || '').trim();

      const result = await closeMonthAndStartNext({
        month,
        year,
        markAllPaid,
        notes,
        recordedByUserId: req.dbUser!.id,
        ipAddress: req.ip || '',
      });

      res.json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'تعذر تنفيذ التصفية الشهرية';
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/finance/reset-month', requireAuth, requireAdminOrStaff, requirePermission('finance:write'), async (req: AuthRequest, res) => {
    try {
      const activePeriod = await getActiveBillingPeriod();
      const month = Number(req.body?.month) || activePeriod.month;
      const year = Number(req.body?.year) || activePeriod.year;
      const resetEmployees = req.body?.resetEmployees !== false;

      const result = await resetMonthFinancials({
        month,
        year,
        resetEmployees,
        recordedByUserId: req.dbUser!.id,
        ipAddress: req.ip || '',
      });

      res.json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'تعذر تصفير مالية الشهر';
      res.status(400).json({ error: msg });
    }
  });

  // 6. Attendance
  app.get('/api/attendance', requireAuth, requireAdminOrStaff, requireAnyPermission(['attendance:write', 'dashboard:read']), async (req: AuthRequest, res) => {
    try {
      const dateStr = (req.query.date as string) || getTodayDateString();
      const rows = await db.select().from(attendance).where(eq(attendance.date, dateStr));
      res.json({ date: dateStr, records: rows });
    } catch (error) {
      console.error('Attendance get error:', error);
      res.status(500).json({ error: 'تعذر تحميل الحضور' });
    }
  });

  app.post('/api/attendance', requireAuth, requireAdminOrStaff, requirePermission('attendance:write'), async (req: AuthRequest, res) => {
    try {
      const { driverId, date, status, notes } = req.body;
      if (!driverId || !date || !status) {
        return res.status(400).json({ error: 'السائق والتاريخ والحالة مطلوبة' });
      }
      const [row] = await db
        .insert(attendance)
        .values({
          driverId: Number(driverId),
          date: String(date),
          status: String(status),
          notes: notes || '',
          recordedByUserId: req.dbUser!.id,
        })
        .onConflictDoUpdate({
          target: [attendance.driverId, attendance.date],
          set: { status: String(status), notes: notes || '', recordedByUserId: req.dbUser!.id },
        })
        .returning();
      res.json({ record: row });
    } catch (error) {
      console.error('Attendance save error:', error);
      res.status(500).json({ error: 'تعذر حفظ الحضور' });
    }
  });

  // 7. Live GPS Tracking
  app.get('/api/gps/fleet', requireAuth, requireAdminOrStaff, requirePermission('gps:read'), async (_req: AuthRequest, res) => {
    try {
      const fleet = (await getFleetWithLatestGps()).filter(
        (v) => v.operationalStatus !== 'inactive'
      );
      res.json({ fleet });
    } catch (error) {
      console.error('GPS fleet error:', error);
      res.status(500).json({ error: 'تعذر تحميل مواقع الأسطول' });
    }
  });

  app.get('/api/gps/vehicle/:id/history', requireAuth, requireAdminOrStaff, requirePermission('gps:read'), async (req: AuthRequest, res) => {
    try {
      const vehicleId = Number(req.params.id);
      const history = await db
        .select()
        .from(gpsLocations)
        .where(eq(gpsLocations.vehicleId, vehicleId))
        .orderBy(desc(gpsLocations.recordedAt))
        .limit(50);

      // Compute approximate distance traveled from consecutive points
      let distanceKm = 0;
      for (let i = 1; i < history.length; i++) {
        const p1 = history[i - 1];
        const p2 = history[i];
        const R = 6371;
        const dLat = ((p2.lat - p1.lat) * Math.PI) / 180;
        const dLon = ((p2.lng - p1.lng) * Math.PI) / 180;
        const a =
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos((p1.lat * Math.PI) / 180) *
            Math.cos((p2.lat * Math.PI) / 180) *
            Math.sin(dLon / 2) *
            Math.sin(dLon / 2);
        distanceKm += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      }

      res.json({ history, distanceKm: Number(distanceKm.toFixed(2)) });
    } catch (error) {
      console.error('GPS history error:', error);
      res.status(500).json({ error: 'تعذر تحميل سجل المسار' });
    }
  });

  // Admin simulation / manual GPS ping or driver update
  app.post('/api/gps/update', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { vehicleId, lat, lng, speedKmh, heading, accuracyMeters, recordedAt, source } = req.body;
      let targetVehicleId = vehicleId ? Number(vehicleId) : null;
      let targetDriverId: number | null = req.driverRecord?.id || null;

      if (req.dbUser?.roleSlug === 'driver') {
        if (!req.driverRecord) {
          return res.status(403).json({ error: 'لا يوجد ملف سائق مرتبط بحسابك' });
        }
        const [assign] = await db
          .select()
          .from(driverAssignments)
          .where(and(eq(driverAssignments.driverId, req.driverRecord.id), eq(driverAssignments.isCurrent, true)))
          .limit(1);
        if (!assign || !assign.vehicleId) {
          return res.status(400).json({ error: 'لم يتم تعيين مركبة لك بعد' });
        }
        targetVehicleId = assign.vehicleId;
        targetDriverId = req.driverRecord.id;
      } else if (!hasPermission(req.dbUser, 'gps:write')) {
        return res.status(403).json({ error: 'ليس لديك صلاحية تحديث إحداثيات المركبات' });
      }

      const numLat = Number(lat);
      const numLng = Number(lng);
      if (!targetVehicleId || !isValidGpsCoordinate(numLat, numLng)) {
        return res.status(400).json({ error: 'بيانات الموقع الجغرافي غير صالحة أو خارج النطاق' });
      }

      const parsedRecordedAt =
        typeof recordedAt === 'string' || typeof recordedAt === 'number'
          ? new Date(recordedAt)
          : new Date();
      const validRecordedAt = Number.isNaN(parsedRecordedAt.getTime())
        ? new Date()
        : parsedRecordedAt;
      const pointSource =
        source === 'buffered' || source === 'manual' ? String(source) : 'live';
      const isFreshNow = Date.now() - validRecordedAt.getTime() <= GPS_STALE_THRESHOLD_MS;

      const [ping] = await db
        .insert(gpsLocations)
        .values({
          vehicleId: targetVehicleId,
          driverId: targetDriverId,
          lat: numLat,
          lng: numLng,
          speedKmh: Math.max(0, Math.min(200, Number(speedKmh || 0))),
          heading: Number.isFinite(Number(heading)) ? Number(heading) : 0,
          accuracyMeters: Number.isFinite(Number(accuracyMeters)) ? Number(accuracyMeters) : 10,
          isLive: isFreshNow,
          source: pointSource,
          recordedAt: validRecordedAt,
        })
        .returning();

      if (isFreshNow) {
        await db
          .update(vehicles)
          .set({ gpsStatus: 'online' })
          .where(eq(vehicles.id, targetVehicleId));
      }

      res.status(201).json({ ping });
    } catch (error) {
      console.error('GPS update error:', error);
      res.status(500).json({ error: 'تعذر تحديث الموقع الجغرافي' });
    }
  });

  // Batch GPS offline buffer flush (for Driver background/offline sync)
  app.post('/api/gps/sync-batch', requireAuth, async (req: AuthRequest, res) => {
    try {
      if (req.dbUser?.roleSlug !== 'driver' && !hasPermission(req.dbUser, 'gps:write')) {
        return res.status(403).json({ error: 'غير مصرح لك بمزامنة نقاط GPS' });
      }

      const points = Array.isArray(req.body?.points) ? req.body.points : [];
      if (points.length === 0) {
        return res.json({ ok: true, inserted: 0 });
      }
      if (points.length > 250) {
        return res.status(400).json({ error: 'الحد الأقصى للدفعة الواحدة هو 250 نقطة' });
      }

      let driverVehicleId: number | null = null;
      let driverId: number | null = req.driverRecord?.id || null;
      if (req.dbUser?.roleSlug === 'driver') {
        if (!req.driverRecord) {
          return res.status(403).json({ error: 'لا يوجد ملف سائق مرتبط بحسابك' });
        }
        const [assign] = await db
          .select()
          .from(driverAssignments)
          .where(and(eq(driverAssignments.driverId, req.driverRecord.id), eq(driverAssignments.isCurrent, true)))
          .limit(1);
        if (!assign?.vehicleId) {
          return res.status(400).json({ error: 'لم يتم تعيين مركبة لك بعد' });
        }
        driverVehicleId = assign.vehicleId;
        driverId = req.driverRecord.id;
      }

      const rowsToInsert: Array<typeof gpsLocations.$inferInsert> = [];
      let newestFreshVehicleId: number | null = null;

      for (const rawPt of points) {
        if (!rawPt || typeof rawPt !== 'object') continue;
        const pt = rawPt as Record<string, unknown>;
        const lat = Number(pt.lat);
        const lng = Number(pt.lng);
        const vId = driverVehicleId || (pt.vehicleId ? Number(pt.vehicleId) : null);
        if (!vId || !isValidGpsCoordinate(lat, lng)) continue;

        const recDate = pt.recordedAt ? new Date(String(pt.recordedAt)) : new Date();
        const validDate = Number.isNaN(recDate.getTime()) ? new Date() : recDate;
        const fresh = Date.now() - validDate.getTime() <= GPS_STALE_THRESHOLD_MS;
        if (fresh) newestFreshVehicleId = vId;

        rowsToInsert.push({
          vehicleId: vId,
          driverId,
          lat,
          lng,
          speedKmh: Math.max(0, Math.min(200, Number(pt.speedKmh || 0))),
          heading: Number.isFinite(Number(pt.heading)) ? Number(pt.heading) : 0,
          accuracyMeters: Number.isFinite(Number(pt.accuracyMeters)) ? Number(pt.accuracyMeters) : 15,
          isLive: fresh,
          source: 'buffered',
          recordedAt: validDate,
        });
      }

      if (rowsToInsert.length > 0) {
        await db.insert(gpsLocations).values(rowsToInsert);
        if (newestFreshVehicleId) {
          await db
            .update(vehicles)
            .set({ gpsStatus: 'online' })
            .where(eq(vehicles.id, newestFreshVehicleId));
        }
      }

      res.status(201).json({ ok: true, inserted: rowsToInsert.length });
    } catch (error) {
      console.error('GPS sync-batch error:', error);
      res.status(500).json({ error: 'تعذر مزامنة نقاط الموقع المخزنة' });
    }
  });

  // 8. Egyptian Arabic AI Voice Assistant (Admin Only)
  app.post('/api/voice/transcribe', requireAuth, requireAdminOrStaff, requirePermission('*'), async (req: AuthRequest, res) => {
    try {
      const { audioBase64, mimeType } = req.body;
      if (!audioBase64) {
        console.warn('[API /voice/transcribe] Missing audioBase64 in request');
        return res.status(400).json({ error: 'الملف الصوتي غير موجود' });
      }
      console.info(
        `[API /voice/transcribe] user=${req.dbUser?.email} mime=${mimeType || 'audio/webm'} size=${String(audioBase64).length}`
      );
      const transcript = await transcribeEgyptianAudio(audioBase64, mimeType || 'audio/webm');
      if (!transcript) {
        return res.status(422).json({ error: 'لم يتم التقاط كلام واضح في التسجيل، حاول التحدث بصوت أوضح.' });
      }
      res.json({ transcript });
    } catch (error: unknown) {
      console.error('[API /voice/transcribe] Voice transcribe error:', error);
      const detail = error instanceof Error ? error.message : String(error);
      let userMessage = 'تعذر تحويل الصوت إلى نص عبر الخادم. يمكنك استخدام الإملاء المباشر أو كتابة الأمر.';
      if (detail.includes('مفتاح')) {
        userMessage = detail;
      } else if (detail.includes('429') || detail.includes('RESOURCE_EXHAUSTED')) {
        userMessage = 'تم تجاوز حصة طلبات الذكاء الاصطناعي مؤقتاً. يمكنك استخدام زر الإملاء الفوري أو كتابة الأمر.';
      } else if (detail.includes('400') || detail.includes('INVALID_ARGUMENT')) {
        userMessage = 'صيغة الملف الصوتي غير مدعومة من الخادم. جرب الإملاء الفوري أو أعد التسجيل.';
      } else if (detail.includes('timed out') || detail.includes('503') || detail.includes('UNAVAILABLE')) {
        userMessage = 'خدمة تحويل الصوت مشغولة أو بطيئة حالياً، يرجى إعادة المحاولة أو استخدام الإملاء الفوري.';
      }
      res.status(500).json({ error: userMessage });
    }
  });

  app.post('/api/voice/interpret', requireAuth, requireAdminOrStaff, requirePermission('*'), async (req: AuthRequest, res) => {
    try {
      const { transcript } = req.body;
      if (!transcript || !String(transcript).trim()) {
        return res.status(400).json({ error: 'يرجى إدخال الأمر الصوتي أو النصي' });
      }

      const todayDate = getTodayDateString();
      const allEnrichedDrivers = await getEnrichedDrivers();
      const enrichedDrivers = allEnrichedDrivers.filter((d) => d.accountStatus === 'active');
      const allSchools = await db.select().from(schools);

      const interpreted = await interpretEgyptianCommand(String(transcript), {
        todayDate,
        driversList: enrichedDrivers.map((d) => ({
          id: d.id,
          driverCode: d.driverCode,
          fullName: d.fullName,
          schoolName: d.schoolName,
          busNumber: d.busNumber,
        })),
        schoolsList: allSchools.map((s) => ({ id: s.id, name: s.name })),
      });

      // Resolve matched driver against DB
      const matchedDriver = enrichedDrivers.find(
        (d) =>
          (interpreted.driverCode && d.driverCode === interpreted.driverCode.trim()) ||
          (interpreted.driverNameQuery &&
            d.fullName.includes(interpreted.driverNameQuery.trim()))
      );

      const matchedSchool = allSchools.find(
        (s) =>
          interpreted.schoolNameQuery &&
          (s.name.includes(interpreted.schoolNameQuery.trim()) ||
            interpreted.schoolNameQuery.includes(s.name))
      );

      const now = new Date();
      const month = now.getMonth() + 1;
      const year = now.getFullYear();

      // Handle read-only queries directly against real PostgreSQL data
      let queryResult: Record<string, unknown> | null = null;
      let finalReply = interpreted.replyArabic;
      let requiresConfirmation = interpreted.requiresConfirmation;
      let executionStatus = 'parsed';

      if (interpreted.isAmbiguous) {
        requiresConfirmation = false;
        finalReply = interpreted.ambiguityReason || 'الأمر غير واضح بما يكفي. من فضلك حدد اسم أو كود السائق والمبلغ بدقة.';
      } else if (!requiresConfirmation) {
        executionStatus = 'executed';

        if (interpreted.intent === 'driver_statement') {
          if (!matchedDriver) {
            finalReply = `ملقتش سائق بالاسم أو الكود "${interpreted.driverNameQuery || interpreted.driverCode}". تأكد من الاسم أو رقم السائق.`;
          } else {
            const sal = await recalculateDriverSalary(db, matchedDriver.id, month, year);
            queryResult = {
              type: 'driver_statement',
              driver: matchedDriver,
              salary: {
                baseSalary: Number(sal.baseSalary),
                totalAdvances: Number(sal.totalAdvances),
                totalCoverageDeductions: Number(sal.totalCoverageDeductions),
                otherDeductions: Number(sal.otherDeductions),
                bonuses: Number(sal.bonuses),
                netSalary: Number(sal.netSalary),
              },
            };
            finalReply = `كشف حساب السائق ${matchedDriver.fullName} (كود ${matchedDriver.driverCode}) للشهر ده: الراتب الأساسي ${Number(sal.baseSalary).toLocaleString('ar-EG')} جنيه، السلف ${Number(sal.totalAdvances).toLocaleString('ar-EG')} جنيه، خصومات التغطية ${Number(sal.totalCoverageDeductions).toLocaleString('ar-EG')} جنيه، المكافآت ${Number(sal.bonuses).toLocaleString('ar-EG')} جنيه، وصافي المستحق حالياً ${Number(sal.netSalary).toLocaleString('ar-EG')} جنيه.`;
          }
        } else if (interpreted.intent === 'absent_drivers') {
          const targetDate = interpreted.date || todayDate;
          const attRows = await db
            .select()
            .from(attendance)
            .where(eq(attendance.date, targetDate));
          const absentIds = new Set(
            attRows.filter((a) => a.status === 'absent' || a.status === 'covered').map((a) => a.driverId)
          );
          const absentList = enrichedDrivers.filter((d) => absentIds.has(d.id));
          queryResult = { type: 'absent_drivers', date: targetDate, drivers: absentList };
          finalReply =
            absentList.length === 0
              ? `مفيش أي سائقين غايبين بتاريخ ${targetDate}، كل السائقين منتظمين الحمد لله.`
              : `عدد السائقين الغائبين أو المغطيين بتاريخ ${targetDate} هو ${absentList.length}: ${absentList.map((d) => `${d.fullName} (كود ${d.driverCode})`).join('، ')}.`;
        } else if (interpreted.intent === 'school_advances_total') {
          const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
          const schoolDrivers = matchedSchool
            ? enrichedDrivers.filter((d) => d.schoolId === matchedSchool.id)
            : enrichedDrivers;
          const schoolDriverIds = new Set(schoolDrivers.map((d) => d.id));
          const monthAdv = await db
            .select()
            .from(advances)
            .where(and(eq(advances.isReversed, false), sql`${advances.date} LIKE ${monthPrefix + '%'}`));
          const filteredAdv = monthAdv.filter((a) => schoolDriverIds.has(a.driverId));
          const total = filteredAdv.reduce((sum, a) => sum + Number(a.amount || 0), 0);
          queryResult = {
            type: 'school_advances_total',
            schoolName: matchedSchool?.name || 'كل المدارس',
            total,
            count: filteredAdv.length,
          };
          finalReply = matchedSchool
            ? `إجمالي السلف في ${matchedSchool.name} الشهر ده هو ${total.toLocaleString('ar-EG')} جنيه بإجمالي ${filteredAdv.length} عملية.`
            : `إجمالي السلف في المكتب كله الشهر ده ${total.toLocaleString('ar-EG')} جنيه بإجمالي ${filteredAdv.length} عملية.`;
        } else if (interpreted.intent === 'top_advance_driver') {
          const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
          const monthAdv = await db
            .select()
            .from(advances)
            .where(and(eq(advances.isReversed, false), sql`${advances.date} LIKE ${monthPrefix + '%'}`));
          const totalsByDriver: Record<number, number> = {};
          for (const a of monthAdv) {
            totalsByDriver[a.driverId] = (totalsByDriver[a.driverId] || 0) + Number(a.amount || 0);
          }
          let topDriverId = 0;
          let topAmount = 0;
          for (const [idStr, amt] of Object.entries(totalsByDriver)) {
            if (amt > topAmount) {
              topAmount = amt;
              topDriverId = Number(idStr);
            }
          }
          const topDriver = enrichedDrivers.find((d) => d.id === topDriverId);
          queryResult = { type: 'top_advance_driver', driver: topDriver || null, totalAmount: topAmount };
          finalReply = topDriver
            ? `أكتر سائق أخد سلف الشهر ده هو ${topDriver.fullName} (كود ${topDriver.driverCode}) بإجمالي ${topAmount.toLocaleString('ar-EG')} جنيه.`
            : `لم يتم تسجيل أي سلف خلال الشهر الحالي حتى الآن.`;
        } else if (interpreted.intent === 'offline_vehicles') {
          const fleet = await getFleetWithLatestGps();
          const offline = fleet.filter((v) => !v.isOnline && v.operationalStatus === 'active');
          queryResult = { type: 'offline_vehicles', vehicles: offline };
          finalReply =
            offline.length === 0
              ? 'كل الباصات النشطة متصلة بالإنترنت والـ GPS شغال تمام.'
              : `يوجد ${offline.length} باصات غير متصلة حالياً: ${offline.map((v) => `${v.busNumber} (${v.driverName})`).join('، ')}.`;
        } else if (interpreted.intent === 'total_net_salaries') {
          let totalNet = 0;
          for (const d of enrichedDrivers) {
            const sal = await recalculateDriverSalary(db, d.id, month, year);
            totalNet += Math.max(0, Number(sal.netSalary));
          }
          queryResult = { type: 'total_net_salaries', totalNet, driverCount: enrichedDrivers.length };
          finalReply = `إجمالي صافي المرتبات المطلوب دفعها الشهر ده لعدد ${enrichedDrivers.length} سائقين هو ${totalNet.toLocaleString('ar-EG')} جنيه.`;
        } else if (interpreted.intent === 'monthly_profit') {
          const fleet = await getFleetWithLatestGps();
          const schoolRev = allSchools
            .filter((s) => s.isActive)
            .reduce((sum, s) => sum + Number(s.monthlyContractValue || 0), 0);
          const ownerCost = fleet
            .filter((v) => v.operationalStatus !== 'inactive')
            .reduce((sum, v) => sum + v.monthlyOwnerCost, 0);
          const profit = schoolRev - ownerCost;
          queryResult = { type: 'monthly_profit', schoolRev, ownerCost, profit };
          finalReply = `صافي ربح المكتب الشهري المتوقع من عقود المدارس (${schoolRev.toLocaleString('ar-EG')} جنيه) ناقص تكلفة ملاك الباصات (${ownerCost.toLocaleString('ar-EG')} جنيه) هو ${profit.toLocaleString('ar-EG')} جنيه.`;
        }
      } else {
        // Financial action requiring explicit Admin Confirmation!
        if (!matchedDriver) {
          requiresConfirmation = false;
          finalReply = `لم أتمكن من مطابقة السائق (${interpreted.driverCode || interpreted.driverNameQuery}) في قاعدة البيانات. برجاء تحديد كود السائق أو اسمه بدقة.`;
        } else if (
          interpreted.intent === 'edit_advance' ||
          interpreted.intent === 'delete_advance'
        ) {
          const driverAdvances = await db
            .select()
            .from(advances)
            .where(and(eq(advances.driverId, matchedDriver.id), eq(advances.isReversed, false)))
            .orderBy(desc(advances.date), desc(advances.id))
            .limit(12);

          if (driverAdvances.length === 0) {
            requiresConfirmation = false;
            finalReply = `السائق ${matchedDriver.fullName} معندوش أي سلف مسجلة حالياً لتعديلها أو حذفها.`;
          } else {
            const targetAdvance =
              (interpreted.targetDate
                ? driverAdvances.find((a) => a.date === interpreted.targetDate)
                : undefined) ||
              (interpreted.oldAmount > 0
                ? driverAdvances.find((a) => Number(a.amount) === interpreted.oldAmount)
                : undefined) ||
              driverAdvances[0];

            const sal = await recalculateDriverSalary(db, matchedDriver.id, month, year);
            const currentNet = Number(sal.netSalary);
            const currentAdvAmt = Number(targetAdvance.amount);
            const nextAmt =
              interpreted.intent === 'delete_advance'
                ? 0
                : interpreted.amount > 0
                ? Number(interpreted.amount)
                : currentAdvAmt;
            const projectedNet = currentNet + currentAdvAmt - nextAmt;

            const availableAdvances = driverAdvances.map((a) => ({
              id: a.id,
              amount: Number(a.amount),
              date: a.date,
              reason: a.reason || '',
              paymentMethod: a.paymentMethod || 'cash',
            }));

            queryResult = {
              type: 'pending_confirmation',
              driver: matchedDriver,
              currentNetSalary: currentNet,
              projectedNetSalary: projectedNet,
              availableAdvances,
              payload: {
                intent: interpreted.intent,
                targetRecordId: targetAdvance.id,
                driverId: matchedDriver.id,
                driverCode: matchedDriver.driverCode,
                driverName: matchedDriver.fullName,
                schoolId: matchedDriver.schoolId,
                schoolName: matchedDriver.schoolName,
                vehicleId: matchedDriver.vehicleId,
                busNumber: matchedDriver.busNumber,
                amount: interpreted.intent === 'delete_advance' ? currentAdvAmt : nextAmt,
                actualReplacementCost: 0,
                absentDriverDeduction: 0,
                date:
                  interpreted.date && interpreted.date !== todayDate
                    ? interpreted.date
                    : targetAdvance.date,
                reason:
                  interpreted.reason && interpreted.reason !== 'أمر صوتي من المدير'
                    ? interpreted.reason
                    : targetAdvance.reason || '',
                paymentMethod:
                  interpreted.paymentMethod || targetAdvance.paymentMethod || 'cash',
              },
            };

            finalReply =
              interpreted.intent === 'delete_advance'
                ? `جاهز لحذف سلفة ${currentAdvAmt.toLocaleString('ar-EG')} جنيه بتاريخ ${targetAdvance.date} للسائق ${matchedDriver.fullName}. اضغط تأكيد الحذف لإرجاع المبلغ لصافي الراتب.`
                : `جاهز لتعديل سلفة السائق ${matchedDriver.fullName} (بتاريخ ${targetAdvance.date} — كانت ${currentAdvAmt.toLocaleString('ar-EG')} جنيه) إلى ${nextAmt.toLocaleString('ar-EG')} جنيه. يمكنك تعديل أي خانة ثم الضغط على تأكيد.`;
          }
        } else if (
          interpreted.intent === 'edit_coverage' ||
          interpreted.intent === 'delete_coverage'
        ) {
          const driverCoverages = await db
            .select()
            .from(coverageRecords)
            .where(
              and(
                eq(coverageRecords.absentDriverId, matchedDriver.id),
                eq(coverageRecords.isReversed, false)
              )
            )
            .orderBy(desc(coverageRecords.date), desc(coverageRecords.id))
            .limit(12);

          if (driverCoverages.length === 0) {
            requiresConfirmation = false;
            finalReply = `السائق ${matchedDriver.fullName} معندوش أي تغطيات غياب مسجلة حالياً لتعديلها أو حذفها.`;
          } else {
            const targetCoverage =
              (interpreted.targetDate
                ? driverCoverages.find((c) => c.date === interpreted.targetDate)
                : undefined) ||
              (interpreted.oldAmount > 0
                ? driverCoverages.find(
                    (c) => Number(c.absentDriverDeduction) === interpreted.oldAmount
                  )
                : undefined) ||
              driverCoverages[0];

            const driverNameMap: Record<number, string> = {};
            for (const d of allEnrichedDrivers) driverNameMap[d.id] = d.fullName;

            const existingRepName = targetCoverage.replacementDriverId
              ? driverNameMap[targetCoverage.replacementDriverId] || ''
              : targetCoverage.replacementExternalName || '';

            const sal = await recalculateDriverSalary(db, matchedDriver.id, month, year);
            const currentNet = Number(sal.netSalary);
            const oldDeduction = Number(targetCoverage.absentDriverDeduction);
            const nextDeduction =
              interpreted.intent === 'delete_coverage'
                ? 0
                : interpreted.absentDriverDeduction > 0
                ? Number(interpreted.absentDriverDeduction)
                : interpreted.amount > 0
                ? Number(interpreted.amount)
                : oldDeduction;
            const nextCost =
              interpreted.intent === 'delete_coverage'
                ? 0
                : interpreted.actualReplacementCost > 0
                ? Number(interpreted.actualReplacementCost)
                : interpreted.amount > 0
                ? Number(interpreted.amount)
                : Number(targetCoverage.actualReplacementCost);
            const projectedNet = currentNet + oldDeduction - nextDeduction;

            const availableCoverages = driverCoverages.map((c) => ({
              id: c.id,
              date: c.date,
              actualReplacementCost: Number(c.actualReplacementCost),
              absentDriverDeduction: Number(c.absentDriverDeduction),
              reason: c.reason || '',
              replacementName: c.replacementDriverId
                ? driverNameMap[c.replacementDriverId] || '—'
                : c.replacementExternalName || '',
            }));

            queryResult = {
              type: 'pending_confirmation',
              driver: matchedDriver,
              currentNetSalary: currentNet,
              projectedNetSalary: projectedNet,
              availableCoverages,
              payload: {
                intent: interpreted.intent,
                targetRecordId: targetCoverage.id,
                driverId: matchedDriver.id,
                driverCode: matchedDriver.driverCode,
                driverName: matchedDriver.fullName,
                schoolId: matchedDriver.schoolId,
                schoolName: matchedDriver.schoolName,
                vehicleId: matchedDriver.vehicleId,
                busNumber: matchedDriver.busNumber,
                replacementQuery: interpreted.replacementDriverQuery || existingRepName,
                amount: nextDeduction,
                actualReplacementCost:
                  interpreted.intent === 'delete_coverage'
                    ? Number(targetCoverage.actualReplacementCost)
                    : nextCost,
                absentDriverDeduction:
                  interpreted.intent === 'delete_coverage' ? oldDeduction : nextDeduction,
                date:
                  interpreted.date && interpreted.date !== todayDate
                    ? interpreted.date
                    : targetCoverage.date,
                reason:
                  interpreted.reason && interpreted.reason !== 'أمر صوتي من المدير'
                    ? interpreted.reason
                    : targetCoverage.reason || '',
                paymentMethod: 'cash',
              },
            };

            finalReply =
              interpreted.intent === 'delete_coverage'
                ? `جاهز لحذف سجل التغطية بتاريخ ${targetCoverage.date} للسائق ${matchedDriver.fullName} (خصم ${oldDeduction.toLocaleString('ar-EG')} جنيه). اضغط تأكيد للتنفيذ.`
                : `جاهز لتعديل تغطية السائق ${matchedDriver.fullName} بتاريخ ${targetCoverage.date}. راجع تكلفة البديل والخصم واضغط تأكيد للحفظ.`;
          }
        } else if (
          (interpreted.intent === 'record_advance' ||
            interpreted.intent === 'record_bonus' ||
            interpreted.intent === 'record_deduction') &&
          (!interpreted.amount || interpreted.amount <= 0)
        ) {
          requiresConfirmation = false;
          finalReply = `محتاج تحديد المبلغ بالجنيه عشان أجهز العملية للسائق ${matchedDriver.fullName}.`;
        } else {
          const sal = await recalculateDriverSalary(db, matchedDriver.id, month, year);
          const currentNet = Number(sal.netSalary);
          const amt =
            interpreted.intent === 'record_coverage'
              ? Number(interpreted.absentDriverDeduction || 350)
              : Number(interpreted.amount || 0);

          const projectedNet =
            interpreted.intent === 'record_bonus' ? currentNet + amt : currentNet - amt;

          queryResult = {
            type: 'pending_confirmation',
            driver: matchedDriver,
            currentNetSalary: currentNet,
            projectedNetSalary: projectedNet,
            payload: {
              intent: interpreted.intent,
              driverId: matchedDriver.id,
              driverCode: matchedDriver.driverCode,
              driverName: matchedDriver.fullName,
              schoolId: matchedDriver.schoolId,
              schoolName: matchedDriver.schoolName,
              vehicleId: matchedDriver.vehicleId,
              busNumber: matchedDriver.busNumber,
              amount: amt,
              actualReplacementCost:
                interpreted.intent === 'record_coverage'
                  ? Number(interpreted.actualReplacementCost || amt)
                  : 0,
              absentDriverDeduction:
                interpreted.intent === 'record_coverage'
                  ? Number(interpreted.absentDriverDeduction || amt)
                  : 0,
              date: interpreted.date || todayDate,
              reason: interpreted.reason || 'أمر صوتي من المدير',
              paymentMethod: interpreted.paymentMethod || 'cash',
            },
          };

          if (interpreted.intent === 'record_advance') {
            finalReply = `جاهز لتسجيل سلفة بمبلغ ${amt.toLocaleString('ar-EG')} جنيه للسائق ${matchedDriver.fullName} (كود ${matchedDriver.driverCode}). اضغط تأكيد لتنفيذ العملية وتحديث صافي راتبه إلى ${projectedNet.toLocaleString('ar-EG')} جنيه.`;
          } else if (interpreted.intent === 'record_coverage') {
            finalReply = `جاهز لتسجيل تغطية غياب للسائق ${matchedDriver.fullName} (كود ${matchedDriver.driverCode}) بتاريخ ${interpreted.date || todayDate}. راجع قيمة التكلفة والخصم واضغط تأكيد للتنفيذ.`;
          } else if (interpreted.intent === 'record_bonus') {
            finalReply = `جاهز لإضافة مكافأة بمبلغ ${amt.toLocaleString('ar-EG')} جنيه للسائق ${matchedDriver.fullName} (كود ${matchedDriver.driverCode}). اضغط تأكيد للتنفيذ.`;
          } else if (interpreted.intent === 'record_deduction') {
            finalReply = `جاهز لتسجيل خصم بمبلغ ${amt.toLocaleString('ar-EG')} جنيه على السائق ${matchedDriver.fullName} (كود ${matchedDriver.driverCode}). اضغط تأكيد للتنفيذ.`;
          }
        }
      }

      const [logRow] = await db
        .insert(voiceCommandLogs)
        .values({
          adminUserId: req.dbUser!.id,
          rawTranscript: String(transcript),
          parsedIntent: interpreted.intent,
          extractedEntitiesJson: {
            ...interpreted,
            matchedDriverId: matchedDriver?.id || null,
            matchedSchoolId: matchedSchool?.id || null,
          },
          requiresConfirmation,
          wasConfirmed: false,
          executionStatus,
          responseArabic: finalReply,
        })
        .returning();

      res.json({
        logId: logRow.id,
        transcript: String(transcript),
        intent: interpreted.intent,
        requiresConfirmation,
        isAmbiguous: interpreted.isAmbiguous,
        replyArabic: finalReply,
        queryResult,
      });
    } catch (error) {
      console.error('Voice interpret error:', error);
      res.status(500).json({ error: 'تعذر تحليل الأمر الصوتي، حاول مرة أخرى' });
    }
  });

  app.post('/api/voice/confirm', requireAuth, requireAdminOrStaff, requirePermission('*'), async (req: AuthRequest, res) => {
    try {
      const { logId, payload } = req.body;
      if (!payload || !payload.intent || !payload.driverId) {
        return res.status(400).json({ error: 'بيانات التأكيد غير مكتملة' });
      }

      let actionSummary = '';
      const idempKey = logId ? `voice-${logId}` : undefined;

      if (payload.intent === 'record_advance') {
        const result = await recordAdvanceTransaction({
          driverId: Number(payload.driverId),
          amount: Number(payload.amount),
          date: String(payload.date || getTodayDateString()),
          reason: String(payload.reason || 'سلفة بأمر صوتي'),
          paymentMethod: String(payload.paymentMethod || 'cash'),
          notes: 'تم التنفيذ عبر المساعد الصوتي بعد تأكيد المدير',
          recordedByUserId: req.dbUser!.id,
          idempotencyKey: idempKey,
          ipAddress: req.ip || '',
        });
        actionSummary = `تم تنفيذ السلفة بنجاح بمبلغ ${Number(payload.amount).toLocaleString('ar-EG')} جنيه للسائق ${payload.driverName}. صافي الراتب المحدث: ${Number(result.salary?.netSalary || 0).toLocaleString('ar-EG')} جنيه.`;
      } else if (payload.intent === 'record_coverage') {
        const result = await recordCoverageTransaction({
          absentDriverId: Number(payload.driverId),
          replacementDriverId: payload.replacementDriverId ? Number(payload.replacementDriverId) : null,
          replacementExternalName: payload.replacementExternalName || 'سائق تغطية',
          vehicleId: payload.vehicleId ? Number(payload.vehicleId) : null,
          schoolId: payload.schoolId ? Number(payload.schoolId) : null,
          date: String(payload.date || getTodayDateString()),
          actualReplacementCost: Number(payload.actualReplacementCost || 0),
          absentDriverDeduction: Number(payload.absentDriverDeduction || 0),
          reason: String(payload.reason || 'تغطية غياب بأمر صوتي'),
          notes: 'تم التنفيذ عبر المساعد الصوتي بعد تأكيد المدير',
          recordedByUserId: req.dbUser!.id,
          idempotencyKey: idempKey,
          ipAddress: req.ip || '',
        });
        actionSummary = `تم تسجيل تغطية الغياب للسائق ${payload.driverName} وخصم ${Number(payload.absentDriverDeduction).toLocaleString('ar-EG')} جنيه. صافي الراتب المحدث: ${Number(result.salary?.netSalary || 0).toLocaleString('ar-EG')} جنيه.`;
      } else if (payload.intent === 'record_bonus' || payload.intent === 'record_deduction') {
        const d = String(payload.date || getTodayDateString()).split('-');
        const result = await recordAdjustmentTransaction({
          driverId: Number(payload.driverId),
          month: Number(d[1]) || new Date().getMonth() + 1,
          year: Number(d[0]) || new Date().getFullYear(),
          type: payload.intent === 'record_bonus' ? 'bonus' : 'other_deduction',
          amount: Number(payload.amount),
          description: String(payload.reason || 'تسوية بأمر صوتي'),
          recordedByUserId: req.dbUser!.id,
          ipAddress: req.ip || '',
        });
        actionSummary = `تم تسجيل التسوية بنجاح للسائق ${payload.driverName}. صافي الراتب المحدث: ${Number(result.salary.netSalary).toLocaleString('ar-EG')} جنيه.`;
      } else if (payload.intent === 'edit_advance') {
        if (!payload.targetRecordId) {
          return res.status(400).json({ error: 'لم يتم تحديد سجل السلفة المطلوب تعديله' });
        }
        const result = await updateAdvanceTransaction({
          id: Number(payload.targetRecordId),
          amount: Number(payload.amount),
          date: String(payload.date || getTodayDateString()),
          reason: String(payload.reason || ''),
          paymentMethod: String(payload.paymentMethod || 'cash'),
          notes: 'تم التعديل عبر المساعد الصوتي بعد تأكيد المدير',
          recordedByUserId: req.dbUser!.id,
          ipAddress: req.ip || '',
        });
        actionSummary = `تم تعديل السلفة بنجاح إلى ${Number(payload.amount).toLocaleString('ar-EG')} جنيه للسائق ${payload.driverName}. صافي الراتب المحدث: ${Number(result.salary?.netSalary || 0).toLocaleString('ar-EG')} جنيه.`;
      } else if (payload.intent === 'delete_advance') {
        if (!payload.targetRecordId) {
          return res.status(400).json({ error: 'لم يتم تحديد سجل السلفة المطلوب حذفه' });
        }
        const result = await deleteAdvanceTransaction({
          id: Number(payload.targetRecordId),
          recordedByUserId: req.dbUser!.id,
          ipAddress: req.ip || '',
        });
        actionSummary = `تم حذف السلفة بنجاح للسائق ${payload.driverName}. صافي الراتب المحدث: ${Number(result.salary?.netSalary || 0).toLocaleString('ar-EG')} جنيه.`;
      } else if (payload.intent === 'edit_coverage') {
        if (!payload.targetRecordId) {
          return res.status(400).json({ error: 'لم يتم تحديد سجل التغطية المطلوب تعديله' });
        }
        const repText = String(payload.replacementQuery || payload.replacementExternalName || '').trim();
        const resolvedRep = payload.replacementDriverId
          ? await resolveDriverByIdOrQuery({ driverId: payload.replacementDriverId })
          : repText
          ? await resolveDriverByIdOrQuery({ driverQuery: repText })
          : null;

        const result = await updateCoverageTransaction({
          id: Number(payload.targetRecordId),
          replacementDriverId: resolvedRep ? resolvedRep.id : null,
          replacementExternalName: resolvedRep ? '' : repText,
          date: String(payload.date || getTodayDateString()),
          actualReplacementCost: Number(payload.actualReplacementCost || 0),
          absentDriverDeduction: Number(payload.absentDriverDeduction || 0),
          reason: String(payload.reason || ''),
          notes: 'تم التعديل عبر المساعد الصوتي بعد تأكيد المدير',
          recordedByUserId: req.dbUser!.id,
          ipAddress: req.ip || '',
        });
        actionSummary = `تم تعديل سجل التغطية للسائق ${payload.driverName} بنجاح (الخصم ${Number(payload.absentDriverDeduction || 0).toLocaleString('ar-EG')} جنيه). صافي الراتب المحدث: ${Number(result.salary?.netSalary || 0).toLocaleString('ar-EG')} جنيه.`;
      } else if (payload.intent === 'delete_coverage') {
        if (!payload.targetRecordId) {
          return res.status(400).json({ error: 'لم يتم تحديد سجل التغطية المطلوب حذفه' });
        }
        const result = await deleteCoverageTransaction({
          id: Number(payload.targetRecordId),
          recordedByUserId: req.dbUser!.id,
          ipAddress: req.ip || '',
        });
        actionSummary = `تم حذف سجل التغطية بنجاح للسائق ${payload.driverName}. صافي الراتب المحدث: ${Number(result.salary?.netSalary || 0).toLocaleString('ar-EG')} جنيه.`;
      } else {
        return res.status(400).json({ error: 'نوع العملية غير مدعوم للتنفيذ' });
      }

      if (logId) {
        await db
          .update(voiceCommandLogs)
          .set({
            wasConfirmed: true,
            executionStatus: 'executed',
            responseArabic: actionSummary,
          })
          .where(eq(voiceCommandLogs.id, Number(logId)));
      }

      res.json({ ok: true, replyArabic: actionSummary });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'تعذر تنفيذ العملية';
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/voice/speak', requireAuth, requireAdminOrStaff, requirePermission('*'), async (req: AuthRequest, res) => {
    try {
      const { text } = req.body;
      if (!text) return res.status(400).json({ error: 'النص مطلوب' });
      const audioBase64 = await synthesizeArabicSpeech(String(text));
      res.json({ audioBase64, mimeType: 'audio/wav' });
    } catch (error) {
      console.error('Voice TTS error:', error);
      res.status(500).json({ error: 'تعذر توليد الصوت' });
    }
  });

  app.get('/api/voice/logs', requireAuth, requireAdminOrStaff, requirePermission('*'), async (_req: AuthRequest, res) => {
    try {
      const logs = await db
        .select()
        .from(voiceCommandLogs)
        .orderBy(desc(voiceCommandLogs.createdAt))
        .limit(25);
      res.json({ logs });
    } catch (error) {
      console.error('Voice logs error:', error);
      res.status(500).json({ error: 'تعذر تحميل سجل الأوامر الصوتية' });
    }
  });

  // 9. Notifications
  app.get('/api/notifications', requireAuth, async (req: AuthRequest, res) => {
    try {
      if (req.dbUser?.roleSlug === 'driver') {
        if (!req.driverRecord) return res.json({ notifications: [] });
        const rows = await db
          .select()
          .from(notifications)
          .where(eq(notifications.recipientDriverId, req.driverRecord.id))
          .orderBy(desc(notifications.createdAt))
          .limit(30);
        return res.json({ notifications: rows });
      }
      const rows = await db
        .select()
        .from(notifications)
        .orderBy(desc(notifications.createdAt))
        .limit(40);
      res.json({ notifications: rows });
    } catch (error) {
      console.error('Notifications error:', error);
      res.status(500).json({ error: 'تعذر تحميل الإشعارات' });
    }
  });

  app.post('/api/notifications/announcement', requireAuth, requireAdminOrStaff, requirePermission('*'), async (req: AuthRequest, res) => {
    try {
      const { title, body, driverId, driverQuery } = req.body;
      if (!title || !body) return res.status(400).json({ error: 'العنوان ونص الإشعار مطلوبان' });

      const q = String(driverQuery || '').trim();
      if (driverId || q) {
        const target = await resolveDriverByIdOrQuery({ driverId, driverQuery: q });
        if (!target) {
          return res.status(404).json({ error: 'لم يتم العثور على السائق بهذا الاسم أو الكود' });
        }
        const [n] = await db
          .insert(notifications)
          .values({
            recipientDriverId: target.id,
            recipientUserId: target.userId || null,
            type: 'announcement',
            title,
            body,
          })
          .returning();
        return res.status(201).json({ notification: n });
      } else {
        const allDrivers = await db.select().from(drivers).where(eq(drivers.accountStatus, 'active'));
        if (allDrivers.length > 0) {
          await db.insert(notifications).values(
            allDrivers.map((d) => ({
              recipientDriverId: d.id,
              recipientUserId: d.userId || null,
              type: 'announcement',
              title,
              body,
            }))
          );
        }
        return res.status(201).json({ ok: true, count: allDrivers.length });
      }
    } catch (error) {
      console.error('Announcement error:', error);
      res.status(500).json({ error: 'تعذر إرسال الإشعار' });
    }
  });

  app.patch('/api/notifications/:id/read', requireAuth, async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      if (req.dbUser?.roleSlug === 'driver') {
        if (!req.driverRecord) {
          return res.status(403).json({ error: 'غير مصرح لك بتعديل هذا الإشعار' });
        }
        const updated = await db
          .update(notifications)
          .set({ isRead: true })
          .where(and(eq(notifications.id, id), eq(notifications.recipientDriverId, req.driverRecord.id)))
          .returning();
        if (updated.length === 0) {
          return res.status(404).json({ error: 'الإشعار غير موجود أو غير مخصص لك' });
        }
      } else {
        await db.update(notifications).set({ isRead: true }).where(eq(notifications.id, id));
      }
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: 'تعذر تحديث الإشعار' });
    }
  });

  // 10. Users, Roles & Audit Logs
  app.get('/api/users', requireAuth, requireAdminOrStaff, requirePermission('*'), async (_req: AuthRequest, res) => {
    try {
      const allUsers = await db.select().from(users).orderBy(users.id);
      const allRoles = await db.select().from(userRoles);
      const roleById: Record<number, typeof userRoles.$inferSelect> = {};
      for (const r of allRoles) roleById[r.id] = r;

      res.json({
        users: allUsers.map((u) => ({
          ...u,
          roleSlug: roleById[u.roleId]?.slug || 'driver',
          roleNameAr: roleById[u.roleId]?.nameAr || 'سائق',
        })),
        roles: allRoles,
      });
    } catch (error) {
      res.status(500).json({ error: 'تعذر تحميل المستخدمين' });
    }
  });

  app.patch('/api/users/:id/role', requireAuth, requireAdminOrStaff, requirePermission('*'), async (req: AuthRequest, res) => {
    try {
      if (req.dbUser?.roleSlug !== 'super_admin') {
        return res.status(403).json({ error: 'تعديل الصلاحيات متاح للمدير العام فقط' });
      }
      const userId = Number(req.params.id);
      const { roleId, isActive } = req.body;
      const [updated] = await db
        .update(users)
        .set({
          roleId: roleId ? Number(roleId) : undefined,
          isActive: isActive !== undefined ? Boolean(isActive) : undefined,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId))
        .returning();
      if (!updated) {
        return res.status(404).json({ error: 'المستخدم غير موجود' });
      }
      res.json({ user: updated });
    } catch (error) {
      res.status(500).json({ error: 'تعذر تحديث صلاحية المستخدم' });
    }
  });

  app.get('/api/audit-logs', requireAuth, requireAdminOrStaff, requirePermission('*'), async (_req: AuthRequest, res) => {
    try {
      const logs = await db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(60);
      res.json({ logs });
    } catch (error) {
      res.status(500).json({ error: 'تعذر تحميل سجل التدقيق' });
    }
  });

  // 11. Reports Summary
  app.get('/api/reports/summary', requireAuth, requireAdminOrStaff, requirePermission('reports:read'), async (req: AuthRequest, res) => {
    try {
      const activePeriod = await getActiveBillingPeriod();
      const month = Number(req.query.month) || activePeriod.month;
      const year = Number(req.query.year) || activePeriod.year;
      const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;

      const [closingRow] = await db
        .select({ id: monthlyClosings.id })
        .from(monthlyClosings)
        .where(and(eq(monthlyClosings.month, month), eq(monthlyClosings.year, year)))
        .limit(1);

      const allDrivers = await getEnrichedDrivers();
      const activeDrivers = allDrivers.filter((d) => d.accountStatus === 'active');
      if (!closingRow) {
        for (const d of activeDrivers) {
          await recalculateDriverSalary(db, d.id, month, year);
        }
      }

      const [
        rawMonthSalaries,
        monthAdvances,
        monthCoverages,
        monthAttendance,
        allSchools,
        fleet,
      ] = await Promise.all([
        db
          .select()
          .from(salaries)
          .where(and(eq(salaries.month, month), eq(salaries.year, year))),
        db
          .select()
          .from(advances)
          .where(and(eq(advances.isReversed, false), sql`${advances.date} LIKE ${monthPrefix + '%'}`)),
        db
          .select()
          .from(coverageRecords)
          .where(and(eq(coverageRecords.isReversed, false), sql`${coverageRecords.date} LIKE ${monthPrefix + '%'}`)),
        db
          .select()
          .from(attendance)
          .where(sql`${attendance.date} LIKE ${monthPrefix + '%'}`),
        db.select().from(schools),
        getFleetWithLatestGps(),
      ]);

      const activeIds = new Set(activeDrivers.map((d) => d.id));
      const monthSalaries = closingRow
        ? rawMonthSalaries
        : rawMonthSalaries.filter((s) => activeIds.has(s.driverId));
      const reportDriverIds = new Set(monthSalaries.map((s) => s.driverId));
      const enrichedDrivers = closingRow
        ? allDrivers.filter((d) => reportDriverIds.has(d.id) || d.accountStatus === 'active')
        : activeDrivers;

      res.json({
        period: { month, year },
        drivers: enrichedDrivers,
        salaries: monthSalaries,
        advances: monthAdvances,
        coverages: monthCoverages,
        attendance: monthAttendance,
        schools: allSchools,
        fleet,
      });
    } catch (error) {
      console.error('Reports error:', error);
      res.status(500).json({ error: 'تعذر إنشاء التقرير' });
    }
  });

  // 12. Driver Mobile App Endpoints (Strict Data Isolation!)
  app.get('/api/driver-app/me', requireAuth, async (req: AuthRequest, res) => {
    try {
      const activePeriod = await getActiveBillingPeriod();
      const month = Number(req.query.month) || activePeriod.month;
      const year = Number(req.query.year) || activePeriod.year;

      // Security: Driver role is ALWAYS locked to their own authenticated driverRecord.
      // Super admin may pass ?asDriverId= to inspect/preview a specific driver's mobile experience.
      if (req.dbUser?.roleSlug !== 'driver' && req.dbUser?.roleSlug !== 'super_admin') {
        return res.status(403).json({ error: 'هذا المسار مخصص لحسابات السائقين والمدير العام فقط' });
      }

      let targetDriverId: number | null = req.driverRecord?.id || null;
      if (req.dbUser?.roleSlug === 'super_admin' && req.query.asDriverId) {
        targetDriverId = Number(req.query.asDriverId);
      }

      if (!targetDriverId) {
        return res.json({ linked: false, driver: null });
      }

      const enrichedDrivers = await getEnrichedDrivers();
      const driver = enrichedDrivers.find((d) => d.id === targetDriverId);
      if (!driver) return res.json({ linked: false, driver: null });

      const salary = await getOrRecalculateDriverSalaryForRead(db, driver.id, month, year);
      const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;

      const [driverAdvances, driverCoverages, transactions, driverNotifications, vehicleGpsData] =
        await Promise.all([
          db
            .select()
            .from(advances)
            .where(and(eq(advances.driverId, driver.id), sql`${advances.date} LIKE ${monthPrefix + '%'}`))
            .orderBy(desc(advances.date)),
          db
            .select()
            .from(coverageRecords)
            .where(
              and(
                eq(coverageRecords.absentDriverId, driver.id),
                sql`${coverageRecords.date} LIKE ${monthPrefix + '%'}`
              )
            )
            .orderBy(desc(coverageRecords.date)),
          db
            .select()
            .from(financialTransactions)
            .where(
              and(
                eq(financialTransactions.driverId, driver.id),
                eq(financialTransactions.month, month),
                eq(financialTransactions.year, year)
              )
            )
            .orderBy(desc(financialTransactions.createdAt)),
          db
            .select()
            .from(notifications)
            .where(eq(notifications.recipientDriverId, driver.id))
            .orderBy(desc(notifications.createdAt))
            .limit(20),
          driver.vehicleId
            ? Promise.all([
                db.select().from(vehicles).where(eq(vehicles.id, driver.vehicleId)).limit(1),
                db
                  .select()
                  .from(gpsLocations)
                  .where(eq(gpsLocations.vehicleId, driver.vehicleId))
                  .orderBy(desc(gpsLocations.recordedAt))
                  .limit(1),
              ])
            : Promise.resolve(null),
        ]);

      let latestGps = null;
      let vehicleGpsStatus = 'offline';
      if (vehicleGpsData) {
        const [[veh], [g]] = vehicleGpsData;
        vehicleGpsStatus = veh?.gpsStatus || 'offline';
        if (g) {
          latestGps = {
            ...g,
            isLive: vehicleGpsStatus !== 'paused' && isGpsFresh(g.recordedAt, g.isLive),
          };
        }
      }

      res.json({
        linked: true,
        period: { month, year },
        driver,
        salary: {
          ...salary,
          baseSalary: Number(salary.baseSalary),
          totalAdvances: Number(salary.totalAdvances),
          totalCoverageDeductions: Number(salary.totalCoverageDeductions),
          otherDeductions: Number(salary.otherDeductions),
          bonuses: Number(salary.bonuses),
          netSalary: Number(salary.netSalary),
        },
        advances: driverAdvances.map((a) => ({ ...a, amount: Number(a.amount) })),
        coverages: driverCoverages.map((c) => ({
          ...c,
          actualReplacementCost:
            req.dbUser?.roleSlug === 'driver' ? 0 : Number(c.actualReplacementCost),
          absentDriverDeduction: Number(c.absentDriverDeduction),
        })),
        transactions: transactions.map((t) => ({ ...t, amount: Number(t.amount) })),
        notifications: driverNotifications,
        gps: {
          vehicleGpsStatus,
          latestGps,
        },
      });
    } catch (error) {
      console.error('Driver app me error:', error);
      res.status(500).json({ error: 'تعذر تحميل بيانات السائق' });
    }
  });

  app.post('/api/driver-app/gps-pause', requireAuth, async (req: AuthRequest, res) => {
    try {
      if (req.dbUser?.roleSlug !== 'driver' && req.dbUser?.roleSlug !== 'super_admin') {
        return res.status(403).json({ error: 'غير مصرح لك بتعديل حالة التتبع للسائق' });
      }
      const { paused, driverId } = req.body;
      let targetDriverId = req.driverRecord?.id || null;
      if (req.dbUser?.roleSlug === 'super_admin' && driverId) {
        targetDriverId = Number(driverId);
      }
      if (!targetDriverId) {
        return res.status(403).json({ error: 'حساب السائق غير مرتبط' });
      }
      const [assign] = await db
        .select()
        .from(driverAssignments)
        .where(and(eq(driverAssignments.driverId, targetDriverId), eq(driverAssignments.isCurrent, true)))
        .limit(1);
      if (!assign || !assign.vehicleId) return res.status(400).json({ error: 'لا توجد مركبة معينة' });

      const newStatus = paused ? 'paused' : 'online';
      await db.update(vehicles).set({ gpsStatus: newStatus }).where(eq(vehicles.id, assign.vehicleId));

      if (paused) {
        const [drv] = await db.select().from(drivers).where(eq(drivers.id, targetDriverId)).limit(1);
        await db.insert(notifications).values({
          targetRole: 'super_admin',
          type: 'gps_alert',
          title: 'إيقاف مشاركة الموقع من السائق',
          body: `قام السائق ${drv?.fullName || ''} بإيقاف مشاركة الموقع مؤقتاً.`,
        });
      }

      res.json({ ok: true, gpsStatus: newStatus });
    } catch (error) {
      res.status(500).json({ error: 'تعذر تحديث حالة مشاركة الموقع' });
    }
  });

  // Admin quick update for driver license photos
  app.put(
    '/api/drivers/:id/licenses',
    requireAuth,
    requireAdminOrStaff,
    requirePermission('drivers:write'),
    async (req: AuthRequest, res) => {
      try {
        const driverId = Number(req.params.id);
        const [existing] = await db.select().from(drivers).where(eq(drivers.id, driverId)).limit(1);
        if (!existing) return res.status(404).json({ error: 'السائق غير موجود' });

        let nextPhotos: DriverLicensePhoto[];
        try {
          nextPhotos = sanitizeLicensePhotos(req.body?.licensePhotos, 'admin');
        } catch (err: unknown) {
          return res.status(400).json({
            error: err instanceof Error ? err.message : 'بيانات صور الرخص غير صالحة',
          });
        }

        const [updated] = await db
          .update(drivers)
          .set({ licensePhotosJson: nextPhotos })
          .where(eq(drivers.id, driverId))
          .returning();

        await db.insert(auditLogs).values({
          actorUserId: req.dbUser!.id,
          action: 'ADMIN_UPDATE_DRIVER_LICENSES',
          entityType: 'drivers',
          entityId: String(driverId),
          afterJson: { count: nextPhotos.length },
          ipAddress: req.ip || '',
        });

        res.json({ ok: true, licensePhotos: updated.licensePhotosJson });
      } catch (error) {
        console.error('Admin license update error:', error);
        res.status(500).json({ error: 'تعذر حفظ صور الرخص' });
      }
    }
  );

  // Driver (or Super Admin previewing) self-service license photo upload/update
  app.put('/api/driver-app/licenses', requireAuth, async (req: AuthRequest, res) => {
    try {
      if (req.dbUser?.roleSlug !== 'driver' && req.dbUser?.roleSlug !== 'super_admin') {
        return res.status(403).json({ error: 'غير مصرح لك بتعديل صور الرخص' });
      }

      const isAdminActor = req.dbUser?.roleSlug === 'super_admin';
      let targetDriverId: number | null = req.driverRecord?.id || null;
      if (isAdminActor && req.body?.driverId) {
        targetDriverId = Number(req.body.driverId);
      }
      if (!targetDriverId) {
        return res.status(403).json({ error: 'حساب السائق غير مرتبط بملف' });
      }

      const defaultUploader: 'admin' | 'driver' = isAdminActor ? 'admin' : 'driver';
      let nextPhotos: DriverLicensePhoto[];
      try {
        nextPhotos = sanitizeLicensePhotos(req.body?.licensePhotos, defaultUploader);
      } catch (err: unknown) {
        return res.status(400).json({
          error: err instanceof Error ? err.message : 'بيانات صور الرخص غير صالحة',
        });
      }

      const result = await runWithRlsContext({ role: 'system', driverId: targetDriverId }, async () => {
        const [existing] = await db
          .select()
          .from(drivers)
          .where(eq(drivers.id, targetDriverId))
          .limit(1);
        if (!existing) return null;

        const prevCount = Array.isArray(existing.licensePhotosJson)
          ? existing.licensePhotosJson.length
          : 0;

        const [updated] = await db
          .update(drivers)
          .set({ licensePhotosJson: nextPhotos })
          .where(eq(drivers.id, targetDriverId))
          .returning();

        await db.insert(auditLogs).values({
          actorUserId: req.dbUser!.id,
          action: isAdminActor ? 'ADMIN_PREVIEW_UPDATE_LICENSES' : 'DRIVER_UPDATE_LICENSES',
          entityType: 'drivers',
          entityId: String(targetDriverId),
          afterJson: { count: nextPhotos.length },
          ipAddress: req.ip || '',
        });

        if (!isAdminActor && nextPhotos.length > prevCount) {
          await db.insert(notifications).values({
            targetRole: 'super_admin',
            type: 'driver_document',
            title: 'تم رفع صور رخصة جديدة',
            body: `قام السائق ${existing.fullName} (كود ${existing.driverCode}) برفع صورة رخصة في ملفه (${nextPhotos.length} صورة محفوظة).`,
          });
        }

        return updated;
      });

      if (!result) {
        return res.status(404).json({ error: 'ملف السائق غير موجود' });
      }

      res.json({ ok: true, licensePhotos: result.licensePhotosJson });
    } catch (error) {
      console.error('Driver license update error:', error);
      res.status(500).json({ error: 'تعذر حفظ صور الرخص' });
    }
  });

  // 13. Supervisors Management (Admin) & Dedicated Supervisor App (Strictly Non-Financial!)
  async function getEnrichedSupervisors() {
    const todayDate = getTodayDateString();
    const [
      allSups,
      allSchools,
      allVehicles,
      allRoutes,
      currentAssignments,
      allDrivers,
      todayTrips,
    ] = await Promise.all([
      db.select().from(supervisors).orderBy(supervisors.supervisorCode),
      db
        .select({
          id: schools.id,
          name: schools.name,
          address: schools.address,
          lat: schools.lat,
          lng: schools.lng,
          contactName: schools.contactName,
          contactPhone: schools.contactPhone,
        })
        .from(schools),
      db
        .select({
          id: vehicles.id,
          busNumber: vehicles.busNumber,
          registrationNumber: vehicles.registrationNumber,
          vehicleType: vehicles.vehicleType,
          operationalStatus: vehicles.operationalStatus,
          gpsStatus: vehicles.gpsStatus,
        })
        .from(vehicles),
      db.select().from(routes),
      db.select().from(driverAssignments).where(eq(driverAssignments.isCurrent, true)),
      db
        .select({
          id: drivers.id,
          fullName: drivers.fullName,
          phone: drivers.phone,
          accountStatus: drivers.accountStatus,
        })
        .from(drivers),
      db.select().from(supervisorTrips).where(eq(supervisorTrips.tripDate, todayDate)),
    ]);

    const schoolById: Record<number, (typeof allSchools)[number]> = {};
    for (const s of allSchools) schoolById[s.id] = s;

    const vehicleById: Record<number, (typeof allVehicles)[number]> = {};
    for (const v of allVehicles) vehicleById[v.id] = v;

    const routeById: Record<number, (typeof allRoutes)[number]> = {};
    for (const r of allRoutes) routeById[r.id] = r;

    const driverById: Record<number, (typeof allDrivers)[number]> = {};
    for (const d of allDrivers) driverById[d.id] = d;

    const assignByVehicle: Record<number, (typeof currentAssignments)[number]> = {};
    for (const a of currentAssignments) {
      if (a.vehicleId) assignByVehicle[a.vehicleId] = a;
    }

    const tripBySupervisor: Record<number, (typeof todayTrips)[number]> = {};
    for (const t of todayTrips) {
      tripBySupervisor[t.supervisorId] = t;
    }

    return allSups.map((sup) => {
      const school = sup.schoolId ? schoolById[sup.schoolId] : undefined;
      const vehicle = sup.vehicleId ? vehicleById[sup.vehicleId] : undefined;
      const route = sup.routeId ? routeById[sup.routeId] : undefined;
      const assign = sup.vehicleId ? assignByVehicle[sup.vehicleId] : undefined;
      const drv =
        assign && driverById[assign.driverId]?.accountStatus === 'active'
          ? driverById[assign.driverId]
          : undefined;
      const trip = tripBySupervisor[sup.id];
      const hasLiveCoords =
        sup.liveLat !== null &&
        sup.liveLat !== undefined &&
        sup.liveLng !== null &&
        sup.liveLng !== undefined;
      const supLive = hasLiveCoords
        ? {
            lat: sup.liveLat!,
            lng: sup.liveLng!,
            speedKmh: Math.round(Number(sup.liveSpeedKmh || 0)),
            accuracyMeters: sup.liveAccuracyMeters ?? null,
            recordedAt: sup.liveUpdatedAt ? sup.liveUpdatedAt.toISOString() : '',
            isLive: isGpsFresh(sup.liveUpdatedAt, true),
          }
        : null;

      return {
        id: sup.id,
        userId: sup.userId,
        linkedEmail: sup.linkedEmail || '',
        supervisorCode: sup.supervisorCode,
        fullName: sup.fullName,
        phone: sup.phone,
        photoUrl: sup.photoUrl || '',
        schoolId: sup.schoolId,
        schoolName: school?.name || 'غير معينة',
        schoolAddress: school?.address || '',
        schoolLat: school?.lat ?? null,
        schoolLng: school?.lng ?? null,
        vehicleId: sup.vehicleId,
        busNumber: vehicle?.busNumber || '—',
        registrationNumber: vehicle?.registrationNumber || '—',
        routeId: sup.routeId,
        routeName: route?.name || 'غير محدد',
        pickupArea: route?.pickupArea || '',
        dropoffArea: route?.dropoffArea || '',
        pickupTime: route?.pickupTime || '',
        dropoffTime: route?.dropoffTime || '',
        estimatedDistanceKm: route?.estimatedDistanceKm ?? null,
        assignedDriverName: drv?.fullName || 'غير معين',
        assignedDriverPhone: drv?.phone || '',
        accountStatus: sup.accountStatus,
        notes: sup.notes || '',
        liveLocation: supLive,
        todayTrip: trip
          ? {
              tripDate: trip.tripDate,
              morningStartedAt: trip.morningStartedAt ? trip.morningStartedAt.toISOString() : null,
              morningLat: trip.morningLat ?? null,
              morningLng: trip.morningLng ?? null,
              eveningEndedAt: trip.eveningEndedAt ? trip.eveningEndedAt.toISOString() : null,
              eveningLat: trip.eveningLat ?? null,
              eveningLng: trip.eveningLng ?? null,
            }
          : null,
        createdAt: sup.createdAt,
      };
    });
  }

  app.get(
    '/api/supervisors',
    requireAuth,
    requireAdminOrStaff,
    requireAnyPermission(['drivers:read', 'gps:read']),
    async (_req: AuthRequest, res) => {
      try {
        const list = await getEnrichedSupervisors();
        res.json({ supervisors: list });
      } catch (error) {
        console.error('Get supervisors error:', error);
        res.status(500).json({ error: 'تعذر تحميل قائمة المشرفات' });
      }
    }
  );

  function extractDatabaseErrorInfo(error: unknown): {
    code?: string;
    constraint?: string;
    detail?: string;
    message: string;
  } {
    const errObj = (error && typeof error === 'object' ? error : {}) as {
      code?: unknown;
      constraint?: unknown;
      detail?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const cause = (
      errObj.cause && typeof errObj.cause === 'object' ? errObj.cause : {}
    ) as {
      code?: unknown;
      constraint?: unknown;
      detail?: unknown;
      message?: unknown;
    };
    const code =
      typeof cause.code === 'string'
        ? cause.code
        : typeof errObj.code === 'string'
        ? errObj.code
        : undefined;
    const constraint =
      typeof cause.constraint === 'string'
        ? cause.constraint
        : typeof errObj.constraint === 'string'
        ? errObj.constraint
        : undefined;
    const detail =
      typeof cause.detail === 'string'
        ? cause.detail
        : typeof errObj.detail === 'string'
        ? errObj.detail
        : undefined;
    const message =
      typeof cause.message === 'string'
        ? cause.message
        : typeof errObj.message === 'string'
        ? errObj.message
        : String(error || 'Unknown database error');
    return { code, constraint, detail, message };
  }

  app.post(
    '/api/supervisors',
    requireAuth,
    requireAdminOrStaff,
    async (req: AuthRequest, res) => {
      try {
        const {
          supervisorCode,
          fullName,
          phone,
          photoUrl,
          linkedEmail,
          schoolId,
          schoolName,
          vehicleId,
          busNumber,
          routeId,
          routeName,
          pickupArea,
          dropoffArea,
          pickupTime,
          dropoffTime,
          accountStatus,
          notes,
        } = req.body ?? {};

        const cleanCode = normalizeDriverCode(supervisorCode);
        const cleanName = String(fullName ?? '').trim();
        const rawPhone = normalizeArabicDigits(String(phone ?? '')).trim();
        const cleanPhone = normalizeEgyptPhone(rawPhone) || rawPhone;

        if (!cleanCode || !cleanName || !cleanPhone) {
          return res
            .status(400)
            .json({ error: 'كود المشرفة والاسم الكامل ورقم الموبايل حقول إلزامية' });
        }

        let safePhotoUrl = '';
        if (photoUrl !== undefined && photoUrl !== null && String(photoUrl).trim() !== '') {
          try {
            safePhotoUrl = sanitizeDriverPhotoUrl(photoUrl);
          } catch (err: unknown) {
            return res.status(400).json({
              error: err instanceof Error ? err.message : 'صورة المشرفة غير صالحة',
            });
          }
        }

        const created = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
          const existingSups = await db
            .select({
              id: supervisors.id,
              supervisorCode: supervisors.supervisorCode,
              fullName: supervisors.fullName,
            })
            .from(supervisors);
          const duplicateSup = existingSups.find(
            (s) => s.supervisorCode.trim().toLowerCase() === cleanCode.toLowerCase()
          );
          if (duplicateSup) {
            throw new Error(`DUPLICATE_CODE:${duplicateSup.fullName}`);
          }

          const cleanRouteNameInput = String(routeName ?? '').trim();
          const safeRouteName = PLACEHOLDER_ASSIGNMENTS.has(cleanRouteNameInput)
            ? ''
            : cleanRouteNameInput;
          const cleanPickupArea = String(pickupArea ?? '').trim();
          const cleanDropoffArea = String(dropoffArea ?? '').trim();
          const cleanPickupTime = normalizeArabicDigits(String(pickupTime ?? '')).trim();
          const cleanDropoffTime = normalizeArabicDigits(String(dropoffTime ?? '')).trim();
          const cleanSchoolName = String(schoolName ?? '').trim();
          const safeSchoolName = PLACEHOLDER_ASSIGNMENTS.has(cleanSchoolName) ? '' : cleanSchoolName;

          const hasTripDetails = Boolean(
            cleanPickupArea || cleanDropoffArea || cleanPickupTime || cleanDropoffTime
          );
          const effectiveRouteName =
            safeRouteName ||
            (hasTripDetails
              ? cleanPickupArea && (cleanDropoffArea || safeSchoolName)
                ? `${cleanPickupArea} - ${cleanDropoffArea || safeSchoolName}`
                : cleanPickupArea || `خط ${cleanName}`
              : '');

          return await db.transaction(async (tx) => {
            const resolvedSchoolId = await resolveSchoolIdForDriver(tx, {
              schoolId,
              schoolName: safeSchoolName,
            });
            const resolvedVehicleId = await resolveVehicleIdForDriver(tx, { vehicleId, busNumber });
            const resolvedRouteId = await resolveRouteIdForDriver(tx, {
              schoolId: resolvedSchoolId,
              routeId,
              routeName: effectiveRouteName || undefined,
              pickupArea: cleanPickupArea,
              pickupTime: cleanPickupTime,
              dropoffTime: cleanDropoffTime,
            });

            if (resolvedRouteId && hasTripDetails) {
              const [curRoute] = await tx
                .select()
                .from(routes)
                .where(eq(routes.id, resolvedRouteId))
                .limit(1);
              if (curRoute) {
                await tx
                  .update(routes)
                  .set({
                    pickupArea: cleanPickupArea || curRoute.pickupArea,
                    dropoffArea: cleanDropoffArea || curRoute.dropoffArea,
                    pickupTime: cleanPickupTime || curRoute.pickupTime,
                    dropoffTime: cleanDropoffTime || curRoute.dropoffTime,
                  })
                  .where(eq(routes.id, resolvedRouteId));
              }
            }

            const [row] = await tx
              .insert(supervisors)
              .values({
                supervisorCode: cleanCode,
                fullName: cleanName,
                phone: cleanPhone,
                photoUrl: safePhotoUrl,
                linkedEmail: String(linkedEmail ?? '').trim().toLowerCase(),
                schoolId: resolvedSchoolId,
                vehicleId: resolvedVehicleId,
                routeId: resolvedRouteId,
                accountStatus: accountStatus === 'inactive' ? 'inactive' : 'active',
                notes: String(notes ?? '').trim(),
              })
              .returning();

            if (req.dbUser?.id) {
              await tx.insert(auditLogs).values({
                actorUserId: req.dbUser.id,
                action: 'CREATE_SUPERVISOR',
                entityType: 'supervisors',
                entityId: String(row.id),
                afterJson: { supervisorCode: row.supervisorCode, fullName: row.fullName },
                ipAddress: req.ip || '',
              });
            }

            return row;
          });
        });

        const enriched = (await getEnrichedSupervisors()).find((s) => s.id === created.id);
        res.status(201).json({ supervisor: enriched || created });
      } catch (error: unknown) {
        console.error('Create supervisor error:', error);
        const errStr = error instanceof Error ? error.message : String(error);
        if (errStr.startsWith('DUPLICATE_CODE:')) {
          const supName = errStr.split(':')[1] || '';
          return res.status(409).json({
            error: `كود المشرفة مسجل بالفعل للمشرفة (${supName})`,
          });
        }
        const pgInfo = extractDatabaseErrorInfo(error);
        const lowerMsg = pgInfo.message.toLowerCase();

        if (pgInfo.code === '23505' || lowerMsg.includes('unique')) {
          return res.status(409).json({
            error: 'كود المشرفة أو رقم الباص مسجل بالفعل لبيان آخر',
            details: pgInfo.detail || pgInfo.message,
          });
        }

        res.status(500).json({
          error: `تعذر إضافة المشرفة: ${pgInfo.message}`,
          details: pgInfo.detail || pgInfo.message,
        });
      }
    }
  );

  app.patch(
    '/api/supervisors/:id',
    requireAuth,
    requireAdminOrStaff,
    async (req: AuthRequest, res) => {
      try {
        const id = Number(req.params.id);
        const {
          supervisorCode,
          fullName,
          phone,
          photoUrl,
          linkedEmail,
          schoolId,
          schoolName,
          vehicleId,
          busNumber,
          routeId,
          routeName,
          pickupArea,
          dropoffArea,
          pickupTime,
          dropoffTime,
          accountStatus,
          notes,
        } = req.body ?? {};

        const updated = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
          const [existing] = await db
            .select()
            .from(supervisors)
            .where(eq(supervisors.id, id))
            .limit(1);
          if (!existing) {
            throw new Error('SUPERVISOR_NOT_FOUND');
          }

          const nextCode =
            supervisorCode !== undefined
              ? normalizeDriverCode(supervisorCode) || existing.supervisorCode
              : existing.supervisorCode;
          const nextName =
            fullName !== undefined ? String(fullName ?? '').trim() : existing.fullName;
          const rawPhone =
            phone !== undefined ? normalizeArabicDigits(String(phone ?? '')).trim() : existing.phone;
          const nextPhone = normalizeEgyptPhone(rawPhone) || rawPhone;

          if (!nextCode || !nextName || !nextPhone) {
            throw new Error('INVALID_FIELDS:كود المشرفة والاسم الكامل ورقم الموبايل حقول إلزامية');
          }

          let nextPhotoUrl = existing.photoUrl || '';
          if (photoUrl !== undefined) {
            try {
              nextPhotoUrl = sanitizeDriverPhotoUrl(photoUrl);
            } catch (err: unknown) {
              throw new Error(`INVALID_PHOTO:${err instanceof Error ? err.message : 'صورة غير صالحة'}`);
            }
          }

          if (nextCode.toLowerCase() !== existing.supervisorCode.toLowerCase()) {
            const [dupSup] = await db
              .select({ id: supervisors.id })
              .from(supervisors)
              .where(
                and(
                  ne(supervisors.id, id),
                  sql`LOWER(TRIM(${supervisors.supervisorCode})) = LOWER(${nextCode})`
                )
              )
              .limit(1);
            if (dupSup) {
              throw new Error(`DUPLICATE_CODE:${nextCode}`);
            }
          }

          const cleanRouteNameInput = routeName !== undefined ? String(routeName ?? '').trim() : undefined;
          const safeRouteName =
            cleanRouteNameInput !== undefined && PLACEHOLDER_ASSIGNMENTS.has(cleanRouteNameInput)
              ? ''
              : cleanRouteNameInput;
          const cleanPickupArea =
            pickupArea !== undefined ? String(pickupArea ?? '').trim() : undefined;
          const cleanDropoffArea =
            dropoffArea !== undefined ? String(dropoffArea ?? '').trim() : undefined;
          const cleanPickupTime =
            pickupTime !== undefined ? normalizeArabicDigits(String(pickupTime ?? '')).trim() : undefined;
          const cleanDropoffTime =
            dropoffTime !== undefined
              ? normalizeArabicDigits(String(dropoffTime ?? '')).trim()
              : undefined;

          await db.transaction(async (tx) => {
            const nextSchoolId =
              schoolName !== undefined || schoolId !== undefined
                ? await resolveSchoolIdForDriver(tx, { schoolId, schoolName })
                : existing.schoolId;
            const nextVehicleId =
              busNumber !== undefined || vehicleId !== undefined
                ? await resolveVehicleIdForDriver(tx, { vehicleId, busNumber })
                : existing.vehicleId;

            const hasTripUpdate = Boolean(
              cleanPickupArea || cleanDropoffArea || cleanPickupTime || cleanDropoffTime
            );
            const effectiveRouteName =
              safeRouteName !== undefined
                ? safeRouteName ||
                  (hasTripUpdate
                    ? cleanPickupArea && cleanDropoffArea
                      ? `${cleanPickupArea} - ${cleanDropoffArea}`
                      : cleanPickupArea || `خط ${nextName}`
                    : '')
                : undefined;

            const nextRouteId =
              effectiveRouteName !== undefined || routeId !== undefined
                ? await resolveRouteIdForDriver(tx, {
                    schoolId: nextSchoolId,
                    routeId,
                    routeName: effectiveRouteName,
                    pickupArea: cleanPickupArea,
                    pickupTime: cleanPickupTime,
                    dropoffTime: cleanDropoffTime,
                  })
                : existing.routeId;

            if (
              nextRouteId &&
              (cleanPickupArea !== undefined ||
                cleanDropoffArea !== undefined ||
                cleanPickupTime !== undefined ||
                cleanDropoffTime !== undefined)
            ) {
              const [curRoute] = await tx
                .select()
                .from(routes)
                .where(eq(routes.id, nextRouteId))
                .limit(1);
              if (curRoute) {
                await tx
                  .update(routes)
                  .set({
                    pickupArea: cleanPickupArea !== undefined ? cleanPickupArea : curRoute.pickupArea,
                    dropoffArea:
                      cleanDropoffArea !== undefined ? cleanDropoffArea : curRoute.dropoffArea,
                    pickupTime: cleanPickupTime !== undefined ? cleanPickupTime : curRoute.pickupTime,
                    dropoffTime:
                      cleanDropoffTime !== undefined ? cleanDropoffTime : curRoute.dropoffTime,
                  })
                  .where(eq(routes.id, nextRouteId));
              }
            }

            await tx
              .update(supervisors)
              .set({
                supervisorCode: nextCode,
                fullName: nextName,
                phone: nextPhone,
                photoUrl: nextPhotoUrl,
                linkedEmail:
                  linkedEmail !== undefined
                    ? String(linkedEmail ?? '').trim().toLowerCase()
                    : existing.linkedEmail,
                schoolId: nextSchoolId,
                vehicleId: nextVehicleId,
                routeId: nextRouteId,
                accountStatus:
                  accountStatus === 'inactive' || accountStatus === 'active'
                    ? accountStatus
                    : existing.accountStatus,
                notes: notes !== undefined ? String(notes ?? '').trim() : existing.notes,
                updatedAt: new Date(),
              })
              .where(eq(supervisors.id, id));

            await tx.insert(auditLogs).values({
              actorUserId: req.dbUser!.id,
              action: 'UPDATE_SUPERVISOR',
              entityType: 'supervisors',
              entityId: String(id),
              beforeJson: {
                supervisorCode: existing.supervisorCode,
                fullName: existing.fullName,
                accountStatus: existing.accountStatus,
              },
              afterJson: {
                supervisorCode: nextCode,
                fullName: nextName,
                accountStatus:
                  accountStatus === 'inactive' || accountStatus === 'active'
                    ? accountStatus
                    : existing.accountStatus,
              },
              ipAddress: req.ip || '',
            });
          });

          return (await getEnrichedSupervisors()).find((s) => s.id === id);
        });

        res.json({ supervisor: updated });
      } catch (error: unknown) {
        console.error('Update supervisor error:', error);
        const errStr = error instanceof Error ? error.message : String(error);
        if (errStr === 'SUPERVISOR_NOT_FOUND') {
          return res.status(404).json({ error: 'المشرفة غير موجودة' });
        }
        if (errStr.startsWith('INVALID_FIELDS:')) {
          return res.status(400).json({ error: errStr.split(':')[1] });
        }
        if (errStr.startsWith('INVALID_PHOTO:')) {
          return res.status(400).json({ error: errStr.split(':')[1] });
        }
        if (errStr.startsWith('DUPLICATE_CODE:')) {
          return res.status(409).json({ error: 'كود المشرفة مسجل بالفعل لمشرفة أخرى' });
        }
        const pgInfo = extractDatabaseErrorInfo(error);
        if (pgInfo.code === '23505') {
          return res.status(409).json({
            error: 'كود المشرفة أو رقم الباص مسجل بالفعل لبيان آخر',
            details: pgInfo.detail || pgInfo.message,
          });
        }
        res.status(400).json({
          error: `تعذر تحديث بيانات المشرفة: ${pgInfo.message}`,
          details: pgInfo.detail || pgInfo.message,
        });
      }
    }
  );

  app.delete(
    '/api/supervisors/:id',
    requireAuth,
    requireAdminOrStaff,
    async (req: AuthRequest, res) => {
      try {
        const id = Number(req.params.id);
        await runWithRlsContext({ role: 'system', driverId: null }, async () => {
          const [existing] = await db
            .select()
            .from(supervisors)
            .where(eq(supervisors.id, id))
            .limit(1);
          if (!existing) {
            throw new Error('SUPERVISOR_NOT_FOUND');
          }

          await db.transaction(async (tx) => {
            await tx.delete(supervisorTrips).where(eq(supervisorTrips.supervisorId, id));
            await tx.delete(supervisors).where(eq(supervisors.id, id));
            await tx.insert(auditLogs).values({
              actorUserId: req.dbUser!.id,
              action: 'DELETE_SUPERVISOR',
              entityType: 'supervisors',
              entityId: String(id),
              beforeJson: { supervisorCode: existing.supervisorCode, fullName: existing.fullName },
              ipAddress: req.ip || '',
            });
          });
        });
        res.json({ ok: true, deletedId: id });
      } catch (error: unknown) {
        console.error('Delete supervisor error:', error);
        const errStr = error instanceof Error ? error.message : String(error);
        if (errStr === 'SUPERVISOR_NOT_FOUND') {
          return res.status(404).json({ error: 'المشرفة غير موجودة' });
        }
        res.status(500).json({ error: 'تعذر حذف المشرفة' });
      }
    }
  );

  // Dedicated Supervisor App Endpoint — STRICTLY NON-FINANCIAL (zero salary/contract/accounting fields)
  app.get('/api/supervisor-app/me', requireAuth, async (req: AuthRequest, res) => {
    try {
      if (req.dbUser?.roleSlug !== 'supervisor' && req.dbUser?.roleSlug !== 'super_admin') {
        return res.status(403).json({ error: 'هذا المسار مخصص لنسخة المشرفة والمدير العام فقط' });
      }

      let targetSupervisorId: number | null = req.supervisorRecord?.id || null;
      if (req.dbUser?.roleSlug === 'super_admin' && req.query.asSupervisorId) {
        targetSupervisorId = Number(req.query.asSupervisorId);
      }

      if (!targetSupervisorId) {
        return res.json({ linked: false, supervisor: null });
      }

      const payload = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        const [sup] = await db
          .select()
          .from(supervisors)
          .where(eq(supervisors.id, targetSupervisorId))
          .limit(1);

        if (!sup) return { kind: 'not_found' as const };
        if (req.dbUser?.roleSlug === 'supervisor' && sup.accountStatus !== 'active') {
          return { kind: 'inactive' as const };
        }

        const todayDate = getTodayDateString();
        const [schoolRows, routeRows, activeAssignments, todayTripRows] = await Promise.all([
          sup.schoolId
            ? db
                .select({
                  id: schools.id,
                  name: schools.name,
                  address: schools.address,
                  lat: schools.lat,
                  lng: schools.lng,
                  contactName: schools.contactName,
                  contactPhone: schools.contactPhone,
                })
                .from(schools)
                .where(eq(schools.id, sup.schoolId))
                .limit(1)
            : Promise.resolve([]),
          sup.routeId
            ? db
                .select({
                  id: routes.id,
                  name: routes.name,
                  pickupArea: routes.pickupArea,
                  dropoffArea: routes.dropoffArea,
                  pickupTime: routes.pickupTime,
                  dropoffTime: routes.dropoffTime,
                  estimatedDistanceKm: routes.estimatedDistanceKm,
                })
                .from(routes)
                .where(eq(routes.id, sup.routeId))
                .limit(1)
            : Promise.resolve([]),
          db
            .select({
              driverId: driverAssignments.driverId,
              schoolId: driverAssignments.schoolId,
              vehicleId: driverAssignments.vehicleId,
              routeId: driverAssignments.routeId,
            })
            .from(driverAssignments)
            .where(eq(driverAssignments.isCurrent, true)),
          db
            .select()
            .from(supervisorTrips)
            .where(
              and(eq(supervisorTrips.supervisorId, sup.id), eq(supervisorTrips.tripDate, todayDate))
            )
            .limit(1),
        ]);

        const schoolInfo = schoolRows[0] || null;
        const routeInfo = routeRows[0] || null;
        const todayTripRow = todayTripRows[0] || null;

        const targetVehicleIds = new Set<number>();
        if (sup.vehicleId) {
          targetVehicleIds.add(sup.vehicleId);
        } else if (sup.routeId) {
          for (const a of activeAssignments) {
            if (a.routeId === sup.routeId && a.vehicleId) targetVehicleIds.add(a.vehicleId);
          }
        } else if (sup.schoolId) {
          for (const a of activeAssignments) {
            if (a.schoolId === sup.schoolId && a.vehicleId) targetVehicleIds.add(a.vehicleId);
          }
        }

        const vehicleResults = await Promise.all(
          [...targetVehicleIds].map(async (vId) => {
            const assign = activeAssignments.find((a) => a.vehicleId === vId);
            const needExtraRoute = Boolean(
              assign?.routeId && (!routeInfo || assign.routeId !== routeInfo.id)
            );

            const [vehRows, drvRows, extraRouteRows, trailRows] = await Promise.all([
              db
                .select({
                  id: vehicles.id,
                  busNumber: vehicles.busNumber,
                  registrationNumber: vehicles.registrationNumber,
                  vehicleType: vehicles.vehicleType,
                  gpsStatus: vehicles.gpsStatus,
                })
                .from(vehicles)
                .where(eq(vehicles.id, vId))
                .limit(1),
              assign?.driverId
                ? db
                    .select({
                      fullName: drivers.fullName,
                      phone: drivers.phone,
                      accountStatus: drivers.accountStatus,
                    })
                    .from(drivers)
                    .where(eq(drivers.id, assign.driverId))
                    .limit(1)
                : Promise.resolve([]),
              needExtraRoute && assign?.routeId
                ? db
                    .select({ name: routes.name })
                    .from(routes)
                    .where(eq(routes.id, assign.routeId))
                    .limit(1)
                : Promise.resolve([]),
              db
                .select({
                  id: gpsLocations.id,
                  lat: gpsLocations.lat,
                  lng: gpsLocations.lng,
                  speedKmh: gpsLocations.speedKmh,
                  heading: gpsLocations.heading,
                  accuracyMeters: gpsLocations.accuracyMeters,
                  isLive: gpsLocations.isLive,
                  recordedAt: gpsLocations.recordedAt,
                })
                .from(gpsLocations)
                .where(eq(gpsLocations.vehicleId, vId))
                .orderBy(desc(gpsLocations.recordedAt))
                .limit(25),
            ]);

            const veh = vehRows[0];
            if (!veh) return null;

            const drv = drvRows[0];
            const driverName = drv && drv.accountStatus === 'active' ? drv.fullName : 'غير معين';
            const driverPhone = drv && drv.accountStatus === 'active' ? drv.phone : '';
            const busRouteName = extraRouteRows[0]?.name || routeInfo?.name || 'غير محدد';

            const latest = trailRows[0] || null;
            const fresh = latest ? isGpsFresh(latest.recordedAt, latest.isLive) : false;

            return {
              vehicleId: veh.id,
              busNumber: veh.busNumber,
              registrationNumber: veh.registrationNumber,
              vehicleType: veh.vehicleType,
              gpsStatus: veh.gpsStatus,
              routeName: busRouteName,
              driverName,
              driverPhone,
              isOnline: veh.gpsStatus !== 'paused' && fresh,
              gps: latest
                ? {
                    lat: latest.lat,
                    lng: latest.lng,
                    speedKmh: fresh ? Math.round(latest.speedKmh) : 0,
                    heading: latest.heading,
                    accuracyMeters: latest.accuracyMeters,
                    recordedAt: latest.recordedAt,
                    isLive: veh.gpsStatus !== 'paused' && fresh,
                    statusLabel:
                      veh.gpsStatus === 'paused'
                        ? 'متوقف مؤقتاً من السائق'
                        : fresh
                        ? 'متصل مباشر'
                        : 'آخر موقع مسجل (غير متصل)',
                  }
                : null,
              trail: trailRows.map((p) => ({
                id: p.id,
                lat: p.lat,
                lng: p.lng,
                speedKmh: Math.round(p.speedKmh),
                recordedAt: p.recordedAt,
              })),
            };
          })
        );

        const trackedVehicles = vehicleResults.filter(
          (item): item is NonNullable<typeof item> => item !== null
        );

        const hasSupLiveCoords =
          sup.liveLat !== null &&
          sup.liveLat !== undefined &&
          sup.liveLng !== null &&
          sup.liveLng !== undefined;

        return {
          kind: 'ok' as const,
          data: {
            linked: true,
            supervisor: {
              id: sup.id,
              supervisorCode: sup.supervisorCode,
              fullName: sup.fullName,
              phone: sup.phone,
              photoUrl: sup.photoUrl || '',
              accountStatus: sup.accountStatus,
              notes: sup.notes || '',
              liveLocation: hasSupLiveCoords
                ? {
                    lat: sup.liveLat!,
                    lng: sup.liveLng!,
                    speedKmh: Math.round(Number(sup.liveSpeedKmh || 0)),
                    accuracyMeters: sup.liveAccuracyMeters ?? null,
                    recordedAt: sup.liveUpdatedAt ? sup.liveUpdatedAt.toISOString() : '',
                    isLive: isGpsFresh(sup.liveUpdatedAt, true),
                  }
                : null,
            },
            todayTrip: todayTripRow
              ? {
                  tripDate: todayTripRow.tripDate,
                  morningStartedAt: todayTripRow.morningStartedAt
                    ? todayTripRow.morningStartedAt.toISOString()
                    : null,
                  morningLat: todayTripRow.morningLat ?? null,
                  morningLng: todayTripRow.morningLng ?? null,
                  eveningEndedAt: todayTripRow.eveningEndedAt
                    ? todayTripRow.eveningEndedAt.toISOString()
                    : null,
                  eveningLat: todayTripRow.eveningLat ?? null,
                  eveningLng: todayTripRow.eveningLng ?? null,
                }
              : {
                  tripDate: todayDate,
                  morningStartedAt: null,
                  morningLat: null,
                  morningLng: null,
                  eveningEndedAt: null,
                  eveningLat: null,
                  eveningLng: null,
                },
            school: schoolInfo,
            route: routeInfo,
            trackedVehicles,
          },
        };
      });

      if (payload.kind === 'not_found') {
        return res.json({ linked: false, supervisor: null });
      }
      if (payload.kind === 'inactive') {
        return res.status(403).json({
          error: 'تم إيقاف حساب المشرفة من قبل الإدارة. يرجى التواصل مع المشرف.',
        });
      }

      res.json(payload.data);
    } catch (error) {
      console.error('Supervisor app me error:', error);
      res.status(500).json({ error: 'تعذر تحميل بيانات المشرفة' });
    }
  });

  // Supervisor App: Live GPS Stream (Auto-started when supervisor opens app)
  app.post('/api/supervisor-app/gps', requireAuth, async (req: AuthRequest, res) => {
    try {
      if (req.dbUser?.roleSlug !== 'supervisor' && req.dbUser?.roleSlug !== 'super_admin') {
        return res.status(403).json({ error: 'هذا المسار مخصص لنسخة المشرفة والمدير العام فقط' });
      }

      let targetSupervisorId: number | null = req.supervisorRecord?.id || null;
      if (req.dbUser?.roleSlug === 'super_admin') {
        const override = req.query.asSupervisorId || req.body?.supervisorId;
        if (override) targetSupervisorId = Number(override);
      }

      if (!targetSupervisorId) {
        return res.status(403).json({ error: 'لا يوجد ملف مشرفة مرتبط بهذا الحساب' });
      }

      const numLat = Number(req.body?.lat);
      const numLng = Number(req.body?.lng);
      if (!isValidGpsCoordinate(numLat, numLng)) {
        return res.status(400).json({ error: 'إحداثيات الموقع المباشر غير صالحة' });
      }

      const safeSpeed = Math.max(0, Math.min(200, Number(req.body?.speedKmh || 0)));
      const safeAccuracy = Number.isFinite(Number(req.body?.accuracyMeters))
        ? Math.round(Number(req.body.accuracyMeters))
        : 15;
      const safeHeading = Number.isFinite(Number(req.body?.heading)) ? Number(req.body.heading) : 0;
      const now = new Date();

      const result = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        const [sup] = await db
          .select()
          .from(supervisors)
          .where(eq(supervisors.id, targetSupervisorId))
          .limit(1);

        if (!sup) return { kind: 'not_found' as const };
        if (req.dbUser?.roleSlug === 'supervisor' && sup.accountStatus !== 'active') {
          return { kind: 'inactive' as const };
        }

        await db
          .update(supervisors)
          .set({
            liveLat: numLat,
            liveLng: numLng,
            liveSpeedKmh: safeSpeed,
            liveAccuracyMeters: safeAccuracy,
            liveUpdatedAt: now,
            updatedAt: now,
          })
          .where(eq(supervisors.id, sup.id));

        if (sup.vehicleId) {
          await db.insert(gpsLocations).values({
            vehicleId: sup.vehicleId,
            driverId: null,
            lat: numLat,
            lng: numLng,
            speedKmh: safeSpeed,
            heading: safeHeading,
            accuracyMeters: safeAccuracy,
            isLive: true,
            source: 'live',
            recordedAt: now,
          });
          await db
            .update(vehicles)
            .set({ gpsStatus: 'online' })
            .where(eq(vehicles.id, sup.vehicleId));
        }

        return {
          kind: 'ok' as const,
          liveLocation: {
            lat: numLat,
            lng: numLng,
            speedKmh: Math.round(safeSpeed),
            accuracyMeters: safeAccuracy,
            recordedAt: now.toISOString(),
            isLive: true,
          },
        };
      });

      if (result.kind === 'not_found') {
        return res.status(404).json({ error: 'ملف المشرفة غير موجود' });
      }
      if (result.kind === 'inactive') {
        return res.status(403).json({ error: 'حساب المشرفة غير نشط' });
      }

      res.json({ ok: true, liveLocation: result.liveLocation });
    } catch (error) {
      console.error('Supervisor GPS update error:', error);
      res.status(500).json({ error: 'تعذر تحديث الموقع المباشر للمشرفة' });
    }
  });

  // Supervisor App: Two Daily Missions (1: Morning Trip Start / 2: Evening Trip End)
  app.post('/api/supervisor-app/trip-action', requireAuth, async (req: AuthRequest, res) => {
    try {
      if (req.dbUser?.roleSlug !== 'supervisor' && req.dbUser?.roleSlug !== 'super_admin') {
        return res.status(403).json({ error: 'هذا المسار مخصص لنسخة المشرفة والمدير العام فقط' });
      }

      let targetSupervisorId: number | null = req.supervisorRecord?.id || null;
      if (req.dbUser?.roleSlug === 'super_admin') {
        const override = req.query.asSupervisorId || req.body?.supervisorId;
        if (override) targetSupervisorId = Number(override);
      }

      if (!targetSupervisorId) {
        return res.status(403).json({ error: 'لا يوجد ملف مشرفة مرتبط بهذا الحساب' });
      }

      const action = req.body?.action;
      if (action !== 'start_morning' && action !== 'end_evening') {
        return res.status(400).json({ error: 'نوع المهمة غير صالح (start_morning | end_evening)' });
      }

      const numLat = Number(req.body?.lat);
      const numLng = Number(req.body?.lng);
      const hasValidCoords = isValidGpsCoordinate(numLat, numLng);
      const now = new Date();
      const todayDate = getTodayDateString();

      const result = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        const [sup] = await db
          .select()
          .from(supervisors)
          .where(eq(supervisors.id, targetSupervisorId))
          .limit(1);

        if (!sup) return { kind: 'not_found' as const };
        if (req.dbUser?.roleSlug === 'supervisor' && sup.accountStatus !== 'active') {
          return { kind: 'inactive' as const };
        }

        if (hasValidCoords) {
          await db
            .update(supervisors)
            .set({
              liveLat: numLat,
              liveLng: numLng,
              liveUpdatedAt: now,
              updatedAt: now,
            })
            .where(eq(supervisors.id, sup.id));
        }

        const insertValues =
          action === 'start_morning'
            ? {
                supervisorId: sup.id,
                vehicleId: sup.vehicleId,
                tripDate: todayDate,
                morningStartedAt: now,
                morningLat: hasValidCoords ? numLat : null,
                morningLng: hasValidCoords ? numLng : null,
                updatedAt: now,
              }
            : {
                supervisorId: sup.id,
                vehicleId: sup.vehicleId,
                tripDate: todayDate,
                eveningEndedAt: now,
                eveningLat: hasValidCoords ? numLat : null,
                eveningLng: hasValidCoords ? numLng : null,
                updatedAt: now,
              };

        const updateSet =
          action === 'start_morning'
            ? {
                vehicleId: sup.vehicleId,
                morningStartedAt: now,
                ...(hasValidCoords ? { morningLat: numLat, morningLng: numLng } : {}),
                updatedAt: now,
              }
            : {
                vehicleId: sup.vehicleId,
                eveningEndedAt: now,
                ...(hasValidCoords ? { eveningLat: numLat, eveningLng: numLng } : {}),
                updatedAt: now,
              };

        const [tripRow] = await db
          .insert(supervisorTrips)
          .values(insertValues)
          .onConflictDoUpdate({
            target: [supervisorTrips.supervisorId, supervisorTrips.tripDate],
            set: updateSet,
          })
          .returning();

        if (req.dbUser?.id) {
          await db.insert(auditLogs).values({
            actorUserId: req.dbUser.id,
            action:
              action === 'start_morning' ? 'SUPERVISOR_MORNING_START' : 'SUPERVISOR_EVENING_END',
            entityType: 'supervisor_trips',
            entityId: String(tripRow.id),
            afterJson: {
              supervisorId: sup.id,
              tripDate: todayDate,
              action,
              lat: hasValidCoords ? numLat : null,
              lng: hasValidCoords ? numLng : null,
            },
            ipAddress: req.ip || '',
          });
        }

        return {
          kind: 'ok' as const,
          todayTrip: {
            tripDate: tripRow.tripDate,
            morningStartedAt: tripRow.morningStartedAt
              ? tripRow.morningStartedAt.toISOString()
              : null,
            morningLat: tripRow.morningLat ?? null,
            morningLng: tripRow.morningLng ?? null,
            eveningEndedAt: tripRow.eveningEndedAt ? tripRow.eveningEndedAt.toISOString() : null,
            eveningLat: tripRow.eveningLat ?? null,
            eveningLng: tripRow.eveningLng ?? null,
          },
        };
      });

      if (result.kind === 'not_found') {
        return res.status(404).json({ error: 'ملف المشرفة غير موجود' });
      }
      if (result.kind === 'inactive') {
        return res.status(403).json({ error: 'حساب المشرفة غير نشط' });
      }

      res.json({ ok: true, action, todayTrip: result.todayTrip });
    } catch (error) {
      console.error('Supervisor trip action error:', error);
      res.status(500).json({ error: 'تعذر تسجيل حركة الرحلة' });
    }
  });

  await ensureRlsPoliciesApplied().catch((err) => {
    console.warn('[RLS] Startup policy sync warning:', err);
  });

  const httpServer = http.createServer(app);

  // Vite / Static Frontend Serving
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const port = Number(process.env.PORT) || 3000;
  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`Al-Waleed Travel server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
