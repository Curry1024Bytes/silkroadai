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

interface OfficialPriceMatch {
    model: string;
    provider: string | null;
    inputUsdPer1m: number;
    outputUsdPer1m: number;
    cacheReadUsdPer1m: number;
    cacheWrite5mUsdPer1m: number;
    cacheWrite1hUsdPer1m: number | null;
}

interface OfficialPriceResponse {
    source: string;
    source_label: string;
    fetched_at: string;
    models: OfficialPriceMatch[];
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

function formWithLiveContext(context: CalculatorContext): FormState {
    const defaultGroup =
        context.groups.find((group) => group.key === DEFAULT_FORM.groupKey) ??
        context.groups.find((group) => group.is_default);

    return {
        ...DEFAULT_FORM,
        chatFx: String(context.chat_fx_cny_per_1m_quota),
        quotaPerUsd: String(context.quota_per_usd),
        ...(defaultGroup?.group_ratio != null
            ? { groupKey: defaultGroup.key, groupRatio: String(defaultGroup.group_ratio) }
            : {}),
    };
}

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
            subtitle: 'Estimate upstream cost, customer charge, and profit. Preview only.',
            safe: 'This calculator only estimates prices. It does not change any live setting.',
            formula: 'Cost = official price × upstream ratio ÷ credits per ¥1. Retail = cost × (1 + markup).',
            upstream: '1. Upstream cost',
            upstreamNote: 'Enter the price and rules from this upstream.',
            upstreamCredits: 'Credits from ¥1 recharge',
            upstreamCreditsHint: 'For 1:10, enter 10.',
            upstreamRatio: 'Upstream channel ratio',
            upstreamRatioHint: 'For 10x, enter 10.',
            official: 'Official token prices',
            officialNote:
                'USD per 1 million tokens. Look up a LiteLLM reference price, then verify important models against the provider.',
            officialLookup: 'Look up reference price',
            officialLookupHint: 'Searches the LiteLLM public price catalog. It does not change any live price.',
            officialLookupAction: 'Look up',
            officialLookupLoading: 'Looking up…',
            officialLookupEmpty: 'No matching token-priced model was found. You can still enter a price manually.',
            officialLookupError:
                'The reference price source is temporarily unavailable. Enter the price manually or try again.',
            officialLookupSource: 'Reference source',
            officialApply: 'Fill selected price',
            officialApplied: 'Reference price filled into this calculator. It has not been saved.',
            input: 'Input',
            output: 'Output',
            cacheRead: 'Cache read',
            cacheWrite: 'Cache write / 5m',
            group: 'Customer group',
            groupRatio: 'Current group multiplier (GroupRatio)',
            groupRatioHint: 'Usually loaded from new-api. Only edit for a simulation.',
            sales: '2. Sales plan',
            salesNote: 'Choose the group used by this customer and set your target markup.',
            markup: 'Target markup (%)',
            portal: 'Advanced system values',
            chatFx: 'CNY value of 1M quota',
            quotaPerUsd: 'Quota per technical billing unit',
            usdToCny: 'Portal billing unit to CNY',
            sample: '3. Verify with a real request',
            sampleNote: 'Optional. Enter a request log to check its expected deduction.',
            tokens: 'Token count',
            model: 'Model label',
            result: 'Token price comparison',
            resultNote: 'Each row is a separate price per 1 million tokens; they are not added together.',
            cost: 'Upstream cost',
            retail: 'Customer charge',
            profit: 'Profit',
            margin: 'Margin',
            ratio: 'Advanced new-api check',
            ratioNote: 'These values only verify current new-api pricing. This page does not save them.',
            sampleResult: 'Expected deduction for this request',
            category: 'Token type',
            officialPrice: 'Official $/1M',
            costCny: 'Cost ¥/1M',
            retailCny: 'Charge ¥/1M',
            profitCny: 'Profit ¥/1M',
            modelRatio: 'Input multiplier (ModelRatio)',
            completionRatio: 'Output multiplier (CompletionRatio)',
            cacheRatio: 'Cache read multiplier (CacheRatio)',
            createCacheRatio: 'Cache write multiplier',
            sampleUpstream: 'Upstream cost',
            sampleRetail: 'Customer charge',
            sampleProfit: 'Profit',
            technicalUnit: 'Technical billing units',
            quota: 'Deducted quota',
            reset: 'Reset',
            resetComplete: 'Default sample restored.',
            loadingContext: 'Loading current group settings…',
            contextError: 'Current group settings are unavailable; editable defaults are being used.',
            invalid: 'Enter valid positive prices and ratios to calculate.',
            note: 'Use the charge column when entering prices in Admin → Pricing.',
            advanced: 'Advanced settings',
        };
    }
    return {
        title: '定价计算器',
        subtitle: '算清上游成本、用户扣费和利润，只做预览',
        safe: '本页只计算，不会保存或修改任何线上价格。',
        formula: '成本 = 官方价格 × 上游渠道倍率 ÷ 充值 ¥1 获得的额度；售价 = 成本 ×（1 + 加价率）。',
        upstream: '1. 填上游成本',
        upstreamNote: '按当前上游的充值规则、渠道倍率和模型价格填写。',
        upstreamCredits: '充值 ¥1 获得上游额度',
        upstreamCreditsHint: '例如 1:10 就填 10',
        upstreamRatio: '上游渠道倍率',
        upstreamRatioHint: '例如 10x 就填 10',
        official: '官方 Token 价格',
        officialNote: '单位均为 美元 / 100 万 token。可查询 LiteLLM 基准价；重点模型仍请与厂商官方价格核对。',
        officialLookup: '查询官方基准价',
        officialLookupHint: '查询 LiteLLM 公开价格表，只会填入当前计算器，不会修改任何线上价格。',
        officialLookupAction: '查询',
        officialLookupLoading: '查询中…',
        officialLookupEmpty: '没有找到可按 Token 计价的匹配模型，仍可手动填写。',
        officialLookupError: '官方基准价数据暂时不可用，请稍后重试或手动填写。',
        officialLookupSource: '基准价来源',
        officialApply: '填入选中价格',
        officialApplied: '已填入当前计算器，尚未保存或修改任何线上价格。',
        input: '普通输入',
        output: '输出',
        cacheRead: '缓存读取',
        cacheWrite: '缓存写入 / 5 分钟',
        group: '用户销售分组',
        groupRatio: '当前分组倍率（GroupRatio）',
        groupRatioHint: '通常自动从 new-api 读取；仅临时模拟时才手动修改。',
        sales: '2. 设置售价',
        salesNote: '选择用户所在分组，再填期望加价率。',
        markup: '目标加价率 (%)',
        portal: '高级：系统换算参数',
        chatFx: '每 100 万 quota 对应人民币',
        quotaPerUsd: '每技术计费单位对应 quota',
        usdToCny: 'Portal 计费单位兑人民币',
        sample: '3. 用真实请求核对',
        sampleNote: '可选。填入一条日志的 Token 数，核对预计扣费。',
        tokens: 'Token 数量',
        model: '模型名称',
        result: '每类 Token 单价对照',
        resultNote: '每行都是单独的“每 100 万 token”价格，不能相加。',
        cost: '上游成本',
        retail: '用户扣费',
        profit: '利润',
        margin: '毛利率',
        ratio: '高级：new-api 核对值',
        ratioNote: '只用于核对当前 new-api 定价，不会自动保存或修改。',
        sampleResult: '这条请求预计扣费',
        category: 'Token 类型',
        officialPrice: '官方价格（美元/百万）',
        costCny: '成本（元/百万）',
        retailCny: '用户扣费（元/百万）',
        profitCny: '利润（元/百万）',
        modelRatio: '输入倍率（ModelRatio）',
        completionRatio: '输出倍率（CompletionRatio）',
        cacheRatio: '缓存读取倍率（CacheRatio）',
        createCacheRatio: '缓存写入倍率',
        sampleUpstream: '上游成本',
        sampleRetail: '用户扣费',
        sampleProfit: '利润',
        technicalUnit: '技术计费单位',
        quota: '实际扣减 quota',
        reset: '重置',
        resetComplete: '已恢复默认计算样例。',
        loadingContext: '正在读取当前分组设置…',
        contextError: '无法读取当前分组设置，已使用可编辑的默认值。',
        invalid: '请输入有效的正数价格和倍率后再计算。',
        note: '将“用户扣费 ¥/1M”一列填入 Admin「定价」页面。',
        advanced: '高级参数',
    };
}

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

