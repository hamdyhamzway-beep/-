import React from 'react';
import splashScreenImg from '../assets/images/alwaleed_splash_screen_1794752422708.jpg';
import travelBackdropImg from '../assets/images/alwaleed_travel_backdrop_1794752421692.jpg';

interface AppLogoBackdropProps {
  /** Offsets the centered logo on desktop when the fixed right-side admin sidebar is visible */
  withSidebarOffset?: boolean;
}

export const AppLogoBackdrop: React.FC<AppLogoBackdropProps> = ({
  withSidebarOffset = false,
}) => {
  return (
    <div
      aria-hidden="true"
      className={`fixed inset-y-0 left-0 right-0 ${
        withSidebarOffset ? 'lg:right-64' : ''
      } z-0 pointer-events-none select-none overflow-hidden no-print flex items-center justify-center bg-[#e8edf5]`}
    >
      {/* Subtle full-bleed dark slate & gold topographic map texture */}
      <img
        src={travelBackdropImg}
        alt=""
        referrerPolicy="no-referrer"
        className="absolute inset-0 w-full h-full object-cover opacity-[0.12]"
      />

      {/* Clearly visible centered AL WALEED TRAVEL medallion logo watermark */}
      <div className="relative w-[310px] h-[310px] sm:w-[440px] sm:h-[440px] lg:w-[520px] lg:h-[520px] rounded-full overflow-hidden opacity-[0.26] ring-2 ring-[#C89B3C]/30 shadow-2xl">
        <img
          src={splashScreenImg}
          alt=""
          referrerPolicy="no-referrer"
          className="w-full h-full object-cover object-center scale-110"
        />
      </div>
    </div>
  );
};
