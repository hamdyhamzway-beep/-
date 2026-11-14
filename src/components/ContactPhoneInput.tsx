import React, { useRef, useState } from 'react';
import { Contact, FileUp, Info, X } from 'lucide-react';

interface ContactSelection {
  phone: string;
  name?: string;
}

interface ContactPhoneInputProps {
  value: string;
  onChange: (value: string) => void;
  onPickContact?: (selection: ContactSelection) => void;
  required?: boolean;
  placeholder?: string;
  inputClassName?: string;
}

interface NavigatorWithContacts extends Navigator {
  contacts?: {
    select: (
      properties: string[],
      options?: { multiple?: boolean }
    ) => Promise<Array<{ name?: string[]; tel?: string[] }>>;
  };
}

export function normalizePhoneNumber(raw: string): string {
  // Remove RTL/LTR marks, spaces, parentheses, hyphens
  let cleaned = raw
    .replace(/[\u200e\u200f\u202a-\u202e\s\-().]/g, '')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

  // Normalize Egyptian international prefixes (+201... or 00201... -> 01...)
  if (cleaned.startsWith('+20')) {
    cleaned = '0' + cleaned.slice(3);
  } else if (cleaned.startsWith('0020')) {
    cleaned = '0' + cleaned.slice(4);
  } else if (cleaned.startsWith('201') && cleaned.length === 12) {
    cleaned = '0' + cleaned.slice(2);
  }

  return cleaned;
}

function decodeQuotedPrintableUtf8(str: string): string {
  try {
    const clean = str.replace(/=\r?\n/g, '');
    const bytes: number[] = [];
    for (let i = 0; i < clean.length; i++) {
      if (clean[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(clean.slice(i + 1, i + 3))) {
        bytes.push(parseInt(clean.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(clean.charCodeAt(i));
      }
    }
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
  } catch {
    return str;
  }
}

function parseVCard(vcfText: string): ContactSelection | null {
  const unfolded = vcfText.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);

  let name = '';
  let phone = '';

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const prop = line.slice(0, colonIdx).toUpperCase();
    const val = line.slice(colonIdx + 1).trim();
    if (!val) continue;

    if (prop === 'FN' || prop.startsWith('FN;')) {
      name = prop.includes('QUOTED-PRINTABLE') ? decodeQuotedPrintableUtf8(val) : val;
    } else if (prop === 'TEL' || prop.startsWith('TEL;')) {
      if (!phone) {
        phone = normalizePhoneNumber(val);
      }
    }
  }

  if (!phone) return null;
  return { phone, name: name.trim() || undefined };
}

export const ContactPhoneInput: React.FC<ContactPhoneInputProps> = ({
  value,
  onChange,
  onPickContact,
  required = false,
  placeholder = '01012345678',
  inputClassName = '',
}) => {
  const vcfInputRef = useRef<HTMLInputElement | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [showFallbackHint, setShowFallbackHint] = useState(false);

  const applySelection = (selection: ContactSelection) => {
    setStatusMessage(null);
    setShowFallbackHint(false);
    if (onPickContact) {
      onPickContact(selection);
    } else {
      onChange(selection.phone);
    }
  };

  const handleOpenContacts = async () => {
    setStatusMessage(null);
    const nav = navigator as NavigatorWithContacts;

    if (nav.contacts && typeof nav.contacts.select === 'function') {
      try {
        const picked = await nav.contacts.select(['name', 'tel'], { multiple: false });
        if (!picked || picked.length === 0) return;

        const first = picked[0];
        const rawPhone = first.tel?.[0] || '';
        const phone = normalizePhoneNumber(rawPhone);
        const name = first.name?.[0]?.trim() || undefined;

        if (!phone) {
          setStatusMessage('جهة الاتصال المختارة لا تحتوي على رقم هاتف.');
          return;
        }

        applySelection({ phone, name });
        return;
      } catch (err: unknown) {
        const errName = err instanceof Error ? err.name : '';
        if (errName === 'AbortError') return; // User closed contact picker
        if (errName === 'SecurityError' || errName === 'InvalidStateError') {
          setStatusMessage(
            'الوصول المباشر لجهات الاتصال يتطلب فتح التطبيق كموبايل PWA أو في نافذة مستقلة (خارج إطار المعاينة)، أو يمكنك استيراد ملف جهة اتصال (.vcf).'
          );
          setShowFallbackHint(true);
          return;
        }
      }
    }

    // Browser doesn't expose Web Contact Picker API (e.g., iOS Safari or Desktop)
    setShowFallbackHint((prev) => !prev);
  };

  const handleVcfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = parseVCard(text);
      if (!parsed) {
        setStatusMessage('لم يتم العثور على رقم هاتف داخل ملف جهة الاتصال.');
        return;
      }
      applySelection(parsed);
    } catch {
      setStatusMessage('تعذر قراءة ملف جهة الاتصال (.vcf).');
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-stretch gap-1.5">
        <input
          type="tel"
          required={required}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          dir="ltr"
          className={`flex-1 min-w-0 rounded-lg border border-slate-200 px-3 py-2 font-mono text-right focus:border-[#0B1F3A] focus:outline-none ${inputClassName}`}
        />
        <button
          type="button"
          onClick={handleOpenContacts}
          title="اختيار رقم من جهات الاتصال على الموبايل"
          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-[11px] font-semibold text-[#0B1F3A] hover:bg-amber-50 hover:border-[#C89B3C]/60 shrink-0 cursor-pointer transition-colors"
        >
          <Contact className="w-3.5 h-3.5 text-[#C89B3C]" />
          <span>جهات الاتصال</span>
        </button>
      </div>

      {statusMessage && (
        <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 leading-relaxed">
          {statusMessage}
        </p>
      )}

      {showFallbackHint && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-[11px] text-slate-600 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-1.5 leading-relaxed">
              <Info className="w-3.5 h-3.5 text-[#0B1F3A] shrink-0 mt-0.5" />
              <span>
                على <strong>أندرويد (Chrome / تطبيق PWA)</strong> يفتح سجل الأسماء مباشرة. على{' '}
                <strong>الآيفون أو الكمبيوتر</strong> يمكنك استيراد بطاقة جهة الاتصال (.vcf):
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowFallbackHint(false)}
              className="text-slate-400 hover:text-slate-600 cursor-pointer shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => vcfInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-md bg-white border border-slate-300 px-2.5 py-1.5 text-[11px] font-semibold text-[#0B1F3A] hover:bg-slate-100 cursor-pointer"
          >
            <FileUp className="w-3.5 h-3.5 text-[#C89B3C]" />
            استيراد ملف جهة اتصال (.vcf)
          </button>
        </div>
      )}

      <input
        ref={vcfInputRef}
        type="file"
        accept=".vcf,text/vcard,text/x-vcard"
        onChange={handleVcfUpload}
        className="hidden"
      />
    </div>
  );
};
