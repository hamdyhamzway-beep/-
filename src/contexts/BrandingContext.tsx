import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import defaultBrandLogoImg from '../assets/images/alwaleed_travel_logo_1794730803222.jpg';

export type AppFontChoice = 'Cairo' | 'Tajawal' | 'IBM Plex Sans Arabic';

export const APP_FONT_OPTIONS: Array<{ value: AppFontChoice; label: string }> = [
  { value: 'Cairo', label: 'Cairo (كايرو — الافتراضي)' },
  { value: 'Tajawal', label: 'Tajawal (تجوال)' },
  { value: 'IBM Plex Sans Arabic', label: 'IBM Plex Sans Arabic' },
];

export const BRANDING_STORAGE_KEY = 'alwaleed_branding_v1';

export interface BrandingSettings {
  logoUrl: string;
  businessNameAr: string;
  businessNameEn: string;
  phone: string;
  whatsappPhone: string;
  commercialRegister: string;
  taxId: string;
  managerTitleAr: string;
  fontFamily: AppFontChoice;
  footerNote: string;
}

export const DEFAULT_BRANDING: BrandingSettings = {
  logoUrl: '',
  businessNameAr: 'الوليد ترافيل للنقل المدرسي',
  businessNameEn: 'Al-Waleed Travel · School Fleet Management',
  phone: '01016815939',
  whatsappPhone: '01016815939',
  commercialRegister: '83296',
  taxId: '775627151',
  managerTitleAr: 'الإدارة التنفيذية — م. حمدي لطفي',
  fontFamily: 'Cairo',
  footerNote: '',
};

const VALID_FONTS = new Set<AppFontChoice>(['Cairo', 'Tajawal', 'IBM Plex Sans Arabic']);

function sanitizeBranding(raw: unknown): BrandingSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_BRANDING };
  const obj = raw as Partial<BrandingSettings>;
  const fontCandidate = obj.fontFamily;
  return {
    logoUrl: typeof obj.logoUrl === 'string' ? obj.logoUrl : DEFAULT_BRANDING.logoUrl,
    businessNameAr:
      typeof obj.businessNameAr === 'string' && obj.businessNameAr.trim()
        ? obj.businessNameAr
        : DEFAULT_BRANDING.businessNameAr,
    businessNameEn:
      typeof obj.businessNameEn === 'string' && obj.businessNameEn.trim()
        ? obj.businessNameEn
        : DEFAULT_BRANDING.businessNameEn,
    phone:
      typeof obj.phone === 'string' && obj.phone.trim() ? obj.phone : DEFAULT_BRANDING.phone,
    whatsappPhone:
      typeof obj.whatsappPhone === 'string' ? obj.whatsappPhone : DEFAULT_BRANDING.whatsappPhone,
    commercialRegister:
      typeof obj.commercialRegister === 'string' && obj.commercialRegister.trim()
        ? obj.commercialRegister
        : DEFAULT_BRANDING.commercialRegister,
    taxId:
      typeof obj.taxId === 'string' && obj.taxId.trim() ? obj.taxId : DEFAULT_BRANDING.taxId,
    managerTitleAr:
      typeof obj.managerTitleAr === 'string' && obj.managerTitleAr.trim()
        ? obj.managerTitleAr
        : DEFAULT_BRANDING.managerTitleAr,
    fontFamily:
      fontCandidate && VALID_FONTS.has(fontCandidate) ? fontCandidate : DEFAULT_BRANDING.fontFamily,
    footerNote: typeof obj.footerNote === 'string' ? obj.footerNote : DEFAULT_BRANDING.footerNote,
  };
}

function loadStoredBranding(): BrandingSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_BRANDING };
  try {
    const raw = window.localStorage.getItem(BRANDING_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_BRANDING };
    return sanitizeBranding(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_BRANDING };
  }
}

