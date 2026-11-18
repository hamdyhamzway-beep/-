import { and, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  advances,
  attendance,
  auditLogs,
  billingPeriods,
  coverageRecords,
  driverAssignments,
  drivers,
  employees,
  financialTransactions,
  monthlyClosings,
  notifications,
  salaries,
  schools,
  supervisors,
  supervisorTrips,
} from '../db/schema.ts';
import {
  getBillingDateRangeForPeriod,
  getBillingPeriodForDate,
  getCairoTodayDateString,
  getCurrentBillingRangeForSchool,
  getFinancialPeriodBounds,
  type FinancialPeriodBounds,
  type SchoolBillingConfig,
  type SchoolBillingRange,
} from '../lib/billing-cycle.ts';

type DbExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

export function getMonthYearFromDate(
  dateStr: string,
  school?: SchoolBillingConfig | null
): { month: number; year: number } {
  return getBillingPeriodForDate(dateStr, school);
}

export async function getDriverSchoolBillingConfig(
  tx: DbExecutor,
  driverId: number
): Promise<SchoolBillingConfig | null> {
  const [assignment] = await tx
    .select({ schoolId: driverAssignments.schoolId })
    .from(driverAssignments)
    .where(and(eq(driverAssignments.driverId, driverId), eq(driverAssignments.isCurrent, true)))
    .limit(1);

  if (!assignment?.schoolId) return null;

  const [school] = await tx
    .select({
      id: schools.id,
      name: schools.name,
      billingCycleType: schools.billingCycleType,
      billingCycleStartDay: schools.billingCycleStartDay,
    })
    .from(schools)
    .where(eq(schools.id, assignment.schoolId))
    .limit(1);

  return school || null;
}

export async function getSchoolBillingConfigById(
  tx: DbExecutor,
  schoolId?: number | null
): Promise<SchoolBillingConfig | null> {
  if (!schoolId) return null;
  const [school] = await tx
    .select({
      id: schools.id,
      name: schools.name,
      billingCycleType: schools.billingCycleType,
      billingCycleStartDay: schools.billingCycleStartDay,
    })
    .from(schools)
    .where(eq(schools.id, schoolId))
    .limit(1);
  return school || null;
}

/**
 * GetFinancialPeriod(schoolId, targetMonth, targetYear)
 * Returns exact StartDate (00:00:00) and EndDate (23:59:59) for the given school & period:
 * - "إشراقة الغد" (calendar): Day 1 00:00:00 to last day of targetMonth 23:59:59
 * - "الهلالية" (shifted, startDay=13): Day 13 of previous month 00:00:00 to Day 12 of targetMonth 23:59:59
 */
export async function getFinancialPeriod(
  schoolId: number | null | undefined,
  targetMonth: number,
  targetYear: number,
  tx: DbExecutor = db
): Promise<FinancialPeriodBounds> {
  const schoolCfg = await getSchoolBillingConfigById(tx, schoolId);
  return getFinancialPeriodBounds(schoolCfg, targetMonth, targetYear);
}

export const GetFinancialPeriod = getFinancialPeriod;

export async function recalculateDriverSalary(
  tx: DbExecutor,
  driverId: number,
  month: number,
  year: number,
  schoolConfigOverride?: SchoolBillingConfig | null
) {
  const [driver] = await tx
    .select()
    .from(drivers)
    .where(eq(drivers.id, driverId))
    .limit(1);

  if (!driver) {
    throw new Error('السائق غير موجود');
  }

  const baseSalary = Number(driver.monthlyAgreedSalary || 0);
  const schoolConfig =
    schoolConfigOverride !== undefined
      ? schoolConfigOverride
      : await getDriverSchoolBillingConfig(tx, driverId);
  const range = getBillingDateRangeForPeriod(month, year, schoolConfig);

  // Sum all financial transactions for this driver & period
  const txRows = await tx
    .select()
    .from(financialTransactions)
    .where(
      and(
        eq(financialTransactions.driverId, driverId),
        eq(financialTransactions.month, month),
        eq(financialTransactions.year, year)
      )
    );

  // Filter active advances & coverage records strictly within this driver's school financial cycle [startDate, endDate]
  const activeAdvances = await tx
    .select()
    .from(advances)
    .where(
      and(
        eq(advances.driverId, driverId),
        eq(advances.isReversed, false),
        gte(advances.date, range.startDate),
        lte(advances.date, range.endDate)
      )
    );

  const activeCoverages = await tx
    .select()
    .from(coverageRecords)
    .where(
      and(
        eq(coverageRecords.absentDriverId, driverId),
        eq(coverageRecords.isReversed, false),
        gte(coverageRecords.date, range.startDate),
        lte(coverageRecords.date, range.endDate)
      )
    );

  const totalAdvances = activeAdvances.reduce((sum, a) => sum + Number(a.amount || 0), 0);
  const totalCoverageDeductions = activeCoverages.reduce(
    (sum, c) => sum + Number(c.absentDriverDeduction || 0),
    0
  );

  let otherDeductions = 0;
  let bonuses = 0;

  for (const t of txRows) {
    const amt = Number(t.amount || 0);
    if (t.type === 'other_deduction') {
      otherDeductions += amt;
    } else if (t.type === 'bonus' || t.type === 'salary_adjustment') {
      if (t.direction === 'credit') {
        bonuses += amt;
      } else {
        otherDeductions += amt;
      }
    } else if (t.type === 'reversal' && t.referenceType === 'other_deduction') {
      otherDeductions = Math.max(0, otherDeductions - amt);
    } else if (t.type === 'reversal' && t.referenceType === 'bonus') {
      bonuses = Math.max(0, bonuses - amt);
    }
  }

  // Net Salary = Base Salary - Advances - Coverage Deductions - Other Deductions + Bonuses
  const netSalary =
    baseSalary - totalAdvances - totalCoverageDeductions - otherDeductions + bonuses;

  const [upserted] = await tx
    .insert(salaries)
    .values({
      driverId,
      schoolId: schoolConfig?.id ?? null,
      month,
      year,
      baseSalary: baseSalary.toFixed(2),
      totalAdvances: totalAdvances.toFixed(2),
      totalCoverageDeductions: totalCoverageDeductions.toFixed(2),
      otherDeductions: otherDeductions.toFixed(2),
      bonuses: bonuses.toFixed(2),
      netSalary: netSalary.toFixed(2),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [salaries.driverId, salaries.month, salaries.year],
      set: {
        schoolId: schoolConfig?.id ?? null,
        baseSalary: baseSalary.toFixed(2),
        totalAdvances: totalAdvances.toFixed(2),
        totalCoverageDeductions: totalCoverageDeductions.toFixed(2),
        otherDeductions: otherDeductions.toFixed(2),
        bonuses: bonuses.toFixed(2),
        netSalary: netSalary.toFixed(2),
        updatedAt: new Date(),
      },
    })
    .returning();

  return upserted;
}

