import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  advances,
  attendance,
  auditLogs,
  coverageRecords,
  drivers,
  financialTransactions,
  notifications,
  salaries,
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
        reason: params.reason || 'سلفة نقدية',
        paymentMethod: params.paymentMethod || 'cash',
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
      description: `سلفة: ${params.reason || 'سلفة نقدية'} (${params.paymentMethod})`,
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
        reason: params.reason || 'تغطية غياب',
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
