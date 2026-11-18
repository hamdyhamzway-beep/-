import React, { useState } from 'react';
import { ShieldCheck, MapPin, Mic, User, KeyRound, Loader2, Wallet } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { BrandLogo } from './BrandLogo';
import { CompanyLegalFooter } from './CompanyLegalFooter';
import { PWAInstallButton } from './PWAInstall';
import splashScreenImg from '../assets/images/alwaleed_splash_screen_1794752422708.jpg';
import travelBackdropImg from '../assets/images/alwaleed_travel_backdrop_1794752421692.jpg';

type LoginTab = 'driver' | 'supervisor' | 'admin';

export const SignInScreen: React.FC = () => {
  const {
    loginWithGoogle,
    loginDriverWithPhoneCode,
    loginSupervisorWithPhoneCode,
    loginStaffWithCode,
    authError,
    clearAuthError,
  } = useAuth();
  const [activeTab, setActiveTab] = useState<LoginTab>('driver');
  const [identifier, setIdentifier] = useState('');
  const [accessCode, setAccessCode] = useState('');
  const [staffIdentifier, setStaffIdentifier] = useState('');
  const [staffCode, setStaffCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleTabSwitch = (tab: LoginTab) => {
    setActiveTab(tab);
    setIdentifier('');
    setAccessCode('');
    setStaffIdentifier('');
    setStaffCode('');
    setLocalError(null);
    clearAuthError();
  };

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    const trimmedIdentifier = identifier.trim();
    const trimmedCode = accessCode.trim();
    if (!trimmedIdentifier || !trimmedCode) {
      setLocalError(
        activeTab === 'supervisor'
          ? 'يرجى إدخال رقم الموبايل أو الاسم وكود المشرفة'
          : 'يرجى إدخال رقم الموبايل أو الاسم وكود السائق'
      );
      return;
    }

    setSubmitting(true);
    try {
      if (activeTab === 'supervisor') {
        await loginSupervisorWithPhoneCode(trimmedIdentifier, trimmedCode);
      } else {
        await loginDriverWithPhoneCode(trimmedIdentifier, trimmedCode);
      }
    } catch {
      // authError is already populated by AuthContext
    } finally {
      setSubmitting(false);
    }
  };

  const handleStaffCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    const trimmedId = staffIdentifier.trim();
    const trimmedCode = staffCode.trim();
    if (!trimmedId || !trimmedCode) {
      setLocalError('يرجى إدخال الاسم أو الموبايل أو البريد الإلكتروني مع كود الموظف');
      return;
    }
    setSubmitting(true);
    try {
      await loginStaffWithCode(trimmedId, trimmedCode);
    } catch {
      // authError populated by AuthContext
    } finally {
      setSubmitting(false);
    }
  };

  const displayError = localError || authError;

  return (
    <div className="min-h-screen bg-[#0B1F3A] relative overflow-hidden flex flex-col justify-between">
      {/* Minimalist Dark Slate & Gold Map Background + Clear Logo Watermark */}
      <img
        src={travelBackdropImg}
        alt=""
        referrerPolicy="no-referrer"
        className="absolute inset-0 w-full h-full object-cover opacity-45 pointer-events-none select-none"
      />
      <div className="hidden lg:flex absolute inset-y-0 left-10 items-center pointer-events-none select-none">
        <div className="w-[460px] h-[460px] rounded-full overflow-hidden opacity-35 ring-1 ring-[#C89B3C]/30">
          <img
            src={splashScreenImg}
            alt=""
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover object-center scale-110"
          />
        </div>
      </div>
      <div className="absolute inset-0 bg-gradient-to-b from-[#0B1F3A]/65 via-[#0B1F3A]/45 to-[#081528]/80 pointer-events-none" />

      <header className="relative z-10 w-full border-b border-white/10 bg-[#0B1F3A]/85 backdrop-blur-md px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-8">
          <div className="flex items-center gap-3 whitespace-nowrap shrink-0">
            <BrandLogo size="sm" />
            <div className="flex flex-col">
              <span className="font-display text-lg font-bold text-white leading-tight">
                الوليد ترافيل
              </span>
              <span className="text-[10px] font-semibold tracking-widest text-[#C89B3C] uppercase">
                AL WALEED TRAVEL
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <PWAInstallButton />
          </div>
        </div>
      </header>

      <main className="relative z-10 flex-1 flex items-center justify-center px-4 py-8 sm:py-12">
        <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-12 bg-white/90 backdrop-blur-md border border-white/20 rounded-2xl overflow-hidden shadow-2xl">
          <div className="lg:col-span-7 p-7 sm:p-10 flex flex-col justify-center order-2 lg:order-1">
            <p className="text-xs font-semibold text-[#C89B3C] tracking-wide mb-2">
              الوليد ترافيل · AL WALEED TRAVEL
            </p>
            <h1 className="font-display text-2xl sm:text-3xl font-bold text-[#0B1F3A] leading-snug">
              الوليد ترافيل.. الكفاءة في إدارة النقل المدرسي
            </h1>
            <p className="mt-4 text-sm sm:text-base text-slate-700 font-medium leading-relaxed">
              نظام متكامل يربط الإدارة، السائقين، والمشرفات بمنظومة واحدة ذكية:
            </p>

            <div className="mt-6 space-y-3.5 border-t border-slate-200/80 pt-6">
              <div className="flex items-start gap-3 text-sm text-slate-800">
                <MapPin className="w-5 h-5 text-[#C89B3C] shrink-0 mt-0.5" />
                <span>
                  <strong className="text-[#0B1F3A]">تتبع لحظي دقيق:</strong> مراقبة خطوط السير
                  وسرعة الباصات عبر خرائط مباشرة.
                </span>
              </div>
              <div className="flex items-start gap-3 text-sm text-slate-800">
                <ShieldCheck className="w-5 h-5 text-[#C89B3C] shrink-0 mt-0.5" />
                <span>
                  <strong className="text-[#0B1F3A]">صلاحيات آمنة ومعزولة:</strong> بوابات مخصصة
                  للإدارة، المشرفات، والسائقين.
                </span>
              </div>
              <div className="flex items-start gap-3 text-sm text-slate-800">
                <Wallet className="w-5 h-5 text-[#C89B3C] shrink-0 mt-0.5" />
                <span>
                  <strong className="text-[#0B1F3A]">شاملة إدارة مالية:</strong> متابعة الرواتب،
                  السلف، التغطيات، والتصفية الشهرية بدقة.
                </span>
              </div>
              <div className="flex items-start gap-3 text-sm text-slate-800">
                <Mic className="w-5 h-5 text-[#C89B3C] shrink-0 mt-0.5" />
                <span>
                  <strong className="text-[#0B1F3A]">مساعد صوتي ذكي:</strong> لتسجيل العمليات
                  اليومية بكل سهولة وسرعة.
                </span>
              </div>
            </div>
          </div>

          <div className="lg:col-span-5 relative overflow-hidden bg-[#0B1F3A] text-white p-7 sm:p-9 flex flex-col justify-center order-1 lg:order-2">
            <img
              src={splashScreenImg}
              alt=""
              referrerPolicy="no-referrer"
              className="absolute inset-0 w-full h-full object-cover object-center opacity-50 pointer-events-none select-none"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-[#0B1F3A]/75 via-[#0B1F3A]/55 to-[#081528]/90 pointer-events-none" />

            <div className="relative z-10">
              <div className="flex items-center gap-3 mb-4 pb-3 border-b border-white/15">
                <div className="w-12 h-12 rounded-full overflow-hidden border border-[#C89B3C]/70 bg-[#081528] shrink-0 shadow-md">
                  <img
                    src={splashScreenImg}
                    alt="AL WALEED TRAVEL"
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover object-center scale-115"
                  />
                </div>
                <div className="min-w-0">
                  <h2 className="font-display text-base sm:text-lg font-bold text-white leading-snug">
                    {activeTab === 'supervisor'
                      ? 'دخول المشرفات - الوليد ترافيل'
                      : activeTab === 'admin'
                      ? 'بوابة الإدارة - الوليد ترافيل'
                      : 'تسجيل دخول السائقين - الوليد ترافيل'}
                  </h2>
                  <p className="text-[11px] text-[#ebd089] mt-0.5 leading-relaxed">
                    {activeTab === 'supervisor'
                      ? 'متابعة خط السير والموقع المباشر للباص بكل أمان.'
                      : 'شريكنا في النجاح.. طريقك آمن، وحساباتك منظمة بين إيديك.'}
                  </p>
                </div>
              </div>

              {/* Segmented Mode Tabs */}
              <div className="mt-4 grid grid-cols-3 gap-1 rounded-xl bg-white/10 p-1">
                <button
                  type="button"
                  onClick={() => handleTabSwitch('driver')}
                  className={`min-h-[40px] rounded-lg py-2 px-2 text-xs font-bold transition-colors cursor-pointer ${
                    activeTab === 'driver'
                      ? 'bg-[#C89B3C] text-[#0B1F3A]'
                      : 'text-slate-200 hover:text-white'
                  }`}
                >
                  السائق
                </button>
                <button
                  type="button"
                  onClick={() => handleTabSwitch('supervisor')}
                  className={`min-h-[40px] rounded-lg py-2 px-2 text-xs font-bold transition-colors cursor-pointer ${
                    activeTab === 'supervisor'
                      ? 'bg-[#C89B3C] text-[#0B1F3A]'
                      : 'text-slate-200 hover:text-white'
                  }`}
                >
                  المشرفة
                </button>
                <button
                  type="button"
                  onClick={() => handleTabSwitch('admin')}
                  className={`min-h-[40px] rounded-lg py-2 px-2 text-xs font-bold transition-colors cursor-pointer ${
                    activeTab === 'admin'
                      ? 'bg-[#C89B3C] text-[#0B1F3A]'
                      : 'text-slate-200 hover:text-white'
                  }`}
                >
                  الإدارة
                </button>
              </div>

              {displayError && (
                <div className="mt-4 rounded-lg bg-red-950/60 border border-red-400/40 px-4 py-3 text-xs text-red-100 leading-relaxed">
                  {displayError}
                </div>
              )}

              {activeTab === 'driver' || activeTab === 'supervisor' ? (
                <form onSubmit={handleCodeSubmit} className="mt-5 space-y-4">
                  <p className="text-xs text-slate-300 leading-relaxed">
                    {activeTab === 'supervisor'
                      ? 'أدخلي رقم الموبايل أو اسم المشرفة المسجل مع الكود المخصص لمتابعة خط السير والخريطة المباشرة.'
                      : 'أدخل رقم الموبايل أو اسمك المسجل مع كود السائق للوصول إلى حسابك وكشف الراتب ومشاركة الموقع.'}
                  </p>

                  <div>
                    <label className="block text-xs font-semibold text-slate-200 mb-1.5">
                      {activeTab === 'supervisor'
                        ? 'رقم الموبايل أو اسم المشرفة'
                        : 'رقم الموبايل أو اسم السائق'}
                    </label>
                    <div className="relative">
                      <User className="w-4 h-4 text-slate-400 absolute right-3 top-3 pointer-events-none" />
                      <input
                        type="text"
                        autoComplete="username"
                        required
                        dir="auto"
                        value={identifier}
                        onChange={(e) => setIdentifier(e.target.value)}
                        placeholder={
                          activeTab === 'supervisor'
                            ? '01012345678 أو أ. منى'
                            : '01012345678 أو أحمد محمد'
                        }
                        className="w-full rounded-xl bg-white/10 border border-white/20 pr-10 pl-3 py-2.5 text-sm text-white placeholder:text-slate-400 focus:border-[#C89B3C] focus:bg-white/15 focus:outline-none"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-200 mb-1.5">
                      {activeTab === 'supervisor' ? 'كود المشرفة' : 'كود السائق'}
                    </label>
                    <div className="relative">
                      <KeyRound className="w-4 h-4 text-slate-400 absolute right-3 top-3 pointer-events-none" />
                      <input
                        type="text"
                        autoComplete="off"
                        autoCapitalize="characters"
                        required
                        dir="ltr"
                        value={accessCode}
                        onChange={(e) => setAccessCode(e.target.value)}
                        placeholder={activeTab === 'supervisor' ? 'SUP-101' : '1025'}
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
                    ) : activeTab === 'supervisor' ? (
                      'دخول المشرفة'
                    ) : (
                      'دخول السائق'
                    )}
                  </button>

                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    يتم حفظ جلسة الدخول تلقائياً على جهازك بعد أول تسجيل لتجنب إعادة الإدخال في كل
                    مرة.
                  </p>
                </form>
              ) : (
                <div className="mt-5 space-y-5">
                  <div>
                    <p className="text-xs text-slate-300 leading-relaxed">
                      دخول المدير العام أو الموظفين المرتبطين بحساب Google:
                    </p>

                    <button
                      type="button"
                      onClick={loginWithGoogle}
                      className="mt-3 w-full flex items-center justify-center gap-3 rounded-xl bg-[#C89B3C] px-5 py-3 text-sm font-bold text-[#0B1F3A] hover:bg-[#d6aa4c] transition-colors cursor-pointer"
                    >
                      <svg className="w-5 h-5" viewBox="0 0 24 24">
                        <path
                          fill="currentColor"
                          d="M21.35 11.1h-9.17v2.73h6.51c-.33 3.81-3.5 5.44-6.5 5.44C8.36 19.27 5 16.25 5 12c0-4.1 3.2-7.27 7.2-7.27c3.09 0 4.9 1.97 4.9 1.97L19 4.72S16.56 2 12.1 2C6.42 2 2.03 6.8 2.03 12c0 5.05 4.13 10 10.22 10c5.35 0 9.25-3.67 9.25-9.09c0-1.15-.15-1.81-.15-1.81Z"
                        />
                      </svg>
                      الدخول باستخدام حساب Google
                    </button>
                  </div>

                  <div className="relative flex items-center py-1">
                    <div className="flex-grow border-t border-white/15" />
                    <span className="mx-3 shrink text-[11px] font-semibold text-[#ebd089]">
                      أو دخول المحاسب / مشرف الحركة بالكود
                    </span>
                    <div className="flex-grow border-t border-white/15" />
                  </div>

                  <form onSubmit={handleStaffCodeSubmit} className="space-y-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-200 mb-1">
                        الاسم أو الموبايل أو البريد الإلكتروني
                      </label>
                      <div className="relative">
                        <User className="w-4 h-4 text-slate-400 absolute right-3 top-2.5 pointer-events-none" />
                        <input
                          type="text"
                          required
                          dir="auto"
                          value={staffIdentifier}
                          onChange={(e) => setStaffIdentifier(e.target.value)}
                          placeholder="01012345678 أو اسم الموظف"
                          className="w-full rounded-xl bg-white/10 border border-white/20 pr-10 pl-3 py-2 text-sm text-white placeholder:text-slate-400 focus:border-[#C89B3C] focus:bg-white/15 focus:outline-none"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-200 mb-1">
                        كود الموظف (من المدير العام)
                      </label>
                      <div className="relative">
                        <KeyRound className="w-4 h-4 text-slate-400 absolute right-3 top-2.5 pointer-events-none" />
                        <input
                          type="text"
                          autoComplete="off"
                          autoCapitalize="characters"
                          required
                          dir="ltr"
                          value={staffCode}
                          onChange={(e) => setStaffCode(e.target.value)}
                          placeholder="STF-101"
                          className="w-full rounded-xl bg-white/10 border border-white/20 pr-10 pl-3 py-2 text-sm font-mono text-white placeholder:text-slate-400 text-right focus:border-[#C89B3C] focus:bg-white/15 focus:outline-none"
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={submitting}
                      className="w-full min-h-[42px] flex items-center justify-center gap-2 rounded-xl border border-[#C89B3C]/60 bg-white/10 hover:bg-white/15 px-4 py-2.5 text-xs font-bold text-[#ebd089] disabled:opacity-60 transition-colors cursor-pointer"
                    >
                      {submitting ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          جاري التحقق...
                        </>
                      ) : (
                        'دخول المحاسب / مشرف الحركة بالكود'
                      )}
                    </button>
                  </form>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      <CompanyLegalFooter variant="dark" />
    </div>
  );
};
