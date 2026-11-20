import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Loader2,
  Mic,
  MicOff,
  Send,
  ShieldAlert,
  Volume2,
  VolumeX,
  XCircle,
} from 'lucide-react';
import { apiFetch, formatEGP } from '../../lib/api';

interface AvailableAdvanceOption {
  id: number;
  amount: number;
  date: string;
  reason: string;
  paymentMethod: string;
}

interface AvailableCoverageOption {
  id: number;
  date: string;
  actualReplacementCost: number;
  absentDriverDeduction: number;
  reason: string;
  replacementName: string;
}

interface PendingConfirmationPayload {
  intent: string;
  targetRecordId?: number;
  driverId: number;
  driverCode: string;
  driverName: string;
  schoolId: number | null;
  schoolName: string;
  vehicleId: number | null;
  busNumber: string;
  replacementQuery?: string;
  amount: number;
  actualReplacementCost: number;
  absentDriverDeduction: number;
  date: string;
  reason: string;
  paymentMethod: string;
}

interface InterpretResponse {
  logId: number;
  transcript: string;
  intent: string;
  requiresConfirmation: boolean;
  isAmbiguous: boolean;
  replyArabic: string;
  queryResult: {
    type?: string;
    currentNetSalary?: number;
    projectedNetSalary?: number;
    availableAdvances?: AvailableAdvanceOption[];
    availableCoverages?: AvailableCoverageOption[];
    payload?: PendingConfirmationPayload;
    [key: string]: unknown;
  } | null;
}

interface VoiceLogItem {
  id: number;
  rawTranscript: string;
  parsedIntent: string;
  executionStatus: string;
  wasConfirmed: boolean;
  responseArabic: string;
  createdAt: string;
}

