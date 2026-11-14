import 'dotenv/config';
import http from 'http';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { and, desc, eq, gte, or, sql } from 'drizzle-orm';
import { db } from './src/db/index.ts';
import {
  advances,
  attendance,
  auditLogs,
  coverageRecords,
  driverAssignments,
  drivers,
  financialTransactions,
  gpsLocations,
  notifications,
  routes,
  salaries,
  schools,
  userRoles,
  users,
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
  normalizeArabicDigits,
  normalizeDriverCode,
  normalizeEgyptPhone,
} from './src/lib/driver-session.ts';
import { ensureRlsPoliciesApplied } from './src/db/apply-rls-policies.ts';
import { runWithRlsContext } from './src/db/rls-context.ts';
import { ensureStarterOperationalData } from './src/services/bootstrap.ts';
import {
  recalculateDriverSalary,
  recordAdjustmentTransaction,
  recordAdvanceTransaction,
  recordCoverageTransaction,
  reverseFinancialRecord,
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
  return new Date().toISOString().slice(0, 10);
}

function sanitizeDriverPhotoUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length > 650_000) {
    throw new Error('حجم صورة السائق كبير جداً، يرجى اختيار صورة أصغر');
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

async function getEnrichedDrivers() {
  const allDrivers = await db.select().from(drivers).orderBy(drivers.driverCode);
  const currentAssignments = await db
    .select()
    .from(driverAssignments)
    .where(eq(driverAssignments.isCurrent, true));
  const allSchools = await db.select().from(schools);
  const allVehicles = await db.select().from(vehicles);
  const allOwners = await db.select().from(vehicleOwners);
  const allRoutes = await db.select().from(routes);

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
    const school = assign ? schoolById[assign.schoolId] : undefined;
    const vehicle = assign ? vehicleById[assign.vehicleId] : undefined;
    const owner = vehicle?.ownerId ? ownerById[vehicle.ownerId] : undefined;
    const route = assign?.routeId ? routeById[assign.routeId] : undefined;

    return {
      ...d,
      monthlyAgreedSalary: Number(d.monthlyAgreedSalary || 0),
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
  const allVehicles = await db.select().from(vehicles).orderBy(vehicles.busNumber);
  const allOwners = await db.select().from(vehicleOwners);
  const allSchools = await db.select().from(schools);
  const allRoutes = await db.select().from(routes);
  const allDrivers = await db.select().from(drivers);
  const currentAssignments = await db
    .select()
    .from(driverAssignments)
    .where(eq(driverAssignments.isCurrent, true));

  const latestGpsRows = await db
    .select()
    .from(gpsLocations)
    .orderBy(desc(gpsLocations.recordedAt))
    .limit(500);

  const latestByVehicle: Record<number, typeof gpsLocations.$inferSelect> = {};
  for (const g of latestGpsRows) {
    if (!latestByVehicle[g.vehicleId]) {
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
  for (const a of currentAssignments) assignByVehicle[a.vehicleId] = a;

  return allVehicles.map((v) => {
    const assign = assignByVehicle[v.id];
    const driver = assign ? driverById[assign.driverId] : undefined;
    const school = assign ? schoolById[assign.schoolId] : undefined;
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

  // 0. Driver Phone + Code Login (Public endpoint with rate limiting & live status checks)
  const driverLoginAttempts: Record<string, { count: number; resetAt: number }> = {};

  app.post('/api/auth/driver-login', async (req, res) => {
    const clientIp = req.ip || 'unknown';
    const nowMs = Date.now();
    const attempt = driverLoginAttempts[clientIp];
    if (attempt && attempt.resetAt > nowMs && attempt.count >= 15) {
      return res.status(429).json({
        error: 'تم تجاوز الحد المسموح لمحاولات الدخول. يرجى المحاولة بعد 10 دقائق.',
      });
    }

    const recordFailedAttempt = () => {
      const cur = driverLoginAttempts[clientIp];
      if (!cur || cur.resetAt <= nowMs) {
        driverLoginAttempts[clientIp] = { count: 1, resetAt: nowMs + 10 * 60 * 1000 };
      } else {
        cur.count += 1;
      }
    };

    try {
      const normCode = normalizeDriverCode(req.body?.driverCode);
      const normPhone = normalizeEgyptPhone(req.body?.phone);
      const rawPhoneDigits = normalizeArabicDigits(String(req.body?.phone || '')).replace(/\D/g, '');

      if (!normCode || !normPhone) {
        return res.status(400).json({ error: 'يرجى إدخال رقم الموبايل وكود السائق' });
      }

      const result = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        await ensureRolesExist();

        const driverCountRes = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(drivers);
        if ((driverCountRes[0]?.count ?? 0) === 0) {
          const seedOwnerId = await ensureSeedOwnerUserId();
          await ensureStarterOperationalData(seedOwnerId);
        }

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
          return { status: 401 as const, error: 'رقم الموبايل أو كود السائق غير صحيح' };
        }

        const storedPhoneNorm = normalizeEgyptPhone(driver.phone);
        const storedPhoneDigits = normalizeArabicDigits(driver.phone).replace(/\D/g, '');
        const phoneMatches =
          storedPhoneNorm === normPhone ||
          (rawPhoneDigits.length >= 8 && storedPhoneDigits === rawPhoneDigits);

        if (!phoneMatches) {
          return { status: 401 as const, error: 'رقم الموبايل أو كود السائق غير صحيح' };
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

      delete driverLoginAttempts[clientIp];
      return res.json(result.payload);
    } catch (error) {
      console.error('Driver login error:', error);
      return res.status(500).json({ error: 'تعذر تسجيل دخول السائق، يرجى المحاولة لاحقاً' });
    }
  });

  // 1. Current Authenticated User & Bootstrap
  app.get('/api/me', requireAuth, async (req: AuthRequest, res) => {
    try {
      if (req.dbUser?.roleSlug === 'super_admin') {
        await ensureStarterOperationalData(req.dbUser.id);
      }
      res.json({
        user: req.dbUser,
        driver: req.driverRecord || null,
      });
    } catch (error) {
      console.error('Error in /api/me:', error);
      res.status(500).json({ error: 'تعذر تحميل بيانات الحساب' });
    }
  });

  // 2. Dashboard Summary (Admin/Staff only)
  app.get('/api/dashboard', requireAuth, requireAdminOrStaff, requirePermission('dashboard:read'), async (req: AuthRequest, res) => {
    try {
      const month = Number(req.query.month) || new Date().getMonth() + 1;
      const year = Number(req.query.year) || new Date().getFullYear();
      const dateStr = (req.query.date as string) || getTodayDateString();
      const schoolFilter = req.query.schoolId ? Number(req.query.schoolId) : null;
      const driverFilter = req.query.driverId ? Number(req.query.driverId) : null;
      const vehicleFilter = req.query.vehicleId ? Number(req.query.vehicleId) : null;
      const statusFilter = (req.query.status as string) || '';

      let enrichedDrivers = await getEnrichedDrivers();
      let fleet = await getFleetWithLatestGps();
      const allSchools = await db.select().from(schools);
      const todayAttendance = await db
        .select()
        .from(attendance)
        .where(eq(attendance.date, dateStr));

      const attByDriver: Record<number, typeof attendance.$inferSelect> = {};
      for (const a of todayAttendance) attByDriver[a.driverId] = a;

      if (schoolFilter) {
        enrichedDrivers = enrichedDrivers.filter((d) => d.schoolId === schoolFilter);
        fleet = fleet.filter((v) => v.schoolId === schoolFilter);
      }
      if (driverFilter) {
        enrichedDrivers = enrichedDrivers.filter((d) => d.id === driverFilter);
        fleet = fleet.filter((v) => v.driverId === driverFilter);
      }
      if (vehicleFilter) {
        enrichedDrivers = enrichedDrivers.filter((d) => d.vehicleId === vehicleFilter);
        fleet = fleet.filter((v) => v.id === vehicleFilter);
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

      const driverIds = new Set(enrichedDrivers.map((d) => d.id));
      const allSalaries = await db
        .select()
        .from(salaries)
        .where(and(eq(salaries.month, month), eq(salaries.year, year)));

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

      // School contract revenue vs vehicle owner costs
      const relevantSchools = schoolFilter
        ? allSchools.filter((s) => s.id === schoolFilter && s.isActive)
        : allSchools.filter((s) => s.isActive);
      const totalSchoolContracts = relevantSchools.reduce(
        (sum, s) => sum + Number(s.monthlyContractValue || 0),
        0
      );
      const totalOwnerCosts = fleet
        .filter((v) => v.operationalStatus !== 'inactive')
        .reduce((sum, v) => sum + Number(v.monthlyOwnerCost || 0), 0);

      // Coverage spread this month
      const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
      const monthCoverages = await db
        .select()
        .from(coverageRecords)
        .where(and(eq(coverageRecords.isReversed, false), sql`${coverageRecords.date} LIKE ${monthPrefix + '%'}`));
      const coverageSpread = monthCoverages.reduce(
        (sum, c) => sum + (Number(c.absentDriverDeduction || 0) - Number(c.actualReplacementCost || 0)),
        0
      );

      const monthlyBusinessProfit = totalSchoolContracts - totalOwnerCosts + coverageSpread;

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

      res.json({
        period: { month, year, date: dateStr },
        kpis: {
          totalRegisteredDrivers: enrichedDrivers.length,
          totalActiveVehicles: activeVehicles.length,
          vehiclesOnline: onlineVehicles.length,
          vehiclesOffline: offlineVehicles.length,
          driversActive: activeDriversCount,
          driversAbsent: absentDriversCount,
          totalMonthlySalaries,
          totalAdvances,
          totalCoverageDeductions,
          totalOutstandingPayments,
          totalSchoolContracts,
          totalOwnerCosts,
          monthlyBusinessProfit,
        },
        drivers: enrichedDrivers.map((d) => ({
          ...d,
          todayAttendance: attByDriver[d.id]?.status || 'present',
          currentSalary: salaryByDriver[d.id] || null,
        })),
        fleet,
        schools: allSchools,
        recentNotifications,
      });
    } catch (error) {
      console.error('Dashboard error:', error);
      res.status(500).json({ error: 'تعذر تحميل بيانات لوحة التحكم' });
    }
  });

  // 3. Drivers Management
  app.get('/api/drivers', requireAuth, requireAdminOrStaff, requirePermission('drivers:read'), async (_req: AuthRequest, res) => {
    try {
      const list = await getEnrichedDrivers();
      res.json({ drivers: list });
    } catch (error) {
      console.error('Get drivers error:', error);
      res.status(500).json({ error: 'تعذر تحميل قائمة السائقين' });
    }
  });

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
          notes,
          schoolId,
          vehicleId,
          routeId,
        } = req.body;

        if (!driverCode || !fullName || !phone) {
          return res.status(400).json({ error: 'كود السائق والاسم الكامل ورقم الهاتف حقول إلزامية' });
        }

        let safePhotoUrl = '';
        try {
          safePhotoUrl = sanitizeDriverPhotoUrl(photoUrl);
        } catch (photoErr: unknown) {
          return res.status(400).json({
            error: photoErr instanceof Error ? photoErr.message : 'صورة السائق غير صالحة',
          });
        }

        const normalizedCode = normalizeDriverCode(driverCode);
        const normalizedPhone = normalizeEgyptPhone(phone) || String(phone).trim();

        const existingCode = await db
          .select()
          .from(drivers)
          .where(eq(drivers.driverCode, normalizedCode))
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
              notes: notes || '',
            })
            .returning();

          if (schoolId && vehicleId) {
            await tx.insert(driverAssignments).values({
              driverId: newDriver.id,
              schoolId: Number(schoolId),
              vehicleId: Number(vehicleId),
              routeId: routeId ? Number(routeId) : null,
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
        notes,
        schoolId,
        vehicleId,
        routeId,
      } = req.body;

      let nextPhotoUrl = existing.photoUrl || '';
      if (photoUrl !== undefined) {
        try {
          nextPhotoUrl = sanitizeDriverPhotoUrl(photoUrl);
        } catch (photoErr: unknown) {
          return res.status(400).json({
            error: photoErr instanceof Error ? photoErr.message : 'صورة السائق غير صالحة',
          });
        }
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
            notes: notes ?? existing.notes,
          })
          .where(eq(drivers.id, driverId))
          .returning();

        if (schoolId && vehicleId) {
          await tx
            .update(driverAssignments)
            .set({ isCurrent: false, endedAt: new Date() })
            .where(and(eq(driverAssignments.driverId, driverId), eq(driverAssignments.isCurrent, true)));

          await tx.insert(driverAssignments).values({
            driverId,
            schoolId: Number(schoolId),
            vehicleId: Number(vehicleId),
            routeId: routeId ? Number(routeId) : null,
            isCurrent: true,
          });
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

      const month = Number(req.query.month) || new Date().getMonth() + 1;
      const year = Number(req.query.year) || new Date().getFullYear();

      const allDrivers = await getEnrichedDrivers();
      const driver = allDrivers.find((d) => d.id === driverId);
      if (!driver) return res.status(404).json({ error: 'السائق غير موجود' });

      const salary = await recalculateDriverSalary(db, driverId, month, year);
      const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;

      const driverAdvances = await db
        .select()
        .from(advances)
        .where(and(eq(advances.driverId, driverId), sql`${advances.date} LIKE ${monthPrefix + '%'}`))
        .orderBy(desc(advances.date), desc(advances.id));

      const driverCoverages = await db
        .select()
        .from(coverageRecords)
        .where(
          and(
            eq(coverageRecords.absentDriverId, driverId),
            sql`${coverageRecords.date} LIKE ${monthPrefix + '%'}`
          )
        )
        .orderBy(desc(coverageRecords.date), desc(coverageRecords.id));

      const transactions = await db
        .select()
        .from(financialTransactions)
        .where(
          and(
            eq(financialTransactions.driverId, driverId),
            eq(financialTransactions.month, month),
            eq(financialTransactions.year, year)
          )
        )
        .orderBy(desc(financialTransactions.createdAt));

      res.json({
        driver,
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
      if (!name) return res.status(400).json({ error: 'اسم المدرسة مطلوب' });

      const [created] = await db
        .insert(schools)
        .values({
          name: String(name).trim(),
          contactName: contactName || '',
          contactPhone: contactPhone || '',
          address: address || '',
          lat: Number(lat || 30.0444),
          lng: Number(lng || 31.2357),
          monthlyContractValue: Number(monthlyContractValue || 0).toFixed(2),
          contractStartDate: contractStartDate || '2026-09-01',
          contractEndDate: contractEndDate || '2027-06-30',
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
        monthlyOwnerCost,
        operationalStatus,
        notes,
      } = req.body;
      if (!busNumber || !registrationNumber) {
        return res.status(400).json({ error: 'رقم الباص ورقم اللوحة مطلوبان' });
      }
      const [created] = await db
        .insert(vehicles)
        .values({
          busNumber: String(busNumber).trim(),
          registrationNumber: String(registrationNumber).trim(),
          vehicleType: vehicleType || 'تويوتا هايس سقف عالي',
          ownerId: ownerId ? Number(ownerId) : null,
          monthlyOwnerCost: Number(monthlyOwnerCost || 0).toFixed(2),
          operationalStatus: operationalStatus || 'active',
          gpsStatus: 'offline',
          notes: notes || '',
        })
        .returning();

      await db.insert(auditLogs).values({
        actorUserId: req.dbUser!.id,
        action: 'CREATE_VEHICLE',
        entityType: 'vehicles',
        entityId: String(created.id),
        afterJson: created,
        ipAddress: req.ip || '',
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
        monthlyOwnerCost,
        operationalStatus,
        notes,
      } = req.body;

      const [updated] = await db
        .update(vehicles)
        .set({
          busNumber: busNumber ?? existing.busNumber,
          registrationNumber: registrationNumber ?? existing.registrationNumber,
          vehicleType: vehicleType ?? existing.vehicleType,
          ownerId: ownerId !== undefined ? (ownerId ? Number(ownerId) : null) : existing.ownerId,
          monthlyOwnerCost:
            monthlyOwnerCost !== undefined
              ? Number(monthlyOwnerCost).toFixed(2)
              : existing.monthlyOwnerCost,
          operationalStatus: operationalStatus ?? existing.operationalStatus,
          notes: notes ?? existing.notes,
        })
        .where(eq(vehicles.id, id))
        .returning();

      res.json({ vehicle: updated });
    } catch (error) {
      console.error('Update vehicle error:', error);
      res.status(500).json({ error: 'تعذر تحديث المركبة' });
    }
  });

  app.post('/api/routes', requireAuth, requireAdminOrStaff, requirePermission('routes:write'), async (req: AuthRequest, res) => {
    try {
      const { name, schoolId, pickupArea, dropoffArea, pickupTime, dropoffTime, estimatedDistanceKm } =
        req.body;
      if (!name || !schoolId) {
        return res.status(400).json({ error: 'اسم الخط والمدرسة مطلوبان' });
      }
      const [route] = await db
        .insert(routes)
        .values({
          name,
          schoolId: Number(schoolId),
          pickupArea: pickupArea || '',
          dropoffArea: dropoffArea || '',
          pickupTime: pickupTime || '06:45',
          dropoffTime: dropoffTime || '14:30',
          estimatedDistanceKm: Number(estimatedDistanceKm || 0),
        })
        .returning();
      res.status(201).json({ route });
    } catch (error) {
      console.error('Create route error:', error);
      res.status(500).json({ error: 'تعذر إضافة الخط' });
    }
  });

  // 5. Financial Management (Advances, Coverages, Adjustments, Reversals, Statements)
  app.get('/api/finance/overview', requireAuth, requireAdminOrStaff, requirePermission('finance:read'), async (req: AuthRequest, res) => {
    try {
      const month = Number(req.query.month) || new Date().getMonth() + 1;
      const year = Number(req.query.year) || new Date().getFullYear();
      const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;

      const enrichedDrivers = await getEnrichedDrivers();
      for (const d of enrichedDrivers) {
        await recalculateDriverSalary(db, d.id, month, year);
      }

      const monthSalaries = await db
        .select()
        .from(salaries)
        .where(and(eq(salaries.month, month), eq(salaries.year, year)));

      const monthAdvances = await db
        .select()
        .from(advances)
        .where(sql`${advances.date} LIKE ${monthPrefix + '%'}`)
        .orderBy(desc(advances.date), desc(advances.id));

      const monthCoverages = await db
        .select()
        .from(coverageRecords)
        .where(sql`${coverageRecords.date} LIKE ${monthPrefix + '%'}`)
        .orderBy(desc(coverageRecords.date), desc(coverageRecords.id));

      const monthLedger = await db
        .select()
        .from(financialTransactions)
        .where(and(eq(financialTransactions.month, month), eq(financialTransactions.year, year)))
        .orderBy(desc(financialTransactions.createdAt));

      const driverMap: Record<number, (typeof enrichedDrivers)[number]> = {};
      for (const d of enrichedDrivers) driverMap[d.id] = d;

      res.json({
        period: { month, year },
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
      const { driverId, amount, date, reason, paymentMethod, notes, idempotencyKey } = req.body;
      if (!driverId || !amount || !date) {
        return res.status(400).json({ error: 'السائق والمبلغ والتاريخ حقول مطلوبة' });
      }
      const result = await recordAdvanceTransaction({
        driverId: Number(driverId),
        amount: Number(amount),
        date: String(date),
        reason: reason || 'سلفة نقدية',
        paymentMethod: paymentMethod || 'cash',
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
        replacementDriverId,
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

      if (!absentDriverId || !date) {
        return res.status(400).json({ error: 'السائق الغائب والتاريخ حقول مطلوبة' });
      }

      const executeCoverage = () =>
        recordCoverageTransaction({
          absentDriverId: Number(absentDriverId),
          replacementDriverId: replacementDriverId ? Number(replacementDriverId) : null,
          replacementExternalName: replacementExternalName || '',
          vehicleId: vehicleId ? Number(vehicleId) : null,
          schoolId: schoolId ? Number(schoolId) : null,
          date: String(date),
          actualReplacementCost: Number(actualReplacementCost || 0),
          absentDriverDeduction: Number(absentDriverDeduction || 0),
          reason: reason || 'تغطية غياب',
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
      const { driverId, month, year, type, amount, description } = req.body;
      if (!driverId || !type || !amount || !description) {
        return res.status(400).json({ error: 'جميع الحقول مطلوبة لتسجيل التسوية' });
      }
      if (type !== 'bonus' && type !== 'other_deduction') {
        return res.status(400).json({ error: 'نوع التسوية غير صحيح' });
      }
      const result = await recordAdjustmentTransaction({
        driverId: Number(driverId),
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
      const fleet = await getFleetWithLatestGps();
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
      const { vehicleId, lat, lng, speedKmh, heading, accuracyMeters } = req.body;
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
        if (!assign) {
          return res.status(400).json({ error: 'لم يتم تعيين مركبة لك بعد' });
        }
        targetVehicleId = assign.vehicleId;
        targetDriverId = req.driverRecord.id;
      } else if (!hasPermission(req.dbUser, 'gps:write')) {
        return res.status(403).json({ error: 'ليس لديك صلاحية تحديث إحداثيات المركبات' });
      }

      if (!targetVehicleId || typeof lat !== 'number' || typeof lng !== 'number') {
        return res.status(400).json({ error: 'بيانات الموقع الجغرافي غير مكتملة' });
      }

      const [ping] = await db
        .insert(gpsLocations)
        .values({
          vehicleId: targetVehicleId,
          driverId: targetDriverId,
          lat,
          lng,
          speedKmh: Number(speedKmh || 0),
          heading: Number(heading || 0),
          accuracyMeters: Number(accuracyMeters || 10),
          isLive: true,
          recordedAt: new Date(),
        })
        .returning();

      await db
        .update(vehicles)
        .set({ gpsStatus: 'online' })
        .where(eq(vehicles.id, targetVehicleId));

      res.status(201).json({ ping });
    } catch (error) {
      console.error('GPS update error:', error);
      res.status(500).json({ error: 'تعذر تحديث الموقع الجغرافي' });
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
      const enrichedDrivers = await getEnrichedDrivers();
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
      const { title, body, driverId } = req.body;
      if (!title || !body) return res.status(400).json({ error: 'العنوان ونص الإشعار مطلوبان' });

      if (driverId) {
        const [n] = await db
          .insert(notifications)
          .values({
            recipientDriverId: Number(driverId),
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
      const month = Number(req.query.month) || new Date().getMonth() + 1;
      const year = Number(req.query.year) || new Date().getFullYear();
      const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;

      const enrichedDrivers = await getEnrichedDrivers();
      for (const d of enrichedDrivers) {
        await recalculateDriverSalary(db, d.id, month, year);
      }

      const monthSalaries = await db
        .select()
        .from(salaries)
        .where(and(eq(salaries.month, month), eq(salaries.year, year)));
      const monthAdvances = await db
        .select()
        .from(advances)
        .where(and(eq(advances.isReversed, false), sql`${advances.date} LIKE ${monthPrefix + '%'}`));
      const monthCoverages = await db
        .select()
        .from(coverageRecords)
        .where(and(eq(coverageRecords.isReversed, false), sql`${coverageRecords.date} LIKE ${monthPrefix + '%'}`));
      const monthAttendance = await db
        .select()
        .from(attendance)
        .where(sql`${attendance.date} LIKE ${monthPrefix + '%'}`);
      const allSchools = await db.select().from(schools);
      const fleet = await getFleetWithLatestGps();

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
      const month = Number(req.query.month) || new Date().getMonth() + 1;
      const year = Number(req.query.year) || new Date().getFullYear();

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

      const salary = await recalculateDriverSalary(db, driver.id, month, year);
      const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;

      const driverAdvances = await db
        .select()
        .from(advances)
        .where(and(eq(advances.driverId, driver.id), sql`${advances.date} LIKE ${monthPrefix + '%'}`))
        .orderBy(desc(advances.date));

      const driverCoverages = await db
        .select()
        .from(coverageRecords)
        .where(
          and(
            eq(coverageRecords.absentDriverId, driver.id),
            sql`${coverageRecords.date} LIKE ${monthPrefix + '%'}`
          )
        )
        .orderBy(desc(coverageRecords.date));

      const transactions = await db
        .select()
        .from(financialTransactions)
        .where(
          and(
            eq(financialTransactions.driverId, driver.id),
            eq(financialTransactions.month, month),
            eq(financialTransactions.year, year)
          )
        )
        .orderBy(desc(financialTransactions.createdAt));

      const driverNotifications = await db
        .select()
        .from(notifications)
        .where(eq(notifications.recipientDriverId, driver.id))
        .orderBy(desc(notifications.createdAt))
        .limit(20);

      let latestGps = null;
      let vehicleGpsStatus = 'offline';
      if (driver.vehicleId) {
        const [veh] = await db
          .select()
          .from(vehicles)
          .where(eq(vehicles.id, driver.vehicleId))
          .limit(1);
        vehicleGpsStatus = veh?.gpsStatus || 'offline';
        const [g] = await db
          .select()
          .from(gpsLocations)
          .where(eq(gpsLocations.vehicleId, driver.vehicleId))
          .orderBy(desc(gpsLocations.recordedAt))
          .limit(1);
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
      if (!assign) return res.status(400).json({ error: 'لا توجد مركبة معينة' });

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
