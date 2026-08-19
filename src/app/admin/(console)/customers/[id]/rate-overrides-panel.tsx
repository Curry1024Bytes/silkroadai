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
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
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
            const data = (await response.json()) as { tiers: RateTier[]; overrides: RateOverride[] };
            setTiers(data.tiers);
            setOverrides(data.overrides);
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

    const card = isDark ? 'border-slate-700 bg-slate-800/70' : 'border-slate-200 bg-white shadow-sm';
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';
    const value = isDark ? 'text-slate-100' : 'text-slate-900';
    const input = isDark ? 'border-slate-600 bg-slate-900 text-slate-100' : 'border-slate-300 bg-white text-slate-900';

    return (
        <div>
            <div className={`mb-2 text-sm font-semibold ${value}`}>{zh ? '专属计费设置' : 'Dedicated billing'}</div>
            <div className={`mb-2 text-xs ${muted}`}>
                {zh
                    ? '仅调整该客户的有效倍率；公共档次和 API Key 的计费分组保持不变。'
                    : 'Adjusts this customer only; public tiers and API key billing groups stay unchanged.'}
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
                                    disabled={saving}
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
                                    disabled={saving}
                                />
                            </label>
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    onClick={save}
                                    disabled={saving}
                                    className="h-10 rounded-lg bg-indigo-600 px-3 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                                >
                                    {saving ? (zh ? '同步中...' : 'Syncing...') : zh ? '保存并同步' : 'Save & sync'}
                                </button>
                                {activeOverride && (
                                    <button
                                        type="button"
                                        onClick={remove}
                                        disabled={saving}
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
