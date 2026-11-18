import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Building,
  Camera,
  Check,
  CheckCircle2,
  Clock,
  DollarSign,
  Eye,
  FileCheck,
  FileText,
  Fuel,
  Image as ImageIcon,
  Loader2,
  Mic,
  MicOff,
  Pause,
  Play,
  Plus,
  Receipt,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
  User,
  Users,
  Volume2,
  Wrench,
  X,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch, formatEGP } from '../../lib/api';
import { useEscapeKey } from '../../lib/useEscapeKey';
import { speakArabicText, isSpeechSynthesisAvailable } from '../../lib/background-notifications';
import type { DailyReportAttachment, DailyReportRecord } from '../../types';

interface EmployeeDailyReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (report: DailyReportRecord) => void;
}

// Client-side image compressor to ensure light payload and fast mobile uploads
function compressImageFile(file: File): Promise<{ dataUrl: string; sizeKb: number; name: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const maxDimension = 1280;
        let width = img.width;
        let height = img.height;
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          const rawUrl = e.target?.result as string;
          resolve({ dataUrl: rawUrl, sizeKb: Math.round(file.size / 1024), name: file.name });
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.82);
        const approxSizeKb = Math.round((compressedDataUrl.length * 3) / 4 / 1024);
        resolve({ dataUrl: compressedDataUrl, sizeKb: approxSizeKb, name: file.name });
      };
      img.onerror = () => {
        const rawUrl = e.target?.result as string;
        resolve({ dataUrl: rawUrl, sizeKb: Math.round(file.size / 1024), name: file.name });
      };
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const INVOICE_CATEGORIES = [
  { id: 'fuel', label: 'فاتورة بنزين / سولار ⛽' },
  { id: 'maintenance', label: 'إيصال صيانة وفلاتر 🔧' },
  { id: 'toll', label: 'كارتة طريق وبوابات 🎫' },
  { id: 'cash_advance', label: 'سلفة / عهدة ومصاريف 💵' },
  { id: 'invoice', label: 'فاتورة مشتريات عامة 🧾' },
  { id: 'other', label: 'مستند / صورة أخرى 📄' },
];