function Panel({
    title,
    note,
    children,
    isDark,
}: {
    title: string;
    note?: string;
    children: ReactNode;
    isDark: boolean;
}) {
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
            {note && (
                <p className={['-mt-2 mb-4 text-xs leading-5', isDark ? 'text-slate-400' : 'text-slate-500'].join(' ')}>
                    {note}
                </p>
            )}
            {children}
        </section>
    );
}

function OfficialPriceDetail({
    model,
    locale,
    muted,
}: {
    model: OfficialPriceMatch | null;
    locale: Locale;
    muted: string;
}) {
    if (!model) return null;
    const labels =
        locale === 'zh'
            ? {
                  input: '普通输入',
                  output: '输出',
                  cacheRead: '缓存读取',
                  cacheWrite5m: '缓存写入 5 分钟',
                  cacheWrite1h: '缓存写入 1 小时',
              }
            : {
                  input: 'Input',
                  output: 'Output',
                  cacheRead: 'Cache read',
                  cacheWrite5m: 'Cache write 5m',
                  cacheWrite1h: 'Cache write 1h',
              };
    const rows: Array<readonly [string, number]> = [
        [labels.input, model.inputUsdPer1m],
        [labels.output, model.outputUsdPer1m],
        [labels.cacheRead, model.cacheReadUsdPer1m],
        [labels.cacheWrite5m, model.cacheWrite5mUsdPer1m],
        ...(model.cacheWrite1hUsdPer1m === null ? [] : [[labels.cacheWrite1h, model.cacheWrite1hUsdPer1m] as const]),
    ];

    return (
        <div className={['grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]', muted].join(' ')}>
            {rows.map(([label, value]) => (
                <span key={label}>
                    {label}: ${decimal(value, 6)} / 1M
                </span>
            ))}
        </div>
    );
}

