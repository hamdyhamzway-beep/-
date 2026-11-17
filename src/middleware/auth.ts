import type { NextFunction, Request, Response } from 'express';
import { eq, sql } from 'drizzle-orm';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { adminAuth } from '../lib/firebase-admin.ts';
import {
  issueDriverSessionToken,
  issueSupervisorSessionToken,
  shouldRefreshSessionToken,
  verifyDriverSessionToken,
  verifySupervisorSessionToken,
} from '../lib/driver-session.ts';
import { db } from '../db/index.ts';
import { runWithRlsContext } from '../db/rls-context.ts';
import { drivers, supervisors, userRoles, users } from '../db/schema.ts';

export interface DbUserContext {
  id: number;
  uid: string;
  email: string;
  fullName: string;
  phone: string | null;
  roleId: number;
  roleSlug: string;
  roleNameAr: string;
  permissions: string[];
  isActive: boolean;
}

export interface AuthRequest extends Request {
  firebaseUser?: DecodedIdToken;
  dbUser?: DbUserContext;
  driverRecord?: typeof drivers.$inferSelect | null;
  supervisorRecord?: typeof supervisors.$inferSelect | null;
  refreshedSessionToken?: string;
}

const DEFAULT_ROLES = [
  {
    slug: 'super_admin',
    nameAr: 'المدير العام (المالك)',
    description: 'صلاحيات كاملة على كافة المدارس والسائقين والحسابات والتتبع والمساعد الصوتي',
    permissions: ['*'],
  },
  {
    slug: 'driver',
    nameAr: 'سائق',
    description: 'عرض الملف الشخصي والمركبة والراتب وكشف الحساب ومشاركة الموقع فقط',
    permissions: ['driver:self_read', 'driver:gps_write', 'driver:notifications'],
  },
  {
    slug: 'supervisor',
    nameAr: 'المشرفة',
    description: 'عرض بيانات المشرفة وخط السير والتتبع المباشر للباص فقط بدون أي بيانات مالية',
    permissions: ['supervisor:self_read', 'supervisor:gps_read'],
  },
  {
    slug: 'movement_manager',
    nameAr: 'مشرف حركة',
    description: 'إدارة المسارات والمركبات والتغطيات اليومية ومتابعة الخريطة المباشرة',
    permissions: [
      'dashboard:read',
      'drivers:read',
      'vehicles:read',
      'vehicles:write',
      'schools:read',
      'routes:write',
      'coverage:write',
      'attendance:write',
      'gps:read',
    ],
  },
  {
    slug: 'accountant',
    nameAr: 'محاسب',
    description: 'إدارة المرتبات والسلف والخصومات والمكافآت والتقارير المالية',
    permissions: [
      'dashboard:read',
      'drivers:read',
      'schools:read',
      'finance:read',
      'finance:write',
      'reports:read',
    ],
  },
];

let rolesSeeded = false;

export async function ensureRolesExist() {
  if (rolesSeeded) return;
  for (const r of DEFAULT_ROLES) {
    await db
      .insert(userRoles)
      .values(r)
      .onConflictDoNothing({ target: userRoles.slug });
  }
  rolesSeeded = true;
}

