import type { NextFunction, Request, Response } from 'express';
import { eq, sql } from 'drizzle-orm';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { adminAuth } from '../lib/firebase-admin.ts';
import {
  issueDriverSessionToken,
  issueStaffSessionToken,
  issueSupervisorSessionToken,
  shouldRefreshSessionToken,
  verifyDriverSessionToken,
  verifyStaffSessionToken,
  verifySupervisorSessionToken,
} from '../lib/driver-session.ts';
import {
  ROLE_DEFAULT_PERMISSIONS,
  normalizeSchoolIds,
} from '../lib/permissions.ts';
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
  customPermissions: string[] | null;
  assignedSchoolIds: number[];
  staffCode: string | null;
  employeeId: number | null;
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
    permissions: ROLE_DEFAULT_PERMISSIONS.super_admin,
  },
  {
    slug: 'driver',
    nameAr: 'سائق',
    description: 'عرض الملف الشخصي والمركبة والراتب وكشف الحساب ومشاركة الموقع فقط',
    permissions: ROLE_DEFAULT_PERMISSIONS.driver,
  },
  {
    slug: 'supervisor',
    nameAr: 'المشرفة',
    description: 'عرض بيانات المشرفة وخط السير والتتبع المباشر للباص فقط بدون أي بيانات مالية',
    permissions: ROLE_DEFAULT_PERMISSIONS.supervisor,
  },
  {
    slug: 'movement_manager',
    nameAr: 'مشرف حركة',
    description: 'إدارة المسارات والمركبات والتغطيات والسلف والوصول للسائقين في المدارس المخصصة له',
    permissions: ROLE_DEFAULT_PERMISSIONS.movement_manager,
  },
  {
    slug: 'accountant',
    nameAr: 'محاسب',
    description: 'إدارة المرتبات والسلف والتغطيات والخصومات والمكافآت والتقارير المالية للمدارس المخصصة له',
    permissions: ROLE_DEFAULT_PERMISSIONS.accountant,
  },
];

let rolesSeeded = false;

export async function ensureRolesExist() {
  if (rolesSeeded) return;
  for (const r of DEFAULT_ROLES) {
    if (r.slug === 'movement_manager' || r.slug === 'accountant') {
      await db
        .insert(userRoles)
        .values(r)
        .onConflictDoUpdate({
          target: userRoles.slug,
          set: {
            description: r.description,
            permissions: r.permissions,
          },
        });
    } else {
      await db
        .insert(userRoles)
        .values(r)
        .onConflictDoNothing({ target: userRoles.slug });
    }
  }
  rolesSeeded = true;
}

export function buildEffectivePermissions(
  roleSlug: string,
  rolePermissions: unknown,
  customPermissions: unknown
): string[] {
  if (roleSlug === 'super_admin') return ['*'];
  if (Array.isArray(customPermissions)) return customPermissions;
  if (Array.isArray(rolePermissions)) return rolePermissions as string[];
  return [];
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

  const effectivePermissions = buildEffectivePermissions(
    role.slug,
    role.permissions,
    userRow.customPermissions
  );
  const assignedSchoolIds =
    role.slug === 'super_admin' ? [] : normalizeSchoolIds(userRow.assignedSchoolIds);

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
      permissions: effectivePermissions,
      customPermissions: Array.isArray(userRow.customPermissions)
        ? userRow.customPermissions
        : null,
      assignedSchoolIds,
      staffCode: userRow.staffCode || null,
      employeeId: userRow.employeeId ?? null,
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
        customPermissions: null,
        assignedSchoolIds: [],
        staffCode: null,
        employeeId: null,
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
        customPermissions: null,
        assignedSchoolIds: [],
        staffCode: null,
        employeeId: null,
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

  // 2b. Persistent Staff Token (المحاسب / مشرف الحركة / الموظف المصرح له)
  if (token.startsWith('stf_')) {
    const payload = verifyStaffSessionToken(token);
    if (!payload) {
      return res.status(401).json({ error: 'انتهت صلاحية جلسة الموظف، يرجى تسجيل الدخول مرة أخرى' });
    }

    try {
      const resolved = await runWithRlsContext({ role: 'system', driverId: null }, async () => {
        await ensureRolesExist();
        const [userRow] = await db
          .select()
          .from(users)
          .where(eq(users.id, payload.userId))
          .limit(1);

        if (!userRow) return null;

        const [role] = await db
          .select()
          .from(userRoles)
          .where(eq(userRoles.id, userRow.roleId))
          .limit(1);

        return { userRow, role };
      });

      if (!resolved) {
        return res.status(401).json({ error: 'بيانات حساب الموظف غير متوفرة، يرجى إعادة الدخول' });
      }

      if (!resolved.userRow.isActive) {
        return res.status(403).json({ error: 'تم إيقاف صلاحية هذا الحساب من قبل المدير العام' });
      }

      const roleSlug = resolved.role?.slug || 'accountant';
      if (roleSlug === 'driver' || roleSlug === 'supervisor') {
        return res.status(403).json({ error: 'تم تغيير دور هذا الحساب، يرجى تسجيل الدخول من البوابة المناسبة' });
      }

      const effectivePermissions = buildEffectivePermissions(
        roleSlug,
        resolved.role?.permissions,
        resolved.userRow.customPermissions
      );
      const assignedSchoolIds =
        roleSlug === 'super_admin'
          ? []
          : normalizeSchoolIds(resolved.userRow.assignedSchoolIds);

      const dbUser: DbUserContext = {
        id: resolved.userRow.id,
        uid: resolved.userRow.uid,
        email: resolved.userRow.email,
        fullName: resolved.userRow.fullName,
        phone: resolved.userRow.phone,
        roleId: resolved.userRow.roleId,
        roleSlug,
        roleNameAr: resolved.role?.nameAr || 'موظف إدارة',
        permissions: effectivePermissions,
        customPermissions: Array.isArray(resolved.userRow.customPermissions)
          ? resolved.userRow.customPermissions
          : null,
        assignedSchoolIds,
        staffCode: resolved.userRow.staffCode || null,
        employeeId: resolved.userRow.employeeId ?? null,
        isActive: resolved.userRow.isActive,
      };

      req.dbUser = dbUser;

      if (shouldRefreshSessionToken(payload.exp)) {
        const freshToken = issueStaffSessionToken({
          userId: resolved.userRow.id,
          staffCode: resolved.userRow.staffCode || payload.staffCode,
        });
        req.refreshedSessionToken = freshToken;
        res.setHeader('X-Refreshed-Session-Token', freshToken);
      }

      return runWithRlsContext(
        {
          role: dbUser.roleSlug,
          driverId: null,
          supervisorId: null,
        },
        () => next()
      );
    } catch (error) {
      console.error('Staff session verification error:', error);
      return res.status(500).json({ error: 'تعذر التحقق من جلسة الموظف' });
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

export function isSchoolUnrestricted(user: DbUserContext | undefined): boolean {
  if (!user) return false;
  if (user.roleSlug === 'super_admin' || user.permissions.includes('*')) return true;
  return !user.assignedSchoolIds || user.assignedSchoolIds.length === 0;
}

export function isSchoolAllowed(
  user: DbUserContext | undefined,
  schoolId: number | null | undefined
): boolean {
  if (!user) return false;
  if (isSchoolUnrestricted(user)) return true;
  if (schoolId === null || schoolId === undefined) return false;
  return user.assignedSchoolIds.includes(Number(schoolId));
}

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
