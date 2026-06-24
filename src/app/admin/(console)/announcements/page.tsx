'use client';

import { useSearchParams } from 'next/navigation';
import { useState, useEffect, useCallback, Suspense } from 'react';
import PayPageLayout from '@/components/PayPageLayout';
import { resolveLocale, type Locale } from '@/lib/locale';
import type { AnnouncementLevel } from '@/lib/announcements/types';

interface Announcement {
    id: string;
    title: string;
    body: string;
    level: AnnouncementLevel;
    link_url: string | null;
    link_label: string | null;
    is_active: boolean;
    created_at: string;
}

interface FormData {
    title: string;
    body: string;
    level: AnnouncementLevel;
    link_url: string;
    link_label: string;
    is_active: boolean;
}

const emptyForm: FormData = { title: '', body: '', level: 'info', link_url: '', link_label: '', is_active: true };

/** 级别色点(admin 列表用 slate 适配色,不用 banner 的暖色 status token)。 */
const LEVEL_DOT: Record<AnnouncementLevel, string> = {
    info: 'bg-blue-500',
    warning: 'bg-amber-500',
    critical: 'bg-red-500',
};

function getTexts(locale: Locale) {
    return locale === 'en'
        ? {
              sessionExpired: 'Your session has expired (superadmin only).',
              title: 'Announcements',
              subtitle: 'Ops announcements — shown as a top banner in the customer console. Superadmin only.',
              refresh: 'Refresh',
              loading: 'Loading...',
              newItem: '+ New Announcement',
              editItem: 'Edit Announcement',
              none: 'No announcements',
              colTitle: 'Title',
              colLevel: 'Level',
              colStatus: 'Status',
              colTime: 'Created',
              colActions: 'Actions',
              edit: 'Edit',
              del: 'Delete',
              publish: 'Publish',
              unpublish: 'Unpublish',
              statusActive: 'Live',
              statusInactive: 'Offline',
              fieldTitle: 'Title',
              fieldBody: 'Body',
              fieldBodyHint: 'Line breaks kept. Shown to all customers — keep it plain.',
              fieldLevel: 'Level',
              fieldLinkUrl: 'Link (optional)',
              fieldLinkUrlHint: 'Must start with http(s)://; opens in a new tab.',
              fieldLinkLabel: 'Link label (optional)',
              fieldLinkLabelHint: 'Defaults to "查看详情" / "Details".',
              fieldActive: 'Publish now',
              levels: { info: 'Info', warning: 'Warning', critical: 'Important' } as Record<AnnouncementLevel, string>,
              cancel: 'Cancel',
              save: 'Save',
              saving: 'Saving...',
              loadFailed: 'Failed to load announcements',
              saveFailed: 'Failed to save announcement',
              delConfirm: 'Delete this announcement? This cannot be undone.',
          }
        : {
              sessionExpired: '登录已过期(仅超管可用)。',
              title: '公告管理',
              subtitle: '运营公告 —— 显示在客户控制台顶部通栏。仅超管可用。',
              refresh: '刷新',
              loading: '加载中...',
              newItem: '+ 新建公告',
              editItem: '编辑公告',
              none: '暂无公告',
              colTitle: '标题',
              colLevel: '级别',
              colStatus: '状态',
              colTime: '创建时间',
              colActions: '操作',
              edit: '编辑',
              del: '删除',
              publish: '上线',
              unpublish: '下线',
              statusActive: '已上线',
              statusInactive: '已下线',
              fieldTitle: '标题',
              fieldBody: '正文',
              fieldBodyHint: '支持换行。面向所有客户,措辞请通俗。',
              fieldLevel: '级别',
              fieldLinkUrl: '链接(可选)',
              fieldLinkUrlHint: '需 http(s):// 开头;客户点击在新标签打开。',
              fieldLinkLabel: '链接文案(可选)',
              fieldLinkLabelHint: '缺省显示「查看详情」。',
              fieldActive: '立即上线',
              levels: { info: '普通', warning: '提醒', critical: '重要' } as Record<AnnouncementLevel, string>,
              cancel: '取消',
              save: '保存',
              saving: '保存中...',
              loadFailed: '加载公告失败',
              saveFailed: '保存公告失败',
              delConfirm: '确认删除这条公告?此操作不可撤销。',
          };
}