export async function getOrRecalculateDriverSalaryForRead(
  tx: DbExecutor,
  driverId: number,
  month: number,
  year: number,
  schoolConfigOverride?: SchoolBillingConfig | null
) {
  const schoolConfig =
    schoolConfigOverride !== undefined
      ? schoolConfigOverride
      : await getDriverSchoolBillingConfig(tx, driverId);

  const closingConditions = schoolConfig?.id
    ? and(
        eq(monthlyClosings.month, month),
        eq(monthlyClosings.year, year),
        sql`(${monthlyClosings.schoolId} IS NULL OR ${monthlyClosings.schoolId} = ${schoolConfig.id})`
      )
    : and(
        eq(monthlyClosings.month, month),
        eq(monthlyClosings.year, year),
        isNull(monthlyClosings.schoolId)
      );

  const [closing] = await tx
    .select({ id: monthlyClosings.id })
    .from(monthlyClosings)
    .where(closingConditions)
    .limit(1);

  if (closing) {
    const [existingSalary] = await tx
      .select()
      .from(salaries)
      .where(
        and(
          eq(salaries.driverId, driverId),
          eq(salaries.month, month),
          eq(salaries.year, year)
        )
      )
      .limit(1);
    if (existingSalary) {
      return existingSalary;
    }
  }

  return recalculateDriverSalary(tx, driverId, month, year, schoolConfig);
}

export async function recordAdvanceTransaction(params: {
  driverId: number;
  amount: number;
  date: string;
  reason: string;
  paymentMethod: string;
  notes?: string;
  recordedByUserId: number;
  idempotencyKey?: string;
  ipAddress?: string;
}) {
  if (!Number.isFinite(params.amount) || params.amount <= 0) {
    throw new Error('قيمة السلفة يجب أن تكون أكبر من صفر');
  }

  return await db.transaction(async (tx) => {
    if (params.idempotencyKey) {
      const existing = await tx
        .select()
        .from(advances)
        .where(eq(advances.idempotencyKey, params.idempotencyKey))
        .limit(1);
      if (existing[0]) {
        return { advance: existing[0], duplicate: true };
      }
    }

    const [driver] = await tx
      .select()
      .from(drivers)
      .where(eq(drivers.id, params.driverId))
      .limit(1);
    if (!driver) throw new Error('لم يتم العثور على السائق');

    const schoolConfig = await getDriverSchoolBillingConfig(tx, params.driverId);

    const [insertedAdvance] = await tx
      .insert(advances)
      .values({
        driverId: params.driverId,
        schoolId: schoolConfig?.id ?? null,
        amount: params.amount.toFixed(2),
        date: params.date,
        reason: params.reason || '',
        paymentMethod: params.paymentMethod || '',
        notes: params.notes || '',
        recordedByUserId: params.recordedByUserId,
        idempotencyKey: params.idempotencyKey || null,
      })
      .returning();

    const { month, year } = getMonthYearFromDate(params.date, schoolConfig);

    await tx.insert(financialTransactions).values({
      driverId: params.driverId,
      schoolId: schoolConfig?.id ?? null,
      month,
      year,
      type: 'advance',
      direction: 'debit',
      amount: params.amount.toFixed(2),
      referenceType: 'advance',
      referenceId: insertedAdvance.id,
      description: `سلفة${params.reason ? `: ${params.reason}` : ''}${params.paymentMethod ? ` (${params.paymentMethod})` : ''}`,
      recordedByUserId: params.recordedByUserId,
    });

    const salary = await recalculateDriverSalary(tx, params.driverId, month, year, schoolConfig);

    await tx.insert(notifications).values({
      recipientDriverId: params.driverId,
      recipientUserId: driver.userId || null,
      type: 'advance',
      title: 'تم تسجيل سلفة جديدة',
      body: `تم تسجيل سلفة بمبلغ ${params.amount.toLocaleString('ar-EG')} ج.م بتاريخ ${params.date}. صافي راتبك الحالي للشهر: ${Number(salary.netSalary).toLocaleString('ar-EG')} ج.م.`,
    });

    await tx.insert(auditLogs).values({
      actorUserId: params.recordedByUserId,
      action: 'CREATE_ADVANCE',
      entityType: 'advances',
      entityId: String(insertedAdvance.id),
      afterJson: insertedAdvance,
      ipAddress: params.ipAddress || '',
    });

    return { advance: insertedAdvance, salary, duplicate: false };
  });
}

export async function recordCoverageTransaction(params: {
  absentDriverId: number;
  replacementDriverId?: number | null;
  replacementExternalName?: string;
  vehicleId?: number | null;
  schoolId?: number | null;
  date: string;
  actualReplacementCost: number;
  absentDriverDeduction: number;
  reason: string;
  notes?: string;
  recordedByUserId: number;
  idempotencyKey?: string;
  ipAddress?: string;
}) {
  if (params.actualReplacementCost < 0 || params.absentDriverDeduction < 0) {
    throw new Error('المبالغ يجب أن تكون موجبة أو صفر');
  }

  return await db.transaction(async (tx) => {
    if (params.idempotencyKey) {
      const existing = await tx
        .select()
        .from(coverageRecords)
        .where(eq(coverageRecords.idempotencyKey, params.idempotencyKey))
        .limit(1);
      if (existing[0]) {
        return { coverage: existing[0], duplicate: true };
      }
    }

    const [absentDriver] = await tx
      .select()
      .from(drivers)
      .where(eq(drivers.id, params.absentDriverId))
      .limit(1);
    if (!absentDriver) throw new Error('السائق الغائب غير موجود');

    const schoolConfig = params.schoolId
      ? await getSchoolBillingConfigById(tx, params.schoolId)
      : await getDriverSchoolBillingConfig(tx, params.absentDriverId);
    const effectiveSchoolId = params.schoolId ?? schoolConfig?.id ?? null;

    const [insertedCoverage] = await tx
      .insert(coverageRecords)
      .values({
        absentDriverId: params.absentDriverId,
        replacementDriverId: params.replacementDriverId || null,
        replacementExternalName: params.replacementExternalName || '',
        vehicleId: params.vehicleId || null,
        schoolId: effectiveSchoolId,
        date: params.date,
        actualReplacementCost: params.actualReplacementCost.toFixed(2),
        absentDriverDeduction: params.absentDriverDeduction.toFixed(2),
        reason: params.reason || '',
        notes: params.notes || '',
        recordedByUserId: params.recordedByUserId,
        idempotencyKey: params.idempotencyKey || null,
      })
      .returning();

    const { month, year } = getMonthYearFromDate(params.date, schoolConfig);

    if (params.absentDriverDeduction > 0) {
      await tx.insert(financialTransactions).values({
        driverId: params.absentDriverId,
        schoolId: effectiveSchoolId,
        month,
        year,
        type: 'coverage_deduction',
        direction: 'debit',
        amount: params.absentDriverDeduction.toFixed(2),
        referenceType: 'coverage',
        referenceId: insertedCoverage.id,
        description: `خصم تغطية غياب بتاريخ ${params.date} — ${params.reason || 'تغطية خط'}`,
        recordedByUserId: params.recordedByUserId,
      });
    }

    // Mark attendance as covered
    await tx
      .insert(attendance)
      .values({
        driverId: params.absentDriverId,
        schoolId: effectiveSchoolId,
        date: params.date,
        status: 'covered',
        notes: params.reason || 'تمت التغطية',
        recordedByUserId: params.recordedByUserId,
      })
      .onConflictDoUpdate({
        target: [attendance.driverId, attendance.date],
        set: {
          schoolId: effectiveSchoolId,
          status: 'covered',
          notes: params.reason || 'تمت التغطية',
          recordedByUserId: params.recordedByUserId,
        },
      });

    const salary = await recalculateDriverSalary(tx, params.absentDriverId, month, year, schoolConfig);

    await tx.insert(notifications).values({
      recipientDriverId: params.absentDriverId,
      recipientUserId: absentDriver.userId || null,
      type: 'coverage',
      title: 'تسجيل تغطية غياب وخصم مستحق',
      body: `تم تسجيل تغطية غياب بتاريخ ${params.date} وخصم ${params.absentDriverDeduction.toLocaleString('ar-EG')} ج.م. صافي راتبك الحالي: ${Number(salary.netSalary).toLocaleString('ar-EG')} ج.م.`,
    });

    await tx.insert(auditLogs).values({
      actorUserId: params.recordedByUserId,
      action: 'CREATE_COVERAGE',
      entityType: 'coverage_records',
      entityId: String(insertedCoverage.id),
      afterJson: insertedCoverage,
      ipAddress: params.ipAddress || '',
    });

    return { coverage: insertedCoverage, salary, duplicate: false };
  });
}

