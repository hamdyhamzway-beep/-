import type { NextFunction, Request, Response } from 'express';
import { eq, sql } from 'drizzle-orm';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { adminAuth } from '../lib/firebase-admin.ts';
import { verifyDriverSessionToken } from '../lib/driver-session.ts';
import { db } from '../db/index.ts';
import { runWithRlsContext } from '../db/rls-context.ts';
import { drivers, userRoles, users } from '../db/schema.ts';

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
      // Determine default role:
      // 1. If linked to a driver record by email -> driver role
      // 2. If primary owner email or no super_admin exists yet -> super_admin role
      // 3. Otherwise -> driver role (safe least-privilege default; admin can promote later)
      const matchedDriver = await db
        .select()
        .from(drivers)
        .where(eq(drivers.linkedEmail, email))
        .limit(1);

      const allRoles = await db.select().from(userRoles);
      const superAdminRole = allRoles.find((r) => r.slug === 'super_admin')!;
      const driverRole = allRoles.find((r) => r.slug === 'driver')!;

      let assignedRoleId = driverRole.id;

      if (matchedDriver[0]) {
        assignedRoleId = driverRole.id;
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

      return runWithRlsContext(
        {
          role: dbUser.roleSlug,
          driverId: resolved.driverRec.id,
        },
        () => next()
      );
    } catch (error) {
      console.error('Driver session verification error:', error);
      return res.status(500).json({ error: 'تعذر التحقق من جلسة السائق' });
    }
  }

  let decodedToken: DecodedIdToken;
  try {
    decodedToken = await adminAuth.verifyIdToken(token);
    req.firebaseUser = decodedToken;
  } catch (error) {
    console.error('Firebase ID token verification error:', error);
    return res.status(401).json({ error: 'انتهت صلاحية الجلسة أو رمز التحقق غير صالح' });
  }

  try {
    const { dbUser, driverRecord } = await runWithRlsContext(
      { role: 'system', driverId: null },
      () => resolveUserContext(decodedToken)
    );
    if (!dbUser.isActive) {
      return res.status(403).json({ error: 'تم إيقاف هذا الحساب من قبل الإدارة' });
    }
    req.dbUser = dbUser;
    req.driverRecord = driverRecord;

    return runWithRlsContext(
      {
        role: dbUser.roleSlug,
        driverId: driverRecord?.id ?? null,
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
  if (!req.dbUser || req.dbUser.roleSlug === 'driver') {
    return res.status(403).json({
      error: 'هذا القسم مخصص لإدارة الوليد ترافيل فقط',
    });
  }
  next();
};
