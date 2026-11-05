'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FactorSource } from '@/lib/pricing-rules/compile';
import type { BoardRule, CustomerSaleRules, PresentedImpact } from '@/lib/pricing-rules/board';
import {
    buttonCls,
    callApi,
    ChangeTable,
    discountToPercent,
    errorText,
    formatTime,
    ImpactView,
    KIND_LABEL,
    Notice,
    publishMessage,
    ratioText,
    RuleForm,
    STATE_LABEL,
    type ConfirmInput,
    type RuleDraft,
    type SaveResponse,
} from '@/components/admin/sale-rules-ui';

interface CheckResult {
    held: boolean;
    diagnostics: Array<{ level: string; message: string; newapiGroup?: string }>;
    changes: Array<{
        newapiGroup: string;
        userId: string | null;
        before: number | null;
        after: number | null;
        increase: boolean;
    }>;
}

function sourceLabel(source: FactorSource | null): string {
    if (!source || !source.kind) return '统一售卖价';
    return `${KIND_LABEL[source.kind] ?? source.kind} ${discountToPercent(source.factor)}%`;
}

/** Customer discounts (spec §5): this customer's sale rules on managed billing groups. */
export function SaleRulesPanel({ customerId, isDark }: { customerId: string; isDark: boolean }) {
    const api = `/api/admin/customers/${customerId}/sale-rules`;
    const [data, setData] = useState<CustomerSaleRules | null>(null);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const [editing, setEditing] = useState<BoardRule | 'new' | null>(null);
    const [pending, setPending] = useState<{ change: Record<string, unknown>; impact: PresentedImpact } | null>(null);
    const [checked, setChecked] = useState<CheckResult | null>(null);
    const card = isDark ? 'border-slate-700 bg-slate-800/70' : 'border-slate-200 bg-white shadow-sm';
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';

    const load = useCallback(async () => {
        try {
            setData(await callApi<CustomerSaleRules>(api));
        } catch (caught) {
            setError(errorText(caught));
        }
    }, [api]);
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
        void load();
    }, [load]);

    const run = async (work: () => Promise<void>) => {
        setBusy(true);
        setError('');
        setNotice('');
        try {
            await work();
        } catch (caught) {
            setError(errorText(caught));
        } finally {
            setBusy(false);
        }
    };
    const preview = (change: Record<string, unknown>) =>
        run(async () => {
            const result = await callApi<SaveResponse>(api, {
                action: 'save_rule',
                change,
                confirmation: { dry_run: true },
            });
            setPending({ change, impact: result.impact });
        });
    const draftChange = (draft: RuleDraft) =>
        editing && editing !== 'new'
            ? { op: 'update', id: editing.id, expected_updated_at: editing.updated_at, draft }
            : { op: 'create', draft };
    const apply = (confirm: ConfirmInput) =>
        run(async () => {
            if (!pending) return;
            const result = await callApi<SaveResponse>(api, {
                action: 'save_rule',
                change: pending.change,
                confirmation: { dry_run: false, ...confirm },
            });
            setPending(null);
            setEditing(null);
            setNotice(publishMessage(result));
            await load();
        });
    const check = () => run(async () => setChecked(await callApi<CheckResult>(api, { action: 'check' })));
    if (!data)
        return (
            <div className={`rounded-xl border p-4 text-sm ${card}`}>
                {error ? <p className="text-red-600">{error}</p> : <p className={muted}>加载中…</p>}
            </div>
        );
    const managed = data.tiers.filter((tier) => tier.managed);
    return (
        <div>
            <div className="mb-2 text-sm font-semibold">售卖折扣</div>
            <p className={`mb-2 text-xs ${muted}`}>
                按统一售卖价的百分比收费，只作用于已纳管的计费分组。同一请求只取一条：客户指定模型 → 全局 → 客户整档 →
                统一售卖价。
            </p>
            <div className={`space-y-3 rounded-xl border p-4 text-sm ${card}`}>
                {error && <p className="text-red-600">{error}</p>}
                {notice && <p className="text-emerald-600">{notice}</p>}
                {!data.customer.newapi_group && (
                    <Notice tone="amber" isDark={isDark} items={['无法读取该客户的 new-api 分组，实际倍率未知。']} />
                )}
                <Notice
                    tone="red"
                    isDark={isDark}
                    items={data.diagnostics.filter((item) => item.level === 'block').map((item) => item.message)}
                />
                <Notice
                    tone="amber"
                    isDark={isDark}
                    items={data.diagnostics.filter((item) => item.level === 'warn').map((item) => item.message)}
                />
                {managed.length === 0 ? (
                    <p className={muted}>该客户所属主体还没有纳管的计费分组，请先在定价页的「售卖规则」中纳管。</p>
                ) : (
                    <table className="w-full text-left text-sm">
                        <thead className={`text-xs ${muted}`}>
                            <tr>
                                <th className="py-1 pr-3">档次</th>
                                <th className="py-1 pr-3">分组倍率</th>
                                <th className="py-1 pr-3">当前实际倍率</th>
                                <th className="py-1 pr-3">发布后</th>
                                <th className="py-1 pr-3">命中规则</th>
                            </tr>
                        </thead>
                        <tbody>
                            {managed.map((tier) => (
                                <tr
                                    key={tier.key}
                                    className={isDark ? 'border-t border-slate-700' : 'border-t border-slate-100'}
                                >
                                    <td className="py-2 pr-3">{tier.display_name}</td>
                                    <td className="py-2 pr-3">{ratioText(tier.group_ratio)}</td>
                                    <td className="py-2 pr-3">{ratioText(tier.effective_ratio)}</td>
                                    <td className="py-2 pr-3">{ratioText(tier.compiled_ratio)}</td>
                                    <td className="py-2 pr-3 text-xs">
                                        {sourceLabel(tier.source)}
                                        {tier.legacy_multiplier !== null && (
                                            <span className="ml-1 text-amber-600">
                                                （旧专属倍率 {tier.legacy_multiplier} 仍生效）
                                            </span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                <div className="flex flex-wrap gap-2">
                    <button
                        type="button"
                        disabled={busy || !managed.length}
                        className={buttonCls('primary', isDark)}
                        onClick={() => {
                            setPending(null);
                            setEditing('new');
                        }}
                    >
                        新增折扣
                    </button>
                    <button
                        type="button"
                        disabled={busy}
                        className={buttonCls('plain', isDark)}
                        onClick={() => void check()}
                    >
                        核对账号与 Key
                    </button>
                </div>
                {data.rules.length > 0 && (
                    <ul className="space-y-2">
                        {data.rules.map((rule) => (
                            <li key={rule.id} className="flex flex-wrap items-center gap-2 text-xs">
                                <span>
                                    {KIND_LABEL[rule.kind] ?? rule.kind} · {rule.tier_key}
                                    {rule.model_name ? ` / ${rule.model_name}` : ''} · 按{' '}
                                    {discountToPercent(rule.discount)}% 收费 · {formatTime(rule.effective_from)} 至{' '}
                                    {formatTime(rule.effective_to)} · {STATE_LABEL[rule.state]}
                                </span>
                                <button
                                    type="button"
                                    disabled={busy}
                                    className={buttonCls('plain', isDark)}
                                    onClick={() => {
                                        setPending(null);
                                        setEditing(rule);
                                    }}
                                >
                                    修改
                                </button>
                                <button
                                    type="button"
                                    disabled={busy}
                                    className={buttonCls('plain', isDark)}
                                    onClick={() =>
                                        void preview({
                                            op: 'delete',
                                            id: rule.id,
                                            expected_updated_at: rule.updated_at,
                                        })
                                    }
                                >
                                    删除
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
                {editing && (
                    <RuleForm
                        key={editing === 'new' ? 'new' : editing.id}
                        tiers={managed}
                        models={data.models}
                        customerId={data.customer.id}
                        initial={editing === 'new' ? null : editing}
                        isDark={isDark}
                        busy={busy}
                        onPreview={(draft) => void preview(draftChange(draft))}
                        onCancel={() => {
                            setEditing(null);
                            setPending(null);
                        }}
                    />
                )}
                {pending && (
                    <ImpactView
                        impact={pending.impact}
                        isDark={isDark}
                        busy={busy}
                        onApply={(confirm) => void apply(confirm)}
                        onCancel={() => setPending(null)}
                    />
                )}
                {checked && (
                    <div className="space-y-2">
                        <Notice
                            tone={checked.held ? 'red' : 'amber'}
                            isDark={isDark}
                            items={checked.diagnostics.map((item) => item.message)}
                        />
                        {!checked.held && !checked.diagnostics.length && (
                            <p className="text-xs text-emerald-600">账号与 Key 核对正常。</p>
                        )}
                        {checked.changes.length > 0 && (
                            <ChangeTable
                                changes={checked.changes.map((item) => ({ ...item, customer_email: null }))}
                                isDark={isDark}
                            />
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
