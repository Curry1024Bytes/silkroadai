'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

interface RateTier {
    key: string;
    display_name: string;
    public_multiplier: number | null;
    effective_multiplier: number | null;
}

interface RateOverride {
    id: string;
    tier_key: string;
    multiplier: number;
    synced_at: string | null;
}

interface RateOverridePanelProps {
    customerId: string;
    isDark: boolean;
    locale: 'zh' | 'en';
}

const formatMultiplier = (value: number | null) => (value == null ? '—' : `${value}x`);
const formatDate = (value: string | null) =>
    value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';

export function RateOverridesPanel({ customerId, isDark, locale }: RateOverridePanelProps) {
    const zh = locale !== 'en';
    const [tiers, setTiers] = useState<RateTier[]>([]);
    const [overrides, setOverrides] = useState<RateOverride[]>([]);
    const [selectedTier, setSelectedTier] = useState('');
    const [multiplier, setMultiplier] = useState('');
    const [activeKeyCount, setActiveKeyCount] = useState(0);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [migrating, setMigrating] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');

    const tierByKey = useMemo(() => new Map(tiers.map((tier) => [tier.key, tier])), [tiers]);
    const selected = tierByKey.get(selectedTier);
    const activeOverride = overrides.find((override) => override.tier_key === selectedTier);

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const response = await fetch(`/api/admin/customers/${encodeURIComponent(customerId)}/rate-overrides`, {
                credentials: 'same-origin',
            });
            if (!response.ok) throw new Error();
            const data = (await response.json()) as {
                tiers: RateTier[];
                overrides: RateOverride[];
                active_key_count: number;
            };
            setTiers(data.tiers);
            setOverrides(data.overrides);
            setActiveKeyCount(data.active_key_count);
            setSelectedTier((current) => current || data.tiers[0]?.key || '');
        } catch {
            setError(zh ? '专属倍率读取失败' : 'Failed to load dedicated multipliers');
        } finally {
            setLoading(false);
        }
    }, [customerId, zh]);

    useEffect(() => {
        // This effect synchronizes the panel with the admin API on mount.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void load();
    }, [load]);

    useEffect(() => {
        // Keep the input aligned with the selected tier's persisted override.
        if (!selected) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setMultiplier('');
            return;
        }
        setMultiplier(activeOverride ? String(activeOverride.multiplier) : '');
    }, [activeOverride, selected]);

    const save = async () => {
        const value = Number(multiplier);
        if (!selectedTier || !Number.isFinite(value) || value <= 0 || value > 100) {
            setError(
                zh ? '请输入大于 0 且不超过 100 的倍率' : 'Enter a multiplier greater than 0 and no greater than 100',
            );
            return;
        }
        setSaving(true);
        setError('');
        setNotice('');
        try {
            const response = await fetch(`/api/admin/customers/${encodeURIComponent(customerId)}/rate-overrides`, {
                method: 'PUT',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tier_key: selectedTier, multiplier: value }),
            });
            const data = (await response.json().catch(() => ({}))) as { error?: string };
            if (!response.ok) throw new Error(data.error || 'sync failed');
            setNotice(zh ? '已同步到 new-api' : 'Synced to new-api');
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : zh ? '专属倍率同步失败' : 'Sync failed');
        } finally {
            setSaving(false);
        }
    };

    const remove = async () => {
        if (!activeOverride || !window.confirm(zh ? '取消该客户的专属倍率？' : 'Remove this dedicated multiplier?'))
            return;
        setSaving(true);
        setError('');
        setNotice('');
        try {
            const response = await fetch(
                `/api/admin/customers/${encodeURIComponent(customerId)}/rate-overrides/${encodeURIComponent(activeOverride.id)}`,
                { method: 'DELETE', credentials: 'same-origin' },
            );
            const data = (await response.json().catch(() => ({}))) as { error?: string };
            if (!response.ok) throw new Error(data.error || 'sync failed');
            setNotice(zh ? '已取消专属倍率并恢复公共倍率' : 'Dedicated multiplier removed; public multiplier restored');
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : zh ? '专属倍率取消失败' : 'Remove failed');
        } finally {
            setSaving(false);
        }
    };

    const migrateKeys = async () => {
        if (!activeOverride || !selectedTier || activeKeyCount === 0) return;
        const confirmation = zh
            ? `确认将该客户现有的 ${activeKeyCount} 把活跃 API Key 迁移到“${selected?.display_name ?? selectedTier}”吗？\n\nKey 值不会变化，但请求路由和实际计费将立即按该档次生效。`
            : `Move all ${activeKeyCount} active API keys to “${selected?.display_name ?? selectedTier}”?\n\nKey values will not change, but routing and actual billing will apply this tier immediately.`;
        if (!window.confirm(confirmation)) return;

        setMigrating(true);
        setError('');
        setNotice('');
        try {
            const response = await fetch(
                `/api/admin/customers/${encodeURIComponent(customerId)}/rate-overrides/migrate-keys`,
                {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tier_key: selectedTier }),
                },
            );
            const data = (await response.json().catch(() => ({}))) as {
                error?: string;
                migrated_count?: number;
                already_target_count?: number;
            };
            if (!response.ok) throw new Error(data.error || 'key migration failed');
            setNotice(
                zh
                    ? `已迁移 ${data.migrated_count ?? 0} 把 Key；${data.already_target_count ?? 0} 把原本已在该档次。`
                    : `Migrated ${data.migrated_count ?? 0} key(s); ${data.already_target_count ?? 0} already used this tier.`,
            );
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : zh ? '历史 API Key 迁移失败' : 'Key migration failed');
        } finally {
            setMigrating(false);
        }
    };

    const card = isDark ? 'border-slate-700 bg-slate-800/70' : 'border-slate-200 bg-white shadow-sm';
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';
    const value = isDark ? 'text-slate-100' : 'text-slate-900';
    const input = isDark ? 'border-slate-600 bg-slate-900 text-slate-100' : 'border-slate-300 bg-white text-slate-900';

    return (
        <div>
            <div className={`mb-2 text-sm font-semibold ${value}`}>{zh ? '专属计费设置' : 'Dedicated billing'}</div>
            <div className={`mb-2 text-xs ${muted}`}>
                {zh
                    ? '保存倍率只影响该客户；公共档次保持不变。历史 Key 需在下方单独迁移计费分组。'
                    : 'Saving affects this customer only and keeps public tiers unchanged. Migrate existing keys separately below.'}
            </div>
            <div className={`rounded-xl border p-4 ${card}`}>
                {loading ? (
                    <div className={`text-sm ${muted}`}>{zh ? '加载中...' : 'Loading...'}</div>
                ) : tiers.length === 0 ? (
                    <div className={`text-sm ${muted}`}>
                        {zh ? '暂无可用 Portal 档次。' : 'No enabled Portal tiers.'}
                    </div>
                ) : (
                    <div className="space-y-4">
                        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_10rem_auto] md:items-end">
                            <label className="block">
                                <span className={`mb-1 block text-xs ${muted}`}>
                                    {zh ? 'Portal 档次' : 'Portal tier'}
                                </span>
                                <select
                                    value={selectedTier}
                                    onChange={(event) => setSelectedTier(event.target.value)}
                                    className={`h-10 w-full rounded-lg border px-3 text-sm ${input}`}
                                    disabled={saving || migrating}
                                >
                                    {tiers.map((tier) => (
                                        <option key={tier.key} value={tier.key}>
                                            {tier.display_name}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label className="block">
                                <span className={`mb-1 block text-xs ${muted}`}>
                                    {zh ? '专属倍率' : 'Dedicated rate'}
                                </span>
                                <input
                                    type="number"
                                    min="0.000001"
                                    max="100"
                                    step="0.000001"
                                    value={multiplier}
                                    onChange={(event) => setMultiplier(event.target.value)}
                                    placeholder={
                                        selected?.public_multiplier == null
                                            ? '0.18'
                                            : String(selected.public_multiplier)
                                    }
                                    className={`h-10 w-full rounded-lg border px-3 text-sm ${input}`}
                                    disabled={saving || migrating}
                                />
                            </label>
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    onClick={save}
                                    disabled={saving || migrating}
                                    className="h-10 rounded-lg bg-indigo-600 px-3 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                                >
                                    {saving ? (zh ? '同步中...' : 'Syncing...') : zh ? '保存并同步' : 'Save & sync'}
                                </button>
                                {activeOverride && (
                                    <button
                                        type="button"
                                        onClick={remove}
                                        disabled={saving || migrating}
                                        className={`h-10 rounded-lg border px-3 text-sm font-medium disabled:opacity-50 ${isDark ? 'border-amber-700 text-amber-300 hover:bg-amber-950/40' : 'border-amber-400 text-amber-700 hover:bg-amber-50'}`}
                                    >
                                        {zh ? '取消专属' : 'Remove'}
                                    </button>
                                )}
                            </div>
                        </div>
                        <div className={`grid gap-3 text-sm sm:grid-cols-3 ${muted}`}>
                            <div>
                                <div className="text-xs">{zh ? '公共倍率' : 'Public rate'}</div>
                                <div className={`mt-1 font-medium ${value}`}>
                                    {formatMultiplier(selected?.public_multiplier ?? null)}
                                </div>
                            </div>
                            <div>
                                <div className="text-xs">{zh ? '当前生效倍率' : 'Effective rate'}</div>
                                <div className={`mt-1 font-medium ${value}`}>
                                    {formatMultiplier(selected?.effective_multiplier ?? null)}
                                </div>
                            </div>
                            <div>
                                <div className="text-xs">{zh ? '最后同步' : 'Last sync'}</div>
                                <div className={`mt-1 font-medium ${value}`}>
                                    {formatDate(activeOverride?.synced_at ?? null)}
                                </div>
                            </div>
                        </div>
                        {activeOverride && (
                            <div
                                className={`flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between ${isDark ? 'border-slate-700' : 'border-slate-200'}`}
                            >
                                <div className="min-w-0">
                                    <div className={`text-sm font-medium ${value}`}>
                                        {zh ? '历史 API Key 迁移' : 'Existing API key migration'}
                                    </div>
                                    <div className={`mt-1 text-xs ${muted}`}>
                                        {zh
                                            ? `${activeKeyCount} 把活跃 Key 将改用当前档次的计费分组；Key 值保持不变。`
                                            : `${activeKeyCount} active key(s) will use this tier's billing group; key values stay unchanged.`}
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={migrateKeys}
                                    disabled={saving || migrating || activeKeyCount === 0}
                                    className={`h-10 shrink-0 rounded-lg border px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${isDark ? 'border-cyan-700 text-cyan-300 hover:bg-cyan-950/40' : 'border-cyan-600 text-cyan-700 hover:bg-cyan-50'}`}
                                >
                                    {migrating
                                        ? zh
                                            ? '迁移中...'
                                            : 'Migrating...'
                                        : zh
                                          ? `迁移全部 ${activeKeyCount} 把活跃 Key`
                                          : `Migrate all ${activeKeyCount} active key(s)`}
                                </button>
                            </div>
                        )}
                    </div>
                )}
                {error && <div className={`mt-3 text-sm ${isDark ? 'text-red-400' : 'text-red-600'}`}>{error}</div>}
                {notice && (
                    <div className={`mt-3 text-sm ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>{notice}</div>
                )}
            </div>
        </div>
    );
}
