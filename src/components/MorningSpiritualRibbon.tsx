import React, { useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
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

interface SpiritualEntry {
  verse: string;
  surah: string;
  hadith: string;
  hadithSource: string;
}

const MORNING_SPIRITUAL_ENTRIES: SpiritualEntry[] = [
  {
    verse: '﴿سُبْحَانَ الَّذِي سَخَّرَ لَنَا هَٰذَا وَمَا كُنَّا لَهُ مُقْرِنِينَ ۝ وَإِنَّا إِلَىٰ رَبِّنَا لَمُنقَلِبُونَ﴾',
    surah: 'سورة الزخرف · الآية ١٣–١٤',
    hadith: '«اللَّهُمَّ بَارِكْ لأُمَّتِي فِي بُكُورِهَا»',
    hadithSource: 'حديث صحيح · رواه الترمذي وأبو داود',
  },
  {
    verse: '﴿فَإِذَا عَزَمْتَ فَتَوَكَّلْ عَلَى اللَّهِ إِنَّ اللَّهَ يُحِبُّ الْمُتَوَكِّلِينَ﴾',
    surah: 'سورة آل عمران · الآية ١٥٩',
    hadith: '«مَنْ سَلَكَ طَرِيقًا يَلْتَمِسُ فِيهِ عِلْمًا سَهَّلَ اللَّهُ لَهُ بِهِ طَرِيقًا إِلَى الْجَنَّةِ»',
    hadithSource: 'رواه مسلم',
  },
  {
    verse: '﴿وَقُل رَّبِّ أَدْخِلْنِي مُدْخَلَ صِدْقٍ وَأَخْرِجْنِي مُخْرَجَ صِدْقٍ وَاجْعَل لِّي مِن لَّدُنكَ سُلْطَانًا نَّصِيرًا﴾',
    surah: 'سورة الإسراء · الآية ٨٠',
    hadith: '«مَا أَكَلَ أَحَدٌ طَعَامًا قَطُّ خَيْرًا مِنْ أَنْ يَأْكُلَ مِنْ عَمَلِ يَدِهِ»',
    hadithSource: 'رواه البخاري',
  },
  {
    verse: '﴿وَمَن يَتَّقِ اللَّهَ يَجْعَل لَّهُ مَخْرَجًا ۝ وَيَرْزُقْهُ مِنْ حَيْثُ لَا يَحْتَسِبُ﴾',
    surah: 'سورة الطلاق · الآية ٢–٣',
    hadith: '«إِنَّ اللَّهَ يُحِبُّ إِذَا عَمِلَ أَحَدُكُمْ عَمَلًا أَنْ يُتْقِنَهُ»',
    hadithSource: 'حديث حسن · رواه البيهقي وأبو يعلى',
  },
  {
    verse: '﴿إِنَّ خَيْرَ مَنِ اسْتَأْجَرْتَ الْقَوِيُّ الْأَمِينُ﴾',
    surah: 'سورة القصص · الآية ٢٦',
    hadith: '«كُلُّكُمْ رَاعٍ وَكُلُّكُمْ مَسْئُولٌ عَنْ رَعِيَّتِهِ»',
    hadithSource: 'متفق عليه · رواه البخاري ومسلم',
  },
  {
    verse: '﴿وَقُلِ اعْمَلُوا فَسَيَرَى اللَّهُ عَمَلَكُمْ وَرَسُولُهُ وَالْمُؤْمِنُونَ﴾',
    surah: 'سورة التوبة · الآية ١٠٥',
    hadith: '«إِنَّ الرِّفْقَ لَا يَكُونُ فِي شَيْءٍ إِلَّا زَانَهُ، وَلَا يُنْزَعُ مِنْ شَيْءٍ إِلَّا شَانَهُ»',
    hadithSource: 'رواه مسلم',
  },
  {
    verse: '﴿أَلَا بِذِكْرِ اللَّهِ تَطْمَئِنُّ الْقُلُوبُ﴾',
    surah: 'سورة الرعد · الآية ٢٨',
    hadith: '«مَن صَلَّى البَرْدَيْنِ دَخَلَ الجَنَّةَ»',
    hadithSource: 'متفق عليه · رواه البخاري ومسلم',
  },
  {
    verse: '﴿رَبَّنَا آتِنَا مِن لَّدُنكَ رَحْمَةً وَهَيِّئْ لَنَا مِنْ أَمْرِنَا رَشَدًا﴾',
    surah: 'سورة الكهف · الآية ١٠',
    hadith: '«خَيْرُ النَّاسِ أَنْفَعُهُمْ لِلنَّاسِ»',
    hadithSource: 'حديث حسن · رواه الطبراني',
  },
  {
    verse: '﴿وَاصْبِرْ فَإِنَّ اللَّهَ لَا يُضِيعُ أَجْرَ الْمُحْسِنِينَ﴾',
    surah: 'سورة هود · الآية ١١٥',
    hadith: '«احْفَظِ اللَّهَ يَحْفَظْكَ، احْفَظِ اللَّهَ تَجِدْهُ تُجَاهَكَ»',
    hadithSource: 'حديث حسن صحيح · رواه الترمذي',
  },
  {
    verse: '﴿فَاذْكُرُونِي أَذْكُرْكُمْ وَاشْكُرُوا لِي وَلَا تَكْفُرُونِ﴾',
    surah: 'سورة البقرة · الآية ١٥٢',
    hadith: '«التَّاجِرُ الصَّدُوقُ الأَمِينُ مَعَ النَّبِيِّينَ وَالصِّدِّيقِينَ وَالشُّهَدَاءِ»',
    hadithSource: 'رواه الترمذي',
  },
];

const MORNING_START_HOUR = 4; // 04:00 AM
const MORNING_END_HOUR = 12; // 12:00 PM

function isMorningHours(date: Date = new Date()): boolean {
  const hour = date.getHours();
  return hour >= MORNING_START_HOUR && hour < MORNING_END_HOUR;
}

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
  const isMorning = isMorningHours(nowDate);
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const [autoCycle, setAutoCycle] = useState(true);
  const [speaking, setSpeaking] = useState(false);

  const initialIndex = useMemo(
    () => getDayOfYear(nowDate) % MORNING_SPIRITUAL_ENTRIES.length,
    [nowDate.toDateString()]
  );
  const [offset, setOffset] = useState(0);

  // Re-evaluate local time every minute so morning banner blooms open automatically at 04:00 AM
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowDate(new Date());
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Automatically cycle verses & hadiths smoothly when expanded
  const isExpanded = manualOpen !== null ? manualOpen : isMorning;

  useEffect(() => {
    if (!isExpanded || !autoCycle) return;
    const timer = window.setInterval(() => {
      setOffset((prev) => prev + 1);
    }, 45_000);
    return () => window.clearInterval(timer);
  }, [isExpanded, autoCycle]);

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

  if (!isExpanded) {
    return (
      <div
        className={`flex items-center justify-between gap-3 rounded-xl border border-[#C89B3C]/30 bg-white/85 px-4 py-2.5 text-xs ${className}`}
      >
        <div className="flex items-center gap-2 min-w-0 text-slate-700">
          <BookOpen className="w-4 h-4 text-[#C89B3C] shrink-0" />
          <span className="font-semibold text-[#0B1F3A] truncate">
            نفحات الصباح · آيات قرآنية وأحاديث نبوية
          </span>
          <span className="hidden sm:inline text-slate-400">·</span>
          <span className="hidden sm:inline text-slate-500 truncate">
            تظهر تلقائياً في ساعات الصباح (٤:٠٠ ص – ١٢:٠٠ م)
          </span>
        </div>
        <button
          type="button"
          onClick={() => setManualOpen(true)}
          className="text-xs font-bold text-[#0B1F3A] hover:text-[#C89B3C] whitespace-nowrap shrink-0 cursor-pointer"
        >
          عرض الآن
        </button>
      </div>
    );
  }

  return (
    <section
      aria-label="آيات قرآنية وأحاديث نبوية صباحية"
      className={`rounded-2xl border border-[#C89B3C]/35 bg-gradient-to-l from-[#fffdf7] via-white to-[#f8fafc] ${
        compact ? 'p-4' : 'p-5'
      } transition-opacity duration-300 ${className}`}
    >
      {/* Clean Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-100">
        <div className="flex items-center gap-2 min-w-0">
          <Sun className="w-4 h-4 text-[#C89B3C] shrink-0" />
          <h2 className="font-display text-sm font-bold text-[#0B1F3A]">
            {isMorning ? 'إشراقة الصباح · آية وحديث' : 'نفحات الذكر · آية وحديث'}
          </h2>
          <span className="text-slate-300 hidden sm:inline" aria-hidden="true">
            ·
          </span>
          <span className="text-[11px] text-slate-500 hidden sm:inline">
            بداية مباركة ليوم العمل
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
          <button
            type="button"
            onClick={() => {
              stopArabicSpeech();
              setSpeaking(false);
              setManualOpen(false);
            }}
            className="px-2 py-1 text-[11px] font-semibold text-slate-500 hover:text-[#0B1F3A] cursor-pointer"
          >
            طيّ
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