export async function recordAdjustmentTransaction(params: {
  driverId: number;
  month: number;
  year: number;
  type: 'bonus' | 'other_deduction';
  amount: number;
  description: string;
  recordedByUserId: number;
  ipAddress?: string;
}) {
  if (!Number.isFinite(params.amount) || params.amount <= 0) {
    throw new Error('القيمة يجب أن تكون أكبر من صفر');
  }

  return await db.transaction(async (tx) => {
    const [driver] = await tx
      .select()
      .from(drivers)
      .where(eq(drivers.id, params.driverId))
      .limit(1);
    if (!driver) throw new Error('السائق غير موجود');

    const direction = params.type === 'bonus' ? 'credit' : 'debit';
    const schoolConfig = await getDriverSchoolBillingConfig(tx, params.driverId);

    const [ledger] = await tx
      .insert(financialTransactions)
      .values({
        driverId: params.driverId,
        schoolId: schoolConfig?.id ?? null,
        month: params.month,
        year: params.year,
        type: params.type,
        direction,
        amount: params.amount.toFixed(2),
        referenceType: params.type,
        description: params.description,
        recordedByUserId: params.recordedByUserId,
      })
      .returning();

    const salary = await recalculateDriverSalary(
      tx,
      params.driverId,
      params.month,
      params.year,
      schoolConfig
    );

    await tx.insert(notifications).values({
      recipientDriverId: params.driverId,
      recipientUserId: driver.userId || null,
      type: 'salary',
      title: params.type === 'bonus' ? 'تمت إضافة مكافأة مالية' : 'تم تسجيل خصم إداري',
      body: `${params.description} بقيمة ${params.amount.toLocaleString('ar-EG')} ج.م. صافي الراتب المحدث: ${Number(salary.netSalary).toLocaleString('ar-EG')} ج.م.`,
    });

    await tx.insert(auditLogs).values({
      actorUserId: params.recordedByUserId,
      action: params.type === 'bonus' ? 'CREATE_BONUS' : 'CREATE_OTHER_DEDUCTION',
      entityType: 'financial_transactions',
      entityId: String(ledger.id),
      afterJson: ledger,
      ipAddress: params.ipAddress || '',
    });

    return { transaction: ledger, salary };
  });
}

export async function reverseFinancialRecord(params: {
  targetType: 'advance' | 'coverage';
  targetId: number;
  reason: string;
  recordedByUserId: number;
  ipAddress?: string;
}) {
  return await db.transaction(async (tx) => {
    if (params.targetType === 'advance') {
      const [adv] = await tx
        .select()
        .from(advances)
        .where(eq(advances.id, params.targetId))
        .limit(1);
      if (!adv) throw new Error('السلفة غير موجودة');
      if (adv.isReversed) throw new Error('تم عكس هذه السلفة مسبقاً');

      await tx
        .update(advances)
        .set({ isReversed: true })
        .where(eq(advances.id, adv.id));

      const schoolConfig = await getDriverSchoolBillingConfig(tx, adv.driverId);
      const { month, year } = getMonthYearFromDate(adv.date, schoolConfig);

      const [rev] = await tx
        .insert(financialTransactions)
        .values({
          driverId: adv.driverId,
          schoolId: adv.schoolId ?? schoolConfig?.id ?? null,
          month,
          year,
          type: 'reversal',
          direction: 'credit',
          amount: adv.amount,
          referenceType: 'advance',
          referenceId: adv.id,
          description: `عكس سلفة #${adv.id}: ${params.reason || 'تصحيح قيد'}`,
          recordedByUserId: params.recordedByUserId,
        })
        .returning();

      const salary = await recalculateDriverSalary(tx, adv.driverId, month, year, schoolConfig);

      await tx.insert(auditLogs).values({
        actorUserId: params.recordedByUserId,
        action: 'REVERSE_ADVANCE',
        entityType: 'advances',
        entityId: String(adv.id),
        beforeJson: adv,
        afterJson: { isReversed: true, reversalTxId: rev.id },
        ipAddress: params.ipAddress || '',
      });

      return { reversal: rev, salary };
    } else {
      const [cov] = await tx
        .select()
        .from(coverageRecords)
        .where(eq(coverageRecords.id, params.targetId))
        .limit(1);
      if (!cov) throw new Error('سجل التغطية غير موجود');
      if (cov.isReversed) throw new Error('تم عكس سجل التغطية مسبقاً');

      await tx
        .update(coverageRecords)
        .set({ isReversed: true })
        .where(eq(coverageRecords.id, cov.id));

      const schoolConfig = cov.schoolId
        ? await getSchoolBillingConfigById(tx, cov.schoolId)
        : await getDriverSchoolBillingConfig(tx, cov.absentDriverId);
      const { month, year } = getMonthYearFromDate(cov.date, schoolConfig);

      const [rev] = await tx
        .insert(financialTransactions)
        .values({
          driverId: cov.absentDriverId,
          schoolId: cov.schoolId ?? schoolConfig?.id ?? null,
          month,
          year,
          type: 'reversal',
          direction: 'credit',
          amount: cov.absentDriverDeduction,
          referenceType: 'coverage',
          referenceId: cov.id,
          description: `عكس خصم تغطية #${cov.id}: ${params.reason || 'تصحيح قيد'}`,
          recordedByUserId: params.recordedByUserId,
        })
        .returning();

      const salary = await recalculateDriverSalary(tx, cov.absentDriverId, month, year, schoolConfig);

      await tx.insert(auditLogs).values({
        actorUserId: params.recordedByUserId,
        action: 'REVERSE_COVERAGE',
        entityType: 'coverage_records',
        entityId: String(cov.id),
        beforeJson: cov,
        afterJson: { isReversed: true, reversalTxId: rev.id },
        ipAddress: params.ipAddress || '',
      });

      return { reversal: rev, salary };
    }
  });
}

