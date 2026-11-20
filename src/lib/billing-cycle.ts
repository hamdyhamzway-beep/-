export type BillingCycleType = 'calendar' | 'shifted';

export interface SchoolBillingConfig {
  id?: number | null;
  name?: string | null;
  billingCycleType?: string | null;
  billingCycleStartDay?: number | null;
  billingCycleEndDay?: number | null;
  customStartDate?: string | null;
  customEndDate?: string | null;
}

export interface ResolvedBillingRule {
  cycleType: BillingCycleType;
  startDay: number;
  endDay: number;
  customStartDate?: string | null;
  customEndDate?: string | null;
}

export interface SchoolBillingRange {
  month: number;
  year: number;
  startDate: string; // YYYY-MM-DD inclusive
  endDate: string; // YYYY-MM-DD inclusive
  startDateTime: string; // YYYY-MM-DD 00:00:00
  endDateTime: string; // YYYY-MM-DD 23:59:59 (11:59 PM)
  startAtIso: string; // ISO-8601 Cairo start timestamp
  endAtIso: string; // ISO-8601 Cairo end timestamp
  cycleType: BillingCycleType;
  startDay: number;
  endDay: number;
  labelAr: string;
  shortLabelAr: string;
}

export interface FinancialPeriodBounds extends SchoolBillingRange {
  schoolId: number | null;
  schoolName: string | null;
  startAt: Date;
  endAt: Date;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function normalizeArabicNameForCycle(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/\s+/g, ' ');
}

