import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Briefcase,
  Bus,
  FileSpreadsheet,
  FileText,
  HandCoins,
  LayoutDashboard,
  LogOut,
  MapPin,
  Menu,
  Mic,
  Receipt,
  Settings,
  Smartphone,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { AppLogoBackdrop } from './components/AppLogoBackdrop';
import { BrandLogo } from './components/BrandLogo';
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstall';
import { CompanyLegalFooter } from './components/CompanyLegalFooter';
import { SignInScreen } from './components/SignInScreen';
import { SplashScreen } from './components/SplashScreen';
import splashScreenImg from './assets/images/alwaleed_splash_screen_1794752422708.jpg';
import { AdminOverview } from './components/admin/AdminOverview';
import { DriversModule } from './components/admin/DriversModule';
import { EmployeesModule } from './components/admin/EmployeesModule';
import { SchoolsVehiclesModule } from './components/admin/SchoolsVehiclesModule';
import { FinanceModule } from './components/admin/FinanceModule';
import { LiveMapModule } from './components/admin/LiveMapModule';
import { VoiceAssistantModule } from './components/admin/VoiceAssistantModule';
import { ReportsModule } from './components/admin/ReportsModule';
import { SettingsUsersModule } from './components/admin/SettingsUsersModule';
import { ArchiveModule } from './components/admin/ArchiveModule';
import { SupervisorsModule } from './components/admin/SupervisorsModule';
import { DailyReportsModule } from './components/admin/DailyReportsModule';
import { EmployeeDailyReportModal } from './components/employee/EmployeeDailyReportModal';
import { DriverApp } from './components/driver/DriverApp';
import { SupervisorApp } from './components/supervisor/SupervisorApp';
import { ChatHubModule } from './components/chat/ChatHubModule';
import { InvoicesModule } from './components/admin/InvoicesModule';
import { CustodiesAndExternalAccountsModule } from './components/admin/CustodiesAndExternalAccountsModule';
import { ArrowRight, MessageSquare, UserCheck } from 'lucide-react';

type AdminTabId =
  | 'overview'
  | 'drivers'
  | 'supervisors'
  | 'employees'
  | 'schools'
  | 'finance'
  | 'custodies_external'
  | 'invoices'
  | 'daily_reports'
  | 'map'
  | 'chat'
  | 'voice'
  | 'reports'
  | 'archive'
  | 'settings';

interface NavItem {
  id: AdminTabId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  visible: boolean;
}

function getDefaultTabForUser(
  roleSlug: string | undefined,
  availableTabs: NavItem[]
): AdminTabId {
  const hasTab = (id: AdminTabId) => availableTabs.some((n) => n.id === id);
  if (roleSlug === 'super_admin') {
    return hasTab('overview') ? 'overview' : availableTabs[0]?.id || 'overview';
  }
  if (roleSlug === 'accountant') {
    if (hasTab('finance')) return 'finance';
    if (hasTab('reports')) return 'reports';
    if (hasTab('overview')) return 'overview';
  }
  if (roleSlug === 'movement_manager') {
    if (hasTab('drivers')) return 'drivers';
    if (hasTab('map')) return 'map';
    if (hasTab('overview')) return 'overview';
  }
  if (roleSlug === 'employee') {
    if (hasTab('daily_reports')) return 'daily_reports';
    if (hasTab('chat')) return 'chat';
  }
  return availableTabs[0]?.id || 'overview';
}