export async function updateAdvanceTransaction(params: {
  id: number;
  amount: number;
  date: string;
  reason: string;
  paymentMethod: string;
  notes?: string;
  recordedByUserId: number;
  ipAddress?: string;
}) {
  if (!Number.isFinite(params.amount) || params.amount <= 0) {
    throw new Error('قيمة السلفة يجب أن تكون أكبر من صفر');
  }

  return await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(advances)
      .where(eq(advances.id, params.id))
      .limit(1);
    if (!existing) throw new Error('السلفة غير موجودة');

    const schoolConfig = await getDriverSchoolBillingConfig(tx, existing.driverId);
    const oldPeriod = getMonthYearFromDate(existing.date, schoolConfig);
    const newPeriod = getMonthYearFromDate(params.date, schoolConfig);

    const [updated] = await tx
      .update(advances)
      .set({
        amount: params.amount.toFixed(2),
        date: params.date,
        reason: params.reason || '',
        paymentMethod: params.paymentMethod || '',
        notes: params.notes || '',
      })
      .where(eq(advances.id, params.id))
      .returning();

    const description = `سلفة${params.reason ? `: ${params.reason}` : ''}${params.paymentMethod ? ` (${params.paymentMethod})` : ''}`;

    const existingLedger = await tx
      .select()
      .from(financialTransactions)
      .where(
        and(
          eq(financialTransactions.referenceType, 'advance'),
          eq(financialTransactions.referenceId, params.id),
          eq(financialTransactions.type, 'advance')
        )
      )
      .limit(1);

    if (existingLedger[0]) {
      await tx
        .update(financialTransactions)
        .set({
          schoolId: existing.schoolId ?? schoolConfig?.id ?? null,
          amount: params.amount.toFixed(2),
          month: newPeriod.month,
          year: newPeriod.year,
          description,
        })
        .where(eq(financialTransactions.id, existingLedger[0].id));
    } else if (!existing.isReversed) {
      await tx.insert(financialTransactions).values({
        driverId: existing.driverId,
        schoolId: existing.schoolId ?? schoolConfig?.id ?? null,
        month: newPeriod.month,
        year: newPeriod.year,
        type: 'advance',
        direction: 'debit',
        amount: params.amount.toFixed(2),
        referenceType: 'advance',
        referenceId: params.id,
        description,
        recordedByUserId: params.recordedByUserId,
      });
    }

    if (oldPeriod.month !== newPeriod.month || oldPeriod.year !== newPeriod.year) {
      await recalculateDriverSalary(tx, existing.driverId, oldPeriod.month, oldPeriod.year, schoolConfig);
    }
    const salary = await recalculateDriverSalary(
      tx,
      existing.driverId,
      newPeriod.month,
      newPeriod.year,
      schoolConfig
    );

    await tx.insert(auditLogs).values({
      actorUserId: params.recordedByUserId,
      action: 'UPDATE_ADVANCE',
      entityType: 'advances',
      entityId: String(params.id),
      beforeJson: existing,
      afterJson: updated,
      ipAddress: params.ipAddress || '',
    });

    return { advance: updated, salary };
  });
}

export async function deleteAdvanceTransaction(params: {
  id: number;
  recordedByUserId: number;
  ipAddress?: string;
}) {
  return await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(advances)
      .where(eq(advances.id, params.id))
      .limit(1);
    if (!existing) throw new Error('السلفة غير موجودة');

    const schoolConfig = await getDriverSchoolBillingConfig(tx, existing.driverId);
    const { month, year } = getMonthYearFromDate(existing.date, schoolConfig);

    await tx
      .delete(financialTransactions)
      .where(
        and(
          eq(financialTransactions.referenceType, 'advance'),
          eq(financialTransactions.referenceId, params.id)
        )
      );

    await tx.delete(advances).where(eq(advances.id, params.id));

    const salary = await recalculateDriverSalary(tx, existing.driverId, month, year, schoolConfig);

    await tx.insert(auditLogs).values({
      actorUserId: params.recordedByUserId,
      action: 'DELETE_ADVANCE',
      entityType: 'advances',
      entityId: String(params.id),
      beforeJson: existing,
      ipAddress: params.ipAddress || '',
    });

    return { deletedId: params.id, salary };
  });
}

export async function updateCoverageTransaction(params: {
  id: number;
  replacementDriverId?: number | null;
  replacementExternalName?: string;
  date: string;
  actualReplacementCost: number;
  absentDriverDeduction: number;
  reason: string;
  notes?: string;
  recordedByUserId: number;
  ipAddress?: string;
}) {
  if (params.actualReplacementCost < 0 || params.absentDriverDeduction < 0) {
    throw new Error('المبالغ يجب أن تكون موجبة أو صفر');
  }

  return await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(coverageRecords)
      .where(eq(coverageRecords.id, params.id))
      .limit(1);
    if (!existing) throw new Error('سجل التغطية غير موجود');

    const schoolConfig = existing.schoolId
      ? await getSchoolBillingConfigById(tx, existing.schoolId)
      : await getDriverSchoolBillingConfig(tx, existing.absentDriverId);
    const oldPeriod = getMonthYearFromDate(existing.date, schoolConfig);
    const newPeriod = getMonthYearFromDate(params.date, schoolConfig);

    const [updated] = await tx
      .update(coverageRecords)
      .set({
        replacementDriverId:
          params.replacementDriverId !== undefined ? params.replacementDriverId : null,
        replacementExternalName: params.replacementExternalName || '',
        date: params.date,
        actualReplacementCost: params.actualReplacementCost.toFixed(2),
        absentDriverDeduction: params.absentDriverDeduction.toFixed(2),
        reason: params.reason || '',
        notes: params.notes || '',
      })
      .where(eq(coverageRecords.id, params.id))
      .returning();

    const existingLedger = await tx
      .select()
      .from(financialTransactions)
      .where(
        and(
          eq(financialTransactions.referenceType, 'coverage'),
          eq(financialTransactions.referenceId, params.id),
          eq(financialTransactions.type, 'coverage_deduction')
        )
      )
      .limit(1);

    const description = `خصم تغطية غياب بتاريخ ${params.date} — ${params.reason || 'تغطية خط'}`;

    if (params.absentDriverDeduction > 0 && !existing.isReversed) {
      if (existingLedger[0]) {
        await tx
          .update(financialTransactions)
          .set({
            schoolId: existing.schoolId ?? schoolConfig?.id ?? null,
            amount: params.absentDriverDeduction.toFixed(2),
            month: newPeriod.month,
            year: newPeriod.year,
            description,
          })
          .where(eq(financialTransactions.id, existingLedger[0].id));
      } else {
        await tx.insert(financialTransactions).values({
          driverId: existing.absentDriverId,
          schoolId: existing.schoolId ?? schoolConfig?.id ?? null,
          month: newPeriod.month,
          year: newPeriod.year,
          type: 'coverage_deduction',
          direction: 'debit',
          amount: params.absentDriverDeduction.toFixed(2),
          referenceType: 'coverage',
          referenceId: params.id,
          description,
          recordedByUserId: params.recordedByUserId,
        });
      }
    } else if (existingLedger[0]) {
      await tx
        .delete(financialTransactions)
        .where(eq(financialTransactions.id, existingLedger[0].id));
    }

    if (oldPeriod.month !== newPeriod.month || oldPeriod.year !== newPeriod.year) {
      await recalculateDriverSalary(
        tx,
        existing.absentDriverId,
        oldPeriod.month,
        oldPeriod.year,
        schoolConfig
      );
    }
    const salary = await recalculateDriverSalary(
      tx,
      existing.absentDriverId,
      newPeriod.month,
      newPeriod.year,
      schoolConfig
    );

    await tx.insert(auditLogs).values({
      actorUserId: params.recordedByUserId,
      action: 'UPDATE_COVERAGE',
      entityType: 'coverage_records',
      entityId: String(params.id),
      beforeJson: existing,
      afterJson: updated,
      ipAddress: params.ipAddress || '',
    });

    return { coverage: updated, salary };
  });
}

