import React from 'react';
import { User } from 'lucide-react';

interface DriverAvatarProps {
  name?: string | null;
  photoUrl?: string | null;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  variant?: 'light' | 'dark';
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<DriverAvatarProps['size']>, string> = {
  xs: 'w-7 h-7 text-[10px]',
  sm: 'w-9 h-9 text-xs',
  md: 'w-11 h-11 text-sm',
  lg: 'w-14 h-14 text-base',
  xl: 'w-20 h-20 text-xl',
};

function getInitials(name?: string | null): string {
  const clean = (name || '').trim();
  if (!clean) return '';
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2);
  return `${parts[0][0] || ''}${parts[1][0] || ''}`;
}

export const DriverAvatar: React.FC<DriverAvatarProps> = ({
  name,
  photoUrl,
  size = 'sm',
  variant = 'light',
  className = '',
}) => {
  const sizeClass = SIZE_CLASSES[size];
  const initials = getInitials(name);

  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt={name || 'صورة السائق'}
        className={`${sizeClass} rounded-full object-cover shrink-0 border ${
          variant === 'dark' ? 'border-[#C89B3C]/60' : 'border-slate-200'
        } ${className}`}
      />
    );
  }

  return (
    <div
      aria-label={name || 'صورة السائق'}
      className={`${sizeClass} rounded-full flex items-center justify-center font-bold shrink-0 border ${
        variant === 'dark'
          ? 'bg-white/10 text-[#C89B3C] border-[#C89B3C]/40'
          : 'bg-[#0B1F3A]/10 text-[#0B1F3A] border-slate-200'
      } ${className}`}
    >
      {initials || <User className="w-4 h-4" />}
    </div>
  );
};
