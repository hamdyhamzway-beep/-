import React from 'react';
import { Building2, FileText, MessageCircle, Phone, ShieldCheck } from 'lucide-react';

export interface CompanyLegalFooterProps {
  variant?: 'light' | 'dark';
  compact?: boolean;
  className?: string;
}

export const COMPANY_DETAILS = {
  businessNameAr: 'الوليد ترافيل للنقل المدرسي',
  businessNameEn: 'Al-Waleed Travel · School Fleet Management',
  commercialRegister: '83296',
  taxId: '775-627-151',
  managerTitleAr: 'الإدارة العامة — م. حمدي',
  phone: '01016815939',
  phoneFormatted: '01016815939',
  whatsappUrl: 'https://wa.me/201016815939?text=%D9%85%D8%B1%D8%AD%D8%A8%D8%A7%D9%8b%20%D8%A5%D8%AF%D8%A7%D8%B1%D8%A9%20%D8%A7%D9%84%D9%88%D9%84%D9%8A%D8%AF%20%D8%AA%D8%B1%D8%A7%D9%81%D9%8A%D9%84',
} as const;

export const CompanyLegalFooter: React.FC<CompanyLegalFooterProps> = ({
  variant = 'light',
  compact = false,
  className = '',
}) => {
  const isDark = variant === 'dark';

  return (
    <footer
      aria-label="بيانات الشركة الرسمية والاتصال"
      className={`w-full transition-colors ${
        isDark
          ? 'bg-[#081528] text-slate-300 border-t border-[#C89B3C]/20 shadow-lg'
          : 'bg-white/95 text-slate-700 border-t border-slate-200/90 shadow-xs backdrop-blur-md'
      } ${compact ? 'py-3 px-4' : 'py-4 sm:py-5 px-4 sm:px-6'} ${className}`}
    >
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4 text-xs">
        {/* Business identity & professional legal badges */}
        <div className="flex flex-wrap items-center justify-center md:justify-start gap-y-2 gap-x-3 text-center md:text-right">
          <div className="flex items-center gap-2 font-display font-bold text-sm text-[#0B1F3A] dark:text-white">
            <div className="w-6 h-6 rounded-md bg-[#0B1F3A] text-[#C89B3C] flex items-center justify-center shrink-0 shadow-xs">
              <Building2 className="w-3.5 h-3.5" />
            </div>
            <span>{COMPANY_DETAILS.businessNameAr}</span>
          </div>

          <span aria-hidden="true" className="hidden md:inline text-slate-300 dark:text-slate-700">
            |
          </span>

          <div className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 dark:bg-white/5 border border-slate-200/80 dark:border-white/10 px-2.5 py-1 text-[11px]">
            <FileText className="w-3.5 h-3.5 text-[#C89B3C] shrink-0" />
            <span className="text-slate-500 dark:text-slate-400">سجل تجاري:</span>
            <span className="font-mono font-bold text-[#0B1F3A] dark:text-[#ebd089] tabular-nums">
              {COMPANY_DETAILS.commercialRegister}
            </span>
          </div>

          <div className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 dark:bg-white/5 border border-slate-200/80 dark:border-white/10 px-2.5 py-1 text-[11px]">
            <ShieldCheck className="w-3.5 h-3.5 text-[#C89B3C] shrink-0" />
            <span className="text-slate-500 dark:text-slate-400">تسجيل ضريبي:</span>
            <span className="font-mono font-bold text-[#0B1F3A] dark:text-[#ebd089] tabular-nums" dir="ltr">
              {COMPANY_DETAILS.taxId}
            </span>
          </div>
        </div>

        {/* Management Contact & Direct Actions (Call & WhatsApp) */}
        <div className="flex flex-wrap items-center justify-center md:justify-end gap-3 shrink-0">
          <div className="font-bold text-[#0B1F3A] dark:text-white text-xs bg-[#C89B3C]/10 border border-[#C89B3C]/30 rounded-lg px-3 py-1">
            {COMPANY_DETAILS.managerTitleAr}
          </div>

          <div className="flex items-center gap-2">
            <a
              href={`tel:${COMPANY_DETAILS.phone}`}
              title="اتصال هاتفي مباشر بالإدارة"
              className="min-h-[32px] inline-flex items-center gap-1.5 rounded-lg bg-[#0B1F3A] hover:bg-[#13325c] text-white px-3 py-1.5 text-xs font-mono font-bold tabular-nums transition-colors cursor-pointer shadow-xs"
              dir="ltr"
            >
              <Phone className="w-3.5 h-3.5 text-[#C89B3C]" />
              <span>{COMPANY_DETAILS.phoneFormatted}</span>
            </a>

            <a
              href={COMPANY_DETAILS.whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="محادثة واتساب فورية مع الإدارة"
              className="min-h-[32px] inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 text-xs font-bold transition-colors cursor-pointer shadow-xs"
            >
              <MessageCircle className="w-3.5 h-3.5" />
              <span>واتساب</span>
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
};