function applyBrandingFontToDocument(fontFamily: AppFontChoice) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (fontFamily === 'Cairo') {
    root.style.setProperty('--font-display', "'Cairo', 'IBM Plex Sans Arabic', system-ui, sans-serif");
    root.style.setProperty('--font-sans', "'IBM Plex Sans Arabic', 'Cairo', system-ui, sans-serif");
    root.style.fontFamily = '';
  } else {
    const stack = `'${fontFamily}', 'Cairo', 'IBM Plex Sans Arabic', system-ui, sans-serif`;
    root.style.setProperty('--font-display', stack);
    root.style.setProperty('--font-sans', stack);
    root.style.fontFamily = stack;
  }
}

export function getHeaderBrandName(branding: BrandingSettings): string {
  const name = branding.businessNameAr.trim();
  if (!name || name === DEFAULT_BRANDING.businessNameAr) {
    return 'الوليد ترافيل';
  }
  return name;
}

export function buildWhatsappHref(phoneInput: string, businessNameAr: string): string {
  const digitsOnly = (phoneInput || DEFAULT_BRANDING.phone).replace(/\D/g, '');
  const normalized =
    digitsOnly.startsWith('0') && digitsOnly.length === 11
      ? `2${digitsOnly}`
      : digitsOnly || '201016815939';
  const greeting = encodeURIComponent(`مرحباً إدارة ${businessNameAr || 'الوليد ترافيل'}`);
  return `https://wa.me/${normalized}?text=${greeting}`;
}

interface BrandingContextValue {
  branding: BrandingSettings;
  defaultLogoSrc: string;
  headerBrandName: string;
  updateBranding: (patch: Partial<BrandingSettings>) => void;
  resetLogo: () => void;
  resetAllBranding: () => void;
}

const BrandingContext = createContext<BrandingContextValue>({
  branding: DEFAULT_BRANDING,
  defaultLogoSrc: defaultBrandLogoImg,
  headerBrandName: 'الوليد ترافيل',
  updateBranding: () => undefined,
  resetLogo: () => undefined,
  resetAllBranding: () => undefined,
});

export const BrandingProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [branding, setBranding] = useState<BrandingSettings>(() => loadStoredBranding());

  useEffect(() => {
    applyBrandingFontToDocument(branding.fontFamily);
  }, [branding.fontFamily]);

  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === BRANDING_STORAGE_KEY) {
        setBranding(loadStoredBranding());
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const persistBranding = useCallback((next: BrandingSettings) => {
    setBranding(next);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(BRANDING_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore storage quota errors gracefully
      }
    }
  }, []);

  const updateBranding = useCallback(
    (patch: Partial<BrandingSettings>) => {
      setBranding((prev) => {
        const merged: BrandingSettings = {
          ...prev,
          ...patch,
          fontFamily:
            patch.fontFamily && VALID_FONTS.has(patch.fontFamily)
              ? patch.fontFamily
              : prev.fontFamily,
        };
        if (typeof window !== 'undefined') {
          try {
            window.localStorage.setItem(BRANDING_STORAGE_KEY, JSON.stringify(merged));
          } catch {
            // ignore storage errors
          }
        }
        return merged;
      });
    },
    []
  );

  const resetLogo = useCallback(() => {
    updateBranding({ logoUrl: '' });
  }, [updateBranding]);

  const resetAllBranding = useCallback(() => {
    const fresh = { ...DEFAULT_BRANDING };
    persistBranding(fresh);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem(BRANDING_STORAGE_KEY);
      } catch {
        // ignore
      }
    }
  }, [persistBranding]);

  const value = useMemo<BrandingContextValue>(
    () => ({
      branding,
      defaultLogoSrc: defaultBrandLogoImg,
      headerBrandName: getHeaderBrandName(branding),
      updateBranding,
      resetLogo,
      resetAllBranding,
    }),
    [branding, updateBranding, resetLogo, resetAllBranding]
  );

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
};

export function useBranding(): BrandingContextValue {
  return useContext(BrandingContext);
}
