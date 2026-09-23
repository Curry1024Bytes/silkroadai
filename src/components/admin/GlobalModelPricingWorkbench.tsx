'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Locale } from '@/lib/locale';
import type {
    GlobalModelBaseInput,
    GlobalModelPriceInfo,
    OfficialPriceQuoteSnapshot,
} from '@/lib/admin/global-model-pricing-types';
import type { PricingPublishJob, PricingPublishPreview } from '@/lib/admin/pricing-publish-types';
import { PricingPublishPreviewDetails } from '@/components/admin/PricingPublishDialog';

interface PreparedGlobalModelPricing {
    input: GlobalModelBaseInput;
    preview: PricingPublishPreview & { global_quote_snapshot?: OfficialPriceQuoteSnapshot };
}

interface GlobalModelPricingWorkbenchProps {
    isDark: boolean;
    locale: Locale;
    onPublished: (job: PricingPublishJob) => void;
    onUncertain: (message?: string) => void;
}

async function readResponse(response: Response, en: boolean): Promise<Record<string, unknown>> {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const message =
            typeof data.message === 'string'
                ? data.message
                : typeof data.error === 'string'
                  ? data.error
                  : response.status === 401
                    ? en
                        ? 'Your session has expired. Please sign in again.'
                        : '登录已过期，请重新登录。'
                    : en
                      ? 'The request could not be completed. Refresh and try again.'
                      : '请求未完成，请刷新后重试。';
        throw new Error(message);
    }
    return data as Record<string, unknown>;
}

async function fetchGlobalModels(en: boolean): Promise<GlobalModelPriceInfo[]> {
    const response = await fetch('/api/admin/pricing/global-model', { credentials: 'same-origin' });
    const data = await readResponse(response, en);
    return Array.isArray(data.models) ? (data.models as GlobalModelPriceInfo[]) : [];
}

async function requestGlobalPreview(
    input: Pick<GlobalModelBaseInput, 'model_id'>,
    en: boolean,
): Promise<PreparedGlobalModelPricing> {
    const response = await fetch('/api/admin/pricing/global-model', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'preview', ...input }),
    });
    const data = await readResponse(response, en);
    const preview = data.preview as PreparedGlobalModelPricing['preview'] | undefined;
    if (!preview?.preview_token || !Array.isArray(preview.rows) || !Array.isArray(preview.warnings)) {
        throw new Error(en ? 'The preview response is invalid.' : '预览响应无效，请重新尝试。');
    }
    const quote = preview.global_quote_snapshot;
    if (!quote) throw new Error(en ? 'The quote is missing from the preview.' : '预览没有返回报价快照，请重新查询。');
    return {
        input: {
            model_id: input.model_id,
            base_input_cny_per_1m: null,
            base_output_cny_per_1m: null,
            base_per_image_cny: null,
            official_quote: quote,
        },
        preview,
    };
}

async function requestGlobalPublish(prepared: PreparedGlobalModelPricing, en: boolean): Promise<PricingPublishJob> {
    if (Date.parse(prepared.preview.expires_at) <= Date.now()) {
        throw new Error(en ? 'This preview has expired. Preview again.' : '预览已过期，请重新生成预览。');
    }
    const response = await fetch('/api/admin/pricing/global-model', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'publish', preview_token: prepared.preview.preview_token, ...prepared.input }),
    });
    const data = await readResponse(response, en);
    const job = data.job as PricingPublishJob | undefined;
    if (!job?.id || !job.status)
        throw new Error(en ? 'The publication response is invalid.' : '发布响应无效，请刷新任务列表。');
    return job;
}

function money(value: number | null | undefined, en: boolean): string {
    if (value === null || value === undefined) return en ? 'Not set' : '未设置';
    return `¥${value.toLocaleString(en ? 'en-US' : 'zh-CN', { maximumFractionDigits: 12 })}`;
}

function usd(value: number | null, en: boolean): string {
    if (value === null) return en ? 'Not listed' : '未列出';
    return new Intl.NumberFormat(en ? 'en-US' : 'zh-CN', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 8,
    }).format(value);
}

