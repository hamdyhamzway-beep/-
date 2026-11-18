import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  Sun,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  isSpeechSynthesisAvailable,
  speakArabicText,
  stopArabicSpeech,
} from '../lib/background-notifications';
import spiritualEntriesData from '../data/spiritualLibrary.json';

interface SpiritualEntry {
  id: number;
  verse: string;
  surah: string;
  hadith: string;
  hadithSource: string;
}

const MORNING_SPIRITUAL_ENTRIES: SpiritualEntry[] = spiritualEntriesData;

function getDayOfYear(date: Date = new Date()): number {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date.getTime() - start.getTime();
  return Math.floor(diff / 86_400_000);
}

export const MorningSpiritualRibbon: React.FC<{
  compact?: boolean;
  className?: string;
}> = ({ compact = false, className = '' }) => {
  const [nowDate, setNowDate] = useState<Date>(() => new Date());
  const [autoCycle, setAutoCycle] = useState(true);
  const [speaking, setSpeaking] = useState(false);

  const initialIndex = useMemo(
    () => getDayOfYear(nowDate) % MORNING_SPIRITUAL_ENTRIES.length,
    [nowDate.toDateString()]
  );
  const [offset, setOffset] = useState(0);

  // Re-evaluate date daily
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowDate(new Date());
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Automatically cycle verses & hadiths smoothly
  useEffect(() => {
    if (!autoCycle) return;
    const timer = window.setInterval(() => {
      setOffset((prev) => prev + 1);
    }, 45_000);
    return () => window.clearInterval(timer);
  }, [autoCycle]);

  useEffect(() => {
    return () => {
      stopArabicSpeech();
    };
  }, []);

  const currentIdx = (initialIndex + offset) % MORNING_SPIRITUAL_ENTRIES.length;
  const entry = MORNING_SPIRITUAL_ENTRIES[currentIdx];
  const canSpeak = isSpeechSynthesisAvailable();

  const handleToggleSpeech = () => {
    if (speaking) {
      stopArabicSpeech();
      setSpeaking(false);
      return;
    }
    const cleanVerse = entry.verse.replace(/[﴿﴾۝]/g, '');
    const cleanHadith = entry.hadith.replace(/[«»]/g, '');
    setSpeaking(true);
    const ok = speakArabicText(
      `آية اليوم من ${entry.surah}: ${cleanVerse}. والحديث الشريف: ${cleanHadith}`,
      {
        rate: 0.9,
        onEnd: () => setSpeaking(false),
      }
    );
    if (!ok) setSpeaking(false);
  };

  const handlePrev = () => {
    setOffset(
      (prev) => (prev - 1 + MORNING_SPIRITUAL_ENTRIES.length) % MORNING_SPIRITUAL_ENTRIES.length
    );
  };

  const handleNext = () => {
    setOffset((prev) => (prev + 1) % MORNING_SPIRITUAL_ENTRIES.length);
  };

  return (
    <section
      aria-label="آيات قرآنية وأحاديث نبوية صباحية"
      className={`rounded-2xl border border-[#C89B3C]/35 bg-gradient-to-l from-[#fffdf7] via-white to-[#f8fafc] shadow-sm ${
        compact ? 'p-3.5 sm:p-4' : 'p-4 sm:p-5'
      } transition-opacity duration-300 ${className}`}
    >
      {/* Clean Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-100">
        <div className="flex items-center gap-2 min-w-0">
          <Sun className="w-4 h-4 text-[#C89B3C] shrink-0" />
          <h2 className="font-display text-sm font-bold text-[#0B1F3A]">
            نفحات الصباح · آية وحديث متجدد
          </h2>
          <span className="text-slate-300 hidden sm:inline" aria-hidden="true">
            ·
          </span>
          <span className="text-[11px] text-slate-500 hidden sm:inline">
            مكتبة متجددة يومياً تبريكاً لبيئة العمل
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {canSpeak && (
            <button
              type="button"
              onClick={handleToggleSpeech}
              title={speaking ? 'إيقاف القراءة' : 'استماع للآية والحديث'}
              className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-semibold cursor-pointer transition-colors whitespace-nowrap ${
                speaking
                  ? 'border-[#0B1F3A] bg-[#0B1F3A] text-white'
                  : 'border-slate-200 bg-white text-[#0B1F3A] hover:bg-slate-50'
              }`}
            >
              {speaking ? (
                <>
                  <VolumeX className="w-3.5 h-3.5 text-[#C89B3C]" />
                  <span>إيقاف</span>
                </>
              ) : (
                <>
                  <Volume2 className="w-3.5 h-3.5 text-[#C89B3C]" />
                  <span>استماع</span>
                </>
              )}
            </button>
          )}
          <button
            type="button"
            onClick={() => setAutoCycle((prev) => !prev)}
            title={autoCycle ? 'إيقاف التبديل التلقائي' : 'تشغيل التبديل التلقائي'}
            className="p-1.5 rounded-lg border border-slate-200 bg-white text-slate-600 hover:text-[#0B1F3A] cursor-pointer"
          >
            {autoCycle ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={handlePrev}
            aria-label="السابق"
            className="p-1.5 rounded-lg border border-slate-200 bg-white text-slate-600 hover:text-[#0B1F3A] cursor-pointer"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleNext}
            aria-label="التالي"
            className="p-1.5 rounded-lg border border-slate-200 bg-white text-slate-600 hover:text-[#0B1F3A] cursor-pointer"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Flowing Verse & Hadith Content (Hairline Split, Zero Nested Cards) */}
      <div className="mt-3.5 grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold text-[#C89B3C]">من الذكر الحكيم</p>
          <p className="font-display text-base sm:text-[17px] font-bold text-[#0B1F3A] leading-loose">
            {entry.verse}
          </p>
          <p className="text-[11px] text-slate-500">{entry.surah}</p>
        </div>

        <div className="space-y-1.5 pt-3 border-t border-slate-100 lg:pt-0 lg:border-t-0 lg:border-r lg:pr-6">
          <p className="text-[11px] font-semibold text-emerald-700">من الهدي النبوي الشريف</p>
          <p className="text-sm sm:text-[15px] font-semibold text-slate-800 leading-relaxed">
            {entry.hadith}
          </p>
          <p className="text-[11px] text-slate-500">{entry.hadithSource}</p>
        </div>
      </div>
    </section>
  );
};