export async function deleteCoverageTransaction(params: {
  id: number;
  recordedByUserId: number;
  ipAddress?: string;
}) {
  return await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(coverageRecords)
      .where(eq(coverageRecords.id, params.id))
      .limit(1);
    if (!existing) throw new Error('سجل التغطية غير موجود');

    const schoolConfig = existing.schoolId
      ? await getSchoolBillingConfigById(tx, existing.schoolId)
      : await getDriverSchoolBillingConfig(tx, existing.absentDriverId);
    const { month, year } = getMonthYearFromDate(existing.date, schoolConfig);

    await tx
      .delete(financialTransactions)
      .where(
        and(
          eq(financialTransactions.referenceType, 'coverage'),
          eq(financialTransactions.referenceId, params.id)
        )
      );

    await tx
      .delete(attendance)
      .where(
        and(
          eq(attendance.driverId, existing.absentDriverId),
          eq(attendance.date, existing.date),
          eq(attendance.status, 'covered')
        )
      );

    await tx.delete(coverageRecords).where(eq(coverageRecords.id, params.id));

    const salary = await recalculateDriverSalary(
      tx,
      existing.absentDriverId,
      month,
      year,
      schoolConfig
    );

    await tx.insert(auditLogs).values({
      actorUserId: params.recordedByUserId,
      action: 'DELETE_COVERAGE',
      entityType: 'coverage_records',
      entityId: String(params.id),
      beforeJson: existing,
      ipAddress: params.ipAddress || '',
    });

    return { deletedId: params.id, salary };
  });
}

export async function updateAdjustmentTransaction(params: {
  id: number;
  type: 'bonus' | 'other_deduction';
  amount: number;
  description: string;
  recordedByUserId: number;
  ipAddress?: string;
}) {
  if (!Number.isFinite(params.amount) || params.amount <= 0) {
    throw new Error('القيمة يجب أن تكون أكبر من صفر');
  }

  return await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(financialTransactions)
      .where(eq(financialTransactions.id, params.id))
      .limit(1);
    if (!existing) throw new Error('التسوية المالية غير موجودة');
    if (existing.type !== 'bonus' && existing.type !== 'other_deduction') {
      throw new Error('يمكن تعديل المكافآت والخصومات الإدارية فقط من هنا');
    }

    const direction = params.type === 'bonus' ? 'credit' : 'debit';
    const [updated] = await tx
      .update(financialTransactions)
      .set({
        type: params.type,
        direction,
        amount: params.amount.toFixed(2),
        referenceType: params.type,
        description: params.description.trim() || existing.description,
      })
      .where(eq(financialTransactions.id, params.id))
      .returning();

    const salary = await recalculateDriverSalary(
      tx,
      existing.driverId,
      existing.month,
      existing.year
    );

    await tx.insert(auditLogs).values({
      actorUserId: params.recordedByUserId,
      action: 'UPDATE_ADJUSTMENT',
      entityType: 'financial_transactions',
      entityId: String(params.id),
      beforeJson: existing,
      afterJson: updated,
      ipAddress: params.ipAddress || '',
    });

    return { transaction: updated, salary };
  });
}

export async function deleteAdjustmentTransaction(params: {
  id: number;
  recordedByUserId: number;
  ipAddress?: string;
}) {
  return await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(financialTransactions)
      .where(eq(financialTransactions.id, params.id))
      .limit(1);
    if (!existing) throw new Error('التسوية المالية غير موجودة');
    if (existing.type !== 'bonus' && existing.type !== 'other_deduction') {
      throw new Error('يمكن حذف المكافآت والخصومات الإدارية فقط من هنا');
    }

    await tx.delete(financialTransactions).where(eq(financialTransactions.id, params.id));

    const salary = await recalculateDriverSalary(
      tx,
      existing.driverId,
      existing.month,
      existing.year
    );

    await tx.insert(auditLogs).values({
      actorUserId: params.recordedByUserId,
      action: 'DELETE_ADJUSTMENT',
      entityType: 'financial_transactions',
      entityId: String(params.id),
      beforeJson: existing,
      ipAddress: params.ipAddress || '',
    });

    return { deletedId: params.id, salary };
  });
}

const ACTIVE_PERIOD_KEY = 'active_billing_period';

export function getSchoolBillingPeriodKey(schoolId: number): string {
  return `school_billing_period_${schoolId}`;
}

export async function getActiveBillingPeriod(
  schoolId?: number | null
): Promise<{ month: number; year: number }> {
  if (schoolId) {
    const schoolKey = getSchoolBillingPeriodKey(schoolId);
    const [schoolPeriodRow] = await db
      .select()
      .from(billingPeriods)
      .where(eq(billingPeriods.key, schoolKey))
      .limit(1);
    if (
      schoolPeriodRow &&
      schoolPeriodRow.activeMonth >= 1 &&
      schoolPeriodRow.activeMonth <= 12 &&
      schoolPeriodRow.activeYear >= 2020
    ) {
      return { month: schoolPeriodRow.activeMonth, year: schoolPeriodRow.activeYear };
    }
    const schoolCfg = await getSchoolBillingConfigById(db, schoolId);
    if (schoolCfg) {
      const auto = getCurrentBillingRangeForSchool(schoolCfg);
      return { month: auto.month, year: auto.year };
    }
  }

  const [row] = await db
    .select()
    .from(billingPeriods)
    .where(eq(billingPeriods.key, ACTIVE_PERIOD_KEY))
    .limit(1);

  if (row && row.activeMonth >= 1 && row.activeMonth <= 12 && row.activeYear >= 2020) {
    return { month: row.activeMonth, year: row.activeYear };
  }
  const today = getCairoTodayDateString();
  const [y, m] = today.split('-').map(Number);
  return { month: m || new Date().getMonth() + 1, year: y || new Date().getFullYear() };
}

