export type BillingCycleType = 'calendar' | 'shifted';

export interface SchoolBillingConfig {
  id?: number | null;
  name?: string | null;
  billingCycleType?: string | null;
  billingCycleStartDay?: number | null;
}

export interface ResolvedBillingRule {
  cycleType: BillingCycleType;
  startDay: number;
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
  const rawDay = Number(school?.billingCycleStartDay || 0);

  if (rawType === 'shifted' || (Number.isFinite(rawDay) && rawDay > 1 && rawDay <= 28)) {
    const safeDay = Number.isFinite(rawDay) && rawDay > 1 && rawDay <= 28 ? Math.floor(rawDay) : 13;
    return { cycleType: 'shifted', startDay: safeDay };
  }

  if (rawType === 'calendar' && rawDay === 1) {
    return { cycleType: 'calendar', startDay: 1 };
  }

  // Smart fallback by school name if DB column was not yet explicitly configured
  const normName = normalizeArabicNameForCycle(school?.name || '');
  if (normName.includes('الهلالي') || normName.includes('hilal')) {
    return { cycleType: 'shifted', startDay: 13 };
  }

  return { cycleType: 'calendar', startDay: 1 };
}

/**
 * Given a target billing period (month, year) and a school's billing rule,
 * returns the exact inclusive [StartDate 00:00:00, EndDate 23:59:59] range.
 *
 * Examples:
 * - Calendar ("إشراقة الغد", day 1):
 *   - month=11, year=2026 => 2026-11-01 00:00:00 to 2026-11-30 23:59:59
 *   - month=2,  year=2024 => 2024-02-01 00:00:00 to 2024-02-29 23:59:59 (leap year)
 * - Shifted ("الهلالية", startDay=13 -> endDay=12):
 *   - month=11, year=2026 => 2026-10-13 00:00:00 to 2026-11-12 23:59:59
 *   - month=1,  year=2026 => 2025-12-13 00:00:00 to 2026-01-12 23:59:59 (cross-year)
 *   - month=12, year=2026 => 2026-11-13 00:00:00 to 2026-12-12 23:59:59
 */
export function getBillingDateRangeForPeriod(
  month: number,
  year: number,
  school?: SchoolBillingConfig | null
): SchoolBillingRange {
  const safeMonth = Math.min(12, Math.max(1, Math.floor(month) || 1));
  const safeYear = Math.min(2099, Math.max(2020, Math.floor(year) || new Date().getFullYear()));
  const rule = resolveSchoolBillingRule(school);

  if (rule.cycleType === 'calendar' || rule.startDay <= 1) {
    const lastDay = getDaysInMonth(safeYear, safeMonth);
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
  const endDay = startDay - 1;
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
 *
 * Examples for Shifted ("الهلالية", startDay = 13, closes day 12 of target month):
 * - 2026-10-13 => { month: 11, year: 2026 } (Nov period: 2026-10-13 .. 2026-11-12)
 * - 2026-11-12 => { month: 11, year: 2026 } (Nov period: 2026-10-13 .. 2026-11-12)
 * - 2026-11-13 => { month: 12, year: 2026 } (Dec period: 2026-11-13 .. 2026-12-12)
 * - 2026-12-18 => { month: 1,  year: 2027 } (Jan 2027 period: 2026-12-13 .. 2027-01-12)
 * - 2026-01-05 => { month: 1,  year: 2026 } (Jan 2026 period: 2025-12-13 .. 2026-01-12)
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

  if (rule.cycleType === 'calendar' || rule.startDay <= 1) {
    return { month, year };
  }

  // Day >= startDay (e.g. 13..31) belongs to NEXT month's shifted period (13 current -> 12 next)
  if (day >= rule.startDay) {
    if (month === 12) {
      return { month: 1, year: year + 1 };
    }
    return { month: month + 1, year };
  }

  // Day < startDay (e.g. 1..12) belongs to THIS month's shifted period (13 prev -> 12 current)
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
