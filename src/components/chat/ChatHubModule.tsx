import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCheck,
  ChevronLeft,
  Loader2,
  Mic,
  MicOff,
  Paperclip,
  Phone,
  PhoneCall,
  PhoneForwarded,
  PhoneOff,
  Radio,
  RadioTower,
  RefreshCw,
  Send,
  Square,
  StopCircle,
  Trash2,
  User,
  Users,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch, formatRelativeArabicTime } from '../../lib/api';
import type { ChatChannel, ChatMessage, ChatMessageType } from '../../types';

export interface ChatHubModuleProps {
  currentRole?: 'admin' | 'driver' | 'supervisor';
  initialRoomKey?: string;
  onClose?: () => void;
  compact?: boolean;
}

export const ChatHubModule: React.FC<ChatHubModuleProps> = ({
  currentRole = 'admin',
  initialRoomKey = 'broadcast',
  onClose,
  compact = false,
}) => {
  const { dbUser, driverRecord, supervisorRecord } = useAuth();

  const [channels, setChannels] = useState<ChatChannel[]>([]);
  const [activeRoomKey, setActiveRoomKey] = useState<string>(initialRoomKey);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingChannels, setLoadingChannels] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [textInput, setTextInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // WebSocket real-time connection state
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  // Voice note recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [audioBlobUrl, setAudioBlobUrl] = useState<string | null>(null);
  const [audioBase64, setAudioBase64] = useState<string | null>(null);
  const [recordedDuration, setRecordedDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);

  // Live Audio Call / Walkie-Talkie state
  const [callActive, setCallActive] = useState(false);
  const [callStatus, setCallStatus] = useState<'idle' | 'calling' | 'connected' | 'ended'>('idle');
  const [callDuration, setCallDuration] = useState(0);
  const [pttTalking, setPttTalking] = useState(false);
  const callTimerRef = useRef<number | null>(null);

  // Auto-scroll messages container
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const myDisplayName =
    driverRecord?.fullName || supervisorRecord?.fullName || dbUser?.fullName || 'أنا';
  const myRole = driverRecord ? 'driver' : supervisorRecord ? 'supervisor' : dbUser?.roleSlug || currentRole;

  useEffect(() => {
    if (initialRoomKey) {
      if (myRole === 'supervisor' && initialRoomKey === 'drivers_broadcast') return;
      setActiveRoomKey(initialRoomKey);
    }
  }, [initialRoomKey, myRole]);

  // 1. Establish WebSocket Connection with automatic reconnection
  useEffect(() => {
    let active = true;
    let reconnectTimeout: number | null = null;

    const connectWs = () => {
      try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws/chat`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (!active) return;
          setWsConnected(true);
          ws.send(
            JSON.stringify({
              type: 'auth',
              userId: dbUser?.id,
              role: myRole,
              name: myDisplayName,
              initialRooms: [activeRoomKey, 'broadcast'],
            })
          );
        };

        ws.onmessage = (event) => {
          if (!active) return;
          try {
            const data = JSON.parse(event.data);

            if (data.type === 'new_message' && data.message) {
              const newMsg: ChatMessage = data.message;
              if (newMsg.roomKey === activeRoomKey) {
                setMessages((prev) => {
                  if (prev.some((m) => m.id === newMsg.id)) return prev;
                  return [...prev, newMsg];
                });
                setTimeout(() => {
                  messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
                }, 100);
              }

              // Update channels list last message
              setChannels((prev) =>
                prev.map((c) =>
                  c.roomKey === newMsg.roomKey
                    ? {
                        ...c,
                        lastMessageText:
                          newMsg.messageType === 'voice_note'
                            ? `🎤 رسالة صوتية (${newMsg.audioDurationSec || 0}ث)`
                            : newMsg.textContent || '',
                        lastMessageAt: newMsg.createdAt,
                      }
                    : c
                )
              );
            }

            if (data.type === 'call_signal' && data.roomKey === activeRoomKey) {
              if (data.action === 'call_start') {
                setCallActive(true);
                setCallStatus('connected');
              } else if (data.action === 'call_end') {
                setCallActive(false);
                setCallStatus('ended');
                setTimeout(() => setCallStatus('idle'), 2500);
              }
            }
          } catch {
            // ignore malformed ws messages
          }
        };

        ws.onclose = () => {
          if (!active) return;
          setWsConnected(false);
          reconnectTimeout = window.setTimeout(connectWs, 3500);
        };

        ws.onerror = () => {
          ws.close();
        };
      } catch {
        setWsConnected(false);
      }
    };

    connectWs();

    return () => {
      active = false;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (wsRef.current) wsRef.current.close();
    };
  }, [dbUser?.id, myRole, myDisplayName, activeRoomKey]);

  // 2. Load Channels
  const fetchChannels = useCallback(async () => {
    try {
      const res = await apiFetch<{ ok: boolean; channels: ChatChannel[] }>('/api/chat/channels');
      if (res.channels) {
        const filtered =
          myRole === 'supervisor'
            ? res.channels.filter(
                (c) => c.roomKey !== 'drivers_broadcast' && c.channelType !== 'drivers_broadcast'
              )
            : res.channels;
        setChannels(filtered);
      }
    } catch (err: unknown) {
      console.warn('Error fetching channels:', err);
    } finally {
      setLoadingChannels(false);
    }
  }, [myRole]);

  useEffect(() => {
    fetchChannels();
  }, [fetchChannels]);

  // 3. Load Messages for Active Room
  const fetchMessages = useCallback(
    async (roomKey: string, silent = false) => {
      if (!silent) setLoadingMessages(true);
      setError(null);
      try {
        const res = await apiFetch<{ ok: boolean; messages: ChatMessage[] }>(
          `/api/chat/messages?roomKey=${encodeURIComponent(roomKey)}`
        );
        if (res.messages) {
          setMessages(res.messages);
          setTimeout(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
          }, 80);
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'تعذر تحميل الرسائل');
      } finally {
        if (!silent) setLoadingMessages(false);
      }
    },
    []
  );

  useEffect(() => {
    fetchMessages(activeRoomKey);
    // Join room on WebSocket
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'join_room', roomKey: activeRoomKey }));
    }

    // Polling fallback every 8 seconds
    const interval = setInterval(() => {
      fetchMessages(activeRoomKey, true);
    }, 8000);

    return () => clearInterval(interval);
  }, [activeRoomKey, fetchMessages]);

  // 4. Send Text Message
  const handleSendText = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = textInput.trim();
    if (!trimmed || sending) return;

    setSending(true);
    setTextInput('');
    setError(null);

    try {
      const res = await apiFetch<{ ok: boolean; message: ChatMessage }>('/api/chat/messages', {
        method: 'POST',
        body: JSON.stringify({
          roomKey: activeRoomKey,
          messageType: 'text',
          textContent: trimmed,
        }),
      });

      if (res.message) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === res.message.id)) return prev;
          return [...prev, res.message];
        });
        setTimeout(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }, 100);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر إرسال الرسالة');
    } finally {
      setSending(false);
    }
  };

  // 5. Voice Note Recording Implementation
  const startRecording = async () => {
    setError(null);
    setAudioBlobUrl(null);
    setAudioBase64(null);
    setRecordingSeconds(0);
    audioChunksRef.current = [];

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setError('تسجيل الصوت غير مدعوم في هذا المتصفح');
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
        ? 'audio/ogg;codecs=opus'
        : 'audio/mp4';

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        const blobUrl = URL.createObjectURL(audioBlob);
        setAudioBlobUrl(blobUrl);

        // Convert to Base64
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = () => {
          const base64data = reader.result as string;
          setAudioBase64(base64data);
        };

        // Stop all audio tracks to release microphone
        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorder.start(250);
      setIsRecording(true);

      const startTime = Date.now();
      recordTimerRef.current = window.setInterval(() => {
        const secs = Math.floor((Date.now() - startTime) / 1000);
        setRecordingSeconds(secs);
        setRecordedDuration(secs);
      }, 500);
    } catch {
      setError('يرجى السماح بصلاحية الميكروفون لتسجيل الرسائل الصوتية');
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
    }
    setIsRecording(false);
  };

  const cancelRecording = () => {
    stopRecording();
    setAudioBlobUrl(null);
    setAudioBase64(null);
    setRecordingSeconds(0);
    audioChunksRef.current = [];
  };

  const sendVoiceNote = async () => {
    if (!audioBase64 || sending) return;
    setSending(true);
    setError(null);

    try {
      const res = await apiFetch<{ ok: boolean; message: ChatMessage }>('/api/chat/messages', {
        method: 'POST',
        body: JSON.stringify({
          roomKey: activeRoomKey,
          messageType: 'voice_note',
          audioDataUrl: audioBase64,
          audioDurationSec: Math.max(1, recordedDuration),
        }),
      });

      if (res.message) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === res.message.id)) return prev;
          return [...prev, res.message];
        });
        cancelRecording();
        setTimeout(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }, 100);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر إرسال التسجيل الصوتي');
    } finally {
      setSending(false);
    }
  };

  // 6. Live Audio / Direct Voice Call & PTT Walkie-Talkie
  const handleStartCall = async () => {
    setCallActive(true);
    setCallStatus('calling');
    setCallDuration(0);

    try {
      await apiFetch('/api/chat/call-signal', {
        method: 'POST',
        body: JSON.stringify({
          roomKey: activeRoomKey,
          action: 'call_start',
        }),
      });

      setCallStatus('connected');
      const startT = Date.now();
      callTimerRef.current = window.setInterval(() => {
        setCallDuration(Math.floor((Date.now() - startT) / 1000));
      }, 1000);
    } catch {
      setCallActive(false);
      setCallStatus('idle');
      setError('تعذر بدء المكالمة الصوتية');
    }
  };

  const handleEndCall = async () => {
    if (callTimerRef.current) clearInterval(callTimerRef.current);
    setCallStatus('ended');

    try {
      await apiFetch('/api/chat/call-signal', {
        method: 'POST',
        body: JSON.stringify({
          roomKey: activeRoomKey,
          action: 'call_end',
        }),
      });
    } catch {
      // ignore
    } finally {
      setTimeout(() => {
        setCallActive(false);
        setCallStatus('idle');
      }, 1000);
    }
  };

  const activeChannel = channels.find((c) => c.roomKey === activeRoomKey) || {
    id: 0,
    roomKey: activeRoomKey,
    title: activeRoomKey === 'broadcast' ? 'غرفة العمليات والطوارئ العامة' : 'محادثة مباشرة',
    channelType: 'broadcast',
    lastMessageAt: new Date().toISOString(),
  };

  const formatTimer = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const getRoleBadge = (role: string) => {
    switch (role) {
      case 'super_admin':
      case 'admin':
        return { text: 'الإدارة', color: 'bg-amber-100 text-amber-800 border-amber-200' };
      case 'driver':
        return { text: 'سائق', color: 'bg-blue-100 text-blue-800 border-blue-200' };
      case 'supervisor':
        return { text: 'مشرفة', color: 'bg-emerald-100 text-emerald-800 border-emerald-200' };
      default:
        return { text: 'عضو', color: 'bg-slate-100 text-slate-700 border-slate-200' };
    }
  };

  return (
    <div className={`flex flex-col h-full bg-[#f8fafc] rounded-2xl border border-slate-200 overflow-hidden shadow-xs ${compact ? 'max-h-[550px]' : 'h-[680px]'}`}>
      {/* Top Main Navigation Bar */}
      <div className="bg-[#0B1F3A] text-white px-4 py-3 flex items-center justify-between gap-3 border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-semibold cursor-pointer shrink-0"
              title="العودة للقائمة السابقة"
            >
              <ChevronLeft className="w-4 h-4 rotate-180" />
              <span>رجوع</span>
            </button>
          )}
          <div className="w-9 h-9 rounded-xl bg-white/10 text-[#C89B3C] flex items-center justify-center shrink-0 border border-white/15">
            <RadioTower className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h2 className="font-display text-sm font-bold truncate">شبكة الاتصال والمحادثات الموحدة</h2>
            <div className="flex items-center gap-2 text-[11px] text-slate-300">
              <span className="flex items-center gap-1">
                {wsConnected ? (
                  <>
                    <Wifi className="w-3 h-3 text-emerald-400" />
                    <span className="text-emerald-300">متصل لحظياً</span>
                  </>
                ) : (
                  <>
                    <WifiOff className="w-3 h-3 text-amber-400" />
                    <span className="text-amber-300">مزامنة تلقائية</span>
                  </>
                )}
              </span>
              <span>·</span>
              <span className="truncate">{activeChannel.title}</span>
            </div>
          </div>
        </div>

        {/* Live Audio Call / Direct PTT Trigger */}
        <div className="flex items-center gap-2 shrink-0">
          {!callActive ? (
            <button
              type="button"
              onClick={handleStartCall}
              className="min-h-[36px] inline-flex items-center gap-1.5 rounded-xl bg-[#C89B3C] hover:bg-[#d8ac4e] px-3 text-xs font-bold text-[#0B1F3A] transition-colors cursor-pointer shadow-xs"
              title="بدء مكالمة صوتية أو لاسلكي مباشر"
            >
              <PhoneCall className="w-3.5 h-3.5" />
              <span>مكالمة صوتية</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={handleEndCall}
              className="min-h-[36px] inline-flex items-center gap-1.5 rounded-xl bg-red-600 hover:bg-red-700 px-3 text-xs font-bold text-white transition-colors cursor-pointer"
            >
              <PhoneOff className="w-3.5 h-3.5" />
              <span>إنهاء ({formatTimer(callDuration)})</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Split Grid (Channels Sidebar + Active Chat Stream) */}
      <div className="flex-1 flex flex-col md:flex-row min-h-0 overflow-hidden">
        {/* Left / Sidebar: Channels & Routes */}
        <div className="w-full md:w-64 lg:w-72 bg-white border-b md:border-b-0 md:border-l border-slate-200 flex flex-col shrink-0 overflow-y-auto max-h-40 md:max-h-full">
          <div className="p-3 border-b border-slate-100 bg-slate-50/70 text-xs font-bold text-slate-700 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5 text-[#C89B3C]" />
              <span>غرف المحادثة وخطوط السير</span>
            </span>
            <button
              onClick={fetchChannels}
              className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
              title="تحديث الغرف"
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          </div>

          <div className="divide-y divide-slate-100 overflow-y-auto flex-1">
            {loadingChannels ? (
              <div className="p-4 text-center text-xs text-slate-400 flex items-center justify-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>جاري تحميل الغرف...</span>
              </div>
            ) : (
              channels.map((chan) => {
                const isActive = chan.roomKey === activeRoomKey;
                return (
                  <button
                    key={chan.id || chan.roomKey}
                    type="button"
                    onClick={() => setActiveRoomKey(chan.roomKey)}
                    className={`w-full text-right p-3 transition-colors cursor-pointer flex flex-col gap-1 ${
                      isActive ? 'bg-[#0B1F3A]/5 border-r-4 border-r-[#C89B3C]' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-xs font-bold truncate ${isActive ? 'text-[#0B1F3A]' : 'text-slate-800'}`}>
                        {chan.title}
                      </span>
                      <span className="text-[10px] text-slate-400 shrink-0 font-mono">
                        {chan.lastMessageAt ? formatRelativeArabicTime(chan.lastMessageAt) : ''}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-slate-500">
                      <p className="truncate max-w-[170px]">{chan.lastMessageText || 'لا توجد رسائل بعد'}</p>
                      {chan.channelType === 'drivers_broadcast' ? (
                        <span className="text-[10px] text-emerald-800 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded font-bold shrink-0">
                          للسائقين فقط
                        </span>
                      ) : chan.channelType === 'broadcast' ? (
                        <span className="text-[10px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded font-semibold shrink-0">
                          عام
                        </span>
                      ) : (
                        <span className="text-[10px] text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded font-semibold shrink-0">
                          خط سير
                        </span>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Right: Active Conversation Pane */}
        <div className="flex-1 flex flex-col min-w-0 bg-[#f8fafc] relative">
          {activeRoomKey === 'drivers_broadcast' && (
            <div className="bg-[#0B1F3A]/5 border-b border-slate-200 px-4 py-2 text-[11px] text-[#0B1F3A] flex items-center justify-between gap-2 shrink-0">
              <span className="font-semibold">
                قناة الرسائل الجماعية للسائقين — تصل لجميع السائقين فقط وتُستثنى المشرفات
              </span>
              <span className="font-mono text-[10px] text-emerald-700 font-bold">
                للسائقين فقط
              </span>
            </div>
          )}
          {/* Active Call Floating Banner */}
          {callActive && (
            <div className="bg-gradient-to-r from-emerald-600 to-teal-700 text-white px-4 py-2.5 flex items-center justify-between gap-3 text-xs shadow-md shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <Radio className="w-4 h-4 text-emerald-200 animate-pulse shrink-0" />
                <span className="font-semibold truncate">
                  مكالمة صوتية مباشرة مع {activeChannel.title}
                </span>
                <span className="font-mono bg-white/20 px-2 py-0.5 rounded text-[11px] tabular-nums shrink-0">
                  {formatTimer(callDuration)}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onMouseDown={() => setPttTalking(true)}
                  onMouseUp={() => setPttTalking(false)}
                  onTouchStart={() => setPttTalking(true)}
                  onTouchEnd={() => setPttTalking(false)}
                  className={`px-3 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                    pttTalking
                      ? 'bg-amber-400 text-[#0B1F3A] scale-105 shadow-md'
                      : 'bg-white/20 hover:bg-white/30 text-white'
                  }`}
                >
                  {pttTalking ? '🔊 متحدث الآن' : 'اضغط للتحدث (PTT)'}
                </button>
                <button
                  type="button"
                  onClick={handleEndCall}
                  className="p-1 rounded-lg bg-red-500 hover:bg-red-600 text-white cursor-pointer"
                  title="إنهاء المكالمة"
                >
                  <PhoneOff className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="m-3 p-2.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 flex items-center justify-between gap-2 shrink-0">
              <span className="flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {error}
              </span>
              <button onClick={() => setError(null)} className="p-1 text-red-500 hover:text-red-700 cursor-pointer">
                ✕
              </button>
            </div>
          )}

          {/* Messages Stream Area */}
          <div className="flex-1 p-4 overflow-y-auto space-y-3 min-h-0">
            {loadingMessages ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-400 gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-[#C89B3C]" />
                <span>جاري تحميل المحادثة...</span>
              </div>
            ) : messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400 space-y-2">
                <RadioTower className="w-10 h-10 text-slate-300" />
                <p className="text-xs font-semibold text-slate-600">لا توجد رسائل سابقة في هذه الغرفة</p>
                <p className="text-[11px] text-slate-400 max-w-xs">
                  يمكنك إرسال رسالة نصية، تسجيل فويس نوت، أو بدء مكالمة صوتية مباشرة مع السائق والمشرفة.
                </p>
              </div>
            ) : (
              messages.map((msg) => {
                const isMine =
                  (dbUser?.id && msg.senderUserId === dbUser.id) ||
                  msg.senderName === myDisplayName;
                const roleBadge = getRoleBadge(msg.senderRole);

                if (msg.messageType === 'call_log') {
                  return (
                    <div key={msg.id} className="flex justify-center my-2">
                      <div className="bg-slate-200/80 text-slate-700 text-[11px] px-3 py-1 rounded-full flex items-center gap-1.5 font-medium">
                        <Phone className="w-3 h-3 text-[#C89B3C]" />
                        <span>{msg.textContent}</span>
                        <span className="text-slate-400 font-mono tabular-nums">· {formatRelativeArabicTime(msg.createdAt)}</span>
                      </div>
                    </div>
                  );
                }

                return (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${isMine ? 'items-end' : 'items-start'} max-w-[85%] sm:max-w-[75%] ${
                      isMine ? 'mr-auto' : 'ml-auto'
                    }`}
                  >
                    {/* Sender Header */}
                    <div className="flex items-center gap-1.5 mb-1 px-1 text-[11px]">
                      <span className="font-bold text-slate-700">{msg.senderName}</span>
                      <span className={`text-[10px] px-1.5 py-0.2 rounded border font-semibold ${roleBadge.color}`}>
                        {roleBadge.text}
                      </span>
                      <span className="text-slate-400 font-mono text-[10px] tabular-nums">
                        {formatRelativeArabicTime(msg.createdAt)}
                      </span>
                    </div>

                    {/* Bubble Content */}
                    <div
                      className={`p-3 rounded-2xl text-xs leading-relaxed shadow-2xs ${
                        isMine
                          ? 'bg-[#0B1F3A] text-white rounded-br-xs'
                          : 'bg-white text-slate-800 border border-slate-200 rounded-bl-xs'
                      }`}
                    >
                      {msg.messageType === 'voice_note' && msg.audioDataUrl ? (
                        <div className="flex flex-col gap-2 min-w-[200px] sm:min-w-[240px]">
                          <div className="flex items-center gap-2">
                            <audio
                              controls
                              src={msg.audioDataUrl}
                              className="w-full h-8 max-w-[240px]"
                              preload="metadata"
                            />
                          </div>
                          <div className="flex items-center justify-between text-[10px] opacity-80 font-mono">
                            <span>🎤 رسالة صوتية</span>
                            <span>{msg.audioDurationSec ? `${msg.audioDurationSec} ثانية` : ''}</span>
                          </div>
                        </div>
                      ) : (
                        <p className="whitespace-pre-wrap break-words">{msg.textContent}</p>
                      )}
                    </div>
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Bottom Composer Area */}
          <div className="p-3 bg-white border-t border-slate-200 shrink-0">
            {/* Audio Recording Preview & Sender Mode */}
            {isRecording ? (
              <div className="flex items-center justify-between gap-3 bg-red-50 border border-red-200 rounded-xl px-4 py-2 text-xs text-red-700 animate-pulse">
                <div className="flex items-center gap-2 font-semibold">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-600 animate-ping" />
                  <span>جاري تسجيل رسالة صوتية...</span>
                  <span className="font-mono tabular-nums font-bold text-red-900">
                    {formatTimer(recordingSeconds)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={cancelRecording}
                    className="p-1.5 rounded-lg text-slate-500 hover:text-slate-700 cursor-pointer"
                    title="إلغاء التسجيل"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={stopRecording}
                    className="min-h-[32px] inline-flex items-center gap-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white px-3 text-xs font-bold cursor-pointer"
                  >
                    <Square className="w-3.5 h-3.5" />
                    <span>إيقاف ومعاينة</span>
                  </button>
                </div>
              </div>
            ) : audioBlobUrl ? (
              <div className="flex items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <audio controls src={audioBlobUrl} className="h-8 w-full max-w-[260px]" />
                  <span className="text-[11px] font-mono text-slate-600 shrink-0">
                    ({recordedDuration} ثانية)
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={cancelRecording}
                    className="p-1.5 rounded-lg text-red-600 hover:bg-red-50 cursor-pointer"
                    title="حذف التسجيل"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={sendVoiceNote}
                    disabled={sending}
                    className="min-h-[34px] inline-flex items-center gap-1.5 rounded-lg bg-[#0B1F3A] hover:bg-[#13325c] text-white px-3 text-xs font-bold cursor-pointer"
                  >
                    {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5 rotate-180" />}
                    <span>إرسال الفويس</span>
                  </button>
                </div>
              </div>
            ) : (
              /* Standard Text + Mic Composer Form */
              <form onSubmit={handleSendText} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={startRecording}
                  className="min-h-[42px] min-w-[42px] flex items-center justify-center rounded-xl bg-slate-100 hover:bg-amber-50 hover:text-[#C89B3C] text-slate-700 transition-colors cursor-pointer shrink-0"
                  title="تسجيل فويس نوت (رسالة صوتية)"
                >
                  <Mic className="w-4 h-4" />
                </button>

                <input
                  type="text"
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  placeholder={`اكتب رسالة إلى ${activeChannel.title}...`}
                  className="flex-1 min-h-[42px] rounded-xl border border-slate-300 bg-slate-50/50 px-3.5 py-2 text-xs text-slate-800 focus:outline-none focus:border-[#C89B3C] focus:bg-white transition-all"
                  dir="rtl"
                />

                <button
                  type="submit"
                  disabled={!textInput.trim() || sending}
                  className={`min-h-[42px] min-w-[42px] flex items-center justify-center rounded-xl transition-colors cursor-pointer shrink-0 ${
                    textInput.trim() && !sending
                      ? 'bg-[#0B1F3A] hover:bg-[#13325c] text-white'
                      : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  }`}
                  title="إرسال"
                >
                  {sending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4 rotate-180" />
                  )}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
