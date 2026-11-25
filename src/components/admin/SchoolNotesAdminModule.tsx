import React, { useCallback, useEffect, useState } from 'react';
import {
  BarChart3,
  CheckCircle2,
  Clock,
  Inbox,
  MessageSquareReply,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch, getLocalTodayDateString } from '../../lib/api';
import { useEscapeKey } from '../../lib/useEscapeKey';
import type { SchoolMonthlyReportSummary, SchoolNoteItem } from '../../types';

const CATEGORY_LABELS: Record<string, string> = {
  delay: 'تأخير',
  cleanliness: 'نظافة',
  behavior: 'تعامل',
  safety: 'أمان',
};

interface ScopedSchoolOption {
  id: number;
  name: string;
}

export const SchoolNotesAdminModule: React.FC = () => {
  const { dbUser } = useAuth();
  const isSuperAdmin = dbUser?.roleSlug === 'super_admin' || (dbUser?.permissions || []).includes('*');
  const canWrite =
    isSuperAdmin ||
    ((dbUser?.permissions || []).includes('school_notes:write') &&
      dbUser?.roleSlug !== 'school_movement_manager');

  const currentMonthCairo = getLocalTodayDateString().slice(0, 7);

  const [subTab, setSubTab] = useState<'inbox' | 'report'>('inbox');
  const [schools, setSchools] = useState<ScopedSchoolOption[]>([]);
  const [notes, setNotes] = useState<SchoolNoteItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  // Inbox Filters
  const [schoolFilter, setSchoolFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'closed'>('all');

  // Inline Reply / Close state
  const [replyingNoteId, setReplyingNoteId] = useState<number | null>(null);
  const [replyText, setReplyText] = useState('');
  const [closingNoteId, setClosingNoteId] = useState<number | null>(null);
  const [resolutionText, setResolutionText] = useState('');
  const [actionBusy, setActionBusy] = useState(false);

  // Photo lightbox
  const [zoomPhotoUrl, setZoomPhotoUrl] = useState<string | null>(null);
  useEscapeKey(Boolean(zoomPhotoUrl), () => setZoomPhotoUrl(null));

  // Monthly report state
  const [reportSchoolId, setReportSchoolId] = useState<string>('');
  const [reportMonth, setReportMonth] = useState<string>(currentMonthCairo);
  const [report, setReport] = useState<SchoolMonthlyReportSummary | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  const loadSchools = useCallback(async () => {
    try {
      const res = await apiFetch<{ schools: ScopedSchoolOption[] }>('/api/my-schools');
      const list = res.schools || [];
      setSchools(list);
      if (list.length > 0) {
        setReportSchoolId((prev) => prev || String(list[0].id));
      }
    } catch {
      // ignore
    }
  }, []);

  const loadInbox = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (schoolFilter !== 'all') params.set('schoolId', schoolFilter);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const q = params.toString();
      const res = await apiFetch<{ notes: SchoolNoteItem[] }>(
        `/api/school-notes${q ? `?${q}` : ''}`
      );
      setNotes(res.notes || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل ملاحظات المدارس');
    } finally {
      setLoading(false);
    }
  }, [schoolFilter, statusFilter]);

  const loadMonthlyReport = useCallback(async () => {
    if (!reportSchoolId) return;
    setReportLoading(true);
    setReportError(null);
    try {
      const res = await apiFetch<{ report: SchoolMonthlyReportSummary }>(
        `/api/school-notes/monthly-report?schoolId=${encodeURIComponent(
          reportSchoolId
        )}&month=${encodeURIComponent(reportMonth)}`
      );
      setReport(res.report);
    } catch (err: unknown) {
      setReportError(err instanceof Error ? err.message : 'تعذر تحميل التقرير الشهري');
    } finally {
      setReportLoading(false);
    }
  }, [reportSchoolId, reportMonth]);

  useEffect(() => {
    loadSchools();
  }, [loadSchools]);

  useEffect(() => {
    loadInbox();
  }, [loadInbox]);

  useEffect(() => {
    if (subTab === 'report' && reportSchoolId) {
      loadMonthlyReport();
    }
  }, [subTab, reportSchoolId, reportMonth, loadMonthlyReport]);

  const handleSaveReply = async (noteId: number) => {
    const trimmed = replyText.trim();
    if (!trimmed) {
      setError('يرجى كتابة نص الرد أولاً');
      return;
    }
    setActionBusy(true);
    setError(null);
    setActionMsg(null);
    try {
      await apiFetch(`/api/school-notes/${noteId}/reply`, {
        method: 'PATCH',
        body: JSON.stringify({ adminReply: trimmed }),
      });
      setReplyingNoteId(null);
      setReplyText('');
      setActionMsg('تم حفظ الرد على الملاحظة.');
      await loadInbox();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر حفظ الرد');
    } finally {
      setActionBusy(false);
    }
  };

  const handleCloseWithResolution = async (noteId: number) => {
    const trimmed = resolutionText.trim();
    if (!trimmed) {
      setError('يجب كتابة الحل قبل إغلاق الملاحظة');
      return;
    }
    setActionBusy(true);
    setError(null);
    setActionMsg(null);
    try {
      await apiFetch(`/api/school-notes/${noteId}/close`, {
        method: 'PATCH',
        body: JSON.stringify({ resolution: trimmed }),
      });
      setClosingNoteId(null);
      setResolutionText('');
      setActionMsg('تم إغلاق الملاحظة بالحل وتسجيلها في سجل التدقيق.');
      await loadInbox();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر إغلاق الملاحظة');
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#0B1F3A]">ملاحظات المدارس</h1>
          <p className="text-sm text-slate-500 mt-1">
            متابعة ملاحظات مديري الحركة في المدارس، الرد عليها، إغلاق الشكاوى بالحل، واستعراض التقرير
            الشهري والالتزام بالمواعيد
          </p>
        </div>

        <div className="inline-flex rounded-xl bg-slate-200/70 p-1 text-xs shrink-0">
          <button
            type="button"
            onClick={() => setSubTab('inbox')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 font-bold cursor-pointer transition-colors ${
              subTab === 'inbox' ? 'bg-[#0B1F3A] text-white' : 'text-slate-700 hover:text-slate-950'
            }`}
          >
            <Inbox className="w-3.5 h-3.5 text-[#C89B3C]" />
            صندوق الملاحظات ({notes.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('report')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 font-bold cursor-pointer transition-colors ${
              subTab === 'report' ? 'bg-[#0B1F3A] text-white' : 'text-slate-700 hover:text-slate-950'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5 text-[#C89B3C]" />
            التقرير الشهري
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3.5 text-xs text-red-800 flex items-center justify-between gap-2">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {actionMsg && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 text-xs font-semibold text-emerald-900 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{actionMsg}</span>
          </div>
          <button type="button" onClick={() => setActionMsg(null)} className="cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {subTab === 'inbox' && (
        <div className="space-y-4">
          {/* Filters Bar */}
          <div className="bg-white border border-slate-200 rounded-2xl p-4 flex flex-wrap items-center gap-3 text-xs">
            <div className="flex items-center gap-2">
              <label className="font-bold text-[#0B1F3A]">المدرسة:</label>
              <select
                value={schoolFilter}
                onChange={(e) => setSchoolFilter(e.target.value)}
                className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-[#0B1F3A]"
              >
                <option value="all">كل المدارس</option>
                {schools.map((sc) => (
                  <option key={sc.id} value={String(sc.id)}>
                    {sc.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="font-bold text-[#0B1F3A] ml-1">الحالة:</span>
              {(['all', 'open', 'closed'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStatusFilter(st)}
                  className={`rounded-lg px-3 py-1.5 font-bold cursor-pointer ${
                    statusFilter === st
                      ? 'bg-[#0B1F3A] text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  {st === 'all' ? 'الكل' : st === 'open' ? 'مفتوحة' : 'اتقفلت'}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center text-xs text-slate-400">
              جاري تحميل ملاحظات المدارس...
            </div>
          ) : notes.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center text-xs text-slate-500">
              لا توجد ملاحظات مطابقة للفلتر المحدد.
            </div>
          ) : (
            <div className="space-y-3">
              {notes.map((note) => {
                const isPositive = note.noteType === 'positive';
                const isClosed = note.status === 'closed';
                const isReplying = replyingNoteId === note.id;
                const isClosing = closingNoteId === note.id;

                return (
                  <div
                    key={note.id}
                    className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-lg bg-[#0B1F3A] px-2.5 py-1 text-xs font-bold text-white">
                          {note.schoolName}
                        </span>
                        <span
                          className={`rounded-lg px-2.5 py-1 text-xs font-bold ${
                            isPositive
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-red-100 text-red-800'
                          }`}
                        >
                          {isPositive ? 'إيجابية' : 'سلبية'}
                        </span>
                        <span className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                          {CATEGORY_LABELS[note.category] || note.category}
                        </span>
                        <span
                          className={`rounded-lg px-2.5 py-1 text-xs font-bold ${
                            isClosed
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                              : 'bg-amber-50 text-amber-800 border border-amber-200'
                          }`}
                        >
                          {isClosed ? 'اتقفلت' : 'مفتوحة'}
                        </span>
                      </div>

                      <div className="text-xs text-slate-500 font-mono">
                        {note.tripDate} · بواسطة {note.createdByName}
                      </div>
                    </div>

                    {(note.routeName || note.driverName) && (
                      <div className="text-xs text-slate-600">
                        {note.routeName && (
                          <span>
                            الخط: <strong className="text-[#0B1F3A]">{note.routeName}</strong>
                          </span>
                        )}
                        {note.routeName && note.driverName && ' · '}
                        {note.driverName && (
                          <span>
                            السائق: <strong className="text-[#0B1F3A]">{note.driverName}</strong>
                          </span>
                        )}
                      </div>
                    )}

                    <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
                      {note.body}
                    </p>

                    {note.photoUrl && (
                      <button
                        type="button"
                        onClick={() => setZoomPhotoUrl(note.photoUrl)}
                        className="block rounded-xl overflow-hidden border border-slate-200 cursor-pointer"
                      >
                        <img
                          src={note.photoUrl}
                          alt="صورة مرفقة"
                          className="max-h-48 object-cover"
                        />
                      </button>
                    )}

                    {(note.adminReply || note.resolution) && (
                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 space-y-1.5 text-xs">
                        {note.adminReply && (
                          <div>
                            <span className="font-bold text-[#0B1F3A]">رد الإدارة: </span>
                            <span className="text-slate-700">{note.adminReply}</span>
                          </div>
                        )}
                        {note.resolution && (
                          <div>
                            <span className="font-bold text-emerald-800">الحل: </span>
                            <span className="text-slate-700">{note.resolution}</span>
                            {note.resolvedByName && (
                              <span className="text-slate-400"> · ({note.resolvedByName})</span>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Admin Actions: رد + اقفل بحل */}
                    {canWrite && (
                      <div className="space-y-3 pt-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setClosingNoteId(null);
                              if (isReplying) {
                                setReplyingNoteId(null);
                              } else {
                                setReplyingNoteId(note.id);
                                setReplyText(note.adminReply || '');
                              }
                            }}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 px-3.5 py-2 text-xs font-bold text-[#0B1F3A] cursor-pointer"
                          >
                            <MessageSquareReply className="w-3.5 h-3.5 text-[#C89B3C]" />
                            رد
                          </button>

                          {!isClosed && (
                            <button
                              type="button"
                              onClick={() => {
                                setReplyingNoteId(null);
                                if (isClosing) {
                                  setClosingNoteId(null);
                                } else {
                                  setClosingNoteId(note.id);
                                  setResolutionText('');
                                }
                              }}
                              className="inline-flex items-center gap-1.5 rounded-xl bg-[#0B1F3A] hover:bg-[#13325c] px-3.5 py-2 text-xs font-bold text-white cursor-pointer"
                            >
                              <ShieldCheck className="w-3.5 h-3.5 text-[#C89B3C]" />
                              اقفل بحل
                            </button>
                          )}
                        </div>

                        {isReplying && (
                          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 space-y-2.5">
                            <textarea
                              rows={2}
                              value={replyText}
                              onChange={(e) => setReplyText(e.target.value)}
                              placeholder="اكتب رد الإدارة هنا..."
                              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs focus:border-[#0B1F3A] focus:outline-none"
                            />
                            <div className="flex justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => setReplyingNoteId(null)}
                                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 cursor-pointer"
                              >
                                إلغاء
                              </button>
                              <button
                                type="button"
                                disabled={actionBusy}
                                onClick={() => handleSaveReply(note.id)}
                                className="rounded-lg bg-[#0B1F3A] px-4 py-1.5 text-xs font-bold text-white disabled:opacity-50 cursor-pointer"
                              >
                                {actionBusy ? 'جاري الحفظ...' : 'حفظ الرد'}
                              </button>
                            </div>
                          </div>
                        )}

                        {isClosing && (
                          <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3.5 space-y-2.5">
                            <label className="block text-xs font-bold text-emerald-900">
                              الحل المُعتمد (إجباري لإغلاق الملاحظة) *
                            </label>
                            <textarea
                              rows={2}
                              value={resolutionText}
                              onChange={(e) => setResolutionText(e.target.value)}
                              placeholder="اكتب الإجراء أو الحل الذي تم اتخاذه..."
                              className="w-full rounded-lg border border-emerald-200 bg-white px-3 py-2 text-xs focus:border-emerald-700 focus:outline-none"
                            />
                            <div className="flex justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => setClosingNoteId(null)}
                                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 cursor-pointer"
                              >
                                إلغاء
                              </button>
                              <button
                                type="button"
                                disabled={actionBusy}
                                onClick={() => handleCloseWithResolution(note.id)}
                                className="rounded-lg bg-emerald-700 hover:bg-emerald-800 px-4 py-1.5 text-xs font-bold text-white disabled:opacity-50 cursor-pointer"
                              >
                                {actionBusy ? 'جاري الإغلاق...' : 'تأكيد الإغلاق بالحل'}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {subTab === 'report' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-2xl p-4 flex flex-wrap items-center gap-3 text-xs">
            <div className="flex items-center gap-2">
              <label className="font-bold text-[#0B1F3A]">المدرسة:</label>
              <select
                value={reportSchoolId}
                onChange={(e) => setReportSchoolId(e.target.value)}
                className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-[#0B1F3A]"
              >
                {schools.map((sc) => (
                  <option key={sc.id} value={String(sc.id)}>
                    {sc.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <label className="font-bold text-[#0B1F3A]">الشهر:</label>
              <input
                type="month"
                max={currentMonthCairo}
                value={reportMonth}
                onChange={(e) => setReportMonth(e.target.value)}
                className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-mono text-[#0B1F3A]"
              />
            </div>
          </div>

          {reportError && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800">
              {reportError}
            </div>
          )}

          {reportLoading ? (
            <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center text-xs text-slate-400">
              جاري حساب التقرير الشهري...
            </div>
          ) : report ? (
            <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-5">
              <div>
                <h2 className="font-display text-lg font-bold text-[#0B1F3A]">
                  التقرير الشهري — {report.schoolName}
                </h2>
                <p className="text-xs text-slate-500 mt-0.5 font-mono">{report.month}</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-center">
                  <div className="text-xs font-bold text-emerald-800">ملاحظات إيجابية</div>
                  <div className="font-display text-3xl font-bold text-emerald-700 mt-1 tabular-nums">
                    {report.positiveCount}
                  </div>
                </div>
                <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-center">
                  <div className="text-xs font-bold text-red-800">ملاحظات سلبية</div>
                  <div className="font-display text-3xl font-bold text-red-700 mt-1 tabular-nums">
                    {report.negativeCount}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-bold text-[#0B1F3A]">توزيع التصنيفات</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-center">
                    <div className="text-xs text-slate-600 font-semibold">تأخير</div>
                    <div className="font-display text-2xl font-bold text-[#0B1F3A] mt-0.5 tabular-nums">
                      {report.categories.delay}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-center">
                    <div className="text-xs text-slate-600 font-semibold">نظافة</div>
                    <div className="font-display text-2xl font-bold text-[#0B1F3A] mt-0.5 tabular-nums">
                      {report.categories.cleanliness}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-center">
                    <div className="text-xs text-slate-600 font-semibold">تعامل</div>
                    <div className="font-display text-2xl font-bold text-[#0B1F3A] mt-0.5 tabular-nums">
                      {report.categories.behavior}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-center">
                    <div className="text-xs text-slate-600 font-semibold">أمان</div>
                    <div className="font-display text-2xl font-bold text-[#0B1F3A] mt-0.5 tabular-nums">
                      {report.categories.safety}
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-1.5">
                <div className="flex items-center gap-2 text-xs font-bold text-[#0B1F3A]">
                  <Clock className="w-4 h-4 text-[#C89B3C]" />
                  <span>نسبة الالتزام بالمواعيد (سماح {report.punctuality.onTimeGraceMinutes} دقيقة)</span>
                </div>
                <div className="font-display text-lg font-bold text-[#0B1F3A]">
                  {report.punctuality.summaryText}
                </div>
              </div>

              <div className="rounded-xl border border-[#C89B3C]/50 bg-amber-50/70 p-4 flex items-center gap-2.5 text-sm font-bold text-[#0B1F3A]">
                <ShieldAlert className="w-4 h-4 text-[#C89B3C] shrink-0" />
                <span>
                  شكاوى اتقفلت بحل: {report.complaintsClosedCount}، مقابل مفتوحة:{' '}
                  {report.complaintsOpenCount}
                </span>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {zoomPhotoUrl && (
        <div
          onClick={() => setZoomPhotoUrl(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative max-w-2xl w-full rounded-2xl bg-[#0B1F3A] p-3"
          >
            <button
              type="button"
              onClick={() => setZoomPhotoUrl(null)}
              className="absolute top-3 left-3 p-2 rounded-lg bg-white/15 text-white hover:bg-white/25 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
            <img
              src={zoomPhotoUrl}
              alt="صورة الملاحظة"
              className="max-h-[80vh] w-full object-contain rounded-xl"
            />
          </div>
        </div>
      )}
    </div>
  );
};
