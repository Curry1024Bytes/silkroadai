'use client';
/**
 * 后台客户详情「专属倍率」面板(2026-10-25,PR-2 写路径)。
 * 读 GET /api/admin/customers/[id]/special-ratios,整体 PUT 保存;展示 new-api 现值与漂移。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

interface Available {
    newapi_group: string;
    display_name: string;
    listRatio: number | null;
}
interface State {
    newapiUsername: string | null;
    mirroredGroup: string | null;
    liveGroup: string | null;
    overrides: Array<{ newapi_group: string; ratio: number; note: string | null; updated_at: string }>;
    liveMatrix: Record<string, number>;
    drift: boolean;
    driftDetail: string[];
    availableGroups: Available[];
}
interface SaveResult {
    userGroup: string;
    tokensPinned?: number;
    verifiedOk: boolean | null;
    verified: Record<string, number> | null;
}

export interface SpecialRatioPanelProps {
    customerId: string;
    isDark: boolean;
    card: string;
    sectionTitle: string;
    muted: string;
}

type Draft = Record<string, { ratio: string; note: string }>;

export function SpecialRatioPanel({ customerId, isDark, card, sectionTitle, muted }: SpecialRatioPanelProps) {
    const [state, setState] = useState<State | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [draft, setDraft] = useState<Draft>({});
    const [adding, setAdding] = useState('');
    const [saving, setSaving] = useState(false);
    const [saveMsg, setSaveMsg] = useState('');
    const [saveErr, setSaveErr] = useState('');

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const res = await fetch(`/api/admin/customers/${customerId}/special-ratios`);
            if (!res.ok) throw new Error(String(res.status));
            const s = (await res.json()) as State;
            setState(s);
            const d: Draft = {};
            for (const o of s.overrides) d[o.newapi_group] = { ratio: String(o.ratio), note: o.note ?? '' };
            setDraft(d);
        } catch {
            setError('专属倍率状态读取失败(new-api 可能不可达)');
        } finally {
            setLoading(false);
        }
    }, [customerId]);
    useEffect(() => {
        void load();
    }, [load]);

    const labelOf = useMemo(() => {
        const m = new Map<string, Available>();
        for (const g of state?.availableGroups ?? []) m.set(g.newapi_group, g);
        return (g: string) => m.get(g);
    }, [state]);

    const addable = (state?.availableGroups ?? []).filter((g) => !(g.newapi_group in draft));

    async function save() {
        if (saving) return;
        setSaveMsg('');
        setSaveErr('');
        const overrides: Array<{ newapi_group: string; ratio: number; note: string | null }> = [];
        for (const [g, v] of Object.entries(draft)) {
            const r = Number(v.ratio);
            if (!Number.isFinite(r) || r <= 0 || r > 100) {
                setSaveErr(`${labelOf(g)?.display_name ?? g} 的倍率要在 0 到 100 之间`);
                return;
            }
            overrides.push({ newapi_group: g, ratio: Math.round(r * 10000) / 10000, note: v.note.trim() || null });
        }
        setSaving(true);
        try {
            const res = await fetch(`/api/admin/customers/${customerId}/special-ratios`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ overrides }),
            });
            const data = (await res.json().catch(() => ({}))) as {
                error?: string;
                message?: string;
                result?: SaveResult;
                state?: State;
            };
            if (!res.ok) {
                setSaveErr(data.message || data.error || `保存失败 (${res.status})`);
                return;
            }
            if (data.state) {
                setState(data.state);
                const d: Draft = {};
                for (const o of data.state.overrides)
                    d[o.newapi_group] = { ratio: String(o.ratio), note: o.note ?? '' };
                setDraft(d);
            }
            const r = data.result;
            const pinned = r?.tokensPinned ? `;${r.tokensPinned} 把未指定档次的 key 已钉成 default` : '';
            if (r?.verifiedOk === true) setSaveMsg(`已生效:用户分组 ${r.userGroup},以客户身份回读倍率一致${pinned}`);
            else if (r?.verifiedOk === false)
                setSaveErr(
                    `已写入,但以客户身份回读的倍率不一致:${JSON.stringify(r.verified)}。请到 new-api 后台核对矩阵`,
                );
            else setSaveMsg(`已写入:用户分组 ${r?.userGroup ?? ''}(未能回读验证,客户无访问令牌)${pinned}`);
        } catch (err) {
            setSaveErr(err instanceof Error ? err.message : '网络错误');
        } finally {
            setSaving(false);
        }
    }

    const inputCls = [
        'rounded-md border px-2 py-1 text-sm',
        isDark ? 'border-slate-600 bg-slate-900 text-slate-100' : 'border-slate-300 bg-white text-slate-900',
    ].join(' ');
    const btnPrimary =
        'rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50';
    const btnGhost = [
        'rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50',
        isDark
            ? 'border-slate-600 text-slate-300 hover:bg-slate-800'
            : 'border-slate-300 text-slate-700 hover:bg-slate-100',
    ].join(' ');

    return (
        <div data-testid="special-ratio-panel">
            <div className={sectionTitle}>专属倍率</div>
            <div className={`mb-2 text-xs ${muted}`}>
                给该客户单独设某几档的倍率(new-api 用户分组 × 令牌分组
                覆盖矩阵)。保存后立即生效并以客户身份回读验证;客户在 /keys、定价页、模型广场看到的即此处的值。留空保存 =
                取消全部专属价。
            </div>
            <div className={`rounded-xl border p-4 ${card}`}>
                {loading ? (
                    <div className={`text-sm ${muted}`}>读取中…</div>
                ) : error ? (
                    <div className={`text-sm ${isDark ? 'text-red-400' : 'text-red-600'}`}>{error}</div>
                ) : state ? (
                    <>
                        <div className={`mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs ${muted}`}>
                            <span>new-api 用户:{state.newapiUsername ?? '—'}</span>
                            <span>当前用户分组:{state.liveGroup ?? '读不到'}</span>
                            {state.mirroredGroup && state.mirroredGroup !== state.liveGroup && (
                                <span>portal 记录分组:{state.mirroredGroup}</span>
                            )}
                        </div>
                        {state.drift && (
                            <div
                                role="status"
                                className={[
                                    'mb-3 rounded-lg border p-3 text-xs',
                                    isDark
                                        ? 'border-amber-700/60 bg-amber-950/30 text-amber-200'
                                        : 'border-amber-300 bg-amber-50 text-amber-800',
                                ].join(' ')}
                            >
                                <div className="font-medium">portal 记录与 new-api 现值不一致</div>
                                <ul className="mt-1 list-disc pl-4">
                                    {state.driftDetail.map((d) => (
                                        <li key={d}>{d}</li>
                                    ))}
                                </ul>
                                <div className="mt-1">点「保存」会以下面的表格为准覆盖 new-api。</div>
                            </div>
                        )}
                        <table className="w-full text-sm">
                            <thead>
                                <tr className={`text-left text-xs ${muted}`}>
                                    <th className="py-1 pr-3 font-medium">档次(令牌分组)</th>
                                    <th className="py-1 pr-3 font-medium">挂牌倍率</th>
                                    <th className="py-1 pr-3 font-medium">专属倍率</th>
                                    <th className="py-1 pr-3 font-medium">备注</th>
                                    <th className="py-1 font-medium"></th>
                                </tr>
                            </thead>
                            <tbody>
                                {Object.keys(draft).length === 0 && (
                                    <tr>
                                        <td colSpan={5} className={`py-2 text-xs ${muted}`}>
                                            尚未设置专属倍率(按挂牌价计费)
                                        </td>
                                    </tr>
                                )}
                                {Object.entries(draft).map(([g, v]) => {
                                    const meta = labelOf(g);
                                    return (
                                        <tr
                                            key={g}
                                            className={
                                                isDark ? 'border-t border-slate-700' : 'border-t border-slate-100'
                                            }
                                        >
                                            <td className="py-1.5 pr-3">
                                                <div>{meta?.display_name ?? g}</div>
                                                <div className={`text-xs ${muted}`}>{g}</div>
                                            </td>
                                            <td className={`py-1.5 pr-3 tabular-nums ${muted}`}>
                                                {meta?.listRatio ?? '—'}x
                                            </td>
                                            <td className="py-1.5 pr-3">
                                                <input
                                                    type="text"
                                                    inputMode="decimal"
                                                    aria-label={`${g} 专属倍率`}
                                                    value={v.ratio}
                                                    onChange={(e) =>
                                                        setDraft((p) => ({
                                                            ...p,
                                                            [g]: { ...p[g], ratio: e.target.value },
                                                        }))
                                                    }
                                                    className={`${inputCls} w-24 tabular-nums`}
                                                    disabled={saving}
                                                />
                                            </td>
                                            <td className="py-1.5 pr-3">
                                                <input
                                                    type="text"
                                                    aria-label={`${g} 备注`}
                                                    value={v.note}
                                                    placeholder="例如:2026-10 大客户协议价"
                                                    onChange={(e) =>
                                                        setDraft((p) => ({
                                                            ...p,
                                                            [g]: { ...p[g], note: e.target.value },
                                                        }))
                                                    }
                                                    className={`${inputCls} w-56`}
                                                    disabled={saving}
                                                />
                                            </td>
                                            <td className="py-1.5 text-right">
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        setDraft((p) => {
                                                            const n = { ...p };
                                                            delete n[g];
                                                            return n;
                                                        })
                                                    }
                                                    disabled={saving}
                                                    className={`text-xs ${isDark ? 'text-red-400' : 'text-red-600'} hover:underline disabled:opacity-50`}
                                                >
                                                    移除
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                            <select
                                aria-label="添加档次"
                                value={adding}
                                onChange={(e) => setAdding(e.target.value)}
                                className={inputCls}
                                disabled={saving || addable.length === 0}
                            >
                                <option value="">{addable.length === 0 ? '所有档次已添加' : '添加档次…'}</option>
                                {addable.map((g) => (
                                    <option key={g.newapi_group} value={g.newapi_group}>
                                        {g.display_name}({g.newapi_group},挂牌 {g.listRatio ?? '—'}x)
                                    </option>
                                ))}
                            </select>
                            <button
                                type="button"
                                className={btnGhost}
                                disabled={!adding || saving}
                                onClick={() => {
                                    if (!adding) return;
                                    const meta = labelOf(adding);
                                    setDraft((p) => ({
                                        ...p,
                                        [adding]: {
                                            ratio: meta?.listRatio != null ? String(meta.listRatio) : '',
                                            note: '',
                                        },
                                    }));
                                    setAdding('');
                                }}
                            >
                                添加
                            </button>
                            <button type="button" className={btnPrimary} onClick={() => void save()} disabled={saving}>
                                {saving ? '保存中…' : '保存并生效'}
                            </button>
                            <button type="button" className={btnGhost} onClick={() => void load()} disabled={saving}>
                                重新读取
                            </button>
                        </div>
                        {saveErr && (
                            <div className={`mt-3 text-sm ${isDark ? 'text-red-400' : 'text-red-600'}`}>{saveErr}</div>
                        )}
                        {saveMsg && (
                            <div className={`mt-3 text-sm ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                                {saveMsg}
                            </div>
                        )}
                    </>
                ) : null}
            </div>
        </div>
    );
}
