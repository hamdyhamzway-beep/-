export interface PermissionDefinition {
  key: string;
  labelAr: string;
  descriptionAr: string;
  group: 'operations' | 'finance' | 'fleet' | 'admin';
}

export const STAFF_PERMISSIONS_CATALOG: PermissionDefinition[] = [
  {
    key: 'dashboard:read',
    labelAr: 'لوحة التحكم والبحث السريع',
    descriptionAr: 'الدخول إلى لوحة التحكم والبحث عن السائقين وفتح صفحة السائق',
    group: 'operations',
  },
  {
    key: 'drivers:read',
    labelAr: 'الوصول للسائقين',
    descriptionAr: 'عرض قائمة السائقين وبياناتهم وتفاصيل التعيين',
    group: 'operations',
  },
  {
    key: 'drivers:write',
    labelAr: 'إضافة وتعديل السائقين',
    descriptionAr: 'إضافة سائقين جدد وتعديل بياناتهم وتعيينهم للمدارس والباصات',
    group: 'operations',
  },
  {
    key: 'advances:write',
    labelAr: 'تسجيل وتعديل السلف',
    descriptionAr: 'إضافة وتعديل وحذف سلف السائقين في المدارس المصرح بها',
    group: 'finance',
  },
  {
    key: 'coverage:write',
    labelAr: 'تسجيل وتعديل التغطيات',
    descriptionAr: 'إضافة وتعديل وحذف سجلات التغطيات اليومية والبدلاء',
    group: 'finance',
  },
  {
    key: 'finance:read',
    labelAr: 'عرض الرواتب وكشوف الحساب',
    descriptionAr: 'الاطلاع على الرواتب وتفاصيل السلف والتغطيات وعقود المدارس المصرح بها',
    group: 'finance',
  },
  {
    key: 'finance:write',
    labelAr: 'تعديل الرواتب والمكافآت والخصومات',
    descriptionAr: 'اعتماد وصرف الرواتب وإضافة المكافآت والخصومات والتقفيل الشهري',
    group: 'finance',
  },
  {
    key: 'attendance:write',
    labelAr: 'تسجيل الحضور والغياب',
    descriptionAr: 'تسجيل وتعديل حالات حضور وغياب السائقين يومياً',
    group: 'operations',
  },
  {
    key: 'schools:read',
    labelAr: 'عرض المدارس والعقود',
    descriptionAr: 'الاطلاع على بيانات المدارس وخطوط السير المخصصة',
    group: 'fleet',
  },
  {
    key: 'schools:write',
    labelAr: 'تعديل المدارس والعقود',
    descriptionAr: 'تعديل بيانات المدارس وقيم العقود الشهرية',
    group: 'fleet',
  },
  {
    key: 'vehicles:read',
    labelAr: 'عرض المركبات والملاك',
    descriptionAr: 'عرض أرقام الباصات واللوحات وملاك السيارات',
    group: 'fleet',
  },
  {
    key: 'vehicles:write',
    labelAr: 'إدارة المركبات والملاك',
    descriptionAr: 'إضافة وتعديل الباصات وملاك المركبات',
    group: 'fleet',
  },
  {
    key: 'routes:write',
    labelAr: 'إدارة خطوط السير',
    descriptionAr: 'إضافة وتعديل خطوط السير ومواعيد التحرك',
    group: 'fleet',
  },
  {
    key: 'gps:read',
    labelAr: 'التتبع المباشر (GPS)',
    descriptionAr: 'متابعة مواقع الباصات المباشرة وسجل الحركة والمشرفات',
    group: 'fleet',
  },
  {
    key: 'reports:read',
    labelAr: 'التقارير والتصدير',
    descriptionAr: 'عرض وتصدير التقارير الشهرية والمالية',
    group: 'admin',
  },
  {
    key: 'employees:read',
    labelAr: 'عرض الموظفين غير السائقين',
    descriptionAr: 'الاطلاع على كشوف الموظفين الإداريين',
    group: 'admin',
  },
  {
    key: 'employees:write',
    labelAr: 'إدارة الموظفين غير السائقين',
    descriptionAr: 'إضافة وتعديل وحذف الموظفين غير السائقين',
    group: 'admin',
  },
];

export const PERMISSION_LABEL_MAP: Record<string, string> = Object.fromEntries(
  STAFF_PERMISSIONS_CATALOG.map((p) => [p.key, p.labelAr])
);

export const ROLE_DEFAULT_PERMISSIONS: Record<string, string[]> = {
  super_admin: ['*'],
  driver: ['driver:self_read', 'driver:gps_write', 'driver:notifications'],
  supervisor: ['supervisor:self_read', 'supervisor:gps_read'],
  movement_manager: [
    'dashboard:read',
    'drivers:read',
    'advances:write',
    'coverage:write',
    'finance:read',
    'vehicles:read',
    'vehicles:write',
    'schools:read',
    'routes:write',
    'attendance:write',
    'gps:read',
  ],
  accountant: [
    'dashboard:read',
    'drivers:read',
    'advances:write',
    'coverage:write',
    'schools:read',
    'finance:read',
    'finance:write',
    'reports:read',
  ],
};

export function normalizeSchoolIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const unique = new Set<number>();
  for (const item of raw) {
    const n = Number(item);
    if (Number.isInteger(n) && n > 0) unique.add(n);
  }
  return Array.from(unique);
}

export function normalizePermissionsList(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return null;
  const allowedKeys = new Set(['*', ...STAFF_PERMISSIONS_CATALOG.map((p) => p.key)]);
  const unique = new Set<string>();
  for (const item of raw) {
    if (typeof item === 'string' && allowedKeys.has(item.trim())) {
      unique.add(item.trim());
    }
  }
  return Array.from(unique);
}
