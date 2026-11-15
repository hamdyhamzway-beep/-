import React, { useState } from 'react';
import { Bus } from 'lucide-react';
import brandLogoImg from '../assets/images/alwaleed_splash_screen_1794752422708.jpg';

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
  const [imgFailed, setImgFailed] = useState(false);

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
      className={`${SIZE_CLASSES[size]} bg-[#0B1F3A] border border-[#C89B3C]/50 overflow-hidden shrink-0 shadow-xs ${className}`}
    >
      <img
        src={brandLogoImg}
        alt="شعار الوليد ترافيل"
        referrerPolicy="no-referrer"
        onError={() => setImgFailed(true)}
        className="w-full h-full object-cover object-center scale-125"
      />
    </div>
  );
};
