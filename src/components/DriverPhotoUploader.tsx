import React, { useEffect, useRef, useState } from 'react';
import {
  Camera,
  Check,
  Crop,
  ImagePlus,
  RotateCcw,
  RotateCw,
  Sun,
  Trash2,
  X,
  ZoomIn,
} from 'lucide-react';
import { DriverAvatar } from './DriverAvatar';
import { useEscapeKey } from '../lib/useEscapeKey';

interface DriverPhotoUploaderProps {
  photoUrl: string;
  driverName?: string;
  title?: string;
  subtitle?: string;
  onChange: (nextPhotoUrl: string) => void;
}

const VIEW_SIZE = 260;
const OUTPUT_SIZE = 360;

function readFileAsDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    return Promise.reject(new Error('يرجى اختيار ملف صورة صالح (JPG أو PNG أو WebP)'));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = typeof reader.result === 'string' ? reader.result : '';
      if (!res) reject(new Error('تعذر قراءة ملف الصورة'));
      else resolve(res);
    };
    reader.onerror = () => reject(new Error('تعذر قراءة ملف الصورة'));
    reader.readAsDataURL(file);
  });
}

export const DriverPhotoUploader: React.FC<DriverPhotoUploaderProps> = ({
  photoUrl,
  driverName,
  title = 'صورة السائق الشخصية',
  subtitle = 'ارفع صورة من الجهاز أو التقطها بالكاميرا مع إمكانية القص والتكبير والتدوير وضبط الإضاءة.',
  onChange,
}) => {
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const [processing, setProcessing] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Interactive Photo Editor State
  const [editorSrc, setEditorSrc] = useState<string | null>(null);
  const [imgDimensions, setImgDimensions] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [brightness, setBrightness] = useState(100);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null
  );

  useEscapeKey(Boolean(editorSrc), () => setEditorSrc(null));

  useEffect(() => {
    if (!editorSrc) {
      setImgDimensions(null);
      return;
    }
    const img = new Image();
    if (editorSrc.startsWith('http://') || editorSrc.startsWith('https://')) {
      img.crossOrigin = 'anonymous';
    }
    img.onload = () => {
      setImgDimensions({ w: img.naturalWidth || img.width, h: img.naturalHeight || img.height });
    };
    img.onerror = () => {
      setUploadError('تعذر فتح الصورة للتعديل');
      setEditorSrc(null);
    };
    img.src = editorSrc;
  }, [editorSrc]);

  const openEditorWithSrc = (src: string) => {
    setUploadError(null);
    setZoom(1);
    setRotation(0);
    setBrightness(100);
    setOffset({ x: 0, y: 0 });
    setEditorSrc(src);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setProcessing(true);
    setUploadError(null);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      openEditorWithSrc(dataUrl);
    } catch (err: unknown) {
      setUploadError(err instanceof Error ? err.message : 'تعذر تحميل الصورة');
    } finally {
      setProcessing(false);
    }
  };

  const getCoverScale = () => {
    if (!imgDimensions) return 1;
    const isSwapped = ((rotation % 180) + 180) % 180 !== 0;
    const effW = isSwapped ? imgDimensions.h : imgDimensions.w;
    const effH = isSwapped ? imgDimensions.w : imgDimensions.h;
    return Math.max(VIEW_SIZE / Math.max(1, effW), VIEW_SIZE / Math.max(1, effH));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: offset.x,
      origY: offset.y,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setOffset({
      x: dragRef.current.origX + dx,
      y: dragRef.current.origY + dy,
    });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      dragRef.current = null;
    }
  };

  const handleSaveEditedPhoto = async () => {
    if (!editorSrc) return;
    setProcessing(true);
    setUploadError(null);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        if (editorSrc.startsWith('http://') || editorSrc.startsWith('https://')) {
          el.crossOrigin = 'anonymous';
        }
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('تعذر معالجة الصورة المختارة'));
        el.src = editorSrc;
      });

      const canvas = document.createElement('canvas');
      canvas.width = OUTPUT_SIZE;
      canvas.height = OUTPUT_SIZE;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('المتصفح لا يدعم معالجة الصور');
      }

      const scale = getCoverScale() * zoom;
      const ratio = OUTPUT_SIZE / VIEW_SIZE;

      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

      ctx.save();
      if (brightness !== 100 && 'filter' in ctx) {
        ctx.filter = `brightness(${brightness}%)`;
      }
      ctx.translate(OUTPUT_SIZE / 2 + offset.x * ratio, OUTPUT_SIZE / 2 + offset.y * ratio);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.scale(scale * ratio, scale * ratio);
      ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
      ctx.restore();

      const finalDataUrl = canvas.toDataURL('image/jpeg', 0.85);
      onChange(finalDataUrl);
      setEditorSrc(null);
    } catch (err: unknown) {
      setUploadError(err instanceof Error ? err.message : 'تعذر حفظ الصورة المعدلة');
    } finally {
      setProcessing(false);
    }
  };

  const activeScale = getCoverScale() * zoom;

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex items-center gap-3">
          <DriverAvatar name={driverName} photoUrl={photoUrl} size="xl" />
          <div className="sm:hidden">
            <p className="text-xs font-bold text-[#0B1F3A]">{title}</p>
            <p className="text-[11px] text-slate-500 mt-0.5">
              يمكنك قص وتعديل الصورة قبل الحفظ
            </p>
          </div>
        </div>

        <div className="flex-1 space-y-2">
          <div className="hidden sm:block">
            <p className="text-xs font-bold text-[#0B1F3A]">{title}</p>
            <p className="text-[11px] text-slate-500 mt-0.5">{subtitle}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={processing}
              onClick={() => galleryInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#0B1F3A] px-3 py-2 text-[11px] font-semibold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
            >
              <ImagePlus className="w-3.5 h-3.5 text-[#C89B3C]" />
              {processing ? 'جاري المعالجة...' : photoUrl ? 'تغيير الصورة' : 'رفع صورة من الجهاز'}
            </button>

            <button
              type="button"
              disabled={processing}
              onClick={() => cameraInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-[11px] font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50 cursor-pointer"
            >
              <Camera className="w-3.5 h-3.5 text-[#0B1F3A]" />
              التقاط بالكاميرا
            </button>

            {photoUrl && (
              <>
                <button
                  type="button"
                  disabled={processing}
                  onClick={() => openEditorWithSrc(photoUrl)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] font-semibold text-[#0B1F3A] hover:bg-amber-100 disabled:opacity-50 cursor-pointer"
                >
                  <Crop className="w-3.5 h-3.5 text-[#C89B3C]" />
                  تعديل الصورة
                </button>
                <button
                  type="button"
                  disabled={processing}
                  onClick={() => {
                    setUploadError(null);
                    onChange('');
                  }}
                  className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] font-semibold text-red-700 hover:bg-red-100 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  حذف
                </button>
              </>
            )}
          </div>

          {uploadError && <p className="text-[11px] text-red-700 font-medium">{uploadError}</p>}
        </div>
      </div>

      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        className="hidden"
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="user"
        onChange={handleFileChange}
        className="hidden"
      />

      {/* Interactive Crop / Rotate / Zoom / Brightness Modal */}
      {editorSrc && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between bg-[#0B1F3A] px-5 py-3.5 text-white">
              <div className="flex items-center gap-2">
                <Crop className="w-4 h-4 text-[#C89B3C]" />
                <h3 className="font-display text-sm font-bold">تعديل وقص الصورة قبل الحفظ</h3>
              </div>
              <button
                type="button"
                onClick={() => setEditorSrc(null)}
                className="text-slate-300 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <p className="text-center text-[11px] text-slate-500">
                اسحب الصورة داخل الإطار لضبط موضع الوجه، واستخدم أدوات التكبير والتدوير أدناه.
              </p>

              {/* Interactive Square Viewport */}
              <div className="flex justify-center">
                <div
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                  className="relative overflow-hidden rounded-2xl border-2 border-[#C89B3C] bg-slate-900 select-none touch-none cursor-grab active:cursor-grabbing shadow-inner"
                  style={{ width: VIEW_SIZE, height: VIEW_SIZE }}
                >
                  {imgDimensions && (
                    <img
                      src={editorSrc}
                      alt="معاينة التعديل"
                      draggable={false}
                      className="pointer-events-none absolute top-1/2 left-1/2 max-w-none"
                      style={{
                        width: imgDimensions.w,
                        height: imgDimensions.h,
                        transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) rotate(${rotation}deg) scale(${activeScale})`,
                        filter: brightness !== 100 ? `brightness(${brightness}%)` : undefined,
                      }}
                    />
                  )}
                  {/* Circular Avatar Guide Overlay */}
                  <div className="pointer-events-none absolute inset-0 rounded-full border-2 border-dashed border-white/60 shadow-[0_0_0_9999px_rgba(11,31,58,0.32)]" />
                </div>
              </div>

              {/* Controls */}
              <div className="space-y-3 rounded-xl bg-slate-50 border border-slate-200 p-3.5 text-xs">
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1 text-slate-700 font-semibold w-20 shrink-0">
                    <ZoomIn className="w-3.5 h-3.5 text-[#0B1F3A]" />
                    التكبير
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={3}
                    step={0.05}
                    value={zoom}
                    onChange={(e) => setZoom(Number(e.target.value))}
                    className="flex-1 accent-[#0B1F3A] cursor-pointer"
                  />
                  <span className="font-mono text-[11px] text-slate-500 w-10 text-left">
                    {zoom.toFixed(1)}x
                  </span>
                </div>

                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1 text-slate-700 font-semibold w-20 shrink-0">
                    <Sun className="w-3.5 h-3.5 text-[#C89B3C]" />
                    الإضاءة
                  </span>
                  <input
                    type="range"
                    min={75}
                    max={135}
                    step={5}
                    value={brightness}
                    onChange={(e) => setBrightness(Number(e.target.value))}
                    className="flex-1 accent-[#0B1F3A] cursor-pointer"
                  />
                  <span className="font-mono text-[11px] text-slate-500 w-10 text-left">
                    {brightness}%
                  </span>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setRotation((r) => r - 90)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-100 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      تدوير يسار
                    </button>
                    <button
                      type="button"
                      onClick={() => setRotation((r) => r + 90)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-100 cursor-pointer"
                    >
                      <RotateCw className="w-3.5 h-3.5" />
                      تدوير يمين
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setZoom(1);
                      setRotation(0);
                      setBrightness(100);
                      setOffset({ x: 0, y: 0 });
                    }}
                    className="text-[11px] font-semibold text-slate-500 hover:text-[#0B1F3A] cursor-pointer"
                  >
                    إعادة ضبط
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  disabled={processing}
                  onClick={() => setEditorSrc(null)}
                  className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="button"
                  disabled={processing || !imgDimensions}
                  onClick={handleSaveEditedPhoto}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#0B1F3A] px-4 py-2 text-xs font-semibold text-white hover:bg-[#13325c] disabled:opacity-50 cursor-pointer"
                >
                  <Check className="w-4 h-4 text-[#C89B3C]" />
                  {processing ? 'جاري الحفظ...' : 'اعتماد الصورة'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