export const EmployeeDailyReportModal: React.FC<EmployeeDailyReportModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const { dbUser } = useAuth();
  useEscapeKey(isOpen, onClose);

  // Core Inputs
  const [rawText, setRawText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [audioDataUrl, setAudioDataUrl] = useState<string | null>(null);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [isTranscribingAi, setIsTranscribingAi] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );

  // Invoices & Attachments
  const [attachments, setAttachments] = useState<DailyReportAttachment[]>([]);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);

  // Extracted Entities State
  const [reportDate, setReportDate] = useState(() => {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
  });
  const [targetAudience, setTargetAudience] = useState<'both' | 'accountant' | 'manager'>('both');
  const [extractedAmount, setExtractedAmount] = useState<number>(0);
  const [extractedTasks, setExtractedTasks] = useState<string[]>([]);
  const [reportType, setReportType] = useState<'operations' | 'financial' | 'mixed'>('operations');
  const [category, setCategory] = useState('تقرير يومي عام');

  // Refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<number | null>(null);
  const recognitionRef = useRef<any>(null);
  const baseTextBeforeRecordingRef = useRef<string>('');
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Reset when opened
  useEffect(() => {
    if (isOpen) {
      setRawText('');
      setAudioDataUrl(null);
      setIsRecording(false);
      setRecordingSeconds(0);
      setStatusMessage(null);
      setExtractedAmount(0);
      setExtractedTasks([]);
      setReportType('operations');
      setTargetAudience('both');
      setAttachments([]);
      setIsPlayingAudio(false);
      setIsTranscribingAi(false);
      setPreviewImageUrl(null);
    }
  }, [isOpen]);

  // Clean up audio on close
  useEffect(() => {
    return () => {
      if (audioPlayerRef.current) {
        audioPlayerRef.current.pause();
      }
      if (timerIntervalRef.current) {
        window.clearInterval(timerIntervalRef.current);
      }
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {}
      }
    };
  }, []);

  // NLP Smart Entity Extraction on Text Changes or Attachments
  useEffect(() => {
    const text = rawText.trim();
    const hasInvoices = attachments.length > 0;

    // 1. Extract financial amounts
    const amountMatch =
      text.match(
        /(?:بمبلغ|مبلغ|تكلفة|مصاريف|سلفة|تحصيل|إجمالي|صرفت|دفعت|قبضت)\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)/i
      ) || text.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:جنيه|ج\.م|egp|ألف)/i);

    let foundAmount = 0;
    if (amountMatch) {
      let val = parseFloat(amountMatch[1]);
      if (text.includes('ألف') && val < 1000) val *= 1000;
      foundAmount = val;
    }
    setExtractedAmount(foundAmount);

    // 2. Extract Tasks
    if (text) {
      const lines = text
        .split(/[\n\r•\-\*]/)
        .map((l) => l.trim())
        .filter((l) => l.length > 4);
      setExtractedTasks(lines.length > 0 ? lines.slice(0, 6) : [text.slice(0, 100)]);
    } else if (hasInvoices) {
      setExtractedTasks([`إرفاق عدد ${attachments.length} فواتير ومستندات للمراجعة والاعتماد`]);
    } else {
      setExtractedTasks([]);
    }

    // 3. Determine Report Type
    const isMoney =
      foundAmount > 0 ||
      hasInvoices ||
      /(?:فلوس|مبلغ|جنيه|مصاريف|سلفة|فاتورة|حساب|صيانة|إيراد|تحصيل|مالي|بنزين|سولار)/i.test(text);
    const isOps =
      /(?:باص|سائق|مشرفة|مدرسة|مسار|خط سير|صيانة|تغطية|غياب|حضور|عطل|عقد|تشغيل|مشرف)/i.test(text);

    if (isMoney && isOps) {
      setReportType('mixed');
      setCategory('تقرير تشغيلي ومالي');
    } else if (isMoney) {
      setReportType('financial');
      setCategory('تقرير مالي وفواتير');
    } else {
      setReportType('operations');
      setCategory('تقرير تشغيلي وإداري');
    }
  }, [rawText, attachments]);

  // Transcribe audio using server-side Gemini API
  const requestServerTranscription = async (audioData: string) => {
    setIsTranscribingAi(true);
    try {
      const res = await apiFetch<{ transcript: string }>('/api/voice/transcribe', {
        method: 'POST',
        body: JSON.stringify({
          audioBase64: audioData,
          mimeType: 'audio/webm',
        }),
      });

      if (res && res.transcript && res.transcript.trim()) {
        const clean = res.transcript.trim();
        setRawText((prev) => {
          if (!prev.trim()) return clean;
          if (prev.includes(clean)) return prev;
          return `${prev}\n${clean}`;
        });
        setStatusMessage({
          type: 'success',
          text: 'تم تفريغ الصوت باللهجة المصرية بدقة بواسطة الذكاء الاصطناعي ✨',
        });
      }
    } catch (err: unknown) {
      console.warn('Server transcription note:', err);
      // Not a blocker - audio is still recorded and will be sent with report
    } finally {
      setIsTranscribingAi(false);
    }
  };

  // Toggle Voice Recording
  const handleToggleVoice = async () => {
    if (isRecording) {
      // STOP RECORDING
      setIsRecording(false);
      if (timerIntervalRef.current) {
        window.clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }

      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {}
        recognitionRef.current = null;
      }

      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      return;
    }

    // START RECORDING
    setStatusMessage(null);
    setRecordingSeconds(0);
    baseTextBeforeRecordingRef.current = rawText.trim();

    // 1. Try Browser SpeechRecognition for live real-time preview
    const SpeechRecognitionAPI =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    let localLiveTranscript = '';
    if (SpeechRecognitionAPI) {
      try {
        const recognition = new SpeechRecognitionAPI();
        recognition.lang = 'ar-EG';
        recognition.continuous = true;
        recognition.interimResults = true;
        recognitionRef.current = recognition;

        recognition.onresult = (event: any) => {
          let interim = '';
          for (let i = event.resultIndex; i < event.results.length; ++i) {
            const piece = event.results[i][0]?.transcript || '';
            if (event.results[i].isFinal) {
              localLiveTranscript += (localLiveTranscript ? ' ' : '') + piece.trim();
            } else {
              interim += ' ' + piece;
            }
          }
          const fullResult = (localLiveTranscript + ' ' + interim).trim();
          if (fullResult) {
            setRawText((prev) => {
              const base = baseTextBeforeRecordingRef.current;
              return base ? `${base}\n${fullResult}` : fullResult;
            });
          }
        };

        recognition.onerror = (e: any) => {
          console.warn('Browser SpeechRecognition note:', e?.error || e);
        };

        recognition.start();
      } catch (err) {
        console.warn('Speech recognition init note:', err);
      }
    }

    // 2. Start Audio MediaRecorder to record audio file
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = () => {
          if (typeof reader.result === 'string') {
            const dataUrl = reader.result;
            setAudioDataUrl(dataUrl);

            // If browser speech didn't yield text, trigger server-side Gemini transcription
            if (!localLiveTranscript.trim() && !rawText.trim()) {
              requestServerTranscription(dataUrl);
            }
          }
        };
        reader.readAsDataURL(audioBlob);

        // Stop all audio tracks
        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);

      timerIntervalRef.current = window.setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      console.warn('Microphone permission or hardware error:', err);
      setStatusMessage({
        type: 'error',
        text: 'تعذر الوصول إلى الميكروفون. يرجى السماح بالإذن أو الكتابة يدوياً.',
      });
    }
  };

  // Play/Pause recorded voice note
  const handleTogglePlayAudio = () => {
    if (!audioDataUrl) return;
    if (isPlayingAudio) {
      audioPlayerRef.current?.pause();
      setIsPlayingAudio(false);
      return;
    }

    if (!audioPlayerRef.current) {
      audioPlayerRef.current = new Audio(audioDataUrl);
      audioPlayerRef.current.onended = () => setIsPlayingAudio(false);
      audioPlayerRef.current.onerror = () => setIsPlayingAudio(false);
    } else {
      audioPlayerRef.current.src = audioDataUrl;
    }

    audioPlayerRef.current.play().catch(() => setIsPlayingAudio(false));
    setIsPlayingAudio(true);
  };

  // Handle Photo/Invoice Upload
  const handleProcessUploadedFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploadingImage(true);
    setStatusMessage(null);

    try {
      const newItems: DailyReportAttachment[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file.type.startsWith('image/')) continue;

        const compressed = await compressImageFile(file);
        newItems.push({
          id: `att_${Date.now()}_${i}`,
          name: file.name || `فاتورة_${i + 1}.jpg`,
          url: compressed.dataUrl,
          type: 'image/jpeg',
          category: 'invoice',
          categoryLabel: 'فاتورة بنزين / سولار ⛽',
          sizeKb: compressed.sizeKb,
          createdAt: new Date().toISOString(),
        });
      }

      if (newItems.length > 0) {
        setAttachments((prev) => [...prev, ...newItems]);
        setStatusMessage({
          type: 'success',
          text: `تم إرفاق ${newItems.length} صورة/فاتورة بنجاح ويمكنك مراجعتها وتصنيفها.`,
        });
      }
    } catch (err) {
      console.error('File upload error:', err);
      setStatusMessage({
        type: 'error',
        text: 'حدث خطأ أثناء قراءة أو ضغط صورة الفاتورة.',
      });
    } finally {
      setUploadingImage(false);
      if (cameraInputRef.current) cameraInputRef.current.value = '';
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemoveAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((item) => item.id !== id));
  };

  const handleUpdateAttachmentCategory = (id: string, categoryId: string) => {
    const found = INVOICE_CATEGORIES.find((c) => c.id === categoryId);
    setAttachments((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              category: categoryId as any,
              categoryLabel: found?.label || item.categoryLabel,
            }
          : item
      )
    );
  };

  // Quick Egyptian Phrase Helpers
  const handleAppendPhrase = (phrase: string) => {
    setRawText((prev) => {
      const trimmed = prev.trim();
      return trimmed ? `${trimmed}\n• ${phrase}` : `• ${phrase}`;
    });
  };

  // Submit Handler
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Check if there is text, audio, or attachments
    const hasText = rawText.trim().length > 0;
    const hasAudio = Boolean(audioDataUrl);
    const hasAttachments = attachments.length > 0;

    if (!hasText && !hasAudio && !hasAttachments) {
      setStatusMessage({
        type: 'error',
        text: 'يرجى تسجيل صوتي، أو كتابة نص، أو إرفاق صورة فاتورة قبل الإرسال.',
      });
      return;
    }

    setSubmitting(true);
    setStatusMessage(null);

    // If text is blank but audio or attachments exist, construct a descriptive title
    let finalContent = rawText.trim();
    if (!finalContent) {
      if (hasAudio && hasAttachments) {
        finalContent = `تقرير صوتي مسجل (${recordingSeconds || 0} ثانية) مع إرفاق ${attachments.length} فواتير ومستندات`;
      } else if (hasAudio) {
        finalContent = `تقرير صوتي مسجل (${recordingSeconds || 0} ثانية)`;
      } else if (hasAttachments) {
        finalContent = `تقرير مرفق به ${attachments.length} فواتير ومستندات للمراجعة المالية`;
      }
    }

    try {
      const res = await apiFetch<{ report: DailyReportRecord }>('/api/daily-reports', {
        method: 'POST',
        body: JSON.stringify({
          rawContent: finalContent,
          audioDataUrl: audioDataUrl || null,
          audioDurationSec: recordingSeconds,
          reportDate,
          targetAudience,
          reportType,
          financialAmount: extractedAmount,
          category,
          attachments,
        }),
      });

      if (isSpeechSynthesisAvailable()) {
        speakArabicText('تم إرسال تقريرك والفواتير المرفقة بنجاح إلى الإدارة والمحاسب', {
          rate: 1.0,
        });
      }

      setStatusMessage({
        type: 'success',
        text: 'تم إرسال التقرير اليومي وتوجيهه بنجاح إلى الجهات المختصة!',
      });
      onSuccess?.(res.report);

      setTimeout(() => {
        onClose();
      }, 1300);
    } catch (err: unknown) {
      setStatusMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'تعذر إرسال التقرير',
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  const canSubmit = rawText.trim().length > 0 || Boolean(audioDataUrl) || attachments.length > 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in overflow-y-auto"
    >
      <div className="relative w-full max-w-2xl bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden my-auto max-h-[92vh] flex flex-col">
        {/* Header Bar */}
        <div className="flex items-center justify-between px-6 py-4 bg-gradient-to-l from-[#0B1F3A] to-[#13325c] text-white shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-xl bg-white/10 text-[#C89B3C] flex items-center justify-center shrink-0">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-display text-base sm:text-lg font-bold">
                تقديم التقرير اليومي ورفع الفواتير
              </h2>
              <p className="text-[11px] text-slate-300">
                تسجيل صوتي مع تفريغ فوري بالذكاء الاصطناعي ورفع صور الفواتير للمحاسب والمدير
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Form Body */}
        <form onSubmit={handleSubmit} className="p-5 sm:p-6 space-y-5 overflow-y-auto flex-1">
          {/* User & Date Quick Info */}
          <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 bg-slate-50 border border-slate-200/80 rounded-2xl text-xs">
            <div className="flex items-center gap-2 text-slate-700">
              <User className="w-4 h-4 text-[#C89B3C]" />
              <span className="font-semibold text-[#0B1F3A]">
                الموظف / السائق: {dbUser?.fullName || 'موظف النظام'}
              </span>
              <span className="text-slate-400">·</span>
              <span className="text-slate-500">{dbUser?.roleNameAr || 'إدارة وتشغيل'}</span>
            </div>

            <div className="flex items-center gap-2 text-slate-600">
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              <span>التاريخ:</span>
              <input
                type="date"
                value={reportDate}
                onChange={(e) => setReportDate(e.target.value)}
                className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono font-bold text-[#0B1F3A]"
              />
            </div>
          </div>

          {/* Big Prominent Voice Input Station */}
          <div className="flex flex-col items-center justify-center p-5 rounded-2xl bg-gradient-to-b from-slate-50 via-white to-slate-50 border-2 border-dashed border-slate-200 hover:border-[#C89B3C]/60 transition-colors">
            <p className="text-xs text-slate-600 mb-3 font-semibold text-center">
              اضغط على الميكروفون وتحدث شفهياً لتقريرك اليومي
            </p>

            <button
              type="button"
              onClick={handleToggleVoice}
              className={`w-20 h-20 sm:w-24 sm:h-24 rounded-full flex flex-col items-center justify-center shadow-lg transition-all duration-300 cursor-pointer ${
                isRecording
                  ? 'bg-red-600 text-white animate-pulse ring-8 ring-red-200 scale-105'
                  : 'bg-gradient-to-tr from-[#0B1F3A] to-[#13325c] text-[#C89B3C] hover:scale-105 ring-4 ring-[#0B1F3A]/20'
              }`}
            >
              {isRecording ? (
                <>
                  <MicOff className="w-8 h-8 animate-bounce" />
                  <span className="text-[10px] font-bold text-white mt-1 font-mono">
                    {Math.floor(recordingSeconds / 60)}:
                    {String(recordingSeconds % 60).padStart(2, '0')}
                  </span>
                </>
              ) : (
                <>
                  <Mic className="w-8 h-8" />
                  <span className="text-[10px] font-bold text-white mt-1">تسجيل صوتي</span>
                </>
              )}
            </button>

            <div className="mt-3 text-center space-y-1.5">
              <span className="text-xs font-semibold text-slate-700 block">
                {isRecording
                  ? 'جاري التسجيل الصوتي... اضغط للإيقاف'
                  : audioDataUrl
                  ? 'تم تسجيل المقطع الصوتي بنجاح'
                  : 'انقر للبدء بالتسجيل الصوتي الشفهي'}
              </span>

              {/* Audio Player and Transcription Status */}
              {audioDataUrl && (
                <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleTogglePlayAudio}
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#0B1F3A] text-white text-xs font-semibold hover:bg-[#13325c] transition-colors cursor-pointer shadow-sm"
                  >
                    {isPlayingAudio ? (
                      <>
                        <Pause className="w-3.5 h-3.5 text-[#C89B3C]" />
                        <span>إيقاف الاستماع</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5 text-[#C89B3C]" />
                        <span>سماع التسجيل ({recordingSeconds} ثانية)</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => requestServerTranscription(audioDataUrl)}
                    disabled={isTranscribingAi}
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#fffdf7] border border-[#C89B3C] text-[#0B1F3A] text-xs font-bold hover:bg-[#C89B3C]/10 transition-colors cursor-pointer"
                  >
                    {isTranscribingAi ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-[#C89B3C]" />
                        <span>جاري التفريغ الذكي...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3.5 h-3.5 text-[#C89B3C]" />
                        <span>تفريغ الصوت بالذكاء الاصطناعي</span>
                      </>
                    )}
                  </button>
                </div>
              )}

              {isTranscribingAi && (
                <p className="text-[11px] text-[#0B1F3A] animate-pulse font-medium">
                  جاري تحويل التسجيل الصوتي إلى نص مكتوب باللهجة المصرية...
                </p>
              )}
            </div>
          </div>

          {/* Quick Phrasing Shortcuts (اللهجة المصرية) */}
          <div className="space-y-1.5">
            <span className="text-[11px] font-bold text-slate-500">عبارات ونماذج سريعة للإضافة:</span>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => handleAppendPhrase('تفويل بنزين للمركبة بمبلغ 450 جنيه')}
                className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs transition-colors cursor-pointer"
              >
                ⛽ بنزين 450 ج
              </button>
              <button
                type="button"
                onClick={() => handleAppendPhrase('صيانة دورية وتغيير زيت وفلاتر بمبلغ 850 جنيه')}
                className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs transition-colors cursor-pointer"
              >
                🔧 صيانة وزيت 850 ج
              </button>
              <button
                type="button"
                onClick={() => handleAppendPhrase('دفع كارتة بوابات وطرق بمبلغ 80 جنيه')}
                className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs transition-colors cursor-pointer"
              >
                🎫 كارتة طرق 80 ج
              </button>
              <button
                type="button"
                onClick={() => handleAppendPhrase('تمت تغطية خط سير الباص الصباحي والمسائي بنجاح')}
                className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs transition-colors cursor-pointer"
              >
                🚌 خط سير كامل
              </button>
            </div>
          </div>

          {/* Manual Input & Live Transcript Area */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <label className="font-bold text-[#0B1F3A]">نص التقرير (تفريغ صوتي أو كتابة يدوية):</label>
              <span className="text-slate-400">يمكنك التعديل أو الكتابة بحرية</span>
            </div>
            <textarea
              rows={3}
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              placeholder="تحدث عبر الميكروفون أعلاه أو اكتب هنا... مثال: تم إنجاز خطوط سير الباصات، وصرف 350 جنيه بنزين للمركبة 104 ومرفق صورة الفاتورة..."
              className="w-full rounded-2xl border border-slate-300 p-3.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0B1F3A] focus:border-transparent leading-relaxed"
            />
          </div>

          {/* Section: Upload Invoices & Receipts (رفع الفواتير والصور) */}
          <div className="space-y-3 p-4 rounded-2xl bg-slate-50 border border-slate-200">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Receipt className="w-4 h-4 text-[#C89B3C]" />
                <span className="text-xs font-bold text-[#0B1F3A]">
                  إرفاق صور الفواتير والإيصالات ({attachments.length}):
                </span>
              </div>
              <span className="text-[11px] text-slate-500">تُوجّه للمحاسب للمراجعة والاعتماد</span>
            </div>

            {/* Hidden inputs for Camera and File Picker */}
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => handleProcessUploadedFiles(e.target.files)}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => handleProcessUploadedFiles(e.target.files)}
            />

            {/* Upload Buttons */}
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => cameraInputRef.current?.click()}
                disabled={uploadingImage}
                className="flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl bg-white border border-slate-300 hover:border-[#0B1F3A] text-xs font-bold text-[#0B1F3A] transition-colors cursor-pointer shadow-sm hover:bg-slate-50"
              >
                <Camera className="w-4 h-4 text-[#C89B3C]" />
                <span>التقاط بالكاميرا</span>
              </button>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingImage}
                className="flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl bg-white border border-slate-300 hover:border-[#0B1F3A] text-xs font-bold text-[#0B1F3A] transition-colors cursor-pointer shadow-sm hover:bg-slate-50"
              >
                <ImageIcon className="w-4 h-4 text-emerald-600" />
                <span>رفع صور من الجهاز</span>
              </button>
            </div>

            {uploadingImage && (
              <div className="flex items-center justify-center gap-2 text-xs text-[#0B1F3A] py-1">
                <Loader2 className="w-4 h-4 animate-spin text-[#C89B3C]" />
                <span>جاري معالجة وضغط الصورة...</span>
              </div>
            )}

            {/* Attachments List */}
            {attachments.length > 0 && (
              <div className="space-y-2 pt-1">
                {attachments.map((att) => (
                  <div
                    key={att.id}
                    className="flex items-center justify-between gap-3 p-2.5 bg-white border border-slate-200 rounded-xl"
                  >
                    <div className="flex items-center gap-2.5 overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setPreviewImageUrl(att.url)}
                        className="relative w-12 h-12 rounded-lg overflow-hidden border border-slate-200 bg-slate-100 shrink-0 group cursor-pointer"
                        title="انقر لتكبير الصورة"
                      >
                        <img
                          src={att.url}
                          alt={att.name}
                          className="w-full h-full object-cover group-hover:scale-110 transition-transform"
                        />
                        <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                          <Eye className="w-3.5 h-3.5 text-white" />
                        </div>
                      </button>

                      <div className="space-y-1 min-w-0">
                        <select
                          value={att.category || 'invoice'}
                          onChange={(e) => handleUpdateAttachmentCategory(att.id, e.target.value)}
                          className="text-[11px] font-bold text-[#0B1F3A] bg-slate-50 border border-slate-200 rounded-md px-1.5 py-0.5"
                        >
                          {INVOICE_CATEGORIES.map((cat) => (
                            <option key={cat.id} value={cat.id}>
                              {cat.label}
                            </option>
                          ))}
                        </select>
                        <p className="text-[10px] text-slate-400 font-mono">
                          {att.sizeKb ? `${att.sizeKb} KB` : 'مرفق'}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => setPreviewImageUrl(att.url)}
                        className="p-1.5 rounded-lg text-slate-500 hover:text-[#0B1F3A] hover:bg-slate-100 transition-colors cursor-pointer"
                        title="معاينة"
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveAttachment(att.id)}
                        className="p-1.5 rounded-lg text-red-500 hover:text-red-700 hover:bg-red-50 transition-colors cursor-pointer"
                        title="حذف الفاتورة"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Smart Automatic Entity Extraction Preview */}
          {(rawText.trim().length > 0 || attachments.length > 0) && (
            <div className="p-4 rounded-2xl bg-[#fffdf7] border border-[#C89B3C]/40 space-y-3 animate-fade-in">
              <div className="flex items-center justify-between pb-2 border-b border-[#C89B3C]/20">
                <div className="flex items-center gap-1.5 text-xs font-bold text-[#0B1F3A]">
                  <Sparkles className="w-4 h-4 text-[#C89B3C]" />
                  <span>استخراج وتصنيف البيانات تلقائياً:</span>
                </div>
                <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                  {reportType === 'financial'
                    ? 'تقرير مالي وفواتير'
                    : reportType === 'mixed'
                    ? 'تقرير مختلط (مالي وتشغيلي)'
                    : 'تقرير تشغيلي'}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                {/* Extracted Financial Amount */}
                <div className="p-2.5 rounded-xl bg-white border border-slate-200 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <DollarSign className="w-4 h-4 text-[#C89B3C]" />
                    <span className="text-slate-600">المبلغ المرصود:</span>
                  </div>
                  <span className="font-bold font-mono text-[#0B1F3A] text-sm tabular-nums">
                    {extractedAmount > 0 ? formatEGP(extractedAmount) : 'فواتير ومرفقات'}
                  </span>
                </div>

                {/* Extracted Invoices Count */}
                <div className="p-2.5 rounded-xl bg-white border border-slate-200 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    <span className="text-slate-600">الفواتير والمرفقات:</span>
                  </div>
                  <span className="font-bold text-[#0B1F3A]">
                    {attachments.length} {attachments.length === 1 ? 'مرفق' : 'مرفقات'}
                  </span>
                </div>
              </div>

              {extractedTasks.length > 0 && (
                <div className="space-y-1">
                  <span className="text-[11px] font-semibold text-slate-500">تفاصيل المهام المرصودة:</span>
                  <div className="flex flex-wrap gap-1.5">
                    {extractedTasks.map((task, idx) => (
                      <span
                        key={idx}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[11px] text-slate-700 font-medium"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-[#C89B3C]"></span>
                        <span>{task}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Role-Based Routing (وجهة إرسال التقرير) */}
          <div className="space-y-2">
            <label className="text-xs font-bold text-[#0B1F3A] block">
              توجيه التقرير (Role-Based Routing):
            </label>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setTargetAudience('both')}
                className={`flex flex-col items-center justify-center p-3 rounded-xl border text-xs font-bold transition-colors cursor-pointer ${
                  targetAudience === 'both'
                    ? 'border-[#0B1F3A] bg-[#0B1F3A] text-white shadow-sm'
                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                }`}
              >
                <Users className="w-4 h-4 mb-1 text-[#C89B3C]" />
                <span>المدير والمحاسب معاً</span>
                <span className="text-[10px] font-normal opacity-80 mt-0.5">(الموصى به)</span>
              </button>

              <button
                type="button"
                onClick={() => setTargetAudience('accountant')}
                className={`flex flex-col items-center justify-center p-3 rounded-xl border text-xs font-bold transition-colors cursor-pointer ${
                  targetAudience === 'accountant'
                    ? 'border-[#0B1F3A] bg-[#0B1F3A] text-white shadow-sm'
                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                }`}
              >
                <DollarSign className="w-4 h-4 mb-1 text-emerald-500" />
                <span>المحاسب فقط</span>
                <span className="text-[10px] font-normal opacity-80 mt-0.5">(فواتير وسلف)</span>
              </button>

              <button
                type="button"
                onClick={() => setTargetAudience('manager')}
                className={`flex flex-col items-center justify-center p-3 rounded-xl border text-xs font-bold transition-colors cursor-pointer ${
                  targetAudience === 'manager'
                    ? 'border-[#0B1F3A] bg-[#0B1F3A] text-white shadow-sm'
                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                }`}
              >
                <Building className="w-4 h-4 mb-1 text-blue-400" />
                <span>المدير فقط</span>
                <span className="text-[10px] font-normal opacity-80 mt-0.5">(إداري وتشغيل)</span>
              </button>
            </div>
          </div>

          {/* Feedback & Status Alert */}
          {statusMessage && (
            <div
              className={`p-3 rounded-xl text-xs flex items-center gap-2 ${
                statusMessage.type === 'success'
                  ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                  : 'bg-red-50 text-red-800 border border-red-200'
              }`}
            >
              {statusMessage.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
              )}
              <span>{statusMessage.text}</span>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-5 py-2.5 rounded-xl border border-slate-300 text-xs font-bold text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
            >
              إلغاء
            </button>

            <button
              type="submit"
              disabled={submitting || !canSubmit}
              className="min-h-[46px] px-8 py-2.5 rounded-xl bg-gradient-to-r from-[#0B1F3A] to-[#13325c] text-white text-xs font-bold hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2 shadow-md cursor-pointer"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>جاري الإرسال والتوجيه...</span>
                </>
              ) : (
                <>
                  <Send className="w-4 h-4 text-[#C89B3C]" />
                  <span>إرسال التقرير فوراً</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>

      {/* Lightbox Image Preview Modal */}
      {previewImageUrl && (
        <div
          className="fixed inset-0 z-60 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setPreviewImageUrl(null)}
        >
          <div
            className="relative max-w-3xl max-h-[90vh] bg-white rounded-2xl overflow-hidden p-2 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-2 px-2 border-b border-slate-200">
              <span className="text-xs font-bold text-[#0B1F3A]">معاينة صورة الفاتورة / المستند</span>
              <button
                type="button"
                onClick={() => setPreviewImageUrl(null)}
                className="p-1 rounded-lg text-slate-500 hover:text-slate-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="mt-2 max-h-[75vh] overflow-auto flex items-center justify-center bg-slate-100 rounded-xl">
              <img
                src={previewImageUrl}
                alt="فاتورة"
                className="max-h-[75vh] w-auto object-contain rounded-lg"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
