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
  cycleType: BillingCycleType;
  startDay: number;
  endDay: number;
  labelAr: string;
  shortLabelAr: string;
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
 * - "مدرسة إشراقة الغد" (or default): calendar month (day 1 to 30/31)
 * - "مدرسة الهلالية" (or any school configured with shifted / startDay > 1): day 13 to day 12 of next month
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
 * Given a billing period (month, year) and a school's billing rule,
 * returns the exact inclusive [startDate, endDate] range in YYYY-MM-DD.
 *
 * Examples:
 * - Calendar (day 1): month=11, year=2026 => 2026-11-01 to 2026-11-30
 * - Shifted (day 13): month=11, year=2026 => 2026-11-13 to 2026-12-12
 * - Shifted (day 13): month=12, year=2026 => 2026-12-13 to 2027-01-12
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
      cycleType: 'calendar',
      startDay: 1,
      endDay: lastDay,
      labelAr: `دورة ميلادية: من ${startDate} إلى ${endDate} (يوم 1 إلى ${lastDay})`,
      shortLabelAr: `1/${safeMonth} → ${lastDay}/${safeMonth}`,
    };
  }

  const startDay = rule.startDay;
  const endDay = startDay - 1;
  const nextMonth = safeMonth === 12 ? 1 : safeMonth + 1;
  const nextYear = safeMonth === 12 ? safeYear + 1 : safeYear;

  const startDate = `${safeYear}-${pad2(safeMonth)}-${pad2(startDay)}`;
  const endDate = `${nextYear}-${pad2(nextMonth)}-${pad2(endDay)}`;

  return {
    month: safeMonth,
    year: safeYear,
    startDate,
    endDate,
    cycleType: 'shifted',
    startDay,
    endDay,
    labelAr: `دورة مرحّلة: من ${startDate} إلى ${endDate} (يوم ${startDay} إلى ${endDay} التالي)`,
    shortLabelAr: `${startDay}/${safeMonth} → ${endDay}/${nextMonth}`,
  };
}

/**
 * Given a transaction or trip date (YYYY-MM-DD) and a school's billing rule,
 * returns the canonical (month, year) billing period that this date belongs to.
 *
 * Examples for Shifted (startDay = 13):
 * - 2026-11-12 => { month: 10, year: 2026 } (range 2026-10-13 .. 2026-11-12)
 * - 2026-11-13 => { month: 11, year: 2026 } (range 2026-11-13 .. 2026-12-12)
 * - 2026-12-05 => { month: 11, year: 2026 } (range 2026-11-13 .. 2026-12-12)
 * - 2026-01-05 => { month: 12, year: 2025 } (range 2025-12-13 .. 2026-01-12)
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

  if (day >= rule.startDay) {
    return { month, year };
  }

  // Day is before startDay -> belongs to the cycle that started in the previous month
  if (month === 1) {
    return { month: 12, year: year - 1 };
  }
  return { month: month - 1, year };
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