function AnnouncementsContent() {
    const searchParams = useSearchParams();
    const theme = searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    const uiMode = searchParams.get('ui_mode') || 'standalone';
    const locale = resolveLocale(searchParams.get('lang'));
    const isDark = theme === 'dark';
    const isEmbedded = uiMode === 'embedded';
    const t = getTexts(locale);

    const [items, setItems] = useState<Announcement[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [modalOpen, setModalOpen] = useState(false);
    const [editing, setEditing] = useState<Announcement | null>(null);
    const [form, setForm] = useState<FormData>(emptyForm);
    const [saving, setSaving] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);

    const fetchList = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const res = await fetch('/api/admin/announcements');
            if (!res.ok) {
                setError(res.status === 401 ? t.sessionExpired : t.loadFailed);
                return;
            }
            const data = await res.json();
            setItems(data.announcements ?? []);
        } catch {
            setError(t.loadFailed);
        } finally {
            setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        fetchList();
    }, [fetchList]);

    const openCreate = () => {
        setEditing(null);
        setForm(emptyForm);
        setModalOpen(true);
    };
    const openEdit = (a: Announcement) => {
        setEditing(a);
        setForm({
            title: a.title,
            body: a.body,
            level: a.level,
            link_url: a.link_url ?? '',
            link_label: a.link_label ?? '',
            is_active: a.is_active,
        });
        setModalOpen(true);
    };

    /** PUT/POST 整体提交(后端整体替换语义)。 */
    function payloadFrom(f: FormData) {
        return {
            title: f.title.trim(),
            body: f.body.trim(),
            level: f.level,
            link_url: f.link_url.trim() || null,
            link_label: f.link_label.trim() || null,
            is_active: f.is_active,
        };
    }

    const handleSave = async () => {
        if (!form.title.trim()) return;
        setSaving(true);
        setError('');
        try {
            const url = editing ? `/api/admin/announcements/${editing.id}` : '/api/admin/announcements';
            const res = await fetch(url, {
                method: editing ? 'PUT' : 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payloadFrom(form)),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                setError(data.error || t.saveFailed);
                return;
            }
            setModalOpen(false);
            fetchList();
        } catch {
            setError(t.saveFailed);
        } finally {
            setSaving(false);
        }
    };

    /** 上/下线快捷 — 复用 PUT,仅翻转 is_active(其余字段原样回传)。 */
    const toggleActive = async (a: Announcement) => {
        setBusyId(a.id);
        setError('');
        try {
            const res = await fetch(`/api/admin/announcements/${a.id}`, {
                method: 'PUT',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: a.title,
                    body: a.body,
                    level: a.level,
                    link_url: a.link_url,
                    link_label: a.link_label,
                    is_active: !a.is_active,
                }),
            });
            if (!res.ok) {
                setError(t.saveFailed);
                return;
            }
            fetchList();
        } catch {
            setError(t.saveFailed);
        } finally {
            setBusyId(null);
        }
    };

    const handleDelete = async (a: Announcement) => {
        if (!window.confirm(t.delConfirm)) return;
        setBusyId(a.id);
        setError('');
        try {
            const res = await fetch(`/api/admin/announcements/${a.id}`, {
                method: 'DELETE',
                credentials: 'same-origin',
            });
            if (!res.ok) {
                setError(t.saveFailed);
                return;
            }
            fetchList();
        } catch {
            setError(t.saveFailed);
        } finally {
            setBusyId(null);
        }
    };

    const btnBase = [
        'inline-flex items-center rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
        isDark
            ? 'border-slate-600 text-slate-200 hover:bg-slate-800'
            : 'border-slate-300 text-slate-700 hover:bg-slate-100',
    ].join(' ');
    const inputCls = [
        'w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50',
        isDark ? 'border-slate-600 bg-slate-700 text-slate-100' : 'border-slate-300 bg-white text-slate-900',
    ].join(' ');
    const labelCls = ['block text-sm font-medium mb-1', isDark ? 'text-slate-300' : 'text-slate-700'].join(' ');
    const linkCls = isDark ? 'text-indigo-400 hover:underline' : 'text-indigo-600 hover:underline';

    return (
        <PayPageLayout
            isDark={isDark}
            isEmbedded={isEmbedded}
            maxWidth="full"
            title={t.title}
            subtitle={t.subtitle}
            locale={locale}
            actions={
                <button type="button" onClick={fetchList} className={btnBase}>
                    {t.refresh}
                </button>
            }
        >
            {error && (
                <div
                    className={`mb-4 rounded-lg border p-3 text-sm ${isDark ? 'border-red-800 bg-red-950/50 text-red-400' : 'border-red-200 bg-red-50 text-red-600'}`}
                >
                    {error}
                    <button onClick={() => setError('')} className="ml-2 opacity-60 hover:opacity-100">
                        ✕
                    </button>
                </div>
            )}

            <div className="mb-4 flex justify-end">
                <button
                    type="button"
                    onClick={openCreate}
                    className="inline-flex items-center rounded-lg border border-emerald-500 bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600"
                >
                    {t.newItem}
                </button>
            </div>

            <div
                className={[
                    'overflow-x-auto rounded-xl border',
                    isDark ? 'border-slate-700 bg-slate-800/70' : 'border-slate-200 bg-white shadow-sm',
                ].join(' ')}
            >
                {loading ? (
                    <div className={`py-12 text-center ${isDark ? 'text-slate-400' : 'text-gray-500'}`}>
                        {t.loading}
                    </div>
                ) : items.length === 0 ? (
                    <div className={`py-12 text-center ${isDark ? 'text-slate-400' : 'text-gray-500'}`}>{t.none}</div>
                ) : (
                    <table className="w-full text-sm">
                        <thead>
                            <tr
                                className={
                                    isDark
                                        ? 'border-b border-slate-700 text-slate-400'
                                        : 'border-b border-slate-200 text-slate-500'
                                }
                            >
                                <th className="px-4 py-3 text-left font-medium">{t.colTitle}</th>
                                <th className="px-4 py-3 text-left font-medium">{t.colLevel}</th>
                                <th className="px-4 py-3 text-center font-medium">{t.colStatus}</th>
                                <th className="px-4 py-3 text-left font-medium">{t.colTime}</th>
                                <th className="px-4 py-3 text-right font-medium">{t.colActions}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {items.map((a) => (
                                <tr
                                    key={a.id}
                                    className={['border-b', isDark ? 'border-slate-700/50' : 'border-slate-100'].join(
                                        ' ',
                                    )}
                                >
                                    <td
                                        className={`px-4 py-3 font-medium ${isDark ? 'text-slate-100' : 'text-slate-900'}`}
                                    >
                                        {a.title}
                                    </td>
                                    <td className={`px-4 py-3 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                                        <span className="inline-flex items-center gap-2">
                                            <span
                                                className={`inline-block h-2.5 w-2.5 rounded-full ${LEVEL_DOT[a.level]}`}
                                            />
                                            {t.levels[a.level]}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-center">
                                        <span className={a.is_active ? 'text-emerald-500' : 'text-slate-400'}>
                                            {a.is_active ? t.statusActive : t.statusInactive}
                                        </span>
                                    </td>
                                    <td className={`px-4 py-3 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                                        {new Date(a.created_at).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN', {
                                            timeZone: 'Asia/Shanghai',
                                        })}
                                    </td>
                                    <td className="px-4 py-3 text-right">
                                        <span className="inline-flex items-center gap-3">
                                            <button
                                                type="button"
                                                onClick={() => toggleActive(a)}
                                                disabled={busyId === a.id}
                                                className={`${linkCls} disabled:opacity-40`}
                                            >
                                                {a.is_active ? t.unpublish : t.publish}
                                            </button>
                                            <button type="button" onClick={() => openEdit(a)} className={linkCls}>
                                                {t.edit}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => handleDelete(a)}
                                                disabled={busyId === a.id}
                                                className="text-red-500 hover:underline disabled:opacity-40"
                                            >
                                                {t.del}
                                            </button>
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {modalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <div
                        className={[
                            'relative w-full max-w-lg overflow-y-auto rounded-2xl border p-6 shadow-2xl',
                            isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-200 bg-white',
                        ].join(' ')}
                        style={{ maxHeight: '90vh' }}
                    >
                        <h2 className={`mb-5 text-lg font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                            {editing ? t.editItem : t.newItem}
                        </h2>
                        <div className="space-y-4">
                            <div>
                                <label className={labelCls}>{t.fieldTitle}</label>
                                <input
                                    type="text"
                                    value={form.title}
                                    maxLength={200}
                                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                                    className={inputCls}
                                />
                            </div>
                            <div>
                                <label className={labelCls}>{t.fieldBody}</label>
                                <textarea
                                    value={form.body}
                                    onChange={(e) => setForm({ ...form, body: e.target.value })}
                                    rows={4}
                                    maxLength={5000}
                                    className={inputCls}
                                />
                                <p className={`mt-1 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                    {t.fieldBodyHint}
                                </p>
                            </div>
                            <div>
                                <label className={labelCls}>{t.fieldLevel}</label>
                                <select
                                    value={form.level}
                                    onChange={(e) => setForm({ ...form, level: e.target.value as AnnouncementLevel })}
                                    className={inputCls}
                                >
                                    <option value="info">{t.levels.info}</option>
                                    <option value="warning">{t.levels.warning}</option>
                                    <option value="critical">{t.levels.critical}</option>
                                </select>
                            </div>
                            <div className="flex gap-3">
                                <div className="flex-1">
                                    <label className={labelCls}>{t.fieldLinkUrl}</label>
                                    <input
                                        type="text"
                                        value={form.link_url}
                                        onChange={(e) => setForm({ ...form, link_url: e.target.value })}
                                        className={[inputCls, 'font-mono text-xs'].join(' ')}
                                        placeholder="https://..."
                                    />
                                    <p className={`mt-1 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                        {t.fieldLinkUrlHint}
                                    </p>
                                </div>
                                <div className="flex-1">
                                    <label className={labelCls}>{t.fieldLinkLabel}</label>
                                    <input
                                        type="text"
                                        value={form.link_label}
                                        maxLength={80}
                                        onChange={(e) => setForm({ ...form, link_label: e.target.value })}
                                        className={inputCls}
                                    />
                                    <p className={`mt-1 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                        {t.fieldLinkLabelHint}
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center gap-3">
                                <button
                                    type="button"
                                    onClick={() => setForm({ ...form, is_active: !form.is_active })}
                                    className={[
                                        'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                                        form.is_active ? 'bg-emerald-500' : isDark ? 'bg-slate-600' : 'bg-slate-300',
                                    ].join(' ')}
                                    aria-pressed={form.is_active}
                                >
                                    <span
                                        className={[
                                            'inline-block h-4 w-4 rounded-full bg-white transition-transform',
                                            form.is_active ? 'translate-x-6' : 'translate-x-1',
                                        ].join(' ')}
                                    />
                                </button>
                                <span className={`text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                                    {t.fieldActive}
                                </span>
                            </div>
                        </div>
                        <div className="mt-6 flex justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => setModalOpen(false)}
                                className={[
                                    'rounded-lg px-4 py-2 text-sm font-medium',
                                    isDark ? 'text-slate-400 hover:bg-slate-700' : 'text-slate-600 hover:bg-slate-100',
                                ].join(' ')}
                            >
                                {t.cancel}
                            </button>
                            <button
                                type="button"
                                onClick={handleSave}
                                disabled={saving || !form.title.trim()}
                                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {saving ? t.saving : t.save}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </PayPageLayout>
    );
}

function Fallback() {
    const searchParams = useSearchParams();
    const locale = resolveLocale(searchParams.get('lang'));
    return (
        <div className="flex min-h-screen items-center justify-center">
            <div className="text-slate-500">{locale === 'en' ? 'Loading...' : '加载中...'}</div>
        </div>
    );
}

export default function AnnouncementsPage() {
    return (
        <Suspense fallback={<Fallback />}>
            <AnnouncementsContent />
        </Suspense>
    );
}
