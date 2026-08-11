'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { RotateCcw } from 'lucide-react';
import PayPageLayout from '@/components/PayPageLayout';
import { resolveLocale, type Locale } from '@/lib/locale';
import {
    calculatePricing,
    type PricingCalculatorInput,
    type PricingCalculatorResult,
} from '@/lib/admin/pricing-calculator';

interface GroupContext {
    key: string;
    display_name: string;
    newapi_group: string;
    is_default: boolean;
    group_ratio: number | null;
}

interface CalculatorContext {
    quota_per_usd: number;
    usd_to_cny_rate: number;
    chat_fx_cny_per_1m_quota: number;
    groups: GroupContext[];
}

interface FormState {
    modelName: string;
    upstreamCreditsPerCny: string;
    upstreamChannelRatio: string;
    inputUsdPer1m: string;
    outputUsdPer1m: string;
    cacheReadUsdPer1m: string;
    cacheWriteUsdPer1m: string;
    markupPercent: string;
    groupKey: string;
    groupRatio: string;
    chatFx: string;
    quotaPerUsd: string;
    sampleInput: string;
    sampleOutput: string;
    sampleCacheRead: string;
    sampleCacheWrite: string;
}

const DEFAULT_FORM: FormState = {
    modelName: 'claude-fable-5',
    upstreamCreditsPerCny: '10',
    upstreamChannelRatio: '10',
    inputUsdPer1m: '10',
    outputUsdPer1m: '50',
    cacheReadUsdPer1m: '1',
    cacheWriteUsdPer1m: '12.5',
    markupPercent: '20',
    groupKey: 'ccmax稳定满血',
    groupRatio: '1.2',
    chatFx: '14.4',
    quotaPerUsd: '500000',
    sampleInput: '2',
    sampleOutput: '2642',
    sampleCacheRead: '37988',
    sampleCacheWrite: '7867',
};

