import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgPolicy,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// 1. User Roles (supports super_admin, driver, and future roles like movement_manager, accountant)
export const userRoles = pgTable('user_roles', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  nameAr: text('name_ar').notNull(),
  description: text('description'),
  permissions: jsonb('permissions').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 2. Users (linked to Firebase Auth UID or Staff Code)
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull().unique(),
  fullName: text('full_name').notNull().default('مستخدم'),
  phone: text('phone'),
  roleId: integer('role_id')
    .references(() => userRoles.id)
    .notNull(),
  assignedSchoolIds: jsonb('assigned_school_ids').$type<number[]>().notNull().default([]),
  customPermissions: jsonb('custom_permissions').$type<string[] | null>().default(null),
  staffCode: text('staff_code').default(''),
  employeeId: integer('employee_id').references(() => employees.id, { onDelete: 'set null' }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 3. Schools
export const schools = pgTable('schools', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  contactName: text('contact_name').notNull().default(''),
  contactPhone: text('contact_phone').notNull().default(''),
  address: text('address').notNull().default(''),
  lat: doublePrecision('lat').notNull().default(30.0444),
  lng: doublePrecision('lng').notNull().default(31.2357),
  monthlyContractValue: numeric('monthly_contract_value', { precision: 12, scale: 2 })
    .notNull()
    .default('0'),
  contractStartDate: text('contract_start_date').notNull().default(''),
  contractEndDate: text('contract_end_date').notNull().default(''),
  billingCycleType: text('billing_cycle_type').notNull().default('calendar'), // calendar (1..30/31) | shifted (e.g. 13..12)
  billingCycleStartDay: integer('billing_cycle_start_day').notNull().default(1), // 1 for calendar, 13 for Al-Hilaliya
  billingCycleEndDay: integer('billing_cycle_end_day'), // e.g. 12 for Al-Hilaliya or custom end day
  notes: text('notes').default(''),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 4. Vehicles (previously vehicleOwners removed)
export const vehicles = pgTable('vehicles', {
  id: serial('id').primaryKey(),
  busNumber: text('bus_number').notNull().unique(),
  registrationNumber: text('registration_number').notNull().unique(),
  vehicleType: text('vehicle_type').notNull().default(''),
  schoolId: integer('school_id').references(() => schools.id),
  operationalStatus: text('operational_status').notNull().default('active'), // active | maintenance | inactive
  gpsStatus: text('gps_status').notNull().default('offline'), // online | offline | paused
  notes: text('notes').default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 6. Routes
export const routes = pgTable('routes', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  schoolId: integer('school_id').references(() => schools.id),
  pickupArea: text('pickup_area').notNull().default(''),
  dropoffArea: text('dropoff_area').notNull().default(''),
  pickupTime: text('pickup_time').notNull().default(''),
  dropoffTime: text('dropoff_time').notNull().default(''),
  estimatedDistanceKm: doublePrecision('estimated_distance_km').default(0),
  notes: text('notes').default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export interface DriverLicensePhoto {
  id: string;
  label: string;
  imageUrl: string;
  uploadedBy: 'admin' | 'driver';
  uploadedAt: string;
}

// 7. Drivers
export const drivers = pgTable(
  'drivers',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id),
    linkedEmail: text('linked_email').default(''),
    driverCode: text('driver_code').notNull().unique(),
    fullName: text('full_name').notNull(),
    phone: text('phone').notNull(),
    emergencyContact: text('emergency_contact').default(''),
    monthlyAgreedSalary: numeric('monthly_agreed_salary', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    employmentStartDate: text('employment_start_date').notNull().default(''),
    accountStatus: text('account_status').notNull().default('active'), // active | inactive | suspended
    photoUrl: text('photo_url').default(''),
    licensePhotosJson: jsonb('license_photos_json')
      .$type<DriverLicensePhoto[]>()
      .notNull()
      .default([]),
    notes: text('notes').default(''),
    documentsJson: jsonb('documents_json')
      .$type<Array<{ title: string; refNumber: string; expiryDate?: string }>>()
      .notNull()
      .default([]),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_drivers_code').on(table.driverCode),
    pgPolicy('drivers_admin_staff_select', {
      for: 'select',
      to: 'public',
      using: sql`current_setting('app.user_role', true) IN ('system', 'super_admin', 'movement_manager', 'accountant')`,
    }),
    pgPolicy('drivers_admin_insert', {
      for: 'insert',
      to: 'public',
      withCheck: sql`current_setting('app.user_role', true) IN ('system', 'super_admin', 'movement_manager', 'accountant')`,
    }),
    pgPolicy('drivers_admin_update', {
      for: 'update',
      to: 'public',
      using: sql`current_setting('app.user_role', true) IN ('system', 'super_admin', 'movement_manager', 'accountant')`,
      withCheck: sql`current_setting('app.user_role', true) IN ('system', 'super_admin', 'movement_manager', 'accountant')`,
    }),
    pgPolicy('drivers_admin_delete', {
      for: 'delete',
      to: 'public',
      using: sql`current_setting('app.user_role', true) IN ('system', 'super_admin', 'movement_manager', 'accountant')`,
    }),
    pgPolicy('drivers_self_select', {
      for: 'select',
      to: 'public',
      using: sql`current_setting('app.user_role', true) = 'driver' AND id = CASE WHEN current_setting('app.driver_id', true) ~ '^[0-9]+$' THEN current_setting('app.driver_id', true)::integer ELSE NULL END`,
    }),
  ]
);

// 8. Driver Assignments
export const driverAssignments = pgTable(
  'driver_assignments',
  {
    id: serial('id').primaryKey(),
    driverId: integer('driver_id')
      .references(() => drivers.id)
      .notNull(),
    schoolId: integer('school_id').references(() => schools.id),
    vehicleId: integer('vehicle_id').references(() => vehicles.id),
    routeId: integer('route_id').references(() => routes.id),
    isCurrent: boolean('is_current').notNull().default(true),
    assignedAt: timestamp('assigned_at').defaultNow().notNull(),
    endedAt: timestamp('ended_at'),
  },
  (table) => [index('idx_assignments_driver_current').on(table.driverId, table.isCurrent)]
);

// 9. Salaries (Monthly materialized statement per driver)
export const salaries = pgTable(
  'salaries',
  {
    id: serial('id').primaryKey(),
    driverId: integer('driver_id')
      .references(() => drivers.id)
      .notNull(),
    schoolId: integer('school_id').references(() => schools.id),
    month: integer('month').notNull(),
    year: integer('year').notNull(),
    baseSalary: numeric('base_salary', { precision: 12, scale: 2 }).notNull().default('0'),
    totalAdvances: numeric('total_advances', { precision: 12, scale: 2 }).notNull().default('0'),
    totalCoverageDeductions: numeric('total_coverage_deductions', {
      precision: 12,
      scale: 2,
    })
      .notNull()
      .default('0'),
    otherDeductions: numeric('other_deductions', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    bonuses: numeric('bonuses', { precision: 12, scale: 2 }).notNull().default('0'),
    netSalary: numeric('net_salary', { precision: 12, scale: 2 }).notNull().default('0'),
    status: text('status').notNull().default('open'), // open | approved | paid
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uq_salaries_driver_month_year').on(table.driverId, table.month, table.year),
    index('idx_salaries_school').on(table.schoolId),
  ]
);

// 10. Advances
export const advances = pgTable(
  'advances',
  {
    id: serial('id').primaryKey(),
    driverId: integer('driver_id')
      .references(() => drivers.id)
      .notNull(),
    schoolId: integer('school_id').references(() => schools.id),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    date: text('date').notNull(), // YYYY-MM-DD
    reason: text('reason').notNull().default(''),
    paymentMethod: text('payment_method').notNull().default(''),
    notes: text('notes').default(''),
    recordedByUserId: integer('recorded_by_user_id')
      .references(() => users.id)
      .notNull(),
    idempotencyKey: text('idempotency_key').unique(),
    isReversed: boolean('is_reversed').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_advances_driver_date').on(table.driverId, table.date),
    index('idx_advances_school').on(table.schoolId),
  ]
);

// 11. Coverage Records (Absence Coverage)
export const coverageRecords = pgTable(
  'coverage_records',
  {
    id: serial('id').primaryKey(),
    absentDriverId: integer('absent_driver_id')
      .references(() => drivers.id)
      .notNull(),
    replacementDriverId: integer('replacement_driver_id').references(() => drivers.id),
    replacementExternalName: text('replacement_external_name').default(''),
    vehicleId: integer('vehicle_id').references(() => vehicles.id),
    schoolId: integer('school_id').references(() => schools.id),
    date: text('date').notNull(), // YYYY-MM-DD
    actualReplacementCost: numeric('actual_replacement_cost', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    absentDriverDeduction: numeric('absent_driver_deduction', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    reason: text('reason').notNull().default(''),
    notes: text('notes').default(''),
    recordedByUserId: integer('recorded_by_user_id')
      .references(() => users.id)
      .notNull(),
    idempotencyKey: text('idempotency_key').unique(),
    isReversed: boolean('is_reversed').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('idx_coverage_absent_date').on(table.absentDriverId, table.date)]
);

// 12. Financial Transactions (Immutable Ledger)
export const financialTransactions = pgTable(
  'financial_transactions',
  {
    id: serial('id').primaryKey(),
    driverId: integer('driver_id')
      .references(() => drivers.id)
      .notNull(),
    schoolId: integer('school_id').references(() => schools.id),
    month: integer('month').notNull(),
    year: integer('year').notNull(),
    type: text('type').notNull(), // advance | coverage_deduction | other_deduction | bonus | reversal | salary_adjustment
    direction: text('direction').notNull(), // debit | credit
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    referenceType: text('reference_type'), // advance | coverage | adjustment
    referenceId: integer('reference_id'),
    description: text('description').notNull(),
    recordedByUserId: integer('recorded_by_user_id')
      .references(() => users.id)
      .notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_ft_driver_period').on(table.driverId, table.year, table.month),
    index('idx_ft_school').on(table.schoolId),
    pgPolicy('ft_admin_accountant_select', {
      for: 'select',
      to: 'public',
      using: sql`current_setting('app.user_role', true) IN ('system', 'super_admin', 'accountant', 'movement_manager')`,
    }),
    pgPolicy('ft_admin_accountant_insert', {
      for: 'insert',
      to: 'public',
      withCheck: sql`current_setting('app.user_role', true) IN ('system', 'super_admin', 'accountant', 'movement_manager')`,
    }),
    pgPolicy('ft_admin_accountant_update', {
      for: 'update',
      to: 'public',
      using: sql`current_setting('app.user_role', true) IN ('system', 'super_admin', 'accountant', 'movement_manager')`,
      withCheck: sql`current_setting('app.user_role', true) IN ('system', 'super_admin', 'accountant', 'movement_manager')`,
    }),
    pgPolicy('ft_admin_accountant_delete', {
      for: 'delete',
      to: 'public',
      using: sql`current_setting('app.user_role', true) IN ('system', 'super_admin', 'accountant', 'movement_manager')`,
    }),
    pgPolicy('ft_driver_self_select', {
      for: 'select',
      to: 'public',
      using: sql`current_setting('app.user_role', true) = 'driver' AND driver_id = CASE WHEN current_setting('app.driver_id', true) ~ '^[0-9]+$' THEN current_setting('app.driver_id', true)::integer ELSE NULL END`,
    }),
  ]
);

// 13. Attendance
export const attendance = pgTable(
  'attendance',
  {
    id: serial('id').primaryKey(),
    driverId: integer('driver_id')
      .references(() => drivers.id)
      .notNull(),
    schoolId: integer('school_id').references(() => schools.id),
    date: text('date').notNull(), // YYYY-MM-DD
    status: text('status').notNull().default('present'), // present | absent | covered | leave
    notes: text('notes').default(''),
    recordedByUserId: integer('recorded_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uq_attendance_driver_date').on(table.driverId, table.date),
    index('idx_attendance_school').on(table.schoolId),
  ]
);

// 14. GPS Locations
export const gpsLocations = pgTable(
  'gps_locations',
  {
    id: serial('id').primaryKey(),
    vehicleId: integer('vehicle_id').references(() => vehicles.id),
    driverId: integer('driver_id').references(() => drivers.id),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    speedKmh: doublePrecision('speed_kmh').notNull().default(0),
    heading: doublePrecision('heading').default(0),
    accuracyMeters: doublePrecision('accuracy_meters').default(10),
    isLive: boolean('is_live').notNull().default(true),
    source: text('source').notNull().default('live'), // live | buffered | manual
    recordedAt: timestamp('recorded_at').defaultNow().notNull(),
  },
  (table) => [index('idx_gps_vehicle_recorded').on(table.vehicleId, table.recordedAt)]
);

// 15. Notifications
export const notifications = pgTable(
  'notifications',
  {
    id: serial('id').primaryKey(),
    recipientUserId: integer('recipient_user_id').references(() => users.id),
    recipientDriverId: integer('recipient_driver_id').references(() => drivers.id),
    targetRole: text('target_role'), // super_admin | driver | all
    type: text('type').notNull(), // advance | coverage | salary | account_status | gps_alert | announcement
    title: text('title').notNull(),
    body: text('body').notNull(),
    isRead: boolean('is_read').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('idx_notif_driver').on(table.recipientDriverId, table.createdAt)]
);

// 16. Voice Command Logs
export const voiceCommandLogs = pgTable('voice_command_logs', {
  id: serial('id').primaryKey(),
  adminUserId: integer('admin_user_id')
    .references(() => users.id)
    .notNull(),
  rawTranscript: text('raw_transcript').notNull(),
  parsedIntent: text('parsed_intent').notNull(),
  extractedEntitiesJson: jsonb('extracted_entities_json').$type<Record<string, unknown>>().default({}),
  requiresConfirmation: boolean('requires_confirmation').notNull().default(false),
  wasConfirmed: boolean('was_confirmed').notNull().default(false),
  executionStatus: text('execution_status').notNull().default('parsed'), // parsed | confirmed | executed | cancelled | failed
  responseArabic: text('response_arabic').notNull().default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 17. Audit Logs (Immutable trail)
export const auditLogs = pgTable('audit_logs', {
  id: serial('id').primaryKey(),
  actorUserId: integer('actor_user_id').references(() => users.id),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  beforeJson: jsonb('before_json'),
  afterJson: jsonb('after_json'),
  ipAddress: text('ip_address').default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 18. Non-Driver Employees (الموظفون غير السائقين)
export const employees = pgTable(
  'employees',
  {
    id: serial('id').primaryKey(),
    employeeCode: text('employee_code').notNull().default(''),
    fullName: text('full_name').notNull(),
    jobTitle: text('job_title').notNull().default(''),
    phone: text('phone').notNull().default(''),
    schoolId: integer('school_id').references(() => schools.id),
    monthlySalary: numeric('monthly_salary', { precision: 12, scale: 2 }).notNull().default('0'),
    bonuses: numeric('bonuses', { precision: 12, scale: 2 }).notNull().default('0'),
    deductions: numeric('deductions', { precision: 12, scale: 2 }).notNull().default('0'),
    employmentStartDate: text('employment_start_date').notNull().default(''),
    status: text('status').notNull().default('active'), // active | inactive
    notes: text('notes').default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [index('idx_employees_school').on(table.schoolId)]
);

// 19. Monthly Closings (تصفية الشهر وأرشفة ملخصاته - على مستوى كل مدرسة أو شامل)
export const monthlyClosings = pgTable(
  'monthly_closings',
  {
    id: serial('id').primaryKey(),
    month: integer('month').notNull(),
    year: integer('year').notNull(),
    schoolId: integer('school_id').references(() => schools.id),
    schoolName: text('school_name').default(''),
    cycleStartDate: text('cycle_start_date').default(''),
    cycleEndDate: text('cycle_end_date').default(''),
    closedByUserId: integer('closed_by_user_id').references(() => users.id),
    driversCount: integer('drivers_count').notNull().default(0),
    employeesCount: integer('employees_count').notNull().default(0),
    totalDriverSalaries: numeric('total_driver_salaries', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    totalEmployeeSalaries: numeric('total_employee_salaries', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    totalAdvances: numeric('total_advances', { precision: 12, scale: 2 }).notNull().default('0'),
    totalCoverageDeductions: numeric('total_coverage_deductions', {
      precision: 12,
      scale: 2,
    })
      .notNull()
      .default('0'),
    totalBonuses: numeric('total_bonuses', { precision: 12, scale: 2 }).notNull().default('0'),
    totalOtherDeductions: numeric('total_other_deductions', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    totalSchoolContracts: numeric('total_school_contracts', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    netProfit: numeric('net_profit', { precision: 12, scale: 2 }).notNull().default('0'),
    notes: text('notes').default(''),
    snapshotJson: jsonb('snapshot_json')
      .$type<{
        drivers: Array<{
          driverId: number;
          driverCode: string;
          fullName: string;
          schoolName: string;
          baseSalary: number;
          totalAdvances: number;
          totalCoverageDeductions: number;
          otherDeductions: number;
          bonuses: number;
          netSalary: number;
          status: string;
        }>;
        employees: Array<{
          employeeId: number;
          employeeCode: string;
          fullName: string;
          jobTitle: string;
          monthlySalary: number;
          bonuses: number;
          deductions: number;
          netSalary: number;
        }>;
        supervisors?: Array<{
          supervisorId: number;
          supervisorCode: string;
          fullName: string;
          schoolName: string;
          tripsCount: number;
          monthlySalary: number;
        }>;
      }>()
      .notNull()
      .default({ drivers: [], employees: [] }),
    closedAt: timestamp('closed_at').defaultNow().notNull(),
  },
  (table) => [index('idx_monthly_closings_period_school').on(table.month, table.year, table.schoolId)]
);

// 20. Billing Periods (الشهر المالي المفتوح حالياً للعمل عليه على بياض)
export const billingPeriods = pgTable('billing_periods', {
  id: serial('id').primaryKey(),
  key: text('key').notNull().unique(),
  activeMonth: integer('active_month').notNull(),
  activeYear: integer('active_year').notNull(),
  customStartDate: text('custom_start_date'), // YYYY-MM-DD custom start date override
  customEndDate: text('custom_end_date'), // YYYY-MM-DD custom end date override
  updatedByUserId: integer('updated_by_user_id').references(() => users.id),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Relations
export const userRolesRelations = relations(userRoles, ({ many }) => ({
  users: many(users),
}));

export const usersRelations = relations(users, ({ one }) => ({
  role: one(userRoles, { fields: [users.roleId], references: [userRoles.id] }),
}));

export const schoolsRelations = relations(schools, ({ many }) => ({
  routes: many(routes),
  vehicles: many(vehicles),
  employees: many(employees),
  assignments: many(driverAssignments),
  dailyReports: many(dailyReports),
}));

export const vehiclesRelations = relations(vehicles, ({ one, many }) => ({
  school: one(schools, { fields: [vehicles.schoolId], references: [schools.id] }),
  assignments: many(driverAssignments),
  gpsLocations: many(gpsLocations),
}));

export const employeesRelations = relations(employees, ({ one }) => ({
  school: one(schools, { fields: [employees.schoolId], references: [schools.id] }),
}));

export const driversRelations = relations(drivers, ({ one, many }) => ({
  user: one(users, { fields: [drivers.userId], references: [users.id] }),
  assignments: many(driverAssignments),
  salaries: many(salaries),
  advances: many(advances),
  financialTransactions: many(financialTransactions),
}));

// 21. Supervisors (المشرفات - نسخة المشرفة بدون أي صلاحيات مالية)
export const supervisors = pgTable(
  'supervisors',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id),
    linkedEmail: text('linked_email').default(''),
    supervisorCode: text('supervisor_code').notNull().unique(),
    fullName: text('full_name').notNull(),
    phone: text('phone').notNull(),
    photoUrl: text('photo_url').default(''),
    schoolId: integer('school_id').references(() => schools.id),
    vehicleId: integer('vehicle_id').references(() => vehicles.id),
    routeId: integer('route_id').references(() => routes.id),
    monthlySalary: numeric('monthly_salary', { precision: 12, scale: 2 }).notNull().default('0'),
    liveLat: doublePrecision('live_lat'),
    liveLng: doublePrecision('live_lng'),
    liveSpeedKmh: doublePrecision('live_speed_kmh').default(0),
    liveAccuracyMeters: doublePrecision('live_accuracy_meters'),
    liveUpdatedAt: timestamp('live_updated_at'),
    accountStatus: text('account_status').notNull().default('active'), // active | inactive
    notes: text('notes').default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [index('idx_supervisors_code').on(table.supervisorCode)]
);

// 22. Supervisor Daily Trips (سجل مهمتي المشرفة اليومية: بداية الرحلة صباحاً / نهاية الرحلة مساءً)
export const supervisorTrips = pgTable(
  'supervisor_trips',
  {
    id: serial('id').primaryKey(),
    supervisorId: integer('supervisor_id')
      .references(() => supervisors.id, { onDelete: 'cascade' })
      .notNull(),
    vehicleId: integer('vehicle_id').references(() => vehicles.id),
    tripDate: text('trip_date').notNull(), // YYYY-MM-DD (Africa/Cairo)
    morningStartedAt: timestamp('morning_started_at'),
    morningLat: doublePrecision('morning_lat'),
    morningLng: doublePrecision('morning_lng'),
    eveningEndedAt: timestamp('evening_ended_at'),
    eveningLat: doublePrecision('evening_lat'),
    eveningLng: doublePrecision('evening_lng'),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uq_supervisor_trips_sup_date').on(table.supervisorId, table.tripDate),
    index('idx_supervisor_trips_date').on(table.tripDate),
  ]
);

export const supervisorsRelations = relations(supervisors, ({ one, many }) => ({
  user: one(users, { fields: [supervisors.userId], references: [users.id] }),
  school: one(schools, { fields: [supervisors.schoolId], references: [schools.id] }),
  vehicle: one(vehicles, { fields: [supervisors.vehicleId], references: [vehicles.id] }),
  route: one(routes, { fields: [supervisors.routeId], references: [routes.id] }),
  trips: many(supervisorTrips),
}));

export const supervisorTripsRelations = relations(supervisorTrips, ({ one }) => ({
  supervisor: one(supervisors, {
    fields: [supervisorTrips.supervisorId],
    references: [supervisors.id],
  }),
  vehicle: one(vehicles, { fields: [supervisorTrips.vehicleId], references: [vehicles.id] }),
}));

// 23. Chat Channels & Conversations (غرف المحادثة: خطوط السير، الاتصال المباشر، الإعلانات العامة)
export const chatChannels = pgTable(
  'chat_channels',
  {
    id: serial('id').primaryKey(),
    roomKey: text('room_key').notNull().unique(), // e.g. "broadcast", "route_1", "direct_driver_5", "direct_supervisor_2"
    channelType: text('channel_type').notNull().default('route'), // 'broadcast' | 'route' | 'direct'
    title: text('title').notNull(),
    routeId: integer('route_id').references(() => routes.id),
    schoolId: integer('school_id').references(() => schools.id),
    driverId: integer('driver_id').references(() => drivers.id),
    supervisorId: integer('supervisor_id').references(() => supervisors.id),
    lastMessageText: text('last_message_text').default(''),
    lastMessageAt: timestamp('last_message_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_chat_channels_room_key').on(table.roomKey),
    index('idx_chat_channels_route').on(table.routeId),
  ]
);

// 24. Chat Messages (الرسائل: كتابية، رسائل صوتية مسجلة، سجل مكالمات مباشرة، لاسلكي)
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: serial('id').primaryKey(),
    channelId: integer('channel_id').references(() => chatChannels.id, { onDelete: 'cascade' }),
    roomKey: text('room_key').notNull(),
    senderUserId: integer('sender_user_id').references(() => users.id),
    senderRole: text('sender_role').notNull(), // 'super_admin' | 'admin' | 'driver' | 'supervisor'
    senderName: text('sender_name').notNull(),
    senderAvatar: text('sender_avatar').default(''),
    messageType: text('message_type').notNull().default('text'), // 'text' | 'voice_note' | 'call_log' | 'ptt_audio'
    textContent: text('text_content').default(''),
    audioDataUrl: text('audio_data_url'), // base64 or audio file url
    audioDurationSec: integer('audio_duration_sec').default(0),
    isRead: boolean('is_read').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_chat_messages_room').on(table.roomKey),
    index('idx_chat_messages_created').on(table.createdAt),
    index('idx_chat_messages_channel').on(table.channelId),
  ]
);

export const chatChannelsRelations = relations(chatChannels, ({ one, many }) => ({
  route: one(routes, { fields: [chatChannels.routeId], references: [routes.id] }),
  school: one(schools, { fields: [chatChannels.schoolId], references: [schools.id] }),
  driver: one(drivers, { fields: [chatChannels.driverId], references: [drivers.id] }),
  supervisor: one(supervisors, { fields: [chatChannels.supervisorId], references: [supervisors.id] }),
  messages: many(chatMessages),
}));

export const chatMessagesRelations = relations(chatMessages, ({ one }) => ({
  channel: one(chatChannels, { fields: [chatMessages.channelId], references: [chatChannels.id] }),
  senderUser: one(users, { fields: [chatMessages.senderUserId], references: [users.id] }),
}));

// 25. Employee Daily Reports (تقارير الموظفين اليومية الصوتية والكتابية الموجهة للمحاسب والمدير)
export const dailyReports = pgTable(
  'daily_reports',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id),
    employeeId: integer('employee_id').references(() => employees.id, { onDelete: 'set null' }),
    schoolId: integer('school_id').references(() => schools.id),
    employeeName: text('employee_name').notNull(),
    employeeRoleOrTitle: text('employee_role_or_title').default(''),
    reportDate: text('report_date').notNull(), // YYYY-MM-DD
    rawContent: text('raw_content').notNull(),
    audioDataUrl: text('audio_data_url'),
    audioDurationSec: integer('audio_duration_sec').default(0),
    reportType: text('report_type').notNull().default('operations'), // operations | financial | mixed | urgent
    targetAudience: text('target_audience').notNull().default('both'), // both | accountant | manager
    financialAmount: numeric('financial_amount', { precision: 12, scale: 2 }).default('0'),
    extractedTasksJson: jsonb('extracted_tasks_json').$type<string[]>().default([]),
    attachmentsJson: jsonb('attachments_json')
      .$type<
        Array<{
          id: string;
          name: string;
          url: string;
          type: string;
          category?: string;
          sizeKb?: number;
          createdAt?: string;
        }>
      >()
      .default([]),
    category: text('category').default('يومي عام'),
    status: text('status').notNull().default('submitted'), // submitted | reviewed_by_accountant | reviewed_by_manager | approved
    accountantNotes: text('accountant_notes').default(''),
    managerNotes: text('manager_notes').default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_daily_reports_date').on(table.reportDate),
    index('idx_daily_reports_target').on(table.targetAudience),
    index('idx_daily_reports_status').on(table.status),
    index('idx_daily_reports_user').on(table.userId),
    index('idx_daily_reports_school').on(table.schoolId),
  ]
);

export const dailyReportsRelations = relations(dailyReports, ({ one }) => ({
  user: one(users, { fields: [dailyReports.userId], references: [users.id] }),
  employee: one(employees, { fields: [dailyReports.employeeId], references: [employees.id] }),
  school: one(schools, { fields: [dailyReports.schoolId], references: [schools.id] }),
}));



