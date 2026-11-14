import React, { useRef, useState } from 'react';
import { Camera, ImagePlus, Trash2 } from 'lucide-react';
import { DriverAvatar } from './DriverAvatar';

interface DriverPhotoUploaderProps {
  photoUrl: string;
  driverName?: string;
  onChange: (nextPhotoUrl: string) => void;
}

async function compressImageToDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('يرجى اختيار ملف صورة صالح (JPG أو PNG أو WebP)');
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('تعذر قراءة ملف الصورة'));
      el.src = objectUrl;
    });

    const maxSize = 360;
    const minDim = Math.min(img.width, img.height);
    // Center-crop square thumbnail for crisp avatar display
    const sx = Math.max(0, Math.floor((img.width - minDim) / 2));
    const sy = Math.max(0, Math.floor((img.height - minDim) / 2));

    const canvas = document.createElement('canvas');
    const targetSize = Math.min(maxSize, minDim || maxSize);
    canvas.width = targetSize;
    canvas.height = targetSize;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('المتصفح لا يدعم معالجة الصور');
    }

    ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, targetSize, targetSize);
    return canvas.toDataURL('image/jpeg', 0.82);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export const DriverPhotoUploader: React.FC<DriverPhotoUploaderProps> = ({
  photoUrl,
  driverName,
  onChange,
}) => {
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const [processing, setProcessing] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setProcessing(true);
    setUploadError(null);
    try {
      const dataUrl = await compressImageToDataUrl(file);
      onChange(dataUrl);
    } catch (err: unknown) {
      setUploadError(err instanceof Error ? err.message : 'تعذر تحميل الصورة');
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex items-center gap-3">
          <DriverAvatar name={driverName} photoUrl={photoUrl} size="xl" />
          <div className="sm:hidden">
            <p className="text-xs font-bold text-[#0B1F3A]">صورة السائق الشخصية</p>
            <p className="text-[11px] text-slate-500 mt-0.5">
              تظهر في لوحة الإدارة وتطبيق السائق
            </p>
          </div>
        </div>

        <div className="flex-1 space-y-2">
          <div className="hidden sm:block">
            <p className="text-xs font-bold text-[#0B1F3A]">صورة السائق الشخصية</p>
            <p className="text-[11px] text-slate-500 mt-0.5">
              يمكنك رفع صورة من الاستوديو أو التقاطها مباشرة بكاميرا الموبايل (يتم ضغطها تلقائياً).
            </p>
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
    </div>
  );
};
