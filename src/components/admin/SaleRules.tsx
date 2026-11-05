'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
    BoardPublication,
    BoardRule,
    BoardTier,
    PresentedImpact,
    PresentedPlan,
    SaleRuleBoard,
} from '@/lib/pricing-rules/board';
import {
    buttonCls,
    callApi,
    ChangeTable,
    discountToPercent,
    errorText,
    formatTime,
    ImpactView,
    inputCls,
    KIND_LABEL,
    Notice,
    publishMessage,
    ratioText,
    RuleForm,
    STATE_LABEL,
    type ConfirmInput,
    type RuleDraft,
    type SaveResponse,
} from './sale-rules-ui';

const API = '/api/admin/pricing/sale-rules';
const DECIMAL = /^\d{1,4}(\.\d{1,10})?$/;

interface AdoptResponse extends SaveResponse {
    unifiedSaleRatio: string;
    conversion: {
        converted: Array<{ userId: string; discount: string; ratio: number; customer_email: string | null }>;
        kept: Array<{ userId: string; ratio: number; reason: string; customer_email: string | null }>;
    };
}

type Pending =
    | { kind: 'rule'; change: Record<string, unknown>; impact: PresentedImpact }
    | { kind: 'adopt'; tierKey: string; impact: PresentedImpact; result: AdoptResponse }
    | { kind: 'unified'; tierKey: string; ratio: string; impact: PresentedImpact };

const TRIGGER_LABEL: Record<string, string> = {
    manual: '手动发布',
    scheduler: '定时发布',
    rule_save: '保存规则',
    tier_save: '统一售卖价',
    adopt: '纳管',
};
const STATUS_LABEL: Record<string, string> = {
    applying: '发布中',
    applied: '已发布',
    failed: '失败',
    interrupted: '中断',
};

type Snapshot = Record<string, { ratio: number | null; customers?: Record<string, number | null> }>;
const rowText = (value: number | null | undefined) =>
    value === null || value === undefined ? '分组价' : String(value);

