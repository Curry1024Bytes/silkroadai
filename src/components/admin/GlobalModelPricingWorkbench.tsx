'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Locale } from '@/lib/locale';
import type { GlobalModelBaseInput, GlobalModelPriceInfo } from '@/lib/admin/global-model-pricing-types';
import type { PricingPublishJob, PricingPublishPreview } from '@/lib/admin/pricing-publish-types';
import { PricingPublishPreviewDetails } from '@/components/admin/PricingPublishDialog';

interface PreparedGlobalModelPricing {
    input: GlobalModelBaseInput;
    preview: PricingPublishPreview;
}

interface GlobalModelPricingWorkbenchProps {
    isDark: boolean;
    locale: Locale;
    onPublished: (job: PricingPublishJob) => void;
    onUncertain: (message?: string) => void;
}

type FieldKey =
    | 'base_input_cny_per_1m'
    | 'base_output_cny_per_1m'
    | 'base_per_image_cny'
    | 'base_cache_read_cny_per_1m'
    | 'base_cache_write_cny_per_1m'
    | 'base_cache_write_1h_cny_per_1m';

type Draft = Record<FieldKey, string>;

const fieldKeys: FieldKey[] = [
    'base_input_cny_per_1m',
    'base_output_cny_per_1m',
    'base_per_image_cny',
    'base_cache_read_cny_per_1m',
    'base_cache_write_cny_per_1m',
    'base_cache_write_1h_cny_per_1m',
];

function emptyDraft(): Draft {
    return Object.fromEntries(fieldKeys.map((key) => [key, ''])) as Draft;
}

