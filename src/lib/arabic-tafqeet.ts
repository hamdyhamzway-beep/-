export const ARABIC_MONTH_NAMES: Record<number, string> = {
  1: 'يناير',
  2: 'فبراير',
  3: 'مارس',
  4: 'أبريل',
  5: 'مايو',
  6: 'يونيو',
  7: 'يوليو',
  8: 'أغسطس',
  9: 'سبتمبر',
  10: 'أكتوبر',
  11: 'نوفمبر',
  12: 'ديسمبر',
};

export function getArabicMonthName(month: number): string {
  const m = Number(month);
  return ARABIC_MONTH_NAMES[m] || `شهر ${m}`;
}

export function formatInvoiceCode(num: number): string {
  const clean = Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
  return String(clean).padStart(4, '0');
}

export const DEFAULT_INVOICE_BILL_TO = 'السيد إسلام عصام الدين (شركة الإسراء للرحلات)';
export const DEFAULT_INVOICE_SCHOOL_NAME = 'مدرسة إشراقة الغد';
export const DEFAULT_INVOICE_VEHICLE_COUNT = 35;

export const INVOICE_COMPANY_META = {
  companyName: 'مكتب رحلات حمدى لطفى (الوليد ترافيل)',
  address: 'مشروع ناصر ثان الرمل الإسكندرية خلف مدرسة القومية للغات',
  commercialRegister: '83296',
  taxId: '775627151',
  phone: '01016815939',
  signatureTitle: 'توقيع وختم المكتب',
} as const;

export function buildDefaultInvoiceStatement(
  month: number,
  vehicleCount: number = DEFAULT_INVOICE_VEHICLE_COUNT,
  schoolName: string = DEFAULT_INVOICE_SCHOOL_NAME
): string {
  const monthName = getArabicMonthName(month);
  const count = Number.isFinite(Number(vehicleCount)) && Number(vehicleCount) > 0
    ? Math.floor(Number(vehicleCount))
    : DEFAULT_INVOICE_VEHICLE_COUNT;
  const school = String(schoolName || DEFAULT_INVOICE_SCHOOL_NAME).trim() || DEFAULT_INVOICE_SCHOOL_NAME;
  return `قيمة نقل طلاب ${school} من وإلى المدرسة بناءً على خطوط السير المحددة باستخدام ${count} سيارة خلال شهر ${monthName}`;
}

const ONES_MASCULINE = [
  '',
  'واحد',
  'اثنان',
  'ثلاثة',
  'أربعة',
  'خمسة',
  'ستة',
  'سبعة',
  'ثمانية',
  'تسعة',
];

const TEENS_MASCULINE = [
  'عشرة',
  'أحد عشر',
  'اثنا عشر',
  'ثلاثة عشر',
  'أربعة عشر',
  'خمسة عشر',
  'ستة عشر',
  'سبعة عشر',
  'ثمانية عشر',
  'تسعة عشر',
];

const TENS = [
  '',
  'عشرة',
  'عشرون',
  'ثلاثون',
  'أربعون',
  'خمسون',
  'ستون',
  'سبعون',
  'ثمانون',
  'تسعون',
];

const HUNDREDS = [
  '',
  'مائة',
  'مائتان',
  'ثلاثمائة',
  'أربعمائة',
  'خمسمائة',
  'ستمائة',
  'سبعمائة',
  'ثمانمائة',
  'تسعمائة',
];

function convertTriad(n: number, dropDualNoonAtEnd = false): string {
  const num = Math.floor(n);
  if (num <= 0 || num > 999) return '';

  const parts: string[] = [];
  const h = Math.floor(num / 100);
  const rem = num % 100;

  if (h > 0) {
    if (h === 2 && rem === 0 && dropDualNoonAtEnd) {
      parts.push('مائتا');
    } else {
      parts.push(HUNDREDS[h]);
    }
  }

  if (rem > 0) {
    if (rem < 10) {
      parts.push(ONES_MASCULINE[rem]);
    } else if (rem >= 10 && rem <= 19) {
      parts.push(TEENS_MASCULINE[rem - 10]);
    } else {
      const ones = rem % 10;
      const tens = Math.floor(rem / 10);
      if (ones > 0) {
        parts.push(ONES_MASCULINE[ones]);
      }
      parts.push(TENS[tens]);
    }
  }

  return parts.join(' و');
}

