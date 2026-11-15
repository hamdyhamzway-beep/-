import React from 'react';
import splashScreenImg from '../assets/images/alwaleed_splash_screen_1794752422708.jpg';
import travelBackdropImg from '../assets/images/alwaleed_travel_backdrop_1794752421692.jpg';

interface SplashScreenProps {
  message?: string;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({
  message = 'جاري التحقق من الجلسة وتجهيز المنصة...',
}) => {
  return (
    <div className="fixed inset-0 z-50 bg-[#0B1F3A] text-white flex flex-col items-center justify-center overflow-hidden">
      {/* Desktop Widescreen Minimalist Map Backdrop */}
      <img
        src={travelBackdropImg}
        alt="AL WALEED TRAVEL Background"
        referrerPolicy="no-referrer"
        className="hidden md:block absolute inset-0 w-full h-full object-cover opacity-40 pointer-events-none select-none"
      />
      <div className="hidden md:block absolute inset-0 bg-gradient-to-b from-[#0B1F3A]/80 via-[#0B1F3A]/60 to-[#0B1F3A]/95 pointer-events-none" />

      {/* Mobile Full-Bleed Splash Screen */}
      <div className="md:hidden absolute inset-0">
        <img
          src={splashScreenImg}
          alt="AL WALEED TRAVEL Splash Screen"
          referrerPolicy="no-referrer"
          className="w-full h-full object-cover object-center"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#081528] via-transparent to-[#081528]/30" />
      </div>

      {/* Desktop Framed 9:16 Luxury Splash Card */}
      <div className="hidden md:flex relative z-10 w-[340px] h-[590px] rounded-[2rem] border border-[#C89B3C]/35 shadow-2xl overflow-hidden bg-[#0E223D] flex-col justify-end">
        <img
          src={splashScreenImg}
          alt="AL WALEED TRAVEL Mobile Splash"
          referrerPolicy="no-referrer"
          className="absolute inset-0 w-full h-full object-cover object-center"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#081528]/95 via-transparent to-transparent" />
        <div className="relative z-10 px-6 pb-8 text-center space-y-3">
          <div className="w-28 h-1 mx-auto rounded-full bg-white/15 overflow-hidden">
            <div className="h-full w-1/2 rounded-full bg-gradient-to-r from-[#C89B3C] to-[#ebd089] animate-pulse" />
          </div>
          <p className="text-[11px] font-medium text-slate-200 tracking-wide">{message}</p>
        </div>
      </div>

      {/* Mobile Bottom Loading Strip */}
      <div className="md:hidden fixed bottom-10 inset-x-0 z-10 px-8 text-center space-y-3">
        <div className="w-32 h-1 mx-auto rounded-full bg-white/15 overflow-hidden">
          <div className="h-full w-1/2 rounded-full bg-gradient-to-r from-[#C89B3C] to-[#ebd089] animate-pulse" />
        </div>
        <p className="text-xs font-medium text-slate-200 tracking-wide">{message}</p>
      </div>
    </div>
  );
};
