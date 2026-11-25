import React, { useEffect, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import {
  PWA_NEED_REFRESH_EVENT,
  applyAppUpdate,
  hasWaitingUpdate,
} from '../lib/pwa-update';

interface UpdateBannerProps {
  hasBottomNav?: boolean;
}

export const UpdateBanner: React.FC<UpdateBannerProps> = ({ hasBottomNav = false }) => {
  const [visible, setVisible] = useState(() => hasWaitingUpdate());
  const [dismissed, setDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    if (hasWaitingUpdate()) {
      setVisible(true);
    }

    const onNeedRefresh = (event: Event) => {
      const custom = event as CustomEvent<{ forceShow?: boolean }>;
      setVisible(true);
      if (custom.detail?.forceShow) {
        setDismissed(false);
      }
    };

    window.addEventListener(PWA_NEED_REFRESH_EVENT, onNeedRefresh);
    return () => {
      window.removeEventListener(PWA_NEED_REFRESH_EVENT, onNeedRefresh);
    };
  }, []);

  if (!visible || dismissed) {
    return null;
  }

  const handleUpdateClick = async () => {
    if (updating) return;
    setUpdating(true);
    try {
      await applyAppUpdate();
    } catch {
      setUpdating(false);
    }
  };

  const bottomPositionClass = hasBottomNav
    ? 'bottom-[calc(4.75rem+env(safe-area-inset-bottom))]'
    : 'bottom-[calc(1rem+env(safe-area-inset-bottom))]';

  return (
    <div
      dir="rtl"
      role="status"
      aria-live="polite"
      className={`fixed ${bottomPositionClass} inset-x-3 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 sm:w-full sm:max-w-md z-[70] no-print`}
    >
      <div className="flex items-center justify-between gap-3 rounded-2xl bg-[#0B1F3A] text-white border border-[#C89B3C]/50 shadow-2xl px-4 py-3 font-display">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-[#C89B3C]/15 border border-[#C89B3C]/40 flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4 text-[#C89B3C]" />
          </div>
          <span className="text-sm font-bold text-white truncate">فيه تحديث جديد</span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={updating}
            onClick={handleUpdateClick}
            className="inline-flex items-center gap-1.5 rounded-xl bg-[#C89B3C] hover:bg-[#d8ac4e] text-[#0B1F3A] px-3.5 py-2 text-xs font-bold shadow-sm disabled:opacity-60 cursor-pointer whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${updating ? 'animate-spin' : ''}`} />
            {updating ? 'جاري التحديث...' : 'اضغط للتحديث'}
          </button>

          <button
            type="button"
            disabled={updating}
            onClick={() => setDismissed(true)}
            className="rounded-xl border border-white/20 bg-white/5 hover:bg-white/15 px-3 py-2 text-xs font-semibold text-slate-200 disabled:opacity-50 cursor-pointer whitespace-nowrap"
          >
            بعدين
          </button>
        </div>
      </div>
    </div>
  );
};
