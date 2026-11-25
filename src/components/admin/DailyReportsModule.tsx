import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Building,
  Calendar,
  CheckCircle2,
  Clock,
  DollarSign,
  Eye,
  FileText,
  Filter,
  Loader2,
  Mic,
  MessageSquare,
  Pause,
  Play,
  Plus,
  Receipt,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  User,
  Users,
  Volume2,
  Wrench,
  X,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch, formatEGP, formatRelativeArabicTime } from '../../lib/api';
import { EmployeeDailyReportModal } from '../employee/EmployeeDailyReportModal';
import type { DailyReportRecord } from '../../types';

interface MySchoolOption {
  id: number;
  name: string;
}

export const DailyReportsModule: React.FC = () => {
  const { dbUser } = useAuth();
  const isSuperAdmin = dbUser?.roleSlug === 'super_admin' || dbUser?.permissions?.includes('*');
  const isAccountant = dbUser?.roleSlug === 'accountant' || dbUser?.permissions?.includes('finance:read');
  const restrictedSchoolIds = dbUser?.assignedSchoolIds || [];
  const isSingleSchoolRestricted = !isSuperAdmin && restrictedSchoolIds.length === 1;

  const [reports, setReports] = useState<DailyReportRecord[]>([]);
  const [mySchools, setMySchools] = useState<MySchoolOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Filters
  const [schoolFilter, setSchoolFilter] = useState<string>(() =>
    isSingleSchoolRestricted ? String(restrictedSchoolIds[0]) : 'all'
  );
  const [dateFilter, setDateFilter] = useState('');
  const [audienceFilter, setAudienceFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  // Audio playing
  const [playingId, setPlayingId] = useState<number | null>(null);
  const audioPlayerRef = React.useRef<HTMLAudioElement | null>(null);

  // Modal & Attachments Preview
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);

  // Reviewing
  const [reviewingId, setReviewingId] = useState<number | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  const [reviewActionBusy, setReviewActionBusy] = useState(false);

  useEffect(() => {
    if (isSingleSchoolRestricted && restrictedSchoolIds[0]) {
      setSchoolFilter(String(restrictedSchoolIds[0]));
    }
  }, [isSingleSchoolRestricted, restrictedSchoolIds]);

  useEffect(() => {
    apiFetch<{ schools: MySchoolOption[] }>('/api/my-schools')
      .then((res) => setMySchools(res.schools || []))
      .catch(() => setMySchools([]));
  }, []);

  const loadReports = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (schoolFilter !== 'all') params.set('schoolId', schoolFilter);
      if (dateFilter) params.set('reportDate', dateFilter);
      if (audienceFilter !== 'all') params.set('targetAudience', audienceFilter);
      if (statusFilter !== 'all') params.set('status', statusFilter);

      const res = await apiFetch<{ reports: DailyReportRecord[] }>(
        `/api/daily-reports?${params.toString()}`
      );
      setReports(res.reports);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل التقارير اليومية');
    } finally {
      setLoading(false);
    }
  }, [schoolFilter, dateFilter, audienceFilter, statusFilter]);

  useEffect(() => {
    loadReports();
  }, [loadReports]);

  // Audio playback handler
  const handleTogglePlayAudio = (reportId: number, audioUrl?: string | null) => {
    if (!audioUrl) return;

    if (playingId === reportId) {
      audioPlayerRef.current?.pause();
      setPlayingId(null);
      return;
    }

    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
    }

    const audio = new Audio(audioUrl);
    audioPlayerRef.current = audio;
    audio.onended = () => setPlayingId(null);
    audio.onerror = () => setPlayingId(null);
    audio.play().catch(() => setPlayingId(null));
    setPlayingId(reportId);
  };

  // Review & Approval Handler
  const handleReviewReport = async (reportId: number, nextStatus: string, role: 'accountant' | 'manager') => {
    setReviewActionBusy(true);
    setActionError(null);
    try {
      const payload: any = { status: nextStatus };
      if (role === 'accountant') {
        payload.accountantNotes = reviewNote.trim() || 'تمت المراجعة والاعتماد المالي';
      } else {
        payload.managerNotes = reviewNote.trim() || 'تم الاطلاع والاعتماد الإداري';
      }

      const res = await apiFetch<{ report: DailyReportRecord }>(`/api/daily-reports/${reportId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });

      setReports((prev) => prev.map((r) => (r.id === reportId ? res.report : r)));
      setReviewingId(null);
      setReviewNote('');
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'تعذر تحديث حالة التقرير');
    } finally {
      setReviewActionBusy(false);
    }
  };

  // Filtered reports list
  const filteredReports = reports.filter((r) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      r.employeeName.toLowerCase().includes(q) ||
      r.rawContent.toLowerCase().includes(q) ||
      r.category.toLowerCase().includes(q)
    );
  });

  // Metrics summary
  const totalReportsCount = reports.length;
  const financialReportsCount = reports.filter(
    (r) => r.reportType === 'financial' || r.financialAmount > 0
  ).length;
  const pendingReviewCount = reports.filter((r) => r.status === 'submitted').length;
  const totalFinancialSum = reports.reduce((sum, r) => sum + (r.financialAmount || 0), 0);

  return (
    <div className="space-y-6">
      {/* Top Banner & Quick Trigger */}
      <div className="rounded-2xl bg-gradient-to-l from-[#0B1F3A] via-[#13325c] to-[#0B1F3A] text-white p-6 shadow-md relative overflow-hidden flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1 z-10">
          <div className="flex items-center gap-2 text-[#C89B3C] text-xs font-bold">
            <Sparkles className="w-4 h-4" />
            <span>نظام تقارير الموظفين اليومية (صوتي وكتابي)</span>
          </div>
          <h1 className="font-display text-xl sm:text-2xl font-bold">
            تقارير ومذكرات الموظفين اليومية
          </h1>
          <p className="text-xs sm:text-sm text-slate-300">
            توجيه فوري ومنظم للمحاسب للمراجعة المالية، وللمدير لمتابعة سير العمل والتشغيل
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowSubmitModal(true)}
          className="min-h-[46px] px-5 py-2.5 rounded-xl bg-[#C89B3C] text-[#0B1F3A] text-xs sm:text-sm font-bold hover:bg-[#d8ac4e] transition-all flex items-center justify-center gap-2 shadow-lg cursor-pointer shrink-0 z-10"
        >
          <Mic className="w-5 h-5 text-[#0B1F3A]" />
          <span>تقديم تقرير يومي جديد</span>
        </button>
      </div>

      {/* Metric KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-4.5 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500">إجمالي التقارير</span>
            <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-700 flex items-center justify-center">
              <FileText className="w-4 h-4" />
            </div>
          </div>
          <p className="text-2xl font-bold font-mono text-[#0B1F3A] tabular-nums mt-2">
            {totalReportsCount}
          </p>
          <p className="text-[11px] text-slate-400 mt-0.5">تقارير الموظفين المسجلة</p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4.5 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500">بانتظار المراجعة</span>
            <div className="w-8 h-8 rounded-lg bg-amber-50 text-amber-700 flex items-center justify-center">
              <Clock className="w-4 h-4" />
            </div>
          </div>
          <p className="text-2xl font-bold font-mono text-amber-600 tabular-nums mt-2">
            {pendingReviewCount}
          </p>
          <p className="text-[11px] text-slate-400 mt-0.5">تحتاج اطلاع المحاسب / المدير</p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4.5 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500">تقارير مالية ومصروفات</span>
            <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center">
              <DollarSign className="w-4 h-4" />
            </div>
          </div>
          <p className="text-2xl font-bold font-mono text-emerald-700 tabular-nums mt-2">
            {financialReportsCount}
          </p>
          <p className="text-[11px] text-slate-400 mt-0.5">موجهة لدفاتر المحاسب</p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4.5 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500">إجمالي المبالغ المرصودة</span>
            <div className="w-8 h-8 rounded-lg bg-[#0B1F3A]/10 text-[#0B1F3A] flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-[#C89B3C]" />
            </div>
          </div>
          <p className="text-xl font-bold font-mono text-[#0B1F3A] tabular-nums mt-2">
            {formatEGP(totalFinancialSum)}
          </p>
          <p className="text-[11px] text-slate-400 mt-0.5">مبالغ ومصروفات مستخرجة</p>
        </div>
      </div>

      {/* Filters Strip */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[240px]">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5 pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="بحث باسم الموظف أو محتوى التقرير..."
                className="w-full rounded-xl border border-slate-200 bg-slate-50 pr-9 pl-3 py-2 text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0B1F3A]"
              />
            </div>

            <div className="flex items-center gap-1.5 text-xs text-slate-600">
              <Calendar className="w-3.5 h-3.5 text-slate-400" />
              <input
                type="date"
                value={dateFilter}
                onChange={(e) => setDateFilter(e.target.value)}
                className="rounded-xl border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs font-mono"
              />
              {dateFilter && (
                <button
                  type="button"
                  onClick={() => setDateFilter('')}
                  className="text-[11px] text-red-600 hover:underline cursor-pointer"
                >
                  إلغاء
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* School Filter */}
            {mySchools.length > 0 && (
              <select
                value={schoolFilter}
                disabled={isSingleSchoolRestricted}
                onChange={(e) => setSchoolFilter(e.target.value)}
                aria-label="تصفية التقارير حسب المدرسة"
                className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-[#0B1F3A] cursor-pointer disabled:opacity-80"
              >
                {!isSingleSchoolRestricted && (
                  <option value="all">
                    {!isSuperAdmin && restrictedSchoolIds.length > 0 ? 'جميع مدارسي' : 'كافة المدارس'}
                  </option>
                )}
                {mySchools.map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}

            {/* Target Audience Filter */}
            <select
              value={audienceFilter}
              onChange={(e) => setAudienceFilter(e.target.value)}
              className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 cursor-pointer"
            >
              <option value="all">كافة الوجهات</option>
              <option value="accountant">الموجهة للمحاسب فقط</option>
              <option value="manager">الموجهة للمدير فقط</option>
              <option value="both">الموجهة للاثنين معاً</option>
            </select>

            {/* Status Filter */}
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 cursor-pointer"
            >
              <option value="all">كافة الحالات</option>
              <option value="submitted">بانتظار المراجعة (جديد)</option>
              <option value="reviewed_by_accountant">تمت مراجعة المحاسب</option>
              <option value="reviewed_by_manager">تمت مراجعة المدير</option>
              <option value="approved">معتمد نهائياً</option>
            </select>

            <button
              type="button"
              onClick={loadReports}
              className="p-2 rounded-xl border border-slate-200 text-slate-600 hover:text-[#0B1F3A] hover:bg-slate-100 transition-colors cursor-pointer"
              title="تحديث البيانات"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {actionError && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-3.5 text-xs text-red-800 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 text-red-600" />
            <span>{actionError}</span>
          </div>
          <button
            type="button"
            onClick={() => setActionError(null)}
            aria-label="إغلاق التنبيه"
            className="p-1 text-red-500 hover:text-red-800 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Reports Feed */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-16 space-y-3">
          <Loader2 className="w-8 h-8 animate-spin text-[#0B1F3A]" />
          <span className="text-xs text-slate-500 font-semibold">جاري تحميل التقارير اليومية...</span>
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-800 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 text-red-600" />
          <span>{error}</span>
        </div>
      ) : filteredReports.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-12 text-center space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mx-auto">
            <FileText className="w-6 h-6" />
          </div>
          <h3 className="text-sm font-bold text-[#0B1F3A]">لا توجد تقارير مطابقة</h3>
          <p className="text-xs text-slate-500 max-w-sm mx-auto">
            لم يتم العثور على تقارير يومية في هذا التاريخ أو المعايير المختارة. يمكنك تقديم تقرير يومي جديد الآن.
          </p>
          <button
            type="button"
            onClick={() => setShowSubmitModal(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#0B1F3A] text-white text-xs font-bold hover:bg-[#13325c] transition-colors cursor-pointer mt-2"
          >
            <Mic className="w-4 h-4 text-[#C89B3C]" />
            <span>تقديم أول تقرير</span>
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredReports.map((rep) => {
            const isPlaying = playingId === rep.id;
            const isBeingReviewed = reviewingId === rep.id;

            return (
              <div
                key={rep.id}
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs hover:border-[#C89B3C]/50 transition-all space-y-4"
              >
                {/* Header: Author, Role, Date, Audience Tag */}
                <div className="flex flex-wrap items-start justify-between gap-3 pb-3 border-b border-slate-100">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-[#0B1F3A] text-[#C89B3C] flex items-center justify-center font-bold text-sm shrink-0">
                      {rep.employeeName.slice(0, 2)}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="font-bold text-sm text-[#0B1F3A]">{rep.employeeName}</h4>
                        <span className="text-[11px] text-slate-500 font-medium">
                          ({rep.employeeRoleOrTitle || 'موظف'})
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400 mt-0.5 tabular-nums">
                        <Clock className="w-3 h-3" />
                        <span>التاريخ: {rep.reportDate}</span>
                        <span>·</span>
                        <span>{formatRelativeArabicTime(rep.createdAt)}</span>
                        <span>·</span>
                        <span className="font-semibold text-[#0B1F3A]">
                          {rep.schoolName || 'المكتب الرئيسي'}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {/* Destination Badge */}
                    <span
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold ${
                        rep.targetAudience === 'accountant'
                          ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                          : rep.targetAudience === 'manager'
                          ? 'bg-blue-50 text-blue-800 border border-blue-200'
                          : 'bg-[#0B1F3A]/10 text-[#0B1F3A] border border-[#0B1F3A]/20'
                      }`}
                    >
                      {rep.targetAudience === 'accountant' ? (
                        <>
                          <DollarSign className="w-3 h-3 text-emerald-600" />
                          <span>للمحاسب</span>
                        </>
                      ) : rep.targetAudience === 'manager' ? (
                        <>
                          <Building className="w-3 h-3 text-blue-600" />
                          <span>للمدير</span>
                        </>
                      ) : (
                        <>
                          <Users className="w-3 h-3 text-[#C89B3C]" />
                          <span>للمدير والمحاسب</span>
                        </>
                      )}
                    </span>

                    {/* Status Badge */}
                    <span
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold ${
                        rep.status === 'approved'
                          ? 'bg-emerald-100 text-emerald-900'
                          : rep.status === 'reviewed_by_accountant'
                          ? 'bg-teal-100 text-teal-900'
                          : rep.status === 'reviewed_by_manager'
                          ? 'bg-blue-100 text-blue-900'
                          : 'bg-amber-100 text-amber-900 animate-pulse'
                      }`}
                    >
                      {rep.status === 'approved'
                        ? 'معتمد نهائياً'
                        : rep.status === 'reviewed_by_accountant'
                        ? 'مراجعة المحاسب'
                        : rep.status === 'reviewed_by_manager'
                        ? 'مراجعة المدير'
                        : 'بانتظار المراجعة'}
                    </span>
                  </div>
                </div>

                {/* Extracted Details Pill Strip (Amount & Type) */}
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  {rep.financialAmount > 0 && (
                    <div className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 font-bold">
                      <DollarSign className="w-3.5 h-3.5 text-emerald-600" />
                      <span>مبلغ مرصود: {formatEGP(rep.financialAmount)}</span>
                    </div>
                  )}

                  <div className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-slate-100 text-slate-700 font-medium">
                    <span className="w-2 h-2 rounded-full bg-[#C89B3C]"></span>
                    <span>التصنيف: {rep.category}</span>
                  </div>

                  {rep.audioDataUrl && (
                    <button
                      type="button"
                      onClick={() => handleTogglePlayAudio(rep.id, rep.audioDataUrl)}
                      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-xl border text-xs font-bold transition-colors cursor-pointer ${
                        isPlaying
                          ? 'bg-[#0B1F3A] text-white border-[#0B1F3A]'
                          : 'bg-white border-slate-300 text-[#0B1F3A] hover:bg-slate-50'
                      }`}
                    >
                      {isPlaying ? (
                        <>
                          <Pause className="w-3.5 h-3.5 text-[#C89B3C]" />
                          <span>إيقاف المقطع</span>
                        </>
                      ) : (
                        <>
                          <Volume2 className="w-3.5 h-3.5 text-[#C89B3C]" />
                          <span>استماع للتسجيل الصوتي ({rep.audioDurationSec || 0}ث)</span>
                        </>
                      )}
                    </button>
                  )}
                </div>

                {/* Content Box */}
                <div className="p-4 rounded-xl bg-slate-50/80 border border-slate-200/80 text-sm text-slate-800 leading-relaxed font-sans whitespace-pre-line">
                  {rep.rawContent}
                </div>

                {/* Attached Invoices & Photos Section */}
                {Array.isArray(rep.attachments) && rep.attachments.length > 0 && (
                  <div className="space-y-2.5 p-3.5 bg-slate-50/90 rounded-xl border border-slate-200">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-xs font-bold text-[#0B1F3A]">
                        <Receipt className="w-4 h-4 text-[#C89B3C]" />
                        <span>الفواتير والمستندات المرفقة ({rep.attachments.length}):</span>
                      </div>
                      <span className="text-[10px] text-slate-400">انقر على أي صورة لتكبيرها وفحصها</span>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
                      {rep.attachments.map((att) => (
                        <div
                          key={att.id}
                          onClick={() => setPreviewImageUrl(att.url)}
                          className="group relative rounded-xl border border-slate-200 overflow-hidden bg-white hover:border-[#C89B3C] transition-all cursor-pointer shadow-xs"
                          title="تكبير الفاتورة"
                        >
                          <div className="aspect-4/3 w-full overflow-hidden bg-slate-100 flex items-center justify-center">
                            <img
                              src={att.url}
                              alt={att.name}
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                            />
                          </div>
                          <div className="p-2 space-y-0.5">
                            <span className="block text-[11px] font-bold text-[#0B1F3A] truncate">
                              {att.categoryLabel || att.name}
                            </span>
                            {att.sizeKb && (
                              <span className="block text-[10px] text-slate-400 font-mono">
                                {att.sizeKb} KB
                              </span>
                            )}
                          </div>
                          <div className="absolute top-1.5 left-1.5 bg-black/60 text-white rounded-md p-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <Eye className="w-3.5 h-3.5" />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Extracted Tasks (if any) */}
                {rep.extractedTasks && rep.extractedTasks.length > 0 && (
                  <div className="space-y-1.5">
                    <span className="text-[11px] font-bold text-slate-500">المهام المنجزة المستخرجة:</span>
                    <div className="flex flex-wrap gap-2">
                      {rep.extractedTasks.map((t, idx) => (
                        <div
                          key={idx}
                          className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-white border border-slate-200 text-xs text-slate-700"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                          <span>{t}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Notes from Accountant or Manager */}
                {(rep.accountantNotes || rep.managerNotes) && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                    {rep.accountantNotes && (
                      <div className="p-3 rounded-xl bg-emerald-50/70 border border-emerald-200 text-xs">
                        <span className="font-bold text-emerald-900 block mb-1">
                          💼 ملاحظة ومراجعة المحاسب:
                        </span>
                        <p className="text-emerald-800">{rep.accountantNotes}</p>
                      </div>
                    )}
                    {rep.managerNotes && (
                      <div className="p-3 rounded-xl bg-blue-50/70 border border-blue-200 text-xs">
                        <span className="font-bold text-blue-900 block mb-1">
                          👑 توجيه ومراجعة المدير:
                        </span>
                        <p className="text-blue-800">{rep.managerNotes}</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Review & Approval Controls for Accountant & Manager */}
                {(isAccountant || isSuperAdmin) && (
                  <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
                    {isBeingReviewed ? (
                      <div className="w-full space-y-2 bg-slate-50 p-3 rounded-xl border border-slate-200">
                        <input
                          type="text"
                          value={reviewNote}
                          onChange={(e) => setReviewNote(e.target.value)}
                          placeholder="أضف ملاحظتك أو توجيهك للموظف..."
                          className="w-full rounded-lg border border-slate-300 p-2 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-[#0B1F3A]"
                        />
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setReviewingId(null);
                              setReviewNote('');
                            }}
                            className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-200 rounded-lg cursor-pointer"
                          >
                            إلغاء
                          </button>
                          {isAccountant && (
                            <button
                              type="button"
                              disabled={reviewActionBusy}
                              onClick={() =>
                                handleReviewReport(rep.id, 'reviewed_by_accountant', 'accountant')
                              }
                              className="px-4 py-1.5 text-xs font-bold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 cursor-pointer disabled:opacity-50"
                            >
                              اعتماد المحاسب
                            </button>
                          )}
                          {isSuperAdmin && (
                            <button
                              type="button"
                              disabled={reviewActionBusy}
                              onClick={() => handleReviewReport(rep.id, 'approved', 'manager')}
                              className="px-4 py-1.5 text-xs font-bold rounded-lg bg-[#0B1F3A] text-white hover:bg-[#13325c] cursor-pointer disabled:opacity-50"
                            >
                              اعتماد المدير النهائي
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 mr-auto">
                        <button
                          type="button"
                          onClick={() => {
                            setReviewingId(rep.id);
                            setReviewNote('');
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-[#0B1F3A] hover:bg-slate-50 cursor-pointer"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5 text-[#C89B3C]" />
                          <span>إضافة مراجعة أو اعتماد</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Submit Daily Report Modal */}
      <EmployeeDailyReportModal
        isOpen={showSubmitModal}
        onClose={() => setShowSubmitModal(false)}
        onSuccess={(newReport) => {
          setReports((prev) => [newReport, ...prev]);
        }}
      />

      {/* Lightbox Image Preview Modal */}
      {previewImageUrl && (
        <div
          className="fixed inset-0 z-60 bg-black/80 flex items-center justify-center p-4 backdrop-blur-xs"
          onClick={() => setPreviewImageUrl(null)}
        >
          <div
            className="relative max-w-4xl max-h-[92vh] bg-white rounded-2xl overflow-hidden p-3 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-2 px-2 border-b border-slate-200">
              <span className="text-xs font-bold text-[#0B1F3A]">معاينة وتدقيق صورة الفاتورة / المستند المرفق</span>
              <button
                type="button"
                onClick={() => setPreviewImageUrl(null)}
                className="p-1 rounded-lg text-slate-500 hover:text-slate-800 cursor-pointer hover:bg-slate-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="mt-2 max-h-[80vh] overflow-auto flex items-center justify-center bg-slate-900/5 rounded-xl p-2">
              <img
                src={previewImageUrl}
                alt="فاتورة"
                className="max-h-[78vh] w-auto object-contain rounded-lg shadow-sm"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
