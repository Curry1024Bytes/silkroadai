'use client';

import { useState } from 'react';
import type { BoardModel, BoardRule, PresentedImpact } from '@/lib/pricing-rules/board';

/** Shared pieces of the sale-rule UI (pricing page tab and customer page panel). */

export class ApiError extends Error {
    constructor(
        message: string,
        public code: string | null,
    ) {
        super(message);
    }
}

export async function callApi<T>(url: string, body?: Record<string, unknown>): Promise<T> {
    const response = await fetch(url, {
        method: body ? 'POST' : 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const data = (await response.json().catch(() => null)) as (T & { message?: string; error?: string }) | null;
    if (!response.ok || !data)
        throw new ApiError(
            data?.message ?? (response.status === 401 ? '登录已过期，请重新登录。' : '请求失败，请稍后重试。'),
            data?.error ?? null,
        );
    return data;
}

export const errorText = (error: unknown) => (error instanceof Error ? error.message : '请求失败，请稍后重试。');

/** "80" (percent of the unified price) -> "0.8", exactly; null when not a plain number. */
export function percentToDiscount(percent: string): string | null {
    const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(percent.trim());
    if (!match) return null;
    const digits = `${match[1]}${(match[2] ?? '').padEnd(2, '0')}`.replace(/^0+(?=\d)/, '').padStart(5, '0');
    const whole = digits.slice(0, -4).replace(/^0+(?=\d)/, '');
    const fraction = digits.slice(-4).replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
}

/** "0.8" -> "80". */
export function discountToPercent(discount: string): string {
    const [whole, fraction = ''] = discount.split('.');
    const padded = fraction.padEnd(2, '0');
    const integer = `${whole}${padded.slice(0, 2)}`.replace(/^0+(?=\d)/, '');
    const rest = padded.slice(2).replace(/0+$/, '');
    return rest ? `${integer}.${rest}` : integer;
}

const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

/** datetime-local value read as Beijing time -> ISO with offset. */
export function localToIso(value: string): string | null {
    return value ? new Date(`${value}:00+08:00`).toISOString() : null;
}

export function isoToLocal(value: string | null): string {
    return value ? new Date(new Date(value).getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 16) : '';
}

export function formatTime(value: string | null): string {
    return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
}

export const ratioText = (value: number | null | undefined) =>
    value === null || value === undefined ? '—' : String(value);

export function buttonCls(kind: 'primary' | 'plain' | 'danger', isDark: boolean) {
    if (kind === 'primary')
        return 'rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50';
    if (kind === 'danger')
        return 'rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50';
    return `rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${isDark ? 'border-slate-600 text-slate-200' : 'border-slate-300 text-slate-700'}`;
}

export function inputCls(isDark: boolean, width = 'w-28') {
    return `${width} rounded border px-2 py-1 text-sm ${isDark ? 'border-slate-600 bg-slate-900 text-slate-100' : 'border-slate-300 bg-white'}`;
}

export const KIND_LABEL: Record<string, string> = {
    global_tier: '全局 · 整个档次',
    global_model: '全局 · 指定模型',
    customer_tier: '客户 · 整个档次',
    customer_model: '客户 · 指定模型',
};

export const STATE_LABEL: Record<BoardRule['state'], string> = {
    active: '生效中',
    scheduled: '未开始',
    expired: '已到期',
    disabled: '已停用',
};
type Change = Omit<PresentedImpact['changes'][number], 'at'> & { at?: string | null };

export function ChangeTable({ changes, isDark }: { changes: Change[]; isDark: boolean }) {
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';
    if (!changes.length) return <p className={`text-xs ${muted}`}>没有价格变化。</p>;
    return (
        <table className="w-full text-left text-xs">
            <thead className={muted}>
                <tr>
                    <th className="py-1 pr-3">时间</th>
                    <th className="py-1 pr-3">计费分组</th>
                    <th className="py-1 pr-3">客户</th>
                    <th className="py-1 pr-3">原倍率</th>
                    <th className="py-1 pr-3">新倍率</th>
                </tr>
            </thead>
            <tbody>
                {changes.map((change, index) => (
                    <tr key={index} className={isDark ? 'border-t border-slate-700' : 'border-t border-slate-100'}>
                        <td className="py-1 pr-3">{change.at ? formatTime(change.at) : '立即'}</td>
                        <td className="py-1 pr-3 font-mono">{change.newapiGroup}</td>
                        <td className="py-1 pr-3">
                            {change.userId ? (change.customer_email ?? change.userId) : '未享折扣的客户（分组价）'}
                        </td>
                        <td className="py-1 pr-3">{ratioText(change.before)}</td>
                        <td className={`py-1 pr-3 ${change.increase ? 'font-semibold text-red-600' : ''}`}>
                            {ratioText(change.after)}
                            {change.increase ? ' ↑涨价' : ''}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

export function Notice({ tone, items, isDark }: { tone: 'red' | 'amber'; items: string[]; isDark: boolean }) {
    if (!items.length) return null;
    const cls =
        tone === 'red'
            ? isDark
                ? 'border-red-800 bg-red-950/50 text-red-300'
                : 'border-red-200 bg-red-50 text-red-700'
            : isDark
              ? 'border-amber-700 bg-amber-950/20 text-amber-200'
              : 'border-amber-200 bg-amber-50 text-amber-800';
    return (
        <ul className={`space-y-1 rounded-lg border p-2 text-xs ${cls}`}>
            {items.map((item, index) => (
                <li key={index}>{item}</li>
            ))}
        </ul>
    );
}
export interface ConfirmInput {
    impact_hash: string;
    confirm_increases: boolean;
    below_cost_reason?: string;
}

/** Preview of a pending change with the confirmations spec §6 requires before it is saved. */
export function ImpactView({
    impact,
    isDark,
    busy,
    extra,
    onApply,
    onCancel,
}: {
    impact: PresentedImpact;
    isDark: boolean;
    busy: boolean;
    extra?: React.ReactNode;
    onApply: (confirm: ConfirmInput) => void;
    onCancel: () => void;
}) {
    const [increases, setIncreases] = useState(false);
    const [reason, setReason] = useState('');
    const blocked = impact.blocks.length > 0 || impact.holds.length > 0;
    const ready =
        !blocked && (!impact.increases.length || increases) && (!impact.belowCost.length || reason.trim().length > 0);
    const where = (item: { newapiGroup?: string; customer_email: string | null }) =>
        [item.newapiGroup, item.customer_email].filter(Boolean).join(' · ');
    return (
        <div
            className={`mt-3 space-y-3 rounded-lg border p-3 text-sm ${isDark ? 'border-slate-600 bg-slate-900/40' : 'border-slate-200 bg-slate-50'}`}
        >
            <p className="font-medium">
                预览：{impact.changes.length} 处价格变化
                {impact.increases.length ? `，其中 ${impact.increases.length} 处涨价` : ''}
            </p>
            {extra}
            <ChangeTable changes={impact.changes} isDark={isDark} />
            <Notice
                tone="red"
                isDark={isDark}
                items={[...impact.blocks, ...impact.holds].map((item) => `${where(item)} ${item.message}`)}
            />
            <Notice
                tone="amber"
                isDark={isDark}
                items={[
                    ...impact.belowCost.map(
                        (item) =>
                            `${item.newapiGroup} · ${item.model}：倍率 ${item.ratio} 低于成本线 ${item.floor.toFixed(6)}`,
                    ),
                    ...impact.warnings.map((item) => `${where(item)} ${item.message}`),
                ]}
            />
            {impact.increases.length > 0 && (
                <label className="flex items-center gap-2 text-xs">
                    <input
                        type="checkbox"
                        checked={increases}
                        onChange={(event) => setIncreases(event.target.checked)}
                    />
                    我已核对上面标为涨价的客户，确认涨价
                </label>
            )}
            {impact.belowCost.length > 0 && (
                <label className="block text-xs">
                    售价低于采购成本，请填写原因
                    <textarea
                        value={reason}
                        maxLength={500}
                        onChange={(event) => setReason(event.target.value)}
                        className={`mt-1 block w-full ${inputCls(isDark, 'w-full')}`}
                    />
                </label>
            )}
            <div className="flex gap-2">
                <button
                    type="button"
                    disabled={busy || !ready}
                    className={buttonCls('primary', isDark)}
                    onClick={() =>
                        onApply({
                            impact_hash: impact.hash,
                            confirm_increases: increases,
                            ...(reason.trim() ? { below_cost_reason: reason.trim() } : {}),
                        })
                    }
                >
                    {busy ? '保存中…' : '确认保存并发布'}
                </button>
                <button type="button" disabled={busy} className={buttonCls('plain', isDark)} onClick={onCancel}>
                    取消
                </button>
            </div>
        </div>
    );
}
export interface SaveResponse {
    applied: boolean;
    impact: PresentedImpact;
    publish: { outcome: 'applied' | 'noop' | 'deferred'; publicationId: string | null; message: string | null } | null;
}

export function publishMessage(result: SaveResponse): string {
    if (!result.publish) return '已保存。';
    if (result.publish.outcome === 'deferred') return result.publish.message ?? '已保存，发布未完成。';
    return result.publish.outcome === 'applied' ? '已保存并发布到 new-api。' : '已保存，new-api 无需改动。';
}

export interface RuleDraft {
    kind: string;
    tier_key: string;
    user_id: string | null;
    model_id: string | null;
    discount: string;
    effective_from: string | null;
    effective_to: string | null;
    enabled: boolean;
    note: string | null;
}

/** Create or edit one rule. `customerId` fixes the customer (customer page); otherwise it edits global rules. */
export function RuleForm({
    tiers,
    models,
    customerId,
    initial,
    isDark,
    busy,
    onPreview,
    onCancel,
}: {
    tiers: Array<{ key: string; display_name: string }>;
    models: BoardModel[];
    customerId: string | null;
    initial: BoardRule | null;
    isDark: boolean;
    busy: boolean;
    onPreview: (draft: RuleDraft) => void;
    onCancel: () => void;
}) {
    const scope = customerId ? 'customer' : 'global';
    const [tier, setTier] = useState(initial?.tier_key ?? tiers[0]?.key ?? '');
    const [model, setModel] = useState(initial?.model_id ?? '');
    const [percent, setPercent] = useState(initial ? discountToPercent(initial.discount) : '');
    const [from, setFrom] = useState(isoToLocal(initial?.effective_from ?? null));
    const [to, setTo] = useState(isoToLocal(initial?.effective_to ?? null));
    const [enabled, setEnabled] = useState(initial?.enabled ?? true);
    const [note, setNote] = useState(initial?.note ?? '');
    const [problem, setProblem] = useState('');
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';
    const tierModels = models.filter((item) => item.tiers.includes(tier));
    const submit = () => {
        const discount = percentToDiscount(percent);
        if (!tier) return setProblem('请选择档次。');
        if (!discount) return setProblem('请按标价百分比填写，例如 80 表示按标价的 80% 收费。');
        setProblem('');
        onPreview({
            kind: `${scope}_${model ? 'model' : 'tier'}`,
            tier_key: tier,
            user_id: customerId,
            model_id: model || null,
            discount,
            effective_from: localToIso(from),
            effective_to: localToIso(to),
            enabled,
            note: note.trim() || null,
        });
    };
    const field = (label: string, control: React.ReactNode) => (
        <label className="block">
            <span className={`mb-1 block text-xs ${muted}`}>{label}</span>
            {control}
        </label>
    );
    return (
        <div
            className={`mt-3 space-y-3 rounded-lg border p-3 text-sm ${isDark ? 'border-slate-600 bg-slate-900/40' : 'border-slate-200 bg-slate-50'}`}
        >
            <div className="grid gap-3 md:grid-cols-3">
                {field(
                    '档次（已纳管）',
                    <select
                        value={tier}
                        disabled={busy || !!initial}
                        onChange={(event) => {
                            setTier(event.target.value);
                            setModel('');
                        }}
                        className={inputCls(isDark, 'w-full')}
                    >
                        {tiers.map((item) => (
                            <option key={item.key} value={item.key}>
                                {item.display_name}
                            </option>
                        ))}
                    </select>,
                )}
                {field(
                    '模型',
                    <select
                        value={model}
                        disabled={busy}
                        onChange={(event) => setModel(event.target.value)}
                        className={inputCls(isDark, 'w-full')}
                    >
                        <option value="">整个档次（含之后新增的模型）</option>
                        {tierModels.map((item) => (
                            <option key={item.id} value={item.id}>
                                {item.display_name}
                            </option>
                        ))}
                    </select>,
                )}
                {field(
                    '按标价的百分比收费',
                    <input
                        value={percent}
                        disabled={busy}
                        inputMode="decimal"
                        placeholder="80"
                        onChange={(event) => setPercent(event.target.value)}
                        className={inputCls(isDark, 'w-full')}
                    />,
                )}
                {field(
                    '生效时间（北京时间，可空）',
                    <input
                        type="datetime-local"
                        value={from}
                        disabled={busy}
                        onChange={(event) => setFrom(event.target.value)}
                        className={inputCls(isDark, 'w-full')}
                    />,
                )}
                {field(
                    '到期时间（北京时间，可空）',
                    <input
                        type="datetime-local"
                        value={to}
                        disabled={busy}
                        onChange={(event) => setTo(event.target.value)}
                        className={inputCls(isDark, 'w-full')}
                    />,
                )}
                {field(
                    '备注',
                    <input
                        value={note}
                        maxLength={500}
                        disabled={busy}
                        onChange={(event) => setNote(event.target.value)}
                        className={inputCls(isDark, 'w-full')}
                    />,
                )}
            </div>
            <p className={`text-xs ${muted}`}>
                5 至 200 之间，例如 80 表示按该档次统一售卖价的 80% 收费；超过 100
                是加价。同一请求只取一条折扣，不叠加。
            </p>
            <label className="flex items-center gap-2 text-xs">
                <input
                    type="checkbox"
                    checked={enabled}
                    disabled={busy}
                    onChange={(e) => setEnabled(e.target.checked)}
                />
                启用
            </label>
            {problem && <p className="text-xs text-red-600">{problem}</p>}
            <div className="flex gap-2">
                <button type="button" disabled={busy} className={buttonCls('primary', isDark)} onClick={submit}>
                    {busy ? '计算中…' : '预览影响'}
                </button>
                <button type="button" disabled={busy} className={buttonCls('plain', isDark)} onClick={onCancel}>
                    取消
                </button>
            </div>
        </div>
    );
}
