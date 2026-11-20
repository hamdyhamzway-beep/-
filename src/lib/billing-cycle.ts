export type BillingCycleType = 'calendar' | 'shifted';

export interface SchoolBillingConfig {
  id?: number | null;
  name?: string | null;
  billingCycleType?: string | null;
  billingCycleStartDay?: number | null;
  billingCycleEndDay?: number | null;
  customStartDate?: string | null;
  customEndDate?: string | null;
  customPeriodMonth?: number | null;
  customPeriodYear?: number | null;
}

export interface ResolvedBillingRule {
  cycleType: BillingCycleType;
  startDay: number;
  endDay: number;
  customStartDate?: string | null;
  customEndDate?: string | null;
  customPeriodMonth?: number | null;
  customPeriodYear?: number | null;
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

function toWesternDigits(input: string): string {
  return input
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
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

/**
 * Normalizes date strings (YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, ISO timestamps, Arabic digits)
 * strictly into YYYY-MM-DD without UTC timezone drift.
 */
export function normalizeIsoDateInput(dateStr?: string | null): string {
  const raw = toWesternDigits(String(dateStr || '').trim());
  if (!raw) return getCairoTodayDateString();

  // YYYY-MM-DD or YYYY/MM/DD (optionally followed by T...)
  const ymd = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s].*)?$/);
  if (ymd) {
    const y = Number(ymd[1]);
    const m = Number(ymd[2]);
    const d = Number(ymd[3]);
    if (y >= 2000 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${pad2(m)}-${pad2(d)}`;
    }
  }

  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:\s.*)?$/);
  if (dmy) {
    const d = Number(dmy[1]);
    const m = Number(dmy[2]);
    const y = Number(dmy[3]);
    if (y >= 2000 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${pad2(m)}-${pad2(d)}`;
    }
  }

  return getCairoTodayDateString();
}

export function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Resolves the financial cycle rule for a school.
 * - Calendar cycle (default): day 1 00:00 to last day 23:59:59 of targetMonth
 * - "مدرسة الهلالية" / "هلاليه للغات" (shifted, startDay=13, endDay=12):
 *   day 13 of CURRENT targetMonth 00:00 to day 12 of NEXT month 23:59:59
 */
export function resolveSchoolBillingRule(school?: SchoolBillingConfig | null): ResolvedBillingRule {
  const rawType = school?.billingCycleType;
  const rawStartDay = Number(school?.billingCycleStartDay || 0);
  const rawEndDay = Number(school?.billingCycleEndDay || 0);
  const customStartDate = school?.customStartDate?.trim()
    ? normalizeIsoDateInput(school.customStartDate)
    : null;
  const customEndDate = school?.customEndDate?.trim()
    ? normalizeIsoDateInput(school.customEndDate)
    : null;
  const customPeriodMonth =
    school?.customPeriodMonth && Number.isFinite(Number(school.customPeriodMonth))
      ? Number(school.customPeriodMonth)
      : null;
  const customPeriodYear =
    school?.customPeriodYear && Number.isFinite(Number(school.customPeriodYear))
      ? Number(school.customPeriodYear)
      : null;

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
      customPeriodMonth,
      customPeriodYear,
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
      customPeriodMonth,
      customPeriodYear,
    };
  }

  // Smart fallback by school name (matches "مدرسة الهلالية", "هلاليه للغات", "Al-Hilaliya")
  const normName = normalizeArabicNameForCycle(school?.name || '');
  if (normName.includes('هلالي') || normName.includes('hilal')) {
    return {
      cycleType: 'shifted',
      startDay: 13,
      endDay: 12,
      customStartDate,
      customEndDate,
      customPeriodMonth,
      customPeriodYear,
    };
  }

  return {
    cycleType: 'calendar',
    startDay: 1,
    endDay: 31,
    customStartDate,
    customEndDate,
    customPeriodMonth,
    customPeriodYear,
  };
}

/**
 * Given a target billing period (month, year) and a school's billing rule,
 * returns the exact inclusive [StartDate 00:00:00, EndDate 23:59:59] range.
 *
 * For Al-Hilaliya (shifted, startDay=13, endDay=12):
 * Period (11, 2026) -> 2026-11-13 00:00:00 to 2026-12-12 23:59:59.
 */
