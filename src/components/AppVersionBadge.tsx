import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { checkForAppUpdate, getAppVersionInfo } from '../lib/pwa-update';

interface AppVersionBadgeProps {
  variant?: 'light' | 'dark';
  className?: string;
}

export const AppVersionBadge: React.FC<AppVersionBadgeProps> = ({
  variant = 'light',
  className = '',
}) => {
  const { version, formattedBuildTime } = getAppVersionInfo();
  const [checking, setChecking] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const handleCheckUpdate = async () => {
    if (checking) return;
    setChecking(true);
    setStatusMessage(null);
    try {
      const result = await checkForAppUpdate();
      if (result === 'offline') {
        setStatusMessage('لا يوجد اتصال بالإنترنت');
      } else if (result === 'up-to-date' || result === 'unsupported') {
        setStatusMessage('أنت على آخر نسخة');
      } else if (result === 'update-available') {
        setStatusMessage('يتوفر تحديث جديد');
      }
    } finally {
      setChecking(false);
      window.setTimeout(() => {
        setStatusMessage((prev) => (prev ? null : prev));
      }, 4500);
    }
  };

  const isDark = variant === 'dark';

  return (
    <div
      dir="rtl"
      className={`text-[11px] leading-relaxed ${
        isDark ? 'text-slate-300' : 'text-slate-600'
      } ${className}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2.5 gap-y-1">
        <span className="tabular-nums">
          النسخة {version} · بتاريخ {formattedBuildTime}
        </span>

        <button
          type="button"
          disabled={checking}
          onClick={handleCheckUpdate}
          className={`inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] font-semibold transition-colors cursor-pointer disabled:opacity-50 ${
            isDark
              ? 'text-slate-200 hover:text-white hover:bg-white/10 border border-white/15'
              : 'text-[#0B1F3A] hover:bg-slate-100 border border-slate-300 bg-white'
          }`}
        >
          <RefreshCw className={`w-3 h-3 ${checking ? 'animate-spin' : ''}`} />
          {checking ? 'جاري الفحص...' : 'التحقق من تحديث'}
        </button>
      </div>

      {statusMessage && (
        <div
          className={`mt-1 text-[11px] font-semibold ${
            isDark ? 'text-[#ebd089]' : 'text-[#0B1F3A]'
          }`}
        >
          {statusMessage}
        </div>
      )}
    </div>
  );
};
