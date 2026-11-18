import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  Bell,
  Calendar,
  CheckCircle2,
  Clock,
  FileText,
  Mic,
  MicOff,
  Navigation,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { speakArabicText, isSpeechSynthesisAvailable } from '../../lib/background-notifications';

interface MaintenanceRecord {
  id: string;
  type: string;
  odometer: number;
  cost?: number;
  date: string;
  notes: string;
  status: 'completed' | 'pending';
}

interface LicenseExpiryItem {
  id: string;
  title: string;
  expiryDate: string;
  daysRemaining: number;
  type: 'vehicle_license' | 'driver_license' | 'periodic_maintenance';
}

export const DriverMaintenanceVoiceModule: React.FC<{
  busNumber?: string;
  schoolName?: string;
}> = ({ busNumber = '104', schoolName = 'مدرسة النور الخاصة' }) => {
  const [inputText, setInputText] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [extractedDraft, setExtractedDraft] = useState<{
    type: string;
    odometer: number;
    cost: number;
    notes: string;
  } | null>(null);

  const [maintenanceRecords, setMaintenanceRecords] = useState<MaintenanceRecord[]>([
    {
      id: 'm1',
      type: 'تغيير زيت وفلاتر',
      odometer: 45000,
      cost: 1200,
      date: '2026-11-10',
      notes: 'تم التغيير بالمركز الرئيسي',
      status: 'completed',
    },
    {
      id: 'm2',
      type: 'صيانة دورية وتغيير فرامل',
      odometer: 50000,
      cost: 2500,
      date: '2026-12-05',
      notes: 'موعد الصيانة القادمة',
      status: 'pending',
    },
  ]);

  const [licenses, setLicenses] = useState<LicenseExpiryItem[]>([
    {
      id: 'l1',
      title: 'رخصة تسيير المركبة (الباص)',
      expiryDate: '2026-11-20', // 3 days from mock current date
      daysRemaining: 3,
      type: 'vehicle_license',
    },
    {
      id: 'l2',
      title: 'رخصة قيادة السائق',
      expiryDate: '2026-12-15',
      daysRemaining: 28,
      type: 'driver_license',
    },
    {
      id: 'l3',
      title: 'موعد الصيانة الدورية القادمة',
      expiryDate: '2026-11-19', // 2 days remaining
      daysRemaining: 2,
      type: 'periodic_maintenance',
    },
  ]);

  const [alertTriggered, setAlertTriggered] = useState(false);

  // Check for 2-3 days expiry and trigger proactive voice alert once per session
  useEffect(() => {
    if (alertTriggered) return;
    const urgentItems = licenses.filter((l) => l.daysRemaining <= 3 && l.daysRemaining >= 0);
    if (urgentItems.length > 0 && isSpeechSynthesisAvailable()) {
      const itemNames = urgentItems.map((i) => `${i.title} باقي عليها ${i.daysRemaining} أيام`).join(' و');
      const msg = `تنبيه صوتي عاجل يا كابتن: ${itemNames}. يرجى اتخاذ اللازم فوراً.`;
      speakArabicText(msg, { rate: 0.95 });
      setAlertTriggered(true);
    }
  }, [licenses, alertTriggered]);

  // NLP Smart Extraction function
  const parseMaintenanceText = (text: string) => {
    const clean = text.trim();
    if (!clean) return;

    // Detect type
    let type = 'صيانة دورية عامة';
    if (clean.includes('زيت') || clean.includes('زيت المحرك')) {
      type = 'تغيير زيت المحرك';
    } else if (clean.includes('فلاتر') || clean.includes('فلتر')) {
      type = 'تغيير فلاتر الهواء والزيت';
    } else if (clean.includes('فرامل') || clean.includes('تيل') || clean.includes('طنابير')) {
      type = 'صيانة وتغيير الفرامل';
    } else if (clean.includes('إطارات') || clean.includes('كاوتش') || clean.includes('عجلات')) {
      type = 'تغيير وفحص الإطارات';
    } else if (clean.includes('كهرباء') || clean.includes('بطارية')) {
      type = 'صيانة كهرباء وبطارية';
    }

    // Extract odometer numbers (e.g. 55000 or 55 ألف)
    let odometer = 52000;
    const numMatch = clean.match(/(\d{4,6})/);
    if (numMatch) {
      odometer = parseInt(numMatch[1], 10);
    } else if (clean.includes('ألف')) {
      const alfaMatch = clean.match(/(\d+)\s*ألف/);
      if (alfaMatch) {
        odometer = parseInt(alfaMatch[1], 10) * 1000;
      }
    }

    // Extract cost if mentioned
    let cost = 1000;
    const costMatch = clean.match(/بتكلفة\s*(\d+)|بمبلغ\s*(\d+)|(\d+)\s*جنيه/);
    if (costMatch) {
      cost = parseInt(costMatch[1] || costMatch[2] || costMatch[3], 10);
    }

    setExtractedDraft({
      type,
      odometer,
      cost,
      notes: clean,
    });
  };

  // Handle Speech Recognition
  const handleToggleVoiceRecording = () => {
    const SpeechRecognitionAPI =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognitionAPI) {
      // Fallback simulation for environments without Web Speech API
      setIsListening(true);
      setTimeout(() => {
        setIsListening(false);
        const simulatedText = 'تم تغيير زيت وفلاتر على عداد 55000 كم بتكلفة 1300 جنيه';
        setInputText(simulatedText);
        parseMaintenanceText(simulatedText);
        speakArabicText('تم التعرف على الصوت بنجاح: تغيير زيت وفلاتر', { rate: 0.95 });
      }, 2500);
      return;
    }

    if (isListening) {
      setIsListening(false);
      return;
    }

    try {
      const recognition = new SpeechRecognitionAPI();
      recognition.lang = 'ar-SA';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        setIsListening(true);
      };

      recognition.onresult = (event: any) => {
        const speechResult = event.results[0][0].transcript;
        setInputText(speechResult);
        parseMaintenanceText(speechResult);
        setIsListening(false);
      };

      recognition.onerror = () => {
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognition.start();
    } catch {
      setIsListening(false);
    }
  };

  const handleConfirmSaveDraft = () => {
    if (!extractedDraft) return;
    const newRecord: MaintenanceRecord = {
      id: `m_${Date.now()}`,
      type: extractedDraft.type,
      odometer: extractedDraft.odometer,
      cost: extractedDraft.cost,
      date: new Date().toISOString().split('T')[0],
      notes: extractedDraft.notes,
      status: 'completed',
    };
    setMaintenanceRecords([newRecord, ...maintenanceRecords]);
    setExtractedDraft(null);
    setInputText('');
    speakArabicText('تم حفظ تفاصيل الصيانة وقراءة العداد بنجاح', { rate: 0.95 });
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="rounded-2xl bg-gradient-to-l from-[#0B1F3A] via-[#13325c] to-[#0B1F3A] text-white p-6 shadow-md relative overflow-hidden">
        <div className="absolute left-0 bottom-0 opacity-10 transform translate-x-4 translate-y-4">
          <Wrench className="w-48 h-48 text-white" />
        </div>
        <div className="relative z-10">
          <div className="flex items-center gap-2 text-[#C89B3C] text-xs font-bold mb-1">
            <ShieldCheck className="w-4 h-4" />
            <span>نظام إدارة الصيانة والرخص الذكي للسائقين</span>
          </div>
          <h1 className="font-display text-xl sm:text-2xl font-bold">
            مساعد الوليد الذكي للصيانة والروابط
          </h1>
          <p className="text-xs sm:text-sm text-slate-300 mt-1 max-w-xl">
            الباص رقم {busNumber} · {schoolName} · سجل الأوامر الصوتية والتنبيهات الاستباقية للرخص والصيانات
          </p>
        </div>
      </div>

      {/* Urgent Expiry & Maintenance Alert Banner */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {licenses.map((item) => {
          const isUrgent = item.daysRemaining <= 3;
          return (
            <div
              key={item.id}
              className={`rounded-2xl border p-4 flex items-center justify-between gap-3 shadow-sm transition-colors ${
                isUrgent
                  ? 'border-amber-300 bg-amber-50/80 text-amber-900'
                  : 'border-slate-200 bg-white text-slate-800'
              }`}
            >
              <div className="flex items-center gap-3">
                <div
                  className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                    isUrgent ? 'bg-amber-500 text-white' : 'bg-[#0B1F3A] text-[#C89B3C]'
                  }`}
                >
                  <Clock className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-xs font-bold">{item.title}</h4>
                  <p className="text-[11px] text-slate-500">تاريخ الانتهاء: {item.expiryDate}</p>
                </div>
              </div>

              <div className="text-left shrink-0">
                <span
                  className={`inline-block px-2.5 py-1 rounded-full text-xs font-bold ${
                    isUrgent ? 'bg-amber-200 text-amber-900 animate-pulse' : 'bg-slate-100 text-slate-700'
                  }`}
                >
                  باقي {item.daysRemaining} أيام
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Voice & Manual Input Station */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-6">
        <div className="text-center max-w-lg mx-auto space-y-2">
          <h2 className="font-display text-lg font-bold text-[#0B1F3A]">
            تسجيل صيانة جديدة (صوتي أو يدوي)
          </h2>
          <p className="text-xs text-slate-500">
            اضغط على زر الميكروفون وتحدث بصوت واضح (مثل: تم تغيير زيت المحرك وفلاتر الهواء على عداد خمسة وخمسين ألف)، أو اكتب التفاصيل بالأسفل.
          </p>
        </div>

        {/* Big Prominent Microphone Button */}
        <div className="flex flex-col items-center justify-center py-4">
          <button
            type="button"
            onClick={handleToggleVoiceRecording}
            className={`w-24 h-24 sm:w-28 sm:h-28 rounded-full flex flex-col items-center justify-center shadow-xl transition-all duration-300 cursor-pointer ${
              isListening
                ? 'bg-red-600 text-white animate-pulse scale-105 ring-8 ring-red-200'
                : 'bg-gradient-to-tr from-[#0B1F3A] to-[#13325c] text-[#C89B3C] hover:scale-105 ring-4 ring-[#0B1F3A]/20'
            }`}
          >
            {isListening ? (
              <>
                <MicOff className="w-10 h-10 animate-bounce" />
                <span className="text-[10px] font-bold text-white mt-1">جاري الاستماع...</span>
              </>
            ) : (
              <>
                <Mic className="w-10 h-10" />
                <span className="text-[11px] font-bold text-white mt-1">اضغط للتحدث</span>
              </>
            )}
          </button>
          <span className="text-xs text-slate-400 mt-3 font-medium">
            {isListening ? 'تحدث الآن، النظام يستمع لأوامرك...' : 'جاهز لاستقبال الأوامر الصوتية'}
          </span>
        </div>

        {/* Manual Text Input */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-slate-700 block">أو اكتب تفاصيل الصيانة يدوياً:</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="مثال: تم تغيير زيت وفلاتر وقراءة العداد 55000 كم..."
              className="flex-1 rounded-xl border border-slate-300 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#0B1F3A]"
            />
            <button
              type="button"
              onClick={() => parseMaintenanceText(inputText)}
              className="px-5 py-3 rounded-xl bg-[#0B1F3A] text-white text-xs font-bold hover:bg-[#13325c] transition-colors flex items-center gap-1.5 shrink-0 cursor-pointer"
            >
              <Send className="w-4 h-4" />
              <span>تحليل واستخراج</span>
            </button>
          </div>
        </div>

        {/* Extracted Summary & Confirmation Card */}
        {extractedDraft && (
          <div className="rounded-2xl border-2 border-[#C89B3C] bg-[#fffdf7] p-5 space-y-4 animate-fade-in">
            <div className="flex items-center justify-between border-b border-[#C89B3C]/30 pb-3">
              <div className="flex items-center gap-2 text-[#0B1F3A]">
                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                <h3 className="font-display text-sm font-bold">ملخص الصيانة المستخرجة (جاهز للتأكيد)</h3>
              </div>
              <span className="text-xs bg-emerald-100 text-emerald-800 font-bold px-2.5 py-1 rounded-full">
                استخراج ذكي 100%
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
              <div className="bg-white p-3 rounded-xl border border-slate-200">
                <span className="text-slate-400 block">نوع الصيانة:</span>
                <span className="font-bold text-[#0B1F3A] text-sm mt-0.5 block">{extractedDraft.type}</span>
              </div>
              <div className="bg-white p-3 rounded-xl border border-slate-200">
                <span className="text-slate-400 block">قراءة العداد الحالية:</span>
                <span className="font-bold font-mono text-[#C89B3C] text-sm mt-0.5 block">
                  {extractedDraft.odometer.toLocaleString()} كم
                </span>
              </div>
              <div className="bg-white p-3 rounded-xl border border-slate-200">
                <span className="text-slate-400 block">التكلفة التقديرية:</span>
                <span className="font-bold text-slate-800 text-sm mt-0.5 block">{extractedDraft.cost} جنيه</span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setExtractedDraft(null)}
                className="px-4 py-2 rounded-xl border border-slate-300 text-slate-600 text-xs font-bold hover:bg-slate-100 cursor-pointer"
              >
                إلغاء وتعديل
              </button>
              <button
                type="button"
                onClick={handleConfirmSaveDraft}
                className="px-6 py-2 rounded-xl bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 transition-colors flex items-center gap-1.5 cursor-pointer"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>تأكيد وحفظ السجل</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Maintenance History Records */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-[#C89B3C]" />
            <h3 className="font-display text-base font-bold text-[#0B1F3A]">سجلات الصيانات السابقة والدورية</h3>
          </div>
          <span className="text-xs text-slate-500">إجمالي السجلات: {maintenanceRecords.length}</span>
        </div>

        <div className="space-y-3">
          {maintenanceRecords.map((rec) => (
            <div
              key={rec.id}
              className="rounded-xl border border-slate-200 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/80 transition-colors"
            >
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-[#0B1F3A]/10 text-[#0B1F3A] flex items-center justify-center shrink-0 mt-0.5">
                  <Wrench className="w-5 h-5" />
                </div>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <h4 className="font-bold text-sm text-[#0B1F3A]">{rec.type}</h4>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                        rec.status === 'completed'
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-amber-100 text-amber-800'
                      }`}
                    >
                      {rec.status === 'completed' ? 'تمت بنجاح' : 'مجدولة قادمة'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">{rec.notes}</p>
                </div>
              </div>

              <div className="flex items-center gap-4 text-xs font-mono text-slate-600 sm:text-right shrink-0">
                <div>
                  <span className="text-slate-400 block text-[10px]">العداد</span>
                  <span className="font-bold text-[#0B1F3A]">{rec.odometer.toLocaleString()} كم</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px]">التاريخ</span>
                  <span>{rec.date}</span>
                </div>
                {rec.cost && (
                  <div>
                    <span className="text-slate-400 block text-[10px]">التكلفة</span>
                    <span className="font-bold text-emerald-700">{rec.cost} ج.م</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
