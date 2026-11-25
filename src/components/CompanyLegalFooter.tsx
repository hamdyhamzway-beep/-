import React from 'react';
import { Building2, FileText, MessageCircle, Phone, ShieldCheck } from 'lucide-react';
import {
  DEFAULT_BRANDING,
  buildWhatsappHref,
  useBranding,
} from '../contexts/BrandingContext';

export interface CompanyLegalFooterProps {
  variant?: 'light' | 'dark';
  compact?: boolean;
  className?: string;
}

export const COMPANY_DETAILS = {
  businessNameAr: DEFAULT_BRANDING.businessNameAr,
  businessNameEn: DEFAULT_BRANDING.businessNameEn,
  commercialRegister: DEFAULT_BRANDING.commercialRegister,
  taxId: DEFAULT_BRANDING.taxId,
  managerTitleAr: DEFAULT_BRANDING.managerTitleAr,
  phone: DEFAULT_BRANDING.phone,
  phoneFormatted: DEFAULT_BRANDING.phone,
  whatsappUrl: buildWhatsappHref(DEFAULT_BRANDING.whatsappPhone, DEFAULT_BRANDING.businessNameAr),
} as const;

export const CompanyLegalFooter: React.FC<CompanyLegalFooterProps> = ({
  variant = 'light',
  compact = false,
  className = '',
}) => {
  const { branding } = useBranding();
  const isDark = variant === 'dark';

  const businessNameAr = branding.businessNameAr.trim() || COMPANY_DETAILS.businessNameAr;
  const commercialRegister =
    branding.commercialRegister.trim() || COMPANY_DETAILS.commercialRegister;
  const taxId = branding.taxId.trim() || COMPANY_DETAILS.taxId;
  const managerTitleAr = branding.managerTitleAr.trim() || COMPANY_DETAILS.managerTitleAr;
  const phone = branding.phone.trim() || COMPANY_DETAILS.phone;
  const whatsappTarget = branding.whatsappPhone.trim() || phone;
  const whatsappUrl = buildWhatsappHref(whatsappTarget, businessNameAr);
  const footerNote = branding.footerNote.trim();

  return (
    <footer
      aria-label="بيانات الشركة الرسمية والاتصال"
      className={`w-full transition-colors ${
        isDark
          ? 'bg-[#081528] text-slate-200 border-t border-[#C89B3C]/25 shadow-lg'
          : 'bg-white text-[#0B1F3A] border-t border-slate-200 shadow-xs'
      } ${compact ? 'py-3 px-4' : 'py-4 sm:py-5 px-4 sm:px-6'} ${className}`}
    >
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4 text-xs">
        {/* Business identity & professional legal details */}
        <div className="flex flex-wrap items-center justify-center md:justify-start gap-y-2 gap-x-3 text-center md:text-right">
          <div
            className={`flex items-center gap-2 font-display font-bold text-sm ${
              isDark ? 'text-white' : 'text-[#0B1F3A]'
            }`}
          >
            <div className="w-6 h-6 rounded-md bg-[#0B1F3A] border border-[#C89B3C]/40 text-[#C89B3C] flex items-center justify-center shrink-0 shadow-xs">
              <Building2 className="w-3.5 h-3.5" />
            </div>
            <span>{businessNameAr}</span>
          </div>

          <span
            aria-hidden="true"
            className={`hidden md:inline ${isDark ? 'text-slate-600' : 'text-slate-300'}`}
          >
            |
          </span>

          <div
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs ${
              isDark
                ? 'bg-white/10 border border-white/15'
                : 'bg-slate-100 border border-slate-200'
            }`}
          >
            <FileText className="w-3.5 h-3.5 text-[#C89B3C] shrink-0" />
            <span className={isDark ? 'text-slate-300' : 'text-slate-600'}>سجل تجاري:</span>
            <span
              className={`font-mono font-bold tabular-nums ${
                isDark ? 'text-[#ebd089]' : 'text-[#0B1F3A]'
              }`}
            >
              {commercialRegister}
            </span>
          </div>

          <div
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs ${
              isDark
                ? 'bg-white/10 border border-white/15'
                : 'bg-slate-100 border border-slate-200'
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5 text-[#C89B3C] shrink-0" />
            <span className={isDark ? 'text-slate-300' : 'text-slate-600'}>تسجيل ضريبي:</span>
            <span
              className={`font-mono font-bold tabular-nums ${
                isDark ? 'text-[#ebd089]' : 'text-[#0B1F3A]'
              }`}
              dir="ltr"
            >
              {taxId}
            </span>
          </div>
        </div>

        {/* Management Contact & Direct Actions (Call & WhatsApp) */}
        <div className="flex flex-wrap items-center justify-center md:justify-end gap-3 shrink-0">
          <div
            className={`font-bold text-xs rounded-lg px-3 py-1 ${
              isDark
                ? 'text-white bg-white/10 border border-[#C89B3C]/40'
                : 'text-[#0B1F3A] bg-[#C89B3C]/15 border border-[#C89B3C]/45'
            }`}
          >
            {managerTitleAr}
          </div>

          <div className="flex items-center gap-2">
            <a
              href={`tel:${phone}`}
              title="اتصال هاتفي مباشر بالإدارة"
              className={`min-h-[34px] inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-mono font-bold text-white tabular-nums transition-colors cursor-pointer shadow-xs ${
                isDark
                  ? 'bg-[#13325c] hover:bg-[#1a4378] border border-white/20'
                  : 'bg-[#0B1F3A] hover:bg-[#13325c]'
              }`}
              dir="ltr"
            >
              <Phone className="w-3.5 h-3.5 text-[#C89B3C]" />
              <span>{phone}</span>
            </a>

            <a
              href={whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="محادثة واتساب فورية مع الإدارة"
              className="min-h-[34px] inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 text-xs font-bold transition-colors cursor-pointer shadow-xs"
            >
              <MessageCircle className="w-3.5 h-3.5" />
              <span>واتساب</span>
            </a>
          </div>
        </div>
      </div>

      {footerNote && (
        <div
          className={`max-w-7xl mx-auto mt-2.5 pt-2 border-t text-center text-[11px] leading-relaxed ${
            isDark
              ? 'border-white/10 text-slate-300'
              : 'border-slate-200/80 text-slate-600'
          }`}
        >
          {footerNote}
        </div>
      )}
    </footer>
  );
};
