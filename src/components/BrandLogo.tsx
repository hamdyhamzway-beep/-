import React, { useEffect, useState } from 'react';
import { Bus } from 'lucide-react';
import { useBranding } from '../contexts/BrandingContext';

interface BrandLogoProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<BrandLogoProps['size']>, string> = {
  sm: 'w-9 h-9 rounded-lg',
  md: 'w-11 h-11 rounded-xl',
  lg: 'w-14 h-14 rounded-2xl',
  xl: 'w-16 h-16 rounded-2xl',
};

export const BrandLogo: React.FC<BrandLogoProps> = ({ size = 'md', className = '' }) => {
  const { branding, defaultLogoSrc } = useBranding();
  const activeSrc = branding.logoUrl.trim() || defaultLogoSrc;
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
  }, [activeSrc]);

  if (imgFailed) {
    return (
      <div
        className={`${SIZE_CLASSES[size]} bg-[#0B1F3A] border border-[#C89B3C]/40 flex items-center justify-center text-[#C89B3C] shrink-0 ${className}`}
      >
        <Bus className="w-1/2 h-1/2" />
      </div>
    );
  }

  return (
    <div
      className={`${SIZE_CLASSES[size]} bg-[#0B1F3A] border border-[#C89B3C]/50 overflow-hidden shrink-0 shadow-xs flex items-center justify-center ${className}`}
    >
      <img
        src={activeSrc}
        alt={`شعار ${branding.businessNameAr.trim() || 'الوليد ترافيل'}`}
        referrerPolicy="no-referrer"
        onError={() => setImgFailed(true)}
        className="w-full h-full object-contain object-center"
      />
    </div>
  );
};
