import React, { useCallback, useEffect, useState } from 'react';
import { Bell, Shield, Users } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import type { EnrichedDriver } from '../../types';

interface UserItem {
  id: number;
  email: string;
  fullName: string;
  roleId: number;
  roleSlug: string;
  roleNameAr: string;
  isActive: boolean;
}

interface RoleItem {
  id: number;
  slug: string;
  nameAr: string;
  description: string | null;
  permissions: string[];
}

interface AuditItem {
  id: number;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
}

export const SettingsUsersModule: React.FC = () => {
  const [usersList, setUsersList] = useState<UserItem[]>([]);
  const [rolesList, setRolesList] = useState<RoleItem[]>([]);
  const [auditList, setAuditList] = useState<AuditItem[]>([]);
  const [driversList, setDriversList] = useState<EnrichedDriver[]>([]);
  const [announceTitle, setAnnounceTitle] = useState('');
  const [announceBody, setAnnounceBody] = useState('');
  const [targetDriverId, setTargetDriverId] = useState('');
  const [sentMsg, setSentMsg] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    const [uRes, aRes, dRes] = await Promise.all([
      apiFetch<{ users: UserItem[]; roles: RoleItem[] }>('/api/users'),
      apiFetch<{ logs: AuditItem[] }>('/api/audit-logs'),
      apiFetch<{ drivers: EnrichedDriver[] }>('/api/drivers'),
    ]);
    setUsersList(uRes.users);
    setRolesList(uRes.roles);
    setAuditList(aRes.logs);
    setDriversList(dRes.drivers);
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleRoleChange = async (userId: number, roleId: number) => {
    await apiFetch(`/api/users/${userId}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ roleId }),
    });
    await loadAll();
  };

  const handleSendAnnouncement = async (e: React.FormEvent) => {
    e.preventDefault();
    setSentMsg(null);
    await apiFetch('/api/notifications/announcement', {
      method: 'POST',
      body: JSON.stringify({
        title: announceTitle,
        body: announceBody,
        driverId: targetDriverId ? Number(targetDriverId) : null,
      }),
    });
    setAnnounceTitle('');
    setAnnounceBody('');
    setSentMsg('تم إرسال الإشعار بنجاح.');
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-[#0B1F3A]">
          الصلاحيات والمستخدمون والإشعارات
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          إدارة مستويات الوصول (المدير العام، السائقين، مشرف الحركة، المحاسب) وإرسال التنبيهات وسجل التدقيق
        </p>
      </div>

      {/* Role Architecture Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {rolesList.map((r) => (
          <div key={r.id} className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="flex items-center gap-2 font-bold text-sm text-[#0B1F3A]">
              <Shield className="w-4 h-4 text-[#C89B3C]" />
              <span>{r.nameAr}</span>
            </div>
            <p className="mt-1.5 text-xs text-slate-600 leading-relaxed">{r.description}</p>
            <div className="mt-2 font-mono text-[11px] text-slate-400">{r.slug}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Users Table */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-2 font-bold text-sm text-[#0B1F3A]">
            <Users className="w-4 h-4 text-[#C89B3C]" />
            <span>حسابات المستخدمين المسجلة</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4">الاسم والبريد</th>
                  <th className="py-3 px-4">الدور الوظيفي</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {usersList.map((u) => (
                  <tr key={u.id}>
                    <td className="py-3 px-4">
                      <div className="font-semibold text-slate-900">{u.fullName}</div>
                      <div className="font-mono text-slate-500">{u.email}</div>
                    </td>
                    <td className="py-3 px-4">
                      <select
                        value={u.roleId}
                        onChange={(e) => handleRoleChange(u.id, Number(e.target.value))}
                        className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold"
                      >
                        {rolesList.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.nameAr}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Send Announcement */}
        <form
          onSubmit={handleSendAnnouncement}
          className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-3 text-xs h-fit"
        >
          <div className="flex items-center gap-2 font-bold text-sm text-[#0B1F3A]">
            <Bell className="w-4 h-4 text-[#C89B3C]" />
            <span>إرسال إشعار للسائقين</span>
          </div>
          {sentMsg && (
            <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-2.5 text-emerald-800">
              {sentMsg}
            </div>
          )}
          <select
            value={targetDriverId}
            onChange={(e) => setTargetDriverId(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2"
          >
            <option value="">جميع السائقين النشطين</option>
            {driversList.map((d) => (
              <option key={d.id} value={d.id}>
                {d.fullName} (كود {d.driverCode})
              </option>
            ))}
          </select>
          <input
            required
            placeholder="عنوان الإشعار *"
            value={announceTitle}
            onChange={(e) => setAnnounceTitle(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2"
          />
          <textarea
            required
            rows={3}
            placeholder="نص التنبيه أو التعميم الإداري *"
            value={announceBody}
            onChange={(e) => setAnnounceBody(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2"
          />
          <button
            type="submit"
            className="w-full rounded-lg bg-[#0B1F3A] py-2.5 font-semibold text-white hover:bg-[#13325c] cursor-pointer"
          >
            إرسال الإشعار الآن
          </button>
        </form>
      </div>

      {/* Audit Trail */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 font-bold text-sm text-[#0B1F3A]">
          سجل التدقيق والأمان (Audit Trail)
        </div>
        <div className="overflow-x-auto max-h-72 overflow-y-auto">
          <table className="w-full text-right text-xs">
            <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
              <tr>
                <th className="py-2.5 px-4">الوقت</th>
                <th className="py-2.5 px-4">الإجراء</th>
                <th className="py-2.5 px-4">الجدول / المعرف</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {auditList.map((a) => (
                <tr key={a.id}>
                  <td className="py-2.5 px-4 font-mono text-slate-500 tabular-nums">
                    {new Date(a.createdAt).toLocaleString('ar-EG')}
                  </td>
                  <td className="py-2.5 px-4 font-mono font-semibold text-[#0B1F3A]">{a.action}</td>
                  <td className="py-2.5 px-4 font-mono text-slate-600">
                    {a.entityType} #{a.entityId}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
