import React, { useState } from 'react';
import { Bus, ShieldCheck, MapPin, Mic, Phone, KeyRound, Loader2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { PWAInstallButton } from './PWAInstall';

type LoginTab = 'driver' | 'admin';

export const SignInScreen: React.FC = () => {
  const { loginWithGoogle, loginDriverWithPhoneCode, authError, clearAuthError } = useAuth();
  const [activeTab, setActiveTab] = useState<LoginTab>('driver');
  const [phone, setPhone] = useState('');
  const [driverCode, setDriverCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleTabSwitch = (tab: LoginTab) => {
    setActiveTab(tab);
    setLocalError(null);
    clearAuthError();
  };

  const handleDriverSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    const trimmedPhone = phone.trim();
    const trimmedCode = driverCode.trim();
    if (!trimmedPhone || !trimmedCode) {
      setLocalError('يرجى إدخال رقم الموبايل وكود السائق');
      return;
    }

    setSubmitting(true);
    try {
      await loginDriverWithPhoneCode(trimmedPhone, trimmedCode);
    } catch {
      // authError is already populated by AuthContext
    } finally {
      setSubmitting(false);
    }
  };

  const displayError = localError || authError;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-between">
      <header className="w-full border-b border-slate-200 bg-white px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-8">
          <div className="flex items-center gap-3 whitespace-nowrap shrink-0">
            <div className="w-9 h-9 rounded-lg bg-[#0B1F3A] flex items-center justify-center text-[#C89B3C]">
              <Bus className="w-5 h-5" />
            </div>
            <span className="font-display text-lg font-bold text-[#0B1F3A]">الوليد ترافيل</span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <PWAInstallButton />
          </div>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-4 py-8 sm:py-12">
        <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-12 bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
          <div className="lg:col-span-7 p-7 sm:p-10 flex flex-col justify-center order-2 lg:order-1">
            <p className="text-xs font-semibold text-[#C89B3C] tracking-wide mb-2">
              منصة إدارة النقل المدرسي المتكاملة
            </p>
            <h1 className="font-display text-2xl sm:text-3xl font-bold text-[#0B1F3A] leading-snug">
              الوليد ترافيل لإدارة الأسطول والحسابات والتتبع المباشر
            </h1>
            <p className="mt-4 text-sm sm:text-base text-slate-600 leading-relaxed">
              نظام موحد يجمع بين لوحة التحكم التنفيذية لإدارة المدارس والسائقين والسلف والتغطيات
              وصافي الأرباح، وتطبيق السائق الشخصي لمتابعة كشف الحساب ومشاركة الموقع بأمان تام.
            </p>

            <div className="mt-8 space-y-3 border-t border-slate-100 pt-6">
              <div className="flex items-start gap-3 text-sm text-slate-700">
                <ShieldCheck className="w-5 h-5 text-[#0B1F3A] shrink-0 mt-0.5" />
                <span>عزل تام للصلاحيات: حساب المدير العام، السائقين، ومشرفي الحركة والمحاسبين</span>
              </div>
              <div className="flex items-start gap-3 text-sm text-slate-700">
                <MapPin className="w-5 h-5 text-[#0B1F3A] shrink-0 mt-0.5" />
                <span>خرائط جوجل المباشرة لتتبع الباصات والسرعة والتمييز بين البث المباشر والمخزن</span>
              </div>
              <div className="flex items-start gap-3 text-sm text-slate-700">
                <Mic className="w-5 h-5 text-[#0B1F3A] shrink-0 mt-0.5" />
                <span>مساعد صوتي ذكي باللهجة المصرية لتسجيل السلف والتغطيات والاستعلام الفوري</span>
              </div>
            </div>
          </div>

          <div className="lg:col-span-5 bg-[#0B1F3A] text-white p-7 sm:p-10 flex flex-col justify-center order-1 lg:order-2">
            <h2 className="font-display text-xl font-bold text-white">تسجيل الدخول إلى النظام</h2>

            {/* Segmented Mode Tabs */}
            <div className="mt-4 grid grid-cols-2 gap-1.5 rounded-xl bg-white/10 p-1">
              <button
                type="button"
                onClick={() => handleTabSwitch('driver')}
                className={`rounded-lg py-2 px-3 text-xs font-bold transition-colors cursor-pointer ${
                  activeTab === 'driver'
                    ? 'bg-[#C89B3C] text-[#0B1F3A]'
                    : 'text-slate-200 hover:text-white'
                }`}
              >
                دخول السائق
              </button>
              <button
                type="button"
                onClick={() => handleTabSwitch('admin')}
                className={`rounded-lg py-2 px-3 text-xs font-bold transition-colors cursor-pointer ${
                  activeTab === 'admin'
                    ? 'bg-[#C89B3C] text-[#0B1F3A]'
                    : 'text-slate-200 hover:text-white'
                }`}
              >
                دخول الإدارة (Google)
              </button>
            </div>

            {displayError && (
              <div className="mt-4 rounded-lg bg-red-950/60 border border-red-400/40 px-4 py-3 text-xs text-red-100 leading-relaxed">
                {displayError}
              </div>
            )}

            {activeTab === 'driver' ? (
              <form onSubmit={handleDriverSubmit} className="mt-5 space-y-4">
                <p className="text-xs text-slate-300 leading-relaxed">
                  أدخل رقم الموبايل المسجل وكود السائق الخاص بك للوصول إلى حسابك وكشف الراتب ومشاركة
                  الموقع.
                </p>

                <div>
                  <label className="block text-xs font-semibold text-slate-200 mb-1.5">
                    رقم الموبايل
                  </label>
                  <div className="relative">
                    <Phone className="w-4 h-4 text-slate-400 absolute right-3 top-3 pointer-events-none" />
                    <input
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      required
                      dir="ltr"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="01012345678"
                      className="w-full rounded-xl bg-white/10 border border-white/20 pr-10 pl-3 py-2.5 text-sm font-mono text-white placeholder:text-slate-400 text-right focus:border-[#C89B3C] focus:bg-white/15 focus:outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-200 mb-1.5">
                    كود السائق
                  </label>
                  <div className="relative">
                    <KeyRound className="w-4 h-4 text-slate-400 absolute right-3 top-3 pointer-events-none" />
                    <input
                      type="text"
                      autoComplete="off"
                      autoCapitalize="characters"
                      required
                      dir="ltr"
                      value={driverCode}
                      onChange={(e) => setDriverCode(e.target.value)}
                      placeholder="1025"
                      className="w-full rounded-xl bg-white/10 border border-white/20 pr-10 pl-3 py-2.5 text-sm font-mono text-white placeholder:text-slate-400 text-right focus:border-[#C89B3C] focus:bg-white/15 focus:outline-none"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full min-h-[46px] flex items-center justify-center gap-2 rounded-xl bg-[#C89B3C] px-5 py-3 text-sm font-bold text-[#0B1F3A] hover:bg-[#d6aa4c] disabled:opacity-60 transition-colors cursor-pointer"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      جاري التحقق من البيانات...
                    </>
                  ) : (
                    'دخول السائق'
                  )}
                </button>

                <p className="text-[11px] text-slate-400 leading-relaxed">
                  في حالة عدم معرفة كود السائق أو تغيير رقم الموبايل، يرجى التواصل مع إدارة الوليد
                  ترافيل.
                </p>
              </form>
            ) : (
              <div className="mt-5">
                <p className="text-sm text-slate-300 leading-relaxed">
                  سجّل الدخول بحساب Google المعتمد للمدير العام ومشرفي الحركة والمحاسبين.
                </p>

                <button
                  type="button"
                  onClick={loginWithGoogle}
                  className="mt-6 w-full flex items-center justify-center gap-3 rounded-xl bg-[#C89B3C] px-5 py-3.5 text-sm font-bold text-[#0B1F3A] hover:bg-[#d6aa4c] transition-colors cursor-pointer"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24">
                    <path
                      fill="currentColor"
                      d="M21.35 11.1h-9.17v2.73h6.51c-.33 3.81-3.5 5.44-6.5 5.44C8.36 19.27 5 16.25 5 12c0-4.1 3.2-7.27 7.2-7.27c3.09 0 4.9 1.97 4.9 1.97L19 4.72S16.56 2 12.1 2C6.42 2 2.03 6.8 2.03 12c0 5.05 4.13 10 10.22 10c5.35 0 9.25-3.67 9.25-9.09c0-1.15-.15-1.81-.15-1.81Z"
                    />
                  </svg>
                  الدخول باستخدام حساب Google
                </button>

                <p className="mt-6 text-xs text-slate-400 leading-relaxed">
                  يتم التحقق من الهوية والصلاحيات تلقائياً عبر خادم الوليد ترافيل وقاعدة البيانات
                  المشفرة.
                </p>
              </div>
            )}
          </div>
        </div>
      </main>

      <footer className="py-4 px-6 text-center text-xs text-slate-500 border-t border-slate-200 bg-white">
        الوليد ترافيل للنقل المدرسي · جميع الحقوق محفوظة
      </footer>
    </div>
  );
};
