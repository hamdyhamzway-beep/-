import 'dotenv/config';
import http from 'http';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { and, desc, eq, gte, isNull, like, lte, ne, or, sql } from 'drizzle-orm';
import { db } from './src/db/index.ts';
import {
  advances,
  attendance,
  auditLogs,
  billingPeriods,
  chatChannels,
  coverageRecords,
  dailyReports,
  driverAssignments,
  drivers,
  employees,
  financialCustodies,
  financialTransactions,
  gpsLocations,
  invoices,
  monthlyClosings,
  notifications,
  routes,
  salaries,
  schools,
  supervisors,
  supervisorNotes,
  supervisorTrips,
  userRoles,
  users,
  type DriverLicensePhoto,
  vehicles,
  voiceCommandLogs,
} from './src/db/schema.ts';
import {
  buildDefaultInvoiceStatement,
  DEFAULT_INVOICE_BILL_TO,
  DEFAULT_INVOICE_SCHOOL_NAME,
  DEFAULT_INVOICE_VEHICLE_COUNT,
  formatInvoiceCode,
  tafqeetEGP,
} from './src/lib/arabic-tafqeet.ts';
import {
  type AuthRequest,
  buildEffectivePermissions,
  ensureRolesExist,
  ensureSeedOwnerUserId,
  hasPermission,
  isSchoolAllowed,
  isSchoolUnrestricted,
  requireAdminOrStaff,
  requireAnyPermission,
  requireAuth,
  requirePermission,
  resolveAssignedSchoolNames,
} from './src/middleware/auth.ts';
import {
  issueDriverSessionToken,
  issueStaffSessionToken,
  issueSupervisorSessionToken,
  normalizeArabicDigits,
  normalizeArabicName,
  normalizeDriverCode,
  normalizeEgyptPhone,
} from './src/lib/driver-session.ts';
import {
  normalizePermissionsList,
  normalizeSchoolIds,
} from './src/lib/permissions.ts';
import { ensureRlsPoliciesApplied } from './src/db/apply-rls-policies.ts';
import { runWithRlsContext } from './src/db/rls-context.ts';
import {
  closeMonthAndStartNext,
  deleteAdjustmentTransaction,
  deleteAdvanceTransaction,
  deleteCoverageTransaction,
  getActiveBillingPeriod,
  getDriverSchoolBillingConfig,
  GetFinancialPeriod,
  getMonthYearFromDate,
  getMonthlyClosingsHistory,
  getOrRecalculateDriverSalaryForRead,
  getSchoolBillingConfigById,
  getSchoolBillingPeriodKey,
  getSupervisorCycleSummaries,
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
  getBillingDateRangeForPeriod,
  getCurrentBillingRangeForSchool,
  isDateInRange,
  normalizeIsoDateInput,
  resolveSchoolBillingRule,
  type SchoolBillingConfig,
} from './src/lib/billing-cycle.ts';
import {
  interpretEgyptianCommand,
  synthesizeArabicSpeech,
  transcribeEgyptianAudio,
} from './src/services/gemini-voice.ts';
import {
  broadcastToRoom,
  DRIVERS_BROADCAST_ROOM,
  getEnrichedChatChannels,
  getMessagesForRoom,
  initChatWebSocketServer,
  saveMessageToDb,
} from './src/services/chat-service.ts';

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
  const [allDrivers, currentAssignments, allSchools, allVehicles, allRoutes] =
    await Promise.all([
      db.select().from(drivers).orderBy(drivers.driverCode),
      db.select().from(driverAssignments).where(eq(driverAssignments.isCurrent, true)),
      db.select().from(schools),
      db.select().from(vehicles),
      db.select().from(routes),
    ]);

  const schoolById: Record<number, typeof schools.$inferSelect> = {};
  for (const s of allSchools) schoolById[s.id] = s;

  const vehicleById: Record<number, typeof vehicles.$inferSelect> = {};
  for (const v of allVehicles) vehicleById[v.id] = v;

  const routeById: Record<number, typeof routes.$inferSelect> = {};
  for (const r of allRoutes) routeById[r.id] = r;

  const assignByDriver: Record<number, typeof driverAssignments.$inferSelect> = {};
  for (const a of currentAssignments) assignByDriver[a.driverId] = a;

  return allDrivers.map((d) => {
    const assign = assignByDriver[d.id];
    const school = assign?.schoolId ? schoolById[assign.schoolId] : undefined;
    const vehicle = assign?.vehicleId ? vehicleById[assign.vehicleId] : undefined;
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
    allSchools,
    allRoutes,
    allDrivers,
    currentAssignments,
    latestGpsRows,
  ] = await Promise.all([
    db.select().from(vehicles).orderBy(vehicles.busNumber),
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
    const effectiveSchoolId = v.schoolId ?? assign?.schoolId ?? null;
    const school = effectiveSchoolId ? schoolById[effectiveSchoolId] : undefined;
    const route = assign?.routeId ? routeById[assign.routeId] : undefined;
    const gps = latestByVehicle[v.id] || null;
    const fresh = gps ? isGpsFresh(gps.recordedAt, gps.isLive) : false;

    return {
      ...v,
      driverId: driver?.id || null,
      driverName: driver?.fullName || 'غير معين',
      driverCode: driver?.driverCode || '—',
      driverPhone: driver?.phone || '',
      schoolId: school?.id ?? effectiveSchoolId ?? null,
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

  // 0c. Staff Code Login (المحاسب / مشرف الحركة / الموظف المصرح له بالكود)
  app.post('/api/auth/staff-login', async (req, res) => {
    const clientIp = req.ip || 'unknown';
    const rateKey = `stf:${clientIp}`;
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
        req.body?.identifier ?? req.body?.phone ?? req.body?.name ?? req.body?.email ?? ''
      ).trim();
      const normCode = normalizeDriverCode(req.body?.staffCode ?? req.body?.code);
      const normPhone = normalizeEgyptPhone(rawIdentifier);
      const rawPhoneDigits = normalizeArabicDigits(rawIdentifier).replace(/\D/g, '');
      const normInputName = normalizeArabicName(rawIdentifier);
      const normInputEmail = rawIdentifier.toLowerCase();

      if (!normCode || !rawIdentifier) {
        return res.status(400).json({
          error: 'يرجى إدخال الاسم أو رقم الموبايل أو البريد الإلكتروني مع كود الموظف',
        });
      }

      const result = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        await ensureRolesExist();
        const allUsers = await db.select().from(users);
        const allRoles = await db.select().from(userRoles);
        const roleById: Record<number, typeof userRoles.$inferSelect> = {};
        for (const r of allRoles) roleById[r.id] = r;

        const staffUser = allUsers.find((u) => {
          const role = roleById[u.roleId];
          if (!role || role.slug === 'driver' || role.slug === 'supervisor') return false;
          const storedCode = normalizeDriverCode(u.staffCode || '').toLowerCase();
          if (!storedCode || storedCode !== normCode.toLowerCase()) return false;

          const storedPhoneNorm = normalizeEgyptPhone(u.phone || '');
          const storedPhoneDigits = normalizeArabicDigits(u.phone || '').replace(/\D/g, '');
          const phoneMatches =
            (Boolean(normPhone) && storedPhoneNorm === normPhone) ||
            (rawPhoneDigits.length >= 8 &&
              (storedPhoneDigits === rawPhoneDigits ||
                storedPhoneDigits.endsWith(rawPhoneDigits) ||
                rawPhoneDigits.endsWith(storedPhoneDigits)));

          const emailMatches =
            normInputEmail.includes('@') && u.email.toLowerCase() === normInputEmail;
          const normStoredName = normalizeArabicName(u.fullName);
          const nameMatches =
            normInputName.length >= 2 &&
            (normStoredName === normInputName || normStoredName.includes(normInputName));

          return phoneMatches || emailMatches || nameMatches;
        });

        if (!staffUser) {
          return {
            status: 401 as const,
            error: 'بيانات الموظف أو كود الدخول غير صحيح، يرجى التأكد من المدير العام',
          };
        }

        if (!staffUser.isActive) {
          return {
            status: 403 as const,
            error: 'تم إيقاف صلاحية هذا الحساب من قبل المدير العام',
          };
        }

        const role = roleById[staffUser.roleId];
        const effectivePermissions = buildEffectivePermissions(
          role.slug,
          role.permissions,
          staffUser.customPermissions
        );
        const assignedSchoolIds =
          role.slug === 'super_admin' ? [] : normalizeSchoolIds(staffUser.assignedSchoolIds);
        const assignedSchoolNames = await resolveAssignedSchoolNames(assignedSchoolIds);

        const token = issueStaffSessionToken({
          userId: staffUser.id,
          staffCode: staffUser.staffCode || normCode,
        });

        await db.insert(auditLogs).values({
          actorUserId: staffUser.id,
          action: 'STAFF_CODE_LOGIN',
          entityType: 'users',
          entityId: String(staffUser.id),
          afterJson: { staffCode: staffUser.staffCode, roleSlug: role.slug },
          ipAddress: clientIp,
        });

        return {
          status: 200 as const,
          payload: {
            token,
            user: {
              id: staffUser.id,
              uid: staffUser.uid,
              email: staffUser.email,
              fullName: staffUser.fullName,
              phone: staffUser.phone,
              roleId: staffUser.roleId,
              roleSlug: role.slug,
              roleNameAr: role.nameAr,
              permissions: effectivePermissions,
              customPermissions: Array.isArray(staffUser.customPermissions)
                ? staffUser.customPermissions
                : null,
              assignedSchoolIds,
              assignedSchoolNames,
              staffCode: staffUser.staffCode || null,
              employeeId: staffUser.employeeId ?? null,
              isActive: staffUser.isActive,
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
      console.error('Staff login error:', error);
      return res.status(500).json({ error: 'تعذر تسجيل دخول الموظف، يرجى المحاولة لاحقاً' });
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
      const schoolFilter = req.query.schoolId ? Number(req.query.schoolId) : null;
      if (schoolFilter && !isSchoolAllowed(req.dbUser, schoolFilter)) {
        return res.status(403).json({ error: 'هذه المدرسة خارج نطاق صلاحياتك' });
      }
      const activePeriod = await getActiveBillingPeriod(schoolFilter);
      const month = Number(req.query.month) || activePeriod.month;
      const year = Number(req.query.year) || activePeriod.year;
      const dateStr = normalizeIsoDateInput(String(req.query.date || '')) || getTodayDateString();
      const driverFilter = req.query.driverId ? Number(req.query.driverId) : null;
      const vehicleFilter = req.query.vehicleId ? Number(req.query.vehicleId) : null;
      const statusFilter = (req.query.status as string) || '';
      const schoolQuery = String(req.query.schoolQuery || '').trim().toLowerCase();
      const driverQuery = String(req.query.driverQuery || '').trim().toLowerCase();
      const vehicleQuery = String(req.query.vehicleQuery || '').trim().toLowerCase();
      const statusQuery = String(req.query.statusQuery || '').trim().toLowerCase();

      const dashboardPayload = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        const [allEnrichedDrivers, rawFleet, allSchools, todayAttendance, allSalaries, rawEmployees] =
          await Promise.all([
            getEnrichedDrivers(),
            getFleetWithLatestGps(),
            db.select().from(schools),
            db.select().from(attendance).where(eq(attendance.date, dateStr)),
            db.select().from(salaries).where(and(eq(salaries.month, month), eq(salaries.year, year))),
            db.select().from(employees).orderBy(employees.fullName),
          ]);

      let enrichedDrivers = allEnrichedDrivers.filter(
        (d) => d.accountStatus === 'active' && isSchoolAllowed(req.dbUser, d.schoolId)
      );
      let fleet = rawFleet.filter(
        (v) => v.operationalStatus !== 'inactive' && isSchoolAllowed(req.dbUser, v.schoolId)
      );
      const scopedSchools = allSchools.filter((s) => isSchoolAllowed(req.dbUser, s.id));

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

      const canReadEmployees =
        req.dbUser?.roleSlug === 'super_admin' || hasPermission(req.dbUser, 'employees:read');
      const activeEmployees = canReadEmployees
        ? rawEmployees.filter(
            (e) =>
              e.status === 'active' &&
              isSchoolAllowed(req.dbUser, e.schoolId) &&
              (!schoolFilter || e.schoolId === schoolFilter)
          )
        : [];

      // School contract revenue vs total payroll (drivers + non-driver employees)
      const relevantSchools = schoolFilter
        ? scopedSchools.filter((s) => s.id === schoolFilter && s.isActive)
        : schoolQuery
        ? scopedSchools.filter((s) => s.isActive && s.name.toLowerCase().includes(schoolQuery))
        : scopedSchools.filter((s) => s.isActive);
      const totalSchoolContracts = relevantSchools.reduce(
        (sum, s) => sum + Number(s.monthlyContractValue || 0),
        0
      );

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
        .where(
          schoolFilter
            ? and(
                eq(monthlyClosings.month, month),
                eq(monthlyClosings.year, year),
                or(eq(monthlyClosings.schoolId, schoolFilter), isNull(monthlyClosings.schoolId))
              )
            : and(eq(monthlyClosings.month, month), eq(monthlyClosings.year, year), isNull(monthlyClosings.schoolId))
        )
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

        return {
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
                    totalCoverageAdditions: Number(s.totalCoverageAdditions || 0),
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
                    totalCoverageAdditions: 0,
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
          schools: scopedSchools,
          recentNotifications,
        };
      });
      res.json(dashboardPayload);
    } catch (error) {
      console.error('Dashboard error:', error);
      res.status(500).json({ error: 'تعذر تحميل بيانات لوحة التحكم' });
    }
  });

  async function getDriverCurrentSchoolId(driverId: number): Promise<number | null> {
    const [assign] = await db
      .select({ schoolId: driverAssignments.schoolId })
      .from(driverAssignments)
      .where(and(eq(driverAssignments.driverId, driverId), eq(driverAssignments.isCurrent, true)))
      .limit(1);
    return assign?.schoolId ?? null;
  }

  async function permanentlyDeleteUserTx(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    userId: number,
    fallbackAdminUserId: number
  ): Promise<boolean> {
    const [targetUser] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!targetUser) return false;
    if (targetUser.email.toLowerCase() === 'hamdyhamzway@gmail.com') {
      throw new Error('لا يمكن حذف حساب المدير العام الرئيسي');
    }

    // 1. Reassign non-null foreign keys to fallbackAdminUserId
    await tx
      .update(advances)
      .set({ recordedByUserId: fallbackAdminUserId })
      .where(eq(advances.recordedByUserId, userId));

    await tx
      .update(coverageRecords)
      .set({ recordedByUserId: fallbackAdminUserId })
      .where(eq(coverageRecords.recordedByUserId, userId));

    await tx
      .update(financialTransactions)
      .set({ recordedByUserId: fallbackAdminUserId })
      .where(eq(financialTransactions.recordedByUserId, userId));

    await tx
      .update(voiceCommandLogs)
      .set({ adminUserId: fallbackAdminUserId })
      .where(eq(voiceCommandLogs.adminUserId, userId));

    // 2. Nullify nullable foreign keys
    await tx.update(drivers).set({ userId: null }).where(eq(drivers.userId, userId));
    await tx.update(supervisors).set({ userId: null }).where(eq(supervisors.userId, userId));
    await tx.update(attendance).set({ recordedByUserId: null }).where(eq(attendance.recordedByUserId, userId));
    await tx.update(notifications).set({ recipientUserId: null }).where(eq(notifications.recipientUserId, userId));
    await tx.update(auditLogs).set({ actorUserId: null }).where(eq(auditLogs.actorUserId, userId));
    await tx.update(monthlyClosings).set({ closedByUserId: null }).where(eq(monthlyClosings.closedByUserId, userId));
    await tx.update(billingPeriods).set({ updatedByUserId: null }).where(eq(billingPeriods.updatedByUserId, userId));
    await tx.update(dailyReports).set({ userId: null }).where(eq(dailyReports.userId, userId));
    await tx.update(financialCustodies).set({ handedByUserId: null }).where(eq(financialCustodies.handedByUserId, userId));
    await tx.update(financialCustodies).set({ settledByUserId: null }).where(eq(financialCustodies.settledByUserId, userId));

    // 3. Delete the user row permanently
    await tx.delete(users).where(eq(users.id, userId));
    return true;
  }

  // 3. Drivers Management (Active by default — archived drivers live in /api/archive)
  app.get('/api/drivers', requireAuth, requireAdminOrStaff, requirePermission('drivers:read'), async (req: AuthRequest, res) => {
    try {
      const includeArchived = req.query.includeArchived === 'true';
      const list = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        const all = (await getEnrichedDrivers()).filter((d) =>
          isSchoolAllowed(req.dbUser, d.schoolId)
        );
        return includeArchived ? all : all.filter((d) => d.accountStatus === 'active');
      });
      res.json({ drivers: list });
    } catch (error) {
      console.error('Get drivers error:', error);
      res.status(500).json({ error: 'تعذر تحميل قائمة السائقين' });
    }
  });

  const PLACEHOLDER_ASSIGNMENTS = new Set(['غير معين', 'غير معينة', 'غير محدد', '—', '-']);

  async function resolveSchoolIdForDriver(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db,
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

      const autoRule = resolveSchoolBillingRule({ name: trimmed });
      const [created] = await tx
        .insert(schools)
        .values({
          name: trimmed,
          address: '',
          lat: 31.2156,
          lng: 29.9553,
          billingCycleType: autoRule.cycleType,
          billingCycleStartDay: autoRule.startDay,
          billingCycleEndDay: autoRule.endDay,
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

        let scopedTargetSchoolId: number | undefined = schoolId ? Number(schoolId) : undefined;
        if (!isSchoolUnrestricted(req.dbUser)) {
          let targetSchoolId: number | null = schoolId ? Number(schoolId) : null;
          if (!targetSchoolId && schoolName && !PLACEHOLDER_ASSIGNMENTS.has(String(schoolName).trim())) {
            const [sRow] = await db
              .select({ id: schools.id })
              .from(schools)
              .where(eq(schools.name, String(schoolName).trim()))
              .limit(1);
            targetSchoolId = sRow?.id ?? null;
          }
          if (!targetSchoolId && (!schoolName || PLACEHOLDER_ASSIGNMENTS.has(String(schoolName).trim()))) {
            if ((req.dbUser?.assignedSchoolIds?.length || 0) === 1) {
              targetSchoolId = req.dbUser!.assignedSchoolIds[0];
            }
          }
          if (!targetSchoolId || !isSchoolAllowed(req.dbUser, targetSchoolId)) {
            return res.status(403).json({
              error: 'لا يمكنك إضافة سائق خارج المدارس المعينة لك',
            });
          }
          scopedTargetSchoolId = targetSchoolId;
        }

        const existingCode = await db
          .select({ id: drivers.id })
          .from(drivers)
          .where(sql`LOWER(TRIM(${drivers.driverCode})) = LOWER(${normalizedCode})`)
          .limit(1);

        if (existingCode[0]) {
          return res.status(409).json({ error: `كود السائق ${normalizedCode} مسجل مسبقاً ولا يمكن تكراره` });
        }

        const created = await runWithRlsContext({ role: 'system', driverId: null }, async () =>
          db.transaction(async (tx) => {
            const [newDriver] = await tx
              .insert(drivers)
              .values({
                driverCode: normalizedCode,
                fullName: String(fullName).trim(),
                phone: normalizedPhone,
                emergencyContact: emergencyContact || '',
                linkedEmail: linkedEmail ? String(linkedEmail).toLowerCase().trim() : '',
                monthlyAgreedSalary: Number(monthlyAgreedSalary || 0).toFixed(2),
                employmentStartDate: employmentStartDate ? normalizeIsoDateInput(String(employmentStartDate)) : getTodayDateString(),
                accountStatus: accountStatus || 'active',
                photoUrl: safePhotoUrl,
                licensePhotosJson: safeLicensePhotos,
                notes: notes || '',
              })
              .returning();

            const resolvedSchoolId = await resolveSchoolIdForDriver(tx, {
              schoolId: scopedTargetSchoolId ?? schoolId,
              schoolName,
            });
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

            const drvSchoolCfg = resolvedSchoolId
              ? await getSchoolBillingConfigById(tx, resolvedSchoolId)
              : null;
            const currentRange = getCurrentBillingRangeForSchool(drvSchoolCfg);
            await recalculateDriverSalary(
              tx,
              newDriver.id,
              currentRange.month,
              currentRange.year,
              drvSchoolCfg
            );

            await tx.insert(auditLogs).values({
              actorUserId: req.dbUser!.id,
              action: 'CREATE_DRIVER',
              entityType: 'drivers',
              entityId: String(newDriver.id),
              afterJson: newDriver,
              ipAddress: req.ip || '',
            });

            return newDriver;
          })
        );

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

      if (!isSchoolUnrestricted(req.dbUser)) {
        const currentSchoolId = await getDriverCurrentSchoolId(driverId);
        if (!isSchoolAllowed(req.dbUser, currentSchoolId)) {
          return res.status(403).json({ error: 'هذا السائق تابع لمدرسة خارج نطاق صلاحياتك' });
        }
      }

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

      const updated = await runWithRlsContext({ role: 'system', driverId: null }, async () =>
        db.transaction(async (tx) => {
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
            if (!isSchoolUnrestricted(req.dbUser) && (!resolvedSchoolId || !isSchoolAllowed(req.dbUser, resolvedSchoolId))) {
              throw new Error('SCHOOL_FORBIDDEN');
            }
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

          const drvSchoolCfg = await getDriverSchoolBillingConfig(tx, driverId);
          const currentRange = getCurrentBillingRangeForSchool(drvSchoolCfg);
          await recalculateDriverSalary(
            tx,
            driverId,
            currentRange.month,
            currentRange.year,
            drvSchoolCfg
          );

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
        })
      );

      res.json({ driver: updated });
    } catch (error) {
      if (error instanceof Error && error.message === 'SCHOOL_FORBIDDEN') {
        return res.status(403).json({ error: 'لا يمكنك نقل أو تعيين السائق لمدرسة خارج نطاق صلاحياتك' });
      }
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

        if (!isSchoolUnrestricted(req.dbUser)) {
          const currentSchoolId = await getDriverCurrentSchoolId(driverId);
          if (!isSchoolAllowed(req.dbUser, currentSchoolId)) {
            return res.status(403).json({ error: 'هذا السائق تابع لمدرسة خارج نطاق صلاحياتك' });
          }
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

        const force = req.query.force === 'true';
        if (!force && (ftRef[0] || advRef[0] || covRef[0])) {
          return res.status(409).json({
            error:
              'توجد سلف أو تغطيات أو حركات مالية مسجلة لهذا السائق في دفتر الحسابات. هل تريد حذفه نهائياً وشاملاً مع كافة حركاته؟',
            canForce: true,
          });
        }

        await db.transaction(async (tx) => {
          await tx
            .update(gpsLocations)
            .set({ driverId: null })
            .where(eq(gpsLocations.driverId, driverId));
          await tx
            .delete(chatChannels)
            .where(and(eq(chatChannels.driverId, driverId), eq(chatChannels.channelType, 'direct')));
          await tx
            .update(chatChannels)
            .set({ driverId: null })
            .where(eq(chatChannels.driverId, driverId));
          await tx
            .update(coverageRecords)
            .set({ replacementDriverId: null })
            .where(eq(coverageRecords.replacementDriverId, driverId));
          await tx
            .delete(coverageRecords)
            .where(eq(coverageRecords.absentDriverId, driverId));
          await tx
            .delete(financialTransactions)
            .where(eq(financialTransactions.driverId, driverId));
          await tx.delete(advances).where(eq(advances.driverId, driverId));
          await tx.delete(salaries).where(eq(salaries.driverId, driverId));
          await tx.delete(attendance).where(eq(attendance.driverId, driverId));
          await tx.delete(driverAssignments).where(eq(driverAssignments.driverId, driverId));
          await tx.delete(notifications).where(eq(notifications.recipientDriverId, driverId));
          await tx
            .update(financialCustodies)
            .set({ driverId: null })
            .where(eq(financialCustodies.driverId, driverId));
          await tx.delete(drivers).where(eq(drivers.id, driverId));

          if (existing.userId) {
            await permanentlyDeleteUserTx(tx, existing.userId, req.dbUser!.id);
          }

          await tx.insert(auditLogs).values({
            actorUserId: req.dbUser!.id,
            action: 'DELETE_DRIVER',
            entityType: 'drivers',
            entityId: String(driverId),
            beforeJson: existing,
            ipAddress: req.ip || '',
          });
        });

        res.json({ ok: true, deletedId: driverId, message: 'تم مسح السائق نهائياً بنجاح.' });
      } catch (error) {
        console.error('Delete driver error:', error);
        res.status(500).json({ error: 'تعذر حذف السائق' });
      }
    }
  );

  app.delete(
    '/api/schools/:id',
    requireAuth,
    requireAdminOrStaff,
    requirePermission('schools:write'),
    async (req: AuthRequest, res) => {
      try {
        const id = Number(req.params.id);
        const [existing] = await db.select().from(schools).where(eq(schools.id, id)).limit(1);
        if (!existing) return res.status(404).json({ error: 'المدرسة غير موجودة' });
        if (!isSchoolAllowed(req.dbUser, id)) {
          return res.status(403).json({ error: 'هذه المدرسة خارج نطاق صلاحياتك' });
        }

        await db.transaction(async (tx) => {
          await tx.update(vehicles).set({ schoolId: null }).where(eq(vehicles.schoolId, id));
          await tx.update(routes).set({ schoolId: null }).where(eq(routes.schoolId, id));
          await tx.update(driverAssignments).set({ schoolId: null }).where(eq(driverAssignments.schoolId, id));
          await tx.update(salaries).set({ schoolId: null }).where(eq(salaries.schoolId, id));
          await tx.update(advances).set({ schoolId: null }).where(eq(advances.schoolId, id));
          await tx.update(coverageRecords).set({ schoolId: null }).where(eq(coverageRecords.schoolId, id));
          await tx.update(financialTransactions).set({ schoolId: null }).where(eq(financialTransactions.schoolId, id));
          await tx.update(financialCustodies).set({ schoolId: null }).where(eq(financialCustodies.schoolId, id));
          await tx.update(attendance).set({ schoolId: null }).where(eq(attendance.schoolId, id));
          await tx.update(employees).set({ schoolId: null }).where(eq(employees.schoolId, id));
          await tx.update(monthlyClosings).set({ schoolId: null }).where(eq(monthlyClosings.schoolId, id));
          await tx.update(supervisors).set({ schoolId: null }).where(eq(supervisors.schoolId, id));
          await tx.update(chatChannels).set({ schoolId: null }).where(eq(chatChannels.schoolId, id));
          await tx.update(dailyReports).set({ schoolId: null }).where(eq(dailyReports.schoolId, id));
          await tx.delete(billingPeriods).where(eq(billingPeriods.key, getSchoolBillingPeriodKey(id)));

          const allUsersRows = await tx.select().from(users);
          for (const u of allUsersRows) {
            const currentAssigned = Array.isArray(u.assignedSchoolIds) ? u.assignedSchoolIds : [];
            if (currentAssigned.includes(id)) {
              await tx
                .update(users)
                .set({
                  assignedSchoolIds: currentAssigned.filter((sid) => sid !== id),
                  updatedAt: new Date(),
                })
                .where(eq(users.id, u.id));
            }
          }

          await tx.delete(schools).where(eq(schools.id, id));
          await tx.insert(auditLogs).values({
            actorUserId: req.dbUser!.id,
            action: 'DELETE_SCHOOL',
            entityType: 'schools',
            entityId: String(id),
            beforeJson: existing,
            ipAddress: req.ip || '',
          });
        });

        res.json({ ok: true, deletedId: id, message: 'تم مسح المدرسة نهائياً بنجاح.' });
      } catch (error) {
        console.error('Delete school error:', error);
        res.status(500).json({ error: 'تعذر حذف المدرسة' });
      }
    }
  );

  app.delete(
    '/api/vehicles/:id',
    requireAuth,
    requireAdminOrStaff,
    requirePermission('vehicles:write'),
    async (req: AuthRequest, res) => {
      try {
        const id = Number(req.params.id);
        const [existing] = await db.select().from(vehicles).where(eq(vehicles.id, id)).limit(1);
        if (!existing) return res.status(404).json({ error: 'المركبة غير موجودة' });

        if (!isSchoolUnrestricted(req.dbUser)) {
          const [assign] = await db
            .select({ schoolId: driverAssignments.schoolId })
            .from(driverAssignments)
            .where(and(eq(driverAssignments.vehicleId, id), eq(driverAssignments.isCurrent, true)))
            .limit(1);
          const effSchoolId = existing.schoolId ?? assign?.schoolId ?? null;
          if (!effSchoolId || !isSchoolAllowed(req.dbUser, effSchoolId)) {
            return res.status(403).json({ error: 'هذه المركبة خارج نطاق المدارس المصرح لك بها' });
          }
        }

        await db.transaction(async (tx) => {
          await tx.update(gpsLocations).set({ vehicleId: null }).where(eq(gpsLocations.vehicleId, id));
          await tx.update(driverAssignments).set({ vehicleId: null }).where(eq(driverAssignments.vehicleId, id));
          await tx.update(coverageRecords).set({ vehicleId: null }).where(eq(coverageRecords.vehicleId, id));
          await tx.update(supervisors).set({ vehicleId: null }).where(eq(supervisors.vehicleId, id));
          await tx.update(supervisorTrips).set({ vehicleId: null }).where(eq(supervisorTrips.vehicleId, id));
          await tx.delete(vehicles).where(eq(vehicles.id, id));
          await tx.insert(auditLogs).values({
            actorUserId: req.dbUser!.id,
            action: 'DELETE_VEHICLE',
            entityType: 'vehicles',
            entityId: String(id),
            beforeJson: existing,
            ipAddress: req.ip || '',
          });
        });

        res.json({ ok: true, deletedId: id, message: 'تم مسح المركبة نهائياً بنجاح.' });
      } catch (error) {
        console.error('Delete vehicle error:', error);
        res.status(500).json({ error: 'تعذر حذف المركبة' });
      }
    }
  );

  app.get('/api/drivers/:id/statement', requireAuth, async (req: AuthRequest, res) => {
    try {
      const driverId = Number(req.params.id);
      // Security: a driver can ONLY read their own statement; staff must hold finance:read or advances/coverage write
      if (req.dbUser?.roleSlug === 'driver') {
        if (req.driverRecord?.id !== driverId) {
          return res.status(403).json({ error: 'غير مصرح لك بعرض كشف حساب سائق آخر' });
        }
      } else if (
        !hasPermission(req.dbUser, 'finance:read') &&
        !hasPermission(req.dbUser, 'advances:write') &&
        !hasPermission(req.dbUser, 'coverage:write')
      ) {
        return res.status(403).json({ error: 'ليس لديك صلاحية الاطلاع على الكشوف المالية' });
      }

      const runAs =
        req.dbUser?.roleSlug === 'driver'
          ? { role: 'driver', driverId }
          : { role: 'system', driverId: null };

      const payload = await runWithRlsContext(runAs, async () => {
        const allDrivers = await getEnrichedDrivers();
        const driver = allDrivers.find((d) => d.id === driverId);
        if (!driver) return { kind: 'not_found' as const };

        if (req.dbUser?.roleSlug !== 'driver' && !isSchoolAllowed(req.dbUser, driver.schoolId)) {
          return { kind: 'forbidden' as const };
        }

        const autoPeriod = String(req.query.autoPeriod || '').toLowerCase() === 'true';
        const schoolConfig = await getSchoolBillingConfigById(db, driver.schoolId);
        const activePeriod = await getActiveBillingPeriod(driver.schoolId);
        const autoRange = getCurrentBillingRangeForSchool(schoolConfig);
        const month = autoPeriod
          ? autoRange.month
          : Number(req.query.month) || activePeriod.month;
        const year = autoPeriod
          ? autoRange.year
          : Number(req.query.year) || activePeriod.year;
        const range = getBillingDateRangeForPeriod(month, year, schoolConfig);

        const salary = await getOrRecalculateDriverSalaryForRead(db, driverId, month, year, schoolConfig);

        const [driverAdvances, driverCoverages, transactions, todayAttRows] = await Promise.all([
          db
            .select()
            .from(advances)
            .where(
              and(
                eq(advances.driverId, driverId),
                gte(advances.date, range.startDate),
                lte(advances.date, range.endDate)
              )
            )
            .orderBy(desc(advances.date), desc(advances.id)),
          db
            .select()
            .from(coverageRecords)
            .where(
              and(
                or(
                  eq(coverageRecords.absentDriverId, driverId),
                  eq(coverageRecords.replacementDriverId, driverId)
                ),
                gte(coverageRecords.date, range.startDate),
                lte(coverageRecords.date, range.endDate)
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

        return {
          kind: 'ok' as const,
          data: {
            driver: {
              ...driver,
              todayAttendance: todayAtt?.status || 'present',
            },
            period: {
              month,
              year,
              startDate: range.startDate,
              endDate: range.endDate,
              labelAr: range.labelAr,
              shortLabelAr: range.shortLabelAr,
            },
            billingRange: range,
            salary: {
              ...salary,
              baseSalary: Number(salary.baseSalary),
              totalAdvances: Number(salary.totalAdvances),
              totalCoverageDeductions: Number(salary.totalCoverageDeductions),
              totalCoverageAdditions: Number(salary.totalCoverageAdditions || 0),
              otherDeductions: Number(salary.otherDeductions),
              bonuses: Number(salary.bonuses),
              netSalary: Number(salary.netSalary),
            },
            advances: driverAdvances.map((a) => ({ ...a, amount: Number(a.amount) })),
            coverages: driverCoverages.map((c) => {
              const unifiedAmt = Number(c.absentDriverDeduction || c.actualReplacementCost || 0);
              return {
                ...c,
                coverageRole: c.absentDriverId === driverId ? ('absent' as const) : ('replacement' as const),
                coverageAmount: unifiedAmt,
                absentDriverName: driverNameById[c.absentDriverId] || '—',
                replacementDriverName: c.replacementDriverId
                  ? driverNameById[c.replacementDriverId] || '—'
                  : c.replacementExternalName || 'سائق خارجي',
                actualReplacementCost: unifiedAmt,
                absentDriverDeduction: unifiedAmt,
              };
            }),
            transactions: transactions.map((t) => ({ ...t, amount: Number(t.amount) })),
          },
        };
      });

      if (payload.kind === 'not_found') {
        return res.status(404).json({ error: 'السائق غير موجود' });
      }
      if (payload.kind === 'forbidden') {
        return res.status(403).json({ error: 'هذا السائق تابع لمدرسة خارج نطاق صلاحياتك' });
      }

      res.json(payload.data);
    } catch (error) {
      console.error('Statement error:', error);
      res.status(500).json({ error: 'تعذر تحميل كشف حساب السائق' });
    }
  });

  // Lightweight allowed schools selector list for all authenticated staff/users
  app.get('/api/my-schools', requireAuth, async (req: AuthRequest, res) => {
    try {
      const allSchools = await db.select().from(schools).orderBy(schools.name);
      const scoped = allSchools
        .filter((s) => isSchoolAllowed(req.dbUser, s.id))
        .map((s) => ({
          id: s.id,
          name: s.name,
          isActive: s.isActive,
          billingCycleType: s.billingCycleType,
          billingCycleStartDay: s.billingCycleStartDay,
          billingCycleEndDay: s.billingCycleEndDay,
        }));
      res.json({ schools: scoped });
    } catch (error) {
      console.error('Get my-schools error:', error);
      res.status(500).json({ error: 'تعذر تحميل المدارس المصرح بها' });
    }
  });

  // 4. Schools, Vehicle Owners, Vehicles & Routes
  app.get('/api/schools', requireAuth, requireAdminOrStaff, requirePermission('schools:read'), async (req: AuthRequest, res) => {
    try {
      const activePeriod = await getActiveBillingPeriod();
      const [rawAllSchools, rawAllRoutes, enrichedDrivers, fleet] = await Promise.all([
        db.select().from(schools).orderBy(schools.name),
        db.select().from(routes).orderBy(routes.name),
        getEnrichedDrivers(),
        getFleetWithLatestGps(),
      ]);

      const allSchools = rawAllSchools.filter((s) => isSchoolAllowed(req.dbUser, s.id));
      const allRoutes = rawAllRoutes.filter((r) => isSchoolAllowed(req.dbUser, r.schoolId));

      const data = await runWithRlsContext({ role: 'system', driverId: null }, async () =>
        Promise.all(
          allSchools.map(async (s) => {
            const schoolCfg = (await getSchoolBillingConfigById(db, s.id)) || s;
            const rule = resolveSchoolBillingRule(schoolCfg);
            const scPeriod = await getActiveBillingPeriod(s.id);
            const currentBillingRange = getCurrentBillingRangeForSchool(schoolCfg);
            const activePeriodRange = getBillingDateRangeForPeriod(scPeriod.month, scPeriod.year, schoolCfg);

            const schoolVehicles = fleet.filter(
              (v) => v.schoolId === s.id && v.operationalStatus !== 'inactive'
            );
            const schoolDrivers = enrichedDrivers.filter(
              (d) => d.schoolId === s.id && d.accountStatus === 'active'
            );
            const schoolRoutes = allRoutes.filter((r) => r.schoolId === s.id);

            const driverSummaries = await Promise.all(
              schoolDrivers.map(async (d) => {
                const sal = await getOrRecalculateDriverSalaryForRead(
                  db,
                  d.id,
                  scPeriod.month,
                  scPeriod.year,
                  schoolCfg
                );
                const baseSalary = sal ? Number(sal.baseSalary) : Number(d.monthlyAgreedSalary || 0);
                const totalAdvances = sal ? Number(sal.totalAdvances) : 0;
                const totalCoverageDeductions = sal ? Number(sal.totalCoverageDeductions) : 0;
                const totalCoverageAdditions = sal ? Number(sal.totalCoverageAdditions || 0) : 0;
                const otherDeductions = sal ? Number(sal.otherDeductions) : 0;
                const bonuses = sal ? Number(sal.bonuses) : 0;
                const netSalary = sal ? Number(sal.netSalary) : baseSalary;
                return {
                  id: d.id,
                  driverCode: d.driverCode,
                  fullName: d.fullName,
                  phone: d.phone,
                  busNumber: d.busNumber,
                  routeName: d.routeName,
                  monthlyAgreedSalary: Number(d.monthlyAgreedSalary || 0),
                  baseSalary,
                  totalAdvances,
                  totalCoverageDeductions,
                  totalCoverageAdditions,
                  otherDeductions,
                  bonuses,
                  netSalary,
                  salaryStatus: sal?.status || 'open',
                };
              })
            );

            const totalDriverSalaries = driverSummaries.reduce((sum, d) => sum + d.baseSalary, 0);
            const totalNetDriverSalaries = driverSummaries.reduce((sum, d) => sum + d.netSalary, 0);
            const contractValue = Number(s.monthlyContractValue || 0);

            return {
              ...s,
              billingCycleType: rule.cycleType,
              billingCycleStartDay: rule.startDay,
              billingCycleEndDay: rule.endDay,
              customStartDate: rule.customStartDate || null,
              customEndDate: rule.customEndDate || null,
              activePeriod: { month: scPeriod.month, year: scPeriod.year },
              currentBillingRange: activePeriodRange || currentBillingRange,
              monthlyContractValue: contractValue,
              vehicleCount: schoolVehicles.length,
              driverCount: driverSummaries.length,
              totalDriverSalaries,
              totalNetDriverSalaries,
              estimatedProfit: contractValue - totalDriverSalaries,
              routes: schoolRoutes,
              vehicles: schoolVehicles,
              drivers: driverSummaries,
            };
          })
        )
      );

      res.json({ schools: data, routes: allRoutes, billingPeriod: activePeriod });
    } catch (error) {
      console.error('Get schools error:', error);
      res.status(500).json({ error: 'تعذر تحميل المدارس' });
    }
  });

  app.post('/api/schools', requireAuth, requireAdminOrStaff, requirePermission('schools:write'), async (req: AuthRequest, res) => {
    try {
      if (!isSchoolUnrestricted(req.dbUser)) {
        return res.status(403).json({ error: 'إضافة مدارس جديدة متاح لصلاحية جميع المدارس فقط' });
      }
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
        billingCycleType,
        billingCycleStartDay,
        billingCycleEndDay,
      } = req.body;
      const trimmedName = String(name || '').trim();
      if (!trimmedName) return res.status(400).json({ error: 'اسم المدرسة مطلوب' });

      const normalizedStartDay =
        billingCycleType === 'calendar' && billingCycleStartDay === undefined
          ? 1
          : billingCycleType === 'shifted' &&
            (billingCycleStartDay === undefined || Number(billingCycleStartDay) <= 1)
          ? 13
          : billingCycleStartDay !== undefined
          ? Number(billingCycleStartDay)
          : undefined;
      const billingRule = resolveSchoolBillingRule({
        name: trimmedName,
        billingCycleType,
        billingCycleStartDay: normalizedStartDay,
        billingCycleEndDay: billingCycleEndDay !== undefined ? Number(billingCycleEndDay) : undefined,
      });

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
              billingCycleType: billingRule.cycleType,
              billingCycleStartDay: billingRule.startDay,
              billingCycleEndDay: billingRule.endDay,
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
          billingCycleType: billingRule.cycleType,
          billingCycleStartDay: billingRule.startDay,
          billingCycleEndDay: billingRule.endDay,
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
      if (!isSchoolAllowed(req.dbUser, id)) {
        return res.status(403).json({ error: 'هذه المدرسة خارج نطاق صلاحياتك' });
      }
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
        billingCycleType,
        billingCycleStartDay,
        billingCycleEndDay,
      } = req.body;

      const nextName = name ?? existing.name;
      const requestedCycleType = billingCycleType ?? existing.billingCycleType;
      const requestedStartDay =
        billingCycleStartDay !== undefined
          ? Number(billingCycleStartDay)
          : billingCycleType === 'calendar'
          ? 1
          : billingCycleType === 'shifted' && Number(existing.billingCycleStartDay || 1) <= 1
          ? 13
          : existing.billingCycleStartDay;
      const requestedEndDay =
        billingCycleEndDay !== undefined
          ? Number(billingCycleEndDay)
          : existing.billingCycleEndDay;

      const resolvedRule = resolveSchoolBillingRule({
        name: nextName,
        billingCycleType: requestedCycleType,
        billingCycleStartDay: requestedStartDay,
        billingCycleEndDay: requestedEndDay,
      });

      const [updated] = await db
        .update(schools)
        .set({
          name: nextName,
          contactName: contactName ?? existing.contactName,
          contactPhone: contactPhone ?? existing.contactPhone,
          address: address ?? existing.address,
          monthlyContractValue:
            monthlyContractValue !== undefined
              ? Number(monthlyContractValue).toFixed(2)
              : existing.monthlyContractValue,
          contractStartDate: contractStartDate ?? existing.contractStartDate,
          contractEndDate: contractEndDate ?? existing.contractEndDate,
          billingCycleType: resolvedRule.cycleType,
          billingCycleStartDay: resolvedRule.startDay,
          billingCycleEndDay: resolvedRule.endDay,
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

  // التحكم المباشر في بداية ونهاية كل فترة شهرية لكل مدرسة
  app.get('/api/schools/:id/billing-period', requireAuth, requireAdminOrStaff, async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      if (!isSchoolAllowed(req.dbUser, id)) {
        return res.status(403).json({ error: 'هذه المدرسة خارج نطاق صلاحياتك' });
      }
      const schoolCfg = await getSchoolBillingConfigById(db, id);
      if (!schoolCfg) return res.status(404).json({ error: 'المدرسة غير موجودة' });
      const activePeriod = await getActiveBillingPeriod(id);
      const rule = resolveSchoolBillingRule(schoolCfg);
      const range = getBillingDateRangeForPeriod(activePeriod.month, activePeriod.year, schoolCfg);

      res.json({
        schoolId: id,
        schoolName: schoolCfg.name,
        cycleType: rule.cycleType,
        startDay: rule.startDay,
        endDay: rule.endDay,
        activeMonth: activePeriod.month,
        activeYear: activePeriod.year,
        customStartDate: schoolCfg.customStartDate || null,
        customEndDate: schoolCfg.customEndDate || null,
        currentRange: range,
      });
    } catch (error) {
      res.status(500).json({ error: 'تعذر جلب تفاصيل الفترة الشهرية للمدرسة' });
    }
  });

  app.put('/api/schools/:id/billing-period', requireAuth, requireAdminOrStaff, requireAnyPermission(['schools:write', 'finance:write']), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      if (!isSchoolAllowed(req.dbUser, id)) {
        return res.status(403).json({ error: 'هذه المدرسة خارج نطاق صلاحياتك' });
      }
      const [existing] = await db.select().from(schools).where(eq(schools.id, id)).limit(1);
      if (!existing) return res.status(404).json({ error: 'المدرسة غير موجودة' });

      const {
        cycleType,
        startDay,
        endDay,
        activeMonth,
        activeYear,
        customStartDate,
        customEndDate,
        resetToDefault,
      } = req.body;

      const schoolKey = getSchoolBillingPeriodKey(id);

      if (resetToDefault) {
        return await runWithRlsContext({ role: 'system', driverId: null }, async () => {
          await db.delete(billingPeriods).where(eq(billingPeriods.key, schoolKey));
          const isHilalDefault =
            existing.name.includes('هلالي') || existing.name.toLowerCase().includes('hilal');
          await db.update(schools).set({
            billingCycleType: isHilalDefault ? 'shifted' : 'calendar',
            billingCycleStartDay: isHilalDefault ? 13 : 1,
            billingCycleEndDay: isHilalDefault ? 12 : null,
          }).where(eq(schools.id, id));

          const updatedCfg = await getSchoolBillingConfigById(db, id);
          const auto = getCurrentBillingRangeForSchool(updatedCfg);
          return res.json({
            ok: true,
            message: 'تمت استعادة الدورة التلقائية للمدرسة بنجاح',
            billingPeriod: auto,
          });
        });
      }

      const cleanCustomStart =
        customStartDate && String(customStartDate).trim()
          ? normalizeIsoDateInput(String(customStartDate))
          : null;
      const cleanCustomEnd =
        customEndDate && String(customEndDate).trim()
          ? normalizeIsoDateInput(String(customEndDate))
          : null;

      if (cleanCustomStart && cleanCustomEnd && cleanCustomStart > cleanCustomEnd) {
        return res.status(400).json({ error: 'تاريخ بداية الفترة المخصصة يجب أن يكون قبل أو يساوي تاريخ النهاية' });
      }

      const nextCycleType = cycleType || existing.billingCycleType;
      const nextStartDay = startDay !== undefined ? Number(startDay) : existing.billingCycleStartDay;
      const nextEndDay = endDay !== undefined ? Number(endDay) : existing.billingCycleEndDay;

      const responsePayload = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        await db.update(schools).set({
          billingCycleType: nextCycleType,
          billingCycleStartDay: nextStartDay,
          billingCycleEndDay: nextEndDay,
        }).where(eq(schools.id, id));

        const nowPeriod = await getActiveBillingPeriod(id);
        const nextMonth = activeMonth !== undefined ? Number(activeMonth) : nowPeriod.month;
        const nextYear = activeYear !== undefined ? Number(activeYear) : nowPeriod.year;

        await db
          .insert(billingPeriods)
          .values({
            key: schoolKey,
            activeMonth: nextMonth,
            activeYear: nextYear,
            customStartDate: cleanCustomStart,
            customEndDate: cleanCustomEnd,
            updatedByUserId: req.dbUser!.id,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [billingPeriods.key],
            set: {
              activeMonth: nextMonth,
              activeYear: nextYear,
              customStartDate: cleanCustomStart,
              customEndDate: cleanCustomEnd,
              updatedByUserId: req.dbUser!.id,
              updatedAt: new Date(),
            },
          });

        const updatedSchoolCfg = await getSchoolBillingConfigById(db, id);
        const schoolDrivers = (await getEnrichedDrivers()).filter((d) => d.schoolId === id && d.accountStatus === 'active');
        for (const drv of schoolDrivers) {
          await recalculateDriverSalary(db, drv.id, nextMonth, nextYear, updatedSchoolCfg);
        }

        const activeRange = getBillingDateRangeForPeriod(nextMonth, nextYear, updatedSchoolCfg);

        await db.insert(auditLogs).values({
          actorUserId: req.dbUser!.id,
          action: 'UPDATE_SCHOOL_BILLING_PERIOD',
          entityType: 'schools',
          entityId: String(id),
          afterJson: {
            schoolId: id,
            activeMonth: nextMonth,
            activeYear: nextYear,
            customStartDate: cleanCustomStart,
            customEndDate: cleanCustomEnd,
            cycleType: nextCycleType,
            startDay: nextStartDay,
            endDay: nextEndDay,
            activeRange,
          },
          ipAddress: req.ip || '',
        });

        return {
          ok: true,
          message: 'تم تحديث الدورة المالية والفترة الشهرية للمدرسة بنجاح',
          schoolId: id,
          activeMonth: nextMonth,
          activeYear: nextYear,
          customStartDate: cleanCustomStart,
          customEndDate: cleanCustomEnd,
          range: activeRange,
        };
      });

      res.json(responsePayload);
    } catch (error) {
      console.error('Update school billing period error:', error);
      res.status(500).json({ error: 'تعذر تحديث الفترة الشهرية للمدرسة' });
    }
  });


  app.get('/api/vehicles', requireAuth, requireAdminOrStaff, requirePermission('vehicles:read'), async (req: AuthRequest, res) => {
    try {
      const fleet = (await getFleetWithLatestGps()).filter((v) =>
        isSchoolAllowed(req.dbUser, v.schoolId)
      );
      res.json({ vehicles: fleet });
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
        schoolId,
        schoolName,
        operationalStatus,
        notes,
      } = req.body;
      if (!busNumber || !registrationNumber) {
        return res.status(400).json({ error: 'رقم الباص ورقم اللوحة مطلوبان' });
      }
      const created = await db.transaction(async (tx) => {
        const defaultSchoolId =
          !isSchoolUnrestricted(req.dbUser) &&
          !schoolId &&
          (!schoolName || PLACEHOLDER_ASSIGNMENTS.has(String(schoolName).trim())) &&
          (req.dbUser?.assignedSchoolIds?.length || 0) === 1
            ? req.dbUser!.assignedSchoolIds[0]
            : schoolId;
        const resolvedSchoolId = await resolveSchoolIdForDriver(tx, {
          schoolId: defaultSchoolId,
          schoolName,
        });
        if (
          !isSchoolUnrestricted(req.dbUser) &&
          (!resolvedSchoolId || !isSchoolAllowed(req.dbUser, resolvedSchoolId))
        ) {
          throw new Error('SCHOOL_FORBIDDEN');
        }
        const [v] = await tx
          .insert(vehicles)
          .values({
            busNumber: String(busNumber).trim(),
            registrationNumber: String(registrationNumber).trim(),
            vehicleType: vehicleType || '',
            schoolId: resolvedSchoolId ?? null,
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
      if (error instanceof Error && error.message === 'SCHOOL_FORBIDDEN') {
        return res.status(403).json({ error: 'لا يمكنك إضافة مركبة خارج نطاق المدارس المصرح لك بها' });
      }
      console.error('Create vehicle error:', error);
      res.status(500).json({ error: 'تعذر إضافة المركبة (تأكد من عدم تكرار رقم الباص أو اللوحة)' });
    }
  });

  app.patch('/api/vehicles/:id', requireAuth, requireAdminOrStaff, requirePermission('vehicles:write'), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      const [existing] = await db.select().from(vehicles).where(eq(vehicles.id, id)).limit(1);
      if (!existing) return res.status(404).json({ error: 'المركبة غير موجودة' });

      if (!isSchoolUnrestricted(req.dbUser)) {
        const [assign] = await db
          .select({ schoolId: driverAssignments.schoolId })
          .from(driverAssignments)
          .where(and(eq(driverAssignments.vehicleId, id), eq(driverAssignments.isCurrent, true)))
          .limit(1);
        const effSchoolId = existing.schoolId ?? assign?.schoolId ?? null;
        if (!effSchoolId || !isSchoolAllowed(req.dbUser, effSchoolId)) {
          return res.status(403).json({ error: 'هذه المركبة خارج نطاق المدارس المصرح لك بها' });
        }
      }

      const {
        busNumber,
        registrationNumber,
        vehicleType,
        schoolId,
        schoolName,
        operationalStatus,
        notes,
      } = req.body;

      const updated = await db.transaction(async (tx) => {
        const nextSchoolId =
          schoolId !== undefined || schoolName !== undefined
            ? await resolveSchoolIdForDriver(tx, { schoolId, schoolName })
            : existing.schoolId;
        if (
          !isSchoolUnrestricted(req.dbUser) &&
          (schoolId !== undefined || schoolName !== undefined) &&
          (!nextSchoolId || !isSchoolAllowed(req.dbUser, nextSchoolId))
        ) {
          throw new Error('SCHOOL_FORBIDDEN');
        }
        const [v] = await tx
          .update(vehicles)
          .set({
            busNumber: busNumber ?? existing.busNumber,
            registrationNumber: registrationNumber ?? existing.registrationNumber,
            vehicleType: vehicleType ?? existing.vehicleType,
            schoolId: nextSchoolId ?? null,
            operationalStatus: operationalStatus ?? existing.operationalStatus,
            notes: notes ?? existing.notes,
          })
          .where(eq(vehicles.id, id))
          .returning();
        return v;
      });

      res.json({ vehicle: updated });
    } catch (error) {
      if (error instanceof Error && error.message === 'SCHOOL_FORBIDDEN') {
        return res.status(403).json({ error: 'لا يمكنك نقل المركبة لمدرسة خارج نطاق صلاحياتك' });
      }
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
      if (!isSchoolUnrestricted(req.dbUser)) {
        let targetSchoolId: number | null = schoolId ? Number(schoolId) : null;
        if (!targetSchoolId && schoolName) {
          const [sRow] = await db
            .select({ id: schools.id })
            .from(schools)
            .where(eq(schools.name, String(schoolName).trim()))
            .limit(1);
          targetSchoolId = sRow?.id ?? null;
        }
        if (!targetSchoolId || !isSchoolAllowed(req.dbUser, targetSchoolId)) {
          return res.status(403).json({ error: 'لا يمكنك إضافة خط سير خارج المدارس المعينة لك' });
        }
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
      if (!isSchoolAllowed(req.dbUser, existing.schoolId)) {
        return res.status(403).json({ error: 'خط السير خارج نطاق المدارس المصرح لك بها' });
      }

      const { name, schoolId, schoolName, pickupArea, dropoffArea, pickupTime, dropoffTime, estimatedDistanceKm } =
        req.body;

      const updated = await db.transaction(async (tx) => {
        const nextSchoolId =
          schoolName !== undefined || schoolId !== undefined
            ? await resolveSchoolIdForDriver(tx, { schoolId, schoolName })
            : existing.schoolId;
        if (!isSchoolUnrestricted(req.dbUser) && (!nextSchoolId || !isSchoolAllowed(req.dbUser, nextSchoolId))) {
          throw new Error('SCHOOL_FORBIDDEN');
        }
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
      if (error instanceof Error && error.message === 'SCHOOL_FORBIDDEN') {
        return res.status(403).json({ error: 'لا يمكنك نقل خط السير لمدرسة خارج نطاق صلاحياتك' });
      }
      console.error('Update route error:', error);
      res.status(500).json({ error: 'تعذر تحديث خط السير' });
    }
  });

  app.delete('/api/routes/:id', requireAuth, requireAdminOrStaff, requirePermission('routes:write'), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      const [existing] = await db.select().from(routes).where(eq(routes.id, id)).limit(1);
      if (!existing) return res.status(404).json({ error: 'خط السير غير موجود' });
      if (!isSchoolAllowed(req.dbUser, existing.schoolId)) {
        return res.status(403).json({ error: 'خط السير خارج نطاق المدارس المصرح لك بها' });
      }

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
  app.get(
    '/api/finance/overview',
    requireAuth,
    requireAdminOrStaff,
    requireAnyPermission(['finance:read', 'advances:write', 'coverage:write', 'finance:write']),
    async (req: AuthRequest, res) => {
      try {
        const rawSchoolIdParam = req.query.schoolId;
        const parsedSchoolId =
          rawSchoolIdParam && rawSchoolIdParam !== 'all' ? Number(rawSchoolIdParam) : null;
        const selectedSchoolId =
          parsedSchoolId && Number.isFinite(parsedSchoolId) ? parsedSchoolId : null;
        if (selectedSchoolId && !isSchoolAllowed(req.dbUser, selectedSchoolId)) {
          return res.status(403).json({ error: 'هذه المدرسة خارج نطاق صلاحياتك' });
        }

        const autoPeriod = String(req.query.autoPeriod || '').toLowerCase() === 'true';
        const unrestricted = isSchoolUnrestricted(req.dbUser);
        const overviewPayload = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
          const [rawAllSchools, closingsHistory, allDrivers] = await Promise.all([
            db.select().from(schools).orderBy(schools.name),
            getMonthlyClosingsHistory(),
            getEnrichedDrivers(),
          ]);

          const allSchools = rawAllSchools.filter((s) => isSchoolAllowed(req.dbUser, s.id));
          const selectedSchool = selectedSchoolId
            ? rawAllSchools.find((s) => s.id === selectedSchoolId) || null
            : null;

          const schoolConfigsById: Record<number, SchoolBillingConfig> = {};
          await Promise.all(
            allSchools.map(async (sc) => {
              const cfg = await getSchoolBillingConfigById(db, sc.id);
              if (cfg) schoolConfigsById[sc.id] = cfg;
            })
          );

          const defaultSchoolCfg = selectedSchoolId
            ? schoolConfigsById[selectedSchoolId] || (await getSchoolBillingConfigById(db, selectedSchoolId))
            : null;

          const activePeriod = await getActiveBillingPeriod(selectedSchoolId);
          let month = Number(req.query.month) || activePeriod.month;
          let year = Number(req.query.year) || activePeriod.year;
          if (autoPeriod) {
            const autoRange = getCurrentBillingRangeForSchool(defaultSchoolCfg || selectedSchool);
            month = autoRange.month;
            year = autoRange.year;
          }

          const schoolById: Record<number, (typeof allSchools)[number]> = {};
          for (const sc of allSchools) schoolById[sc.id] = sc;

          const rangeBySchoolKey = new Map<string, ReturnType<typeof getBillingDateRangeForPeriod>>();
          const defaultRange = getBillingDateRangeForPeriod(month, year, defaultSchoolCfg);
          rangeBySchoolKey.set('unassigned', getBillingDateRangeForPeriod(month, year, null));

          let minStartDate = defaultRange.startDate;
          let maxEndDate = defaultRange.endDate;
          for (const sc of allSchools) {
            const cfg = schoolConfigsById[sc.id] || sc;
            const r = getBillingDateRangeForPeriod(month, year, cfg);
            rangeBySchoolKey.set(String(sc.id), r);
            if (r.startDate < minStartDate) minStartDate = r.startDate;
            if (r.endDate > maxEndDate) maxEndDate = r.endDate;
          }
          const getRangeForSchoolId = (sId?: number | null) =>
            (sId ? rangeBySchoolKey.get(String(sId)) : undefined) ||
            rangeBySchoolKey.get('unassigned')!;

          const globalClosing =
            closingsHistory.find((c) => c.month === month && c.year === year && c.schoolId === null) ||
            null;
          const schoolClosing = selectedSchoolId
            ? closingsHistory.find(
                (c) => c.month === month && c.year === year && c.schoolId === selectedSchoolId
              ) || null
            : null;
          const currentClosing = selectedSchoolId ? schoolClosing || globalClosing : globalClosing;

          const isSchoolClosedForPeriod = (sId?: number | null) =>
            Boolean(globalClosing) ||
            Boolean(
              sId &&
                closingsHistory.some(
                  (c) => c.month === month && c.year === year && c.schoolId === sId
                )
            );

          const scopedDrivers = allDrivers.filter((d) => isSchoolAllowed(req.dbUser, d.schoolId));
          const activeDrivers = scopedDrivers.filter((d) => d.accountStatus === 'active');
          const activeDriverIds = new Set(activeDrivers.map((d) => d.id));
          const scopedDriverIds = new Set(scopedDrivers.map((d) => d.id));

          for (const d of activeDrivers) {
            if (!isSchoolClosedForPeriod(d.schoolId)) {
              const drvSchool = d.schoolId ? schoolConfigsById[d.schoolId] || null : null;
              await recalculateDriverSalary(db, d.id, month, year, drvSchool);
            }
          }

        const [
          rawMonthSalaries,
          rawWindowAdvances,
          rawWindowCoverages,
          rawMonthLedger,
          rawAllEmployees,
          rawAllVehicles,
          allSupervisorSummaries,
        ] = await Promise.all([
          db
            .select()
            .from(salaries)
            .where(and(eq(salaries.month, month), eq(salaries.year, year))),
          db
            .select()
            .from(advances)
            .where(
              selectedSchoolId
                ? or(
                    and(gte(advances.date, minStartDate), lte(advances.date, maxEndDate)),
                    eq(advances.schoolId, selectedSchoolId)
                  )
                : and(gte(advances.date, minStartDate), lte(advances.date, maxEndDate))
            )
            .orderBy(desc(advances.date), desc(advances.id)),
          db
            .select()
            .from(coverageRecords)
            .where(
              selectedSchoolId
                ? or(
                    and(gte(coverageRecords.date, minStartDate), lte(coverageRecords.date, maxEndDate)),
                    eq(coverageRecords.schoolId, selectedSchoolId)
                  )
                : and(gte(coverageRecords.date, minStartDate), lte(coverageRecords.date, maxEndDate))
            )
            .orderBy(desc(coverageRecords.date), desc(coverageRecords.id)),
          db
            .select()
            .from(financialTransactions)
            .where(and(eq(financialTransactions.month, month), eq(financialTransactions.year, year)))
            .orderBy(desc(financialTransactions.createdAt)),
          db.select().from(employees),
          db.select().from(vehicles),
          getSupervisorCycleSummaries({
            month,
            year,
            allowedSchoolIds: unrestricted ? null : req.dbUser?.assignedSchoolIds || [],
          }),
        ]);

        const driverMap: Record<number, (typeof allDrivers)[number]> = {};
        for (const d of allDrivers) driverMap[d.id] = d;

        // Strictly isolate advances & coverages by each driver/school's cycle [startDate, endDate]
        const monthAdvancesAll = rawWindowAdvances.filter((a) => {
          if (!unrestricted && !scopedDriverIds.has(a.driverId)) return false;
          const drv = driverMap[a.driverId];
          const recSchoolId = a.schoolId ?? drv?.schoolId ?? null;
          if (!isSchoolClosedForPeriod(recSchoolId) && !activeDriverIds.has(a.driverId)) return false;
          const recRange = getRangeForSchoolId(recSchoolId);
          return isDateInRange(a.date, recRange.startDate, recRange.endDate);
        });

        const monthCoveragesAll = rawWindowCoverages.filter((c) => {
          if (
            !unrestricted &&
            !scopedDriverIds.has(c.absentDriverId) &&
            !(c.schoolId != null && isSchoolAllowed(req.dbUser, c.schoolId))
          ) {
            return false;
          }
          const recSchoolId = c.schoolId ?? driverMap[c.absentDriverId]?.schoolId ?? null;
          if (!isSchoolClosedForPeriod(recSchoolId) && !activeDriverIds.has(c.absentDriverId)) return false;
          const recRange = getRangeForSchoolId(recSchoolId);
          return isDateInRange(c.date, recRange.startDate, recRange.endDate);
        });

        const monthLedgerAll = (unrestricted
          ? rawMonthLedger
          : rawMonthLedger.filter((t) => scopedDriverIds.has(t.driverId))
        ).filter((t) => {
          const drv = driverMap[t.driverId];
          return isSchoolClosedForPeriod(drv?.schoolId) || activeDriverIds.has(t.driverId);
        });
        const allEmployees = rawAllEmployees.filter((e) =>
          isSchoolAllowed(req.dbUser, e.schoolId)
        );

        const fleetForScope = await getFleetWithLatestGps();
        const scopedVehicleIds = new Set(
          fleetForScope
            .filter(
              (v) =>
                isSchoolAllowed(req.dbUser, v.schoolId) &&
                (!selectedSchoolId || v.schoolId === selectedSchoolId)
            )
            .map((v) => v.id)
        );
        const allVehicles = rawAllVehicles.filter((v) =>
          selectedSchoolId ? scopedVehicleIds.has(v.id) : unrestricted || scopedVehicleIds.has(v.id)
        );

        const monthSalariesAll = rawMonthSalaries
          .filter((s) => unrestricted || scopedDriverIds.has(s.driverId))
          .filter((s) => {
            const drv = driverMap[s.driverId];
            return isSchoolClosedForPeriod(drv?.schoolId) || activeDriverIds.has(s.driverId);
          });

        const enrichedSalariesAll = monthSalariesAll.map((s) => {
          const drv = driverMap[s.driverId];
          return {
            ...s,
            baseSalary: Number(s.baseSalary),
            totalAdvances: Number(s.totalAdvances),
            totalCoverageDeductions: Number(s.totalCoverageDeductions),
            totalCoverageAdditions: Number(s.totalCoverageAdditions || 0),
            otherDeductions: Number(s.otherDeductions),
            bonuses: Number(s.bonuses),
            netSalary: Number(s.netSalary),
            driverName: drv?.fullName || '—',
            driverCode: drv?.driverCode || '—',
            schoolId: drv?.schoolId ?? null,
            schoolName: drv?.schoolName || 'غير معين',
            busNumber: drv?.busNumber || '—',
            routeName: drv?.routeName || '—',
          };
        });

        const salariesBySchoolKey = new Map<string, typeof enrichedSalariesAll>();
        for (const sal of enrichedSalariesAll) {
          const key = sal.schoolId ? String(sal.schoolId) : 'unassigned';
          const list = salariesBySchoolKey.get(key) || [];
          list.push(sal);
          salariesBySchoolKey.set(key, list);
        }

        const supervisorsBySchoolKey = new Map<string, typeof allSupervisorSummaries>();
        for (const sup of allSupervisorSummaries) {
          if (sup.accountStatus !== 'active') continue;
          const key = sup.schoolId ? String(sup.schoolId) : 'unassigned';
          const list = supervisorsBySchoolKey.get(key) || [];
          list.push(sup);
          supervisorsBySchoolKey.set(key, list);
        }

        const schoolContracts = allSchools.map((sc) => {
          const scDrivers = salariesBySchoolKey.get(String(sc.id)) || [];
          const scSupervisors = supervisorsBySchoolKey.get(String(sc.id)) || [];
          const totalSupervisorSalaries = scSupervisors.reduce(
            (sum, sup) => sum + Number(sup.monthlySalary || 0),
            0
          );
          const monthlyContractValue = Number(sc.monthlyContractValue || 0);
          const totalBaseSalaries = scDrivers.reduce((sum, r) => sum + r.baseSalary, 0);
          const totalAdvances = scDrivers.reduce((sum, r) => sum + r.totalAdvances, 0);
          const totalCoverageDeductions = scDrivers.reduce(
            (sum, r) => sum + r.totalCoverageDeductions,
            0
          );
          const totalCoverageAdditions = scDrivers.reduce(
            (sum, r) => sum + r.totalCoverageAdditions,
            0
          );
          const totalOtherDeductions = scDrivers.reduce((sum, r) => sum + r.otherDeductions, 0);
          const totalBonuses = scDrivers.reduce((sum, r) => sum + r.bonuses, 0);
          const totalNetSalaries = scDrivers.reduce((sum, r) => sum + r.netSalary, 0);
          const profit = monthlyContractValue - totalBaseSalaries;
          const netPayoutProfit = monthlyContractValue - totalNetSalaries;
          const profitMarginPct =
            monthlyContractValue > 0 ? Math.round((profit / monthlyContractValue) * 1000) / 10 : 0;

          return {
            schoolId: sc.id,
            schoolName: sc.name,
            isActive: sc.isActive,
            monthlyContractValue,
            contactPerson: sc.contactName || '',
            contactPhone: sc.contactPhone || '',
            driversCount: scDrivers.length,
            supervisorsCount: scSupervisors.length,
            totalSupervisorSalaries,
            billingRange: getRangeForSchoolId(sc.id),
            totalBaseSalaries,
            totalAdvances,
            totalCoverageDeductions,
            totalCoverageAdditions,
            totalOtherDeductions,
            totalBonuses,
            totalNetSalaries,
            profit,
            netPayoutProfit,
            profitMarginPct,
            drivers: scDrivers,
          };
        });

        const unassignedDrivers = salariesBySchoolKey.get('unassigned') || [];
        if (unassignedDrivers.length > 0) {
          const scSupervisors = supervisorsBySchoolKey.get('unassigned') || [];
          const totalSupervisorSalaries = scSupervisors.reduce(
            (sum, sup) => sum + Number(sup.monthlySalary || 0),
            0
          );
          const totalBaseSalaries = unassignedDrivers.reduce((sum, r) => sum + r.baseSalary, 0);
          const totalAdvances = unassignedDrivers.reduce((sum, r) => sum + r.totalAdvances, 0);
          const totalCoverageDeductions = unassignedDrivers.reduce(
            (sum, r) => sum + r.totalCoverageDeductions,
            0
          );
          const totalCoverageAdditions = unassignedDrivers.reduce(
            (sum, r) => sum + r.totalCoverageAdditions,
            0
          );
          const totalOtherDeductions = unassignedDrivers.reduce(
            (sum, r) => sum + r.otherDeductions,
            0
          );
          const totalBonuses = unassignedDrivers.reduce((sum, r) => sum + r.bonuses, 0);
          const totalNetSalaries = unassignedDrivers.reduce((sum, r) => sum + r.netSalary, 0);
          schoolContracts.push({
            schoolId: null as unknown as number,
            schoolName: 'سائقون غير معينين بمدرسة',
            isActive: true,
            monthlyContractValue: 0,
            contactPerson: '',
            contactPhone: '',
            driversCount: unassignedDrivers.length,
            supervisorsCount: scSupervisors.length,
            totalSupervisorSalaries,
            billingRange: getRangeForSchoolId(null),
            totalBaseSalaries,
            totalAdvances,
            totalCoverageDeductions,
            totalCoverageAdditions,
            totalOtherDeductions,
            totalBonuses,
            totalNetSalaries,
            profit: -totalBaseSalaries,
            netPayoutProfit: -totalNetSalaries,
            profitMarginPct: 0,
            drivers: unassignedDrivers,
          });
        }

        const enrichedSalaries = selectedSchoolId
          ? enrichedSalariesAll.filter((s) => s.schoolId === selectedSchoolId)
          : enrichedSalariesAll;
        const monthAdvances = selectedSchoolId
          ? monthAdvancesAll.filter(
              (a) => (a.schoolId ?? driverMap[a.driverId]?.schoolId) === selectedSchoolId
            )
          : monthAdvancesAll;
        const monthCoverages = selectedSchoolId
          ? monthCoveragesAll.filter(
              (c) => (c.schoolId ?? driverMap[c.absentDriverId]?.schoolId) === selectedSchoolId
            )
          : monthCoveragesAll;
        const monthLedger = selectedSchoolId
          ? monthLedgerAll.filter((t) => driverMap[t.driverId]?.schoolId === selectedSchoolId)
          : monthLedgerAll;
        const scopedSupervisors = selectedSchoolId
          ? allSupervisorSummaries.filter((s) => s.schoolId === selectedSchoolId)
          : allSupervisorSummaries;

        const targetContracts = selectedSchoolId
          ? schoolContracts.filter((c) => c.schoolId === selectedSchoolId && c.isActive)
          : schoolContracts.filter((c) => c.schoolId !== null && c.isActive);

        const totalContractsValue = targetContracts.reduce(
          (sum, c) => sum + c.monthlyContractValue,
          0
        );
        const totalAllBaseSalaries = (
          selectedSchoolId
            ? schoolContracts.filter((c) => c.schoolId === selectedSchoolId)
            : schoolContracts
        ).reduce((sum, c) => sum + c.totalBaseSalaries, 0);
        const totalAllNetSalaries = (
          selectedSchoolId
            ? schoolContracts.filter((c) => c.schoolId === selectedSchoolId)
            : schoolContracts
        ).reduce((sum, c) => sum + c.totalNetSalaries, 0);
        const totalAllProfit = totalContractsValue - totalAllBaseSalaries;

        const totalDriverAdvances = enrichedSalaries.reduce((sum, s) => sum + s.totalAdvances, 0);
        const totalCoverageDriverDeductions = enrichedSalaries.reduce(
          (sum, s) => sum + s.totalCoverageDeductions,
          0
        );
        const totalCoverageAdditions = enrichedSalaries.reduce(
          (sum, s) => sum + s.totalCoverageAdditions,
          0
        );
        const totalOtherDeductions = enrichedSalaries.reduce((sum, s) => sum + s.otherDeductions, 0);
        const totalBonuses = enrichedSalaries.reduce((sum, s) => sum + s.bonuses, 0);
        const unifiedCoverageAmount = monthCoverages
          .filter((c) => !c.isReversed)
          .reduce(
            (sum, c) => sum + Number(c.absentDriverDeduction || c.actualReplacementCost || 0),
            0
          );
        const totalCoverageReplacementCost = unifiedCoverageAmount;
        const totalPaidSalaries = enrichedSalaries
          .filter((s) => s.status === 'paid')
          .reduce((sum, s) => sum + s.netSalary, 0);
        const totalUnpaidSalaries = enrichedSalaries
          .filter((s) => s.status !== 'paid')
          .reduce((sum, s) => sum + s.netSalary, 0);

        const activeEmployees = allEmployees.filter(
          (e) => e.status === 'active' && (!selectedSchoolId || e.schoolId === selectedSchoolId)
        );
        const totalEmployeeBaseSalaries = activeEmployees.reduce(
          (sum, e) => sum + Number(e.monthlySalary || 0),
          0
        );
        const totalEmployeeBonuses = activeEmployees.reduce(
          (sum, e) => sum + Number(e.bonuses || 0),
          0
        );
        const totalEmployeeDeductions = activeEmployees.reduce(
          (sum, e) => sum + Number(e.deductions || 0),
          0
        );
        const totalEmployeeNetSalaries = activeEmployees.reduce((sum, e) => {
          const net = Math.max(
            0,
            Number(e.monthlySalary || 0) + Number(e.bonuses || 0) - Number(e.deductions || 0)
          );
          return sum + net;
        }, 0);

        const activeSupervisors = scopedSupervisors.filter((s) => s.accountStatus === 'active');
        const totalSupervisorSalaries = activeSupervisors.reduce(
          (sum, s) => sum + Number(s.monthlySalary || 0),
          0
        );

        const activeVehicles = allVehicles.filter((v) => v.operationalStatus !== 'inactive');

        const totalLedgerCredits = monthLedger
          .filter((t) => t.direction === 'credit')
          .reduce((sum, t) => sum + Number(t.amount || 0), 0);
        const totalLedgerDebits = monthLedger
          .filter((t) => t.direction === 'debit')
          .reduce((sum, t) => sum + Number(t.amount || 0), 0);

        const totalCombinedPayroll =
          totalAllNetSalaries + totalEmployeeNetSalaries + totalSupervisorSalaries;
        // Coverage is a transfer from absent driver to replacement driver — must NOT be deducted twice
        const overallNetBalance =
          totalContractsValue -
          (totalAllBaseSalaries + totalEmployeeNetSalaries + totalSupervisorSalaries);

          return {
            period: {
              month,
              year,
              startDate: defaultRange.startDate,
              endDate: defaultRange.endDate,
              startDateTime: defaultRange.startDateTime,
              endDateTime: defaultRange.endDateTime,
              labelAr: defaultRange.labelAr,
              shortLabelAr: defaultRange.shortLabelAr,
              schoolId: selectedSchoolId,
              schoolName: selectedSchool?.name || null,
              isAutoTodayPeriod: autoPeriod,
            },
            activePeriod,
            currentClosing,
            closingsHistory,
            schoolContracts,
            supervisors: scopedSupervisors,
            contractsSummary: {
              schoolsCount: targetContracts.length,
              totalContractsValue,
              totalAllBaseSalaries,
              totalAllNetSalaries,
              totalAllProfit,
            },
            grandTotals: {
              schoolsCount: targetContracts.length,
              driversCount: enrichedSalaries.length,
              employeesCount: activeEmployees.length,
              supervisorsCount: activeSupervisors.length,
              vehiclesCount: activeVehicles.length,
              totalSchoolContracts: totalContractsValue,
              totalDriverBaseSalaries: totalAllBaseSalaries,
              totalDriverAdvances,
              totalCoverageAmount: unifiedCoverageAmount,
              totalCoverageReplacementCost,
              totalCoverageDriverDeductions,
              totalCoverageAdditions,
              totalOtherDeductions,
              totalBonuses,
              totalDriverNetSalaries: totalAllNetSalaries,
              totalPaidSalaries,
              totalUnpaidSalaries,
              totalEmployeeBaseSalaries,
              totalEmployeeBonuses,
              totalEmployeeDeductions,
              totalEmployeeNetSalaries,
              totalSupervisorSalaries,
              totalCombinedPayroll,
              totalLedgerCredits,
              totalLedgerDebits,
              netLedgerBalance: totalLedgerCredits - totalLedgerDebits,
              contractsProfitAfterDrivers: totalAllProfit,
              overallNetBalance,
            },
            salaries: enrichedSalaries,
            advances: monthAdvances.map((a) => ({
              ...a,
              amount: Number(a.amount),
              driverName: driverMap[a.driverId]?.fullName || '—',
              driverCode: driverMap[a.driverId]?.driverCode || '—',
              schoolId: a.schoolId ?? driverMap[a.driverId]?.schoolId ?? null,
              schoolName:
                (a.schoolId && schoolById[a.schoolId]?.name) ||
                driverMap[a.driverId]?.schoolName ||
                '—',
            })),
            coverages: monthCoverages.map((c) => {
              const unifiedAmt = Number(c.absentDriverDeduction || c.actualReplacementCost || 0);
              return {
                ...c,
                coverageAmount: unifiedAmt,
                actualReplacementCost: unifiedAmt,
                absentDriverDeduction: unifiedAmt,
                absentDriverName: driverMap[c.absentDriverId]?.fullName || '—',
                absentDriverCode: driverMap[c.absentDriverId]?.driverCode || '—',
                replacementDriverName: c.replacementDriverId
                  ? driverMap[c.replacementDriverId]?.fullName || '—'
                  : c.replacementExternalName || 'سائق خارجي',
                schoolId: c.schoolId ?? driverMap[c.absentDriverId]?.schoolId ?? null,
                schoolName:
                  (c.schoolId && schoolById[c.schoolId]?.name) ||
                  driverMap[c.absentDriverId]?.schoolName ||
                  '—',
                busNumber: driverMap[c.absentDriverId]?.busNumber || '—',
              };
            }),
            ledger: monthLedger.map((t) => ({
              ...t,
              amount: Number(t.amount),
              driverName: driverMap[t.driverId]?.fullName || '—',
              driverCode: driverMap[t.driverId]?.driverCode || '—',
              schoolId: driverMap[t.driverId]?.schoolId ?? null,
              schoolName: driverMap[t.driverId]?.schoolName || '—',
            })),
          };
        });
        res.json(overviewPayload);
      } catch (error) {
        console.error('Finance overview error:', error);
        res.status(500).json({ error: 'تعذر تحميل البيانات المالية' });
      }
    }
  );

  app.post('/api/finance/advances', requireAuth, requireAdminOrStaff, requireAnyPermission(['finance:write', 'advances:write']), async (req: AuthRequest, res) => {
    try {
      const {
        driverId,
        driverQuery,
        amount,
        date,
        reason,
        paymentMethod,
        notes,
        idempotencyKey,
        schoolId,
        schoolName,
        targetMonth,
        targetYear,
      } = req.body;
      const numericAmount = Number(amount);
      if ((!driverId && !driverQuery) || !Number.isFinite(numericAmount) || numericAmount <= 0 || !date) {
        return res.status(400).json({ error: 'يرجى كتابة اسم أو كود سائق مسجل ومبلغ صحيح وتاريخ' });
      }
      const cleanDate = normalizeIsoDateInput(String(date));

      const outcome = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        const resolvedDriver = await resolveDriverByIdOrQuery({ driverId, driverQuery });
        if (!resolvedDriver) {
          return {
            status: 400 as const,
            body: { error: 'لم يتم العثور على السائق بهذا الاسم أو الكود' },
          };
        }
        const rawSchoolId = schoolId ? Number(schoolId) : null;
        const drvSchoolId =
          rawSchoolId && Number.isFinite(rawSchoolId)
            ? rawSchoolId
            : await getDriverCurrentSchoolId(resolvedDriver.id);
        if (drvSchoolId && !isSchoolAllowed(req.dbUser, drvSchoolId)) {
          return {
            status: 403 as const,
            body: { error: 'هذا السائق تابع لمدرسة خارج نطاق صلاحياتك' },
          };
        }
        const result = await recordAdvanceTransaction({
          driverId: resolvedDriver.id,
          schoolId: drvSchoolId,
          schoolName: schoolName ? String(schoolName).trim() : undefined,
          targetMonth: targetMonth ? Number(targetMonth) : null,
          targetYear: targetYear ? Number(targetYear) : null,
          amount: numericAmount,
          date: cleanDate,
          reason: reason ? String(reason).trim() : '',
          paymentMethod: paymentMethod ? String(paymentMethod).trim() : '',
          notes: notes || '',
          recordedByUserId: req.dbUser!.id,
          idempotencyKey: idempotencyKey ? String(idempotencyKey) : undefined,
          ipAddress: req.ip || '',
        });
        return {
          status: (result.duplicate ? 200 : 201) as 200 | 201,
          body: result,
        };
      });
      res.status(outcome.status).json(outcome.body);
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
        schoolName,
        targetMonth,
        targetYear,
        date,
        coverageAmount,
        actualReplacementCost,
        absentDriverDeduction,
        reason,
        notes,
        idempotencyKey,
      } = req.body;
      if ((!absentDriverId && !absentDriverQuery) || !date) {
        return res.status(400).json({ error: 'يرجى كتابة اسم أو كود السائق الغائب والتاريخ' });
      }
      const cleanDate = normalizeIsoDateInput(String(date));
      const unifiedAmount = Number(
        coverageAmount ?? absentDriverDeduction ?? actualReplacementCost ?? 0
      );

      const outcome = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        const resolvedAbsent = await resolveDriverByIdOrQuery({
          driverId: absentDriverId,
          driverQuery: absentDriverQuery,
        });
        if (!resolvedAbsent) {
          return {
            status: 400 as const,
            body: { error: 'يرجى كتابة اسم أو كود السائق الغائب بشكل صحيح' },
          };
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

        if (nextSchoolId && !isSchoolAllowed(req.dbUser, nextSchoolId)) {
          return {
            status: 403 as const,
            body: { error: 'هذا السائق تابع لمدرسة خارج نطاق صلاحياتك' },
          };
        }

        const result = await recordCoverageTransaction({
          absentDriverId: resolvedAbsent.id,
          replacementDriverId: resolvedRep ? resolvedRep.id : null,
          replacementExternalName: resolvedRep ? '' : repText,
          vehicleId: nextVehicleId,
          schoolId: nextSchoolId,
          schoolName: schoolName ? String(schoolName).trim() : undefined,
          targetMonth: targetMonth ? Number(targetMonth) : null,
          targetYear: targetYear ? Number(targetYear) : null,
          date: cleanDate,
          coverageAmount: unifiedAmount,
          reason: reason ? String(reason).trim() : '',
          notes: notes || '',
          recordedByUserId: req.dbUser!.id,
          idempotencyKey: idempotencyKey ? String(idempotencyKey) : undefined,
          ipAddress: req.ip || '',
        });
        return {
          status: (result.duplicate ? 200 : 201) as 200 | 201,
          body: result,
        };
      });

      res.status(outcome.status).json(outcome.body);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'تعذر تسجيل تغطية الغياب';
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/finance/adjustments', requireAuth, requireAdminOrStaff, requirePermission('finance:write'), async (req: AuthRequest, res) => {
    try {
      const { driverId, driverQuery, month, year, type, amount, description } = req.body;
      if ((!driverId && !driverQuery) || !type || !amount || !description) {
        return res.status(400).json({ error: 'يرجى كتابة السائق والنوع والمبلغ والبيان' });
      }
      if (type !== 'bonus' && type !== 'other_deduction') {
        return res.status(400).json({ error: 'نوع التسوية غير صحيح' });
      }
      const outcome = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        const resolvedDriver = await resolveDriverByIdOrQuery({ driverId, driverQuery });
        if (!resolvedDriver) {
          return { status: 400 as const, body: { error: 'يرجى تحديد سائق مسجل' } };
        }
        const drvSchoolId = await getDriverCurrentSchoolId(resolvedDriver.id);
        if (!isSchoolAllowed(req.dbUser, drvSchoolId)) {
          return {
            status: 403 as const,
            body: { error: 'هذا السائق تابع لمدرسة خارج نطاق صلاحياتك' },
          };
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
        return { status: 201 as const, body: result };
      });
      res.status(outcome.status).json(outcome.body);
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
      const outcome = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        if (!isSchoolUnrestricted(req.dbUser)) {
          const [ft] = await db
            .select({ driverId: financialTransactions.driverId })
            .from(financialTransactions)
            .where(eq(financialTransactions.id, id))
            .limit(1);
          if (ft) {
            const drvSchoolId = await getDriverCurrentSchoolId(ft.driverId);
            if (!isSchoolAllowed(req.dbUser, drvSchoolId)) {
              return {
                status: 403 as const,
                body: { error: 'هذه الحركة تابعة لمدرسة خارج نطاق صلاحياتك' },
              };
            }
          }
        }
        const result = await updateAdjustmentTransaction({
          id,
          type,
          amount: Number(amount),
          description: String(description || ''),
          recordedByUserId: req.dbUser!.id,
          ipAddress: req.ip || '',
        });
        return { status: 200 as const, body: result };
      });
      res.status(outcome.status).json(outcome.body);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'تعذر تعديل التسوية المالية';
      res.status(400).json({ error: msg });
    }
  });

  app.delete('/api/finance/adjustments/:id', requireAuth, requireAdminOrStaff, requirePermission('finance:write'), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'معرف التسوية غير صالح' });
      const outcome = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        if (!isSchoolUnrestricted(req.dbUser)) {
          const [ft] = await db
            .select({ driverId: financialTransactions.driverId })
            .from(financialTransactions)
            .where(eq(financialTransactions.id, id))
            .limit(1);
          if (ft) {
            const drvSchoolId = await getDriverCurrentSchoolId(ft.driverId);
            if (!isSchoolAllowed(req.dbUser, drvSchoolId)) {
              return {
                status: 403 as const,
                body: { error: 'هذه الحركة تابعة لمدرسة خارج نطاق صلاحياتك' },
              };
            }
          }
        }
        const result = await deleteAdjustmentTransaction({
          id,
          recordedByUserId: req.dbUser!.id,
          ipAddress: req.ip || '',
        });
        return { status: 200 as const, body: result };
      });
      res.status(outcome.status).json(outcome.body);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'تعذر حذف التسوية المالية';
      res.status(400).json({ error: msg });
    }
  });

  app.patch('/api/finance/advances/:id', requireAuth, requireAdminOrStaff, requireAnyPermission(['finance:write', 'advances:write']), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      const { amount, date, reason, paymentMethod, notes } = req.body;
      if (!id || !amount || !date) {
        return res.status(400).json({ error: 'بيانات تعديل السلفة غير مكتملة' });
      }
      const cleanDate = normalizeIsoDateInput(String(date));
      const outcome = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        if (!isSchoolUnrestricted(req.dbUser)) {
          const [advRow] = await db
            .select({ driverId: advances.driverId, schoolId: advances.schoolId })
            .from(advances)
            .where(eq(advances.id, id))
            .limit(1);
          if (advRow) {
            const drvSchoolId = advRow.schoolId ?? (await getDriverCurrentSchoolId(advRow.driverId));
            if (!isSchoolAllowed(req.dbUser, drvSchoolId)) {
              return {
                status: 403 as const,
                body: { error: 'هذه السلفة تابعة لمدرسة خارج نطاق صلاحياتك' },
              };
            }
          }
        }
        const result = await updateAdvanceTransaction({
          id,
          amount: Number(amount),
          date: cleanDate,
          reason: reason !== undefined ? String(reason).trim() : '',
          paymentMethod: paymentMethod !== undefined ? String(paymentMethod).trim() : '',
          notes: notes !== undefined ? String(notes) : '',
          recordedByUserId: req.dbUser!.id,
          ipAddress: req.ip || '',
        });
        return { status: 200 as const, body: result };
      });
      res.status(outcome.status).json(outcome.body);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'تعذر تعديل السلفة';
      res.status(400).json({ error: msg });
    }
  });

  app.delete('/api/finance/advances/:id', requireAuth, requireAdminOrStaff, requireAnyPermission(['finance:write', 'advances:write']), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'معرف السلفة غير صالح' });
      const outcome = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        if (!isSchoolUnrestricted(req.dbUser)) {
          const [advRow] = await db
            .select({ driverId: advances.driverId, schoolId: advances.schoolId })
            .from(advances)
            .where(eq(advances.id, id))
            .limit(1);
          if (advRow) {
            const drvSchoolId = advRow.schoolId ?? (await getDriverCurrentSchoolId(advRow.driverId));
            if (!isSchoolAllowed(req.dbUser, drvSchoolId)) {
              return {
                status: 403 as const,
                body: { error: 'هذه السلفة تابعة لمدرسة خارج نطاق صلاحياتك' },
              };
            }
          }
        }
        const result = await deleteAdvanceTransaction({
          id,
          recordedByUserId: req.dbUser!.id,
          ipAddress: req.ip || '',
        });
        return { status: 200 as const, body: result };
      });
      res.status(outcome.status).json(outcome.body);
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
        coverageAmount,
        actualReplacementCost,
        absentDriverDeduction,
        reason,
        notes,
      } = req.body;
      if (!id || !date) {
        return res.status(400).json({ error: 'بيانات تعديل التغطية غير مكتملة' });
      }
      const cleanDate = normalizeIsoDateInput(String(date));
      const unifiedAmount = Number(
        coverageAmount ?? absentDriverDeduction ?? actualReplacementCost ?? 0
      );
      const outcome = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        if (!isSchoolUnrestricted(req.dbUser)) {
          const [covRow] = await db
            .select({ absentDriverId: coverageRecords.absentDriverId, schoolId: coverageRecords.schoolId })
            .from(coverageRecords)
            .where(eq(coverageRecords.id, id))
            .limit(1);
          if (covRow) {
            const targetSchoolId = covRow.schoolId ?? (await getDriverCurrentSchoolId(covRow.absentDriverId));
            if (!isSchoolAllowed(req.dbUser, targetSchoolId)) {
              return {
                status: 403 as const,
                body: { error: 'هذه التغطية تابعة لمدرسة خارج نطاق صلاحياتك' },
              };
            }
          }
        }
        const repText = String(replacementQuery ?? replacementExternalName ?? '').trim();
        const resolvedRep = replacementDriverId
          ? await resolveDriverByIdOrQuery({ driverId: replacementDriverId })
          : repText
          ? await resolveDriverByIdOrQuery({ driverQuery: repText })
          : null;

        const result = await updateCoverageTransaction({
          id,
          replacementDriverId: resolvedRep ? resolvedRep.id : null,
          replacementExternalName: resolvedRep ? '' : repText,
          date: cleanDate,
          coverageAmount: unifiedAmount,
          reason: reason !== undefined ? String(reason).trim() : '',
          notes: notes !== undefined ? String(notes) : '',
          recordedByUserId: req.dbUser!.id,
          ipAddress: req.ip || '',
        });
        return { status: 200 as const, body: result };
      });
      res.status(outcome.status).json(outcome.body);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'تعذر تعديل سجل التغطية';
      res.status(400).json({ error: msg });
    }
  });

  app.delete('/api/finance/coverage/:id', requireAuth, requireAdminOrStaff, requireAnyPermission(['finance:write', 'coverage:write']), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'معرف التغطية غير صالح' });
      const outcome = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        if (!isSchoolUnrestricted(req.dbUser)) {
          const [covRow] = await db
            .select({ absentDriverId: coverageRecords.absentDriverId, schoolId: coverageRecords.schoolId })
            .from(coverageRecords)
            .where(eq(coverageRecords.id, id))
            .limit(1);
          if (covRow) {
            const targetSchoolId = covRow.schoolId ?? (await getDriverCurrentSchoolId(covRow.absentDriverId));
            if (!isSchoolAllowed(req.dbUser, targetSchoolId)) {
              return {
                status: 403 as const,
                body: { error: 'هذه التغطية تابعة لمدرسة خارج نطاق صلاحياتك' },
              };
            }
          }
        }
        const result = await deleteCoverageTransaction({
          id,
          recordedByUserId: req.dbUser!.id,
          ipAddress: req.ip || '',
        });
        return { status: 200 as const, body: result };
      });
      res.status(outcome.status).json(outcome.body);
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
      const outcome = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        if (!isSchoolUnrestricted(req.dbUser)) {
          if (targetType === 'advance') {
            const [advRow] = await db
              .select({ driverId: advances.driverId, schoolId: advances.schoolId })
              .from(advances)
              .where(eq(advances.id, Number(targetId)))
              .limit(1);
            if (advRow) {
              const sId = advRow.schoolId ?? (await getDriverCurrentSchoolId(advRow.driverId));
              if (!isSchoolAllowed(req.dbUser, sId)) {
                return {
                  status: 403 as const,
                  body: { error: 'هذه الحركة خارج نطاق المدارس المصرح لك بها' },
                };
              }
            }
          } else {
            const [covRow] = await db
              .select({ absentDriverId: coverageRecords.absentDriverId, schoolId: coverageRecords.schoolId })
              .from(coverageRecords)
              .where(eq(coverageRecords.id, Number(targetId)))
              .limit(1);
            if (covRow) {
              const sId = covRow.schoolId ?? (await getDriverCurrentSchoolId(covRow.absentDriverId));
              if (!isSchoolAllowed(req.dbUser, sId)) {
                return {
                  status: 403 as const,
                  body: { error: 'هذه الحركة خارج نطاق المدارس المصرح لك بها' },
                };
              }
            }
          }
        }
        const result = await reverseFinancialRecord({
          targetType,
          targetId: Number(targetId),
          reason: reason || 'تصحيح قيد مالي',
          recordedByUserId: req.dbUser!.id,
          ipAddress: req.ip || '',
        });
        return { status: 200 as const, body: result };
      });
      res.status(outcome.status).json(outcome.body);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'تعذر تنفيذ قيد العكس';
      res.status(400).json({ error: msg });
    }
  });

  // 5a. Financial Ledger Permanent Deletion (حذف القيود المالية من دفتر الأستاذ مع عكس وتصفية السجلات المرتبطة)
  app.delete(
    '/api/finance/ledger/:id',
    requireAuth,
    requireAdminOrStaff,
    requirePermission('finance:write'),
    async (req: AuthRequest, res) => {
      try {
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ error: 'معرف الحركة غير صالح' });

        const outcome = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
          const [txRow] = await db
            .select()
            .from(financialTransactions)
            .where(eq(financialTransactions.id, id))
            .limit(1);

          if (!txRow) {
            return { status: 404 as const, body: { error: 'الحركة المالية غير موجودة' } };
          }

          const drvSchoolId = await getDriverCurrentSchoolId(txRow.driverId);
          if (!isSchoolUnrestricted(req.dbUser) && !isSchoolAllowed(req.dbUser, drvSchoolId)) {
            return {
              status: 403 as const,
              body: { error: 'هذه الحركة تابعة لمدرسة خارج نطاق صلاحياتك' },
            };
          }

          const result = await db.transaction(async (tx) => {
            let deletedAdvanceId: number | null = null;
            let deletedCoverageId: number | null = null;
            let replacementDriverId: number | null = null;

            if (txRow.referenceType === 'advance' && txRow.referenceId) {
              deletedAdvanceId = txRow.referenceId;
              await tx
                .delete(financialTransactions)
                .where(
                  and(
                    eq(financialTransactions.referenceType, 'advance'),
                    eq(financialTransactions.referenceId, txRow.referenceId)
                  )
                );
              await tx.delete(advances).where(eq(advances.id, txRow.referenceId));
            } else if (txRow.referenceType === 'coverage' && txRow.referenceId) {
              deletedCoverageId = txRow.referenceId;
              const [covRow] = await tx
                .select()
                .from(coverageRecords)
                .where(eq(coverageRecords.id, txRow.referenceId))
                .limit(1);

              if (covRow) {
                replacementDriverId = covRow.replacementDriverId;
                await tx
                  .delete(financialTransactions)
                  .where(
                    and(
                      eq(financialTransactions.referenceType, 'coverage'),
                      eq(financialTransactions.referenceId, txRow.referenceId)
                    )
                  );
                await tx
                  .delete(attendance)
                  .where(
                    and(
                      eq(attendance.driverId, covRow.absentDriverId),
                      eq(attendance.date, covRow.date),
                      eq(attendance.status, 'covered')
                    )
                  );
                await tx.delete(coverageRecords).where(eq(coverageRecords.id, txRow.referenceId));
              }
            } else {
              await tx.delete(financialTransactions).where(eq(financialTransactions.id, id));
            }

            const schoolCfg = await getDriverSchoolBillingConfig(tx, txRow.driverId);
            const salary = await recalculateDriverSalary(
              tx,
              txRow.driverId,
              txRow.month,
              txRow.year,
              schoolCfg
            );

            if (replacementDriverId) {
              const repSchoolCfg = await getDriverSchoolBillingConfig(tx, replacementDriverId);
              await recalculateDriverSalary(
                tx,
                replacementDriverId,
                txRow.month,
                txRow.year,
                repSchoolCfg
              );
            }

            await tx.insert(auditLogs).values({
              actorUserId: req.dbUser!.id,
              action: 'DELETE_LEDGER_TRANSACTION',
              entityType: 'financial_transactions',
              entityId: String(id),
              beforeJson: txRow,
              ipAddress: req.ip || '',
            });

            return {
              deletedId: id,
              deletedAdvanceId,
              deletedCoverageId,
              salary,
            };
          });

          return { status: 200 as const, body: { ok: true, ...result } };
        });

        res.status(outcome.status).json(outcome.body);
      } catch (error: unknown) {
        console.error('Delete ledger transaction error:', error);
        const msg = error instanceof Error ? error.message : 'تعذر حذف القيد المالي';
        res.status(400).json({ error: msg });
      }
    }
  );

  // 5b. Financial Custodies Management (العهد المالية - تسليم واستلام وتصفية)
  app.get(
    '/api/finance/custodies',
    requireAuth,
    requireAdminOrStaff,
    requireAnyPermission(['finance:read', 'finance:write']),
    async (req: AuthRequest, res) => {
      try {
        const rawSchoolIdParam = req.query.schoolId;
        const selectedSchoolId =
          rawSchoolIdParam && rawSchoolIdParam !== 'all' ? Number(rawSchoolIdParam) : null;
        if (selectedSchoolId && !isSchoolAllowed(req.dbUser, selectedSchoolId)) {
          return res.status(403).json({ error: 'هذه المدرسة خارج نطاق صلاحياتك' });
        }
        const statusFilter = req.query.status ? String(req.query.status) : null;
        const beneficiaryTypeFilter = req.query.beneficiaryType ? String(req.query.beneficiaryType) : null;
        const search = req.query.search ? String(req.query.search).trim().toLowerCase() : '';

        const outcome = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
          const [rawCustodies, allSchools, allDrivers, allSupervisors, allEmployees] = await Promise.all([
            db
              .select()
              .from(financialCustodies)
              .orderBy(desc(financialCustodies.handoverDate), desc(financialCustodies.id)),
            db.select().from(schools),
            db.select().from(drivers),
            db.select().from(supervisors),
            db.select().from(employees),
          ]);

          const schoolMap = new Map(allSchools.map((s) => [s.id, s]));
          const driverMap = new Map(allDrivers.map((d) => [d.id, d]));
          const supervisorMap = new Map(allSupervisors.map((s) => [s.id, s]));
          const employeeMap = new Map(allEmployees.map((e) => [e.id, e]));

          const filtered = rawCustodies.filter((c) => {
            if (!isSchoolAllowed(req.dbUser, c.schoolId)) return false;
            if (selectedSchoolId && c.schoolId !== selectedSchoolId) return false;
            if (statusFilter && statusFilter !== 'all' && c.status !== statusFilter) return false;
            if (
              beneficiaryTypeFilter &&
              beneficiaryTypeFilter !== 'all' &&
              c.beneficiaryType !== beneficiaryTypeFilter
            ) {
              return false;
            }
            if (search) {
              const codeMatch = c.custodyCode?.toLowerCase().includes(search);
              const nameMatch = c.beneficiaryName?.toLowerCase().includes(search);
              const purposeMatch = c.purpose?.toLowerCase().includes(search);
              const notesMatch = c.notes?.toLowerCase().includes(search);
              if (!codeMatch && !nameMatch && !purposeMatch && !notesMatch) return false;
            }
            return true;
          });

          const enriched = filtered.map((c) => {
            const sc = c.schoolId ? schoolMap.get(c.schoolId) : null;
            const drv = c.driverId ? driverMap.get(c.driverId) : null;
            const sup = c.supervisorId ? supervisorMap.get(c.supervisorId) : null;
            const emp = c.employeeId ? employeeMap.get(c.employeeId) : null;

            const amount = Number(c.amount || 0);
            const spentAmount = Number(c.spentAmount || 0);
            const returnedAmount = Number(c.returnedAmount || 0);
            const remainingAmount = Math.max(0, amount - spentAmount - returnedAmount);

            return {
              ...c,
              amount,
              spentAmount,
              returnedAmount,
              remainingAmount,
              schoolName: sc?.name || (c.schoolId ? `مدرسة #${c.schoolId}` : 'الإدارة العامة'),
              driverCode: drv?.driverCode || null,
              driverName: drv?.fullName || null,
              supervisorName: sup?.fullName || null,
              employeeName: emp?.fullName || null,
            };
          });

          const totalHandedAmount = enriched.reduce((sum, c) => sum + c.amount, 0);
          const totalSpentAmount = enriched.reduce((sum, c) => sum + c.spentAmount, 0);
          const totalReturnedAmount = enriched.reduce((sum, c) => sum + c.returnedAmount, 0);
          const totalActiveAmount = enriched.reduce(
            (sum, c) => sum + (c.status !== 'settled' ? c.remainingAmount : 0),
            0
          );
          const activeCount = enriched.filter((c) => c.status === 'active').length;
          const partialCount = enriched.filter((c) => c.status === 'partial').length;
          const settledCount = enriched.filter((c) => c.status === 'settled').length;

          return {
            custodies: enriched,
            stats: {
              totalHandedAmount,
              totalSpentAmount,
              totalReturnedAmount,
              totalActiveAmount,
              totalCount: enriched.length,
              activeCount,
              partialCount,
              settledCount,
            },
          };
        });

        res.json(outcome);
      } catch (error) {
        console.error('Get custodies error:', error);
        res.status(500).json({ error: 'تعذر تحميل العهد المالية' });
      }
    }
  );

  app.post(
    '/api/finance/custodies',
    requireAuth,
    requireAdminOrStaff,
    requirePermission('finance:write'),
    async (req: AuthRequest, res) => {
      try {
        const {
          schoolId,
          beneficiaryType = 'driver',
          driverId,
          supervisorId,
          employeeId,
          beneficiaryName,
          beneficiaryPhone,
          amount,
          handoverDate,
          purpose,
          paymentMethod = 'كاش',
          handedByName,
          notes,
        } = req.body;

        const numAmount = Number(amount);
        if (!numAmount || numAmount <= 0) {
          return res.status(400).json({ error: 'يرجى إدخال مبلغ صحيح للعهدة أكبر من صفر' });
        }
        if (!beneficiaryName || !String(beneficiaryName).trim()) {
          return res.status(400).json({ error: 'يرجى تحديد أو إدخال اسم المستلم للعهدة' });
        }
        if (!purpose || !String(purpose).trim()) {
          return res.status(400).json({ error: 'يرجى تحديد الغرض من العهدة' });
        }

        const cleanSchoolId = schoolId ? Number(schoolId) : null;
        if (cleanSchoolId && !isSchoolAllowed(req.dbUser, cleanSchoolId)) {
          return res.status(403).json({ error: 'المدرسة خارج نطاق صلاحياتك' });
        }

        const cleanHandoverDate = handoverDate
          ? normalizeIsoDateInput(String(handoverDate))
          : getTodayDateString();

        const outcome = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
          return await db.transaction(async (tx) => {
            const [lastCustody] = await tx
              .select({ id: financialCustodies.id })
              .from(financialCustodies)
              .orderBy(desc(financialCustodies.id))
              .limit(1);

            const nextNum = (lastCustody?.id || 0) + 1;
            const custodyCode = `CST-${String(nextNum).padStart(4, '0')}`;

            const [inserted] = await tx
              .insert(financialCustodies)
              .values({
                custodyCode,
                schoolId: cleanSchoolId,
                beneficiaryType: String(beneficiaryType || 'driver'),
                driverId: driverId ? Number(driverId) : null,
                supervisorId: supervisorId ? Number(supervisorId) : null,
                employeeId: employeeId ? Number(employeeId) : null,
                beneficiaryName: String(beneficiaryName).trim(),
                beneficiaryPhone: beneficiaryPhone ? String(beneficiaryPhone).trim() : '',
                amount: numAmount.toFixed(2),
                spentAmount: '0.00',
                returnedAmount: '0.00',
                handoverDate: cleanHandoverDate,
                purpose: String(purpose).trim(),
                paymentMethod: String(paymentMethod || 'كاش').trim(),
                handedByUserId: req.dbUser?.id || null,
                handedByName: handedByName
                  ? String(handedByName).trim()
                  : req.dbUser?.fullName || 'الإدارة المالية',
                status: 'active',
                notes: notes ? String(notes).trim() : '',
              })
              .returning();

            await tx.insert(auditLogs).values({
              actorUserId: req.dbUser!.id,
              action: 'ADD_CUSTODY',
              entityType: 'financial_custodies',
              entityId: String(inserted.id),
              afterJson: inserted,
              ipAddress: req.ip || '',
            });

            await tx.insert(notifications).values({
              targetRole: 'super_admin',
              type: 'financial_action',
              title: 'تسليم عهدة مالية جديدة',
              body: `قام المحاسب/المسؤول ${inserted.handedByName} بتسليم عهدة (${inserted.custodyCode}) بقيمة ${numAmount.toLocaleString()} ج.م إلى ${inserted.beneficiaryName} (${String(purpose).trim()}).`,
              isRead: false,
            });

            return inserted;
          });
        });

        res.status(201).json({ custody: outcome });
      } catch (error: unknown) {
        console.error('Create custody error:', error);
        const msg = error instanceof Error ? error.message : 'تعذر تسجيل تسليم العهدة';
        res.status(400).json({ error: msg });
      }
    }
  );

  app.patch(
    '/api/finance/custodies/:id',
    requireAuth,
    requireAdminOrStaff,
    requirePermission('finance:write'),
    async (req: AuthRequest, res) => {
      try {
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ error: 'معرف العهدة غير صالح' });

        const outcome = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
          const [existing] = await db
            .select()
            .from(financialCustodies)
            .where(eq(financialCustodies.id, id))
            .limit(1);

          if (!existing) return { status: 404 as const, body: { error: 'العهدة غير موجودة' } };
          if (existing.schoolId && !isSchoolAllowed(req.dbUser, existing.schoolId)) {
            return { status: 403 as const, body: { error: 'العهدة خارج نطاق صلاحياتك' } };
          }

          const {
            schoolId,
            beneficiaryType,
            driverId,
            supervisorId,
            employeeId,
            beneficiaryName,
            beneficiaryPhone,
            amount,
            handoverDate,
            purpose,
            paymentMethod,
            handedByName,
            notes,
          } = req.body;

          const newAmount = amount !== undefined ? Number(amount) : Number(existing.amount);
          const currentSpent = Number(existing.spentAmount || 0);
          const currentReturned = Number(existing.returnedAmount || 0);

          let newStatus = existing.status;
          if (currentSpent + currentReturned >= newAmount && newAmount > 0) {
            newStatus = 'settled';
          } else if (currentSpent + currentReturned > 0) {
            newStatus = 'partial';
          } else {
            newStatus = 'active';
          }

          const [updated] = await db
            .update(financialCustodies)
            .set({
              schoolId: schoolId !== undefined ? (schoolId ? Number(schoolId) : null) : existing.schoolId,
              beneficiaryType:
                beneficiaryType !== undefined ? String(beneficiaryType) : existing.beneficiaryType,
              driverId: driverId !== undefined ? (driverId ? Number(driverId) : null) : existing.driverId,
              supervisorId:
                supervisorId !== undefined ? (supervisorId ? Number(supervisorId) : null) : existing.supervisorId,
              employeeId:
                employeeId !== undefined ? (employeeId ? Number(employeeId) : null) : existing.employeeId,
              beneficiaryName:
                beneficiaryName !== undefined ? String(beneficiaryName).trim() : existing.beneficiaryName,
              beneficiaryPhone:
                beneficiaryPhone !== undefined ? String(beneficiaryPhone).trim() : existing.beneficiaryPhone,
              amount: newAmount.toFixed(2),
              handoverDate:
                handoverDate !== undefined
                  ? normalizeIsoDateInput(String(handoverDate))
                  : existing.handoverDate,
              purpose: purpose !== undefined ? String(purpose).trim() : existing.purpose,
              paymentMethod:
                paymentMethod !== undefined ? String(paymentMethod).trim() : existing.paymentMethod,
              handedByName:
                handedByName !== undefined ? String(handedByName).trim() : existing.handedByName,
              notes: notes !== undefined ? String(notes).trim() : existing.notes,
              status: newStatus,
              updatedAt: new Date(),
            })
            .where(eq(financialCustodies.id, id))
            .returning();

          await db.insert(auditLogs).values({
            actorUserId: req.dbUser!.id,
            action: 'UPDATE_CUSTODY',
            entityType: 'financial_custodies',
            entityId: String(id),
            beforeJson: existing,
            afterJson: updated,
            ipAddress: req.ip || '',
          });

          return { status: 200 as const, body: { custody: updated } };
        });

        res.status(outcome.status).json(outcome.body);
      } catch (error: unknown) {
        console.error('Update custody error:', error);
        const msg = error instanceof Error ? error.message : 'تعذر تعديل بيانات العهدة';
        res.status(400).json({ error: msg });
      }
    }
  );

  app.post(
    '/api/finance/custodies/:id/settle',
    requireAuth,
    requireAdminOrStaff,
    requirePermission('finance:write'),
    async (req: AuthRequest, res) => {
      try {
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ error: 'معرف العهدة غير صالح' });

        const outcome = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
          const [existing] = await db
            .select()
            .from(financialCustodies)
            .where(eq(financialCustodies.id, id))
            .limit(1);

          if (!existing) return { status: 404 as const, body: { error: 'العهدة غير موجودة' } };
          if (existing.schoolId && !isSchoolAllowed(req.dbUser, existing.schoolId)) {
            return { status: 403 as const, body: { error: 'العهدة خارج نطاق صلاحياتك' } };
          }

          const {
            spentAmount = 0,
            returnedAmount = 0,
            settlementDate,
            settledByName,
            notes,
          } = req.body;

          const numSpent = Math.max(0, Number(spentAmount) || 0);
          const numReturned = Math.max(0, Number(returnedAmount) || 0);
          const totalOriginal = Number(existing.amount || 0);
          const totalSettled = numSpent + numReturned;

          if (totalSettled > totalOriginal + 0.001) {
            return {
              status: 400 as const,
              body: {
                error: `إجمالي المصروف والمرتجع (${totalSettled.toLocaleString()} ج.م) لا يمكن أن يتجاوز أصل العهدة (${totalOriginal.toLocaleString()} ج.م)`,
              },
            };
          }

          let status = 'active';
          if (totalSettled >= totalOriginal - 0.001 && totalOriginal > 0) {
            status = 'settled';
          } else if (totalSettled > 0) {
            status = 'partial';
          }

          const cleanSettlementDate = settlementDate
            ? normalizeIsoDateInput(String(settlementDate))
            : getTodayDateString();

          const combinedNotes = notes
            ? `${existing.notes ? existing.notes + ' | ' : ''}[تصفية ${cleanSettlementDate}]: ${String(notes).trim()}`
            : existing.notes;

          const [updated] = await db
            .update(financialCustodies)
            .set({
              spentAmount: numSpent.toFixed(2),
              returnedAmount: numReturned.toFixed(2),
              settlementDate: cleanSettlementDate,
              settledByUserId: req.dbUser?.id || null,
              settledByName: settledByName
                ? String(settledByName).trim()
                : req.dbUser?.fullName || 'الإدارة المالية',
              status,
              notes: combinedNotes,
              updatedAt: new Date(),
            })
            .where(eq(financialCustodies.id, id))
            .returning();

          await db.insert(auditLogs).values({
            actorUserId: req.dbUser!.id,
            action: 'SETTLE_CUSTODY',
            entityType: 'financial_custodies',
            entityId: String(id),
            beforeJson: existing,
            afterJson: updated,
            ipAddress: req.ip || '',
          });

          await db.insert(notifications).values({
            targetRole: 'super_admin',
            type: 'financial_action',
            title: 'تصفية عهدة مالية',
            body: `تم تصفية العهدة (${updated.custodyCode}) الخاصة بـ ${updated.beneficiaryName}: مصروف ${numSpent.toLocaleString()} ج.م، مرتجع ${numReturned.toLocaleString()} ج.م بواسطة ${updated.settledByName}.`,
            isRead: false,
          });

          return { status: 200 as const, body: { custody: updated } };
        });

        res.status(outcome.status).json(outcome.body);
      } catch (error: unknown) {
        console.error('Settle custody error:', error);
        const msg = error instanceof Error ? error.message : 'تعذر تسجيل تصفية العهدة';
        res.status(400).json({ error: msg });
      }
    }
  );

  app.delete(
    '/api/finance/custodies/:id',
    requireAuth,
    requireAdminOrStaff,
    requirePermission('finance:write'),
    async (req: AuthRequest, res) => {
      try {
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ error: 'معرف العهدة غير صالح' });

        const outcome = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
          const [existing] = await db
            .select()
            .from(financialCustodies)
            .where(eq(financialCustodies.id, id))
            .limit(1);

          if (!existing) return { status: 404 as const, body: { error: 'العهدة غير موجودة' } };
          if (existing.schoolId && !isSchoolAllowed(req.dbUser, existing.schoolId)) {
            return { status: 403 as const, body: { error: 'العهدة خارج نطاق صلاحياتك' } };
          }

          await db.delete(financialCustodies).where(eq(financialCustodies.id, id));

          await db.insert(auditLogs).values({
            actorUserId: req.dbUser!.id,
            action: 'DELETE_CUSTODY',
            entityType: 'financial_custodies',
            entityId: String(id),
            beforeJson: existing,
            ipAddress: req.ip || '',
          });

          return { status: 200 as const, body: { ok: true, deletedId: id } };
        });

        res.status(outcome.status).json(outcome.body);
      } catch (error: unknown) {
        console.error('Delete custody error:', error);
        const msg = error instanceof Error ? error.message : 'تعذر حذف العهدة';
        res.status(400).json({ error: msg });
      }
    }
  );

  // 5b-2. Commercial Invoices & Archive (وحدة إصدار الفواتير وأرشيف الفواتير الصادرة)
  const serializeInvoice = (row: typeof invoices.$inferSelect) => ({
    ...row,
    totalAmount: Number(row.totalAmount || 0),
    cancelledReason: row.cancelledReason || '',
    createdByName: row.createdByName || '',
    notes: row.notes || '',
  });

  app.get(
    '/api/finance/invoices/next-number',
    requireAuth,
    requireAdminOrStaff,
    requireAnyPermission(['finance:read', 'finance:write', 'reports:read']),
    async (_req: AuthRequest, res) => {
      try {
        const result = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
          const [row] = await db
            .select({ maxNum: sql<number>`COALESCE(MAX(${invoices.invoiceNumber}), 0)` })
            .from(invoices);
          const nextNumber = Number(row?.maxNum || 0) + 1;
          return { nextNumber, nextCode: formatInvoiceCode(nextNumber) };
        });
        res.json(result);
      } catch (error) {
        console.error('Next invoice number error:', error);
        res.status(500).json({ error: 'تعذر احتساب رقم الفاتورة التسلسلي التالي' });
      }
    }
  );

  app.get(
    '/api/finance/invoices',
    requireAuth,
    requireAdminOrStaff,
    requireAnyPermission(['finance:read', 'finance:write', 'reports:read']),
    async (req: AuthRequest, res) => {
      try {
        const search = String(req.query.search || '').trim().toLowerCase();
        const statusFilter = String(req.query.status || 'all').trim();

        const payload = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
          const rows = await db
            .select()
            .from(invoices)
            .orderBy(desc(invoices.invoiceNumber));

          const maxNum = rows.reduce((m, r) => Math.max(m, Number(r.invoiceNumber || 0)), 0);
          const nextNumber = maxNum + 1;

          const serialized = rows.map(serializeInvoice);
          const issuedCount = serialized.filter((r) => r.status === 'issued').length;
          const cancelledCount = serialized.filter((r) => r.status === 'cancelled').length;
          const issuedTotalAmount = serialized
            .filter((r) => r.status === 'issued')
            .reduce((sum, r) => sum + Number(r.totalAmount || 0), 0);

          const filtered = serialized.filter((inv) => {
            if (statusFilter !== 'all' && inv.status !== statusFilter) return false;
            if (!search) return true;
            const hay = `${inv.invoiceCode} ${inv.billToName} ${inv.schoolName} ${inv.statementText} ${inv.issueDate}`.toLowerCase();
            return hay.includes(search);
          });

          return {
            invoices: filtered,
            nextNumber,
            nextCode: formatInvoiceCode(nextNumber),
            summary: {
              totalCount: serialized.length,
              issuedCount,
              cancelledCount,
              issuedTotalAmount,
            },
          };
        });

        res.json(payload);
      } catch (error) {
        console.error('List invoices error:', error);
        res.status(500).json({ error: 'تعذر تحميل سجل الفواتير الصادرة' });
      }
    }
  );

  app.post(
    '/api/finance/invoices',
    requireAuth,
    requireAdminOrStaff,
    requirePermission('finance:write'),
    async (req: AuthRequest, res) => {
      try {
        const {
          issueDate,
          billToName,
          billingMonth,
          billingYear,
          vehicleCount,
          schoolName,
          statementText,
          totalAmount,
          notes,
        } = req.body;

        const cleanTotal = Math.round(Number(totalAmount || 0) * 100) / 100;
        if (!Number.isFinite(cleanTotal) || cleanTotal <= 0) {
          return res.status(400).json({ error: 'يرجى إدخال قيمة إجمالية صحيحة أكبر من صفر' });
        }

        const todayCairo = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
        const cleanIssueDate = normalizeIsoDateInput(String(issueDate || '')) || todayCairo;
        const cleanMonth = Math.min(12, Math.max(1, Number(billingMonth) || new Date().getMonth() + 1));
        const cleanYear = Math.min(2099, Math.max(2020, Number(billingYear) || new Date().getFullYear()));
        const cleanVehicleCount =
          Number.isFinite(Number(vehicleCount)) && Number(vehicleCount) > 0
            ? Math.floor(Number(vehicleCount))
            : DEFAULT_INVOICE_VEHICLE_COUNT;
        const cleanSchool =
          String(schoolName || '').trim() || DEFAULT_INVOICE_SCHOOL_NAME;
        const cleanBillTo =
          String(billToName || '').trim() || DEFAULT_INVOICE_BILL_TO;
        const cleanStatement =
          String(statementText || '').trim() ||
          buildDefaultInvoiceStatement(cleanMonth, cleanVehicleCount, cleanSchool);
        const amountWords = tafqeetEGP(cleanTotal);

        const outcome = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
          return db.transaction(async (tx) => {
            // Transaction-scoped advisory lock guarantees zero duplicate/skipped sequence numbers
            await tx.execute(sql`SELECT pg_advisory_xact_lock(9042001)`);
            const [maxRow] = await tx
              .select({ maxNum: sql<number>`COALESCE(MAX(${invoices.invoiceNumber}), 0)` })
              .from(invoices);
            const nextNumber = Number(maxRow?.maxNum || 0) + 1;
            const invoiceCode = formatInvoiceCode(nextNumber);

            const [created] = await tx
              .insert(invoices)
              .values({
                invoiceNumber: nextNumber,
                invoiceCode,
                issueDate: cleanIssueDate,
                billToName: cleanBillTo,
                billingMonth: cleanMonth,
                billingYear: cleanYear,
                vehicleCount: cleanVehicleCount,
                schoolName: cleanSchool,
                statementText: cleanStatement,
                totalAmount: cleanTotal.toFixed(2),
                amountInWords: amountWords,
                status: 'issued',
                createdByUserId: req.dbUser!.id,
                createdByName: req.dbUser!.fullName || req.dbUser!.email || '',
                notes: String(notes || '').trim(),
              })
              .returning();

            await tx.insert(auditLogs).values({
              actorUserId: req.dbUser!.id,
              action: 'ISSUE_INVOICE',
              entityType: 'invoices',
              entityId: String(created.id),
              afterJson: created,
              ipAddress: req.ip || '',
            });

            await tx.insert(notifications).values({
              targetRole: 'super_admin',
              type: 'financial_action',
              title: `إصدار فاتورة رقم #${invoiceCode}`,
              body: `تم إصدار فاتورة رقم #${invoiceCode} بمبلغ ${cleanTotal.toLocaleString()} ج.م مطلوبة من ${cleanBillTo} بواسطة ${req.dbUser!.fullName || req.dbUser!.email}.`,
              isRead: false,
            });

            return {
              invoice: serializeInvoice(created),
              nextNumber: nextNumber + 1,
              nextCode: formatInvoiceCode(nextNumber + 1),
            };
          });
        });

        res.status(201).json(outcome);
      } catch (error) {
        console.error('Create invoice error:', error);
        res.status(500).json({ error: 'تعذر إصدار الفاتورة وحفظها في السجل' });
      }
    }
  );

  app.patch(
    '/api/finance/invoices/:id',
    requireAuth,
    requireAdminOrStaff,
    requirePermission('finance:write'),
    async (req: AuthRequest, res) => {
      try {
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ error: 'معرف الفاتورة غير صالح' });

        const outcome = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
          const [existing] = await db
            .select()
            .from(invoices)
            .where(eq(invoices.id, id))
            .limit(1);

          if (!existing) {
            return { status: 404 as const, body: { error: 'الفاتورة غير موجودة' } };
          }
          if (existing.status === 'cancelled') {
            return {
              status: 400 as const,
              body: { error: 'لا يمكن تعديل فاتورة ملغاة حفاظاً على سلامة السجل المحاسبي' },
            };
          }

          const {
            issueDate,
            billToName,
            billingMonth,
            billingYear,
            vehicleCount,
            schoolName,
            statementText,
            totalAmount,
            notes,
          } = req.body;

          const nextTotal =
            totalAmount !== undefined
              ? Math.round(Number(totalAmount) * 100) / 100
              : Number(existing.totalAmount || 0);

          if (!Number.isFinite(nextTotal) || nextTotal <= 0) {
            return {
              status: 400 as const,
              body: { error: 'يجب أن يكون إجمالي الفاتورة أكبر من صفر' },
            };
          }

          const nextIssueDate =
            issueDate !== undefined
              ? normalizeIsoDateInput(String(issueDate)) || existing.issueDate
              : existing.issueDate;
          const nextMonth =
            billingMonth !== undefined
              ? Math.min(12, Math.max(1, Number(billingMonth) || existing.billingMonth))
              : existing.billingMonth;
          const nextYear =
            billingYear !== undefined
              ? Math.min(2099, Math.max(2020, Number(billingYear) || existing.billingYear))
              : existing.billingYear;
          const nextVehicleCount =
            vehicleCount !== undefined
              ? Math.max(1, Math.floor(Number(vehicleCount) || existing.vehicleCount))
              : existing.vehicleCount;
          const nextSchoolName =
            schoolName !== undefined
              ? String(schoolName).trim() || existing.schoolName
              : existing.schoolName;
          const nextBillTo =
            billToName !== undefined
              ? String(billToName).trim() || existing.billToName
              : existing.billToName;
          const nextStatement =
            statementText !== undefined
              ? String(statementText).trim() || existing.statementText
              : existing.statementText;
          const nextNotes = notes !== undefined ? String(notes).trim() : existing.notes || '';
          const nextWords = tafqeetEGP(nextTotal);

          const [updated] = await db
            .update(invoices)
            .set({
              issueDate: nextIssueDate,
              billToName: nextBillTo,
              billingMonth: nextMonth,
              billingYear: nextYear,
              vehicleCount: nextVehicleCount,
              schoolName: nextSchoolName,
              statementText: nextStatement,
              totalAmount: nextTotal.toFixed(2),
              amountInWords: nextWords,
              notes: nextNotes,
              updatedAt: new Date(),
            })
            .where(eq(invoices.id, id))
            .returning();

          await db.insert(auditLogs).values({
            actorUserId: req.dbUser!.id,
            action: 'UPDATE_INVOICE',
            entityType: 'invoices',
            entityId: String(id),
            beforeJson: existing,
            afterJson: updated,
            ipAddress: req.ip || '',
          });

          await db.insert(notifications).values({
            targetRole: 'super_admin',
            type: 'financial_action',
            title: `تعديل فاتورة رقم #${existing.invoiceCode}`,
            body: `تم تحديث بيانات الفاتورة رقم #${existing.invoiceCode} إلى مبلغ ${nextTotal.toLocaleString()} ج.م بواسطة ${req.dbUser!.fullName || req.dbUser!.email}.`,
            isRead: false,
          });

          return { status: 200 as const, body: { invoice: serializeInvoice(updated) } };
        });

        res.status(outcome.status).json(outcome.body);
      } catch (error) {
        console.error('Update invoice error:', error);
        res.status(500).json({ error: 'تعذر تعديل بيانات الفاتورة' });
      }
    }
  );

  app.post(
    '/api/finance/invoices/:id/cancel',
    requireAuth,
    requireAdminOrStaff,
    requirePermission('finance:write'),
    async (req: AuthRequest, res) => {
      try {
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ error: 'معرف الفاتورة غير صالح' });
        const reason = String(req.body?.reason || '').trim() || 'إلغاء محاسبي مع حفظ التسلسل';

        const outcome = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
          const [existing] = await db
            .select()
            .from(invoices)
            .where(eq(invoices.id, id))
            .limit(1);

          if (!existing) {
            return { status: 404 as const, body: { error: 'الفاتورة غير موجودة' } };
          }
          if (existing.status === 'cancelled') {
            return {
              status: 400 as const,
              body: { error: 'الفاتورة ملغاة بالفعل في السجل' },
            };
          }

          const [updated] = await db
            .update(invoices)
            .set({
              status: 'cancelled',
              cancelledReason: reason,
              cancelledAt: new Date(),
              cancelledByUserId: req.dbUser!.id,
              updatedAt: new Date(),
            })
            .where(eq(invoices.id, id))
            .returning();

          await db.insert(auditLogs).values({
            actorUserId: req.dbUser!.id,
            action: 'CANCEL_INVOICE',
            entityType: 'invoices',
            entityId: String(id),
            beforeJson: existing,
            afterJson: updated,
            ipAddress: req.ip || '',
          });

          await db.insert(notifications).values({
            targetRole: 'super_admin',
            type: 'financial_action',
            title: `إلغاء فاتورة رقم #${existing.invoiceCode}`,
            body: `تم إلغاء الفاتورة رقم #${existing.invoiceCode} مع بقائها محفوظة بالسجل (السبب: ${reason}) بواسطة ${req.dbUser!.fullName || req.dbUser!.email}.`,
            isRead: false,
          });

          return { status: 200 as const, body: { invoice: serializeInvoice(updated) } };
        });

        res.status(outcome.status).json(outcome.body);
      } catch (error) {
        console.error('Cancel invoice error:', error);
        res.status(500).json({ error: 'تعذر إلغاء الفاتورة' });
      }
    }
  );

  app.delete(
    '/api/finance/invoices/:id',
    requireAuth,
    requireAdminOrStaff,
    async (_req: AuthRequest, res) => {
      res.status(405).json({
        error:
          'لا يُسمح بالحذف النهائي للفواتير حفاظاً على تسلسل الترقيم المحاسبي — استخدم إجراء الإلغاء لوسمها كـ «ملغاة».',
      });
    }
  );

  // 5c. Financial Audit Trail / Activity Log (سجل النشاط والرقابة المالية)
  app.get(
    '/api/finance/audit-logs',
    requireAuth,
    requireAdminOrStaff,
    requireAnyPermission(['finance:read', 'finance:write']),
    async (req: AuthRequest, res) => {
      try {
        const outcome = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
          const [logs, allUsers] = await Promise.all([
            db
              .select()
              .from(auditLogs)
              .where(
                or(
                  eq(auditLogs.entityType, 'advances'),
                  eq(auditLogs.entityType, 'coverage_records'),
                  eq(auditLogs.entityType, 'financial_transactions'),
                  eq(auditLogs.entityType, 'financial_custodies'),
                  eq(auditLogs.entityType, 'invoices'),
                  like(auditLogs.action, '%ADVANCE%'),
                  like(auditLogs.action, '%COVERAGE%'),
                  like(auditLogs.action, '%ADJUSTMENT%'),
                  like(auditLogs.action, '%CUSTODY%'),
                  like(auditLogs.action, '%INVOICE%'),
                  like(auditLogs.action, '%LEDGER%')
                )
              )
              .orderBy(desc(auditLogs.createdAt))
              .limit(100),
            db.select().from(users),
          ]);

          const userMap = new Map(allUsers.map((u) => [u.id, u]));

          const enriched = logs.map((log) => {
            const actor = log.actorUserId ? userMap.get(log.actorUserId) : null;
            let actionAr = log.action;
            if (log.action.includes('ADVANCE') || log.entityType === 'advances') {
              actionAr = log.action.includes('ADD') ? 'إضافة سلفة' : log.action.includes('UPDATE') ? 'تعديل سلفة' : 'حذف سلفة';
            } else if (log.action.includes('COVERAGE') || log.entityType === 'coverage_records') {
              actionAr = log.action.includes('ADD') ? 'إضافة تغطية' : log.action.includes('UPDATE') ? 'تعديل تغطية' : 'حذف تغطية';
            } else if (log.action.includes('ADJUSTMENT')) {
              actionAr = 'تعديل تسوية راتب (مكافأة/خصم)';
            } else if (log.action.includes('CUSTODY') || log.entityType === 'financial_custodies') {
              actionAr = log.action.includes('ADD') ? 'تسليم عهدة' : log.action.includes('UPDATE') ? 'تعديل عهدة' : log.action.includes('SETTLE') ? 'تصفية عهدة' : 'حذف عهدة';
            } else if (log.action.includes('INVOICE') || log.entityType === 'invoices') {
              actionAr = log.action.includes('ISSUE')
                ? 'إصدار فاتورة'
                : log.action.includes('UPDATE')
                ? 'تعديل فاتورة'
                : log.action.includes('CANCEL')
                ? 'إلغاء فاتورة'
                : 'عملية فاتورة';
            } else if (log.action.includes('LEDGER') || log.entityType === 'financial_transactions') {
              actionAr = 'حذف قيد من دفتر الأستاذ';
            }

            return {
              ...log,
              actorName: actor?.fullName || 'النظام / غير معروف',
              actorEmail: actor?.email || '',
              actionAr,
            };
          });

          return enriched;
        });

        res.json({ auditLogs: outcome });
      } catch (error) {
        console.error('Get finance audit logs error:', error);
        res.status(500).json({ error: 'تعذر تحميل سجل النشاط المالي' });
      }
    }
  );

  // 5b. Non-Driver Employees Management (الموظفون غير السائقين - نشطون فقط)
  app.get('/api/employees', requireAuth, requireAdminOrStaff, requireAnyPermission(['employees:read', 'employees:write', 'finance:read', 'dashboard:read']), async (req: AuthRequest, res) => {
    try {
      const includeArchived = req.query.includeArchived === 'true';
      const rawSchoolFilter = req.query.schoolId;
      const schoolFilter =
        rawSchoolFilter && rawSchoolFilter !== 'all' ? Number(rawSchoolFilter) : null;
      if (schoolFilter && Number.isFinite(schoolFilter) && !isSchoolAllowed(req.dbUser, schoolFilter)) {
        return res.status(403).json({ error: 'هذه المدرسة خارج نطاق صلاحياتك' });
      }

      const [rows, allSchools, allUsers, allRoles] = await Promise.all([
        db.select().from(employees).orderBy(employees.fullName),
        db.select().from(schools).orderBy(schools.name),
        req.dbUser?.roleSlug === 'super_admin' ? db.select().from(users) : Promise.resolve([]),
        req.dbUser?.roleSlug === 'super_admin' ? db.select().from(userRoles) : Promise.resolve([]),
      ]);

      const schoolNameById: Record<number, string> = {};
      for (const s of allSchools) schoolNameById[s.id] = s.name;

      const roleById: Record<number, typeof userRoles.$inferSelect> = {};
      for (const r of allRoles) roleById[r.id] = r;

      const userByEmployeeId: Record<number, typeof users.$inferSelect> = {};
      for (const u of allUsers) {
        if (u.employeeId) userByEmployeeId[u.employeeId] = u;
      }

      const visible = rows.filter((e) => {
        if (!includeArchived && e.status !== 'active') return false;
        if (!isSchoolAllowed(req.dbUser, e.schoolId)) return false;
        if (schoolFilter && Number.isFinite(schoolFilter) && e.schoolId !== schoolFilter) return false;
        return true;
      });

      res.json({
        employees: visible.map((e) => {
          const linked = userByEmployeeId[e.id];
          const linkedRole = linked ? roleById[linked.roleId] : undefined;
          const linkedSchoolIds = linked ? normalizeSchoolIds(linked.assignedSchoolIds) : [];
          return {
            ...e,
            schoolId: e.schoolId ?? null,
            schoolName: e.schoolId
              ? schoolNameById[e.schoolId] || 'غير معين'
              : 'الإدارة العامة',
            monthlySalary: Number(e.monthlySalary || 0),
            bonuses: Number(e.bonuses || 0),
            deductions: Number(e.deductions || 0),
            netSalary:
              Number(e.monthlySalary || 0) + Number(e.bonuses || 0) - Number(e.deductions || 0),
            linkedUser: linked
              ? {
                  id: linked.id,
                  email: linked.email,
                  roleId: linked.roleId,
                  roleSlug: linkedRole?.slug || 'accountant',
                  roleNameAr: linkedRole?.nameAr || 'موظف',
                  staffCode: linked.staffCode || '',
                  assignedSchoolIds: linkedSchoolIds,
                  assignedSchoolNames: linkedSchoolIds.map(
                    (id) => schoolNameById[id] || `مدرسة #${id}`
                  ),
                  customPermissions: Array.isArray(linked.customPermissions)
                    ? linked.customPermissions
                    : null,
                  permissions: buildEffectivePermissions(
                    linkedRole?.slug || 'accountant',
                    linkedRole?.permissions,
                    linked.customPermissions
                  ),
                  isActive: linked.isActive,
                }
              : null,
          };
        }),
      });
    } catch (error) {
      console.error('Get employees error:', error);
      res.status(500).json({ error: 'تعذر تحميل بيانات الموظفين' });
    }
  });

  // 5c. Dedicated Archive Management (الأرشفة)
  app.get('/api/archive', requireAuth, requireAdminOrStaff, requireAnyPermission(['drivers:write', 'vehicles:write', 'schools:write', 'employees:write']), async (req: AuthRequest, res) => {
    try {
      const allDrivers = await getEnrichedDrivers();
      const archivedDrivers = allDrivers.filter(
        (d) => d.accountStatus !== 'active' && isSchoolAllowed(req.dbUser, d.schoolId)
      );

      const allSchools = await db.select().from(schools).orderBy(schools.name);
      const schoolNameById: Record<number, string> = {};
      for (const s of allSchools) schoolNameById[s.id] = s.name;

      const allEmployees =
        hasPermission(req.dbUser, 'employees:read') || hasPermission(req.dbUser, 'employees:write')
          ? await db.select().from(employees).orderBy(employees.fullName)
          : [];
      const archivedEmployees = allEmployees
        .filter((e) => e.status !== 'active' && isSchoolAllowed(req.dbUser, e.schoolId))
        .map((e) => ({
          ...e,
          schoolId: e.schoolId ?? null,
          schoolName: e.schoolId ? schoolNameById[e.schoolId] || 'غير معين' : 'الإدارة العامة',
          monthlySalary: Number(e.monthlySalary || 0),
          bonuses: Number(e.bonuses || 0),
          deductions: Number(e.deductions || 0),
          netSalary:
            Number(e.monthlySalary || 0) + Number(e.bonuses || 0) - Number(e.deductions || 0),
        }));

      const allVehicles = await getFleetWithLatestGps();
      const archivedVehicles = allVehicles.filter(
        (v) => v.operationalStatus === 'inactive' && isSchoolAllowed(req.dbUser, v.schoolId)
      );

      const archivedSchools = allSchools.filter(
        (s) => !s.isActive && isSchoolAllowed(req.dbUser, s.id)
      );

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
      if (!isSchoolUnrestricted(req.dbUser)) {
        const sId = await getDriverCurrentSchoolId(id);
        if (!isSchoolAllowed(req.dbUser, sId)) {
          return res.status(403).json({ error: 'هذا السائق خارج نطاق المدارس المصرح لك بها' });
        }
      }
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

  app.post('/api/archive/employees/:id/restore', requireAuth, requireAdminOrStaff, requirePermission('employees:write'), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      const [existing] = await db.select().from(employees).where(eq(employees.id, id)).limit(1);
      if (!existing) return res.status(404).json({ error: 'الموظف غير موجود' });
      if (!isSchoolAllowed(req.dbUser, existing.schoolId)) {
        return res.status(403).json({ error: 'هذا الموظف تابع لمدرسة خارج نطاق صلاحياتك' });
      }
      const [updated] = await db
        .update(employees)
        .set({ status: 'active' })
        .where(eq(employees.id, id))
        .returning();
      res.json({ employee: updated });
    } catch (error) {
      res.status(500).json({ error: 'تعذر استعادة الموظف من الأرشفة' });
    }
  });

  app.post('/api/archive/vehicles/:id/restore', requireAuth, requireAdminOrStaff, requirePermission('vehicles:write'), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      const [existing] = await db.select().from(vehicles).where(eq(vehicles.id, id)).limit(1);
      if (!existing) return res.status(404).json({ error: 'المركبة غير موجودة' });
      if (!isSchoolUnrestricted(req.dbUser)) {
        const [assign] = await db
          .select({ schoolId: driverAssignments.schoolId })
          .from(driverAssignments)
          .where(and(eq(driverAssignments.vehicleId, id), eq(driverAssignments.isCurrent, true)))
          .limit(1);
        const effSchoolId = existing.schoolId ?? assign?.schoolId ?? null;
        if (!effSchoolId || !isSchoolAllowed(req.dbUser, effSchoolId)) {
          return res.status(403).json({ error: 'هذه المركبة خارج نطاق المدارس المصرح لك بها' });
        }
      }
      const [updated] = await db
        .update(vehicles)
        .set({ operationalStatus: 'active' })
        .where(eq(vehicles.id, id))
        .returning();
      res.json({ vehicle: updated });
    } catch (error) {
      res.status(500).json({ error: 'تعذر استعادة المركبة' });
    }
  });

  app.post('/api/archive/schools/:id/restore', requireAuth, requireAdminOrStaff, requirePermission('schools:write'), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      if (!isSchoolAllowed(req.dbUser, id)) {
        return res.status(403).json({ error: 'هذه المدرسة خارج نطاق صلاحياتك' });
      }
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

  app.delete(
    '/api/archive/drivers/:id',
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
        if (!existing) return res.status(404).json({ error: 'السائق غير موجود' });
        if (existing.accountStatus === 'active') {
          return res.status(409).json({ error: 'يرجى أرشفة السائق أولاً قبل الحذف النهائي' });
        }

        if (!isSchoolUnrestricted(req.dbUser)) {
          const currentSchoolId = await getDriverCurrentSchoolId(driverId);
          if (!isSchoolAllowed(req.dbUser, currentSchoolId)) {
            return res.status(403).json({ error: 'هذا السائق تابع لمدرسة خارج نطاق صلاحياتك' });
          }
        }

        await db.transaction(async (tx) => {
          await tx
            .update(gpsLocations)
            .set({ driverId: null })
            .where(eq(gpsLocations.driverId, driverId));
          await tx
            .delete(chatChannels)
            .where(and(eq(chatChannels.driverId, driverId), eq(chatChannels.channelType, 'direct')));
          await tx
            .update(chatChannels)
            .set({ driverId: null })
            .where(eq(chatChannels.driverId, driverId));
          await tx
            .update(coverageRecords)
            .set({ replacementDriverId: null })
            .where(eq(coverageRecords.replacementDriverId, driverId));
          await tx
            .delete(coverageRecords)
            .where(eq(coverageRecords.absentDriverId, driverId));
          await tx
            .delete(financialTransactions)
            .where(eq(financialTransactions.driverId, driverId));
          await tx.delete(advances).where(eq(advances.driverId, driverId));
          await tx.delete(salaries).where(eq(salaries.driverId, driverId));
          await tx.delete(attendance).where(eq(attendance.driverId, driverId));
          await tx.delete(driverAssignments).where(eq(driverAssignments.driverId, driverId));
          await tx.delete(notifications).where(eq(notifications.recipientDriverId, driverId));
          await tx
            .update(financialCustodies)
            .set({ driverId: null })
            .where(eq(financialCustodies.driverId, driverId));
          await tx.delete(drivers).where(eq(drivers.id, driverId));

          if (existing.userId) {
            await permanentlyDeleteUserTx(tx, existing.userId, req.dbUser!.id);
          }

          await tx.insert(auditLogs).values({
            actorUserId: req.dbUser!.id,
            action: 'PERMANENT_DELETE_DRIVER_FROM_ARCHIVE',
            entityType: 'drivers',
            entityId: String(driverId),
            beforeJson: existing,
            ipAddress: req.ip || '',
          });
        });

        res.json({ ok: true, deletedId: driverId });
      } catch (error) {
        console.error('Archive permanent delete driver error:', error);
        res.status(500).json({ error: 'تعذر الحذف النهائي للسائق من الأرشفة' });
      }
    }
  );

  app.delete(
    '/api/archive/employees/:id',
    requireAuth,
    requireAdminOrStaff,
    requirePermission('employees:write'),
    async (req: AuthRequest, res) => {
      try {
        const id = Number(req.params.id);
        const [existing] = await db.select().from(employees).where(eq(employees.id, id)).limit(1);
        if (!existing) return res.status(404).json({ error: 'الموظف غير موجود' });
        if (existing.status === 'active') {
          return res.status(409).json({ error: 'يرجى أرشفة الموظف أولاً قبل الحذف النهائي' });
        }
        if (!isSchoolAllowed(req.dbUser, existing.schoolId)) {
          return res.status(403).json({ error: 'هذا الموظف تابع لمدرسة خارج نطاق صلاحياتك' });
        }

        await db.transaction(async (tx) => {
          const [linkedUser] = await tx
            .select({ id: users.id, email: users.email })
            .from(users)
            .where(eq(users.employeeId, id))
            .limit(1);

          if (linkedUser && linkedUser.email.toLowerCase() !== 'hamdyhamzway@gmail.com') {
            await permanentlyDeleteUserTx(tx, linkedUser.id, req.dbUser!.id);
          }

          await tx
            .update(financialCustodies)
            .set({ employeeId: null })
            .where(eq(financialCustodies.employeeId, id));

          await tx.delete(employees).where(eq(employees.id, id));
          await tx.insert(auditLogs).values({
            actorUserId: req.dbUser!.id,
            action: 'PERMANENT_DELETE_EMPLOYEE_FROM_ARCHIVE',
            entityType: 'employees',
            entityId: String(id),
            beforeJson: existing,
            ipAddress: req.ip || '',
          });
        });

        res.json({ ok: true, deletedId: id });
      } catch (error) {
        console.error('Archive permanent delete employee error:', error);
        res.status(500).json({ error: 'تعذر الحذف النهائي للموظف من الأرشفة' });
      }
    }
  );

  app.delete(
    '/api/archive/vehicles/:id',
    requireAuth,
    requireAdminOrStaff,
    requirePermission('vehicles:write'),
    async (req: AuthRequest, res) => {
      try {
        const id = Number(req.params.id);
        const [existing] = await db.select().from(vehicles).where(eq(vehicles.id, id)).limit(1);
        if (!existing) return res.status(404).json({ error: 'المركبة غير موجودة' });
        if (existing.operationalStatus !== 'inactive') {
          return res.status(409).json({ error: 'يرجى أرشفة المركبة أولاً قبل الحذف النهائي' });
        }

        if (!isSchoolUnrestricted(req.dbUser)) {
          const [assign] = await db
            .select({ schoolId: driverAssignments.schoolId })
            .from(driverAssignments)
            .where(and(eq(driverAssignments.vehicleId, id), eq(driverAssignments.isCurrent, true)))
            .limit(1);
          const effSchoolId = existing.schoolId ?? assign?.schoolId ?? null;
          if (!effSchoolId || !isSchoolAllowed(req.dbUser, effSchoolId)) {
            return res.status(403).json({ error: 'هذه المركبة خارج نطاق المدارس المصرح لك بها' });
          }
        }

        await db.transaction(async (tx) => {
          await tx.update(gpsLocations).set({ vehicleId: null }).where(eq(gpsLocations.vehicleId, id));
          await tx
            .update(driverAssignments)
            .set({ vehicleId: null })
            .where(eq(driverAssignments.vehicleId, id));
          await tx
            .update(coverageRecords)
            .set({ vehicleId: null })
            .where(eq(coverageRecords.vehicleId, id));
          await tx.update(supervisors).set({ vehicleId: null }).where(eq(supervisors.vehicleId, id));
          await tx
            .update(supervisorTrips)
            .set({ vehicleId: null })
            .where(eq(supervisorTrips.vehicleId, id));
          await tx.delete(vehicles).where(eq(vehicles.id, id));
          await tx.insert(auditLogs).values({
            actorUserId: req.dbUser!.id,
            action: 'PERMANENT_DELETE_VEHICLE_FROM_ARCHIVE',
            entityType: 'vehicles',
            entityId: String(id),
            beforeJson: existing,
            ipAddress: req.ip || '',
          });
        });

        res.json({ ok: true, deletedId: id });
      } catch (error) {
        console.error('Archive permanent delete vehicle error:', error);
        res.status(500).json({ error: 'تعذر الحذف النهائي للمركبة من الأرشفة' });
      }
    }
  );

  app.delete(
    '/api/archive/schools/:id',
    requireAuth,
    requireAdminOrStaff,
    requirePermission('schools:write'),
    async (req: AuthRequest, res) => {
      try {
        const id = Number(req.params.id);
        const [existing] = await db.select().from(schools).where(eq(schools.id, id)).limit(1);
        if (!existing) return res.status(404).json({ error: 'المدرسة غير موجودة' });
        if (existing.isActive) {
          return res.status(409).json({ error: 'يرجى أرشفة المدرسة أولاً قبل الحذف النهائي' });
        }
        if (!isSchoolAllowed(req.dbUser, id)) {
          return res.status(403).json({ error: 'هذه المدرسة خارج نطاق صلاحياتك' });
        }

        await db.transaction(async (tx) => {
          await tx.update(vehicles).set({ schoolId: null }).where(eq(vehicles.schoolId, id));
          await tx.update(routes).set({ schoolId: null }).where(eq(routes.schoolId, id));
          await tx
            .update(driverAssignments)
            .set({ schoolId: null })
            .where(eq(driverAssignments.schoolId, id));
          await tx.update(salaries).set({ schoolId: null }).where(eq(salaries.schoolId, id));
          await tx.update(advances).set({ schoolId: null }).where(eq(advances.schoolId, id));
          await tx
            .update(coverageRecords)
            .set({ schoolId: null })
            .where(eq(coverageRecords.schoolId, id));
          await tx
            .update(financialTransactions)
            .set({ schoolId: null })
            .where(eq(financialTransactions.schoolId, id));
          await tx.update(attendance).set({ schoolId: null }).where(eq(attendance.schoolId, id));
          await tx.update(employees).set({ schoolId: null }).where(eq(employees.schoolId, id));
          await tx
            .update(monthlyClosings)
            .set({ schoolId: null })
            .where(eq(monthlyClosings.schoolId, id));
          await tx.update(supervisors).set({ schoolId: null }).where(eq(supervisors.schoolId, id));
          await tx.update(chatChannels).set({ schoolId: null }).where(eq(chatChannels.schoolId, id));
          await tx.update(dailyReports).set({ schoolId: null }).where(eq(dailyReports.schoolId, id));
          await tx
            .delete(billingPeriods)
            .where(eq(billingPeriods.key, getSchoolBillingPeriodKey(id)));

          const allUsersRows = await tx.select().from(users);
          for (const u of allUsersRows) {
            const currentAssigned = Array.isArray(u.assignedSchoolIds) ? u.assignedSchoolIds : [];
            if (currentAssigned.includes(id)) {
              await tx
                .update(users)
                .set({
                  assignedSchoolIds: currentAssigned.filter((sid) => sid !== id),
                  updatedAt: new Date(),
                })
                .where(eq(users.id, u.id));
            }
          }

          await tx.delete(schools).where(eq(schools.id, id));
          await tx.insert(auditLogs).values({
            actorUserId: req.dbUser!.id,
            action: 'PERMANENT_DELETE_SCHOOL_FROM_ARCHIVE',
            entityType: 'schools',
            entityId: String(id),
            beforeJson: existing,
            ipAddress: req.ip || '',
          });
        });

        res.json({ ok: true, deletedId: id });
      } catch (error) {
        console.error('Archive permanent delete school error:', error);
        res.status(500).json({ error: 'تعذر الحذف النهائي للمدرسة من الأرشفة' });
      }
    }
  );

  app.post('/api/employees', requireAuth, requireAdminOrStaff, requirePermission('employees:write'), async (req: AuthRequest, res) => {
    try {
      const {
        employeeCode,
        fullName,
        jobTitle,
        phone,
        schoolId,
        schoolName,
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

      const defaultSchoolId =
        !isSchoolUnrestricted(req.dbUser) &&
        !schoolId &&
        (!schoolName || PLACEHOLDER_ASSIGNMENTS.has(String(schoolName).trim())) &&
        (req.dbUser?.assignedSchoolIds?.length || 0) === 1
          ? req.dbUser!.assignedSchoolIds[0]
          : schoolId;
      const resolvedSchoolId = await resolveSchoolIdForDriver(db, {
        schoolId: defaultSchoolId,
        schoolName,
      });

      if (
        !isSchoolUnrestricted(req.dbUser) &&
        (!resolvedSchoolId || !isSchoolAllowed(req.dbUser, resolvedSchoolId))
      ) {
        return res.status(403).json({ error: 'لا يمكنك إضافة موظف خارج نطاق المدارس المصرح لك بها' });
      }

      const [created] = await db
        .insert(employees)
        .values({
          employeeCode: String(employeeCode || '').trim(),
          fullName: trimmedName,
          jobTitle: String(jobTitle || '').trim(),
          phone: String(phone || '').trim(),
          schoolId: resolvedSchoolId ?? null,
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

      const resolvedSchoolRow = created.schoolId
        ? (await db.select({ name: schools.name }).from(schools).where(eq(schools.id, created.schoolId)).limit(1))[0]
        : null;

      res.status(201).json({
        employee: {
          ...created,
          schoolId: created.schoolId ?? null,
          schoolName: resolvedSchoolRow?.name || 'الإدارة العامة',
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

  app.patch('/api/employees/:id', requireAuth, requireAdminOrStaff, requirePermission('employees:write'), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      const [existing] = await db.select().from(employees).where(eq(employees.id, id)).limit(1);
      if (!existing) return res.status(404).json({ error: 'الموظف غير موجود' });
      if (!isSchoolAllowed(req.dbUser, existing.schoolId)) {
        return res.status(403).json({ error: 'هذا الموظف تابع لمدرسة خارج نطاق صلاحياتك' });
      }

      const {
        employeeCode,
        fullName,
        jobTitle,
        phone,
        schoolId,
        schoolName,
        monthlySalary,
        bonuses,
        deductions,
        employmentStartDate,
        status,
        notes,
      } = req.body;

      const hasSchoolUpdate = schoolId !== undefined || schoolName !== undefined;
      const nextSchoolId = hasSchoolUpdate
        ? await resolveSchoolIdForDriver(db, { schoolId, schoolName })
        : existing.schoolId;

      if (
        hasSchoolUpdate &&
        !isSchoolUnrestricted(req.dbUser) &&
        (!nextSchoolId || !isSchoolAllowed(req.dbUser, nextSchoolId))
      ) {
        return res.status(403).json({ error: 'لا يمكنك نقل الموظف لمدرسة خارج نطاق صلاحياتك' });
      }

      const [updated] = await db
        .update(employees)
        .set({
          employeeCode:
            employeeCode !== undefined ? String(employeeCode).trim() : existing.employeeCode,
          fullName: fullName !== undefined ? String(fullName).trim() : existing.fullName,
          jobTitle: jobTitle !== undefined ? String(jobTitle).trim() : existing.jobTitle,
          phone: phone !== undefined ? String(phone).trim() : existing.phone,
          schoolId: nextSchoolId ?? null,
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

      const resolvedSchoolRow = updated.schoolId
        ? (await db.select({ name: schools.name }).from(schools).where(eq(schools.id, updated.schoolId)).limit(1))[0]
        : null;

      res.json({
        employee: {
          ...updated,
          schoolId: updated.schoolId ?? null,
          schoolName: resolvedSchoolRow?.name || 'الإدارة العامة',
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

  app.delete('/api/employees/:id', requireAuth, requireAdminOrStaff, requirePermission('employees:write'), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      const [existing] = await db.select().from(employees).where(eq(employees.id, id)).limit(1);
      if (!existing) return res.status(404).json({ error: 'الموظف غير موجود' });
      if (!isSchoolAllowed(req.dbUser, existing.schoolId)) {
        return res.status(403).json({ error: 'هذا الموظف تابع لمدرسة خارج نطاق صلاحياتك' });
      }
      await db.transaction(async (tx) => {
        const [linkedUser] = await tx
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(eq(users.employeeId, id))
          .limit(1);

        if (linkedUser && linkedUser.email.toLowerCase() !== 'hamdyhamzway@gmail.com') {
          await permanentlyDeleteUserTx(tx, linkedUser.id, req.dbUser!.id);
        }

        await tx
          .update(financialCustodies)
          .set({ employeeId: null })
          .where(eq(financialCustodies.employeeId, id));

        await tx.delete(employees).where(eq(employees.id, id));
        await tx.insert(auditLogs).values({
          actorUserId: req.dbUser!.id,
          action: 'DELETE_EMPLOYEE',
          entityType: 'employees',
          entityId: String(id),
          beforeJson: existing,
          ipAddress: req.ip || '',
        });
      });
      res.json({ ok: true, deletedId: id });
    } catch (error) {
      console.error('Delete employee error:', error);
      res.status(500).json({ error: 'تعذر حذف الموظف' });
    }
  });

  // ==========================================
  // EMPLOYEE DAILY REPORTS (صوتية وكتابية للمحاسب والمدير)
  // ==========================================
  app.get('/api/daily-reports', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { reportDate, targetAudience, status, schoolId: rawSchoolFilter } = req.query;
      const user = req.dbUser!;
      const isManager = user.roleSlug === 'super_admin' || user.permissions.includes('*');
      const isAccountant = user.roleSlug === 'accountant' || user.permissions.includes('finance:read');
      const isMovementMgr = user.roleSlug === 'movement_manager';

      const parsedSchoolFilter =
        rawSchoolFilter && rawSchoolFilter !== 'all' ? Number(rawSchoolFilter) : null;
      const schoolFilter =
        parsedSchoolFilter && Number.isFinite(parsedSchoolFilter) ? parsedSchoolFilter : null;
      if (schoolFilter && !isSchoolAllowed(user, schoolFilter)) {
        return res.status(403).json({ error: 'هذه المدرسة خارج نطاق صلاحياتك' });
      }

      const conditions: any[] = [];

      // If regular employee without admin/accountant role, scope to their reports only
      if (!isManager && !isAccountant && !isMovementMgr) {
        conditions.push(eq(dailyReports.userId, user.id));
      } else if (isAccountant && !isManager) {
        // Accountant sees reports targeted to accountant or both, or financial reports
        conditions.push(
          or(
            eq(dailyReports.targetAudience, 'accountant'),
            eq(dailyReports.targetAudience, 'both'),
            eq(dailyReports.reportType, 'financial'),
            eq(dailyReports.reportType, 'mixed'),
            eq(dailyReports.userId, user.id)
          )
        );
      }

      if (reportDate && typeof reportDate === 'string') {
        conditions.push(eq(dailyReports.reportDate, reportDate));
      }
      if (targetAudience && typeof targetAudience === 'string' && targetAudience !== 'all') {
        conditions.push(eq(dailyReports.targetAudience, targetAudience));
      }
      if (status && typeof status === 'string' && status !== 'all') {
        conditions.push(eq(dailyReports.status, status));
      }

      const [rawRows, allSchools] = await Promise.all([
        conditions.length > 0
          ? db
              .select()
              .from(dailyReports)
              .where(and(...conditions))
              .orderBy(desc(dailyReports.createdAt))
              .limit(150)
          : db.select().from(dailyReports).orderBy(desc(dailyReports.createdAt)).limit(150),
        db.select({ id: schools.id, name: schools.name }).from(schools),
      ]);

      const schoolNameById: Record<number, string> = {};
      for (const s of allSchools) schoolNameById[s.id] = s.name;

      const scopedRows = rawRows.filter((r) => {
        if (schoolFilter && r.schoolId !== schoolFilter) return false;
        if (isSchoolUnrestricted(user)) return true;
        return r.userId === user.id || (r.schoolId != null && isSchoolAllowed(user, r.schoolId));
      });

      const reports = scopedRows.map((r) => ({
        ...r,
        schoolId: r.schoolId ?? null,
        schoolName: r.schoolId ? schoolNameById[r.schoolId] || 'غير معين' : 'الإدارة العامة',
        financialAmount: Number(r.financialAmount || 0),
        extractedTasks: Array.isArray(r.extractedTasksJson) ? r.extractedTasksJson : [],
        attachments: Array.isArray(r.attachmentsJson) ? r.attachmentsJson : [],
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }));

      res.json({ reports });
    } catch (error) {
      console.error('Error fetching daily reports:', error);
      res.status(500).json({ error: 'تعذر تحميل التقارير اليومية' });
    }
  });

  app.post('/api/daily-reports', requireAuth, async (req: AuthRequest, res) => {
    try {
      const user = req.dbUser!;
      const {
        rawContent,
        audioDataUrl,
        audioDurationSec,
        reportDate,
        targetAudience,
        reportType,
        financialAmount,
        category,
        attachments,
        schoolId,
        schoolName,
      } = req.body;

      let resolvedSchoolId: number | null = await resolveSchoolIdForDriver(db, {
        schoolId,
        schoolName,
      });

      if (!resolvedSchoolId && user.employeeId) {
        const [empRow] = await db
          .select({ schoolId: employees.schoolId })
          .from(employees)
          .where(eq(employees.id, user.employeeId))
          .limit(1);
        resolvedSchoolId = empRow?.schoolId ?? null;
      }
      if (!resolvedSchoolId && !isSchoolUnrestricted(user) && user.assignedSchoolIds.length === 1) {
        resolvedSchoolId = user.assignedSchoolIds[0];
      }

      if (!isSchoolUnrestricted(user)) {
        if (resolvedSchoolId && !isSchoolAllowed(user, resolvedSchoolId)) {
          return res.status(403).json({ error: 'لا يمكنك إرسال تقرير لمدرسة خارج نطاق صلاحياتك' });
        }
        if (!resolvedSchoolId && user.assignedSchoolIds.length > 0) {
          resolvedSchoolId = user.assignedSchoolIds[0];
        }
      }

      const safeAttachments = Array.isArray(attachments) ? attachments : [];
      let text = String(rawContent || '').trim();

      // Allow voice-only or attachment-only reports without erroring
      if (!text) {
        if (audioDataUrl && safeAttachments.length > 0) {
          text = `تقرير صوتي مسجل (${Number(audioDurationSec || 0)} ثانية) ومرفق به ${safeAttachments.length} فواتير ومستندات`;
        } else if (audioDataUrl) {
          text = `تقرير صوتي مسجل (${Number(audioDurationSec || 0)} ثانية)`;
        } else if (safeAttachments.length > 0) {
          text = `تقرير مرفق بمستندات وفواتير (${safeAttachments.length} فواتير ومستندات)`;
        } else {
          return res.status(400).json({ error: 'يرجى تسجيل أو كتابة محتوى التقرير أو إرفاق فواتير ومستندات' });
        }
      }

      // Smart extraction
      let extractedAmount =
        financialAmount !== undefined && financialAmount !== null ? Number(financialAmount) : 0;

      if (!extractedAmount || isNaN(extractedAmount)) {
        const amountMatch =
          text.match(
            /(?:بمبلغ|مبلغ|تكلفة|مصاريف|سلفة|تحصيل|إجمالي|صرفت|دفعت|قبضت)\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)/i
          ) || text.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:جنيه|ج\.م|egp|ألف)/i);
        if (amountMatch) {
          let val = parseFloat(amountMatch[1]);
          if (text.includes('ألف') && val < 1000) val *= 1000;
          extractedAmount = val;
        }
      }

      // Extract tasks
      const taskLines = text
        .split(/[\n\r•\-\*]/)
        .map((l) => l.trim())
        .filter((l) => l.length > 4);

      const extractedTasks = taskLines.length > 0 ? taskLines.slice(0, 8) : [text.slice(0, 100)];

      // Determine Report Type
      let finalReportType = reportType || 'operations';
      const isMoneyRelated =
        extractedAmount > 0 ||
        safeAttachments.some((a) => a.category === 'invoice' || a.category === 'fuel' || a.category === 'maintenance') ||
        /(?:فلوس|مبلغ|جنيه|مصاريف|سلفة|فاتورة|حساب|صيانة|إيراد|تحصيل|بنزين|سولار)/i.test(text);
      const isOpsRelated =
        /(?:باص|سائق|مشرفة|مدرسة|مسار|خط سير|صيانة|تغطية|غياب|حضور|عطل|عقد)/i.test(text);

      if (isMoneyRelated && isOpsRelated) {
        finalReportType = 'mixed';
      } else if (isMoneyRelated) {
        finalReportType = 'financial';
      } else {
        finalReportType = 'operations';
      }

      // Target Audience
      let finalTarget = targetAudience || 'both';

      const todayCairo = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(
        new Date()
      );
      const finalDate =
        reportDate && /^\d{4}-\d{2}-\d{2}$/.test(reportDate) ? reportDate : todayCairo;

      const employeeName = user.fullName || 'موظف';
      const employeeRoleOrTitle = user.roleNameAr || user.roleSlug || 'موظف';

      const [newReport] = await db
        .insert(dailyReports)
        .values({
          userId: user.id,
          employeeId: user.employeeId || null,
          schoolId: resolvedSchoolId ?? null,
          employeeName,
          employeeRoleOrTitle,
          reportDate: finalDate,
          rawContent: text,
          audioDataUrl: audioDataUrl || null,
          audioDurationSec: Number(audioDurationSec || 0),
          reportType: finalReportType,
          targetAudience: finalTarget,
          financialAmount: String(extractedAmount || 0),
          extractedTasksJson: extractedTasks,
          attachmentsJson: safeAttachments,
          category:
            category || (finalReportType === 'financial' ? 'تقرير مالي ومصروفات' : 'تقرير مهام وتشغيل'),
          status: 'submitted',
        })
        .returning();

      // Create notification
      try {
        const notifTitle = `تقرير يومي جديد من: ${employeeName}`;
        const notifBody = `${
          finalReportType === 'financial' ? '💰 تقرير مالي' : '📋 تقرير مهام'
        }: ${text.slice(0, 120)}...`;

        await db.insert(notifications).values([
          {
            targetRole: 'super_admin',
            type: 'announcement',
            title: notifTitle,
            body: notifBody,
            isRead: false,
          },
        ]);
      } catch (notifErr) {
        console.warn('Failed to dispatch notification for daily report:', notifErr);
      }

      const schoolRow = newReport.schoolId
        ? (await db.select({ name: schools.name }).from(schools).where(eq(schools.id, newReport.schoolId)).limit(1))[0]
        : null;

      res.status(201).json({
        report: {
          ...newReport,
          schoolId: newReport.schoolId ?? null,
          schoolName: schoolRow?.name || 'الإدارة العامة',
          financialAmount: Number(newReport.financialAmount || 0),
          extractedTasks,
          attachments: safeAttachments,
          createdAt: newReport.createdAt.toISOString(),
          updatedAt: newReport.updatedAt.toISOString(),
        },
      });
    } catch (error) {
      console.error('Error creating daily report:', error);
      res.status(500).json({ error: 'تعذر حفظ التقرير اليومي' });
    }
  });

  app.patch('/api/daily-reports/:id', requireAuth, requireAdminOrStaff, async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      const user = req.dbUser!;
      const canReview =
        user.roleSlug === 'super_admin' ||
        user.roleSlug === 'accountant' ||
        user.roleSlug === 'movement_manager' ||
        hasPermission(user, 'finance:read') ||
        hasPermission(user, 'finance:write');
      if (!canReview) {
        return res.status(403).json({ error: 'مراجعة واعتماد التقارير متاح للمدير أو المحاسب أو مشرف الحركة فقط' });
      }

      const { status, accountantNotes, managerNotes } = req.body;

      const [existing] = await db.select().from(dailyReports).where(eq(dailyReports.id, id)).limit(1);
      if (!existing) {
        return res.status(404).json({ error: 'التقرير غير موجود' });
      }
      if (!isSchoolAllowed(user, existing.schoolId)) {
        return res.status(403).json({ error: 'هذا التقرير تابع لمدرسة خارج نطاق صلاحياتك' });
      }

      const updates: any = { updatedAt: new Date() };
      if (status !== undefined) updates.status = String(status);
      if (accountantNotes !== undefined) updates.accountantNotes = String(accountantNotes);
      if (managerNotes !== undefined) updates.managerNotes = String(managerNotes);

      const [updated] = await db
        .update(dailyReports)
        .set(updates)
        .where(eq(dailyReports.id, id))
        .returning();

      const schoolRow = updated.schoolId
        ? (await db.select({ name: schools.name }).from(schools).where(eq(schools.id, updated.schoolId)).limit(1))[0]
        : null;

      res.json({
        report: {
          ...updated,
          schoolId: updated.schoolId ?? null,
          schoolName: schoolRow?.name || 'الإدارة العامة',
          financialAmount: Number(updated.financialAmount || 0),
          extractedTasks: Array.isArray(updated.extractedTasksJson) ? updated.extractedTasksJson : [],
          attachments: Array.isArray(updated.attachmentsJson) ? updated.attachmentsJson : [],
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
        },
      });
    } catch (error) {
      console.error('Error updating daily report:', error);
      res.status(500).json({ error: 'تعذر تحديث التقرير' });
    }
  });

  app.patch('/api/finance/salaries/:id/status', requireAuth, requireAdminOrStaff, requirePermission('finance:write'), async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      const { status } = req.body;
      if (!['open', 'approved', 'paid'].includes(status)) {
        return res.status(400).json({ error: 'حالة الراتب غير صالحة' });
      }
      if (!isSchoolUnrestricted(req.dbUser)) {
        const [sal] = await db.select().from(salaries).where(eq(salaries.id, id)).limit(1);
        if (sal) {
          const drvSchoolId = await getDriverCurrentSchoolId(sal.driverId);
          if (!isSchoolAllowed(req.dbUser, drvSchoolId)) {
            return res.status(403).json({ error: 'هذا الراتب تابع لمدرسة خارج نطاق صلاحياتك' });
          }
        }
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
  app.get('/api/finance/period', requireAuth, async (req: AuthRequest, res) => {
    try {
      const schoolId = req.query.schoolId && req.query.schoolId !== 'all' ? Number(req.query.schoolId) : null;
      if (schoolId && !isSchoolAllowed(req.dbUser, schoolId)) {
        return res.status(403).json({ error: 'هذه المدرسة خارج نطاق صلاحياتك' });
      }
      const [activePeriod, schoolCfg] = await Promise.all([
        getActiveBillingPeriod(schoolId),
        getSchoolBillingConfigById(db, schoolId),
      ]);
      const autoPeriod = String(req.query.autoPeriod || '').toLowerCase() === 'true';
      const currentAutoRange = getCurrentBillingRangeForSchool(schoolCfg);
      const targetMonth = autoPeriod
        ? currentAutoRange.month
        : Number(req.query.month) || activePeriod.month;
      const targetYear = autoPeriod
        ? currentAutoRange.year
        : Number(req.query.year) || activePeriod.year;
      const financialPeriod = await GetFinancialPeriod(schoolId, targetMonth, targetYear);
      res.json({
        activePeriod,
        billingRange: financialPeriod,
        currentAutoRange,
        financialPeriod,
      });
    } catch (error) {
      res.status(500).json({ error: 'تعذر قراءة الشهر المالي المفتوح' });
    }
  });

  app.get('/api/finance/closings', requireAuth, requireAdminOrStaff, requirePermission('finance:read'), async (req: AuthRequest, res) => {
    try {
      const schoolId = req.query.schoolId ? Number(req.query.schoolId) : null;
      const [activePeriod, closings] = await Promise.all([
        getActiveBillingPeriod(schoolId),
        getMonthlyClosingsHistory(),
      ]);
      const filteredClosings = schoolId
        ? closings.filter((c) => c.schoolId === schoolId || c.schoolId === null)
        : closings.filter((c) => c.schoolId === null || isSchoolAllowed(req.dbUser, c.schoolId));
      res.json({ activePeriod, closings: filteredClosings });
    } catch (error) {
      console.error('Closings history error:', error);
      res.status(500).json({ error: 'تعذر تحميل سجل التصفيات الشهرية' });
    }
  });

  app.post('/api/finance/close-month', requireAuth, requireAdminOrStaff, requirePermission('finance:write'), async (req: AuthRequest, res) => {
    try {
      const rawSchoolId = req.body?.schoolId;
      const schoolId =
        rawSchoolId !== undefined && rawSchoolId !== null && rawSchoolId !== 'all'
          ? Number(rawSchoolId)
          : null;
      if (schoolId && !isSchoolAllowed(req.dbUser, schoolId)) {
        return res.status(403).json({ error: 'هذه المدرسة خارج نطاق صلاحياتك' });
      }
      if (!schoolId && !isSchoolUnrestricted(req.dbUser)) {
        return res.status(403).json({ error: 'التصفية الشاملة لجميع المدارس متاحة لصلاحية الإدارة العامة فقط' });
      }

      const activePeriod = await getActiveBillingPeriod(schoolId);
      const month = Number(req.body?.month) || activePeriod.month;
      const year = Number(req.body?.year) || activePeriod.year;
      const markAllPaid = req.body?.markAllPaid !== false;
      const notes = String(req.body?.notes || '').trim();

      const result = await closeMonthAndStartNext({
        month,
        year,
        schoolId,
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
      const rawSchoolId = req.body?.schoolId;
      const schoolId =
        rawSchoolId !== undefined && rawSchoolId !== null && rawSchoolId !== 'all'
          ? Number(rawSchoolId)
          : null;
      if (schoolId && !isSchoolAllowed(req.dbUser, schoolId)) {
        return res.status(403).json({ error: 'هذه المدرسة خارج نطاق صلاحياتك' });
      }
      if (!schoolId && !isSchoolUnrestricted(req.dbUser)) {
        return res.status(403).json({ error: 'تصفير جميع المدارس متاح لصلاحية الإدارة العامة فقط' });
      }

      const activePeriod = await getActiveBillingPeriod(schoolId);
      const month = Number(req.body?.month) || activePeriod.month;
      const year = Number(req.body?.year) || activePeriod.year;
      const resetEmployees = req.body?.resetEmployees !== false;

      const result = await resetMonthFinancials({
        month,
        year,
        schoolId,
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
      const dateStr = normalizeIsoDateInput(String(req.query.date || '')) || getTodayDateString();
      const records = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        const rows = await db.select().from(attendance).where(eq(attendance.date, dateStr));
        if (isSchoolUnrestricted(req.dbUser)) {
          return rows;
        }
        const allowedDrivers = (await getEnrichedDrivers()).filter((d) =>
          isSchoolAllowed(req.dbUser, d.schoolId)
        );
        const allowedSet = new Set(allowedDrivers.map((d) => d.id));
        return rows.filter((r) => allowedSet.has(r.driverId));
      });
      res.json({ date: dateStr, records });
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
      const cleanDate = normalizeIsoDateInput(String(date));
      const outcome = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        const drvSchoolId = await getDriverCurrentSchoolId(Number(driverId));
        if (!isSchoolAllowed(req.dbUser, drvSchoolId)) {
          return {
            status: 403 as const,
            body: { error: 'هذا السائق تابع لمدرسة خارج نطاق صلاحياتك' },
          };
        }
        const [row] = await db
          .insert(attendance)
          .values({
            driverId: Number(driverId),
            schoolId: drvSchoolId ?? null,
            date: cleanDate,
            status: String(status),
            notes: notes || '',
            recordedByUserId: req.dbUser!.id,
          })
          .onConflictDoUpdate({
            target: [attendance.driverId, attendance.date],
            set: {
              schoolId: drvSchoolId ?? null,
              status: String(status),
              notes: notes || '',
              recordedByUserId: req.dbUser!.id,
            },
          })
          .returning();
        return { status: 200 as const, body: { record: row } };
      });
      res.status(outcome.status).json(outcome.body);
    } catch (error) {
      console.error('Attendance save error:', error);
      res.status(500).json({ error: 'تعذر حفظ الحضور' });
    }
  });

  // 7. Live GPS Tracking
  app.get('/api/gps/fleet', requireAuth, requireAdminOrStaff, requirePermission('gps:read'), async (req: AuthRequest, res) => {
    try {
      const fleet = (await getFleetWithLatestGps()).filter(
        (v) => v.operationalStatus !== 'inactive' && isSchoolAllowed(req.dbUser, v.schoolId)
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
      if (!isSchoolUnrestricted(req.dbUser)) {
        const [assign] = await db
          .select({ schoolId: driverAssignments.schoolId })
          .from(driverAssignments)
          .where(and(eq(driverAssignments.vehicleId, vehicleId), eq(driverAssignments.isCurrent, true)))
          .limit(1);
        if (!assign || !isSchoolAllowed(req.dbUser, assign.schoolId)) {
          return res.status(403).json({ error: 'هذه المركبة خارج نطاق المدارس المصرح لك بها' });
        }
      }
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

  // 8. Egyptian Arabic AI Voice Assistant (Available to all authenticated staff & drivers)
  app.post('/api/voice/transcribe', requireAuth, async (req: AuthRequest, res) => {
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
                totalCoverageAdditions: Number(sal.totalCoverageAdditions || 0),
                otherDeductions: Number(sal.otherDeductions),
                bonuses: Number(sal.bonuses),
                netSalary: Number(sal.netSalary),
              },
            };
            finalReply = `كشف حساب السائق ${matchedDriver.fullName} (كود ${matchedDriver.driverCode}) للشهر ده: الراتب الأساسي ${Number(sal.baseSalary).toLocaleString('ar-EG')} جنيه، السلف ${Number(sal.totalAdvances).toLocaleString('ar-EG')} جنيه، خصم التغطيات ${Number(sal.totalCoverageDeductions).toLocaleString('ar-EG')} جنيه${Number(sal.totalCoverageAdditions || 0) > 0 ? `، مستحق تغطيات ${Number(sal.totalCoverageAdditions).toLocaleString('ar-EG')} جنيه` : ''}، المكافآت ${Number(sal.bonuses).toLocaleString('ar-EG')} جنيه، وصافي المستحق حالياً ${Number(sal.netSalary).toLocaleString('ar-EG')} جنيه.`;
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
          const schoolDrivers = matchedSchool
            ? enrichedDrivers.filter((d) => d.schoolId === matchedSchool.id)
            : enrichedDrivers;
          const schoolDriverIds = new Set(schoolDrivers.map((d) => d.id));
          const targetRange = getBillingDateRangeForPeriod(month, year, matchedSchool || null);
          let minAdvStart = targetRange.startDate;
          let maxAdvEnd = targetRange.endDate;
          if (!matchedSchool) {
            for (const s of allSchools) {
              const r = getBillingDateRangeForPeriod(month, year, s);
              if (r.startDate < minAdvStart) minAdvStart = r.startDate;
              if (r.endDate > maxAdvEnd) maxAdvEnd = r.endDate;
            }
          }
          const monthAdv = await db
            .select()
            .from(advances)
            .where(
              and(
                eq(advances.isReversed, false),
                gte(advances.date, minAdvStart),
                lte(advances.date, maxAdvEnd)
              )
            );
          const schoolMapVoice: Record<number, (typeof allSchools)[number]> = {};
          for (const s of allSchools) schoolMapVoice[s.id] = s;
          const filteredAdv = monthAdv.filter((a) => {
            if (!schoolDriverIds.has(a.driverId)) return false;
            const drv = enrichedDrivers.find((d) => d.id === a.driverId);
            const drvRange = getBillingDateRangeForPeriod(
              month,
              year,
              drv?.schoolId ? schoolMapVoice[drv.schoolId] : null
            );
            return isDateInRange(a.date, drvRange.startDate, drvRange.endDate);
          });
          const total = filteredAdv.reduce((sum, a) => sum + Number(a.amount || 0), 0);
          queryResult = {
            type: 'school_advances_total',
            schoolName: matchedSchool?.name || 'كل المدارس',
            total,
            count: filteredAdv.length,
          };
          finalReply = matchedSchool
            ? `إجمالي السلف في ${matchedSchool.name} الدورة الحالية هو ${total.toLocaleString('ar-EG')} جنيه بإجمالي ${filteredAdv.length} عملية.`
            : `إجمالي السلف في المكتب كله الدورة الحالية ${total.toLocaleString('ar-EG')} جنيه بإجمالي ${filteredAdv.length} عملية.`;
        } else if (interpreted.intent === 'top_advance_driver') {
          let minAdvStart = getBillingDateRangeForPeriod(month, year, null).startDate;
          let maxAdvEnd = getBillingDateRangeForPeriod(month, year, null).endDate;
          const schoolMapVoice: Record<number, (typeof allSchools)[number]> = {};
          for (const s of allSchools) {
            schoolMapVoice[s.id] = s;
            const r = getBillingDateRangeForPeriod(month, year, s);
            if (r.startDate < minAdvStart) minAdvStart = r.startDate;
            if (r.endDate > maxAdvEnd) maxAdvEnd = r.endDate;
          }
          const monthAdv = await db
            .select()
            .from(advances)
            .where(
              and(
                eq(advances.isReversed, false),
                gte(advances.date, minAdvStart),
                lte(advances.date, maxAdvEnd)
              )
            );
          const totalsByDriver: Record<number, number> = {};
          for (const a of monthAdv) {
            const drv = enrichedDrivers.find((d) => d.id === a.driverId);
            const drvRange = getBillingDateRangeForPeriod(
              month,
              year,
              drv?.schoolId ? schoolMapVoice[drv.schoolId] : null
            );
            if (!isDateInRange(a.date, drvRange.startDate, drvRange.endDate)) continue;
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
            ? `أكتر سائق أخد سلف الدورة الحالية هو ${topDriver.fullName} (كود ${topDriver.driverCode}) بإجمالي ${topAmount.toLocaleString('ar-EG')} جنيه.`
            : `لم يتم تسجيل أي سلف خلال الدورة المالية الحالية حتى الآن.`;
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
          const schoolRev = allSchools
            .filter((s) => s.isActive)
            .reduce((sum, s) => sum + Number(s.monthlyContractValue || 0), 0);
          queryResult = { type: 'monthly_profit', schoolRev, profit: schoolRev };
          finalReply = `إجمالي إيرادات عقود المدارس الشهرية المتوقعة هو ${schoolRev.toLocaleString('ar-EG')} جنيه.`;
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
            const oldDeduction = Number(targetCoverage.absentDriverDeduction || targetCoverage.actualReplacementCost || 0);
            const nextAmount =
              interpreted.intent === 'delete_coverage'
                ? 0
                : Number(
                    interpreted.absentDriverDeduction ||
                      interpreted.actualReplacementCost ||
                      interpreted.amount ||
                      oldDeduction
                  );
            const projectedNet = currentNet + oldDeduction - nextAmount;

            const availableCoverages = driverCoverages.map((c) => {
              const amt = Number(c.absentDriverDeduction || c.actualReplacementCost || 0);
              return {
                id: c.id,
                date: c.date,
                coverageAmount: amt,
                actualReplacementCost: amt,
                absentDriverDeduction: amt,
                reason: c.reason || '',
                replacementName: c.replacementDriverId
                  ? driverNameMap[c.replacementDriverId] || '—'
                  : c.replacementExternalName || '',
              };
            });

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
                amount: interpreted.intent === 'delete_coverage' ? oldDeduction : nextAmount,
                actualReplacementCost:
                  interpreted.intent === 'delete_coverage' ? oldDeduction : nextAmount,
                absentDriverDeduction:
                  interpreted.intent === 'delete_coverage' ? oldDeduction : nextAmount,
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
                ? `جاهز لحذف سجل التغطية بتاريخ ${targetCoverage.date} للسائق ${matchedDriver.fullName} (قيمة ${oldDeduction.toLocaleString('ar-EG')} جنيه). اضغط تأكيد للتنفيذ.`
                : `جاهز لتعديل تغطية السائق ${matchedDriver.fullName} بتاريخ ${targetCoverage.date} بقيمة موحدة ${nextAmount.toLocaleString('ar-EG')} جنيه. راجع البيانات واضغط تأكيد للحفظ.`;
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
              ? Number(interpreted.absentDriverDeduction || interpreted.actualReplacementCost || interpreted.amount || 350)
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
              replacementQuery: interpreted.replacementDriverQuery || '',
              amount: amt,
              actualReplacementCost: interpreted.intent === 'record_coverage' ? amt : 0,
              absentDriverDeduction: interpreted.intent === 'record_coverage' ? amt : 0,
              date: interpreted.date || todayDate,
              reason: interpreted.reason || 'أمر صوتي من المدير',
              paymentMethod: interpreted.paymentMethod || 'cash',
            },
          };

          if (interpreted.intent === 'record_advance') {
            finalReply = `جاهز لتسجيل سلفة بمبلغ ${amt.toLocaleString('ar-EG')} جنيه للسائق ${matchedDriver.fullName} (كود ${matchedDriver.driverCode}). اضغط تأكيد لتنفيذ العملية وتحديث صافي راتبه إلى ${projectedNet.toLocaleString('ar-EG')} جنيه.`;
          } else if (interpreted.intent === 'record_coverage') {
            finalReply = `جاهز لتسجيل تغطية غياب للسائق ${matchedDriver.fullName} (كود ${matchedDriver.driverCode}) بتاريخ ${interpreted.date || todayDate} بقيمة ${amt.toLocaleString('ar-EG')} جنيه (تُخصم من الأساسي وتُضاف للبديل). اضغط تأكيد للتنفيذ.`;
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

      const idempKey = logId ? `voice-${logId}` : undefined;
      const actionSummary = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        let summary = '';
        const cleanVoiceDate = normalizeIsoDateInput(payload.date ? String(payload.date) : getTodayDateString());

        if (payload.intent === 'record_advance') {
          const result = await recordAdvanceTransaction({
            driverId: Number(payload.driverId),
            schoolId: payload.schoolId ? Number(payload.schoolId) : null,
            amount: Number(payload.amount),
            date: cleanVoiceDate,
            reason: String(payload.reason || 'سلفة بأمر صوتي'),
            paymentMethod: String(payload.paymentMethod || 'cash'),
            notes: 'تم التنفيذ عبر المساعد الصوتي بعد تأكيد المدير',
            recordedByUserId: req.dbUser!.id,
            idempotencyKey: idempKey,
            ipAddress: req.ip || '',
          });
          summary = `تم تنفيذ السلفة بنجاح بمبلغ ${Number(payload.amount).toLocaleString('ar-EG')} جنيه للسائق ${payload.driverName}. صافي الراتب المحدث: ${Number(result.salary?.netSalary || 0).toLocaleString('ar-EG')} جنيه.`;
        } else if (payload.intent === 'record_coverage') {
          const unifiedAmt = Number(
            payload.coverageAmount ?? payload.absentDriverDeduction ?? payload.actualReplacementCost ?? payload.amount ?? 0
          );
          const repText = String(payload.replacementQuery || payload.replacementExternalName || '').trim();
          const resolvedRep = payload.replacementDriverId
            ? await resolveDriverByIdOrQuery({ driverId: payload.replacementDriverId })
            : repText
            ? await resolveDriverByIdOrQuery({ driverQuery: repText })
            : null;
          const result = await recordCoverageTransaction({
            absentDriverId: Number(payload.driverId),
            replacementDriverId: resolvedRep ? resolvedRep.id : null,
            replacementExternalName: resolvedRep ? '' : repText || 'سائق تغطية',
            vehicleId: payload.vehicleId ? Number(payload.vehicleId) : null,
            schoolId: payload.schoolId ? Number(payload.schoolId) : null,
            date: cleanVoiceDate,
            coverageAmount: unifiedAmt,
            reason: String(payload.reason || 'تغطية غياب بأمر صوتي'),
            notes: 'تم التنفيذ عبر المساعد الصوتي بعد تأكيد المدير',
            recordedByUserId: req.dbUser!.id,
            idempotencyKey: idempKey,
            ipAddress: req.ip || '',
          });
          summary = `تم تسجيل تغطية الغياب للسائق ${payload.driverName} بقيمة ${unifiedAmt.toLocaleString('ar-EG')} جنيه. صافي الراتب المحدث: ${Number(result.salary?.netSalary || 0).toLocaleString('ar-EG')} جنيه.`;
        } else if (payload.intent === 'record_bonus' || payload.intent === 'record_deduction') {
          const schoolCfg = await getDriverSchoolBillingConfig(db, Number(payload.driverId));
          const targetPeriod = getMonthYearFromDate(cleanVoiceDate, schoolCfg);
          const result = await recordAdjustmentTransaction({
            driverId: Number(payload.driverId),
            month: targetPeriod.month,
            year: targetPeriod.year,
            type: payload.intent === 'record_bonus' ? 'bonus' : 'other_deduction',
            amount: Number(payload.amount),
            description: String(payload.reason || 'تسوية بأمر صوتي'),
            recordedByUserId: req.dbUser!.id,
            ipAddress: req.ip || '',
          });
          summary = `تم تسجيل التسوية بنجاح للسائق ${payload.driverName}. صافي الراتب المحدث: ${Number(result.salary.netSalary).toLocaleString('ar-EG')} جنيه.`;
        } else if (payload.intent === 'edit_advance') {
          if (!payload.targetRecordId) {
            throw new Error('لم يتم تحديد سجل السلفة المطلوب تعديله');
          }
          const result = await updateAdvanceTransaction({
            id: Number(payload.targetRecordId),
            amount: Number(payload.amount),
            date: cleanVoiceDate,
            reason: String(payload.reason || ''),
            paymentMethod: String(payload.paymentMethod || 'cash'),
            notes: 'تم التعديل عبر المساعد الصوتي بعد تأكيد المدير',
            recordedByUserId: req.dbUser!.id,
            ipAddress: req.ip || '',
          });
          summary = `تم تعديل السلفة بنجاح إلى ${Number(payload.amount).toLocaleString('ar-EG')} جنيه للسائق ${payload.driverName}. صافي الراتب المحدث: ${Number(result.salary?.netSalary || 0).toLocaleString('ar-EG')} جنيه.`;
        } else if (payload.intent === 'delete_advance') {
          if (!payload.targetRecordId) {
            throw new Error('لم يتم تحديد سجل السلفة المطلوب حذفه');
          }
          const result = await deleteAdvanceTransaction({
            id: Number(payload.targetRecordId),
            recordedByUserId: req.dbUser!.id,
            ipAddress: req.ip || '',
          });
          summary = `تم حذف السلفة بنجاح للسائق ${payload.driverName}. صافي الراتب المحدث: ${Number(result.salary?.netSalary || 0).toLocaleString('ar-EG')} جنيه.`;
        } else if (payload.intent === 'edit_coverage') {
          if (!payload.targetRecordId) {
            throw new Error('لم يتم تحديد سجل التغطية المطلوب تعديله');
          }
          const unifiedAmt = Number(
            payload.coverageAmount ?? payload.absentDriverDeduction ?? payload.actualReplacementCost ?? payload.amount ?? 0
          );
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
            date: cleanVoiceDate,
            coverageAmount: unifiedAmt,
            reason: String(payload.reason || ''),
            notes: 'تم التعديل عبر المساعد الصوتي بعد تأكيد المدير',
            recordedByUserId: req.dbUser!.id,
            ipAddress: req.ip || '',
          });
          summary = `تم تعديل سجل التغطية للسائق ${payload.driverName} بنجاح بقيمة ${unifiedAmt.toLocaleString('ar-EG')} جنيه. صافي الراتب المحدث: ${Number(result.salary?.netSalary || 0).toLocaleString('ar-EG')} جنيه.`;
        } else if (payload.intent === 'delete_coverage') {
          if (!payload.targetRecordId) {
            throw new Error('لم يتم تحديد سجل التغطية المطلوب حذفه');
          }
          const result = await deleteCoverageTransaction({
            id: Number(payload.targetRecordId),
            recordedByUserId: req.dbUser!.id,
            ipAddress: req.ip || '',
          });
          summary = `تم حذف سجل التغطية بنجاح للسائق ${payload.driverName}. صافي الراتب المحدث: ${Number(result.salary?.netSalary || 0).toLocaleString('ar-EG')} جنيه.`;
        } else {
          throw new Error('نوع العملية غير مدعوم للتنفيذ');
        }

        if (logId) {
          await db
            .update(voiceCommandLogs)
            .set({
              wasConfirmed: true,
              executionStatus: 'executed',
              responseArabic: summary,
            })
            .where(eq(voiceCommandLogs.id, Number(logId)));
        }
        return summary;
      });

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
      if (req.dbUser?.roleSlug === 'supervisor' || req.supervisorRecord) {
        return res.json({ notifications: [] });
      }
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

  app.post('/api/notifications/mark-all-read', requireAuth, async (req: AuthRequest, res) => {
    try {
      if (req.dbUser?.roleSlug === 'driver') {
        if (!req.driverRecord) {
          return res.status(403).json({ error: 'غير مصرح لك بتعديل الإشعارات' });
        }
        await db
          .update(notifications)
          .set({ isRead: true })
          .where(eq(notifications.recipientDriverId, req.driverRecord.id));
        return res.json({ ok: true });
      }
      await db.update(notifications).set({ isRead: true });
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'تعذر تحديث الإشعارات' });
    }
  });

  // 10. Users, Roles & Audit Logs (Super Admin Staff Appointment & Granular RBAC)
  app.get('/api/users', requireAuth, requireAdminOrStaff, requirePermission('*'), async (_req: AuthRequest, res) => {
    try {
      const [allUsers, allRoles, allSchools, allEmployees] = await Promise.all([
        db.select().from(users).orderBy(users.id),
        db.select().from(userRoles).orderBy(userRoles.id),
        db.select().from(schools).orderBy(schools.name),
        db.select().from(employees).orderBy(employees.fullName),
      ]);
      const roleById: Record<number, typeof userRoles.$inferSelect> = {};
      for (const r of allRoles) roleById[r.id] = r;

      const schoolMap: Record<number, string> = {};
      for (const s of allSchools) schoolMap[s.id] = s.name;

      const empMap: Record<number, string> = {};
      for (const e of allEmployees) empMap[e.id] = e.fullName;

      res.json({
        users: allUsers.map((u) => {
          const role = roleById[u.roleId];
          const roleSlug = role?.slug || 'driver';
          const assignedSchoolIds =
            roleSlug === 'super_admin' ? [] : normalizeSchoolIds(u.assignedSchoolIds);
          return {
            ...u,
            roleSlug,
            roleNameAr: role?.nameAr || 'سائق',
            assignedSchoolIds,
            assignedSchoolNames: assignedSchoolIds
              .map((sid) => schoolMap[sid])
              .filter(Boolean),
            customPermissions: Array.isArray(u.customPermissions) ? u.customPermissions : null,
            effectivePermissions: buildEffectivePermissions(
              roleSlug,
              role?.permissions,
              u.customPermissions
            ),
            staffCode: u.staffCode || '',
            employeeId: u.employeeId ?? null,
            employeeName: u.employeeId ? empMap[u.employeeId] || null : null,
          };
        }),
        roles: allRoles,
        schools: allSchools
          .filter((s) => s.isActive)
          .map((s) => ({ id: s.id, name: s.name })),
        employees: allEmployees
          .filter((e) => e.status === 'active')
          .map((e) => ({
            id: e.id,
            fullName: e.fullName,
            jobTitle: e.jobTitle,
            phone: e.phone,
            employeeCode: e.employeeCode,
          })),
      });
    } catch (error) {
      console.error('Get users error:', error);
      res.status(500).json({ error: 'تعذر تحميل المستخدمين' });
    }
  });

  app.post('/api/users', requireAuth, requireAdminOrStaff, requirePermission('*'), async (req: AuthRequest, res) => {
    try {
      if (req.dbUser?.roleSlug !== 'super_admin') {
        return res.status(403).json({ error: 'إضافة وتعيين الموظفين متاح للمدير العام فقط' });
      }
      const {
        fullName,
        email,
        phone,
        roleId,
        roleSlug,
        assignedSchoolIds,
        customPermissions,
        staffCode,
        employeeId,
        isActive,
      } = req.body;

      const trimmedName = String(fullName || '').trim();
      if (!trimmedName) {
        return res.status(400).json({ error: 'الاسم الكامل مطلوب' });
      }

      const allRoles = await db.select().from(userRoles);
      const targetRole = roleId
        ? allRoles.find((r) => r.id === Number(roleId))
        : roleSlug
        ? allRoles.find((r) => r.slug === String(roleSlug))
        : allRoles.find((r) => r.slug === 'accountant');

      if (!targetRole) {
        return res.status(400).json({ error: 'الدور الوظيفي المحدد غير موجود' });
      }
      if (targetRole.slug === 'driver' || targetRole.slug === 'supervisor') {
        return res.status(400).json({
          error: 'يتم إضافة السائقين من قسم السائقين والمشرفات من قسم المشرفات',
        });
      }

      const cleanStaffCode = normalizeDriverCode(staffCode || '') || `STF-${Math.floor(1000 + Math.random() * 9000)}`;
      const cleanPhone = normalizeEgyptPhone(phone || '') || String(phone || '').trim();
      const rawEmail = String(email || '').trim().toLowerCase();
      const cleanEmail = rawEmail || `staff.${Date.now()}.${Math.floor(Math.random() * 1000)}@staff.alwaleed.local`;

      // Auto-purge any stale inactive non-owner accounts that held this email
      const allUsersRows = await db.select().from(users);
      const staleEmailUser = allUsersRows.find(
        (u) =>
          u.email.toLowerCase() === cleanEmail &&
          !u.isActive &&
          u.email.toLowerCase() !== 'hamdyhamzway@gmail.com'
      );
      if (staleEmailUser) {
        await db.transaction(async (tx) => {
          await permanentlyDeleteUserTx(tx, staleEmailUser.id, req.dbUser!.id);
        });
      }

      // Check active duplicate email
      const [dupEmail] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, cleanEmail))
        .limit(1);
      if (dupEmail) {
        return res.status(409).json({ error: 'هذا البريد الإلكتروني مستخدم بالفعل لحساب نشط آخر' });
      }

      // Auto-purge any stale inactive staffCode user
      const staleCodeUser = allUsersRows.find(
        (u) =>
          u.staffCode &&
          normalizeDriverCode(u.staffCode).toLowerCase() === cleanStaffCode.toLowerCase() &&
          !u.isActive &&
          u.email.toLowerCase() !== 'hamdyhamzway@gmail.com'
      );
      if (staleCodeUser) {
        await db.transaction(async (tx) => {
          await permanentlyDeleteUserTx(tx, staleCodeUser.id, req.dbUser!.id);
        });
      }

      const refreshedUsers = await db.select().from(users);
      const dupCode = refreshedUsers.find(
        (u) =>
          u.isActive &&
          u.staffCode &&
          normalizeDriverCode(u.staffCode).toLowerCase() === cleanStaffCode.toLowerCase()
      );
      if (dupCode) {
        return res.status(409).json({ error: `كود الدخول ${cleanStaffCode} مستخدم لموظف آخر` });
      }

      const nextEmployeeId = employeeId ? Number(employeeId) : null;
      if (nextEmployeeId) {
        const linkedConflict = refreshedUsers.find((u) => u.isActive && u.employeeId === nextEmployeeId);
        if (linkedConflict) {
          return res.status(409).json({ error: 'هذا الموظف لديه حساب وصلاحيات مفعلة بالفعل — يمكنك تعديله من القائمة' });
        }
      }

      const nextSchools = targetRole.slug === 'super_admin' ? [] : normalizeSchoolIds(assignedSchoolIds);
      const nextCustomPerms =
        targetRole.slug === 'super_admin' ? null : normalizePermissionsList(customPermissions);

      const [created] = await db
        .insert(users)
        .values({
          uid: `staff_pre_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
          email: cleanEmail,
          fullName: trimmedName,
          phone: cleanPhone || null,
          roleId: targetRole.id,
          assignedSchoolIds: nextSchools,
          customPermissions: nextCustomPerms,
          staffCode: cleanStaffCode,
          employeeId: nextEmployeeId,
          isActive: isActive !== false,
        })
        .returning();

      await db.insert(auditLogs).values({
        actorUserId: req.dbUser!.id,
        action: 'CREATE_STAFF_USER',
        entityType: 'users',
        entityId: String(created.id),
        afterJson: {
          fullName: created.fullName,
          roleSlug: targetRole.slug,
          assignedSchoolIds: nextSchools,
          staffCode: cleanStaffCode,
        },
        ipAddress: req.ip || '',
      });

      res.status(201).json({ user: created });
    } catch (error) {
      console.error('Create staff user error:', error);
      res.status(500).json({ error: 'تعذر إنشاء حساب الموظف ومنحه الصلاحيات' });
    }
  });

  app.patch('/api/users/:id', requireAuth, requireAdminOrStaff, requirePermission('*'), async (req: AuthRequest, res) => {
    try {
      if (req.dbUser?.roleSlug !== 'super_admin') {
        return res.status(403).json({ error: 'تعديل حسابات وصلاحيات الموظفين متاح للمدير العام فقط' });
      }
      const userId = Number(req.params.id);
      const [existing] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!existing) {
        return res.status(404).json({ error: 'المستخدم غير موجود' });
      }

      const {
        fullName,
        email,
        phone,
        roleId,
        roleSlug,
        assignedSchoolIds,
        customPermissions,
        staffCode,
        employeeId,
        isActive,
      } = req.body;

      const allRoles = await db.select().from(userRoles);
      const currentRole = allRoles.find((r) => r.id === existing.roleId);
      let nextRole = currentRole;
      if (roleId) {
        nextRole = allRoles.find((r) => r.id === Number(roleId));
      } else if (roleSlug) {
        nextRole = allRoles.find((r) => r.slug === String(roleSlug));
      }
      if (!nextRole) {
        return res.status(400).json({ error: 'الدور الوظيفي المحدد غير موجود' });
      }

      if (existing.email === 'hamdyhamzway@gmail.com') {
        if (nextRole.slug !== 'super_admin' || isActive === false) {
          return res.status(400).json({ error: 'لا يمكن إيقاف أو تخفيض صلاحية المالك الرئيسي للنظام' });
        }
      }

      const nextEmail =
        email !== undefined && String(email).trim()
          ? String(email).trim().toLowerCase()
          : existing.email;

      if (nextEmail !== existing.email) {
        const [dup] = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.email, nextEmail), ne(users.id, userId)))
          .limit(1);
        if (dup) {
          return res.status(409).json({ error: 'البريد الإلكتروني مستخدم لحساب آخر' });
        }
      }

      const nextStaffCode =
        staffCode !== undefined ? normalizeDriverCode(staffCode) : existing.staffCode || '';
      if (nextStaffCode) {
        const allOthers = await db.select().from(users).where(ne(users.id, userId));
        const dupCode = allOthers.find(
          (u) =>
            u.staffCode &&
            normalizeDriverCode(u.staffCode).toLowerCase() === nextStaffCode.toLowerCase()
        );
        if (dupCode) {
          return res.status(409).json({ error: `كود الدخول ${nextStaffCode} مستخدم لموظف آخر` });
        }
      }

      const nextSchools =
        nextRole.slug === 'super_admin'
          ? []
          : assignedSchoolIds !== undefined
          ? normalizeSchoolIds(assignedSchoolIds)
          : normalizeSchoolIds(existing.assignedSchoolIds);

      const nextCustomPerms =
        nextRole.slug === 'super_admin'
          ? null
          : customPermissions !== undefined
          ? normalizePermissionsList(customPermissions)
          : existing.customPermissions;

      const nextEmployeeId =
        employeeId !== undefined ? (employeeId ? Number(employeeId) : null) : existing.employeeId;

      const [updated] = await db
        .update(users)
        .set({
          fullName: fullName !== undefined ? String(fullName).trim() || existing.fullName : existing.fullName,
          email: nextEmail,
          phone: phone !== undefined ? (normalizeEgyptPhone(phone) || String(phone).trim() || null) : existing.phone,
          roleId: nextRole.id,
          assignedSchoolIds: nextSchools,
          customPermissions: nextCustomPerms,
          staffCode: nextStaffCode,
          employeeId: nextEmployeeId,
          isActive: isActive !== undefined ? Boolean(isActive) : existing.isActive,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId))
        .returning();

      await db.insert(auditLogs).values({
        actorUserId: req.dbUser!.id,
        action: 'UPDATE_STAFF_USER',
        entityType: 'users',
        entityId: String(userId),
        beforeJson: {
          roleId: existing.roleId,
          assignedSchoolIds: existing.assignedSchoolIds,
          isActive: existing.isActive,
        },
        afterJson: {
          roleId: updated.roleId,
          assignedSchoolIds: updated.assignedSchoolIds,
          customPermissions: updated.customPermissions,
          isActive: updated.isActive,
        },
        ipAddress: req.ip || '',
      });

      res.json({ user: updated });
    } catch (error) {
      console.error('Update staff user error:', error);
      res.status(500).json({ error: 'تعذر تحديث بيانات وصلاحيات الموظف' });
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

  app.delete('/api/users/:id', requireAuth, requireAdminOrStaff, requirePermission('*'), async (req: AuthRequest, res) => {
    try {
      if (req.dbUser?.roleSlug !== 'super_admin') {
        return res.status(403).json({ error: 'حذف حسابات الموظفين متاح للمدير العام فقط' });
      }
      const userId = Number(req.params.id);
      if (userId === req.dbUser.id) {
        return res.status(400).json({ error: 'لا يمكنك حذف حسابك النشط الحالي' });
      }
      const [existing] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!existing) {
        return res.status(404).json({ error: 'المستخدم غير موجود' });
      }
      if (existing.email === 'hamdyhamzway@gmail.com') {
        return res.status(400).json({ error: 'لا يمكن حذف حساب المدير العام الرئيسي' });
      }

      await db.transaction(async (tx) => {
        await permanentlyDeleteUserTx(tx, userId, req.dbUser!.id);
        await tx.insert(auditLogs).values({
          actorUserId: req.dbUser!.id,
          action: 'PERMANENT_DELETE_STAFF_USER',
          entityType: 'users',
          entityId: String(userId),
          beforeJson: existing,
          ipAddress: req.ip || '',
        });
      });

      res.json({ ok: true, deletedId: userId, message: 'تم مسح الحساب نهائياً وتحرير البريد الإلكتروني وكود الدخول.' });
    } catch (error) {
      console.error('Delete user error:', error);
      res.status(500).json({ error: 'تعذر حذف المستخدم' });
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
      const rawSchoolId = req.query.schoolId;
      const parsedSchoolId =
        rawSchoolId && rawSchoolId !== 'all' ? Number(rawSchoolId) : null;
      const selectedSchoolId =
        parsedSchoolId && Number.isFinite(parsedSchoolId) ? parsedSchoolId : null;
      if (selectedSchoolId && !isSchoolAllowed(req.dbUser, selectedSchoolId)) {
        return res.status(403).json({ error: 'هذه المدرسة خارج نطاق صلاحياتك' });
      }

      const autoPeriod = String(req.query.autoPeriod || '').toLowerCase() === 'true';
      const unrestricted = isSchoolUnrestricted(req.dbUser);
      const summaryPayload = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        const [rawAllSchools, allClosings, rawAllDrivers] = await Promise.all([
          db.select().from(schools).orderBy(schools.name),
          getMonthlyClosingsHistory(),
          getEnrichedDrivers(),
        ]);

        const scopedSchools = rawAllSchools.filter((s) => isSchoolAllowed(req.dbUser, s.id));
        const selectedSchool = selectedSchoolId
          ? rawAllSchools.find((s) => s.id === selectedSchoolId) || null
          : null;

        const schoolConfigsById: Record<number, SchoolBillingConfig> = {};
        await Promise.all(
          rawAllSchools.map(async (s) => {
            const cfg = await getSchoolBillingConfigById(db, s.id);
            if (cfg) schoolConfigsById[s.id] = cfg;
          })
        );
        const selectedSchoolCfg = selectedSchoolId
          ? schoolConfigsById[selectedSchoolId] || selectedSchool
          : null;

        const activePeriod = await getActiveBillingPeriod(selectedSchoolId);
        let month = Number(req.query.month) || activePeriod.month;
        let year = Number(req.query.year) || activePeriod.year;
        if (autoPeriod) {
          const autoRange = getCurrentBillingRangeForSchool(selectedSchoolCfg);
          month = autoRange.month;
          year = autoRange.year;
        }

        const defaultRange = getBillingDateRangeForPeriod(month, year, selectedSchoolCfg);
        const rangeBySchoolKey = new Map<string, ReturnType<typeof getBillingDateRangeForPeriod>>();
        rangeBySchoolKey.set('none', getBillingDateRangeForPeriod(month, year, null));
        let minStartDate = defaultRange.startDate;
        let maxEndDate = defaultRange.endDate;

        const schoolBillingRanges: Array<{
          schoolId: number;
          schoolName: string;
          range: ReturnType<typeof getBillingDateRangeForPeriod>;
        }> = [];
        for (const s of scopedSchools) {
          const cfg = schoolConfigsById[s.id] || s;
          const r = getBillingDateRangeForPeriod(month, year, cfg);
          rangeBySchoolKey.set(String(s.id), r);
          schoolBillingRanges.push({ schoolId: s.id, schoolName: s.name, range: r });
          if (r.startDate < minStartDate) minStartDate = r.startDate;
          if (r.endDate > maxEndDate) maxEndDate = r.endDate;
        }
        const getRangeForSchool = (sId?: number | null) =>
          (sId ? rangeBySchoolKey.get(String(sId)) : undefined) || rangeBySchoolKey.get('none')!;

        const isClosedForSchool = (sId?: number | null) =>
          allClosings.some(
            (c) =>
              c.month === month &&
              c.year === year &&
              (c.schoolId === null || (sId != null && c.schoolId === sId))
          );

        const allDrivers = rawAllDrivers.filter(
          (d) =>
            isSchoolAllowed(req.dbUser, d.schoolId) &&
            (!selectedSchoolId || d.schoolId === selectedSchoolId)
        );
        const scopedDriverIds = new Set(allDrivers.map((d) => d.id));
        const activeDrivers = allDrivers.filter((d) => d.accountStatus === 'active');

        for (const d of activeDrivers) {
          if (!isClosedForSchool(d.schoolId)) {
            await recalculateDriverSalary(
              db,
              d.id,
              month,
              year,
              d.schoolId ? schoolConfigsById[d.schoolId] || null : null
            );
          }
        }

        const [
          rawMonthSalaries,
          rawWindowAdvances,
          rawWindowCoverages,
          rawWindowAttendance,
          rawFleet,
          supervisorSummaries,
        ] = await Promise.all([
          db
            .select()
            .from(salaries)
            .where(and(eq(salaries.month, month), eq(salaries.year, year))),
          db
            .select()
            .from(advances)
            .where(
              and(
                eq(advances.isReversed, false),
                gte(advances.date, minStartDate),
                lte(advances.date, maxEndDate)
              )
            ),
          db
            .select()
            .from(coverageRecords)
            .where(
              and(
                eq(coverageRecords.isReversed, false),
                gte(coverageRecords.date, minStartDate),
                lte(coverageRecords.date, maxEndDate)
              )
            ),
          db
            .select()
            .from(attendance)
            .where(and(gte(attendance.date, minStartDate), lte(attendance.date, maxEndDate))),
          getFleetWithLatestGps(),
          getSupervisorCycleSummaries({
            month,
            year,
            schoolId: selectedSchoolId,
            allowedSchoolIds: unrestricted ? null : req.dbUser?.assignedSchoolIds || [],
          }),
        ]);

        const driverById: Record<number, (typeof rawAllDrivers)[number]> = {};
        for (const d of rawAllDrivers) driverById[d.id] = d;

        const filteredAdvances = rawWindowAdvances.filter((a) => {
          const drv = driverById[a.driverId];
          if (!drv || !isSchoolAllowed(req.dbUser, drv.schoolId)) return false;
          if (selectedSchoolId && drv.schoolId !== selectedSchoolId) return false;
          const r = getRangeForSchool(a.schoolId ?? drv.schoolId);
          return isDateInRange(a.date, r.startDate, r.endDate);
        });

        const filteredCoverages = rawWindowCoverages.filter((c) => {
          const drv = driverById[c.absentDriverId];
          const effSchoolId = c.schoolId ?? drv?.schoolId ?? null;
          if (!isSchoolAllowed(req.dbUser, effSchoolId) && !scopedDriverIds.has(c.absentDriverId)) {
            return false;
          }
          if (selectedSchoolId && effSchoolId !== selectedSchoolId) return false;
          const r = getRangeForSchool(effSchoolId);
          return isDateInRange(c.date, r.startDate, r.endDate);
        });

        const filteredAttendance = rawWindowAttendance.filter((a) => {
          const drv = driverById[a.driverId];
          if (!drv || !isSchoolAllowed(req.dbUser, drv.schoolId)) return false;
          if (selectedSchoolId && drv.schoolId !== selectedSchoolId) return false;
          const r = getRangeForSchool(drv.schoolId);
          return isDateInRange(a.date, r.startDate, r.endDate);
        });

        const activeIds = new Set(activeDrivers.map((d) => d.id));
        const monthSalaries = rawMonthSalaries.filter((s) => {
          if (!scopedDriverIds.has(s.driverId)) return false;
          const drv = driverById[s.driverId];
          return isClosedForSchool(drv?.schoolId) || activeIds.has(s.driverId);
        });
        const reportDriverIds = new Set(monthSalaries.map((s) => s.driverId));
        const enrichedDrivers = allDrivers.filter(
          (d) => reportDriverIds.has(d.id) || d.accountStatus === 'active'
        );

        return {
          period: {
            month,
            year,
            startDate: defaultRange.startDate,
            endDate: defaultRange.endDate,
            startDateTime: defaultRange.startDateTime,
            endDateTime: defaultRange.endDateTime,
            labelAr: defaultRange.labelAr,
            shortLabelAr: defaultRange.shortLabelAr,
            schoolId: selectedSchoolId,
            schoolName: selectedSchool?.name || null,
          },
          schoolBillingRanges,
          drivers: enrichedDrivers,
          salaries: monthSalaries,
          advances: filteredAdvances,
          coverages: filteredCoverages,
          attendance: filteredAttendance,
          supervisors: supervisorSummaries,
          schools: selectedSchoolId
            ? scopedSchools.filter((s) => s.id === selectedSchoolId)
            : scopedSchools,
          fleet: rawFleet.filter(
            (v) =>
              isSchoolAllowed(req.dbUser, v.schoolId) &&
              (!selectedSchoolId || v.schoolId === selectedSchoolId)
          ),
        };
      });

      res.json(summaryPayload);
    } catch (error) {
      console.error('Reports error:', error);
      res.status(500).json({ error: 'تعذر إنشاء التقرير' });
    }
  });

  // 12. Driver Mobile App Endpoints (Strict Data Isolation!)
  app.get('/api/driver-app/me', requireAuth, async (req: AuthRequest, res) => {
    try {
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

      const driverPayload = await runWithRlsContext(
        { role: 'system', driverId: targetDriverId },
        async () => {
          const enrichedDrivers = await getEnrichedDrivers();
          const driver = enrichedDrivers.find((d) => d.id === targetDriverId);
          if (!driver) return null;

          const schoolConfig = await getSchoolBillingConfigById(db, driver.schoolId);
          const activePeriod = await getActiveBillingPeriod(driver.schoolId);
          const autoRange = getCurrentBillingRangeForSchool(schoolConfig);
          const useAuto = String(req.query.autoPeriod || '').toLowerCase() === 'true';
          const month = useAuto
            ? autoRange.month
            : Number(req.query.month) || activePeriod.month;
          const year = useAuto
            ? autoRange.year
            : Number(req.query.year) || activePeriod.year;
          const range = getBillingDateRangeForPeriod(month, year, schoolConfig);

          const salary = await getOrRecalculateDriverSalaryForRead(
            db,
            driver.id,
            month,
            year,
            schoolConfig
          );

          const [driverAdvances, driverCoverages, transactions, driverNotifications, vehicleGpsData] =
            await Promise.all([
              db
                .select()
                .from(advances)
                .where(
                  and(
                    eq(advances.driverId, driver.id),
                    gte(advances.date, range.startDate),
                    lte(advances.date, range.endDate)
                  )
                )
                .orderBy(desc(advances.date)),
              db
                .select()
                .from(coverageRecords)
                .where(
                  and(
                    or(
                      eq(coverageRecords.absentDriverId, driver.id),
                      eq(coverageRecords.replacementDriverId, driver.id)
                    ),
                    gte(coverageRecords.date, range.startDate),
                    lte(coverageRecords.date, range.endDate)
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

          const driverNameById: Record<number, string> = {};
          for (const d of enrichedDrivers) driverNameById[d.id] = d.fullName;

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

          return {
            linked: true,
            period: {
              month,
              year,
              startDate: range.startDate,
              endDate: range.endDate,
              startDateTime: range.startDateTime,
              endDateTime: range.endDateTime,
              labelAr: range.labelAr,
              shortLabelAr: range.shortLabelAr,
            },
            billingRange: range,
            driver,
            salary: {
              ...salary,
              baseSalary: Number(salary.baseSalary),
              totalAdvances: Number(salary.totalAdvances),
              totalCoverageDeductions: Number(salary.totalCoverageDeductions),
              totalCoverageAdditions: Number(salary.totalCoverageAdditions || 0),
              otherDeductions: Number(salary.otherDeductions),
              bonuses: Number(salary.bonuses),
              netSalary: Number(salary.netSalary),
            },
            advances: driverAdvances.map((a) => ({ ...a, amount: Number(a.amount) })),
            coverages: driverCoverages.map((c) => {
              const unifiedAmt = Number(c.absentDriverDeduction || c.actualReplacementCost || 0);
              return {
                ...c,
                coverageRole: c.absentDriverId === driver.id ? ('absent' as const) : ('replacement' as const),
                coverageAmount: unifiedAmt,
                absentDriverName: driverNameById[c.absentDriverId] || '—',
                replacementDriverName: c.replacementDriverId
                  ? driverNameById[c.replacementDriverId] || '—'
                  : c.replacementExternalName || 'سائق خارجي',
                actualReplacementCost: unifiedAmt,
                absentDriverDeduction: unifiedAmt,
              };
            }),
            transactions: transactions.map((t) => ({ ...t, amount: Number(t.amount) })),
            notifications: driverNotifications,
            gps: {
              vehicleGpsStatus,
              latestGps,
            },
          };
        }
      );

      if (!driverPayload) return res.json({ linked: false, driver: null });
      res.json(driverPayload);
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

        if (!isSchoolUnrestricted(req.dbUser)) {
          const sId = await getDriverCurrentSchoolId(driverId);
          if (!isSchoolAllowed(req.dbUser, sId)) {
            return res.status(403).json({ error: 'هذا السائق تابع لمدرسة خارج نطاق صلاحياتك' });
          }
        }

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
    return runWithRlsContext({ role: 'system', driverId: null }, async () => {
      const todayDate = getTodayDateString();
      const [
        allSups,
        allSchools,
        allSchoolPeriods,
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
            billingCycleType: schools.billingCycleType,
            billingCycleStartDay: schools.billingCycleStartDay,
            billingCycleEndDay: schools.billingCycleEndDay,
          })
          .from(schools),
        db.select().from(billingPeriods).where(sql`${billingPeriods.key} LIKE 'school:%'`),
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

      const periodBySchoolId: Record<number, (typeof allSchoolPeriods)[number]> = {};
      for (const bp of allSchoolPeriods) {
        const sid = Number(bp.key.replace('school:', ''));
        if (Number.isFinite(sid) && sid > 0) periodBySchoolId[sid] = bp;
      }

      const schoolById: Record<number, (typeof allSchools)[number]> = {};
      for (const s of allSchools) schoolById[s.id] = s;

      // Fetch active billing cycle trips for all supervisors in one window query
      const rangeBySchoolKey = new Map<string, ReturnType<typeof getCurrentBillingRangeForSchool>>();
      rangeBySchoolKey.set('none', getCurrentBillingRangeForSchool(null, todayDate));
      let minCycleStart = rangeBySchoolKey.get('none')!.startDate;
      let maxCycleEnd = rangeBySchoolKey.get('none')!.endDate;
      for (const s of allSchools) {
        const bp = periodBySchoolId[s.id];
        const cfg: SchoolBillingConfig = {
          ...s,
          customStartDate: bp?.customStartDate || null,
          customEndDate: bp?.customEndDate || null,
          customPeriodMonth: bp?.activeMonth ?? null,
          customPeriodYear: bp?.activeYear ?? null,
        };
        const r = getCurrentBillingRangeForSchool(cfg, todayDate);
        rangeBySchoolKey.set(String(s.id), r);
        if (r.startDate < minCycleStart) minCycleStart = r.startDate;
        if (r.endDate > maxCycleEnd) maxCycleEnd = r.endDate;
      }

    const cycleTripsRows = await db
      .select()
      .from(supervisorTrips)
      .where(
        and(
          gte(supervisorTrips.tripDate, minCycleStart),
          lte(supervisorTrips.tripDate, maxCycleEnd)
        )
      );
    const cycleTripsBySup = new Map<number, typeof cycleTripsRows>();
    for (const ct of cycleTripsRows) {
      const list = cycleTripsBySup.get(ct.supervisorId) || [];
      list.push(ct);
      cycleTripsBySup.set(ct.supervisorId, list);
    }

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
      const billingRange =
        (sup.schoolId ? rangeBySchoolKey.get(String(sup.schoolId)) : undefined) ||
        rangeBySchoolKey.get('none')!;
      const supCycleTrips = (cycleTripsBySup.get(sup.id) || []).filter((t) =>
        isDateInRange(t.tripDate, billingRange.startDate, billingRange.endDate)
      );
      const cycleTripsCount = supCycleTrips.reduce(
        (cnt, t) => cnt + (t.morningStartedAt ? 1 : 0) + (t.eveningEndedAt ? 1 : 0),
        0
      );

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
        monthlySalary: Number(sup.monthlySalary || 0),
        cycleTripsCount,
        billingRange,
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
    });
  }

  app.get(
    '/api/supervisors',
    requireAuth,
    requireAdminOrStaff,
    requireAnyPermission(['drivers:read', 'gps:read']),
    async (req: AuthRequest, res) => {
      try {
        const list = (await getEnrichedSupervisors()).filter((s) =>
          isSchoolAllowed(req.dbUser, s.schoolId)
        );
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
          monthlySalary,
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
            const defaultSchoolId =
              !isSchoolUnrestricted(req.dbUser) &&
              !schoolId &&
              !safeSchoolName &&
              (req.dbUser?.assignedSchoolIds?.length || 0) === 1
                ? req.dbUser!.assignedSchoolIds[0]
                : schoolId;
            const resolvedSchoolId = await resolveSchoolIdForDriver(tx, {
              schoolId: defaultSchoolId,
              schoolName: safeSchoolName,
            });
            if (
              !isSchoolUnrestricted(req.dbUser) &&
              (!resolvedSchoolId || !isSchoolAllowed(req.dbUser, resolvedSchoolId))
            ) {
              throw new Error('SCHOOL_FORBIDDEN');
            }
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
                monthlySalary: Math.max(0, Number(monthlySalary || 0)).toFixed(2),
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
        if (error instanceof Error && error.message === 'SCHOOL_FORBIDDEN') {
          return res.status(403).json({ error: 'لا يمكنك إضافة مشرفة خارج نطاق المدارس المصرح لك بها' });
        }
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
          monthlySalary,
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
          if (!isSchoolAllowed(req.dbUser, existing.schoolId)) {
            throw new Error('SCHOOL_FORBIDDEN');
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
            if (
              !isSchoolUnrestricted(req.dbUser) &&
              (!nextSchoolId || !isSchoolAllowed(req.dbUser, nextSchoolId))
            ) {
              throw new Error('SCHOOL_FORBIDDEN');
            }
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
                monthlySalary:
                  monthlySalary !== undefined
                    ? Math.max(0, Number(monthlySalary || 0)).toFixed(2)
                    : existing.monthlySalary,
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
        if (errStr === 'SCHOOL_FORBIDDEN') {
          return res.status(403).json({ error: 'هذه المشرفة أو المدرسة خارج نطاق صلاحياتك' });
        }
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
          if (!isSchoolAllowed(req.dbUser, existing.schoolId)) {
            throw new Error('SCHOOL_FORBIDDEN');
          }

          await db.transaction(async (tx) => {
            await tx.delete(supervisorTrips).where(eq(supervisorTrips.supervisorId, id));
            await tx
              .update(financialCustodies)
              .set({ supervisorId: null })
              .where(eq(financialCustodies.supervisorId, id));
            await tx.delete(supervisors).where(eq(supervisors.id, id));

            if (existing.userId) {
              await permanentlyDeleteUserTx(tx, existing.userId, req.dbUser!.id);
            }

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
        if (errStr === 'SCHOOL_FORBIDDEN') {
          return res.status(403).json({ error: 'هذه المشرفة تابعة لمدرسة خارج نطاق صلاحياتك' });
        }
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

  // Supervisor App: Explicitly Stop/Close Live Location if desired
  app.post('/api/supervisor-app/gps/stop', requireAuth, async (req: AuthRequest, res) => {
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

      const now = new Date();
      await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        await db
          .update(supervisors)
          .set({
            liveLat: null,
            liveLng: null,
            liveSpeedKmh: 0,
            liveAccuracyMeters: null,
            liveUpdatedAt: null,
            updatedAt: now,
          })
          .where(eq(supervisors.id, targetSupervisorId));

        if (req.dbUser?.id) {
          await db.insert(auditLogs).values({
            actorUserId: req.dbUser.id,
            action: 'SUPERVISOR_GPS_STOP',
            entityType: 'supervisors',
            entityId: String(targetSupervisorId),
            afterJson: { stoppedAt: now.toISOString() },
            ipAddress: req.ip || '',
          });
        }
      });

      res.json({ ok: true });
    } catch (error) {
      console.error('Supervisor GPS stop error:', error);
      res.status(500).json({ error: 'تعذر إغلاق اللايف لوكيشن' });
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

  // Supervisor App: Task Notebook / Notes (مفكرة المهام وملاحظات المشرفة)
  app.get('/api/supervisor-app/notes', requireAuth, async (req: AuthRequest, res) => {
    try {
      if (req.dbUser?.roleSlug !== 'supervisor' && req.dbUser?.roleSlug !== 'super_admin') {
        return res.status(403).json({ error: 'غير مطلع على هذا المسار' });
      }
      let targetSupervisorId: number | null = req.supervisorRecord?.id || null;
      if (req.dbUser?.roleSlug === 'super_admin') {
        const override = req.query.asSupervisorId;
        if (override) targetSupervisorId = Number(override);
      }
      if (!targetSupervisorId && req.dbUser?.roleSlug !== 'super_admin') {
        return res.status(403).json({ error: 'لا يوجد ملف مشرفة مرتبط' });
      }

      const rows = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        return await db
          .select()
          .from(supervisorNotes)
          .where(targetSupervisorId ? eq(supervisorNotes.supervisorId, targetSupervisorId) : undefined)
          .orderBy(desc(supervisorNotes.createdAt));
      });

      res.json({ notes: rows });
    } catch (error) {
      console.error('Get supervisor notes error:', error);
      res.status(500).json({ error: 'تعذر تحميل مفكرة المهام' });
    }
  });

  app.post('/api/supervisor-app/notes', requireAuth, async (req: AuthRequest, res) => {
    try {
      if (req.dbUser?.roleSlug !== 'supervisor' && req.dbUser?.roleSlug !== 'super_admin') {
        return res.status(403).json({ error: 'غير متاح لك إضافة ملاحظات المشرفة' });
      }
      let targetSupervisorId: number | null = req.supervisorRecord?.id || null;
      if (req.dbUser?.roleSlug === 'super_admin') {
        const override = req.body?.supervisorId || req.query.asSupervisorId;
        if (override) targetSupervisorId = Number(override);
      }
      if (!targetSupervisorId) {
        return res.status(403).json({ error: 'لا يوجد ملف مشرفة مرتبط' });
      }

      const { category = 'students_trip', title, content, notifyAdmin = false, schoolId } = req.body;
      if (!title || !String(title).trim() || !content || !String(content).trim()) {
        return res.status(400).json({ error: 'يرجى إدخال عنوان وتفاصيل الملاحظة أو المهمة' });
      }

      const outcome = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        return await db.transaction(async (tx) => {
          const [sup] = await tx.select().from(supervisors).where(eq(supervisors.id, targetSupervisorId)).limit(1);
          if (!sup) throw new Error('المشرفة غير موجودة');

          const [inserted] = await tx
            .insert(supervisorNotes)
            .values({
              supervisorId: sup.id,
              schoolId: schoolId ? Number(schoolId) : sup.schoolId,
              category: String(category || 'students_trip'),
              title: String(title).trim(),
              content: String(content).trim(),
              notifyAdmin: Boolean(notifyAdmin),
            })
            .returning();

          if (Boolean(notifyAdmin)) {
            await tx.insert(notifications).values({
              targetRole: 'super_admin',
              type: 'supervisor_note',
              title: `🚨 تنبيه من المشرفة ${sup.fullName}: ${inserted.title}`,
              body: `ملاحظة (${inserted.category === 'financial_tips' ? 'الماليات والإكراميات' : inserted.category === 'students_trip' ? 'حالة الطلاب والرحلة' : 'إدارية عاجلة'}): ${inserted.content}`,
              isRead: false,
            });
          }

          await tx.insert(auditLogs).values({
            actorUserId: req.dbUser!.id,
            action: 'CREATE_SUPERVISOR_NOTE',
            entityType: 'supervisor_notes',
            entityId: String(inserted.id),
            afterJson: inserted,
            ipAddress: req.ip || '',
          });

          return inserted;
        });
      });

      res.status(201).json({ note: outcome });
    } catch (error: unknown) {
      console.error('Create supervisor note error:', error);
      const msg = error instanceof Error ? error.message : 'تعذر حفظ الملاحظة';
      res.status(400).json({ error: msg });
    }
  });

  app.delete('/api/supervisor-app/notes/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'معرف الملاحظة غير صالح' });

      const outcome = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        const [existing] = await db.select().from(supervisorNotes).where(eq(supervisorNotes.id, id)).limit(1);
        if (!existing) return { status: 404 as const, body: { error: 'الملاحظة غير موجودة' } };

        if (req.dbUser?.roleSlug === 'supervisor' && req.supervisorRecord?.id && existing.supervisorId !== req.supervisorRecord.id) {
          return { status: 403 as const, body: { error: 'لا يمكنك حذف ملاحظة خاصة بمشرفة أخرى' } };
        }

        await db.delete(supervisorNotes).where(eq(supervisorNotes.id, id));

        if (req.dbUser?.id) {
          await db.insert(auditLogs).values({
            actorUserId: req.dbUser.id,
            action: 'DELETE_SUPERVISOR_NOTE',
            entityType: 'supervisor_notes',
            entityId: String(id),
            beforeJson: existing,
            ipAddress: req.ip || '',
          });
        }

        return { status: 200 as const, body: { ok: true, deletedId: id } };
      });

      res.status(outcome.status).json(outcome.body);
    } catch (error: unknown) {
      console.error('Delete supervisor note error:', error);
      const msg = error instanceof Error ? error.message : 'تعذر حذف الملاحظة';
      res.status(400).json({ error: msg });
    }
  });

  // ==================== Unified Chat & Driver-Only Broadcast API ====================
  const resolveChatActor = (req: AuthRequest) => {
    const isSupervisor = req.dbUser?.roleSlug === 'supervisor' || Boolean(req.supervisorRecord);
    const senderName =
      req.driverRecord?.fullName ||
      req.supervisorRecord?.fullName ||
      req.dbUser?.fullName ||
      'مستخدم';
    const senderRole = req.driverRecord
      ? 'driver'
      : req.supervisorRecord
      ? 'supervisor'
      : req.dbUser?.roleSlug || 'admin';
    const senderAvatar =
      req.driverRecord?.photoUrl || req.supervisorRecord?.photoUrl || '';
    return { senderName, senderRole, senderAvatar, isSupervisor };
  };

  app.get('/api/chat/channels', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { senderRole } = resolveChatActor(req);
      const channels = await getEnrichedChatChannels(senderRole);
      res.json({ ok: true, channels });
    } catch (err) {
      console.error('Error fetching chat channels:', err);
      res.status(500).json({ error: 'تعذر تحميل غرف المحادثة' });
    }
  });

  app.get('/api/chat/messages', requireAuth, async (req: AuthRequest, res) => {
    try {
      const roomKey = String(req.query.roomKey || 'broadcast');
      const { isSupervisor } = resolveChatActor(req);
      if (roomKey === DRIVERS_BROADCAST_ROOM && isSupervisor) {
        return res.status(403).json({ error: 'هذه القناة مخصصة للإدارة والسائقين فقط' });
      }
      const messages = await getMessagesForRoom(roomKey);
      res.json({ ok: true, roomKey, messages });
    } catch (err) {
      console.error('Error fetching messages:', err);
      res.status(500).json({ error: 'تعذر تحميل الرسائل' });
    }
  });

  app.post('/api/chat/messages', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { roomKey, messageType, textContent, audioDataUrl, audioDurationSec } = req.body;
      if (!roomKey) {
        return res.status(400).json({ error: 'roomKey مطلوب' });
      }

      const { senderName, senderRole, senderAvatar, isSupervisor } = resolveChatActor(req);
      if (roomKey === DRIVERS_BROADCAST_ROOM && isSupervisor) {
        return res.status(403).json({ error: 'هذه القناة مخصصة للإدارة والسائقين فقط' });
      }

      const saved = await saveMessageToDb({
        roomKey,
        senderUserId: req.dbUser?.id || null,
        senderRole,
        senderName,
        senderAvatar,
        messageType: messageType || 'text',
        textContent: textContent || '',
        audioDataUrl: audioDataUrl || null,
        audioDurationSec: Number(audioDurationSec) || 0,
      });

      broadcastToRoom(roomKey, {
        type: 'new_message',
        roomKey,
        message: saved,
      });

      res.json({ ok: true, message: saved });
    } catch (err) {
      console.error('Error saving chat message:', err);
      res.status(500).json({ error: 'تعذر إرسال الرسالة' });
    }
  });

  // Dedicated Admin Driver-Only Broadcast Endpoint (Text + Voice Note -> Drivers Only, Excludes Supervisors)
  app.post('/api/admin/drivers-broadcast', requireAuth, requireAdminOrStaff, async (req: AuthRequest, res) => {
    try {
      const { title, textContent, audioDataUrl, audioDurationSec } = req.body || {};
      const cleanText = String(textContent || '').trim();
      const hasAudio = typeof audioDataUrl === 'string' && audioDataUrl.startsWith('data:audio/');
      if (!cleanText && !hasAudio) {
        return res.status(400).json({ error: 'يرجى كتابة رسالة نصية أو تسجيل فويس نوت للسائقين' });
      }

      const senderName = req.dbUser?.fullName || 'الإدارة';
      const senderRole = req.dbUser?.roleSlug || 'super_admin';

      let lastMessage: Awaited<ReturnType<typeof saveMessageToDb>> | null = null;

      if (cleanText) {
        const textSaved = await saveMessageToDb({
          roomKey: DRIVERS_BROADCAST_ROOM,
          senderUserId: req.dbUser?.id || null,
          senderRole,
          senderName,
          messageType: 'text',
          textContent: cleanText,
        });
        lastMessage = textSaved;
        broadcastToRoom(DRIVERS_BROADCAST_ROOM, {
          type: 'new_message',
          roomKey: DRIVERS_BROADCAST_ROOM,
          message: textSaved,
        });
      }

      if (hasAudio) {
        const voiceSaved = await saveMessageToDb({
          roomKey: DRIVERS_BROADCAST_ROOM,
          senderUserId: req.dbUser?.id || null,
          senderRole,
          senderName,
          messageType: 'voice_note',
          textContent: cleanText || '',
          audioDataUrl,
          audioDurationSec: Math.max(1, Number(audioDurationSec) || 1),
        });
        lastMessage = voiceSaved;
        broadcastToRoom(DRIVERS_BROADCAST_ROOM, {
          type: 'new_message',
          roomKey: DRIVERS_BROADCAST_ROOM,
          message: voiceSaved,
        });
      }

      // Notify ONLY active driver accounts (supervisors are strictly excluded)
      const activeDrivers = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        return db
          .select({ id: drivers.id, userId: drivers.userId })
          .from(drivers)
          .where(eq(drivers.accountStatus, 'active'));
      });

      const notifTitle =
        String(title || '').trim() ||
        (hasAudio ? '🎤 رسالة صوتية جماعية من الإدارة للسائقين' : '📢 رسالة جماعية من الإدارة للسائقين');
      const notifBody =
        cleanText ||
        `تم إرسال تسجيل صوتي من ${senderName} (${Math.max(1, Number(audioDurationSec) || 1)} ثانية) — افتح تبويب المحادثات للاستماع.`;

      if (activeDrivers.length > 0) {
        await db.insert(notifications).values(
          activeDrivers.map((d) => ({
            recipientDriverId: d.id,
            recipientUserId: d.userId || null,
            targetRole: 'driver',
            type: 'drivers_broadcast',
            title: notifTitle,
            body: notifBody,
          }))
        );
      }

      await db.insert(auditLogs).values({
        actorUserId: req.dbUser!.id,
        action: 'DRIVERS_ONLY_BROADCAST',
        entityType: 'chat_channels',
        entityId: DRIVERS_BROADCAST_ROOM,
        afterJson: {
          hasText: Boolean(cleanText),
          hasAudio,
          notifiedDriversCount: activeDrivers.length,
        },
        ipAddress: req.ip || '',
      });

      res.status(201).json({
        ok: true,
        notifiedDriversCount: activeDrivers.length,
        message: lastMessage,
      });
    } catch (err) {
      console.error('Drivers-only broadcast error:', err);
      res.status(500).json({ error: 'تعذر إرسال الرسالة الجماعية للسائقين' });
    }
  });

  app.post('/api/chat/call-signal', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { roomKey, action, payload } = req.body;
      const { senderName, senderRole, isSupervisor } = resolveChatActor(req);
      if (roomKey === DRIVERS_BROADCAST_ROOM && isSupervisor) {
        return res.status(403).json({ error: 'هذه القناة مخصصة للإدارة والسائقين فقط' });
      }

      broadcastToRoom(roomKey, {
        type: 'call_signal',
        roomKey,
        action,
        callerName: senderName,
        callerRole: senderRole,
        payload,
      });

      if (action === 'call_start') {
        const logMsg = await saveMessageToDb({
          roomKey,
          senderRole,
          senderName,
          messageType: 'call_log',
          textContent: `📞 مكالمة صوتية مباشرة بواسطة ${senderName}`,
        });
        broadcastToRoom(roomKey, {
          type: 'new_message',
          roomKey,
          message: logMsg,
        });
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('Error in call signal:', err);
      res.status(500).json({ error: 'تعذر إرسال إشارة الاتصال' });
    }
  });

  await ensureRlsPoliciesApplied().catch((err) => {
    console.warn('[RLS] Startup policy sync warning:', err);
  });

  const httpServer = http.createServer(app);
  initChatWebSocketServer(httpServer);

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