export function getBillingDateRangeForPeriod(
  month: number,
  year: number,
  school?: SchoolBillingConfig | null
): SchoolBillingRange {
  const safeMonth = Math.min(12, Math.max(1, Math.floor(month) || 1));
  const safeYear = Math.min(2099, Math.max(2020, Math.floor(year) || new Date().getFullYear()));
  const rule = resolveSchoolBillingRule(school);

  // Apply customStartDate / customEndDate only when it matches the requested period (or unscoped)
  const customPeriodMatches =
    rule.customPeriodMonth === null ||
    rule.customPeriodMonth === undefined ||
    rule.customPeriodYear === null ||
    rule.customPeriodYear === undefined ||
    (safeMonth === rule.customPeriodMonth && safeYear === rule.customPeriodYear);

  if (
    customPeriodMatches &&
    rule.customStartDate &&
    rule.customEndDate &&
    /^\d{4}-\d{2}-\d{2}$/.test(rule.customStartDate) &&
    /^\d{4}-\d{2}-\d{2}$/.test(rule.customEndDate) &&
    rule.customStartDate <= rule.customEndDate
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
    // Shifted cycle: day `startDay` of CURRENT month -> day `endDay` of NEXT month
    // Example (Al-Hilaliya, month=11, year=2026): 2026-11-13 -> 2026-12-12
    const nextMonth = safeMonth === 12 ? 1 : safeMonth + 1;
    const nextYear = safeMonth === 12 ? safeYear + 1 : safeYear;

    const currMonthDays = getDaysInMonth(safeYear, safeMonth);
    const clampedStartDay = Math.min(startDay, currMonthDays);
    const nextMonthDays = getDaysInMonth(nextYear, nextMonth);
    const clampedEndDay = Math.min(endDay, nextMonthDays);

    const startDate = `${safeYear}-${pad2(safeMonth)}-${pad2(clampedStartDay)}`;
    const endDate = `${nextYear}-${pad2(nextMonth)}-${pad2(clampedEndDay)}`;

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
      labelAr: `دورة مرحّلة: من ${startDate} إلى ${endDate} (${clampedStartDay}/${safeMonth} ← ${clampedEndDay}/${nextMonth} · 11:59 م)`,
      shortLabelAr: `${clampedStartDay}/${safeMonth} → ${clampedEndDay}/${nextMonth}`,
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
 * Given a transaction or trip date (YYYY-MM-DD / DD/MM/YYYY) and a school's billing rule,
 * returns the canonical (month, year) billing period that this date belongs to.
 *
 * For Al-Hilaliya (startDay=13, endDay=12):
 * - 2026-11-13..2026-11-30 (day >= 13) -> { month: 11, year: 2026 }
 * - 2026-12-01..2026-12-12 (day <= 12) -> { month: 11, year: 2026 }
 */
export function getBillingPeriodForDate(
  dateStr: string,
  school?: SchoolBillingConfig | null
): { month: number; year: number } {
  const rule = resolveSchoolBillingRule(school);
  const cleanDate = normalizeIsoDateInput(dateStr);
  const parts = cleanDate.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);

  // If a custom date range is configured for a specific period and the date falls inside it, return that period
  if (
    rule.customStartDate &&
    rule.customEndDate &&
    isDateInRange(cleanDate, rule.customStartDate, rule.customEndDate)
  ) {
    if (rule.customPeriodMonth && rule.customPeriodYear) {
      return { month: rule.customPeriodMonth, year: rule.customPeriodYear };
    }
    return { month, year };
  }

  if (rule.cycleType === 'calendar' || rule.startDay <= 1) {
    return { month, year };
  }

  if (rule.startDay > rule.endDay) {
    // Day >= startDay (e.g. 13..31 of Nov) belongs to CURRENT month's shifted period (11/2026)
    if (day >= rule.startDay) {
      return { month, year };
    }

    // Day <= endDay (e.g. 1..12 of Dec) belongs to PREVIOUS month's shifted period (11/2026)
    if (month === 1) {
      return { month: 12, year: year - 1 };
    }
    return { month: month - 1, year };
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
  const today = referenceDate ? normalizeIsoDateInput(referenceDate) : getCairoTodayDateString();
  const { month, year } = getBillingPeriodForDate(today, school);
  return getBillingDateRangeForPeriod(month, year, school);
}

export function isDateInRange(
  dateStr: string | null | undefined,
  startDate: string,
  endDate: string
): boolean {
  if (!dateStr) return false;
  const clean = normalizeIsoDateInput(dateStr);
  return clean >= startDate && clean <= endDate;
}