function historyLines(row: BoardPublication, emails: Record<string, string>): string[] {
    const before = (row.before ?? {}) as Snapshot;
    const after = (row.after ?? {}) as Snapshot;
    const lines: string[] = [];
    for (const [group, next] of Object.entries(after)) {
        const prev = before[group];
        if (prev?.ratio !== next.ratio) lines.push(`${group}：${ratioText(prev?.ratio)} → ${ratioText(next.ratio)}`);
        for (const [userId, value] of Object.entries(next.customers ?? {})) {
            const old = prev?.customers?.[userId] ?? null;
            if (old !== value)
                lines.push(`${group} · ${emails[userId] ?? userId}：${rowText(old)} → ${rowText(value)}`);
        }
    }
    return lines;
}
export default function SaleRules({ isDark }: { isDark: boolean }) {
    const [board, setBoard] = useState<SaleRuleBoard | null>(null);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const [pending, setPending] = useState<Pending | null>(null);
    const [editing, setEditing] = useState<BoardRule | 'new' | null>(null);
    const [unified, setUnified] = useState<Record<string, string>>({});
    const [plan, setPlan] = useState<PresentedPlan | null>(null);
    const [confirmPlan, setConfirmPlan] = useState(false);
    const card = isDark ? 'border-slate-700 bg-slate-800/70' : 'border-slate-200 bg-white shadow-sm';
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';

    const load = useCallback(async () => {
        try {
            setBoard(await callApi<SaleRuleBoard>(API));
        } catch (caught) {
            setError(errorText(caught));
        }
    }, []);
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

    const previewRule = (change: Record<string, unknown>) =>
        run(async () => {
            const result = await callApi<SaveResponse>(API, {
                action: 'save_rule',
                change,
                confirmation: { dry_run: true },
            });
            setPending({ kind: 'rule', change, impact: result.impact });
        });

    const ruleChange = (draft: RuleDraft) =>
        editing && editing !== 'new'
            ? { op: 'update', id: editing.id, expected_updated_at: editing.updated_at, draft }
            : { op: 'create', draft };

    const previewDelete = (rule: BoardRule) =>
        previewRule({ op: 'delete', id: rule.id, expected_updated_at: rule.updated_at });

    const previewAdopt = (tier: BoardTier) =>
        run(async () => {
            const result = await callApi<AdoptResponse>(API, {
                action: 'adopt',
                adopt: { tier_key: tier.key },
                confirmation: { dry_run: true },
            });
            setPending({ kind: 'adopt', tierKey: tier.key, impact: result.impact, result });
        });

    const previewUnified = (tier: BoardTier) => {
        const ratio = (unified[tier.key] ?? '').trim();
        if (!DECIMAL.test(ratio)) return setError('统一售卖倍率须是普通小数，例如 1.2。');
        return run(async () => {
            const result = await callApi<SaveResponse>(API, {
                action: 'unified_ratio',
                unified: { tier_key: tier.key, unified_sale_ratio: ratio },
                confirmation: { dry_run: true },
            });
            setPending({ kind: 'unified', tierKey: tier.key, ratio, impact: result.impact });
        });
    };

    const apply = (confirm: ConfirmInput) =>
        run(async () => {
            if (!pending) return;
            const confirmation = { dry_run: false, ...confirm };
            const body =
                pending.kind === 'rule'
                    ? { action: 'save_rule', change: pending.change, confirmation }
                    : pending.kind === 'adopt'
                      ? { action: 'adopt', adopt: { tier_key: pending.tierKey }, confirmation }
                      : {
                            action: 'unified_ratio',
                            unified: { tier_key: pending.tierKey, unified_sale_ratio: pending.ratio },
                            confirmation,
                        };
            const result = await callApi<SaveResponse>(API, body);
            setPending(null);
            setEditing(null);
            setNotice(publishMessage(result));
            await load();
        });

    const check = () =>
        run(async () => {
            const result = await callApi<{ plan: PresentedPlan }>(API, { action: 'preview' });
            setPlan(result.plan);
            setConfirmPlan(false);
        });

    const publish = () =>
        run(async () => {
            if (!plan) return;
            const result = await callApi<{ outcome: string }>(API, {
                action: 'publish',
                publish: { expected_hash: plan.hash, confirm_increases: confirmPlan },
            });
            setPlan(null);
            setNotice(result.outcome === 'applied' ? '已发布到 new-api。' : 'new-api 已是最新，无需发布。');
            await load();
        });
    if (!board)
        return (
            <div className={`rounded-xl border p-4 ${card}`}>
                {error ? (
                    <p role="alert" className="text-sm text-red-600">
                        {error}
                    </p>
                ) : (
                    <p className={`py-8 text-center text-sm ${muted}`}>加载中…</p>
                )}
            </div>
        );

    const managedTiers = board.tiers.filter((tier) => tier.managed);
    const blocks = board.plan.diagnostics.filter((item) => item.level === 'block');
    const warns = board.plan.diagnostics.filter((item) => item.level === 'warn');
    const label = (item: { newapiGroup?: string; customer_email: string | null; message: string }) =>
        [item.newapiGroup, item.customer_email, item.message].filter(Boolean).join(' · ');
    const tierImpact = pending && pending.kind !== 'rule' ? pending : null;
    const adoptExtra =
        tierImpact?.kind === 'adopt' ? (
            <div className="space-y-1 text-xs">
                <p>统一售卖倍率将设为当前分组倍率 {tierImpact.result.unifiedSaleRatio}，纳管本身不改价。</p>
                {tierImpact.result.conversion.converted.map((item) => (
                    <p key={item.userId}>
                        {item.customer_email ?? item.userId} 的旧专属倍率 {item.ratio} 转为客户统一折扣{' '}
                        {discountToPercent(item.discount)}%
                    </p>
                ))}
                {tierImpact.result.conversion.kept.map((item) => (
                    <p key={item.userId} className="text-amber-600">
                        {item.customer_email ?? item.userId} 的旧专属倍率 {item.ratio} 暂不转换：{item.reason}
                    </p>
                ))}
            </div>
        ) : undefined;

    return (
        <div className="space-y-5">
            <p className={`text-xs ${muted}`}>
                统一售卖价 = 官方基础价 ×
                计费分组倍率。折扣按“标价的百分比”乘在统一售卖价上，同一请求只取一条：客户指定模型 →
                全局（模型优先于整档）→ 客户整档 →
                统一售卖价。规则改动保存后立即发布，到期与开始由每分钟一次的定时发布处理。
            </p>
            {!board.scheduler_enabled && (
                <Notice
                    tone="red"
                    isDark={isDark}
                    items={['售卖规则定时发布未启用：有生效或到期时间的规则不能保存。']}
                />
            )}
            {error && (
                <p role="alert" className="text-sm text-red-600">
                    {error}
                </p>
            )}
            {notice && <p className="text-sm text-emerald-600">{notice}</p>}
            <Notice tone="red" isDark={isDark} items={blocks.map(label)} />
            <Notice tone="amber" isDark={isDark} items={warns.map(label)} />
            <section className={`rounded-xl border p-4 ${card}`}>
                <h3 className="mb-2 text-sm font-semibold">计费分组</h3>
                <table className="w-full text-left text-sm">
                    <thead className={`text-xs ${muted}`}>
                        <tr>
                            <th className="py-1 pr-3">档次</th>
                            <th className="py-1 pr-3">new-api 分组</th>
                            <th className="py-1 pr-3">当前倍率</th>
                            <th className="py-1 pr-3">统一售卖倍率</th>
                            <th className="py-1 pr-3">发布后</th>
                            <th className="py-1 pr-3">操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        {board.tiers.map((tier) => (
                            <tr
                                key={tier.key}
                                className={isDark ? 'border-t border-slate-700' : 'border-t border-slate-100'}
                            >
                                <td className="py-2 pr-3">
                                    {tier.display_name}
                                    {!tier.enabled && <span className={`ml-1 text-xs ${muted}`}>（已停用）</span>}
                                </td>
                                <td className="py-2 pr-3 font-mono text-xs">{tier.newapi_group}</td>
                                <td className="py-2 pr-3">{ratioText(tier.live_ratio)}</td>
                                <td className="py-2 pr-3">
                                    {tier.managed ? tier.unified_sale_ratio : <span className={muted}>未纳管</span>}
                                </td>
                                <td className="py-2 pr-3">
                                    {tier.managed ? (
                                        tier.blocked ? (
                                            <span className="text-red-600">阻断</span>
                                        ) : (
                                            ratioText(tier.target_ratio)
                                        )
                                    ) : (
                                        '—'
                                    )}
                                </td>
                                <td className="py-2 pr-3">
                                    {tier.managed ? (
                                        <span className="flex items-center gap-2">
                                            <input
                                                value={unified[tier.key] ?? ''}
                                                placeholder={tier.unified_sale_ratio ?? ''}
                                                disabled={busy}
                                                onChange={(event) =>
                                                    setUnified({ ...unified, [tier.key]: event.target.value })
                                                }
                                                className={inputCls(isDark, 'w-20')}
                                            />
                                            <button
                                                type="button"
                                                disabled={busy}
                                                className={buttonCls('plain', isDark)}
                                                onClick={() => void previewUnified(tier)}
                                            >
                                                改统一价
                                            </button>
                                        </span>
                                    ) : tier.enabled && !tier.shared_with.length ? (
                                        <button
                                            type="button"
                                            disabled={busy}
                                            className={buttonCls('plain', isDark)}
                                            onClick={() => void previewAdopt(tier)}
                                        >
                                            纳管
                                        </button>
                                    ) : (
                                        <span className={`text-xs ${muted}`}>
                                            {tier.shared_with.length
                                                ? `与 ${tier.shared_with.join('、')} 共用分组，需先拆分`
                                                : '—'}
                                        </span>
                                    )}
                                    {tier.legacy_multipliers > 0 && (
                                        <span className={`ml-2 text-xs ${muted}`}>
                                            {tier.legacy_multipliers} 条旧专属倍率
                                        </span>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {tierImpact && (
                    <ImpactView
                        impact={tierImpact.impact}
                        isDark={isDark}
                        busy={busy}
                        extra={adoptExtra}
                        onApply={(confirm) => void apply(confirm)}
                        onCancel={() => setPending(null)}
                    />
                )}
            </section>
            <section className={`rounded-xl border p-4 ${card}`}>
                <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-semibold">售卖规则</h3>
                    <button
                        type="button"
                        disabled={busy || !managedTiers.length}
                        className={buttonCls('primary', isDark)}
                        onClick={() => {
                            setPending(null);
                            setEditing('new');
                        }}
                    >
                        新增全局规则
                    </button>
                </div>
                <p className={`mb-2 text-xs ${muted}`}>客户规则在客户详情页的「售卖折扣」中新增；这里可修改或删除。</p>
                {board.rules.length === 0 ? (
                    <p className={`text-xs ${muted}`}>还没有规则。</p>
                ) : (
                    <table className="w-full text-left text-sm">
                        <thead className={`text-xs ${muted}`}>
                            <tr>
                                <th className="py-1 pr-3">范围</th>
                                <th className="py-1 pr-3">档次 / 模型</th>
                                <th className="py-1 pr-3">客户</th>
                                <th className="py-1 pr-3">收费比例</th>
                                <th className="py-1 pr-3">时间</th>
                                <th className="py-1 pr-3">状态</th>
                                <th className="py-1 pr-3" />
                            </tr>
                        </thead>
                        <tbody>
                            {board.rules.map((rule) => (
                                <tr
                                    key={rule.id}
                                    className={isDark ? 'border-t border-slate-700' : 'border-t border-slate-100'}
                                >
                                    <td className="py-2 pr-3 text-xs">{KIND_LABEL[rule.kind] ?? rule.kind}</td>
                                    <td className="py-2 pr-3">
                                        {rule.tier_key}
                                        {rule.model_name ? ` / ${rule.model_name}` : ''}
                                    </td>
                                    <td className="py-2 pr-3 text-xs">{rule.customer_email ?? '—'}</td>
                                    <td className="py-2 pr-3">{discountToPercent(rule.discount)}%</td>
                                    <td className="py-2 pr-3 text-xs">
                                        {formatTime(rule.effective_from)} 至 {formatTime(rule.effective_to)}
                                    </td>
                                    <td className="py-2 pr-3 text-xs">{STATE_LABEL[rule.state]}</td>
                                    <td className="py-2 pr-3">
                                        <span className="flex gap-2">
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
                                                onClick={() => void previewDelete(rule)}
                                            >
                                                删除
                                            </button>
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                {editing && (
                    <RuleForm
                        key={editing === 'new' ? 'new' : editing.id}
                        tiers={managedTiers}
                        models={board.models}
                        customerId={editing === 'new' ? null : editing.user_id}
                        initial={editing === 'new' ? null : editing}
                        isDark={isDark}
                        busy={busy}
                        onPreview={(draft) => void previewRule(ruleChange(draft))}
                        onCancel={() => {
                            setEditing(null);
                            setPending(null);
                        }}
                    />
                )}
                {pending?.kind === 'rule' && (
                    <ImpactView
                        impact={pending.impact}
                        isDark={isDark}
                        busy={busy}
                        onApply={(confirm) => void apply(confirm)}
                        onCancel={() => setPending(null)}
                    />
                )}
            </section>
            <section className={`rounded-xl border p-4 ${card}`}>
                <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-semibold">发布核对</h3>
                    <button
                        type="button"
                        disabled={busy}
                        className={buttonCls('plain', isDark)}
                        onClick={() => void check()}
                    >
                        {busy ? '核对中…' : '完整核对（含客户账号与 Key）'}
                    </button>
                </div>
                <p className={`text-xs ${muted}`}>
                    当前编译结果：{board.plan.changes.length} 处待发布的价格变化。完整核对会读取客户的 new-api 分组、Key
                    和单独倍率。
                </p>
                {plan && (
                    <div className="mt-3 space-y-3">
                        <ChangeTable changes={plan.changes} isDark={isDark} />
                        <Notice
                            tone="red"
                            isDark={isDark}
                            items={[
                                ...plan.held.map(
                                    (item) => `${item.customer_email ?? item.user_id} 暂不发布，见下方原因`,
                                ),
                                ...plan.diagnostics.filter((item) => item.level === 'block').map(label),
                            ]}
                        />
                        <Notice
                            tone="amber"
                            isDark={isDark}
                            items={plan.diagnostics.filter((item) => item.level === 'warn').map(label)}
                        />
                        {plan.moves.length > 0 && (
                            <p className={`text-xs ${muted}`}>
                                将移动客户分组：
                                {plan.moves
                                    .map(
                                        (move) =>
                                            `${move.customer_email ?? move.userId}（${move.direction === 'in' ? '启用专属倍率' : '回到原分组'}）`,
                                    )
                                    .join('、')}
                            </p>
                        )}
                        {plan.has_increases && (
                            <label className="flex items-center gap-2 text-xs">
                                <input
                                    type="checkbox"
                                    checked={confirmPlan}
                                    onChange={(event) => setConfirmPlan(event.target.checked)}
                                />
                                我已核对涨价的客户，确认发布
                            </label>
                        )}
                        <button
                            type="button"
                            disabled={
                                busy || plan.blocked || (plan.has_increases && !confirmPlan) || plan.steps.length === 0
                            }
                            className={buttonCls('primary', isDark)}
                            onClick={() => void publish()}
                        >
                            {plan.steps.length === 0 ? '无需发布' : '发布'}
                        </button>
                    </div>
                )}
            </section>

            <section className={`rounded-xl border p-4 ${card}`}>
                <h3 className="mb-2 text-sm font-semibold">发布记录</h3>
                {board.publications.length === 0 ? (
                    <p className={`text-xs ${muted}`}>还没有发布记录。</p>
                ) : (
                    <ul className="space-y-2 text-xs">
                        {board.publications.map((row) => (
                            <li
                                key={row.id}
                                className={isDark ? 'border-t border-slate-700 pt-2' : 'border-t border-slate-100 pt-2'}
                            >
                                <p>
                                    {formatTime(row.created_at)} · {TRIGGER_LABEL[row.trigger] ?? row.trigger} ·{' '}
                                    {row.actor_email ?? '系统'} ·{' '}
                                    <span
                                        className={
                                            row.status === 'applied'
                                                ? 'text-emerald-600'
                                                : row.status === 'applying'
                                                  ? ''
                                                  : 'text-red-600'
                                        }
                                    >
                                        {STATUS_LABEL[row.status] ?? row.status}
                                    </span>
                                    {row.moves ? ` · 移动 ${row.moves} 位客户` : ''}
                                </p>
                                {historyLines(row, board.emails).map((line) => (
                                    <p key={line} className={muted}>
                                        {line}
                                    </p>
                                ))}
                                {row.error && <p className="text-red-600">{row.error}</p>}
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}
