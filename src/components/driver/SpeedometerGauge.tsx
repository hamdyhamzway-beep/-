import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Gauge as GaugeIcon, ShieldCheck, Zap } from 'lucide-react';
import { speakArabicText, isSpeechSynthesisAvailable } from '../../lib/background-notifications';

interface SpeedometerGaugeProps {
  currentSpeed: number; // km/h
  speedLimit?: number; // km/h, default 100
  maxSpeed?: number; // km/h
  className?: string;
  allowSimulation?: boolean;
}

function playSoftAlertBeep() {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    const audioCtx = new AudioContextClass();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(659.25, audioCtx.currentTime); // E5 note
    gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.35);
  } catch {
    // Ignored if audio blocked
  }
}

export const SpeedometerGauge: React.FC<SpeedometerGaugeProps> = ({
  currentSpeed: externalSpeed,
  speedLimit = 100, // Updated default to 100 km/h as requested
  maxSpeed: externalMaxSpeed = 0,
  className = '',
  allowSimulation = true,
}) => {
  const [simSpeed, setSimSpeed] = useState<number | null>(null);
  const speed = simSpeed !== null ? simSpeed : Math.max(0, externalSpeed);
  const maxSpeed = Math.max(speed, externalMaxSpeed);

  const lastBeepRef = useRef<number>(0);

  const isOverLimit = speed > speedLimit;
  const isNearLimit = speed >= speedLimit * 0.85 && !isOverLimit;

  // Trigger soft beep & voice warning when exceeding speed limit (throttled to every 4s)
  useEffect(() => {
    if (isOverLimit) {
      const now = Date.now();
      if (now - lastBeepRef.current > 4000) {
        lastBeepRef.current = now;
        playSoftAlertBeep();
        if (isSpeechSynthesisAvailable()) {
          speakArabicText(`تنبيه: تجاوزت سرعة مئة كيلومتر في الساعة. سرعتك الحالية ${Math.round(speed)}`, {
            rate: 1.0,
          });
        }
      }
    }
  }, [isOverLimit, speed]);

  // Max scale for gauge (e.g. 160 km/h)
  const maxScale = 160;
  const clampedSpeed = Math.min(speed, maxScale);
  const percentage = clampedSpeed / maxScale;

  // SVG arc calculation (semi-circle or 240-degree arc)
  const radius = 70;
  const strokeWidth = 12;
  const circ = 2 * Math.PI * radius;
  const arcLength = circ * 0.75;
  const strokeDashoffset = arcLength - percentage * arcLength;

  // Status color: Red when exceeding 100 km/h
  const statusColor = isOverLimit
    ? 'text-red-600 stroke-red-600 animate-pulse'
    : isNearLimit
    ? 'text-amber-500 stroke-amber-500'
    : 'text-[#C89B3C] stroke-[#C89B3C]';

  return (
    <div
      className={`rounded-2xl bg-gradient-to-b from-[#0B1F3A] to-[#13325c] text-white p-5 shadow-lg border transition-colors duration-300 ${
        isOverLimit ? 'border-red-500 shadow-red-500/20 ring-2 ring-red-500/40' : 'border-[#C89B3C]/30'
      } ${className}`}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
              isOverLimit ? 'bg-red-600 text-white animate-bounce' : 'bg-white/10 text-[#C89B3C]'
            }`}
          >
            <GaugeIcon className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-xs font-bold text-slate-200">عداد السرعة البصري مع التحذير الآلي</h3>
            <p className="text-[10px] text-slate-400">الحد الأقصى المحدد: {speedLimit} كم/س</p>
          </div>
        </div>

        {/* Speed Limit Badge */}
        <div
          className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ${
            isOverLimit
              ? 'bg-red-600 text-white border-red-400 animate-pulse'
              : 'bg-white/10 border-white/20 text-white'
          }`}
        >
          <ShieldCheck className="w-3.5 h-3.5 text-[#C89B3C]" />
          <span>الحد الأقصى: {speedLimit} كم/س</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-center py-2">
        {/* SVG Gauge Dial */}
        <div className="flex flex-col items-center justify-center relative">
          <div className="relative w-44 h-44 flex items-center justify-center">
            <svg className="w-full h-full transform -rotate-225" viewBox="0 0 160 160">
              {/* Background Track */}
              <circle
                cx="80"
                cy="80"
                r={radius}
                fill="none"
                stroke="rgba(255,255,255,0.1)"
                strokeWidth={strokeWidth}
                strokeDasharray={arcLength}
                strokeLinecap="round"
              />
              {/* Progress Arc - Turns red when exceeding limit */}
              <circle
                cx="80"
                cy="80"
                r={radius}
                fill="none"
                className={`transition-all duration-300 ease-out ${statusColor}`}
                strokeWidth={strokeWidth}
                strokeDasharray={arcLength}
                strokeDashoffset={strokeDashoffset}
                strokeLinecap="round"
              />
            </svg>

            {/* Inner Content Readout */}
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
              <span className="text-[10px] uppercase tracking-widest text-slate-300 font-semibold">
                السرعة الحالية
              </span>
              <span
                className={`text-3xl sm:text-4xl font-bold font-mono tabular-nums my-0.5 ${
                  isOverLimit ? 'text-red-400 animate-pulse' : 'text-white'
                }`}
              >
                {Math.round(speed)}
              </span>
              <span className="text-[11px] text-[#C89B3C] font-bold">كم / ساعة</span>
            </div>
          </div>

          {/* Min / Max Tick Labels */}
          <div className="flex justify-between w-40 text-[10px] text-slate-400 font-mono mt-1 px-2">
            <span>0</span>
            <span>80</span>
            <span>160+</span>
          </div>
        </div>

        {/* Speed Stats & Alerts */}
        <div className="md:col-span-2 space-y-3">
          {/* Over Speed Warning Banner */}
          {isOverLimit ? (
            <div className="rounded-xl border border-red-500 bg-red-600/30 p-3 text-xs text-red-100 flex items-center gap-2.5 animate-pulse shadow-lg">
              <AlertTriangle className="w-6 h-6 text-red-400 shrink-0" />
              <div>
                <span className="font-bold block text-sm">تنبيه خطر: تجاوز حد السرعة (100 كم/س)!</span>
                <span>أنت تسير بسرعة {Math.round(speed)} كم/س. يرجى خفض السرعة فورا للحفاظ على السلامة.</span>
              </div>
            </div>
          ) : isNearLimit ? (
            <div className="rounded-xl border border-amber-400/40 bg-amber-500/20 p-3 text-xs text-amber-200 flex items-center gap-2.5">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
              <div>
                <span className="font-bold block">تحذير اقتراب من الحد الأقصى (100 كم/س)</span>
                <span>حافظ على هدوء القيادة والتزم بالسرعة المسموحة</span>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/15 p-3 text-xs text-emerald-200 flex items-center gap-2.5">
              <Zap className="w-4 h-4 text-emerald-400 shrink-0" />
              <div>
                <span className="font-bold block">السرعة ضمن المعدل الآمن</span>
                <span>شكراً لالتزامك بقواعد السلامة المرورية</span>
              </div>
            </div>
          )}

          {/* Stats Grid */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-white/5 border border-white/10 p-3">
              <p className="text-[11px] text-slate-400">أقصى سرعة مسجلة بالرحلة</p>
              <p className="text-xl font-bold font-mono tabular-nums text-[#C89B3C] mt-0.5">
                {Math.round(maxSpeed)} <span className="text-xs text-slate-300">كم/س</span>
              </p>
            </div>
            <div className="rounded-xl bg-white/5 border border-white/10 p-3">
              <p className="text-[11px] text-slate-400">حالة نظام التحذير الآلي</p>
              <p className="text-sm font-bold text-emerald-400 mt-1 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span>
                <span>نشط (حد 100 كم/س)</span>
              </p>
            </div>
          </div>

          {/* Browser Preview Simulation Slider */}
          {allowSimulation && (
            <div className="pt-2 border-t border-white/10">
              <div className="flex items-center justify-between text-xs text-slate-300 mb-1">
                <span>محاكاة السرعة (تجربة الإنذار عند تجاوز 100 كم/س):</span>
                <span className={`font-mono font-bold ${isOverLimit ? 'text-red-400' : 'text-[#C89B3C]'}`}>
                  {Math.round(speed)} كم/س
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="160"
                step="5"
                value={speed}
                onChange={(e) => setSimSpeed(Number(e.target.value))}
                className={`w-full cursor-pointer h-2 rounded-lg accent-${isOverLimit ? 'red' : '[#C89B3C]'}`}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