export interface SupervisorCycleSummary {
  supervisorId: number;
  supervisorCode: string;
  fullName: string;
  phone: string;
  schoolId: number | null;
  schoolName: string;
  monthlySalary: number;
  tripsCount: number;
  morningTripsCount: number;
  eveningTripsCount: number;
  completedDaysCount: number;
  billingRange: SchoolBillingRange;
  accountStatus: string;
}

export async function getSupervisorCycleSummaries(params: {
  month: number;
  year: number;
  schoolId?: number | null;
  allowedSchoolIds?: number[] | null;
}): Promise<SupervisorCycleSummary[]> {
  const { month, year, schoolId, allowedSchoolIds } = params;
  const [allSups, allSchools] = await Promise.all([
    db.select().from(supervisors).orderBy(supervisors.fullName),
    db.select().from(schools),
  ]);

  const schoolMap: Record<number, (typeof allSchools)[number]> = {};
  for (const s of allSchools) schoolMap[s.id] = s;

  const scopedSups = allSups.filter((sup) => {
    if (schoolId && sup.schoolId !== schoolId) return false;
    if (allowedSchoolIds && allowedSchoolIds.length > 0) {
      return sup.schoolId !== null && allowedSchoolIds.includes(sup.schoolId);
    }
    return true;
  });

  if (scopedSups.length === 0) return [];

  // Determine widest date bounds across involved schools to fetch trips in one query
  let minStart = '9999-12-31';
  let maxEnd = '0000-01-01';
  const rangeBySchoolId = new Map<number | 'none', SchoolBillingRange>();
  rangeBySchoolId.set('none', getBillingDateRangeForPeriod(month, year, null));

  for (const sup of scopedSups) {
    const key = sup.schoolId ?? 'none';
    if (!rangeBySchoolId.has(key)) {
      const sc = sup.schoolId ? schoolMap[sup.schoolId] : null;
      rangeBySchoolId.set(key, getBillingDateRangeForPeriod(month, year, sc));
    }
    const r = rangeBySchoolId.get(key)!;
    if (r.startDate < minStart) minStart = r.startDate;
    if (r.endDate > maxEnd) maxEnd = r.endDate;
  }

  const supIds = scopedSups.map((s) => s.id);
  const tripsInWindow = await db
    .select()
    .from(supervisorTrips)
    .where(
      and(
        inArray(supervisorTrips.supervisorId, supIds),
        gte(supervisorTrips.tripDate, minStart),
        lte(supervisorTrips.tripDate, maxEnd)
      )
    );

  const tripsBySup = new Map<number, typeof tripsInWindow>();
  for (const t of tripsInWindow) {
    const list = tripsBySup.get(t.supervisorId) || [];
    list.push(t);
    tripsBySup.set(t.supervisorId, list);
  }

  return scopedSups.map((sup) => {
    const sc = sup.schoolId ? schoolMap[sup.schoolId] : null;
    const range = rangeBySchoolId.get(sup.schoolId ?? 'none')!;
    const rawTrips = tripsBySup.get(sup.id) || [];
    const cycleTrips = rawTrips.filter(
      (t) => t.tripDate >= range.startDate && t.tripDate <= range.endDate
    );

    const morningTripsCount = cycleTrips.filter((t) => Boolean(t.morningStartedAt)).length;
    const eveningTripsCount = cycleTrips.filter((t) => Boolean(t.eveningEndedAt)).length;
    const completedDaysCount = cycleTrips.filter(
      (t) => Boolean(t.morningStartedAt) && Boolean(t.eveningEndedAt)
    ).length;

    return {
      supervisorId: sup.id,
      supervisorCode: sup.supervisorCode,
      fullName: sup.fullName,
      phone: sup.phone,
      schoolId: sup.schoolId ?? null,
      schoolName: sc?.name || 'غير معين',
      monthlySalary: Number(sup.monthlySalary || 0),
      tripsCount: morningTripsCount + eveningTripsCount,
      morningTripsCount,
      eveningTripsCount,
      completedDaysCount,
      billingRange: range,
      accountStatus: sup.accountStatus,
    };
  });
}