function numberOrNull(value: string): number | null {
    if (value.trim() === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function numberOrUndefined(value: string): number | undefined {
    if (value.trim() === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function draftFromModel(model: GlobalModelPriceInfo | undefined): Draft {
    if (!model) return emptyDraft();
    const value = (key: FieldKey) => {
        const current = model[key];
        return current === null || current === undefined ? '' : String(current);
    };
    return Object.fromEntries(fieldKeys.map((key) => [key, value(key)])) as Draft;
}

function toInput(modelId: string, draft: Draft): GlobalModelBaseInput {
    return {
        model_id: modelId,
        base_input_cny_per_1m: numberOrNull(draft.base_input_cny_per_1m),
        base_output_cny_per_1m: numberOrNull(draft.base_output_cny_per_1m),
        base_per_image_cny: numberOrNull(draft.base_per_image_cny),
        ...(draft.base_cache_read_cny_per_1m.trim() !== ''
            ? { base_cache_read_cny_per_1m: numberOrUndefined(draft.base_cache_read_cny_per_1m) }
            : {}),
        ...(draft.base_cache_write_cny_per_1m.trim() !== ''
            ? { base_cache_write_cny_per_1m: numberOrUndefined(draft.base_cache_write_cny_per_1m) }
            : {}),
        ...(draft.base_cache_write_1h_cny_per_1m.trim() !== ''
            ? { base_cache_write_1h_cny_per_1m: numberOrUndefined(draft.base_cache_write_1h_cny_per_1m) }
            : {}),
    };
}

function draftValid(model: GlobalModelPriceInfo | undefined, draft: Draft): boolean {
    if (!model) return false;
    const input = numberOrNull(draft.base_input_cny_per_1m);
    const output = numberOrNull(draft.base_output_cny_per_1m);
    const request = numberOrNull(draft.base_per_image_cny);
    const isToken = input !== null || output !== null;
    if (isToken === (request !== null) || (isToken && (input === null || output === null))) return false;
    if (request !== null && fieldKeys.slice(3).some((key) => draft[key].trim() !== '')) return false;
    return fieldKeys.every((key, index) => {
        const raw = draft[key].trim();
        if (!raw) return true;
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0) return false;
        const decimals = index >= 3 ? 12 : 4;
        return value <= 99_999_999.9999 && Math.abs(value - Number(value.toFixed(decimals))) < 1e-9;
    });
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

async function requestGlobalPreview(input: GlobalModelBaseInput, en: boolean): Promise<PreparedGlobalModelPricing> {
    const response = await fetch('/api/admin/pricing/global-model', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'preview', ...input }),
    });
    const data = await readResponse(response, en);
    const preview = data.preview as PricingPublishPreview | undefined;
    if (!preview?.preview_token || !Array.isArray(preview.rows) || !Array.isArray(preview.warnings)) {
        throw new Error(en ? 'The preview response is invalid.' : '预览响应无效，请重新尝试。');
    }
    return { input: { ...input }, preview };
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

export default function GlobalModelPricingWorkbench({
    isDark,
    locale,
    onPublished,
    onUncertain,
}: GlobalModelPricingWorkbenchProps) {
    const en = locale === 'en';
    const [models, setModels] = useState<GlobalModelPriceInfo[]>([]);
    const [modelId, setModelId] = useState('');
    const [draft, setDraft] = useState<Draft>(() => emptyDraft());
    const [savedDraft, setSavedDraft] = useState('');
    const [prepared, setPrepared] = useState<PreparedGlobalModelPricing | null>(null);
    const [confirmed, setConfirmed] = useState(false);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<'preview' | 'publish' | null>(null);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [now, setNow] = useState(() => Date.now());
    const selected = useMemo(() => models.find((model) => model.id === modelId), [models, modelId]);
    const dirty = JSON.stringify(draft) !== savedDraft;
    const valid = draftValid(selected, draft);
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
        const next = draftFromModel(selected);
        setDraft(next);
        setSavedDraft(JSON.stringify(next));
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

    const setField = (key: FieldKey, value: string) => {
        setDraft((current) => ({ ...current, [key]: value }));
        setPrepared(null);
        setConfirmed(false);
        setNotice('');
    };

    async function preview() {
        if (!selected || !valid || busy) return;
        setBusy('preview');
        setError('');
        setNotice('');
        setConfirmed(false);
        try {
            setPrepared(await requestGlobalPreview(toInput(selected.id, draft), en));
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
        if (!prepared || !confirmed || expired || dirty || busy) return;
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

    const tokenFields: Array<{ key: FieldKey; label: string; help: string }> = [
        {
            key: 'base_input_cny_per_1m',
            label: en ? 'Input · ¥ / 1M tokens' : '输入 · ¥ / 百万 token',
            help: en ? 'Official input price' : '官方输入基础价',
        },
        {
            key: 'base_output_cny_per_1m',
            label: en ? 'Output · ¥ / 1M tokens' : '输出 · ¥ / 百万 token',
            help: en ? 'Official output price' : '官方输出基础价',
        },
        {
            key: 'base_cache_read_cny_per_1m',
            label: en ? 'Cache read · ¥ / 1M tokens' : '缓存读取 · ¥ / 百万 token',
            help: en ? 'Optional cache read price' : '可选的缓存读取基础价',
        },
        {
            key: 'base_cache_write_cny_per_1m',
            label: en ? 'Cache write · ¥ / 1M tokens' : '缓存写入 · ¥ / 百万 token',
            help: en ? 'Optional cache write price' : '可选的缓存写入基础价',
        },
        {
            key: 'base_cache_write_1h_cny_per_1m',
            label: en ? 'Cache write / 1h · ¥ / 1M tokens' : '缓存写入 · 1 小时 · ¥ / 百万 token',
            help: en ? 'Optional one-hour cache write price' : '可选的一小时缓存写入基础价',
        },
    ];

    return (
        <section className={`space-y-5 rounded-xl border p-4 sm:p-5 ${classes.panel}`}>
            <div>
                <h2 className="text-base font-semibold">{en ? 'Global official model price' : '模型官方全局基础价'}</h2>
                <p className={`mt-1 text-sm leading-relaxed ${classes.muted}`}>
                    {en
                        ? 'Set the official base price at GroupRatio = 1. Every linked tier derives its customer price from this base and that tier’s GroupRatio.'
                        : '这里维护模型的官方全局基础价，基准为 GroupRatio = 1。所有关联档次的售价都由此基础价乘以各自 GroupRatio 得出。'}
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
                        <div>
                            <label className={classes.label} htmlFor="global-base-request">
                                {en ? 'Official request price · ¥ / request' : '官方按次基础价 · ¥ / 次'}
                            </label>
                            <input
                                id="global-base-request"
                                type="number"
                                min="0"
                                step="0.0001"
                                value={draft.base_per_image_cny}
                                onChange={(event) => setField('base_per_image_cny', event.target.value)}
                                className={classes.input}
                                disabled={busy !== null}
                            />
                            <p className={`mt-1 text-xs ${classes.muted}`}>
                                {en
                                    ? 'This is the only billing basis for request-priced models.'
                                    : '按次模型只填写按次基础价。'}
                            </p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                            {tokenFields.map((field) => (
                                <div key={field.key}>
                                    <label className={classes.label} htmlFor={`global-${field.key}`}>
                                        {field.label}
                                    </label>
                                    <input
                                        id={`global-${field.key}`}
                                        type="number"
                                        min="0"
                                        step={field.key.startsWith('base_cache') ? '0.000000000001' : '0.0001'}
                                        value={draft[field.key]}
                                        onChange={(event) => setField(field.key, event.target.value)}
                                        className={classes.input}
                                        disabled={busy !== null}
                                    />
                                    <p className={`mt-1 text-xs ${classes.muted}`}>{field.help}</p>
                                </div>
                            ))}
                        </div>
                    )}

                    <div className={classes.warning}>
                        {en
                            ? 'This page changes the shared official model base only. GroupRatio, recharge credits, supplier multiplier and retail multiplier are maintained in separate workflows.'
                            : '此页面只修改模型共享的官方基础价。GroupRatio、充值额度、上游倍率和售价倍率属于独立流程，不在这里填写。'}
                    </div>

                    {prepared && (
                        <div
                            className={`space-y-4 rounded-xl border p-4 ${isDark ? 'border-emerald-800 bg-slate-900/40' : 'border-emerald-200 bg-emerald-50/30'}`}
                        >
                            <h3 className="text-base font-semibold">
                                {en ? 'Review global publication impact' : '核对全局基础价发布影响'}
                            </h3>
                            <PricingPublishPreviewDetails preview={prepared.preview} en={en} isDark={isDark} />
                            <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-relaxed">
                                <input
                                    type="checkbox"
                                    checked={confirmed}
                                    disabled={expired || dirty}
                                    onChange={(event) => setConfirmed(event.target.checked)}
                                    className="mt-1 h-5 w-5 shrink-0 accent-emerald-600"
                                />
                                <span>
                                    {en
                                        ? 'I confirm this is the official global base price and understand it affects every linked tier.'
                                        : '我确认这是模型官方全局基础价，并已了解它会影响所有关联档次。'}
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
                                disabled={!confirmed || expired || dirty || busy !== null}
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
                            : en
                              ? 'Preview official base price'
                              : '预览官方基础价'}
                    </button>
                </>
            )}
        </section>
    );
}

export { draftFromModel, draftValid, toInput };