function num(value: string): number | null {
    if (!value.trim()) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function money(value: number, digits = 4): string {
    return `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: digits })}`;
}

function decimal(value: number, digits = 6): string {
    return value.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function fieldValue(form: FormState, key: keyof FormState): number | null {
    return num(form[key]);
}

function buildInput(form: FormState): PricingCalculatorInput | null {
    const values = {
        upstreamCreditsPerCny: fieldValue(form, 'upstreamCreditsPerCny'),
        upstreamChannelRatio: fieldValue(form, 'upstreamChannelRatio'),
        inputUsdPer1m: fieldValue(form, 'inputUsdPer1m'),
        outputUsdPer1m: fieldValue(form, 'outputUsdPer1m'),
        cacheReadUsdPer1m: fieldValue(form, 'cacheReadUsdPer1m'),
        cacheWriteUsdPer1m: fieldValue(form, 'cacheWriteUsdPer1m'),
        markupPercent: fieldValue(form, 'markupPercent'),
        groupRatio: fieldValue(form, 'groupRatio'),
        chatFx: fieldValue(form, 'chatFx'),
        quotaPerUsd: fieldValue(form, 'quotaPerUsd'),
        sampleInput: fieldValue(form, 'sampleInput'),
        sampleOutput: fieldValue(form, 'sampleOutput'),
        sampleCacheRead: fieldValue(form, 'sampleCacheRead'),
        sampleCacheWrite: fieldValue(form, 'sampleCacheWrite'),
    };
    if (Object.values(values).some((value) => value === null)) return null;

    return {
        upstreamCreditsPerCny: values.upstreamCreditsPerCny as number,
        upstreamChannelRatio: values.upstreamChannelRatio as number,
        official: {
            inputUsdPer1m: values.inputUsdPer1m as number,
            outputUsdPer1m: values.outputUsdPer1m as number,
            cacheReadUsdPer1m: values.cacheReadUsdPer1m as number,
            cacheWriteUsdPer1m: values.cacheWriteUsdPer1m as number,
        },
        markupRate: (values.markupPercent as number) / 100,
        groupRatio: values.groupRatio as number,
        portalChatFxCnyPer1mQuota: values.chatFx as number,
        quotaPerUsd: values.quotaPerUsd as number,
        sample: {
            input: values.sampleInput as number,
            output: values.sampleOutput as number,
            cacheRead: values.sampleCacheRead as number,
            cacheWrite: values.sampleCacheWrite as number,
        },
    };
}

function getTexts(locale: Locale) {
    if (locale === 'en') {
        return {
            title: 'Pricing calculator',
            subtitle: 'Upstream cost → retail price → new-api ratios. Preview only.',
            safe: 'Preview only — this page does not save prices or write new-api options.',
            upstream: 'Upstream economics',
            upstreamCredits: 'Upstream credit / ¥1',
            upstreamCreditsHint: '¥1 → how many upstream USD credits',
            upstreamRatio: 'Upstream channel ratio',
            markup: 'Target markup (%)',
            official: 'Official token prices',
            input: 'Input',
            output: 'Output',
            cacheRead: 'Cache read',
            cacheWrite: 'Cache write / 5m',
            perMillion: '$ / 1M token',
            group: 'Portal tier',
            groupRatio: 'GroupRatio',
            portal: 'Portal conversion context',
            chatFx: '¥ / 1M quota',
            quotaPerUsd: 'Quota / USD',
            usdToCny: 'Live Portal USD→CNY',
            sample: 'Sample request',
            tokens: 'tokens',
            model: 'Model label',
            result: 'Calculated result',
            cost: 'Upstream cost',
            retail: 'Retail price',
            profit: 'Profit',
            margin: 'Margin',
            ratio: 'Ratios to sync',
            sampleResult: 'Sample charge',
            category: 'Token type',
            officialPrice: 'Official $/1M',
            costCny: 'Cost ¥/1M',
            retailCny: 'Retail ¥/1M',
            profitCny: 'Profit ¥/1M',
            modelRatio: 'ModelRatio',
            completionRatio: 'CompletionRatio',
            cacheRatio: 'CacheRatio',
            createCacheRatio: 'CreateCacheRatio',
            sampleUpstream: 'Upstream cost',
            sampleRetail: 'Customer charge',
            sampleProfit: 'Profit',
            technicalUsd: 'new-api technical USD',
            quota: 'Raw quota',
            reset: 'Reset',
            loadingContext: 'Loading live GroupRatio…',
            contextError: 'Live context unavailable; editable defaults are being used.',
            invalid: 'Enter valid positive prices and ratios to calculate.',
            note: 'The cost column is derived from upstream rules. The Admin pricing page should receive the Retail ¥/1M values, not the official USD prices.',
        };
    }
    return {
        title: '定价计算器',
        subtitle: '上游成本 → 用户零售价 → new-api 倍率，只读预览',
        safe: '仅预览：本页面不会保存价格，也不会写入 new-api 配置。',
        upstream: '上游经济参数',
        upstreamCredits: '充值 ¥1 获得上游额度',
        upstreamCreditsHint: '例如 1:10 就填 10',
        upstreamRatio: '上游渠道倍率',
        markup: '目标加价率 (%)',
        official: '官方 Token 价格',
        input: '普通输入',
        output: '输出',
        cacheRead: '缓存读取',
        cacheWrite: '缓存写入 / 5 分钟',
        perMillion: '$ / 100 万 token',
        group: 'Portal 档次',
        groupRatio: 'GroupRatio',
        portal: 'Portal 换算上下文',
        chatFx: '每 100 万 quota 对应 ¥',
        quotaPerUsd: 'quota / USD',
        usdToCny: 'Portal USD→CNY',
        sample: '样例请求',
        tokens: 'token 数',
        model: '模型备注',
        result: '计算结果',
        cost: '上游成本',
        retail: '用户零售价',
        profit: '利润',
        margin: '毛利率',
        ratio: '建议同步倍率',
        sampleResult: '样例扣费',
        category: 'Token 类型',
        officialPrice: '官方 $/1M',
        costCny: '成本 ¥/1M',
        retailCny: '零售 ¥/1M',
        profitCny: '利润 ¥/1M',
        modelRatio: 'ModelRatio',
        completionRatio: 'CompletionRatio',
        cacheRatio: 'CacheRatio',
        createCacheRatio: 'CreateCacheRatio',
        sampleUpstream: '上游成本',
        sampleRetail: '用户扣费',
        sampleProfit: '利润',
        technicalUsd: 'new-api 技术 USD',
        quota: 'Raw quota',
        reset: '重置',
        loadingContext: '正在读取 live GroupRatio…',
        contextError: '无法读取 live 上下文，当前使用可编辑的默认值。',
        invalid: '请输入有效的正数价格和倍率后再计算。',
        note: '成本由上游规则推导。真正填入 Admin「定价」页面的应是“零售 ¥/1M”，不是官方美元价格。',
    };
}

type Texts = ReturnType<typeof getTexts>;

function Field({
    label,
    hint,
    value,
    onChange,
    isDark,
    step = '0.0001',
    min = '0',
    readOnly = false,
    type = 'number',
}: {
    label: string;
    hint?: string;
    value: string;
    onChange?: (value: string) => void;
    isDark: boolean;
    step?: string;
    min?: string;
    readOnly?: boolean;
    type?: 'text' | 'number';
}) {
    return (
        <label className="block">
            <span
                className={['mb-1 block text-xs font-medium', isDark ? 'text-slate-300' : 'text-slate-700'].join(' ')}
            >
                {label}
            </span>
            <input
                type={type}
                inputMode={type === 'number' ? 'decimal' : 'text'}
                step={type === 'number' ? step : undefined}
                min={type === 'number' ? min : undefined}
                value={value}
                readOnly={readOnly}
                onChange={onChange ? (event) => onChange(event.target.value) : undefined}
                className={[
                    'w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40',
                    readOnly ? 'cursor-not-allowed' : '',
                    isDark
                        ? 'border-slate-600 bg-slate-800 text-slate-100 placeholder:text-slate-500'
                        : 'border-slate-300 bg-white text-slate-900 placeholder:text-slate-400',
                ].join(' ')}
            />
            {hint && (
                <span className={['mt-1 block text-[11px]', isDark ? 'text-slate-500' : 'text-slate-500'].join(' ')}>
                    {hint}
                </span>
            )}
        </label>
    );
}

function Panel({ title, children, isDark }: { title: string; children: ReactNode; isDark: boolean }) {
    return (
        <section
            className={[
                'rounded-xl border p-4',
                isDark ? 'border-slate-700 bg-slate-900/70' : 'border-slate-200 bg-white shadow-sm',
            ].join(' ')}
        >
            <h2 className={['mb-4 text-sm font-semibold', isDark ? 'text-slate-100' : 'text-slate-900'].join(' ')}>
                {title}
            </h2>
            {children}
        </section>
    );
}

export default function PricingCalculatorPage() {
    const searchParams = useSearchParams();
    const locale = resolveLocale(searchParams.get('lang'));
    const isDark = searchParams.get('theme') === 'dark';
    const t = getTexts(locale);
    const [form, setForm] = useState<FormState>(DEFAULT_FORM);
    const [context, setContext] = useState<CalculatorContext | null>(null);
    const [contextError, setContextError] = useState(false);

    useEffect(() => {
        let cancelled = false;
        fetch('/api/admin/pricing-calculator/context', { credentials: 'same-origin' })
            .then(async (response) => {
                if (!response.ok) throw new Error('context request failed');
                return (await response.json()) as CalculatorContext;
            })
            .then((next) => {
                if (cancelled) return;
                setContext(next);
                const defaultGroup =
                    next.groups.find((group) => group.key === DEFAULT_FORM.groupKey) ??
                    next.groups.find((group) => group.is_default);
                setForm((current) => ({
                    ...current,
                    chatFx: String(next.chat_fx_cny_per_1m_quota),
                    quotaPerUsd: String(next.quota_per_usd),
                    ...(defaultGroup?.group_ratio != null
                        ? { groupKey: defaultGroup.key, groupRatio: String(defaultGroup.group_ratio) }
                        : {}),
                }));
            })
            .catch(() => {
                if (!cancelled) setContextError(true);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const update = useCallback((key: keyof FormState, value: string) => {
        setForm((current) => ({ ...current, [key]: value }));
    }, []);

    const calculation = useMemo((): { result: PricingCalculatorResult | null; invalid: boolean } => {
        const input = buildInput(form);
        if (!input) return { result: null, invalid: true };
        try {
            return { result: calculatePricing(input), invalid: false };
        } catch {
            return { result: null, invalid: true };
        }
    }, [form]);

    const reset = () => setForm({ ...DEFAULT_FORM });
    const card = isDark ? 'border-slate-700 bg-slate-900/70' : 'border-slate-200 bg-white shadow-sm';
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';
    const strong = isDark ? 'text-slate-100' : 'text-slate-900';
    const inputClass = 'grid grid-cols-1 gap-3 sm:grid-cols-2';
    const result = calculation.result;
    const rows: Array<[string, number, number, number, number]> = result
        ? [
              [
                  t.input,
                  num(form.inputUsdPer1m) ?? 0,
                  result.upstreamCostCnyPer1m.input,
                  result.retailCnyPer1m.input,
                  result.profitCnyPer1m.input,
              ],
              [
                  t.output,
                  num(form.outputUsdPer1m) ?? 0,
                  result.upstreamCostCnyPer1m.output,
                  result.retailCnyPer1m.output,
                  result.profitCnyPer1m.output,
              ],
              [
                  t.cacheRead,
                  num(form.cacheReadUsdPer1m) ?? 0,
                  result.upstreamCostCnyPer1m.cacheRead,
                  result.retailCnyPer1m.cacheRead,
                  result.profitCnyPer1m.cacheRead,
              ],
              [
                  t.cacheWrite,
                  num(form.cacheWriteUsdPer1m) ?? 0,
                  result.upstreamCostCnyPer1m.cacheWrite,
                  result.retailCnyPer1m.cacheWrite,
                  result.profitCnyPer1m.cacheWrite,
              ],
          ]
        : [];

    return (
        <PayPageLayout
            isDark={isDark}
            maxWidth="full"
            title={t.title}
            subtitle={form.modelName ? `${form.modelName} · ${t.subtitle}` : t.subtitle}
            locale={locale}
            actions={
                <button
                    type="button"
                    onClick={reset}
                    title={t.reset}
                    aria-label={t.reset}
                    className={[
                        'inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors',
                        isDark
                            ? 'border-slate-600 text-slate-300 hover:bg-slate-800'
                            : 'border-slate-300 text-slate-700 hover:bg-slate-100',
                    ].join(' ')}
                >
                    <RotateCcw size={14} aria-hidden="true" />
                    {t.reset}
                </button>
            }
        >
            <div
                className={[
                    'mb-5 rounded-lg border px-4 py-3 text-sm',
                    isDark
                        ? 'border-emerald-800/70 bg-emerald-950/30 text-emerald-300'
                        : 'border-emerald-200 bg-emerald-50 text-emerald-800',
                ].join(' ')}
            >
                <strong>{t.safe}</strong>
                <span className="ml-2 opacity-80">{t.note}</span>
            </div>

            {(contextError || !context) && (
                <div
                    className={[
                        'mb-5 rounded-lg border px-4 py-3 text-sm',
                        contextError
                            ? isDark
                                ? 'border-amber-800/70 bg-amber-950/30 text-amber-300'
                                : 'border-amber-200 bg-amber-50 text-amber-800'
                            : isDark
                              ? 'border-slate-700 bg-slate-900/50 text-slate-400'
                              : 'border-slate-200 bg-slate-50 text-slate-500',
                    ].join(' ')}
                >
                    {contextError ? t.contextError : t.loadingContext}
                </div>
            )}

            <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(360px,0.9fr)_minmax(560px,1.5fr)]">
                <div className="space-y-5">
                    <Panel title={t.upstream} isDark={isDark}>
                        <div className={inputClass}>
                            <Field
                                label={t.model}
                                value={form.modelName}
                                onChange={(value) => update('modelName', value)}
                                isDark={isDark}
                                type="text"
                            />
                            <Field
                                label={t.upstreamCredits}
                                hint={t.upstreamCreditsHint}
                                value={form.upstreamCreditsPerCny}
                                onChange={(value) => update('upstreamCreditsPerCny', value)}
                                isDark={isDark}
                            />
                            <Field
                                label={t.upstreamRatio}
                                value={form.upstreamChannelRatio}
                                onChange={(value) => update('upstreamChannelRatio', value)}
                                isDark={isDark}
                            />
                            <Field
                                label={t.markup}
                                value={form.markupPercent}
                                onChange={(value) => update('markupPercent', value)}
                                isDark={isDark}
                                step="1"
                            />
                        </div>
                    </Panel>

                    <Panel title={t.official} isDark={isDark}>
                        <div className="mb-3 text-xs text-slate-500">{t.perMillion}</div>
                        <div className={inputClass}>
                            <Field
                                label={t.input}
                                value={form.inputUsdPer1m}
                                onChange={(value) => update('inputUsdPer1m', value)}
                                isDark={isDark}
                            />
                            <Field
                                label={t.output}
                                value={form.outputUsdPer1m}
                                onChange={(value) => update('outputUsdPer1m', value)}
                                isDark={isDark}
                            />
                            <Field
                                label={t.cacheRead}
                                value={form.cacheReadUsdPer1m}
                                onChange={(value) => update('cacheReadUsdPer1m', value)}
                                isDark={isDark}
                            />
                            <Field
                                label={t.cacheWrite}
                                value={form.cacheWriteUsdPer1m}
                                onChange={(value) => update('cacheWriteUsdPer1m', value)}
                                isDark={isDark}
                            />
                        </div>
                    </Panel>

                    <Panel title={t.portal} isDark={isDark}>
                        {context && (
                            <div className={['mb-3 text-xs', muted].join(' ')}>
                                {t.usdToCny}: {decimal(context.usd_to_cny_rate, 4)}
                            </div>
                        )}
                        <div className={inputClass}>
                            <Field
                                label={t.chatFx}
                                value={form.chatFx}
                                onChange={(value) => update('chatFx', value)}
                                isDark={isDark}
                            />
                            <Field
                                label={t.quotaPerUsd}
                                value={form.quotaPerUsd}
                                onChange={(value) => update('quotaPerUsd', value)}
                                isDark={isDark}
                            />
                            <div>
                                <label className={['mb-1 block text-xs font-medium', muted].join(' ')}>{t.group}</label>
                                <select
                                    value={form.groupKey}
                                    onChange={(event) => {
                                        const group = context?.groups.find(
                                            (candidate) => candidate.key === event.target.value,
                                        );
                                        setForm((current) => ({
                                            ...current,
                                            groupKey: event.target.value,
                                            ...(group?.group_ratio != null
                                                ? { groupRatio: String(group.group_ratio) }
                                                : {}),
                                        }));
                                    }}
                                    className={[
                                        'w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40',
                                        isDark
                                            ? 'border-slate-600 bg-slate-800 text-slate-100'
                                            : 'border-slate-300 bg-white text-slate-900',
                                    ].join(' ')}
                                >
                                    {context?.groups.map((group) => (
                                        <option key={group.key} value={group.key}>
                                            {group.display_name} ({group.group_ratio ?? '?'})
                                        </option>
                                    )) ?? <option value={form.groupKey}>{form.groupKey}</option>}
                                </select>
                            </div>
                            <Field
                                label={t.groupRatio}
                                value={form.groupRatio}
                                onChange={(value) => update('groupRatio', value)}
                                isDark={isDark}
                            />
                        </div>
                    </Panel>

                    <Panel title={t.sample} isDark={isDark}>
                        <div className="mb-3 text-xs text-slate-500">{t.tokens}</div>
                        <div className={inputClass}>
                            <Field
                                label={t.input}
                                value={form.sampleInput}
                                onChange={(value) => update('sampleInput', value)}
                                isDark={isDark}
                                step="1"
                            />
                            <Field
                                label={t.output}
                                value={form.sampleOutput}
                                onChange={(value) => update('sampleOutput', value)}
                                isDark={isDark}
                                step="1"
                            />
                            <Field
                                label={t.cacheRead}
                                value={form.sampleCacheRead}
                                onChange={(value) => update('sampleCacheRead', value)}
                                isDark={isDark}
                                step="1"
                            />
                            <Field
                                label={t.cacheWrite}
                                value={form.sampleCacheWrite}
                                onChange={(value) => update('sampleCacheWrite', value)}
                                isDark={isDark}
                                step="1"
                            />
                        </div>
                    </Panel>
                </div>

                <div className="space-y-5">
                    {calculation.invalid || !result ? (
                        <div className={['rounded-xl border p-6 text-sm', card, muted].join(' ')}>{t.invalid}</div>
                    ) : (
                        <>
                            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                                {[
                                    [t.cost, money(result.upstreamCostCnyPer1m.total)],
                                    [t.retail, money(result.retailCnyPer1m.total)],
                                    [t.profit, money(result.profitCnyPer1m.total)],
                                    [
                                        t.margin,
                                        `${((result.profitCnyPer1m.total / result.retailCnyPer1m.total) * 100).toFixed(2)}%`,
                                    ],
                                ].map(([label, value]) => (
                                    <div key={label} className={['rounded-xl border p-4', card].join(' ')}>
                                        <div className={['text-xs', muted].join(' ')}>{label}</div>
                                        <div className={['mt-1 text-xl font-semibold', strong].join(' ')}>{value}</div>
                                        <div className={['mt-1 text-[11px]', muted].join(' ')}>
                                            per 1M token categories total
                                        </div>
                                    </div>
                                ))}
                            </div>

                            <Panel title={t.result} isDark={isDark}>
                                <div className="overflow-x-auto">
                                    <table className="w-full min-w-[600px] text-sm">
                                        <thead
                                            className={[
                                                'border-b text-left text-xs',
                                                isDark
                                                    ? 'border-slate-700 text-slate-400'
                                                    : 'border-slate-200 text-slate-500',
                                            ].join(' ')}
                                        >
                                            <tr>
                                                <th className="px-2 py-2 font-medium">{t.category}</th>
                                                <th className="px-2 py-2 text-right font-medium">{t.officialPrice}</th>
                                                <th className="px-2 py-2 text-right font-medium">{t.costCny}</th>
                                                <th className="px-2 py-2 text-right font-medium">{t.retailCny}</th>
                                                <th className="px-2 py-2 text-right font-medium">{t.profitCny}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {rows.map(([label, official, cost, retail, profit]) => (
                                                <tr
                                                    key={label}
                                                    className={[
                                                        'border-b last:border-0',
                                                        isDark ? 'border-slate-800' : 'border-slate-100',
                                                    ].join(' ')}
                                                >
                                                    <td className={['px-2 py-2', strong].join(' ')}>{label}</td>
                                                    <td className={['px-2 py-2 text-right', muted].join(' ')}>
                                                        ${decimal(official)}
                                                    </td>
                                                    <td className="px-2 py-2 text-right">{money(cost)}</td>
                                                    <td className="px-2 py-2 text-right font-medium">
                                                        {money(retail)}
                                                    </td>
                                                    <td className="px-2 py-2 text-right text-emerald-600">
                                                        {money(profit)}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </Panel>

                            <Panel title={t.ratio} isDark={isDark}>
                                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                                    {[
                                        [t.modelRatio, result.ratios.modelRatio],
                                        [t.completionRatio, result.ratios.completionRatio],
                                        [t.cacheRatio, result.ratios.cacheRatio],
                                        [t.createCacheRatio, result.ratios.createCacheRatio],
                                    ].map(([label, value]) => (
                                        <div
                                            key={label}
                                            className={[
                                                'rounded-lg border px-3 py-3',
                                                isDark
                                                    ? 'border-slate-700 bg-slate-800/60'
                                                    : 'border-slate-200 bg-slate-50',
                                            ].join(' ')}
                                        >
                                            <div className={['text-xs', muted].join(' ')}>{label}</div>
                                            <div
                                                className={['mt-1 font-mono text-base font-semibold', strong].join(' ')}
                                            >
                                                {decimal(Number(value))}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                                <p className={['mt-3 text-xs', muted].join(' ')}>
                                    {locale === 'en'
                                        ? 'Use the Retail ¥/1M input and output values on the Admin Pricing page. These ratios are a consistency preview; this calculator does not apply them.'
                                        : '把上面的“零售 ¥/1M”输入价和输出价填入 Admin「定价」页面。这里的倍率只是核对结果，本页面不会应用它们。'}
                                </p>
                            </Panel>

                            <Panel title={t.sampleResult} isDark={isDark}>
                                {result.sample && (
                                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                                        {[
                                            [t.sampleUpstream, money(result.sample.upstreamCostCny, 6)],
                                            [t.sampleRetail, money(result.sample.retailCny, 6)],
                                            [t.sampleProfit, money(result.sample.profitCny, 6)],
                                            [t.technicalUsd, `$${result.sample.technicalUsd.toFixed(6)}`],
                                            [t.quota, result.sample.quota.toLocaleString('en-US')],
                                        ].map(([label, value]) => (
                                            <div key={label}>
                                                <div className={['text-xs', muted].join(' ')}>{label}</div>
                                                <div className={['mt-1 font-semibold', strong].join(' ')}>{value}</div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </Panel>
                        </>
                    )}
                </div>
            </div>
        </PayPageLayout>
    );
}
