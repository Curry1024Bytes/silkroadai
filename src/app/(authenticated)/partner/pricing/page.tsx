'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMessages } from '@/lib/i18n/client';
import { partnerMessages } from '@/lib/i18n/messages/partner';

interface PriceRow {
    group_key: string;
    display_name: string;
    available: boolean;
    wholesale_ratio: number;
    retail_ratio: number | null;
}

interface RetailChange {
    group_key: string;
    retail_ratio: number | null;
}

function draftValue(text: string | undefined): number | null {
    const trimmed = (text ?? '').trim();
    return trimmed === '' ? null : Number(trimmed);
}

/** 每 ¥100 客户消费中代理的利润 = 100 × (1 − 拿货价 ÷ 零售率)。 */
function profitPer100(wholesale: number, retail: number | null): string {
    if (retail == null || !Number.isFinite(retail) || retail <= 0) return '—';
    return `¥${(100 * (1 - wholesale / retail)).toFixed(2)}`;
}

export default function PartnerPricingPage() {
    const m = useMessages(partnerMessages);
    const [rows, setRows] = useState<PriceRow[]>([]);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');

    const apply = (prices: PriceRow[]) => {
        setRows(prices);
        setDrafts(Object.fromEntries(prices.map((p) => [p.group_key, p.retail_ratio == null ? '' : String(p.retail_ratio)])));
    };

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const res = await fetch('/api/partner/pricing');
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(data.message || data.error || m.common.loadFailed);
                return;
            }
            apply(data.prices ?? []);
        } catch {
            setError(m.common.loadFailed);
        } finally {
            setLoading(false);
        }
    }, [m.common.loadFailed]);

    useEffect(() => {
        void load();
    }, [load]);

    const changes = useMemo<RetailChange[]>(
        () =>
            rows.flatMap((row) => {
                const value = draftValue(drafts[row.group_key]);
                return value === row.retail_ratio ? [] : [{ group_key: row.group_key, retail_ratio: value }];
            }),
        [rows, drafts],
    );

    const validationError = useMemo(() => {
        for (const change of changes) {
            if (change.retail_ratio === null) continue;
            if (!Number.isFinite(change.retail_ratio) || change.retail_ratio <= 0) return m.pricing.invalidNumber;
            const row = rows.find((item) => item.group_key === change.group_key);
            if (row && change.retail_ratio < row.wholesale_ratio)
                return m.pricing.belowWholesale(row.display_name, row.wholesale_ratio);
        }
        return '';
    }, [changes, rows, m.pricing]);

    const closing = changes.filter((change) => change.retail_ratio === null);

    const handleSave = async () => {
        if (!changes.length || validationError) return;
        if (closing.length && !window.confirm(m.pricing.confirmClose)) return;
        setSaving(true);
        setError('');
        setNotice('');
        try {
            const res = await fetch('/api/partner/pricing', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prices: changes }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(data.message || data.error || m.common.saveFailed);
                return;
            }
            apply(data.prices ?? []);
            setNotice(m.pricing.saved);
        } catch {
            setError(m.common.saveFailed);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="mx-auto max-w-4xl space-y-6 p-6">
            <div>
                <h1 className="text-2xl font-bold text-portal-ink">{m.pricing.title}</h1>
                <p className="mt-1 text-sm text-portal-muted">{m.pricing.intro}</p>
            </div>

            {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
                    {error}
                    <button onClick={() => setError('')} className="ml-2 opacity-60 hover:opacity-100">
                        ✕
                    </button>
                </div>
            )}
            {notice && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</div>
            )}

            {loading ? (
                <p className="text-sm text-portal-muted">{m.common.loading}</p>
            ) : rows.length === 0 ? (
                <div className="rounded-xl border border-portal-line bg-portal-panel p-8 text-center text-sm text-portal-muted">
                    {m.pricing.noGroups}
                </div>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-portal-line">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-portal-line text-portal-muted">
                                <th className="px-4 py-3 text-left font-medium">{m.pricing.group}</th>
                                <th className="px-4 py-3 text-right font-medium">{m.pricing.wholesale}</th>
                                <th className="px-4 py-3 text-right font-medium">{m.pricing.retail}</th>
                                <th className="px-4 py-3 text-right font-medium">{m.pricing.profitPer100}</th>
                                <th className="px-4 py-3 text-right font-medium">{m.pricing.status}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row) => {
                                const draft = draftValue(drafts[row.group_key]);
                                return (
                                    <tr key={row.group_key} className="border-b border-portal-line/50 last:border-0">
                                        <td className="px-4 py-3 text-portal-ink">
                                            {row.display_name}
                                            <span className="ml-2 font-mono text-xs text-portal-subtle">{row.group_key}</span>
                                        </td>
                                        <td className="px-4 py-3 text-right font-mono text-portal-ink">{row.wholesale_ratio}</td>
                                        <td className="px-4 py-3 text-right">
                                            <input
                                                type="number"
                                                min={row.wholesale_ratio}
                                                step="any"
                                                disabled={!row.available}
                                                value={drafts[row.group_key] ?? ''}
                                                onChange={(e) => setDrafts({ ...drafts, [row.group_key]: e.target.value })}
                                                placeholder={m.pricing.placeholder}
                                                className="w-32 rounded-lg border border-portal-line bg-portal-canvas px-3 py-1.5 text-right font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand-accent/30 disabled:opacity-50"
                                            />
                                        </td>
                                        <td className="px-4 py-3 text-right font-mono text-portal-ink">
                                            {profitPer100(row.wholesale_ratio, draft)}
                                        </td>
                                        <td className="px-4 py-3 text-right text-xs">
                                            {!row.available ? (
                                                <span className="text-portal-subtle">{m.pricing.disabled}</span>
                                            ) : row.retail_ratio == null ? (
                                                <span className="text-amber-600">{m.pricing.closed}</span>
                                            ) : (
                                                <span className="text-emerald-600">{m.pricing.open}</span>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {rows.length > 0 && (
                <div className="flex items-center justify-end gap-3">
                    {validationError && <span className="text-xs text-red-600">{validationError}</span>}
                    <button
                        onClick={handleSave}
                        disabled={saving || !changes.length || Boolean(validationError)}
                        className="rounded-lg bg-brand-accent px-4 py-2 text-sm font-medium text-white hover:bg-brand-accent-strong disabled:opacity-50"
                    >
                        {saving ? m.common.saving : changes.length ? m.pricing.saveCount(changes.length) : m.common.save}
                    </button>
                </div>
            )}

            <div className="space-y-1 rounded-xl border border-portal-line bg-portal-soft p-4 text-xs text-portal-muted">
                <p>{m.pricing.rules1}</p>
                <p>{m.pricing.rules2}</p>
                <p>{m.pricing.rules3}</p>
            </div>
        </div>
    );
}
