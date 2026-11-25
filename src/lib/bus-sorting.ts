import { sql, type AnyColumn, type SQL } from 'drizzle-orm';

/**
 * Normalizes Arabic-Indic and Eastern Arabic digits into ASCII digits.
 */
export function normalizeBusDigits(raw: string | null | undefined): string {
  if (!raw) return '';
  return String(raw)
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .trim();
}

/**
 * Shared SQL ORDER BY expressions for numeric bus number sorting.
 * Primary key: NULLIF(regexp_replace(bus_number, '[^0-9]', '', 'g'), '')::int ASC NULLS LAST
 * Secondary key: bus_number ASC NULLS LAST
 */
export function getBusNumericOrderBy(busNumberCol: AnyColumn | SQL): SQL[] {
  return [
    sql`NULLIF(regexp_replace(${busNumberCol}, '[^0-9]', '', 'g'), '')::int ASC NULLS LAST`,
    sql`${busNumberCol} ASC NULLS LAST`,
  ];
}

/**
 * Shared SQL ORDER BY expressions for grouping by school name and sorting numerically by bus number inside each school.
 */
export function getSchoolBusOrderBy(
  schoolNameCol: AnyColumn | SQL,
  busNumberCol: AnyColumn | SQL,
  missingBusFlagSql?: SQL
): SQL[] {
  const orderCols: SQL[] = [sql`${schoolNameCol} ASC NULLS LAST`];
  if (missingBusFlagSql) {
    orderCols.push(missingBusFlagSql);
  }
  orderCols.push(...getBusNumericOrderBy(busNumberCol));
  return orderCols;
}

/**
 * JS numeric key matching NULLIF(regexp_replace(bus_number, '[^0-9]', '', 'g'), '')::int
 */
export function parseBusNumericKey(busNumber?: string | null): number | null {
  const norm = normalizeBusDigits(busNumber);
  if (!norm || norm === '—' || norm === '-') return null;
  const digits = norm.replace(/[^0-9]/g, '');
  if (!digits) return null;
  const parsed = Number.parseInt(digits, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * JS comparator matching SQL bus number ordering (numeric ASC with non-numeric/missing last).
 */
export function compareBusNumbers(a?: string | null, b?: string | null): number {
  const numA = parseBusNumericKey(a);
  const numB = parseBusNumericKey(b);
  if (numA !== null && numB !== null) {
    if (numA !== numB) return numA - numB;
  } else if (numA !== null) {
    return -1;
  } else if (numB !== null) {
    return 1;
  }
  const strA = normalizeBusDigits(a);
  const strB = normalizeBusDigits(b);
  const emptyA = !strA || strA === '—' || strA === '-';
  const emptyB = !strB || strB === '—' || strB === '-';
  if (emptyA && emptyB) return 0;
  if (emptyA) return 1;
  if (emptyB) return -1;
  return strA.localeCompare(strB, 'ar');
}

export interface SchoolBusSortable {
  schoolId?: number | null;
  schoolName?: string | null;
  busNumber?: string | null;
  vehicleId?: number | null;
}

const UNASSIGNED_SCHOOL_NAMES = new Set(['', 'غير معين', 'غير معينة', '—', '-']);

function isSchoolMissing(item: SchoolBusSortable): boolean {
  const name = (item.schoolName || '').trim();
  return !item.schoolId && UNASSIGNED_SCHOOL_NAMES.has(name);
}

function hasCurrentBus(item: SchoolBusSortable): boolean {
  if (item.vehicleId === null) return false;
  const bn = (item.busNumber || '').trim();
  return Boolean(bn && bn !== '—' && bn !== '-' && bn !== 'بدون باص حالي');
}

/**
 * JS comparator matching backend ordering:
 * 1) School name ASC (unassigned schools last)
 * 2) Entries with a current bus BEFORE entries without a current bus
 * 3) Numeric bus number ASC (non-numeric/nulls last)
 */
export function compareSchoolAndBus(a: SchoolBusSortable, b: SchoolBusSortable): number {
  const missSchoolA = isSchoolMissing(a);
  const missSchoolB = isSchoolMissing(b);
  if (missSchoolA !== missSchoolB) return missSchoolA ? 1 : -1;

  const schoolCmp = (a.schoolName || '').localeCompare(b.schoolName || '', 'ar');
  if (schoolCmp !== 0) return schoolCmp;

  const hasBusA = hasCurrentBus(a);
  const hasBusB = hasCurrentBus(b);
  if (hasBusA !== hasBusB) return hasBusA ? -1 : 1;

  return compareBusNumbers(a.busNumber, b.busNumber);
}

/**
 * Formats a concise bus label for UI lists/cards.
 */
export function formatBusBadgeLabel(
  busNumber?: string | null,
  vehicleIdOrHasBus?: number | boolean | null
): string {
  const clean = (busNumber || '').trim();
  if (
    vehicleIdOrHasBus === null ||
    vehicleIdOrHasBus === false ||
    !clean ||
    clean === '—' ||
    clean === '-' ||
    clean === 'بدون باص حالي'
  ) {
    return 'بدون باص حالي';
  }
  return `باص ${clean}`;
}

export interface SchoolGroup<T> {
  schoolKey: string;
  schoolId: number | null;
  schoolName: string;
  items: T[];
}

/**
 * Groups items by school while sorting both groups and items inside each group by bus number.
 */
export function groupBySchoolSortedByBus<T extends SchoolBusSortable>(items: T[]): SchoolGroup<T>[] {
  const sorted = [...items].sort(compareSchoolAndBus);
  const map = new Map<string, SchoolGroup<T>>();
  for (const item of sorted) {
    const missing = isSchoolMissing(item);
    const schoolId = item.schoolId ?? null;
    const schoolName = missing
      ? 'غير معين بمدرسة'
      : (item.schoolName || '').trim() || `مدرسة #${schoolId}`;
    const schoolKey = schoolId ? `school:${schoolId}` : `name:${schoolName}`;
    let grp = map.get(schoolKey);
    if (!grp) {
      grp = { schoolKey, schoolId, schoolName, items: [] };
      map.set(schoolKey, grp);
    }
    grp.items.push(item);
  }
  return Array.from(map.values());
}