async function resolveUserContext(decoded: DecodedIdToken): Promise<{
  dbUser: DbUserContext;
  driverRecord: typeof drivers.$inferSelect | null;
  supervisorRecord: typeof supervisors.$inferSelect | null;
}> {
  await ensureRolesExist();

  const email = (decoded.email || `${decoded.uid}@alwaleed-travel.local`).toLowerCase();
  const displayName = decoded.name || email.split('@')[0] || 'مستخدم';

  // Check if user already exists
  const existingUsers = await db
    .select()
    .from(users)
    .where(eq(users.uid, decoded.uid))
    .limit(1);

  let userRow = existingUsers[0];

  if (!userRow) {
    // Also check by email in case pre-provisioned or email matched
    const byEmail = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (byEmail[0]) {
      const updated = await db
        .update(users)
        .set({ uid: decoded.uid, fullName: byEmail[0].fullName || displayName, updatedAt: new Date() })
        .where(eq(users.id, byEmail[0].id))
        .returning();
      userRow = updated[0];
    } else {
      const matchedDriver = await db
        .select()
        .from(drivers)
        .where(eq(drivers.linkedEmail, email))
        .limit(1);

      const matchedSupervisor = await db
        .select()
        .from(supervisors)
        .where(eq(supervisors.linkedEmail, email))
        .limit(1);

      const allRoles = await db.select().from(userRoles);
      const superAdminRole = allRoles.find((r) => r.slug === 'super_admin')!;
      const driverRole = allRoles.find((r) => r.slug === 'driver')!;
      const supervisorRole = allRoles.find((r) => r.slug === 'supervisor') || driverRole;

      let assignedRoleId = driverRole.id;

      if (matchedDriver[0]) {
        assignedRoleId = driverRole.id;
      } else if (matchedSupervisor[0]) {
        assignedRoleId = supervisorRole.id;
      } else if (email === 'hamdyhamzway@gmail.com') {
        assignedRoleId = superAdminRole.id;
      } else {
        const adminCountRes = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(users)
          .where(eq(users.roleId, superAdminRole.id));
        if ((adminCountRes[0]?.count ?? 0) === 0) {
          assignedRoleId = superAdminRole.id;
        }
      }

      const inserted = await db
        .insert(users)
        .values({
          uid: decoded.uid,
          email,
          fullName: displayName,
          roleId: assignedRoleId,
          isActive: true,
        })
        .onConflictDoUpdate({
          target: users.uid,
          set: { email, updatedAt: new Date() },
        })
        .returning();

      userRow = inserted[0];

      if (matchedDriver[0] && !matchedDriver[0].userId) {
        await db
          .update(drivers)
          .set({ userId: userRow.id })
          .where(eq(drivers.id, matchedDriver[0].id));
      }

      if (matchedSupervisor[0] && !matchedSupervisor[0].userId) {
        await db
          .update(supervisors)
          .set({ userId: userRow.id })
          .where(eq(supervisors.id, matchedSupervisor[0].id));
      }
    }
  }

  const roleRows = await db
    .select()
    .from(userRoles)
    .where(eq(userRoles.id, userRow.roleId))
    .limit(1);

  const role = roleRows[0] || {
    id: userRow.roleId,
    slug: 'driver',
    nameAr: 'سائق',
    permissions: ['driver:self_read'],
  };

  // Find linked driver record if any
  let driverRec: typeof drivers.$inferSelect | null = null;
  const driverByUser = await db
    .select()
    .from(drivers)
    .where(eq(drivers.userId, userRow.id))
    .limit(1);
  if (driverByUser[0]) {
    driverRec = driverByUser[0];
  } else {
    const driverByEmail = await db
      .select()
      .from(drivers)
      .where(eq(drivers.linkedEmail, email))
      .limit(1);
    if (driverByEmail[0]) {
      driverRec = driverByEmail[0];
      await db
        .update(drivers)
        .set({ userId: userRow.id })
        .where(eq(drivers.id, driverByEmail[0].id));
    }
  }

  // Find linked supervisor record if any
  let supervisorRec: typeof supervisors.$inferSelect | null = null;
  const supByUser = await db
    .select()
    .from(supervisors)
    .where(eq(supervisors.userId, userRow.id))
    .limit(1);
  if (supByUser[0]) {
    supervisorRec = supByUser[0];
  } else {
    const supByEmail = await db
      .select()
      .from(supervisors)
      .where(eq(supervisors.linkedEmail, email))
      .limit(1);
    if (supByEmail[0]) {
      supervisorRec = supByEmail[0];
      await db
        .update(supervisors)
        .set({ userId: userRow.id })
        .where(eq(supervisors.id, supByEmail[0].id));
    }
  }

  return {
    dbUser: {
      id: userRow.id,
      uid: userRow.uid,
      email: userRow.email,
      fullName: userRow.fullName,
      phone: userRow.phone,
      roleId: userRow.roleId,
      roleSlug: role.slug,
      roleNameAr: role.nameAr,
      permissions: Array.isArray(role.permissions) ? role.permissions : [],
      isActive: userRow.isActive,
    },
    driverRecord: driverRec,
    supervisorRecord: supervisorRec,
  };
}

export async function ensureSeedOwnerUserId(): Promise<number> {
  await ensureRolesExist();
  const ownerEmail = 'hamdyhamzway@gmail.com';
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.email, ownerEmail))
    .limit(1);
  if (existing) return existing.id;

  const [superAdminRole] = await db
    .select()
    .from(userRoles)
    .where(eq(userRoles.slug, 'super_admin'))
    .limit(1);

  if (!superAdminRole) {
    throw new Error('تعذر العثور على صلاحية المدير العام');
  }

  const [created] = await db
    .insert(users)
    .values({
      uid: 'pending_owner_hamdyhamzway',
      email: ownerEmail,
      fullName: 'المدير العام — الوليد ترافيل',
      roleId: superAdminRole.id,
      isActive: true,
    })
    .onConflictDoNothing({ target: users.email })
    .returning();

  if (created) return created.id;

  const [refetched] = await db
    .select()
    .from(users)
    .where(eq(users.email, ownerEmail))
    .limit(1);
  if (!refetched) {
    throw new Error('تعذر إنشاء حساب المدير الافتراضي');
  }
  return refetched.id;
}

