import { and, desc, eq, sql } from 'drizzle-orm';
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
} from '../db/schema.ts';

type DbExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

export function getMonthYearFromDate(dateStr: string): { month: number; year: number } {
  const parts = dateStr.split('-');
  if (parts.length >= 2) {
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    if (Number.isFinite(year) && Number.isFinite(month) && month >= 1 && month <= 12) {
      return { month, year };
    }
  }
  const now = new Date();
  return { month: now.getMonth() + 1, year: now.getFullYear() };
}

export async function recalculateDriverSalary(
  tx: DbExecutor,
  driverId: number,
  month: number,
  year: number
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

  // Also calculate from active (non-reversed) advances & coverage records for clear itemized totals
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;

  const activeAdvances = await tx
    .select()
    .from(advances)
    .where(
      and(
        eq(advances.driverId, driverId),
        eq(advances.isReversed, false),
        sql`${advances.date} LIKE ${monthPrefix + '%'}`
      )
    );

  const activeCoverages = await tx
    .select()
    .from(coverageRecords)
    .where(
      and(
        eq(coverageRecords.absentDriverId, driverId),
        eq(coverageRecords.isReversed, false),
        sql`${coverageRecords.date} LIKE ${monthPrefix + '%'}`
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
  year: number
) {
  const [closing] = await tx
    .select({ id: monthlyClosings.id })
    .from(monthlyClosings)
    .where(and(eq(monthlyClosings.month, month), eq(monthlyClosings.year, year)))
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

  return recalculateDriverSalary(tx, driverId, month, year);
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

    const [insertedAdvance] = await tx
      .insert(advances)
      .values({
        driverId: params.driverId,
        amount: params.amount.toFixed(2),
        date: params.date,
        reason: params.reason || '',
        paymentMethod: params.paymentMethod || '',
        notes: params.notes || '',
        recordedByUserId: params.recordedByUserId,
        idempotencyKey: params.idempotencyKey || null,
      })
      .returning();

    const { month, year } = getMonthYearFromDate(params.date);

    await tx.insert(financialTransactions).values({
      driverId: params.driverId,
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

    const salary = await recalculateDriverSalary(tx, params.driverId, month, year);

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

    const [insertedCoverage] = await tx
      .insert(coverageRecords)
      .values({
        absentDriverId: params.absentDriverId,
        replacementDriverId: params.replacementDriverId || null,
        replacementExternalName: params.replacementExternalName || '',
        vehicleId: params.vehicleId || null,
        schoolId: params.schoolId || null,
        date: params.date,
        actualReplacementCost: params.actualReplacementCost.toFixed(2),
        absentDriverDeduction: params.absentDriverDeduction.toFixed(2),
        reason: params.reason || '',
        notes: params.notes || '',
        recordedByUserId: params.recordedByUserId,
        idempotencyKey: params.idempotencyKey || null,
      })
      .returning();

    const { month, year } = getMonthYearFromDate(params.date);

    if (params.absentDriverDeduction > 0) {
      await tx.insert(financialTransactions).values({
        driverId: params.absentDriverId,
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
        date: params.date,
        status: 'covered',
        notes: params.reason || 'تمت التغطية',
        recordedByUserId: params.recordedByUserId,
      })
      .onConflictDoUpdate({
        target: [attendance.driverId, attendance.date],
        set: {
          status: 'covered',
          notes: params.reason || 'تمت التغطية',
          recordedByUserId: params.recordedByUserId,
        },
      });

    const salary = await recalculateDriverSalary(tx, params.absentDriverId, month, year);

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

    const [ledger] = await tx
      .insert(financialTransactions)
      .values({
        driverId: params.driverId,
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

    const salary = await recalculateDriverSalary(tx, params.driverId, params.month, params.year);

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

      const { month, year } = getMonthYearFromDate(adv.date);

      const [rev] = await tx
        .insert(financialTransactions)
        .values({
          driverId: adv.driverId,
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

      const salary = await recalculateDriverSalary(tx, adv.driverId, month, year);

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

      const { month, year } = getMonthYearFromDate(cov.date);

      const [rev] = await tx
        .insert(financialTransactions)
        .values({
          driverId: cov.absentDriverId,
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

      const salary = await recalculateDriverSalary(tx, cov.absentDriverId, month, year);

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

    const oldPeriod = getMonthYearFromDate(existing.date);
    const newPeriod = getMonthYearFromDate(params.date);

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
          amount: params.amount.toFixed(2),
          month: newPeriod.month,
          year: newPeriod.year,
          description,
        })
        .where(eq(financialTransactions.id, existingLedger[0].id));
    } else if (!existing.isReversed) {
      await tx.insert(financialTransactions).values({
        driverId: existing.driverId,
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
      await recalculateDriverSalary(tx, existing.driverId, oldPeriod.month, oldPeriod.year);
    }
    const salary = await recalculateDriverSalary(
      tx,
      existing.driverId,
      newPeriod.month,
      newPeriod.year
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

    const { month, year } = getMonthYearFromDate(existing.date);

    await tx
      .delete(financialTransactions)
      .where(
        and(
          eq(financialTransactions.referenceType, 'advance'),
          eq(financialTransactions.referenceId, params.id)
        )
      );

    await tx.delete(advances).where(eq(advances.id, params.id));

    const salary = await recalculateDriverSalary(tx, existing.driverId, month, year);

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

    const oldPeriod = getMonthYearFromDate(existing.date);
    const newPeriod = getMonthYearFromDate(params.date);

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
            amount: params.absentDriverDeduction.toFixed(2),
            month: newPeriod.month,
            year: newPeriod.year,
            description,
          })
          .where(eq(financialTransactions.id, existingLedger[0].id));
      } else {
        await tx.insert(financialTransactions).values({
          driverId: existing.absentDriverId,
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
      await recalculateDriverSalary(tx, existing.absentDriverId, oldPeriod.month, oldPeriod.year);
    }
    const salary = await recalculateDriverSalary(
      tx,
      existing.absentDriverId,
      newPeriod.month,
      newPeriod.year
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

    const { month, year } = getMonthYearFromDate(existing.date);

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

    const salary = await recalculateDriverSalary(tx, existing.absentDriverId, month, year);

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

export async function getActiveBillingPeriod(): Promise<{ month: number; year: number }> {
  const [row] = await db
    .select()
    .from(billingPeriods)
    .where(eq(billingPeriods.key, ACTIVE_PERIOD_KEY))
    .limit(1);

  if (row && row.activeMonth >= 1 && row.activeMonth <= 12 && row.activeYear >= 2020) {
    return { month: row.activeMonth, year: row.activeYear };
  }
  const now = new Date();
  return { month: now.getMonth() + 1, year: now.getFullYear() };
}

export async function closeMonthAndStartNext(params: {
  month: number;
  year: number;
  markAllPaid?: boolean;
  notes?: string;
  recordedByUserId: number;
  ipAddress?: string;
}) {
  const { month, year } = params;
  if (!Number.isFinite(month) || month < 1 || month > 12 || !Number.isFinite(year) || year < 2020) {
    throw new Error('الشهر أو السنة غير صالحة');
  }

  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;

  return await db.transaction(async (tx) => {
    const activeDrivers = await tx
      .select()
      .from(drivers)
      .where(eq(drivers.accountStatus, 'active'));

    const allSchools = await tx.select().from(schools);
    const schoolById: Record<number, string> = {};
    for (const s of allSchools) schoolById[s.id] = s.name;

    const currentAssignments = await tx
      .select()
      .from(driverAssignments)
      .where(eq(driverAssignments.isCurrent, true));
    const assignmentByDriver: Record<number, number | null> = {};
    for (const a of currentAssignments) assignmentByDriver[a.driverId] = a.schoolId;

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

    for (const d of activeDrivers) {
      let sal = await recalculateDriverSalary(tx, d.id, month, year);
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

      const sId = assignmentByDriver[d.id];
      driverSnapshots.push({
        driverId: d.id,
        driverCode: d.driverCode,
        fullName: d.fullName,
        schoolName: (sId && schoolById[sId]) || 'غير معين',
        baseSalary: base,
        totalAdvances: adv,
        totalCoverageDeductions: cov,
        otherDeductions: oth,
        bonuses: bon,
        netSalary: net,
        status: sal.status,
      });
    }

    const activeEmployees = await tx
      .select()
      .from(employees)
      .where(eq(employees.status, 'active'));

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

    const totalEmployeeSalaries = employeeSnapshots.reduce((s, e) => s + e.netSalary, 0);
    const totalSchoolContracts = allSchools
      .filter((s) => s.isActive)
      .reduce((s, sc) => s + Number(sc.monthlyContractValue || 0), 0);

    const netProfit = totalSchoolContracts - (totalDriverBaseSalaries + totalEmployeeSalaries);

    const [closing] = await tx
      .insert(monthlyClosings)
      .values({
        month,
        year,
        closedByUserId: params.recordedByUserId,
        driversCount: activeDrivers.length,
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
        snapshotJson: { drivers: driverSnapshots, employees: employeeSnapshots },
        closedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [monthlyClosings.month, monthlyClosings.year],
        set: {
          closedByUserId: params.recordedByUserId,
          driversCount: activeDrivers.length,
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
          snapshotJson: { drivers: driverSnapshots, employees: employeeSnapshots },
          closedAt: new Date(),
        },
      })
      .returning();

    // Reset monthly bonuses & deductions for non-driver employees so the new month starts on a clean slate
    if (activeEmployees.length > 0) {
      await tx
        .update(employees)
        .set({ bonuses: '0.00', deductions: '0.00', updatedAt: new Date() })
        .where(eq(employees.status, 'active'));
    }

    // Initialize clean salaries for the new month for every active driver
    for (const d of activeDrivers) {
      await recalculateDriverSalary(tx, d.id, nextMonth, nextYear);
    }

    // Advance active billing period to next month
    await tx
      .insert(billingPeriods)
      .values({
        key: ACTIVE_PERIOD_KEY,
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

    await tx.insert(notifications).values({
      targetRole: 'super_admin',
      type: 'salary',
      title: `تمت تصفية شهر ${month}/${year} وبدء شهر ${nextMonth}/${nextYear}`,
      body: `تم إقفال وتصفية حسابات ${activeDrivers.length} سائق و${activeEmployees.length} موظف وفتح شهر ${nextMonth}/${nextYear} على بياض بنفس السائقين والمركبات والمدارس.`,
    });

    await tx.insert(auditLogs).values({
      actorUserId: params.recordedByUserId,
      action: 'CLOSE_MONTH_AND_ROLLOVER',
      entityType: 'monthly_closings',
      entityId: String(closing.id),
      afterJson: {
        closedPeriod: { month, year },
        nextPeriod: { month: nextMonth, year: nextYear },
        driversCount: activeDrivers.length,
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
  resetEmployees?: boolean;
  recordedByUserId: number;
  ipAddress?: string;
}) {
  const { month, year } = params;
  if (!Number.isFinite(month) || month < 1 || month > 12 || !Number.isFinite(year) || year < 2020) {
    throw new Error('الشهر أو السنة غير صالحة');
  }

  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;

  return await db.transaction(async (tx) => {
    await tx.delete(advances).where(sql`${advances.date} LIKE ${monthPrefix + '%'}`);
    await tx.delete(coverageRecords).where(sql`${coverageRecords.date} LIKE ${monthPrefix + '%'}`);
    await tx
      .delete(financialTransactions)
      .where(and(eq(financialTransactions.month, month), eq(financialTransactions.year, year)));
    await tx
      .delete(attendance)
      .where(and(sql`${attendance.date} LIKE ${monthPrefix + '%'}`, eq(attendance.status, 'covered')));
    await tx
      .delete(monthlyClosings)
      .where(and(eq(monthlyClosings.month, month), eq(monthlyClosings.year, year)));

    if (params.resetEmployees !== false) {
      await tx
        .update(employees)
        .set({ bonuses: '0.00', deductions: '0.00', updatedAt: new Date() })
        .where(eq(employees.status, 'active'));
    }

    const activeDrivers = await tx
      .select()
      .from(drivers)
      .where(eq(drivers.accountStatus, 'active'));

    // Reset salary status to open and recalculate cleanly to zero deductions/advances/bonuses
    await tx
      .update(salaries)
      .set({ status: 'open', updatedAt: new Date() })
      .where(and(eq(salaries.month, month), eq(salaries.year, year)));

    for (const d of activeDrivers) {
      await recalculateDriverSalary(tx, d.id, month, year);
    }

    await tx
      .insert(billingPeriods)
      .values({
        key: ACTIVE_PERIOD_KEY,
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
      entityId: `${year}-${month}`,
      afterJson: {
        month,
        year,
        driversReset: activeDrivers.length,
        resetEmployees: params.resetEmployees !== false,
      },
      ipAddress: params.ipAddress || '',
    });

    return {
      period: { month, year },
      driversReset: activeDrivers.length,
    };
  });
}

export async function getMonthlyClosingsHistory() {
  return db
    .select()
    .from(monthlyClosings)
    .orderBy(desc(monthlyClosings.year), desc(monthlyClosings.month));
}