export function getCairoTodayDateString(): string {
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

export function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Resolves the financial cycle rule for a school.
 * - "مدرسة إشراقة الغد" (or default): calendar month (day 1 00:00 to last day 23:59:59)
 * - "مدرسة الهلالية" (or any school configured with shifted / startDay > 1):
 *   day 13 of previous month 00:00 to day 12 of target month 23:59:59
 */
export function resolveSchoolBillingRule(school?: SchoolBillingConfig | null): ResolvedBillingRule {
  const rawType = school?.billingCycleType;
  const rawStartDay = Number(school?.billingCycleStartDay || 0);
  const rawEndDay = Number(school?.billingCycleEndDay || 0);
  const customStartDate = school?.customStartDate?.trim() || null;
  const customEndDate = school?.customEndDate?.trim() || null;

  if (rawType === 'shifted' || (Number.isFinite(rawStartDay) && rawStartDay > 1 && rawStartDay <= 31)) {
    const safeStartDay =
      Number.isFinite(rawStartDay) && rawStartDay >= 1 && rawStartDay <= 31
        ? Math.floor(rawStartDay)
        : 13;
    const safeEndDay =
      Number.isFinite(rawEndDay) && rawEndDay >= 1 && rawEndDay <= 31
        ? Math.floor(rawEndDay)
        : safeStartDay === 1
        ? 30
        : safeStartDay - 1;
    return {
      cycleType: 'shifted',
      startDay: safeStartDay,
      endDay: safeEndDay,
      customStartDate,
      customEndDate,
    };
  }

  if (rawType === 'calendar' && rawStartDay === 1) {
    const safeEndDay =
      Number.isFinite(rawEndDay) && rawEndDay >= 1 && rawEndDay <= 31
        ? Math.floor(rawEndDay)
        : 31;
    return {
      cycleType: 'calendar',
      startDay: 1,
      endDay: safeEndDay,
      customStartDate,
      customEndDate,
    };
  }

  // Smart fallback by school name if DB column was not yet explicitly configured
  const normName = normalizeArabicNameForCycle(school?.name || '');
  if (normName.includes('الهلالي') || normName.includes('hilal')) {
    return {
      cycleType: 'shifted',
      startDay: 13,
      endDay: 12,
      customStartDate,
      customEndDate,
    };
  }

  return {
    cycleType: 'calendar',
    startDay: 1,
    endDay: 31,
    customStartDate,
    customEndDate,
  };
}

/**
 * Given a target billing period (month, year) and a school's billing rule,
 * returns the exact inclusive [StartDate 00:00:00, EndDate 23:59:59] range.
 */
export function getBillingDateRangeForPeriod(
  month: number,
  year: number,
  school?: SchoolBillingConfig | null
): SchoolBillingRange {
  const safeMonth = Math.min(12, Math.max(1, Math.floor(month) || 1));
  const safeYear = Math.min(2099, Math.max(2020, Math.floor(year) || new Date().getFullYear()));
  const rule = resolveSchoolBillingRule(school);

  // If a custom period override exists for this school
  if (
    rule.customStartDate &&
    rule.customEndDate &&
    /^\d{4}-\d{2}-\d{2}$/.test(rule.customStartDate) &&
    /^\d{4}-\d{2}-\d{2}$/.test(rule.customEndDate)
  ) {
    const sDate = rule.customStartDate;
    const eDate = rule.customEndDate;
    return {
      month: safeMonth,
      year: safeYear,
      startDate: sDate,
      endDate: eDate,
      startDateTime: `${sDate} 00:00:00`,
      endDateTime: `${eDate} 23:59:59`,
      startAtIso: `${sDate}T00:00:00.000+02:00`,
      endAtIso: `${eDate}T23:59:59.999+02:00`,
      cycleType: rule.cycleType,
      startDay: Number(sDate.slice(8)) || 1,
      endDay: Number(eDate.slice(8)) || 30,
      labelAr: `فترة مخصصة: من ${sDate} إلى ${eDate} (11:59 م)`,
      shortLabelAr: `${sDate.slice(5)} → ${eDate.slice(5)}`,
    };
  }

  if (rule.cycleType === 'calendar' || rule.startDay <= 1) {
    const monthDays = getDaysInMonth(safeYear, safeMonth);
    const lastDay = Math.min(monthDays, rule.endDay && rule.endDay >= 1 ? rule.endDay : monthDays);
    const startDate = `${safeYear}-${pad2(safeMonth)}-01`;
    const endDate = `${safeYear}-${pad2(safeMonth)}-${pad2(lastDay)}`;
    return {
      month: safeMonth,
      year: safeYear,
      startDate,
      endDate,
      startDateTime: `${startDate} 00:00:00`,
      endDateTime: `${endDate} 23:59:59`,
      startAtIso: `${startDate}T00:00:00.000+02:00`,
      endAtIso: `${endDate}T23:59:59.999+02:00`,
      cycleType: 'calendar',
      startDay: 1,
      endDay: lastDay,
      labelAr: `دورة ميلادية: من ${startDate} إلى ${endDate} (يوم 1 إلى ${lastDay} · 11:59 م)`,
      shortLabelAr: `1/${safeMonth} → ${lastDay}/${safeMonth}`,
    };
  }

  const startDay = rule.startDay;
  const endDay = rule.endDay;

  if (startDay > endDay) {
    // Standard shifted cycle (e.g. 13 of previous month to 12 of target month)
    const prevMonth = safeMonth === 1 ? 12 : safeMonth - 1;
    const prevYear = safeMonth === 1 ? safeYear - 1 : safeYear;

    const prevMonthDays = getDaysInMonth(prevYear, prevMonth);
    const clampedStartDay = Math.min(startDay, prevMonthDays);
    const currMonthDays = getDaysInMonth(safeYear, safeMonth);
    const clampedEndDay = Math.min(endDay, currMonthDays);

    const startDate = `${prevYear}-${pad2(prevMonth)}-${pad2(clampedStartDay)}`;
    const endDate = `${safeYear}-${pad2(safeMonth)}-${pad2(clampedEndDay)}`;

    return {
      month: safeMonth,
      year: safeYear,
      startDate,
      endDate,
      startDateTime: `${startDate} 00:00:00`,
      endDateTime: `${endDate} 23:59:59`,
      startAtIso: `${startDate}T00:00:00.000+02:00`,
      endAtIso: `${endDate}T23:59:59.999+02:00`,
      cycleType: 'shifted',
      startDay: clampedStartDay,
      endDay: clampedEndDay,
      labelAr: `دورة مرحّلة: من ${startDate} إلى ${endDate} (${clampedStartDay}/${prevMonth} ← ${clampedEndDay}/${safeMonth} · 11:59 م)`,
      shortLabelAr: `${clampedStartDay}/${prevMonth} → ${clampedEndDay}/${safeMonth}`,
    };
  }

  // Same-month custom range (e.g. day 1 to day 20, or day 5 to day 25)
  const currMonthDays = getDaysInMonth(safeYear, safeMonth);
  const clampedStartDay = Math.min(startDay, currMonthDays);
  const clampedEndDay = Math.min(endDay, currMonthDays);

  const startDate = `${safeYear}-${pad2(safeMonth)}-${pad2(clampedStartDay)}`;
  const endDate = `${safeYear}-${pad2(safeMonth)}-${pad2(clampedEndDay)}`;

  return {
    month: safeMonth,
    year: safeYear,
    startDate,
    endDate,
    startDateTime: `${startDate} 00:00:00`,
    endDateTime: `${endDate} 23:59:59`,
    startAtIso: `${startDate}T00:00:00.000+02:00`,
    endAtIso: `${endDate}T23:59:59.999+02:00`,
    cycleType: 'shifted',
    startDay: clampedStartDay,
    endDay: clampedEndDay,
    labelAr: `دورة مخصصة: من ${startDate} إلى ${endDate} (يوم ${clampedStartDay} إلى ${clampedEndDay} · 11:59 م)`,
    shortLabelAr: `${clampedStartDay}/${safeMonth} → ${clampedEndDay}/${safeMonth}`,
  };
}

/**
 * Pure helper returning StartDate / EndDate (with 00:00:00 and 23:59:59 Date objects)
 * for a given school config, targetMonth, and targetYear.
 */
export function getFinancialPeriodBounds(
  school: SchoolBillingConfig | null | undefined,
  targetMonth: number,
  targetYear: number
): FinancialPeriodBounds {
  const range = getBillingDateRangeForPeriod(targetMonth, targetYear, school);
  return {
    ...range,
    schoolId: school?.id ?? null,
    schoolName: school?.name ?? null,
    startAt: new Date(range.startAtIso),
    endAt: new Date(range.endAtIso),
  };
}

/**
 * Given a transaction or trip date (YYYY-MM-DD) and a school's billing rule,
 * returns the canonical (month, year) billing period that this date belongs to.
 */
export function getBillingPeriodForDate(
  dateStr: string,
  school?: SchoolBillingConfig | null
): { month: number; year: number } {
  const rule = resolveSchoolBillingRule(school);
  const parts = String(dateStr || '').trim().split('-');
  let year = Number(parts[0]);
  let month = Number(parts[1]);
  let day = Number(parts[2]);

  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    const todayParts = getCairoTodayDateString().split('-');
    year = Number(todayParts[0]);
    month = Number(todayParts[1]);
    day = Number(todayParts[2]);
  }
  if (!Number.isFinite(day) || day < 1 || day > 31) {
    day = 1;
  }

  // If a custom date range is set and date falls within it, return the period of the override
  if (rule.customStartDate && rule.customEndDate && isDateInRange(dateStr, rule.customStartDate, rule.customEndDate)) {
    return { month, year };
  }

  if (rule.cycleType === 'calendar' || rule.startDay <= 1) {
    return { month, year };
  }

  if (rule.startDay > rule.endDay) {
    // Day >= startDay (e.g. 13..31) belongs to NEXT month's shifted period (13 current -> 12 next)
    if (day >= rule.startDay) {
      if (month === 12) {
        return { month: 1, year: year + 1 };
      }
      return { month: month + 1, year };
    }

    // Day <= endDay (e.g. 1..12) belongs to THIS month's shifted period (13 prev -> 12 current)
    if (day <= rule.endDay) {
      return { month, year };
    }

    // If day is between endDay and startDay (e.g. if startDay=15, endDay=10, day 11..14),
    // assign to next month's cycle
    if (month === 12) {
      return { month: 1, year: year + 1 };
    }
    return { month: month + 1, year };
  }

  return { month, year };
}

/**
 * Computes the automatic active billing period & range for a school based on today's Cairo date.
 */
export function getCurrentBillingRangeForSchool(
  school?: SchoolBillingConfig | null,
  referenceDate?: string
): SchoolBillingRange {
  const today = referenceDate || getCairoTodayDateString();
  const { month, year } = getBillingPeriodForDate(today, school);
  return getBillingDateRangeForPeriod(month, year, school);
}

export function isDateInRange(
  dateStr: string | null | undefined,
  startDate: string,
  endDate: string
): boolean {
  if (!dateStr) return false;
  const clean = String(dateStr).slice(0, 10);
  return clean >= startDate && clean <= endDate;
}