export const VoiceAssistantModule: React.FC = () => {
  const [inputText, setInputText] = useState('');
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [result, setResult] = useState<InterpretResponse | null>(null);
  const [editablePayload, setEditablePayload] = useState<PendingConfirmationPayload | null>(null);
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<VoiceLogItem[]>([]);

  const [dictating, setDictating] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);

  const supportsSpeechRecognition =
    typeof window !== 'undefined' &&
    Boolean(
      (window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown })
        .SpeechRecognition ||
        (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition
    );

  const loadLogs = useCallback(async () => {
    try {
      const res = await apiFetch<{ logs: VoiceLogItem[] }>('/api/voice/logs');
      setLogs(res.logs);
    } catch {
      // silent
    }
  }, []);

  const checkVoiceEnvironment = useCallback(async () => {
    const isSecureContext = typeof window !== 'undefined' ? window.isSecureContext : false;
    const inIframe = typeof window !== 'undefined' ? window.self !== window.top : false;
    const hasMediaDevices =
      typeof navigator !== 'undefined' &&
      Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
    const hasMediaRecorder = typeof MediaRecorder !== 'undefined';

    let permissionState: PermissionState | 'unsupported' = 'unsupported';
    if (typeof navigator !== 'undefined' && navigator.permissions?.query) {
      try {
        const status = await navigator.permissions.query({
          name: 'microphone' as PermissionName,
        });
        permissionState = status.state;
      } catch {
        permissionState = 'unsupported';
      }
    }

    let policyAllowsMic: boolean | 'unknown' = 'unknown';
    const docWithPolicy = document as unknown as {
      featurePolicy?: { allowsFeature?: (name: string) => boolean };
      permissionsPolicy?: { allowsFeature?: (name: string) => boolean };
    };
    const policyApi = docWithPolicy.permissionsPolicy || docWithPolicy.featurePolicy;
    if (policyApi && typeof policyApi.allowsFeature === 'function') {
      try {
        policyAllowsMic = policyApi.allowsFeature('microphone');
      } catch {
        policyAllowsMic = 'unknown';
      }
    }

    const diagnostics = {
      origin: typeof window !== 'undefined' ? window.location.origin : '',
      isSecureContext,
      inIframe,
      hasMediaDevices,
      hasMediaRecorder,
      supportsSpeechRecognition,
      permissionState,
      policyAllowsMic,
    };
    console.info('[VoiceAssistant] Environment diagnostics:', diagnostics);
    return diagnostics;
  }, [supportsSpeechRecognition]);

  useEffect(() => {
    loadLogs();
    checkVoiceEnvironment();
    return () => {
      if (recordTimerRef.current) window.clearInterval(recordTimerRef.current);
      recognitionRef.current?.stop();
    };
  }, [loadLogs, checkVoiceEnvironment]);

  const speakArabic = async (text: string) => {
    if (!voiceEnabled || !text) return;
    try {
      const res = await apiFetch<{ audioBase64: string | null; mimeType: string }>(
        '/api/voice/speak',
        {
          method: 'POST',
          body: JSON.stringify({ text }),
        }
      );
      if (res.audioBase64) {
        console.info('[VoiceAssistant] Playing Gemini TTS WAV audio');
        const audio = new Audio(`data:${res.mimeType || 'audio/wav'};base64,${res.audioBase64}`);
        await audio.play().catch((playErr) => {
          console.warn('[VoiceAssistant] Audio playback blocked:', playErr);
        });
        return;
      }
      console.info('[VoiceAssistant] Server TTS returned null, falling back to speechSynthesis');
    } catch (ttsErr) {
      console.warn('[VoiceAssistant] Server TTS failed, falling back to speechSynthesis:', ttsErr);
    }

    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = 'ar-EG';
        utter.rate = 1;
        window.speechSynthesis.speak(utter);
      } catch (synthErr) {
        console.warn('[VoiceAssistant] Browser speechSynthesis failed:', synthErr);
      }
    }
  };

  const runInterpret = async (text: string) => {
    if (!text.trim()) return;
    console.info('[VoiceAssistant] Interpreting transcript:', text.trim());
    setProcessing(true);
    setError(null);
    setConfirmMessage(null);
    setResult(null);
    setEditablePayload(null);

    try {
      const res = await apiFetch<InterpretResponse>('/api/voice/interpret', {
        method: 'POST',
        body: JSON.stringify({ transcript: text.trim() }),
      });
      console.info('[VoiceAssistant] Interpretation result:', {
        logId: res.logId,
        intent: res.intent,
        requiresConfirmation: res.requiresConfirmation,
        isAmbiguous: res.isAmbiguous,
      });
      setResult(res);
      if (res.requiresConfirmation && res.queryResult?.payload) {
        setEditablePayload(res.queryResult.payload);
      }
      await loadLogs();
      void speakArabic(res.replyArabic);
    } catch (err: unknown) {
      console.error('[VoiceAssistant] Interpret error:', err);
      setError(err instanceof Error ? err.message : 'تعذر تحليل الأمر');
    } finally {
      setProcessing(false);
    }
  };

  const startLiveDictation = async () => {
    setError(null);
    const env = await checkVoiceEnvironment();
    if (!env.isSecureContext) {
      console.error('[VoiceAssistant] Dictation blocked: insecure context', env);
      setError('ميزة الإملاء الصوتي تتطلب اتصالاً آمناً (HTTPS أو localhost).');
      return;
    }

    type SpeechRecCtor = new () => {
      lang: string;
      interimResults: boolean;
      maxAlternatives: number;
      onstart: () => void;
      onresult: (e: {
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void;
      onerror: (e: { error: string; message?: string }) => void;
      onend: () => void;
      start: () => void;
      stop: () => void;
    };

    const win = window as unknown as {
      SpeechRecognition?: SpeechRecCtor;
      webkitSpeechRecognition?: SpeechRecCtor;
    };
    const Ctor = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!Ctor) {
      console.warn('[VoiceAssistant] SpeechRecognition API unavailable in this browser');
      setError('المتصفح لا يدعم الإملاء المباشر، استخدم زر التسجيل الصوتي.');
      return;
    }

    const rec = new Ctor();
    rec.lang = 'ar-EG';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let latestTranscript = '';

    rec.onstart = () => {
      console.info('[VoiceAssistant] SpeechRecognition started (ar-EG)');
    };

    rec.onresult = (event) => {
      let combined = '';
      for (let i = 0; i < event.results.length; i++) {
        combined += event.results[i][0]?.transcript || '';
      }
      latestTranscript = combined.trim();
      setInputText(latestTranscript);
      const last = event.results[event.results.length - 1];
      console.debug('[VoiceAssistant] SpeechRecognition result:', {
        isFinal: last?.isFinal,
        transcript: latestTranscript,
      });
      if (last?.isFinal && latestTranscript) {
        rec.stop();
      }
    };

    rec.onerror = (ev) => {
      console.error('[VoiceAssistant] SpeechRecognition error:', ev.error, ev.message);
      setDictating(false);
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        setError(
          env.inIframe
            ? 'تم منع إذن الميكروفون داخل إطار العرض أو المتصفح. تأكد من السماح بالمايك أو افتح التطبيق في تبويب مستقل.'
            : 'تم رفض إذن الميكروفون في المتصفح. اسمح بالمايك من أيقونة القفل بجانب الرابط.'
        );
      } else if (ev.error === 'no-speech') {
        setError('لم يتم سماع صوت واضح. حاول التحدث بالقرب من الميكروفون.');
      } else if (ev.error === 'audio-capture') {
        setError('لم يتم العثور على ميكروفون متاح أو أن الميكروفون مستخدم من تطبيق آخر.');
      } else {
        setError('تعذر الإملاء المباشر، يمكنك استخدام التسجيل الصوتي أو كتابة الأمر.');
      }
    };

    rec.onend = () => {
      console.info('[VoiceAssistant] SpeechRecognition ended, transcript=', latestTranscript);
      setDictating(false);
      recognitionRef.current = null;
      if (latestTranscript) {
        runInterpret(latestTranscript);
      }
    };

    try {
      recognitionRef.current = rec;
      setDictating(true);
      rec.start();
    } catch (startErr) {
      console.error('[VoiceAssistant] Failed to start SpeechRecognition:', startErr);
      setDictating(false);
      setError('تعذر بدء الإملاء الصوتي. استخدم التسجيل الصوتي أو اكتب الأمر أدناه.');
    }
  };

  const stopLiveDictation = () => {
    console.info('[VoiceAssistant] Stopping SpeechRecognition');
    recognitionRef.current?.stop();
    setDictating(false);
  };

  const startRecording = async () => {
    setError(null);
    const env = await checkVoiceEnvironment();

    if (!env.isSecureContext) {
      console.error('[VoiceAssistant] Blocked: page is not in a secure context (HTTPS required)');
      setError('تسجيل الصوت غير متاح لأن الاتصال غير آمن. يجب تشغيل التطبيق عبر HTTPS أو localhost.');
      return;
    }

    if (!env.hasMediaDevices) {
      console.error('[VoiceAssistant] navigator.mediaDevices.getUserMedia is not available');
      setError('واجهة الميكروفون (MediaDevices) غير متوفرة في هذا المتصفح أو نافذة العرض.');
      return;
    }

    if (!env.hasMediaRecorder) {
      console.error('[VoiceAssistant] MediaRecorder API is not supported in this browser');
      setError('المتصفح لا يدعم تسجيل الصوت (MediaRecorder). استخدم الإملاء الفوري أو اكتب الأمر.');
      return;
    }

    if (env.policyAllowsMic === false) {
      console.error('[VoiceAssistant] Microphone blocked by Permissions-Policy / iframe allow attribute');
      setError(
        'سياسة الأمان لإطار العرض (Permissions-Policy) تمنع استخدام الميكروفون هنا. افتح التطبيق في نافذة مستقلة أو اكتب الأمر مباشرة.'
      );
      return;
    }

    if (env.permissionState === 'denied') {
      console.warn('[VoiceAssistant] Microphone permission is currently in denied state');
      setError(
        'إذن الميكروفون محظور حالياً في المتصفح. يرجى السماح بالمايك من إعدادات الموقع (أيقونة القفل) ثم إعادة المحاولة.'
      );
      return;
    }

    try {
      let stream: MediaStream;
      try {
        console.info('[VoiceAssistant] Requesting getUserMedia with audio processing constraints');
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (constraintErr) {
        if (constraintErr instanceof DOMException && constraintErr.name === 'OverconstrainedError') {
          console.warn('[VoiceAssistant] OverconstrainedError, retrying with basic { audio: true }');
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
          throw constraintErr;
        }
      }

      const audioTracks = stream.getAudioTracks();
      console.info(
        '[VoiceAssistant] Microphone stream acquired:',
        audioTracks.map((t) => ({
          label: t.label,
          readyState: t.readyState,
          muted: t.muted,
          settings: typeof t.getSettings === 'function' ? t.getSettings() : null,
        }))
      );

      const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
        'audio/ogg',
      ];
      const supportedMimes =
        typeof MediaRecorder.isTypeSupported === 'function'
          ? candidates.filter((m) => MediaRecorder.isTypeSupported(m))
          : [];
      const chosenMime = supportedMimes[0];
      console.info('[VoiceAssistant] Supported MediaRecorder MIME types:', supportedMimes, 'chosen:', chosenMime);

      let recorder: MediaRecorder;
      try {
        recorder = chosenMime
          ? new MediaRecorder(stream, { mimeType: chosenMime, audioBitsPerSecond: 32000 })
          : new MediaRecorder(stream, { audioBitsPerSecond: 32000 });
      } catch {
        recorder = chosenMime ? new MediaRecorder(stream, { mimeType: chosenMime }) : new MediaRecorder(stream);
      }
      audioChunksRef.current = [];
      setRecordSeconds(0);

      if (recordTimerRef.current) window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = window.setInterval(() => {
        setRecordSeconds((s) => {
          const next = s + 1;
          if (next >= 45 && recorder.state !== 'inactive') {
            recorder.stop();
            setRecording(false);
          }
          return next;
        });
      }, 1000);

      recorder.onstart = () => {
        console.info('[VoiceAssistant] MediaRecorder started, mimeType=', recorder.mimeType);
      };

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          audioChunksRef.current.push(ev.data);
          console.debug('[VoiceAssistant] Audio chunk received:', ev.data.size, 'bytes');
        }
      };

      recorder.onerror = (ev) => {
        console.warn('[VoiceAssistant] MediaRecorder error event:', ev);
        if (recordTimerRef.current) {
          window.clearInterval(recordTimerRef.current);
          recordTimerRef.current = null;
        }
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        setProcessing(false);
        setError('حدث خطأ أثناء تسجيل الصوت من المتصفح. حاول مرة أخرى.');
      };

      recorder.onstop = async () => {
        if (recordTimerRef.current) {
          window.clearInterval(recordTimerRef.current);
          recordTimerRef.current = null;
        }
        stream.getTracks().forEach((t) => t.stop());

        const mime = recorder.mimeType || chosenMime || 'audio/webm';
        const blob = new Blob(audioChunksRef.current, { type: mime });
        console.info('[VoiceAssistant] Recording stopped:', {
          chunks: audioChunksRef.current.length,
          blobSize: blob.size,
          mime,
        });

        if (blob.size < 100) {
          console.warn('[VoiceAssistant] Captured audio blob too small (<100 bytes)');
          setError('التسجيل قصير جداً أو فارغ. اضغط على المايك وتحدث ثم أوقف التسجيل.');
          return;
        }

        const reader = new FileReader();
        reader.onerror = () => {
          console.warn('[VoiceAssistant] FileReader failed to read audio blob:', reader.error);
          setProcessing(false);
          setError('تعذر قراءة بيانات الصوت المسجل.');
        };
        reader.onloadend = async () => {
          const base64 = String(reader.result || '').split(',')[1];
          if (!base64) {
            console.warn('[VoiceAssistant] Base64 encoding of audio blob was empty');
            setError('تعذر ترميز الملف الصوتي. حاول مرة أخرى.');
            return;
          }
          setProcessing(true);
          const sttStart = Date.now();
          const uploadForTranscription = async () => {
            const controller = new AbortController();
            const timer = window.setTimeout(() => controller.abort(), 20000);
            try {
              return await apiFetch<{ transcript: string }>('/api/voice/transcribe', {
                method: 'POST',
                signal: controller.signal,
                body: JSON.stringify({
                  audioBase64: base64,
                  mimeType: mime,
                }),
              });
            } finally {
              window.clearTimeout(timer);
            }
          };

          try {
            console.info('[VoiceAssistant] Uploading audio to /api/voice/transcribe', {
              mimeType: mime,
              base64Len: base64.length,
            });
            let tr: { transcript: string };
            try {
              tr = await uploadForTranscription();
            } catch (firstErr: unknown) {
              const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
              const isTransient =
                firstMsg.includes('تعذر الاتصال بالخادم') ||
                firstMsg.includes('انتهت مهلة الاتصال') ||
                firstMsg.includes('502') ||
                firstMsg.includes('503');
              if (!isTransient) throw firstErr;
              console.warn('[VoiceAssistant] Transient transcription network error, retrying once...', firstMsg);
              await new Promise((r) => setTimeout(r, 600));
              tr = await uploadForTranscription();
            }

            console.info(
              `[VoiceAssistant] Transcription succeeded in ${Date.now() - sttStart}ms:`,
              tr.transcript
            );
            if (!tr.transcript || !tr.transcript.trim()) {
              setError('لم يتم التقاط كلام واضح في التسجيل، حاول التحدث بصوت أوضح أو اكتب الأمر.');
              setProcessing(false);
              return;
            }
            setInputText(tr.transcript);
            await runInterpret(tr.transcript);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'تعذر نسخ الصوت';
            console.warn(
              `[VoiceAssistant] Transcription failed after ${Date.now() - sttStart}ms: ${msg}`
            );
            setError(
              msg.includes('Failed to fetch')
                ? 'تعذر الاتصال بالخادم لتحويل الصوت، يرجى المحاولة مرة أخرى أو استخدام الإملاء الفوري.'
                : msg
            );
            setProcessing(false);
          }
        };
        reader.readAsDataURL(blob);
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250);
      setRecording(true);
    } catch (err: unknown) {
      const name = err instanceof DOMException ? err.name : 'UnknownError';
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[VoiceAssistant] getUserMedia error:', {
        name,
        message: msg,
        isSecureContext: env.isSecureContext,
        inIframe: env.inIframe,
      });

      if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
        setError(
          env.inIframe
            ? 'تم رفض إذن الميكروفون من المتصفح أو إطار المعاينة. فعّل إذن الميكروفون من إعدادات المتصفح أو افتح التطبيق في نافذة مستقلة.'
            : 'تم رفض إذن الميكروفون. اسمح بالوصول للمايك من أيقونة القفل بجانب الرابط ثم حاول مرة أخرى.'
        );
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setError('لم يتم العثور على جهاز ميكروفون متصل بهذا الجهاز.');
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        setError('الميكروفون قيد الاستخدام حالياً بواسطة تطبيق آخر أو تعذر تشغيله.');
      } else {
        setError(`تعذر تشغيل الميكروفون (${name}). يمكنك استخدام كتابة الأمر باللهجة المصرية أدناه.`);
      }
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && recording) {
      console.info('[VoiceAssistant] Stopping MediaRecorder...');
      if (mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      setRecording(false);
    }
  };

  const handleConfirmExecution = async () => {
    if (!result || !editablePayload) return;
    setProcessing(true);
    setError(null);
    try {
      const res = await apiFetch<{ ok: boolean; replyArabic: string }>('/api/voice/confirm', {
        method: 'POST',
        body: JSON.stringify({
          logId: result.logId,
          payload: editablePayload,
        }),
      });
      setConfirmMessage(res.replyArabic);
      setResult((prev) => (prev ? { ...prev, requiresConfirmation: false } : null));
      setEditablePayload(null);
      await loadLogs();
      void speakArabic(res.replyArabic);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تنفيذ العملية المالية');
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#0B1F3A]">
            المساعد الصوتي الذكي (باللهجة المصرية)
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            تحدث أو اكتب أوامرك باللهجة المصرية — العمليات المالية لا تُنفذ إلا بعد تأكيدك الصريح
          </p>
        </div>

        <button
          onClick={() => setVoiceEnabled(!voiceEnabled)}
          className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer self-start"
        >
          {voiceEnabled ? (
            <>
              <Volume2 className="w-4 h-4 text-[#0B1F3A]" />
              الرد الصوتي مفعل
            </>
          ) : (
            <>
              <VolumeX className="w-4 h-4 text-slate-400" />
              الرد الصوتي صامت
            </>
          )}
        </button>
      </div>

      {/* Main Interaction Console */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-5">
        <div className="flex flex-col lg:flex-row items-stretch lg:items-center gap-3">
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={recording ? stopRecording : startRecording}
              disabled={processing || dictating}
              className={`flex items-center justify-center gap-2 rounded-xl px-5 py-3.5 text-xs font-bold transition-colors cursor-pointer shrink-0 disabled:opacity-50 ${
                recording
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'bg-[#0B1F3A] text-white hover:bg-[#13325c]'
              }`}
            >
              {recording ? (
                <>
                  <MicOff className="w-4 h-4" />
                  إيقاف وإرسال ({recordSeconds}ث)
                </>
              ) : (
                <>
                  <Mic className="w-4 h-4 text-[#C89B3C]" />
                  تسجيل أمر صوتي
                </>
              )}
            </button>

            {supportsSpeechRecognition && (
              <button
                type="button"
                onClick={dictating ? stopLiveDictation : startLiveDictation}
                disabled={processing || recording}
                className={`flex items-center justify-center gap-2 rounded-xl border px-4 py-3.5 text-xs font-bold transition-colors cursor-pointer shrink-0 disabled:opacity-50 ${
                  dictating
                    ? 'border-red-300 bg-red-50 text-red-700'
                    : 'border-slate-300 bg-slate-50 text-[#0B1F3A] hover:bg-slate-100'
                }`}
              >
                <Mic className="w-4 h-4 text-[#C89B3C]" />
                {dictating ? 'جاري الاستماع... (إيقاف)' : 'إملاء فوري (مصري)'}
              </button>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              runInterpret(inputText);
            }}
            className="flex-1 flex items-center gap-2"
          >
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="اكتب أمرك هنا بالمصري..."
              className="flex-1 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm focus:border-[#0B1F3A] focus:outline-none"
            />
            <button
              type="submit"
              disabled={processing || !inputText.trim()}
              className="flex items-center gap-2 rounded-xl bg-[#C89B3C] px-5 py-3 text-xs font-bold text-[#0B1F3A] hover:bg-[#d6aa4c] disabled:opacity-50 cursor-pointer shrink-0"
            >
              {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              تنفيذ
            </button>
          </form>
        </div>

        {/* Egyptian Voice / Text Command Examples */}
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="font-semibold text-slate-500">أمثلة أوامر صوتية ونصية:</span>
          {[
            'ادي السواق 1025 سلفة 500 جنيه',
            'عدل سلفة السواق 1025 لـ 350 جنيه',
            'احذف آخر سلفة للسواق 1025',
            'عدل تغطية السواق 1025 لخصم 300',
            'احذف تغطية السواق 1025',
          ].map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setInputText(ex)}
              className="rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 px-2.5 py-1 text-slate-700 cursor-pointer"
            >
              {ex}
            </button>
          ))}
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-800">
            {error}
          </div>
        )}

        {confirmMessage && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-900 flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0" />
            <span>{confirmMessage}</span>
          </div>
        )}

        {/* Assistant Reply & Mandatory Confirmation Card */}
        {result && (
          <div className="border border-slate-200 rounded-xl p-5 bg-slate-50 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs text-slate-500">رد المساعد الذكي:</div>
                <div className="mt-1 text-base font-bold text-[#0B1F3A] leading-relaxed">
                  {result.replyArabic}
                </div>
              </div>
              <span className="text-[11px] font-mono text-slate-500 shrink-0">
                {result.intent}
              </span>
            </div>

            {result.requiresConfirmation && editablePayload && (
              <div
                className={`bg-white border rounded-xl p-5 space-y-4 ${
                  editablePayload.intent === 'delete_advance' ||
                  editablePayload.intent === 'delete_coverage'
                    ? 'border-red-300'
                    : 'border-amber-300'
                }`}
              >
                <div
                  className={`flex items-center gap-2 text-sm font-bold ${
                    editablePayload.intent === 'delete_advance' ||
                    editablePayload.intent === 'delete_coverage'
                      ? 'text-red-700'
                      : 'text-amber-800'
                  }`}
                >
                  <ShieldAlert className="w-5 h-5" />
                  <span>
                    {editablePayload.intent === 'edit_advance'
                      ? 'تأكيد تعديل السلفة قبل الحفظ في قاعدة البيانات'
                      : editablePayload.intent === 'delete_advance'
                      ? 'تأكيد حذف السلفة قبل التنفيذ'
                      : editablePayload.intent === 'edit_coverage'
                      ? 'تأكيد تعديل سجل التغطية قبل الحفظ'
                      : editablePayload.intent === 'delete_coverage'
                      ? 'تأكيد حذف سجل التغطية قبل التنفيذ'
                      : 'تأكيد العملية المالية قبل الحفظ في قاعدة البيانات'}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                  <div>
                    <div className="text-slate-500">السائق المطابق</div>
                    <div className="font-bold text-slate-900 mt-0.5">
                      {editablePayload.driverName} (كود {editablePayload.driverCode})
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500">المدرسة والباص</div>
                    <div className="font-semibold text-slate-800 mt-0.5">
                      {editablePayload.schoolName} · {editablePayload.busNumber}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500">صافي الراتب الحالي</div>
                    <div className="font-mono font-bold text-[#0B1F3A] mt-0.5 tabular-nums">
                      {formatEGP(result.queryResult?.currentNetSalary ?? 0)}
                    </div>
                  </div>
                </div>

                {/* Record Picker when editing/deleting existing Advances */}
                {(editablePayload.intent === 'edit_advance' ||
                  editablePayload.intent === 'delete_advance') &&
                  result.queryResult?.availableAdvances &&
                  result.queryResult.availableAdvances.length > 0 && (
                    <div className="border-t border-slate-100 pt-3 space-y-2 text-xs">
                      <div className="font-semibold text-slate-700">
                        اختر السلفة المطلوب{' '}
                        {editablePayload.intent === 'delete_advance' ? 'حذفها' : 'تعديلها'}:
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {result.queryResult.availableAdvances.map((adv) => {
                          const selected = editablePayload.targetRecordId === adv.id;
                          return (
                            <button
                              key={adv.id}
                              type="button"
                              onClick={() =>
                                setEditablePayload({
                                  ...editablePayload,
                                  targetRecordId: adv.id,
                                  date: adv.date,
                                  reason: adv.reason || '',
                                  paymentMethod: adv.paymentMethod || 'cash',
                                  amount:
                                    editablePayload.intent === 'delete_advance'
                                      ? adv.amount
                                      : editablePayload.amount || adv.amount,
                                })
                              }
                              className={`text-right rounded-lg border p-2.5 cursor-pointer transition-colors ${
                                selected
                                  ? 'border-[#0B1F3A] bg-[#0B1F3A] text-white'
                                  : 'border-slate-200 bg-slate-50 text-slate-800 hover:bg-slate-100'
                              }`}
                            >
                              <div className="flex items-center justify-between font-mono font-bold">
                                <span>{formatEGP(adv.amount)}</span>
                                <span>{adv.date}</span>
                              </div>
                              <div
                                className={`mt-1 text-[11px] truncate ${
                                  selected ? 'text-slate-200' : 'text-slate-500'
                                }`}
                              >
                                {adv.reason || 'بدون سبب'} · {adv.paymentMethod || 'كاش'}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                {/* Record Picker when editing/deleting existing Coverages */}
                {(editablePayload.intent === 'edit_coverage' ||
                  editablePayload.intent === 'delete_coverage') &&
                  result.queryResult?.availableCoverages &&
                  result.queryResult.availableCoverages.length > 0 && (
                    <div className="border-t border-slate-100 pt-3 space-y-2 text-xs">
                      <div className="font-semibold text-slate-700">
                        اختر سجل التغطية المطلوب{' '}
                        {editablePayload.intent === 'delete_coverage' ? 'حذفه' : 'تعديله'}:
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {result.queryResult.availableCoverages.map((cov) => {
                          const selected = editablePayload.targetRecordId === cov.id;
                          const unifiedCovAmt =
                            cov.absentDriverDeduction || cov.actualReplacementCost || 0;
                          return (
                            <button
                              key={cov.id}
                              type="button"
                              onClick={() =>
                                setEditablePayload({
                                  ...editablePayload,
                                  targetRecordId: cov.id,
                                  date: cov.date,
                                  replacementQuery: cov.replacementName,
                                  amount:
                                    editablePayload.intent === 'delete_coverage'
                                      ? unifiedCovAmt
                                      : editablePayload.amount || unifiedCovAmt,
                                  actualReplacementCost:
                                    editablePayload.intent === 'delete_coverage'
                                      ? unifiedCovAmt
                                      : editablePayload.actualReplacementCost || unifiedCovAmt,
                                  absentDriverDeduction:
                                    editablePayload.intent === 'delete_coverage'
                                      ? unifiedCovAmt
                                      : editablePayload.absentDriverDeduction || unifiedCovAmt,
                                  reason: cov.reason || '',
                                })
                              }
                              className={`text-right rounded-lg border p-2.5 cursor-pointer transition-colors ${
                                selected
                                  ? 'border-[#0B1F3A] bg-[#0B1F3A] text-white'
                                  : 'border-slate-200 bg-slate-50 text-slate-800 hover:bg-slate-100'
                              }`}
                            >
                              <div className="flex items-center justify-between font-mono font-bold">
                                <span>{formatEGP(unifiedCovAmt)}</span>
                                <span>{cov.date}</span>
                              </div>
                              <div
                                className={`mt-1 text-[11px] truncate ${
                                  selected ? 'text-slate-200' : 'text-slate-500'
                                }`}
                              >
                                البديل: {cov.replacementName || '—'} · {cov.reason || 'تغطية'}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                {/* Editable Inputs (Hidden in delete confirm modes where read-only summary suffices) */}
                {editablePayload.intent !== 'delete_advance' &&
                  editablePayload.intent !== 'delete_coverage' && (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs border-t border-slate-100 pt-3">
                      <div>
                        <label className="block font-semibold text-slate-700 mb-1">التاريخ</label>
                        <input
                          type="date"
                          value={editablePayload.date}
                          onChange={(e) =>
                            setEditablePayload({ ...editablePayload, date: e.target.value })
                          }
                          className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                        />
                      </div>
                      {editablePayload.intent === 'record_coverage' ||
                      editablePayload.intent === 'edit_coverage' ? (
                        <>
                          <div>
                            <label className="block font-semibold text-slate-700 mb-1">
                              مبلغ التغطية (ج.م)
                            </label>
                            <input
                              type="number"
                              value={
                                editablePayload.absentDriverDeduction ||
                                editablePayload.actualReplacementCost ||
                                editablePayload.amount ||
                                0
                              }
                              onChange={(e) => {
                                const val = Number(e.target.value);
                                setEditablePayload({
                                  ...editablePayload,
                                  amount: val,
                                  actualReplacementCost: val,
                                  absentDriverDeduction: val,
                                });
                              }}
                              className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                            />
                          </div>
                          <div>
                            <label className="block font-semibold text-slate-700 mb-1">
                              السائق البديل
                            </label>
                            <input
                              value={editablePayload.replacementQuery || ''}
                              onChange={(e) =>
                                setEditablePayload({
                                  ...editablePayload,
                                  replacementQuery: e.target.value,
                                })
                              }
                              placeholder="اسم أو كود البديل"
                              className="w-full rounded-lg border border-slate-200 px-3 py-2"
                            />
                          </div>
                          <div className="sm:col-span-3">
                            <label className="block font-semibold text-slate-700 mb-1">السبب</label>
                            <input
                              value={editablePayload.reason}
                              onChange={(e) =>
                                setEditablePayload({ ...editablePayload, reason: e.target.value })
                              }
                              className="w-full rounded-lg border border-slate-200 px-3 py-2"
                            />
                          </div>
                        </>
                      ) : (
                        <>
                          <div>
                            <label className="block font-semibold text-slate-700 mb-1">
                              المبلغ (ج.م)
                            </label>
                            <input
                              type="number"
                              value={editablePayload.amount}
                              onChange={(e) =>
                                setEditablePayload({
                                  ...editablePayload,
                                  amount: Number(e.target.value),
                                })
                              }
                              className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                            />
                          </div>
                          <div>
                            <label className="block font-semibold text-slate-700 mb-1">السبب</label>
                            <input
                              value={editablePayload.reason}
                              onChange={(e) =>
                                setEditablePayload({ ...editablePayload, reason: e.target.value })
                              }
                              className="w-full rounded-lg border border-slate-200 px-3 py-2"
                            />
                          </div>
                          {editablePayload.intent === 'edit_advance' && (
                            <div className="sm:col-span-3">
                              <label className="block font-semibold text-slate-700 mb-1">
                                طريقة الدفع
                              </label>
                              <input
                                value={editablePayload.paymentMethod}
                                onChange={(e) =>
                                  setEditablePayload({
                                    ...editablePayload,
                                    paymentMethod: e.target.value,
                                  })
                                }
                                className="w-full rounded-lg border border-slate-200 px-3 py-2"
                              />
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}

                <div className="flex items-center gap-3 pt-2">
                  <button
                    onClick={handleConfirmExecution}
                    disabled={processing}
                    className={`flex items-center gap-2 rounded-lg px-5 py-2.5 text-xs font-bold text-white cursor-pointer ${
                      editablePayload.intent === 'delete_advance' ||
                      editablePayload.intent === 'delete_coverage'
                        ? 'bg-red-600 hover:bg-red-700'
                        : 'bg-[#0B1F3A] hover:bg-[#13325c]'
                    }`}
                  >
                    <CheckCircle2 className="w-4 h-4 text-[#C89B3C]" />
                    {editablePayload.intent === 'edit_advance'
                      ? 'تأكيد تعديل السلفة'
                      : editablePayload.intent === 'delete_advance'
                      ? 'تأكيد حذف السلفة'
                      : editablePayload.intent === 'edit_coverage'
                      ? 'تأكيد تعديل التغطية'
                      : editablePayload.intent === 'delete_coverage'
                      ? 'تأكيد حذف التغطية'
                      : 'تأكيد وتنفيذ العملية'}
                  </button>
                  <button
                    onClick={() => {
                      setEditablePayload(null);
                      setResult(null);
                    }}
                    className="flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 cursor-pointer"
                  >
                    <XCircle className="w-4 h-4" />
                    إلغاء
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Command Logs */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 font-bold text-sm text-[#0B1F3A]">
          سجل الأوامر الصوتية المنفذة
        </div>
        <div className="divide-y divide-slate-100">
          {logs.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-400">
              لم يتم تسجيل أوامر صوتية بعد
            </div>
          ) : (
            logs.map((l) => (
              <div key={l.id} className="p-4 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <div className="font-bold text-slate-900">"{l.rawTranscript}"</div>
                  <div className="text-slate-600 mt-1">{l.responseArabic}</div>
                </div>
                <div className="text-left shrink-0">
                  <div className="font-mono text-[11px] text-slate-500">
                    {l.parsedIntent} · {l.executionStatus}
                  </div>
                  <div className="font-mono text-[11px] text-slate-400 tabular-nums">
                    {new Date(l.createdAt).toLocaleString('ar-EG')}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