function QuoteSnapshotDetails({
    quote,
    en,
    isDark,
}: {
    quote: OfficialPriceQuoteSnapshot;
    en: boolean;
    isDark: boolean;
}) {
    const rows: Array<[string, number | null, number | null]> = [
        [en ? 'Input' : '输入', quote.input_usd_per_1m, quote.input_cny_per_1m],
        [en ? 'Output' : '输出', quote.output_usd_per_1m, quote.output_cny_per_1m],
        [en ? 'Cache read' : '缓存读取', quote.cache_read_usd_per_1m, quote.cache_read_cny_per_1m],
        [
            en ? 'Cache write · 5m' : '缓存写入 · 5 分钟',
            quote.cache_write_5m_usd_per_1m,
            quote.cache_write_5m_cny_per_1m,
        ],
        [
            en ? 'Cache write · 1h' : '缓存写入 · 1 小时',
            quote.cache_write_1h_usd_per_1m,
            quote.cache_write_1h_cny_per_1m,
        ],
    ].filter((row): row is [string, number | null, number | null] => row[1] !== null);

    return (
        <div
            className={`space-y-3 rounded-lg border p-3 ${isDark ? 'border-slate-700 bg-slate-950/50' : 'border-slate-200 bg-white'}`}
        >
            <div>
                <h4 className="text-sm font-semibold">
                    {en ? 'LiteLLM aggregated reference quote' : 'LiteLLM 聚合参考报价'}
                </h4>
                <p className={`mt-1 text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                    {en
                        ? 'This is an aggregated reference catalog entry, not a direct live quote from the provider.'
                        : '这是聚合参考目录数据，不是向模型厂商实时直连查询的报价。'}
                </p>
            </div>
            <dl
                className={`grid grid-cols-1 gap-x-5 gap-y-2 text-sm sm:grid-cols-2 ${isDark ? 'text-slate-200' : 'text-slate-800'}`}
            >
                <div>
                    <dt className="text-xs text-slate-500">{en ? 'Provider' : 'Provider'}</dt>
                    <dd>{quote.provider ?? (en ? 'Not specified' : '未标注')}</dd>
                </div>
                <div>
                    <dt className="text-xs text-slate-500">{en ? 'Source' : '来源'}</dt>
                    <dd>{quote.source_label}</dd>
                </div>
                <div>
                    <dt className="text-xs text-slate-500">{en ? 'Fetched at' : '抓取时间'}</dt>
                    <dd>{new Date(quote.fetched_at).toLocaleString(en ? 'en-US' : 'zh-CN')}</dd>
                </div>
                <div>
                    <dt className="text-xs text-slate-500">{en ? 'Conversion rate' : '换算汇率'}</dt>
                    <dd>1 USD = {quote.usd_to_cny_rate} CNY</dd>
                </div>
            </dl>
            <div className="overflow-x-auto">
                <table className="w-full min-w-[28rem] text-left text-xs">
                    <thead className={isDark ? 'text-slate-400' : 'text-slate-500'}>
                        <tr>
                            <th className="py-1 pr-3 font-medium">
                                {en ? 'Rate · per 1M tokens' : '单价 · 每百万 token'}
                            </th>
                            <th className="py-1 pr-3 font-medium">USD</th>
                            <th className="py-1 font-medium">CNY · GroupRatio = 1</th>
                        </tr>
                    </thead>
                    <tbody className={isDark ? 'text-slate-200' : 'text-slate-800'}>
                        {rows.map(([label, usdValue, cnyValue]) => (
                            <tr key={label}>
                                <th className="py-1 pr-3 font-normal">{label}</th>
                                <td className="py-1 pr-3 tabular-nums">{usd(usdValue, en)}</td>
                                <td className="py-1 tabular-nums">{money(cnyValue, en)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

export default function GlobalModelPricingWorkbench({
    isDark,
    locale,
    onPublished,
    onUncertain,
}: GlobalModelPricingWorkbenchProps) {
    const en = locale === 'en';
    const [models, setModels] = useState<GlobalModelPriceInfo[]>([]);
    const [modelId, setModelId] = useState('');
    const [prepared, setPrepared] = useState<PreparedGlobalModelPricing | null>(null);
    const [confirmed, setConfirmed] = useState(false);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<'preview' | 'publish' | null>(null);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [now, setNow] = useState(() => Date.now());
    const selected = useMemo(() => models.find((model) => model.id === modelId), [models, modelId]);
    const valid = Boolean(selected && selected.billing_mode !== 'request');
    const expired = prepared ? Date.parse(prepared.preview.expires_at) <= now : false;

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const rows = await fetchGlobalModels(en);
            setModels(rows);
            setModelId((current) => (rows.some((row) => row.id === current) ? current : (rows[0]?.id ?? '')));
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : en
                      ? 'Failed to load global model prices.'
                      : '加载模型官方基础价失败。',
            );
        } finally {
            setLoading(false);
        }
    }, [en]);

    useEffect(() => {
        void load();
    }, [load]);

    useEffect(() => {
        setPrepared(null);
        setConfirmed(false);
        setNotice('');
        setNow(Date.now());
    }, [selected]);

    const classes = {
        panel: isDark ? 'border-slate-700 bg-slate-800/70' : 'border-slate-200 bg-white shadow-sm',
        input: `min-h-11 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500 ${isDark ? 'border-slate-600 bg-slate-900 text-slate-100' : 'border-slate-300 bg-white text-slate-900'}`,
        muted: isDark ? 'text-slate-400' : 'text-slate-600',
        label: `mb-1 block text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`,
        button: `min-h-11 rounded-lg border px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${isDark ? 'border-slate-600 text-slate-200 hover:bg-slate-800' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`,
        primary:
            'min-h-11 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:cursor-not-allowed disabled:opacity-50',
        warning: `rounded-lg border p-3 text-sm leading-relaxed ${isDark ? 'border-amber-800 bg-amber-950/30 text-amber-200' : 'border-amber-200 bg-amber-50 text-amber-900'}`,
    };

    async function preview() {
        if (!selected || selected.billing_mode === 'request' || !valid || busy) return;
        setBusy('preview');
        setError('');
        setNotice('');
        setConfirmed(false);
        try {
            setPrepared(await requestGlobalPreview({ model_id: selected.id }, en));
            setNow(Date.now());
        } catch (caught) {
            setError(
                caught instanceof Error ? caught.message : en ? 'Could not generate the preview.' : '生成预览失败。',
            );
        } finally {
            setBusy(null);
        }
    }

    async function publish() {
        if (!prepared || !confirmed || expired || busy) return;
        setBusy('publish');
        setError('');
        setNotice('');
        try {
            const job = await requestGlobalPublish(prepared, en);
            onPublished(job);
        } catch (caught) {
            const message = caught instanceof Error ? caught.message : undefined;
            onUncertain(message);
        } finally {
            setBusy(null);
        }
    }

    return (
        <section className={`space-y-5 rounded-xl border p-4 sm:p-5 ${classes.panel}`}>
            <div>
                <h2 className="text-base font-semibold">{en ? 'Global model base price' : '模型全局基础价'}</h2>
                <p className={`mt-1 text-sm leading-relaxed ${classes.muted}`}>
                    {en
                        ? 'Token prices are queried from LiteLLM’s aggregated reference catalog. Each tier price is then calculated from the CNY base and its new-api GroupRatio.'
                        : 'Token 价格通过 LiteLLM 聚合参考目录查询，再按 new-api 各分组的 GroupRatio 计算档次售价。'}
                </p>
            </div>

            {error && (
                <div className={classes.warning} role="alert">
                    {error}
                </div>
            )}
            {notice && (
                <div
                    className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"
                    role="status"
                >
                    {notice}
                </div>
            )}

            {loading ? (
                <p className={classes.muted}>{en ? 'Loading models…' : '加载模型中…'}</p>
            ) : models.length === 0 ? (
                <p className={classes.muted}>{en ? 'No enabled model is available.' : '暂无可维护的启用模型。'}</p>
            ) : (
                <>
                    <div>
                        <label className={classes.label} htmlFor="global-model-select">
                            {en ? 'Model' : '模型'}
                        </label>
                        <select
                            id="global-model-select"
                            value={modelId}
                            onChange={(event) => setModelId(event.target.value)}
                            className={classes.input}
                            disabled={busy !== null}
                        >
                            {models.map((model) => (
                                <option key={model.id} value={model.id}>
                                    {model.display_name} · {model.slug}
                                </option>
                            ))}
                        </select>
                    </div>

                    {selected && (
                        <div
                            className={`rounded-lg border p-3 text-sm ${isDark ? 'border-slate-700 bg-slate-900/60' : 'border-slate-200 bg-slate-50'}`}
                        >
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                <span className="font-medium">{selected.display_name}</span>
                                <span className={classes.muted}>{selected.upstream_model}</span>
                                <span
                                    className={`rounded-full px-2 py-0.5 text-xs ${isDark ? 'bg-slate-700 text-slate-200' : 'bg-slate-200 text-slate-600'}`}
                                >
                                    {selected.billing_mode === 'request'
                                        ? en
                                            ? 'Per request'
                                            : '按次'
                                        : selected.billing_mode === 'tiered_expr'
                                          ? en
                                              ? 'Tiered expression'
                                              : '阶梯表达式'
                                          : en
                                            ? 'Token'
                                            : 'Token'}
                                </span>
                            </div>
                            <p className={`mt-2 text-xs ${classes.muted}`}>
                                {en ? 'Current base at GroupRatio = 1: ' : '当前 GroupRatio = 1 基础价：'}
                                {selected.billing_mode === 'request'
                                    ? money(selected.base_per_image_cny, en) + (en ? ' / request' : ' / 次')
                                    : `${money(selected.base_input_cny_per_1m, en)} input · ${money(selected.base_output_cny_per_1m, en)} output`}
                            </p>
                        </div>
                    )}

                    {selected?.billing_mode === 'request' ? (
                        <p className={classes.warning}>
                            {en
                                ? 'Official lookup is unavailable for request-priced models. This catalog provides token rates only, so this workflow cannot publish their prices.'
                                : '按次/图片模型暂不支持此处的官方报价查询。当前目录只提供 Token 单价，因此本工作流不会发布这类模型价格。'}
                        </p>
                    ) : (
                        <p className={`text-sm leading-relaxed ${classes.muted}`}>
                            {en
                                ? 'The lookup uses the exact upstream model name. A missing or ambiguous match stops publication.'
                                : '查询使用档次映射中的精确上游模型名；没有唯一匹配时会停止发布，不会猜测其他模型报价。'}
                        </p>
                    )}

                    <div className={classes.warning}>
                        {en
                            ? 'This page changes the shared official model base only. GroupRatio, recharge credits, supplier multiplier and retail multiplier are maintained in separate workflows.'
                            : 'LiteLLM 提供模型基础参考价，档次售价由 GroupRatio 推导。此处不会修改任何 GroupRatio、充值额度或上游倍率。'}
                    </div>

                    {prepared && (
                        <div
                            className={`space-y-4 rounded-xl border p-4 ${isDark ? 'border-emerald-800 bg-slate-900/40' : 'border-emerald-200 bg-emerald-50/30'}`}
                        >
                            <h3 className="text-base font-semibold">
                                {en ? 'Review global publication impact' : '核对全局基础价发布影响'}
                            </h3>
                            {prepared.preview.global_quote_snapshot && (
                                <QuoteSnapshotDetails
                                    quote={prepared.preview.global_quote_snapshot}
                                    en={en}
                                    isDark={isDark}
                                />
                            )}
                            <PricingPublishPreviewDetails preview={prepared.preview} en={en} isDark={isDark} />
                            <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-relaxed">
                                <input
                                    type="checkbox"
                                    checked={confirmed}
                                    disabled={expired}
                                    onChange={(event) => setConfirmed(event.target.checked)}
                                    className="mt-1 h-5 w-5 shrink-0 accent-emerald-600"
                                />
                                <span>
                                    {en
                                        ? 'I confirm this reference quote and understand the resulting prices affect every linked tier.'
                                        : '我确认采用这份参考报价，并已了解计算后的价格会影响所有关联档次。'}
                                </span>
                            </label>
                            {expired && (
                                <p className={classes.warning}>
                                    {en
                                        ? 'This preview expired. Generate a new preview before publishing.'
                                        : '预览已过期，请重新生成后发布。'}
                                </p>
                            )}
                            <button
                                type="button"
                                className={classes.primary}
                                disabled={!confirmed || expired || busy !== null}
                                onClick={() => void publish()}
                            >
                                {busy === 'publish'
                                    ? en
                                        ? 'Submitting…'
                                        : '正在提交…'
                                    : en
                                      ? 'Confirm and submit publication task'
                                      : '确认并提交发布任务'}
                            </button>
                        </div>
                    )}

                    <button
                        type="button"
                        className={classes.primary}
                        disabled={!selected || !valid || busy !== null}
                        onClick={() => void preview()}
                    >
                        {busy === 'preview'
                            ? en
                                ? 'Preparing preview…'
                                : '正在生成预览…'
                            : selected?.billing_mode === 'request'
                              ? en
                                  ? 'Request pricing unsupported'
                                  : '按次价格暂不支持查询'
                              : en
                                ? 'Query LiteLLM price and preview'
                                : '查询 LiteLLM 报价并预览'}
                    </button>
                </>
            )}
        </section>
    );
}