const AppShell: React.FC = () => {
  const { isAuthenticated, dbUser, loading, logout } = useAuth();
  const [activeTab, setActiveTab] = useState<AdminTabId>('overview');
  const [tabHistory, setTabHistory] = useState<AdminTabId[]>([]);
  const [chatInitialRoomKey, setChatInitialRoomKey] = useState<string>('broadcast');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [adminMode, setAdminMode] = useState<'admin' | 'driver_preview' | 'supervisor_preview'>(
    'admin'
  );
  const [previewSupervisorId, setPreviewSupervisorId] = useState<string>('');
  const [splashElapsed, setSplashElapsed] = useState(false);
  const [quickReportModalOpen, setQuickReportModalOpen] = useState(false);

  const tabHistoryRef = React.useRef<AdminTabId[]>([]);
  tabHistoryRef.current = tabHistory;
  const activeTabRef = React.useRef<AdminTabId>('overview');
  activeTabRef.current = activeTab;
  const adminModeRef = React.useRef<'admin' | 'driver_preview' | 'supervisor_preview'>('admin');
  adminModeRef.current = adminMode;
  const defaultTabRef = React.useRef<AdminTabId>('overview');
  const lastAutoRoutedUserIdRef = React.useRef<number | null>(null);

  useEffect(() => {
    const onPopState = () => {
      if (adminModeRef.current !== 'admin') {
        setAdminMode('admin');
        return;
      }
      if (tabHistoryRef.current.length > 0) {
        const nextHistory = [...tabHistoryRef.current];
        const prevTab = nextHistory.pop()!;
        setTabHistory(nextHistory);
        setActiveTab(prevTab);
        return;
      }
      if (activeTabRef.current !== defaultTabRef.current) {
        setActiveTab(defaultTabRef.current);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setSplashElapsed(true), 750);
    return () => window.clearTimeout(timer);
  }, []);

  const isSuperAdmin = dbUser?.roleSlug === 'super_admin';
  const perms = dbUser?.permissions || [];
  const can = (perm: string) => isSuperAdmin || perms.includes('*') || perms.includes(perm);
  const restrictedSchoolCount = dbUser?.assignedSchoolIds?.length || 0;
  const schoolScopeLabel =
    restrictedSchoolCount > 0
      ? dbUser?.assignedSchoolNames && dbUser.assignedSchoolNames.length > 0
        ? dbUser.assignedSchoolNames.join(' · ')
        : `${restrictedSchoolCount} مدرسة محددة`
      : '';

  const navItems: NavItem[] = useMemo(
    () => [
      {
        id: 'overview',
        label: 'لوحة التحكم',
        icon: LayoutDashboard,
        visible: isSuperAdmin || can('dashboard:read'),
      },
      {
        id: 'drivers',
        label: 'إدارة السائقين',
        icon: Users,
        visible: isSuperAdmin || can('drivers:read'),
      },
      {
        id: 'supervisors',
        label: 'إدارة المشرفات',
        icon: UserCheck,
        visible: isSuperAdmin || can('drivers:read') || can('gps:read'),
      },
      {
        id: 'employees',
        label: 'الموظفون (غير السائقين)',
        icon: Briefcase,
        visible: isSuperAdmin || can('employees:read') || can('employees:write'),
      },
      {
        id: 'schools',
        label: 'المدارس والمركبات',
        icon: Bus,
        visible: isSuperAdmin || can('schools:read') || can('vehicles:read'),
      },
      {
        id: 'finance',
        label: 'المالية والمرتبات',
        icon: Wallet,
        visible:
          isSuperAdmin ||
          can('finance:read') ||
          can('finance:write') ||
          can('advances:write') ||
          can('coverage:write'),
      },
      {
        id: 'custodies_external',
        label: 'العهد والمديونيات',
        icon: HandCoins,
        visible: isSuperAdmin || can('finance:read') || can('finance:write'),
      },
      {
        id: 'invoices',
        label: 'الفواتير',
        icon: Receipt,
        visible:
          isSuperAdmin ||
          can('finance:read') ||
          can('finance:write') ||
          can('reports:read'),
      },
      {
        id: 'daily_reports',
        label: 'تقارير الموظفين اليومية',
        icon: FileText,
        visible:
          isSuperAdmin ||
          can('employees:read') ||
          can('finance:read') ||
          can('dashboard:read') ||
          dbUser?.roleSlug === 'accountant' ||
          dbUser?.roleSlug === 'movement_manager' ||
          dbUser?.roleSlug === 'employee',
      },
      {
        id: 'map',
        label: 'التتبع المباشر (GPS)',
        icon: MapPin,
        visible: isSuperAdmin || can('gps:read'),
      },
      {
        id: 'chat',
        label: 'المحادثات والاتصال المباشر',
        icon: MessageSquare,
        visible: true,
      },
      {
        id: 'voice',
        label: 'المساعد الصوتي الذكي',
        icon: Mic,
        visible: isSuperAdmin,
      },
      {
        id: 'reports',
        label: 'التقارير والتصدير',
        icon: FileSpreadsheet,
        visible: isSuperAdmin || can('reports:read'),
      },
      {
        id: 'archive',
        label: 'الأرشفة',
        icon: Archive,
        visible:
          isSuperAdmin ||
          can('drivers:write') ||
          can('vehicles:write') ||
          can('schools:write') ||
          can('employees:write'),
      },
      {
        id: 'settings',
        label: 'الصلاحيات والإشعارات',
        icon: Settings,
        visible: isSuperAdmin,
      },
    ],
    [isSuperAdmin, perms, dbUser?.roleSlug]
  );

  const visibleNav = navItems.filter((n) => n.visible);
  const defaultTab = getDefaultTabForUser(dbUser?.roleSlug, visibleNav);
  defaultTabRef.current = defaultTab;

  useEffect(() => {
    if (!dbUser) {
      lastAutoRoutedUserIdRef.current = null;
      return;
    }
    if (dbUser.roleSlug === 'driver' || dbUser.roleSlug === 'supervisor') return;
    if (lastAutoRoutedUserIdRef.current !== dbUser.id) {
      lastAutoRoutedUserIdRef.current = dbUser.id;
      setTabHistory([]);
      setActiveTab(defaultTab);
      return;
    }
    if (visibleNav.length > 0 && !visibleNav.some((n) => n.id === activeTab)) {
      setActiveTab(defaultTab);
    }
  }, [dbUser, visibleNav, activeTab, defaultTab]);

  if (loading || !splashElapsed) {
    return (
      <SplashScreen
        message={
          loading ? 'جاري التحقق من الجلسة وتحميل البيانات...' : 'الوليد ترافيل — أهلاً بك'
        }
      />
    );
  }

  if (!isAuthenticated || !dbUser) {
    return <SignInScreen />;
  }

  // Strict Data & UI Isolation: Driver accounts only ever see the mobile-first Driver App
  if (dbUser.roleSlug === 'driver') {
    return <DriverApp allowDriverSelector={false} />;
  }

  // Strict Data & UI Isolation: Supervisor accounts ONLY see non-financial Supervisor App
  if (dbUser.roleSlug === 'supervisor') {
    return <SupervisorApp allowSupervisorSelector={false} />;
  }

  // Admin previewing Driver App (fixed always-visible return bar)
  if (isSuperAdmin && adminMode === 'driver_preview') {
    return (
      <div className="relative pt-12">
        <div className="fixed top-0 inset-x-0 z-50 h-12 bg-[#081528] border-b border-[#C89B3C]/40 px-3 sm:px-5 text-xs text-white flex items-center justify-between gap-2 shadow-md">
          <div className="flex items-center gap-2 min-w-0">
            <Smartphone className="w-4 h-4 text-[#C89B3C] shrink-0" />
            <span className="font-semibold text-[#ebd089] truncate">وضع معاينة تطبيق السائق</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setAdminMode('supervisor_preview')}
              className="hidden sm:inline-flex items-center gap-1.5 rounded-lg border border-white/20 bg-white/10 hover:bg-white/20 px-3 py-1.5 font-semibold text-white whitespace-nowrap shrink-0 cursor-pointer"
            >
              <MapPin className="w-3.5 h-3.5 text-[#C89B3C]" />
              معاينة المشرفة
            </button>
            <button
              type="button"
              onClick={() => setAdminMode('admin')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#C89B3C] hover:bg-[#d8ac4e] px-3.5 py-1.5 font-bold text-[#0B1F3A] whitespace-nowrap shrink-0 cursor-pointer"
            >
              <ArrowRight className="w-3.5 h-3.5" />
              العودة لوحة التحكم
            </button>
          </div>
        </div>
        <DriverApp allowDriverSelector={true} hasPreviewBar={true} />
      </div>
    );
  }

  // Admin previewing Supervisor App (fixed always-visible return bar)
  if (isSuperAdmin && adminMode === 'supervisor_preview') {
    return (
      <div className="relative pt-12">
        <div className="fixed top-0 inset-x-0 z-50 h-12 bg-[#081528] border-b border-[#C89B3C]/40 px-3 sm:px-5 text-xs text-white flex items-center justify-between gap-2 shadow-md">
          <div className="flex items-center gap-2 min-w-0">
            <UserCheck className="w-4 h-4 text-[#C89B3C] shrink-0" />
            <span className="font-semibold text-[#ebd089] truncate">وضع معاينة نسخة المشرفة</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setAdminMode('driver_preview')}
              className="hidden sm:inline-flex items-center gap-1.5 rounded-lg border border-white/20 bg-white/10 hover:bg-white/20 px-3 py-1.5 font-semibold text-white whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Smartphone className="w-3.5 h-3.5 text-[#C89B3C]" />
              معاينة السائق
            </button>
            <button
              type="button"
              onClick={() => setAdminMode('admin')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#C89B3C] hover:bg-[#d8ac4e] px-3.5 py-1.5 font-bold text-[#0B1F3A] whitespace-nowrap shrink-0 cursor-pointer"
            >
              <ArrowRight className="w-3.5 h-3.5" />
              العودة لوحة التحكم
            </button>
          </div>
        </div>
        <SupervisorApp
          allowSupervisorSelector={true}
          initialSupervisorId={previewSupervisorId}
          hasPreviewBar={true}
        />
      </div>
    );
  }

  const currentTabLabel = visibleNav.find((n) => n.id === activeTab)?.label || 'لوحة التحكم';

  const handleNavigate = (tab: string, chatRoomKey?: string) => {
    const match = visibleNav.find((n) => n.id === tab);
    if (chatRoomKey) {
      setChatInitialRoomKey(chatRoomKey);
    }
    if (match) {
      if (match.id !== activeTab) {
        setTabHistory((prev) => [...prev.slice(-19), activeTab]);
        setActiveTab(match.id);
        try {
          window.history.pushState({ alwaleedAdminTab: match.id }, '');
        } catch {
          // ignore history errors
        }
      }
      setMobileMenuOpen(false);
    }
  };

  const handleGoBack = () => {
    if (tabHistory.length > 0) {
      const nextHistory = [...tabHistory];
      const prevTab = nextHistory.pop()!;
      setTabHistory(nextHistory);
      setActiveTab(prevTab);
    } else if (activeTab !== defaultTab) {
      setActiveTab(defaultTab);
    }
  };

  const enterPreviewMode = (mode: 'driver_preview' | 'supervisor_preview') => {
    try {
      window.history.pushState({ alwaleedAdminMode: mode }, '');
    } catch {
      // ignore
    }
    setAdminMode(mode);
  };

  return (
    <div className="min-h-screen bg-[#eef2f7] relative flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 lg:right-0 bg-[#0B1F3A] text-white z-30 no-print overflow-hidden">
        <div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-14 flex items-center justify-center pointer-events-none select-none"
        >
          <div className="w-56 h-56 rounded-full overflow-hidden opacity-40 ring-1 ring-[#C89B3C]/25">
            <img
              src={splashScreenImg}
              alt=""
              referrerPolicy="no-referrer"
              className="w-full h-full object-cover object-center scale-110"
            />
          </div>
        </div>
        <div className="absolute inset-0 bg-gradient-to-b from-[#0B1F3A]/80 via-[#0B1F3A]/45 to-[#081528]/80 pointer-events-none" />
        <div className="relative z-10 h-16 px-5 flex items-center gap-3 border-b border-white/10">
          <BrandLogo size="sm" />
          <div className="min-w-0">
            <div className="font-display text-base font-bold truncate">الوليد ترافيل</div>
            <div className="text-[11px] text-slate-300 truncate">إدارة النقل المدرسي</div>
          </div>
        </div>

        <nav className="relative z-10 flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {visibleNav.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => handleNavigate(item.id)}
                className={`w-full flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition-colors cursor-pointer ${
                  active
                    ? 'bg-[#C89B3C] text-[#0B1F3A]'
                    : 'text-slate-200 hover:bg-white/10 hover:text-white'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="relative z-10 p-4 border-t border-white/10 space-y-3">
          {isSuperAdmin && (
            <div className="space-y-2">
              <button
                onClick={() => enterPreviewMode('driver_preview')}
                className="w-full flex items-center justify-center gap-2 rounded-xl border border-white/20 bg-white/5 hover:bg-white/10 px-3 py-2 text-xs font-semibold text-white cursor-pointer"
              >
                <Smartphone className="w-4 h-4 text-[#C89B3C]" />
                معاينة تطبيق السائق
              </button>
              <button
                onClick={() => enterPreviewMode('supervisor_preview')}
                className="w-full flex items-center justify-center gap-2 rounded-xl border border-white/20 bg-white/5 hover:bg-white/10 px-3 py-2 text-xs font-semibold text-white cursor-pointer"
              >
                <MapPin className="w-4 h-4 text-[#C89B3C]" />
                معاينة نسخة المشرفة
              </button>
            </div>
          )}
          <div className="flex items-center justify-between gap-2 text-xs">
            <div className="min-w-0">
              <p className="font-bold text-white truncate">{dbUser.fullName}</p>
              <p className="text-[11px] text-[#C89B3C] truncate">
                {dbUser.roleNameAr}
                {schoolScopeLabel ? ` · ${schoolScopeLabel}` : ''}
              </p>
            </div>
            <button
              onClick={logout}
              title="تسجيل الخروج"
              className="p-2 rounded-lg bg-white/10 hover:bg-red-500/20 text-slate-200 hover:text-red-200 cursor-pointer shrink-0"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/60"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="relative w-72 max-w-[85vw] bg-[#0B1F3A] text-white flex flex-col h-full z-50 overflow-hidden">
            <div
              aria-hidden="true"
              className="absolute inset-x-0 bottom-14 flex items-center justify-center pointer-events-none select-none"
            >
              <div className="w-56 h-56 rounded-full overflow-hidden opacity-40 ring-1 ring-[#C89B3C]/25">
                <img
                  src={splashScreenImg}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover object-center scale-110"
                />
              </div>
            </div>
            <div className="absolute inset-0 bg-gradient-to-b from-[#0B1F3A]/80 via-[#0B1F3A]/45 to-[#081528]/80 pointer-events-none" />
            <div className="relative z-10 h-16 px-4 flex items-center justify-between border-b border-white/10">
              <div className="flex items-center gap-2.5">
                <BrandLogo size="sm" />
                <span className="font-display text-base font-bold">الوليد ترافيل</span>
              </div>
              <button
                onClick={() => setMobileMenuOpen(false)}
                className="p-2 rounded-lg text-slate-300 hover:bg-white/10"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="relative z-10 flex-1 p-3 space-y-1 overflow-y-auto">
              {visibleNav.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => handleNavigate(item.id)}
                    className={`w-full flex items-center gap-3 rounded-xl px-3.5 py-3 text-sm font-semibold cursor-pointer ${
                      active ? 'bg-[#C89B3C] text-[#0B1F3A]' : 'text-slate-200 hover:bg-white/10'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="relative z-10 p-4 border-t border-white/10 space-y-2.5">
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  setQuickReportModalOpen(true);
                }}
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-[#C89B3C] text-[#0B1F3A] hover:bg-[#d8ac4e] px-3 py-2.5 text-xs font-bold shadow-sm cursor-pointer"
              >
                <Mic className="w-4 h-4" />
                تقديم تقرير يومي سريع
              </button>

              {isSuperAdmin && (
                <div className="space-y-2">
                  <button
                    onClick={() => {
                      setMobileMenuOpen(false);
                      enterPreviewMode('driver_preview');
                    }}
                    className="w-full flex items-center justify-center gap-2 rounded-xl border border-white/20 bg-white/5 px-3 py-2.5 text-xs font-semibold text-white"
                  >
                    <Smartphone className="w-4 h-4 text-[#C89B3C]" />
                    معاينة تطبيق السائق
                  </button>
                  <button
                    onClick={() => {
                      setMobileMenuOpen(false);
                      enterPreviewMode('supervisor_preview');
                    }}
                    className="w-full flex items-center justify-center gap-2 rounded-xl border border-white/20 bg-white/5 px-3 py-2.5 text-xs font-semibold text-white"
                  >
                    <MapPin className="w-4 h-4 text-[#C89B3C]" />
                    معاينة نسخة المشرفة
                  </button>
                </div>
              )}
              <button
                onClick={logout}
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-red-500/20 text-red-100 px-3 py-2.5 text-xs font-semibold"
              >
                <LogOut className="w-4 h-4" />
                تسجيل الخروج
              </button>
            </div>
          </div>
        </div>
      )}

      <AppLogoBackdrop withSidebarOffset />

      {/* Main Content Area */}
      <div className="relative z-10 flex-1 lg:pr-64 flex flex-col min-w-0">
        <header className="sticky top-0 z-20 h-16 bg-white/90 backdrop-blur-md border-b border-slate-200 px-4 sm:px-6 flex items-center justify-between gap-4 no-print">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => setMobileMenuOpen(true)}
              aria-label="فتح القائمة"
              className="lg:hidden p-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 cursor-pointer"
            >
              <Menu className="w-5 h-5" />
            </button>
            {(tabHistory.length > 0 || activeTab !== defaultTab) && (
              <button
                type="button"
                onClick={handleGoBack}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 px-3 py-1.5 text-xs font-bold text-[#0B1F3A] shrink-0 cursor-pointer transition-colors"
                title="العودة للقائمة السابقة دون الخروج"
              >
                <ArrowRight className="w-3.5 h-3.5 text-[#C89B3C]" />
                <span className="hidden sm:inline">العودة للقائمة السابقة</span>
                <span className="sm:hidden">رجوع</span>
              </button>
            )}
            <span className="font-display text-base font-bold text-[#0B1F3A] truncate">
              {currentTabLabel}
            </span>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setQuickReportModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-[#C89B3C] text-[#0B1F3A] hover:bg-[#d8ac4e] text-xs font-bold transition-all shadow-sm shrink-0 cursor-pointer"
              title="تقديم تقرير يومي سريع (صوتي أو كتابي)"
            >
              <Mic className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">تقرير يومي سريع</span>
            </button>
            <PWAInstallButton />
            <div className="hidden sm:flex items-center gap-2 text-xs text-slate-600 border-r border-slate-200 pr-3">
              <span className="font-semibold text-[#0B1F3A]">{dbUser.fullName}</span>
              <span className="text-slate-400">·</span>
              <span className="text-[11px] font-medium text-slate-700">
                {dbUser.roleNameAr}
                {schoolScopeLabel ? ` · ${schoolScopeLabel}` : ''}
              </span>
            </div>
          </div>
        </header>

        <main className="app-glass-cards flex-1 p-4 sm:p-6 max-w-7xl w-full mx-auto">
          {activeTab === 'overview' && <AdminOverview onNavigate={handleNavigate} />}
          {activeTab === 'drivers' && (
            <DriversModule
              onOpenDriversChat={() => handleNavigate('chat', 'drivers_broadcast')}
            />
          )}
          {activeTab === 'supervisors' && (
            <SupervisorsModule
              onPreviewSupervisor={(supId) => {
                setPreviewSupervisorId(String(supId));
                enterPreviewMode('supervisor_preview');
              }}
            />
          )}
          {activeTab === 'employees' && <EmployeesModule />}
          {activeTab === 'schools' && <SchoolsVehiclesModule />}
          {activeTab === 'finance' && <FinanceModule />}
          {activeTab === 'custodies_external' && (
            <CustodiesAndExternalAccountsModule initialSection="custodies" />
          )}
          {activeTab === 'invoices' && <InvoicesModule initialView="create" />}
          {activeTab === 'daily_reports' && <DailyReportsModule />}
          {activeTab === 'map' && <LiveMapModule />}
          {activeTab === 'chat' && (
            <ChatHubModule
              currentRole="admin"
              initialRoomKey={chatInitialRoomKey}
              onClose={handleGoBack}
            />
          )}
          {activeTab === 'voice' && <VoiceAssistantModule />}
          {activeTab === 'reports' && <ReportsModule />}
          {activeTab === 'archive' && <ArchiveModule />}
          {activeTab === 'settings' && (
            <SettingsUsersModule onOpenSupervisors={() => handleNavigate('supervisors')} />
          )}
        </main>

        <CompanyLegalFooter variant="light" className="mt-auto" />

        <EmployeeDailyReportModal
          isOpen={quickReportModalOpen}
          onClose={() => setQuickReportModalOpen(false)}
        />
      </div>
    </div>
  );
};

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          dir="rtl"
          className="min-h-screen bg-[#0B1F3A] text-white flex items-center justify-center p-6"
        >
          <div className="max-w-md w-full rounded-2xl bg-white text-[#0B1F3A] p-6 text-center space-y-4 shadow-2xl">
            <AlertTriangle className="w-10 h-10 text-[#C89B3C] mx-auto" />
            <h2 className="font-display text-lg font-bold">حدث تعارض مؤقت في العرض</h2>
            <p className="text-xs text-slate-600 leading-relaxed">
              تم حفظ جلستك ولن يتم تسجيل الخروج. اضغط على الزر أدناه لإعادة تنشيط الشاشة الحالية.
            </p>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false })}
              className="w-full rounded-xl bg-[#0B1F3A] text-white py-2.5 text-sm font-bold hover:bg-[#13325c] cursor-pointer"
            >
              العودة للبرنامج
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [quotaExceeded, setQuotaExceeded] = useState(false);

  useEffect(() => {
    const handler = () => setQuotaExceeded(true);
    window.addEventListener('gmp-quota-exceeded', handler);
    return () => window.removeEventListener('gmp-quota-exceeded', handler);
  }, []);

  return (
    <AppErrorBoundary>
      <AuthProvider>
        {quotaExceeded && (
          <div
            role="alert"
            className="sticky top-0 z-50 bg-amber-600 text-white px-4 py-2.5 text-xs flex flex-wrap items-center justify-between gap-3"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>
                تم تجاوز حصة مفتاح خرائط جوجل التجريبي. لاستمرار التتبع المباشر بدون انقطاع، يرجى
                الربط بمشروع Google Cloud الخاص بك:
              </span>
            </div>
            <a
              href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
              target="_blank"
              rel="noreferrer"
              className="underline font-bold whitespace-nowrap"
            >
              دليل حل مشكلة الحصة (Quota Guide)
            </a>
          </div>
        )}
        <OfflineIndicator />
        <AppShell />
      </AuthProvider>
    </AppErrorBoundary>
  );
}
