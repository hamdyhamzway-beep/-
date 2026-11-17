import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Mic,
  RadioTower,
  Send,
  ShieldCheck,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { useEscapeKey } from '../../lib/useEscapeKey';

interface DriverBroadcastModalProps {
  open: boolean;
  onClose: () => void;
  onOpenDriversChat?: () => void;
}

export const DriverBroadcastModal: React.FC<DriverBroadcastModalProps> = ({
  open,
  onClose,
  onOpenDriversChat,
}) => {
  const [title, setTitle] = useState('');
  const [textContent, setTextContent] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successInfo, setSuccessInfo] = useState<string | null>(null);

  // Voice Note Recorder
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [audioBlobUrl, setAudioBlobUrl] = useState<string | null>(null);
  const [audioBase64, setAudioBase64] = useState<string | null>(null);
  const [recordedDuration, setRecordedDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEscapeKey(open, onClose);

  useEffect(() => {
    if (!open) {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      if (timerRef.current) window.clearInterval(timerRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      setIsRecording(false);
    }
  }, [open]);

  if (!open) return null;

  const formatTimer = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const startRecording = async () => {
    setError(null);
    setSuccessInfo(null);
    setAudioBlobUrl(null);
    setAudioBase64(null);
    setRecordingSeconds(0);
    setRecordedDuration(0);
    audioChunksRef.current = [];

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setError('تسجيل الصوت غير مدعوم في هذا المتصفح');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
        ? 'audio/ogg;codecs=opus'
        : 'audio/mp4';

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          audioChunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        const url = URL.createObjectURL(blob);
        setAudioBlobUrl(url);
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = () => {
          setAudioBase64(reader.result as string);
        };
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      };

      recorder.start(250);
      setIsRecording(true);
      const startedAt = Date.now();
      timerRef.current = window.setInterval(() => {
        const secs = Math.floor((Date.now() - startedAt) / 1000);
        setRecordingSeconds(secs);
        setRecordedDuration(secs);
      }, 400);
    } catch {
      setError('يرجى السماح بصلاحية الميكروفون لتسجيل الفويس نوت');
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsRecording(false);
  };

  const clearRecording = () => {
    stopRecording();
    setAudioBlobUrl(null);
    setAudioBase64(null);
    setRecordingSeconds(0);
    setRecordedDuration(0);
    audioChunksRef.current = [];
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanText = textContent.trim();
    if (!cleanText && !audioBase64) {
      setError('يرجى كتابة رسالة نصية أو تسجيل فويس نوت قبل الإرسال.');
      return;
    }

    setSending(true);
    setError(null);
    setSuccessInfo(null);

    try {
      const res = await apiFetch<{ ok: boolean; notifiedDriversCount: number }>(
        '/api/admin/drivers-broadcast',
        {
          method: 'POST',
          body: JSON.stringify({
            title: title.trim() || undefined,
            textContent: cleanText || undefined,
            audioDataUrl: audioBase64 || undefined,
            audioDurationSec: audioBase64 ? Math.max(1, recordedDuration) : undefined,
          }),
        }
      );

      setTitle('');
      setTextContent('');
      clearRecording();
      setSuccessInfo(
        `تم إرسال الرسالة الجماعية بنجاح إلى ${res.notifiedDriversCount} سائق نشط فقط (مع استثناء المشرفات تماماً).`
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر إرسال الرسالة الجماعية للسائقين');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
      <div className="w-full max-w-lg bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden">
        <div className="px-5 py-4 bg-[#0B1F3A] text-white flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-white/10 border border-white/15 text-[#C89B3C] flex items-center justify-center">
              <RadioTower className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-display text-base font-bold">رسائل جماعية للسائقين</h3>
              <p className="text-[11px] text-slate-300">
                رسالة نصية أو تسجيل صوتي (فويس نوت) للسائقين فقط
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="p-1.5 rounded-lg text-slate-300 hover:bg-white/10 hover:text-white cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 px-3.5 py-2.5 text-emerald-900 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-700 shrink-0" />
            <span>
              <strong>تصل لحسابات السائقين فقط:</strong> يتم تسليم الإشعار والصوت لجميع السائقين النشطين ولا تظهر للمشرفات إطلاقاً.
            </span>
          </div>

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-red-800 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {successInfo && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-emerald-900 space-y-2">
              <div className="flex items-center gap-2 font-semibold">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>{successInfo}</span>
              </div>
              {onOpenDriversChat && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenDriversChat();
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#0B1F3A] px-3 py-1.5 text-[11px] font-bold text-white hover:bg-[#13325c] cursor-pointer"
                >
                  فتح غرفة محادثة السائقين
                </button>
              )}
            </div>
          )}

          <div>
            <label className="block font-semibold text-slate-700 mb-1">
              عنوان الإشعار (اختياري)
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="مثال: تنبيه هام للسائقين بخصوص مواعيد الصباح"
              className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-slate-900 focus:border-[#0B1F3A] focus:outline-none"
            />
          </div>

          <div>
            <label className="block font-semibold text-slate-700 mb-1">
              الرسالة النصية للسائقين
            </label>
            <textarea
              rows={3}
              value={textContent}
              onChange={(e) => setTextContent(e.target.value)}
              placeholder="اكتب التعليمات أو الرسالة الموجهة لجميع السائقين..."
              className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-slate-900 focus:border-[#0B1F3A] focus:outline-none"
            />
          </div>

          {/* Voice Note Recorder Box */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-bold text-[#0B1F3A]">إرفاق تسجيل صوتي (فويس نوت)</span>
              {!isRecording && !audioBlobUrl && (
                <button
                  type="button"
                  onClick={startRecording}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#C89B3C] hover:bg-[#d8ac4e] text-[#0B1F3A] px-3 py-1.5 font-bold cursor-pointer"
                >
                  <Mic className="w-3.5 h-3.5" />
                  بدء تسجيل صوتي
                </button>
              )}
            </div>

            {isRecording && (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-red-800">
                <div className="flex items-center gap-2 font-semibold">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-600 animate-ping" />
                  <span>جاري التسجيل...</span>
                  <span className="font-mono font-bold tabular-nums">
                    {formatTimer(recordingSeconds)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={stopRecording}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 font-bold cursor-pointer"
                >
                  <Square className="w-3.5 h-3.5" />
                  إيقاف
                </button>
              </div>
            )}

            {audioBlobUrl && !isRecording && (
              <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 p-2.5">
                <audio controls src={audioBlobUrl} className="h-8 flex-1 max-w-[280px]" />
                <span className="font-mono text-[11px] text-slate-600 shrink-0 tabular-nums">
                  {Math.max(1, recordedDuration)}ث
                </span>
                <button
                  type="button"
                  onClick={clearRecording}
                  className="p-1.5 rounded-lg text-red-600 hover:bg-red-100 cursor-pointer"
                  title="حذف التسجيل"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-200 px-4 py-2.5 font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
            >
              إغلاق
            </button>
            <button
              type="submit"
              disabled={sending || isRecording || (!textContent.trim() && !audioBase64)}
              className="inline-flex items-center gap-2 rounded-xl bg-[#0B1F3A] hover:bg-[#13325c] disabled:opacity-50 px-5 py-2.5 font-bold text-white cursor-pointer"
            >
              {sending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4 rotate-180 text-[#C89B3C]" />
              )}
              <span>{sending ? 'جاري الإرسال...' : 'إرسال لجميع السائقين'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
