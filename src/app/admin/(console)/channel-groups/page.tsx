'use client';

import { useSearchParams } from 'next/navigation';
import { useState, useEffect, useCallback, Suspense } from 'react';
import PayPageLayout from '@/components/PayPageLayout';
import { resolveLocale, type Locale } from '@/lib/locale';

// ── Types ──

interface ChannelGroup {
    id: string;
    tenant_id: string | null;
    key: string;
    display_name: string;
    description: string | null;
    newapi_group: string;
    tier_level: number;
    enabled: boolean;
    is_default: boolean;
    newapi_channel_ids: number[];
    created_at: string;
    updated_at: string;
}

interface GroupFormData {
    key: string;
    display_name: string;
    newapi_group: string;
    description: string;
    tier_level: string;
    enabled: boolean;
    is_default: boolean;
    newapi_channel_ids: string;
}

// ── i18n ──

function getTexts(locale: Locale) {
    return locale === 'en'
        ? {
              sessionExpired: 'Your session has expired. Please sign in again.',
              title: 'Channel Groups',
              subtitle: 'Pool / official tiers — customers pick a tier when creating keys; new-api routes by group',
              refresh: 'Refresh',
              loading: 'Loading...',
              newGroup: '+ New Tier',
              editGroup: 'Edit Tier',
              noGroups: 'No channel groups found',
              noGroupsHint: 'Click "+ New Tier" to register a customer-selectable tier.',
              colKey: 'Tier key',
              colName: 'Display Name',
              colNewapiGroup: 'new-api group',
              colTierLevel: 'Sort',
              colDefault: 'Default',
              colEnabled: 'Enabled',
              colChannels: 'Registered channels',
              colActions: 'Actions',
              edit: 'Edit',
              delete: 'Delete',
              deleteConfirm: (key: string) =>
                  `Delete the tier "${key}"?\n\nExisting keys are unaffected (their new-api group keeps working), but new keys can no longer select this tier.`,
              fieldKey: 'Tier key',
              fieldKeyHint: 'Lowercase letters / digits / hyphens. Tier identifier — cannot be changed after creation.',
              fieldDisplayName: 'Display Name',
              fieldNewapiGroup: 'new-api group',
              newapiGroupWarning:
                  '⚠️ newapi_group is sent to new keys. It must exist in new-api and may belong to only one enabled Portal tier.',
              fieldDescription: 'Description',
              fieldDescriptionHint: 'Optional.',
              fieldTierLevel: 'Sort Order',
              fieldTierLevelHint: 'Lower numbers list first.',
              fieldEnabled: 'Enabled',
              fieldIsDefault: 'Default tier',
              fieldIsDefaultHint: 'New keys default to this tier (only one tier can be the default).',
              fieldChannels: 'Registered channel ids',
              fieldChannelsHint:
                  'Comma-separated new-api channel ids (e.g. 3, 5). At least one unique channel is required before enabling the tier.',
              cancel: 'Cancel',
              save: 'Save',
              saving: 'Saving...',
              loadFailed: 'Failed to load channel groups',
              saveFailed: 'Failed to save channel group',
              deleteFailed: 'Failed to delete channel group',
              yes: 'Yes',
              none: '—',
          }
        : {
              sessionExpired: '登录已过期,请重新登录',
              title: '渠道分组',
              subtitle: '动态档次配置 — 客户建 key 选档,new-api 按 group 路由',
              refresh: '刷新',
              loading: '加载中...',
              newGroup: '+ 新建档次',
              editGroup: '编辑档次',
              noGroups: '暂无渠道分组',
              noGroupsHint: '点击「+ 新建档次」注册一个客户可选的档次。',
              colKey: '档次 key',
              colName: '显示名',
              colNewapiGroup: 'new-api group',
              colTierLevel: '排序',
              colDefault: '默认',
              colEnabled: '启用',
              colChannels: '登记渠道',
              colActions: '操作',
              edit: '编辑',
              delete: '删除',
              deleteConfirm: (key: string) =>
                  `确定要删除档次「${key}」吗？\n\n已建 key 不受影响(其 new-api group 照常工作),但新建 key 不能再选该档。`,
              fieldKey: '档次 key',
              fieldKeyHint: '小写字母 / 数字 / 连字符。档次标识,创建后不可修改。',
              fieldDisplayName: '显示名',
              fieldNewapiGroup: 'new-api group',
              newapiGroupWarning:
                  '⚠️ newapi_group 会下发给本档新建 Key。它必须已存在于 new-api，且只能归属于一个启用的 Portal 档次。',
              fieldDescription: '描述',
              fieldDescriptionHint: '可选。',
              fieldTierLevel: '排序',
              fieldTierLevelHint: '数字越小越靠前。',
              fieldEnabled: '启用',
              fieldIsDefault: '默认档次',
              fieldIsDefaultHint: '新建 key 默认选这一档(只能有一个档次为默认)。',
              fieldChannels: '登记渠道 id',
              fieldChannelsHint: '逗号分隔的 new-api 渠道 id(如 3, 5)。启用档次前至少登记一个唯一渠道。',
              cancel: '取消',
              save: '保存',
              saving: '保存中...',
              loadFailed: '加载渠道分组失败',
              saveFailed: '保存渠道分组失败',
              deleteFailed: '删除渠道分组失败',
              yes: '是',
              none: '—',
          };
}