export async function closeMonthAndStartNext(params: {
  month: number;
  year: number;
  schoolId?: number | null;
  markAllPaid?: boolean;
  notes?: string;
  recordedByUserId: number;
  ipAddress?: string;
}) {
  const { month, year, schoolId } = params;
  if (!Number.isFinite(month) || month < 1 || month > 12 || !Number.isFinite(year) || year < 2020) {
    throw new Error('الشهر أو السنة غير صالحة');
  }

  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;

  return await db.transaction(async (tx) => {
    const allSchools = await tx.select().from(schools);
    const schoolById: Record<number, (typeof allSchools)[number]> = {};
    for (const s of allSchools) schoolById[s.id] = s;

    const targetSchool = schoolId ? schoolById[schoolId] || null : null;
    if (schoolId && !targetSchool) {
      throw new Error('المدرسة المحددة غير موجودة');
    }

    const activeDrivers = await tx
      .select()
      .from(drivers)
      .where(eq(drivers.accountStatus, 'active'));

    const currentAssignments = await tx
      .select()
      .from(driverAssignments)
      .where(eq(driverAssignments.isCurrent, true));
    const assignmentByDriver: Record<number, number | null> = {};
    for (const a of currentAssignments) assignmentByDriver[a.driverId] = a.schoolId;

    const targetDrivers = schoolId
      ? activeDrivers.filter((d) => assignmentByDriver[d.id] === schoolId)
      : activeDrivers;

    const driverSnapshots: Array<{
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
    }> = [];

    let totalDriverBaseSalaries = 0;
    let totalDriverNetSalaries = 0;
    let totalAdvances = 0;
    let totalCoverageDeductions = 0;
    let totalBonuses = 0;
    let totalOtherDeductions = 0;

    for (const d of targetDrivers) {
      const drvSchoolId = assignmentByDriver[d.id];
      const drvSchool = drvSchoolId ? schoolById[drvSchoolId] || null : null;
      let sal = await recalculateDriverSalary(tx, d.id, month, year, drvSchool);
      if (params.markAllPaid !== false && sal.status !== 'paid') {
        const [paidRow] = await tx
          .update(salaries)
          .set({ status: 'paid', updatedAt: new Date() })
          .where(eq(salaries.id, sal.id))
          .returning();
        if (paidRow) sal = paidRow;
      }

      const base = Number(sal.baseSalary || 0);
      const adv = Number(sal.totalAdvances || 0);
      const cov = Number(sal.totalCoverageDeductions || 0);
      const oth = Number(sal.otherDeductions || 0);
      const bon = Number(sal.bonuses || 0);
      const net = Number(sal.netSalary || 0);

      totalDriverBaseSalaries += base;
      totalDriverNetSalaries += net;
      totalAdvances += adv;
      totalCoverageDeductions += cov;
      totalBonuses += bon;
      totalOtherDeductions += oth;

      driverSnapshots.push({
        driverId: d.id,
        driverCode: d.driverCode,
        fullName: d.fullName,
        schoolName: drvSchool?.name || 'غير معين',
        baseSalary: base,
        totalAdvances: adv,
        totalCoverageDeductions: cov,
        otherDeductions: oth,
        bonuses: bon,
        netSalary: net,
        status: sal.status,
      });
    }

    const activeEmployees = schoolId
      ? await tx
          .select()
          .from(employees)
          .where(and(eq(employees.status, 'active'), eq(employees.schoolId, schoolId)))
      : await tx.select().from(employees).where(eq(employees.status, 'active'));

    const employeeSnapshots = activeEmployees.map((e) => {
      const base = Number(e.monthlySalary || 0);
      const bon = Number(e.bonuses || 0);
      const ded = Number(e.deductions || 0);
      const net = Math.max(0, base + bon - ded);
      return {
        employeeId: e.id,
        employeeCode: e.employeeCode || '',
        fullName: e.fullName,
        jobTitle: e.jobTitle || '',
        monthlySalary: base,
        bonuses: bon,
        deductions: ded,
        netSalary: net,
      };
    });

    // Supervisor snapshots scoped to targetSchool (or all schools) within exact school cycle dates
    const allSupervisors = await tx
      .select()
      .from(supervisors)
      .where(
        schoolId
          ? and(eq(supervisors.accountStatus, 'active'), eq(supervisors.schoolId, schoolId))
          : eq(supervisors.accountStatus, 'active')
      );

    const supervisorSnapshots: Array<{
      supervisorId: number;
      supervisorCode: string;
      fullName: string;
      schoolName: string;
      tripsCount: number;
      monthlySalary: number;
    }> = [];

    for (const sup of allSupervisors) {
      const supSchool = sup.schoolId ? schoolById[sup.schoolId] || null : null;
      const supRange = getBillingDateRangeForPeriod(month, year, supSchool);
      const supTrips = await tx
        .select()
        .from(supervisorTrips)
        .where(
          and(
            eq(supervisorTrips.supervisorId, sup.id),
            gte(supervisorTrips.tripDate, supRange.startDate),
            lte(supervisorTrips.tripDate, supRange.endDate)
          )
        );
      const tripsCount = supTrips.reduce(
        (cnt, t) => cnt + (t.morningStartedAt ? 1 : 0) + (t.eveningEndedAt ? 1 : 0),
        0
      );
      supervisorSnapshots.push({
        supervisorId: sup.id,
        supervisorCode: sup.supervisorCode,
        fullName: sup.fullName,
        schoolName: supSchool?.name || 'غير معين',
        tripsCount,
        monthlySalary: Number(sup.monthlySalary || 0),
      });
    }

    const totalEmployeeSalaries = employeeSnapshots.reduce((s, e) => s + e.netSalary, 0);
    const totalSupervisorSalaries = supervisorSnapshots.reduce((s, sup) => s + sup.monthlySalary, 0);
    const totalSchoolContracts = targetSchool
      ? targetSchool.isActive
        ? Number(targetSchool.monthlyContractValue || 0)
        : 0
      : allSchools
          .filter((s) => s.isActive)
          .reduce((s, sc) => s + Number(sc.monthlyContractValue || 0), 0);

    const netProfit =
      totalSchoolContracts - (totalDriverBaseSalaries + totalEmployeeSalaries + totalSupervisorSalaries);

    const targetRange = getBillingDateRangeForPeriod(month, year, targetSchool);

    const existingClosingRows = await tx
      .select()
      .from(monthlyClosings)
      .where(
        targetSchool
          ? and(
              eq(monthlyClosings.month, month),
              eq(monthlyClosings.year, year),
              eq(monthlyClosings.schoolId, targetSchool.id)
            )
          : and(
              eq(monthlyClosings.month, month),
              eq(monthlyClosings.year, year),
              isNull(monthlyClosings.schoolId)
            )
      )
      .limit(1);

    const closingPayload = {
      month,
      year,
      schoolId: targetSchool?.id ?? null,
      schoolName: targetSchool?.name || 'جميع المدارس (تصفية شاملة)',
      cycleStartDate: targetRange.startDate,
      cycleEndDate: targetRange.endDate,
      closedByUserId: params.recordedByUserId,
      driversCount: targetDrivers.length,
      employeesCount: activeEmployees.length,
      totalDriverSalaries: totalDriverNetSalaries.toFixed(2),
      totalEmployeeSalaries: totalEmployeeSalaries.toFixed(2),
      totalAdvances: totalAdvances.toFixed(2),
      totalCoverageDeductions: totalCoverageDeductions.toFixed(2),
      totalBonuses: totalBonuses.toFixed(2),
      totalOtherDeductions: totalOtherDeductions.toFixed(2),
      totalSchoolContracts: totalSchoolContracts.toFixed(2),
      netProfit: netProfit.toFixed(2),
      notes: params.notes || '',
      snapshotJson: {
        drivers: driverSnapshots,
        employees: employeeSnapshots,
        supervisors: supervisorSnapshots,
      },
      closedAt: new Date(),
    };

    const [closing] = existingClosingRows[0]
      ? await tx
          .update(monthlyClosings)
          .set(closingPayload)
          .where(eq(monthlyClosings.id, existingClosingRows[0].id))
          .returning()
      : await tx.insert(monthlyClosings).values(closingPayload).returning();

    // Reset monthly bonuses & deductions for active non-driver employees within this closing scope
    if (activeEmployees.length > 0) {
      await tx
        .update(employees)
        .set({ bonuses: '0.00', deductions: '0.00', updatedAt: new Date() })
        .where(
          targetSchool
            ? and(eq(employees.status, 'active'), eq(employees.schoolId, targetSchool.id))
            : eq(employees.status, 'active')
        );
    }

    // Initialize clean salaries for the new month for target drivers
    for (const d of targetDrivers) {
      const drvSchoolId = assignmentByDriver[d.id];
      const drvSchool = drvSchoolId ? schoolById[drvSchoolId] || null : null;
      await recalculateDriverSalary(tx, d.id, nextMonth, nextYear, drvSchool);
    }

    // Advance active billing period for the school (or global)
    const periodKey = targetSchool ? getSchoolBillingPeriodKey(targetSchool.id) : ACTIVE_PERIOD_KEY;
    await tx
      .insert(billingPeriods)
      .values({
        key: periodKey,
        activeMonth: nextMonth,
        activeYear: nextYear,
        updatedByUserId: params.recordedByUserId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: billingPeriods.key,
        set: {
          activeMonth: nextMonth,
          activeYear: nextYear,
          updatedByUserId: params.recordedByUserId,
          updatedAt: new Date(),
        },
      });

    const scopeLabel = targetSchool ? `للمدرسة: ${targetSchool.name}` : 'لجميع المدارس';
    await tx.insert(notifications).values({
      targetRole: 'super_admin',
      type: 'salary',
      title: `تمت تصفية دورة ${month}/${year} (${targetSchool?.name || 'شامل'}) وبدء دورة ${nextMonth}/${nextYear}`,
      body: `تم إقفال حسابات ${targetDrivers.length} سائق و${supervisorSnapshots.length} مشرف ${scopeLabel} عن الفترة (${targetRange.startDate} → ${targetRange.endDate}).`,
    });

    await tx.insert(auditLogs).values({
      actorUserId: params.recordedByUserId,
      action: 'CLOSE_MONTH_AND_ROLLOVER',
      entityType: 'monthly_closings',
      entityId: String(closing.id),
      afterJson: {
        closedPeriod: { month, year, schoolId: targetSchool?.id ?? null },
        nextPeriod: { month: nextMonth, year: nextYear },
        cycleRange: { startDate: targetRange.startDate, endDate: targetRange.endDate },
        driversCount: targetDrivers.length,
        supervisorsCount: supervisorSnapshots.length,
        employeesCount: activeEmployees.length,
        totalDriverNetSalaries,
        totalEmployeeSalaries,
        netProfit,
      },
      ipAddress: params.ipAddress || '',
    });

    return {
      closing,
      nextPeriod: { month: nextMonth, year: nextYear },
    };
  });
}