export default function PricingCalculatorPage() {
    const searchParams = useSearchParams();
    const locale = resolveLocale(searchParams.get('lang'));
    const isDark = searchParams.get('theme') === 'dark';
    const t = getTexts(locale);
    const [form, setForm] = useState<FormState>(DEFAULT_FORM);
    const [resetForm, setResetForm] = useState<FormState>(DEFAULT_FORM);
    const [resetComplete, setResetComplete] = useState(false);
    const [context, setContext] = useState<CalculatorContext | null>(null);
    const [contextError, setContextError] = useState(false);
    const [officialMatches, setOfficialMatches] = useState<OfficialPriceMatch[]>([]);
    const [selectedOfficialModel, setSelectedOfficialModel] = useState('');
    const [officialSource, setOfficialSource] = useState<string | null>(null);
    const [officialLoading, setOfficialLoading] = useState(false);
    const [officialLookupError, setOfficialLookupError] = useState(false);
    const [officialLookupComplete, setOfficialLookupComplete] = useState(false);
    const [officialApplied, setOfficialApplied] = useState(false);

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
                const nextForm = formWithLiveContext(next);
                setForm(nextForm);
                setResetForm(nextForm);
            })
            .catch(() => {
                if (!cancelled) setContextError(true);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const update = useCallback((key: keyof FormState, value: string) => {
        setResetComplete(false);
        setForm((current) => ({ ...current, [key]: value }));
    }, []);

    async function lookupOfficialPrice() {
        const query = form.modelName.trim();
        if (!query) return;
        setOfficialLoading(true);
        setOfficialLookupError(false);
        setOfficialLookupComplete(false);
        setOfficialApplied(false);
        try {
            const response = await fetch(
                `/api/admin/pricing-calculator/official-prices?q=${encodeURIComponent(query)}`,
                { credentials: 'same-origin' },
            );
            if (!response.ok) throw new Error('official price request failed');
            const body = (await response.json()) as OfficialPriceResponse;
            setOfficialMatches(body.models);
            setSelectedOfficialModel(body.models[0]?.model ?? '');
            const fetchedAt = new Date(body.fetched_at);
            setOfficialSource(
                `${body.source_label}${Number.isNaN(fetchedAt.getTime()) ? '' : ` · ${fetchedAt.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}`}`,
            );
            setOfficialLookupComplete(true);
        } catch {
            setOfficialMatches([]);
            setSelectedOfficialModel('');
            setOfficialSource(null);
            setOfficialLookupError(true);
        } finally {
            setOfficialLoading(false);
        }
    }

    const applyOfficialPrice = useCallback(() => {
        const selected = officialMatches.find((model) => model.model === selectedOfficialModel);
        if (!selected) return;
        setResetComplete(false);
        setForm((current) => ({
            ...current,
            inputUsdPer1m: String(selected.inputUsdPer1m),
            outputUsdPer1m: String(selected.outputUsdPer1m),
            cacheReadUsdPer1m: String(selected.cacheReadUsdPer1m),
            cacheWriteUsdPer1m: String(selected.cacheWrite5mUsdPer1m),
        }));
        setOfficialApplied(true);
    }, [officialMatches, selectedOfficialModel]);

    const calculation = useMemo((): { result: PricingCalculatorResult | null; invalid: boolean } => {
        const input = buildInput(form);
        if (!input) return { result: null, invalid: true };
        try {
            return { result: calculatePricing(input), invalid: false };
        } catch {
            return { result: null, invalid: true };
        }
    }, [form]);

    const reset = () => {
        setForm({ ...resetForm });
        setResetComplete(true);
    };
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
                    data-testid="pricing-calculator-reset"
                    className={[
                        'relative z-10 inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60',
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

            <div
                className={[
                    'mb-5 rounded-lg border px-4 py-3 text-xs leading-5',
                    isDark
                        ? 'border-slate-700 bg-slate-900/60 text-slate-300'
                        : 'border-slate-200 bg-slate-50 text-slate-600',
                ].join(' ')}
            >
                {t.formula}
            </div>

            {resetComplete && (
                <p className={['-mt-2 mb-4 text-sm text-emerald-700', isDark ? 'text-emerald-300' : ''].join(' ')}>
                    {t.resetComplete}
                </p>
            )}

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
                    <Panel title={t.upstream} note={t.upstreamNote} isDark={isDark}>
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
                                hint={t.upstreamRatioHint}
                                value={form.upstreamChannelRatio}
                                onChange={(value) => update('upstreamChannelRatio', value)}
                                isDark={isDark}
                            />
                        </div>
                    </Panel>

                    <Panel title={t.official} note={t.officialNote} isDark={isDark}>
                        <div
                            className={[
                                'mb-4 rounded-lg border p-3',
                                isDark ? 'border-slate-700 bg-slate-800/60' : 'border-slate-200 bg-slate-50',
                            ].join(' ')}
                        >
                            <div className={['mb-2 text-xs font-medium', strong].join(' ')}>{t.officialLookup}</div>
                            <p className={['mb-3 text-[11px] leading-5', muted].join(' ')}>{t.officialLookupHint}</p>
                            <button
                                type="button"
                                onClick={() => void lookupOfficialPrice()}
                                disabled={officialLoading || !form.modelName.trim()}
                                className={[
                                    'inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                                    isDark
                                        ? 'border-emerald-700 bg-emerald-950/50 text-emerald-300 hover:bg-emerald-900/60'
                                        : 'border-emerald-700 bg-white text-emerald-800 hover:bg-emerald-50',
                                ].join(' ')}
                            >
                                {officialLoading ? t.officialLookupLoading : t.officialLookupAction}
                            </button>

                            {officialLookupError && (
                                <p className="mt-3 text-xs text-rose-600">{t.officialLookupError}</p>
                            )}
                            {officialLookupComplete && officialMatches.length === 0 && (
                                <p className={['mt-3 text-xs', muted].join(' ')}>{t.officialLookupEmpty}</p>
                            )}
                            {officialMatches.length > 0 && (
                                <div className="mt-3 space-y-2">
                                    <select
                                        value={selectedOfficialModel}
                                        onChange={(event) => {
                                            setSelectedOfficialModel(event.target.value);
                                            setOfficialApplied(false);
                                        }}
                                        aria-label={t.officialLookup}
                                        className={[
                                            'w-full rounded-md border px-2.5 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/40',
                                            isDark
                                                ? 'border-slate-600 bg-slate-800 text-slate-100'
                                                : 'border-slate-300 bg-white text-slate-900',
                                        ].join(' ')}
                                    >
                                        {officialMatches.map((model) => (
                                            <option key={model.model} value={model.model}>
                                                {model.model} · ${model.inputUsdPer1m}/${model.outputUsdPer1m} / 1M
                                            </option>
                                        ))}
                                    </select>
                                    <button
                                        type="button"
                                        onClick={applyOfficialPrice}
                                        className={[
                                            'inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium transition-colors',
                                            isDark
                                                ? 'border-slate-600 text-slate-200 hover:bg-slate-700'
                                                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100',
                                        ].join(' ')}
                                    >
                                        {t.officialApply}
                                    </button>
                                    {officialSource && (
                                        <p className={['text-[11px] leading-5', muted].join(' ')}>
                                            {t.officialLookupSource}: {officialSource}
                                        </p>
                                    )}
                                    {selectedOfficialModel && (
                                        <OfficialPriceDetail
                                            model={
                                                officialMatches.find(
                                                    (model) => model.model === selectedOfficialModel,
                                                ) ?? null
                                            }
                                            locale={locale}
                                            muted={muted}
                                        />
                                    )}
                                </div>
                            )}
                            {officialApplied && (
                                <p className="mt-3 text-xs text-emerald-700 dark:text-emerald-300">
                                    {t.officialApplied}
                                </p>
                            )}
                        </div>
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

                    <Panel title={t.sales} note={t.salesNote} isDark={isDark}>
                        <div className={inputClass}>
                            <div>
                                <label className={['mb-1 block text-xs font-medium', muted].join(' ')}>{t.group}</label>
                                <select
                                    value={form.groupKey}
                                    onChange={(event) => {
                                        const group = context?.groups.find(
                                            (candidate) => candidate.key === event.target.value,
                                        );
                                        setResetComplete(false);
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
                                label={t.markup}
                                value={form.markupPercent}
                                onChange={(value) => update('markupPercent', value)}
                                isDark={isDark}
                                step="1"
                            />
                        </div>
                    </Panel>

                    <details
                        className={[
                            'rounded-xl border p-4',
                            isDark ? 'border-slate-700 bg-slate-900/70' : 'border-slate-200 bg-white shadow-sm',
                        ].join(' ')}
                    >
                        <summary
                            className={[
                                'cursor-pointer text-sm font-semibold',
                                isDark ? 'text-slate-100' : 'text-slate-900',
                            ].join(' ')}
                        >
                            {t.advanced}
                        </summary>
                        <div className="mt-4">
                            <p className={['mb-4 text-xs leading-5', muted].join(' ')}>{t.portal}</p>
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
                                <Field
                                    label={t.groupRatio}
                                    hint={t.groupRatioHint}
                                    value={form.groupRatio}
                                    onChange={(value) => update('groupRatio', value)}
                                    isDark={isDark}
                                />
                            </div>
                        </div>
                    </details>

                    <Panel title={t.sample} note={t.sampleNote} isDark={isDark}>
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
                            <Panel title={t.sampleResult} isDark={isDark}>
                                {result.sample && (
                                    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                                        {[
                                            [t.sampleUpstream, money(result.sample.upstreamCostCny, 6)],
                                            [t.sampleRetail, money(result.sample.retailCny, 6)],
                                            [t.sampleProfit, money(result.sample.profitCny, 6)],
                                            [t.margin, `${(result.sample.marginRate * 100).toFixed(2)}%`],
                                        ].map(([label, value], index) => (
                                            <div key={label}>
                                                <div className={['text-xs', muted].join(' ')}>{label}</div>
                                                <div
                                                    className={[
                                                        'mt-1 text-lg font-semibold',
                                                        index === 1
                                                            ? isDark
                                                                ? 'text-emerald-300'
                                                                : 'text-emerald-700'
                                                            : strong,
                                                    ].join(' ')}
                                                >
                                                    {value}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </Panel>

                            <Panel title={t.result} note={t.resultNote} isDark={isDark}>
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

                            <details
                                className={[
                                    'rounded-xl border p-4',
                                    isDark ? 'border-slate-700 bg-slate-900/70' : 'border-slate-200 bg-white shadow-sm',
                                ].join(' ')}
                            >
                                <summary
                                    className={[
                                        'cursor-pointer text-sm font-semibold',
                                        isDark ? 'text-slate-100' : 'text-slate-900',
                                    ].join(' ')}
                                >
                                    {t.ratio}
                                </summary>
                                <p className={['mb-4 mt-3 text-xs leading-5', muted].join(' ')}>{t.ratioNote}</p>
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
                                {result.sample && (
                                    <p className={['mt-4 text-xs leading-5', muted].join(' ')}>
                                        {t.technicalUnit}: {result.sample.technicalUnit.toFixed(6)} · {t.quota}:{' '}
                                        {result.sample.quota.toLocaleString('en-US')}
                                    </p>
                                )}
                            </details>
                        </>
                    )}
                </div>
            </div>
        </PayPageLayout>
    );
}