// ── Helpers ──

/** Parse comma-separated ints, dropping blanks / NaN. e.g. "3, 5, x" → [3, 5]. */
function parseChannelIds(raw: string): number[] {
    return raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isFinite(n));
}

const emptyForm: GroupFormData = {
    key: '',
    display_name: '',
    newapi_group: '',
    description: '',
    tier_level: '0',
    enabled: false,
    is_default: false,
    newapi_channel_ids: '',
};

// ── Main Content ──

function ChannelGroupsContent() {
    const searchParams = useSearchParams();
    const theme = searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    const uiMode = searchParams.get('ui_mode') || 'standalone';
    const locale = resolveLocale(searchParams.get('lang'));
    const isDark = theme === 'dark';
    const isEmbedded = uiMode === 'embedded';
    const t = getTexts(locale);

    const [groups, setGroups] = useState<ChannelGroup[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    // Edit / create modal state
    const [editModalOpen, setEditModalOpen] = useState(false);
    const [editingGroup, setEditingGroup] = useState<ChannelGroup | null>(null);
    const [form, setForm] = useState<GroupFormData>(emptyForm);
    const [saving, setSaving] = useState(false);

    // ── Fetch groups ──

    const fetchGroups = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const res = await fetch('/api/admin/channel-groups');
            if (!res.ok) {
                if (res.status === 401) {
                    setError(t.sessionExpired);
                    return;
                }
                const data = await res.json().catch(() => ({}));
                setError(data.error || t.loadFailed);
                return;
            }
            const data = await res.json();
            setGroups(data.groups ?? []);
        } catch {
            setError(t.loadFailed);
        } finally {
            setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        fetchGroups();
    }, [fetchGroups]);

    // ── Modal handlers ──

    const openCreateModal = () => {
        setEditingGroup(null);
        setForm(emptyForm);
        setEditModalOpen(true);
    };

    const openEditModal = (group: ChannelGroup) => {
        setEditingGroup(group);
        setForm({
            key: group.key,
            display_name: group.display_name,
            newapi_group: group.newapi_group,
            description: group.description ?? '',
            tier_level: String(group.tier_level),
            enabled: group.enabled,
            is_default: group.is_default,
            newapi_channel_ids: (group.newapi_channel_ids ?? []).join(', '),
        });
        setEditModalOpen(true);
    };

    const closeEditModal = () => {
        setEditModalOpen(false);
        setEditingGroup(null);
    };

    const handleSave = async () => {
        if (!form.display_name.trim() || !form.newapi_group.trim()) return;
        if (!editingGroup && !form.key.trim()) return;

        setSaving(true);
        setError('');

        const desc = form.description.trim();
        const body: Record<string, unknown> = {
            display_name: form.display_name.trim(),
            newapi_group: form.newapi_group.trim(),
            description: desc === '' ? null : desc,
            tier_level: parseInt(form.tier_level, 10) || 0,
            enabled: form.enabled,
            is_default: form.is_default,
            newapi_channel_ids: parseChannelIds(form.newapi_channel_ids),
        };
        // key only on create (not editable on PUT)
        if (!editingGroup) {
            body.key = form.key.trim();
        }

        try {
            const url = editingGroup ? `/api/admin/channel-groups/${editingGroup.id}` : '/api/admin/channel-groups';
            const method = editingGroup ? 'PUT' : 'POST';

            const res = await fetch(url, {
                method,
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                if (res.status === 401) {
                    setError(t.sessionExpired);
                    return;
                }
                const data = await res.json().catch(() => ({}));
                setError(data.error || t.saveFailed);
                return;
            }

            closeEditModal();
            fetchGroups();
        } catch {
            setError(t.saveFailed);
        } finally {
            setSaving(false);
        }
    };

    // ── Delete handler ──

    const handleDelete = async (group: ChannelGroup) => {
        if (!confirm(t.deleteConfirm(group.key))) return;
        setError('');
        try {
            const res = await fetch(`/api/admin/channel-groups/${group.id}`, {
                method: 'DELETE',
                credentials: 'same-origin',
            });
            if (!res.ok) {
                if (res.status === 401) {
                    setError(t.sessionExpired);
                    return;
                }
                const data = await res.json().catch(() => ({}));
                setError(data.error || t.deleteFailed);
                return;
            }
            fetchGroups();
        } catch {
            setError(t.deleteFailed);
        }
    };

    // ── Toggle enabled ──

    const handleToggleEnabled = async (group: ChannelGroup) => {
        setError('');
        try {
            const res = await fetch(`/api/admin/channel-groups/${group.id}`, {
                method: 'PUT',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: !group.enabled }),
            });
            if (!res.ok) {
                if (res.status === 401) {
                    setError(t.sessionExpired);
                    return;
                }
                const data = await res.json().catch(() => ({}));
                setError(data.error || t.saveFailed);
                return;
            }
            setGroups((prev) => prev.map((g) => (g.id === group.id ? { ...g, enabled: !g.enabled } : g)));
        } catch {
            setError(t.saveFailed);
        }
    };

    // ── Shared styles ──

    const btnBase = [
        'inline-flex items-center rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
        isDark
            ? 'border-slate-600 text-slate-200 hover:bg-slate-800'
            : 'border-slate-300 text-slate-700 hover:bg-slate-100',
    ].join(' ');

    const inputCls = [
        'w-full rounded-lg border px-3 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500/50',
        isDark
            ? 'border-slate-600 bg-slate-700 text-slate-100 placeholder-slate-400'
            : 'border-slate-300 bg-white text-slate-900 placeholder-slate-400',
    ].join(' ');

    const readonlyInputCls = [
        'w-full rounded-lg border px-3 py-2 text-sm cursor-not-allowed font-mono',
        isDark ? 'border-slate-700 bg-slate-800 text-slate-400' : 'border-slate-200 bg-slate-100 text-slate-500',
    ].join(' ');

    const labelCls = ['block text-sm font-medium mb-1', isDark ? 'text-slate-300' : 'text-slate-700'].join(' ');

    // ── Render ──

    return (
        <PayPageLayout
            isDark={isDark}
            isEmbedded={isEmbedded}
            maxWidth="full"
            title={t.title}
            subtitle={t.subtitle}
            locale={locale}
            actions={
                <button type="button" onClick={fetchGroups} className={btnBase}>
                    {t.refresh}
                </button>
            }
        >
            {/* Error banner */}
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

            {/* Action buttons */}
            <div className="mb-4 flex flex-wrap gap-2 justify-end">
                <button
                    type="button"
                    onClick={openCreateModal}
                    className="inline-flex items-center rounded-lg border border-emerald-500 bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-600"
                >
                    {t.newGroup}
                </button>
            </div>

            {/* Group table */}
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
                ) : groups.length === 0 ? (
                    <div className={`py-12 text-center ${isDark ? 'text-slate-400' : 'text-gray-500'}`}>
                        <p className="text-base font-medium">{t.noGroups}</p>
                        <p className="mt-1 text-sm opacity-70">{t.noGroupsHint}</p>
                    </div>
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
                                <th className="px-4 py-3 text-left font-medium">{t.colKey}</th>
                                <th className="px-4 py-3 text-left font-medium">{t.colName}</th>
                                <th className="px-4 py-3 text-left font-medium">{t.colNewapiGroup}</th>
                                <th className="px-4 py-3 text-center font-medium">{t.colTierLevel}</th>
                                <th className="px-4 py-3 text-center font-medium">{t.colDefault}</th>
                                <th className="px-4 py-3 text-center font-medium">{t.colEnabled}</th>
                                <th className="px-4 py-3 text-left font-medium">{t.colChannels}</th>
                                <th className="px-4 py-3 text-right font-medium">{t.colActions}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {groups.map((group) => {
                                const channels =
                                    group.newapi_channel_ids && group.newapi_channel_ids.length > 0
                                        ? group.newapi_channel_ids.join(', ')
                                        : t.none;
                                return (
                                    <tr
                                        key={group.id}
                                        className={[
                                            'border-b transition-colors',
                                            isDark
                                                ? 'border-slate-700/50 hover:bg-slate-700/30'
                                                : 'border-slate-100 hover:bg-slate-50',
                                        ].join(' ')}
                                    >
                                        <td
                                            className={`px-4 py-3 font-mono text-xs ${isDark ? 'text-slate-100' : 'text-slate-900'}`}
                                        >
                                            {group.key}
                                        </td>
                                        <td
                                            className={`px-4 py-3 font-medium ${isDark ? 'text-slate-100' : 'text-slate-900'}`}
                                        >
                                            <div>{group.display_name}</div>
                                            {group.description && (
                                                <div
                                                    className={`text-xs font-normal ${isDark ? 'text-slate-500' : 'text-slate-400'}`}
                                                >
                                                    {group.description}
                                                </div>
                                            )}
                                        </td>
                                        <td
                                            className={`px-4 py-3 font-mono text-xs ${isDark ? 'text-slate-300' : 'text-slate-700'}`}
                                        >
                                            {group.newapi_group}
                                        </td>
                                        <td
                                            className={`px-4 py-3 text-center ${isDark ? 'text-slate-400' : 'text-slate-500'}`}
                                        >
                                            {group.tier_level}
                                        </td>
                                        <td className="px-4 py-3 text-center">
                                            {group.is_default ? (
                                                <span
                                                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${isDark ? 'bg-emerald-500/20 text-emerald-300' : 'bg-emerald-50 text-emerald-700'}`}
                                                >
                                                    ✓ {t.yes}
                                                </span>
                                            ) : (
                                                <span className={isDark ? 'text-slate-600' : 'text-slate-300'}>
                                                    {t.none}
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-center">
                                            <button
                                                type="button"
                                                onClick={() => handleToggleEnabled(group)}
                                                className={[
                                                    'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
                                                    group.enabled
                                                        ? 'bg-emerald-500'
                                                        : isDark
                                                          ? 'bg-slate-600'
                                                          : 'bg-slate-300',
                                                ].join(' ')}
                                                aria-pressed={group.enabled}
                                            >
                                                <span
                                                    className={[
                                                        'inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform',
                                                        group.enabled ? 'translate-x-4.5' : 'translate-x-0.5',
                                                    ].join(' ')}
                                                />
                                            </button>
                                        </td>
                                        <td
                                            className={`px-4 py-3 font-mono text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}
                                        >
                                            {channels}
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                            <div className="inline-flex gap-1">
                                                <button
                                                    type="button"
                                                    onClick={() => openEditModal(group)}
                                                    className={[
                                                        'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                                                        isDark
                                                            ? 'text-indigo-400 hover:bg-indigo-500/20'
                                                            : 'text-indigo-600 hover:bg-indigo-50',
                                                    ].join(' ')}
                                                >
                                                    {t.edit}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => handleDelete(group)}
                                                    className={[
                                                        'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                                                        isDark
                                                            ? 'text-red-400 hover:bg-red-500/20'
                                                            : 'text-red-600 hover:bg-red-50',
                                                    ].join(' ')}
                                                >
                                                    {t.delete}
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>

            {/* ── Edit / Create Modal ── */}
            {editModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <div
                        className={[
                            'relative w-full max-w-lg overflow-y-auto rounded-2xl border p-6 shadow-2xl',
                            isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-200 bg-white',
                        ].join(' ')}
                        style={{ maxHeight: '90vh' }}
                    >
                        <h2 className={`mb-5 text-lg font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                            {editingGroup ? t.editGroup : t.newGroup}
                        </h2>

                        <div className="space-y-4">
                            {/* Tier key */}
                            <div>
                                <label className={labelCls}>{t.fieldKey}</label>
                                <input
                                    type="text"
                                    value={form.key}
                                    onChange={(e) => setForm({ ...form, key: e.target.value })}
                                    className={editingGroup ? readonlyInputCls : [inputCls, 'font-mono'].join(' ')}
                                    readOnly={!!editingGroup}
                                    placeholder="sale-tier"
                                    required={!editingGroup}
                                />
                                <p className={`mt-1 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                    {t.fieldKeyHint}
                                </p>
                            </div>

                            {/* Display Name */}
                            <div>
                                <label className={labelCls}>{t.fieldDisplayName}</label>
                                <input
                                    type="text"
                                    value={form.display_name}
                                    onChange={(e) => setForm({ ...form, display_name: e.target.value })}
                                    className={inputCls}
                                    placeholder={locale === 'en' ? 'Promotional route' : '特惠线路'}
                                    required
                                />
                            </div>

                            {/* new-api group (with strong warning) */}
                            <div>
                                <label className={labelCls}>{t.fieldNewapiGroup}</label>
                                <input
                                    type="text"
                                    value={form.newapi_group}
                                    onChange={(e) => setForm({ ...form, newapi_group: e.target.value })}
                                    className={[inputCls, 'font-mono'].join(' ')}
                                    placeholder="GPT-特惠反代"
                                    required
                                />
                                <div
                                    className={[
                                        'mt-2 rounded-lg border p-2.5 text-xs leading-relaxed',
                                        isDark
                                            ? 'border-amber-700/60 bg-amber-950/40 text-amber-300'
                                            : 'border-amber-300 bg-amber-50 text-amber-800',
                                    ].join(' ')}
                                >
                                    {t.newapiGroupWarning}
                                </div>
                            </div>

                            {/* Description */}
                            <div>
                                <label className={labelCls}>{t.fieldDescription}</label>
                                <input
                                    type="text"
                                    value={form.description}
                                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                                    className={inputCls}
                                    placeholder={locale === 'en' ? 'Optional' : '可选'}
                                />
                                <p className={`mt-1 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                    {t.fieldDescriptionHint}
                                </p>
                            </div>

                            {/* Tier Level (sort) */}
                            <div>
                                <label className={labelCls}>{t.fieldTierLevel}</label>
                                <input
                                    type="number"
                                    min="0"
                                    value={form.tier_level}
                                    onChange={(e) => setForm({ ...form, tier_level: e.target.value })}
                                    className={inputCls}
                                />
                                <p className={`mt-1 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                    {t.fieldTierLevelHint}
                                </p>
                            </div>

                            {/* Registered channel ids */}
                            <div>
                                <label className={labelCls}>{t.fieldChannels}</label>
                                <input
                                    type="text"
                                    value={form.newapi_channel_ids}
                                    onChange={(e) => setForm({ ...form, newapi_channel_ids: e.target.value })}
                                    className={[inputCls, 'font-mono'].join(' ')}
                                    placeholder="3, 5"
                                />
                                <p className={`mt-1 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                    {t.fieldChannelsHint}
                                </p>
                            </div>

                            {/* Enabled toggle */}
                            <div className="flex items-center gap-3">
                                <button
                                    type="button"
                                    onClick={() => setForm({ ...form, enabled: !form.enabled })}
                                    className={[
                                        'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                                        form.enabled ? 'bg-emerald-500' : isDark ? 'bg-slate-600' : 'bg-slate-300',
                                    ].join(' ')}
                                    aria-pressed={form.enabled}
                                >
                                    <span
                                        className={[
                                            'inline-block h-4 w-4 rounded-full bg-white transition-transform',
                                            form.enabled ? 'translate-x-6' : 'translate-x-1',
                                        ].join(' ')}
                                    />
                                </button>
                                <span className={`text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                                    {t.fieldEnabled}
                                </span>
                            </div>

                            {/* Default tier checkbox */}
                            <div>
                                <label className="flex items-center gap-3">
                                    <input
                                        type="checkbox"
                                        checked={form.is_default}
                                        onChange={(e) => setForm({ ...form, is_default: e.target.checked })}
                                        className="h-4 w-4 rounded border-slate-400 text-emerald-500 focus:ring-emerald-500/50"
                                    />
                                    <span className={`text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                                        {t.fieldIsDefault}
                                    </span>
                                </label>
                                <p className={`mt-1 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                    {t.fieldIsDefaultHint}
                                </p>
                            </div>
                        </div>

                        {/* Actions */}
                        <div className="mt-6 flex justify-end gap-3">
                            <button
                                type="button"
                                onClick={closeEditModal}
                                className={[
                                    'rounded-lg px-4 py-2 text-sm font-medium transition-colors',
                                    isDark ? 'text-slate-400 hover:bg-slate-700' : 'text-slate-600 hover:bg-slate-100',
                                ].join(' ')}
                            >
                                {t.cancel}
                            </button>
                            <button
                                type="button"
                                onClick={handleSave}
                                disabled={
                                    saving ||
                                    !form.display_name.trim() ||
                                    !form.newapi_group.trim() ||
                                    (!editingGroup && !form.key.trim())
                                }
                                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed"
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

function ChannelGroupsPageFallback() {
    const searchParams = useSearchParams();
    const locale = resolveLocale(searchParams.get('lang'));

    return (
        <div className="flex min-h-screen items-center justify-center">
            <div className="text-slate-500">{locale === 'en' ? 'Loading...' : '加载中...'}</div>
        </div>
    );
}

export default function ChannelGroupsPage() {
    return (
        <Suspense fallback={<ChannelGroupsPageFallback />}>
            <ChannelGroupsContent />
        </Suspense>
    );
}
