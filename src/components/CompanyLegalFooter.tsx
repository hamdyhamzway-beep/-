import React from 'react';
import { Building2, FileText, MessageCircle, Phone, ShieldCheck } from 'lucide-react';

export interface CompanyLegalFooterProps {
  variant?: 'light' | 'dark';
  compact?: boolean;
  className?: string;
}

export const COMPANY_DETAILS = {
  businessNameAr: 'الوليد ترافيل للنقل المدرسي',
  businessNameEn: 'Al-Waleed Travel',
  commercialRegister: '83296',
  taxId: '151-627-775',
  managerTitleAr: 'الإدارة / م. حمدي',
  phone: '01016815939',
  phoneFormatted: '01016815939',
  whatsappUrl: 'https://wa.me/201016815939?text=%D9%85%D8%B1%D8%AD%D8%A8%D8%A7%D9%8B%20%D8%A5%D8%AF%D8%A7%D8%B1%D8%A9%20%D8%A7%D9%84%D9%88%D9%84%D9%8A%D8%AF%20%D8%AA%D8%B1%D8%A7%D9%81%D9%8A%D9%84',
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
          ? 'bg-[#0B1F3A]/90 text-slate-300 border-t border-white/10'
          : 'bg-white/80 text-slate-600 border-t border-slate-200/80 backdrop-blur-sm'
      } ${compact ? 'py-3 px-4' : 'py-4 sm:py-5 px-4 sm:px-6'} ${className}`}
    >
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-3 sm:gap-4 text-xs">
        {/* Business identity & legal registries */}
        <div className="flex flex-wrap items-center justify-center md:justify-start gap-y-1.5 gap-x-3 text-center md:text-right">
          <div className="flex items-center gap-1.5 font-bold text-[#C89B3C]">
            <Building2 className="w-3.5 h-3.5 shrink-0" />
            <span className={isDark ? 'text-white' : 'text-[#0B1F3A]'}>
              {COMPANY_DETAILS.businessNameAr}
            </span>
          </div>

          <span aria-hidden="true" className="hidden sm:inline text-slate-400">
            ·
          </span>

          <div className="flex items-center gap-1">
            <FileText className="w-3.5 h-3.5 text-[#C89B3C] shrink-0" />
            <span className={isDark ? 'text-slate-300' : 'text-slate-600'}>س.ت:</span>
            <span className="font-mono font-semibold tabular-nums text-[#C89B3C]">
              {COMPANY_DETAILS.commercialRegister}
            </span>
          </div>

          <span aria-hidden="true" className="text-slate-400">
            ·
          </span>

          <div className="flex items-center gap-1">
            <ShieldCheck className="w-3.5 h-3.5 text-[#C89B3C] shrink-0" />
            <span className={isDark ? 'text-slate-300' : 'text-slate-600'}>ب.ض:</span>
            <span className="font-mono font-semibold tabular-nums text-[#C89B3C]" dir="ltr">
              {COMPANY_DETAILS.taxId}
            </span>
          </div>
        </div>

        {/* Management Contact & Direct Actions (Call & WhatsApp) */}
        <div className="flex flex-wrap items-center justify-center md:justify-end gap-2 shrink-0">
          <span className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            {COMPANY_DETAILS.managerTitleAr}:
          </span>

          <a
            href={`tel:${COMPANY_DETAILS.phone}`}
            title="اتصال هاتفي مباشر بالإدارة"
            className={`min-h-[32px] inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-mono font-semibold tabular-nums transition-colors cursor-pointer ${
              isDark
                ? 'bg-white/10 hover:bg-white/20 text-white'
                : 'bg-slate-100 hover:bg-slate-200 text-[#0B1F3A]'
            }`}
            dir="ltr"
          >
            <Phone className="w-3 h-3 text-[#C89B3C]" />
            <span>{COMPANY_DETAILS.phoneFormatted}</span>
          </a>

          <a
            href={COMPANY_DETAILS.whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="محادثة واتساب فورية مع الإدارة"
            className="min-h-[32px] inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white px-2.5 py-1 text-xs font-semibold transition-colors cursor-pointer shadow-xs"
          >
            <MessageCircle className="w-3 h-3" />
            <span>واتساب</span>
          </a>
        </div>
      </div>
    </footer>
  );
};