export async function resetMonthFinancials(params: {
  month: number;
  year: number;
  schoolId?: number | null;
  resetEmployees?: boolean;
  recordedByUserId: number;
  ipAddress?: string;
}) {
  const { month, year, schoolId } = params;
  if (!Number.isFinite(month) || month < 1 || month > 12 || !Number.isFinite(year) || year < 2020) {
    throw new Error('الشهر أو السنة غير صالحة');
  }

  return await db.transaction(async (tx) => {
    const allSchools = await tx.select().from(schools);
    const schoolById: Record<number, (typeof allSchools)[number]> = {};
    for (const s of allSchools) schoolById[s.id] = s;

    const targetSchool = schoolId ? schoolById[schoolId] || null : null;
    if (schoolId && !targetSchool) {
      throw new Error('المدرسة المحددة غير موجودة');
    }

    const activeDrivers = await tx
      .select()
      .from(drivers)
      .where(eq(drivers.accountStatus, 'active'));

    const currentAssignments = await tx
      .select()
      .from(driverAssignments)
      .where(eq(driverAssignments.isCurrent, true));
    const assignmentByDriver: Record<number, number | null> = {};
    for (const a of currentAssignments) assignmentByDriver[a.driverId] = a.schoolId;

    const targetDrivers = schoolId
      ? activeDrivers.filter((d) => assignmentByDriver[d.id] === schoolId)
      : activeDrivers;

    for (const d of targetDrivers) {
      const drvSchoolId = assignmentByDriver[d.id];
      const drvSchool = drvSchoolId ? schoolById[drvSchoolId] || null : null;
      const range = getBillingDateRangeForPeriod(month, year, drvSchool);

      await tx
        .delete(advances)
        .where(
          and(
            eq(advances.driverId, d.id),
            gte(advances.date, range.startDate),
            lte(advances.date, range.endDate)
          )
        );
      await tx
        .delete(coverageRecords)
        .where(
          and(
            eq(coverageRecords.absentDriverId, d.id),
            gte(coverageRecords.date, range.startDate),
            lte(coverageRecords.date, range.endDate)
          )
        );
      await tx
        .delete(financialTransactions)
        .where(
          and(
            eq(financialTransactions.driverId, d.id),
            eq(financialTransactions.month, month),
            eq(financialTransactions.year, year)
          )
        );
      await tx
        .delete(attendance)
        .where(
          and(
            eq(attendance.driverId, d.id),
            gte(attendance.date, range.startDate),
            lte(attendance.date, range.endDate),
            eq(attendance.status, 'covered')
          )
        );
      await tx
        .update(salaries)
        .set({ status: 'open', updatedAt: new Date() })
        .where(
          and(
            eq(salaries.driverId, d.id),
            eq(salaries.month, month),
            eq(salaries.year, year)
          )
        );
      await recalculateDriverSalary(tx, d.id, month, year, drvSchool);
    }

    if (targetSchool) {
      await tx
        .delete(monthlyClosings)
        .where(
          and(
            eq(monthlyClosings.month, month),
            eq(monthlyClosings.year, year),
            eq(monthlyClosings.schoolId, targetSchool.id)
          )
        );
    } else {
      await tx
        .delete(monthlyClosings)
        .where(and(eq(monthlyClosings.month, month), eq(monthlyClosings.year, year)));
    }

    if (params.resetEmployees !== false) {
      await tx
        .update(employees)
        .set({ bonuses: '0.00', deductions: '0.00', updatedAt: new Date() })
        .where(
          targetSchool
            ? and(eq(employees.status, 'active'), eq(employees.schoolId, targetSchool.id))
            : eq(employees.status, 'active')
        );
    }

    const periodKey = targetSchool ? getSchoolBillingPeriodKey(targetSchool.id) : ACTIVE_PERIOD_KEY;
    await tx
      .insert(billingPeriods)
      .values({
        key: periodKey,
        activeMonth: month,
        activeYear: year,
        updatedByUserId: params.recordedByUserId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: billingPeriods.key,
        set: {
          activeMonth: month,
          activeYear: year,
          updatedByUserId: params.recordedByUserId,
          updatedAt: new Date(),
        },
      });

    await tx.insert(auditLogs).values({
      actorUserId: params.recordedByUserId,
      action: 'RESET_MONTH_FINANCIALS',
      entityType: 'salaries',
      entityId: `${year}-${month}${targetSchool ? `-school-${targetSchool.id}` : ''}`,
      afterJson: {
        month,
        year,
        schoolId: targetSchool?.id ?? null,
        driversReset: targetDrivers.length,
        resetEmployees: params.resetEmployees !== false,
      },
      ipAddress: params.ipAddress || '',
    });

    return {
      period: { month, year },
      schoolId: targetSchool?.id ?? null,
      driversReset: targetDrivers.length,
    };
  });
}

export async function getMonthlyClosingsHistory() {
  return db
    .select()
    .from(monthlyClosings)
    .orderBy(desc(monthlyClosings.year), desc(monthlyClosings.month), desc(monthlyClosings.closedAt));
}