function convertIntegerToArabicWords(n: number): string {
  if (n === 0) return 'صفر';

  const billions = Math.floor(n / 1_000_000_000);
  const millions = Math.floor((n % 1_000_000_000) / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1_000);
  const rest = n % 1_000;

  const segments: string[] = [];

  if (billions > 0) {
    const bRem = billions % 100;
    const isLastScale = millions === 0 && thousands === 0 && rest === 0;
    if (billions === 1) {
      segments.push('مليار');
    } else if (billions === 2) {
      segments.push(isLastScale ? 'مليارا' : 'ملياران');
    } else if (bRem >= 3 && bRem <= 10) {
      segments.push(`${convertTriad(billions)} مليارات`);
    } else {
      segments.push(`${convertTriad(billions)} مليار`);
    }
  }

  if (millions > 0) {
    const mRem = millions % 100;
    const isLastScale = thousands === 0 && rest === 0;
    if (millions === 1) {
      segments.push('مليون');
    } else if (millions === 2) {
      segments.push(isLastScale ? 'مليونا' : 'مليونان');
    } else if (mRem >= 3 && mRem <= 10) {
      segments.push(`${convertTriad(millions)} ملايين`);
    } else {
      segments.push(`${convertTriad(millions)} مليون`);
    }
  }

  if (thousands > 0) {
    const tRem = thousands % 100;
    const hasFollowing = rest > 0;
    if (thousands === 1) {
      segments.push('ألف');
    } else if (thousands === 2) {
      segments.push(hasFollowing ? 'ألفان' : 'ألفا');
    } else if (tRem >= 3 && tRem <= 10) {
      segments.push(`${convertTriad(thousands)} آلاف`);
    } else {
      segments.push(`${convertTriad(thousands)} ${hasFollowing ? 'ألفاً' : 'ألف'}`);
    }
  }

  if (rest > 0) {
    segments.push(convertTriad(rest, true));
  }

  return segments.join(' و');
}

function formatPoundsPhrase(intPart: number): string {
  if (intPart === 0) return 'صفر جنيه مصري';
  if (intPart === 1) return 'جنيه مصري واحد';
  if (intPart === 2) return 'جنيهان مصريان';

  const words = convertIntegerToArabicWords(intPart);
  const mod100 = intPart % 100;

  if (mod100 >= 3 && mod100 <= 10) {
    return `${words} جنيهات مصرية`;
  }
  if (mod100 >= 11 && mod100 <= 99) {
    return `${words} جنيهاً مصرياً`;
  }
  // Exact multiples of 100 (e.g., 100, 1000, 185000, 1000000) or ...01 / ...02 above 100
  return `${words} جنيه مصري`;
}

function formatPiastersPhrase(piasters: number): string {
  if (piasters <= 0) return '';
  if (piasters === 1) return 'قرش واحد';
  if (piasters === 2) return 'قرشان';
  const words = convertTriad(piasters);
  if (piasters >= 3 && piasters <= 10) {
    return `${words} قروش`;
  }
  return `${words} قرشاً`;
}

/**
 * Arabic Tafqeet Engine for Egyptian Pounds & Piasters
 * Example: tafqeetEGP(185000) === "مائة وخمسة وثمانون ألف جنيه مصري لا غير"
 */
export function tafqeetEGP(rawAmount: number | string): string {
  const num = Number(rawAmount);
  if (!Number.isFinite(num) || num < 0) {
    return 'صفر جنيه مصري لا غير';
  }

  const totalPiasters = Math.round(num * 100);
  const intPart = Math.floor(totalPiasters / 100);
  const piasters = totalPiasters % 100;

  if (intPart === 0 && piasters === 0) {
    return 'صفر جنيه مصري لا غير';
  }

  if (intPart === 0 && piasters > 0) {
    return `${formatPiastersPhrase(piasters)} لا غير`;
  }

  const poundsText = formatPoundsPhrase(intPart);
  if (piasters === 0) {
    return `${poundsText} لا غير`;
  }

  const piastersText = formatPiastersPhrase(piasters);
  return `${poundsText} و${piastersText} لا غير`;
}