export const requireAuth = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'غير مصرح: يرجى تسجيل الدخول أولاً' });
  }

  const token = authHeader.split('Bearer ')[1];

  // 1. Persistent Driver Token
  if (token.startsWith('drv_')) {
    const payload = verifyDriverSessionToken(token);
    if (!payload) {
      return res.status(401).json({ error: 'انتهت صلاحية جلسة السائق، يرجى تسجيل الدخول مرة أخرى' });
    }

    try {
      const resolved = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        const [userRow] = await db
          .select()
          .from(users)
          .where(eq(users.id, payload.userId))
          .limit(1);
        const [driverRec] = await db
          .select()
          .from(drivers)
          .where(eq(drivers.id, payload.driverId))
          .limit(1);

        if (!userRow || !driverRec) return null;

        const [role] = await db
          .select()
          .from(userRoles)
          .where(eq(userRoles.id, userRow.roleId))
          .limit(1);

        return { userRow, driverRec, role };
      });

      if (!resolved) {
        return res.status(401).json({ error: 'بيانات حساب السائق غير متوفرة، يرجى إعادة الدخول' });
      }

      if (!resolved.userRow.isActive || resolved.driverRec.accountStatus !== 'active') {
        return res.status(403).json({ error: 'تم إيقاف هذا الحساب من قبل الإدارة' });
      }

      const role = resolved.role || {
        id: resolved.userRow.roleId,
        slug: 'driver',
        nameAr: 'سائق',
        permissions: ['driver:self_read', 'driver:gps_write', 'driver:notifications'],
      };

      const dbUser: DbUserContext = {
        id: resolved.userRow.id,
        uid: resolved.userRow.uid,
        email: resolved.userRow.email,
        fullName: resolved.driverRec.fullName || resolved.userRow.fullName,
        phone: resolved.driverRec.phone || resolved.userRow.phone,
        roleId: resolved.userRow.roleId,
        roleSlug: role.slug,
        roleNameAr: role.nameAr,
        permissions: Array.isArray(role.permissions) ? role.permissions : [],
        isActive: resolved.userRow.isActive,
      };

      req.dbUser = dbUser;
      req.driverRecord = resolved.driverRec;

      if (shouldRefreshSessionToken(payload.exp)) {
        const freshToken = issueDriverSessionToken({
          userId: resolved.userRow.id,
          driverId: resolved.driverRec.id,
          driverCode: resolved.driverRec.driverCode,
        });
        req.refreshedSessionToken = freshToken;
        res.setHeader('X-Refreshed-Session-Token', freshToken);
      }

      return runWithRlsContext(
        {
          role: dbUser.roleSlug,
          driverId: resolved.driverRec.id,
          supervisorId: null,
        },
        () => next()
      );
    } catch (error) {
      console.error('Driver session verification error:', error);
      return res.status(500).json({ error: 'تعذر التحقق من جلسة السائق' });
    }
  }

  // 2. Persistent Supervisor Token (المشرفة)
  if (token.startsWith('sup_')) {
    const payload = verifySupervisorSessionToken(token);
    if (!payload) {
      return res.status(401).json({ error: 'انتهت صلاحية جلسة المشرفة، يرجى تسجيل الدخول مرة أخرى' });
    }

    try {
      const resolved = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        await ensureRolesExist();
        const [userRow] = await db
          .select()
          .from(users)
          .where(eq(users.id, payload.userId))
          .limit(1);
        const [supRec] = await db
          .select()
          .from(supervisors)
          .where(eq(supervisors.id, payload.supervisorId))
          .limit(1);

        if (!userRow || !supRec) return null;

        const [role] = await db
          .select()
          .from(userRoles)
          .where(eq(userRoles.id, userRow.roleId))
          .limit(1);

        return { userRow, supRec, role };
      });

      if (!resolved) {
        return res.status(401).json({ error: 'بيانات حساب المشرفة غير متوفرة، يرجى إعادة الدخول' });
      }

      if (!resolved.userRow.isActive || resolved.supRec.accountStatus !== 'active') {
        return res.status(403).json({ error: 'تم إيقاف هذا الحساب من قبل الإدارة' });
      }

      const dbUser: DbUserContext = {
        id: resolved.userRow.id,
        uid: resolved.userRow.uid,
        email: resolved.userRow.email,
        fullName: resolved.supRec.fullName || resolved.userRow.fullName,
        phone: resolved.supRec.phone || resolved.userRow.phone,
        roleId: resolved.userRow.roleId,
        roleSlug: 'supervisor',
        roleNameAr: resolved.role?.nameAr || 'المشرفة',
        permissions: ['supervisor:self_read', 'supervisor:gps_read'],
        isActive: resolved.userRow.isActive,
      };

      req.dbUser = dbUser;
      req.supervisorRecord = resolved.supRec;

      if (shouldRefreshSessionToken(payload.exp)) {
        const freshToken = issueSupervisorSessionToken({
          userId: resolved.userRow.id,
          supervisorId: resolved.supRec.id,
          supervisorCode: resolved.supRec.supervisorCode,
        });
        req.refreshedSessionToken = freshToken;
        res.setHeader('X-Refreshed-Session-Token', freshToken);
      }

      return runWithRlsContext(
        {
          role: 'supervisor',
          driverId: null,
          supervisorId: resolved.supRec.id,
        },
        () => next()
      );
    } catch (error) {
      console.error('Supervisor session verification error:', error);
      return res.status(500).json({ error: 'تعذر التحقق من جلسة المشرفة' });
    }
  }

  // 3. Firebase ID Token
  let decodedToken: DecodedIdToken;
  try {
    decodedToken = await adminAuth.verifyIdToken(token);
    req.firebaseUser = decodedToken;
  } catch (error: unknown) {
    console.error('Firebase ID token verification error:', error);
    const errObj = error as { code?: string; message?: string } | null;
    const errCode = String(errObj?.code || '');
    const errMsg = String(errObj?.message || '').toLowerCase();
    const isTransientCertFetch =
      errCode === 'auth/internal-error' ||
      errMsg.includes('fetching public keys') ||
      errMsg.includes('etimedout') ||
      errMsg.includes('econnreset') ||
      errMsg.includes('enotfound') ||
      errMsg.includes('network');

    if (isTransientCertFetch) {
      return res.status(503).json({
        error: 'تعذر التحقق من الخادم مؤقتاً، يرجى إعادة المحاولة',
        code: 'AUTH_TEMPORARY_UNAVAILABLE',
      });
    }

    return res.status(401).json({
      error: 'انتهت صلاحية الجلسة أو رمز التحقق غير صالح',
      code: errCode || 'TOKEN_EXPIRED',
    });
  }

  try {
    const { dbUser, driverRecord, supervisorRecord } = await runWithRlsContext(
      { role: 'system', driverId: null },
      () => resolveUserContext(decodedToken)
    );
    if (!dbUser.isActive) {
      return res.status(403).json({ error: 'تم إيقاف هذا الحساب من قبل الإدارة' });
    }
    req.dbUser = dbUser;
    req.driverRecord = driverRecord;
    req.supervisorRecord = supervisorRecord;

    return runWithRlsContext(
      {
        role: dbUser.roleSlug,
        driverId: driverRecord?.id ?? null,
        supervisorId: supervisorRecord?.id ?? null,
      },
      () => next()
    );
  } catch (error) {
    console.error('User context DB resolution error:', error);
    return res.status(500).json({ error: 'تعذر تحميل بيانات الحساب من قاعدة البيانات' });
  }
};

export function hasPermission(user: DbUserContext | undefined, permission: string): boolean {
  if (!user) return false;
  if (user.roleSlug === 'super_admin' || user.permissions.includes('*')) return true;
  return user.permissions.includes(permission);
}

export const requirePermission = (permission: string) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!hasPermission(req.dbUser, permission)) {
      return res.status(403).json({
        error: 'ليس لديك صلاحية تنفيذ هذا الإجراء',
      });
    }
    next();
  };
};

export const requireAnyPermission = (permissions: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!permissions.some((p) => hasPermission(req.dbUser, p))) {
      return res.status(403).json({
        error: 'ليس لديك صلاحية تنفيذ هذا الإجراء',
      });
    }
    next();
  };
};

export const requireAdminOrStaff = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.dbUser || req.dbUser.roleSlug === 'driver' || req.dbUser.roleSlug === 'supervisor') {
    return res.status(403).json({
      error: 'هذا القسم مخصص لإدارة الوليد ترافيل فقط',
    });
  }
  next();
};
