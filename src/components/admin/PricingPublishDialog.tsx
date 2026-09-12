'use client';

import { useEffect, useRef, useState } from 'react';
import type {
    PricingPublishAmounts,
    PricingPublishInput,
    PricingPublishJob,
    PricingPublishPreview,
} from '@/lib/admin/pricing-publish-types';

export interface PricingPublishTier {
    tier: string;
    current: (PricingPublishAmounts & { cost_cny_per_1m: number | null }) | null;
}
interface FormValues {
    tier: string;
    input_cny_per_1m: string;
    output_cny_per_1m: string;
    per_image_cny: string;
    cost_cny_per_1m: string;
}
export interface PreparedPricingPublish {
    input: PricingPublishInput;
    preview: PricingPublishPreview;
}

export function pricingPublishInput(modelId: string, values: FormValues): PricingPublishInput | null {
    const amount = (value: string): number | null => (value.trim() === '' ? null : Number(value));
    const input = {
        model_id: modelId,
        tier: values.tier,
        input_cny_per_1m: amount(values.input_cny_per_1m),
        output_cny_per_1m: amount(values.output_cny_per_1m),
        per_image_cny: amount(values.per_image_cny),
        cost_cny_per_1m: amount(values.cost_cny_per_1m),
    };
    if (!modelId || !values.tier.trim()) return null;
    for (const value of [input.input_cny_per_1m, input.output_cny_per_1m, input.per_image_cny, input.cost_cny_per_1m])
        if (
            value !== null &&
            (!Number.isFinite(value) ||
                value < 0 ||
                value > 99_999_999.9999 ||
                Math.abs(value - Number(value.toFixed(4))) >= 1e-9)
        )
            return null;
    // Token input must be positive to derive a completion ratio. Request/output
    // prices may explicitly be zero; exactly one billing basis must be present.
    const tokens = input.input_cny_per_1m !== null && input.input_cny_per_1m > 0 && input.output_cny_per_1m !== null;
    const request = input.per_image_cny !== null;
    if (request ? input.input_cny_per_1m !== null || input.output_cny_per_1m !== null : !tokens) return null;
    return input;
}

export class PricingPublishRequestError extends Error {
    constructor(
        message: string,
        public code: string,
        public status: number,
    ) {
        super(message);
    }
}

async function postPricing(body: object, en: boolean): Promise<Record<string, unknown>> {
    const response = await fetch('/api/admin/pricing', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
        throw new PricingPublishRequestError(
            typeof data.message === 'string'
                ? data.message
                : response.status === 401
                  ? en
                      ? 'Your session has expired. Please sign in again.'
                      : '登录已过期，请重新登录。'
                  : en
                    ? 'The request could not be completed. Refresh the preview and try again.'
                    : '请求未完成，请重新预览后再操作。',
            typeof data.error === 'string' ? data.error : 'publish_failed',
            response.status,
        );
    return data;
}

export async function requestPricingPreview(input: PricingPublishInput, en = false): Promise<PreparedPricingPublish> {
    // Copy the form before awaiting I/O; publishing uses this exact snapshot.
    const snapshot = { ...input };
    const data = await postPricing({ action: 'preview', ...snapshot }, en);
    const preview = data.preview as PricingPublishPreview | undefined;
    if (
        !preview?.preview_token ||
        !Number.isFinite(Date.parse(preview.expires_at)) ||
        !Array.isArray(preview.rows) ||
        !Array.isArray(preview.warnings)
    )
        throw new Error('Invalid preview response');
    return { input: snapshot, preview };
}

export async function requestPricingPublish(prepared: PreparedPricingPublish, en = false): Promise<PricingPublishJob> {
    if (Date.parse(prepared.preview.expires_at) <= Date.now())
        throw new PricingPublishRequestError(
            en ? 'This preview has expired. Please preview again.' : '预览已过期，请重新预览。',
            'preview_stale',
            409,
        );
    const data = await postPricing(
        { action: 'publish', preview_token: prepared.preview.preview_token, ...prepared.input },
        en,
    );
    const job = data.job as PricingPublishJob | undefined;
    if (!job?.id || !job.status) throw new Error('Invalid publication response');
    return job;
}

function money(value: number | null) {
    return value === null ? '—' : `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 4 })}`;
}
function priceText(amounts: PricingPublishAmounts | null, en: boolean) {
    if (!amounts) return en ? 'No catalog price' : '未设置目录价格';
    return amounts.per_image_cny !== null
        ? `${money(amounts.per_image_cny)} / ${en ? 'request' : '次'}`
        : `${en ? 'Input' : '输入'} ${money(amounts.input_cny_per_1m)} · ${en ? 'output' : '输出'} ${money(amounts.output_cny_per_1m)} / ${en ? '1M tokens' : '百万 token'}`;
}

export function PricingPublishPreviewDetails({
    preview,
    en,
    isDark,
}: {
    preview: PricingPublishPreview;
    en: boolean;
    isDark: boolean;
}) {
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';
    return (
        <div className="space-y-4">
            <p
                className={`rounded-lg border p-3 text-sm ${isDark ? 'border-amber-800 bg-amber-950/30 text-amber-200' : 'border-amber-200 bg-amber-50 text-amber-900'}`}
            >
                {en
                    ? 'The base price is shared. This change affects every tier below. Actual charges are determined by new-api; catalog prices update only after verification.'
                    : '基础价格由各档次共享，本次会影响下列模型和档次。实际扣费由 new-api 执行；两端核验完成后，目录才显示新价格。'}
            </p>
            <p className={`text-xs ${muted}`}>
                {preview.upstream_model} ·{' '}
                {preview.basis === 'token' ? (en ? 'Per token' : '按 token 计费') : en ? 'Per request' : '按次计费'}
            </p>
            <div className="space-y-3">
                {preview.rows.map((row) => (
                    <article
                        key={`${row.model_id}:${row.tier}`}
                        className={`rounded-lg border p-3 ${isDark ? 'border-slate-700' : 'border-slate-200'}`}
                    >
                        <p className="text-sm font-medium">
                            {row.model_name} · {row.tier}
                        </p>
                        <p className={`mt-1 text-xs ${muted}`}>new-api group: {row.group}</p>
                        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
                            <dt className={muted}>{en ? 'Current' : '当前'}</dt>
                            <dd>{priceText(row.before, en)}</dd>
                            <dt className={muted}>{en ? 'After publication' : '发布后'}</dt>
                            <dd className={isDark ? 'text-emerald-300' : 'text-emerald-700'}>
                                {priceText(row.after, en)}
                            </dd>
                        </dl>
                    </article>
                ))}
            </div>
            {preview.warnings.length > 0 && (
                <ul className={`list-disc space-y-1 pl-5 text-sm ${muted}`}>
                    {preview.warnings.map((warning, index) => (
                        <li key={index}>{warning}</li>
                    ))}
                </ul>
            )}
            <p className={`text-xs ${muted}`}>
                {en ? 'Preview valid until: ' : '预览有效至：'}
                {new Date(preview.expires_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                {en ? ' (Beijing time)' : '（北京时间）'}
            </p>
        </div>
    );
}

export default function PricingPublishDialog({
    model,
    tiers,
    initialTier,
    en,
    isDark,
    onClose,
    onSubmitted,
    onUncertain,
}: {
    model: { id: string; display_name: string; slug: string };
    tiers: PricingPublishTier[];
    initialTier?: string;
    en: boolean;
    isDark: boolean;
    onClose: () => void;
    onSubmitted: (job: PricingPublishJob) => void;
    onUncertain: () => void;
}) {
    const valuesFor = (tier: string): FormValues => {
        const current = tiers.find((row) => row.tier === tier)?.current;
        return {
            tier,
            input_cny_per_1m: String(current?.input_cny_per_1m ?? ''),
            output_cny_per_1m: String(current?.output_cny_per_1m ?? ''),
            per_image_cny: String(current?.per_image_cny ?? ''),
            cost_cny_per_1m: String(current?.cost_cny_per_1m ?? ''),
        };
    };
    const [form, setForm] = useState(() => valuesFor(initialTier ?? ''));
    const [prepared, setPrepared] = useState<PreparedPricingPublish | null>(null);
    const [busy, setBusy] = useState(false);
    const [confirmed, setConfirmed] = useState(false);
    const [error, setError] = useState('');
    const [now, setNow] = useState(() => Date.now());
    const dialog = useRef<HTMLDivElement>(null);
    const active = useRef(true);
    const requestLock = useRef(false);
    useEffect(() => {
        active.current = true;
        const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dialog.current?.focus();
        return () => {
            active.current = false;
            trigger?.focus();
        };
    }, []);
    useEffect(() => {
        if (!prepared) return;
        const interval = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(interval);
    }, [prepared]);
    const input = pricingPublishInput(model.id, form);
    const expired = prepared !== null && Date.parse(prepared.preview.expires_at) <= now;
    const clearPreview = () => {
        setPrepared(null);
        setConfirmed(false);
        setError('');
    };
    const edit = (field: keyof FormValues, value: string) => {
        clearPreview();
        setForm(field === 'tier' ? valuesFor(value) : { ...form, [field]: value });
    };
    const preview = async () => {
        if (!input || requestLock.current) return;
        requestLock.current = true;
        setBusy(true);
        setError('');
        try {
            const result = await requestPricingPreview(input, en);
            if (active.current) {
                setPrepared(result);
                setConfirmed(false);
                setNow(Date.now());
            }
        } catch (caught) {
            if (active.current)
                setError(
                    caught instanceof PricingPublishRequestError
                        ? caught.message
                        : en
                          ? 'Could not load the preview. Please retry.'
                          : '未能读取发布预览，请重试。',
                );
        } finally {
            requestLock.current = false;
            if (active.current) setBusy(false);
        }
    };
    const publish = async () => {
        if (!prepared || !confirmed || expired || requestLock.current) return;
        requestLock.current = true;
        setBusy(true);
        setError('');
        try {
            const job = await requestPricingPublish(prepared, en);
            if (active.current) onSubmitted(job);
        } catch (caught) {
            if (!active.current) return;
            setPrepared(null);
            setConfirmed(false);
            setError(
                caught instanceof PricingPublishRequestError
                    ? caught.message
                    : en
                      ? 'The submission result is unconfirmed. Check Publication tasks before submitting again.'
                      : '提交结果尚未确认，请先关闭窗口查看「价格发布任务」，避免重复提交。',
            );
            onUncertain();
        } finally {
            requestLock.current = false;
            if (active.current) setBusy(false);
        }
    };
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';
    const inputClass = `w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 ${isDark ? 'border-slate-600 bg-slate-700 text-slate-100' : 'border-slate-300 bg-white text-slate-900'}`;
    const secondary = `rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 ${isDark ? 'text-slate-300 hover:bg-slate-700' : 'text-slate-600 hover:bg-slate-100'}`;
    const fields: { key: keyof Omit<FormValues, 'tier'>; label: string }[] = [
        { key: 'input_cny_per_1m', label: en ? 'Input price (CNY / 1M tokens)' : '输入价（¥ / 百万 token）' },
        { key: 'output_cny_per_1m', label: en ? 'Output price (CNY / 1M tokens)' : '输出价（¥ / 百万 token）' },
        { key: 'per_image_cny', label: en ? 'Request price (CNY / request)' : '按次价格（¥ / 次）' },
        { key: 'cost_cny_per_1m', label: en ? 'Cost (optional)' : '成本（可选）' },
    ];
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div
                ref={dialog}
                role="dialog"
                aria-modal="true"
                aria-labelledby="pricing-publish-title"
                tabIndex={-1}
                onKeyDown={(event) => {
                    if (event.key === 'Escape' && !busy) {
                        event.preventDefault();
                        onClose();
                    }
                    if (event.key !== 'Tab') return;
                    const focusable = Array.from(
                        dialog.current?.querySelectorAll<HTMLElement>(
                            'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]',
                        ) ?? [],
                    ).filter((element) => !element.closest('fieldset:disabled'));
                    const first = focusable[0],
                        last = focusable.at(-1);
                    if (
                        event.shiftKey &&
                        (document.activeElement === first || document.activeElement === dialog.current)
                    ) {
                        event.preventDefault();
                        last?.focus();
                    } else if (
                        !event.shiftKey &&
                        (document.activeElement === last || document.activeElement === dialog.current)
                    ) {
                        event.preventDefault();
                        first?.focus();
                    }
                }}
                className={`max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border p-6 shadow-2xl ${isDark ? 'border-slate-700 bg-slate-800 text-slate-100' : 'border-slate-200 bg-white text-slate-900'}`}
            >
                <h2 id="pricing-publish-title" className="text-lg font-semibold">
                    {prepared
                        ? en
                            ? 'Confirm price publication to new-api'
                            : '确认发布价格到 new-api'
                        : en
                          ? 'Publish price to new-api'
                          : '发布价格到 new-api'}
                </h2>
                <p className={`mb-5 mt-1 text-sm ${muted}`}>
                    {model.display_name} · {model.slug}
                </p>
                {error && (
                    <p
                        role="alert"
                        className={`mb-4 rounded-lg border p-3 text-sm ${isDark ? 'border-red-800 bg-red-950/30 text-red-300' : 'border-red-200 bg-red-50 text-red-700'}`}
                    >
                        {error}
                    </p>
                )}
                {prepared ? (
                    <>
                        <PricingPublishPreviewDetails preview={prepared.preview} en={en} isDark={isDark} />
                        <p className={`mt-4 text-sm ${muted}`}>
                            {en ? 'Cost for ' : '成本（'}
                            {prepared.input.tier}
                            {en ? ': ' : '）：'}
                            {prepared.input.cost_cny_per_1m === null
                                ? en
                                    ? 'Not set'
                                    : '未设置'
                                : money(prepared.input.cost_cny_per_1m)}
                            {en ? '. Other recorded costs are preserved.' : '；其他档次已有成本保持原值。'}
                        </p>
                        <label className="mt-5 flex items-start gap-2 text-sm">
                            <input
                                type="checkbox"
                                checked={confirmed}
                                disabled={busy || expired}
                                onChange={(event) => setConfirmed(event.target.checked)}
                                className="mt-0.5 h-4 w-4 accent-emerald-600"
                            />
                            <span>
                                {en
                                    ? 'I have reviewed every affected tier and confirm these shared price changes.'
                                    : '我已核对所有受影响档次，确认发布以上价格。'}
                            </span>
                        </label>
                        {expired && (
                            <p role="status" className={`mt-3 text-sm ${muted}`}>
                                {en
                                    ? 'Preview expired. Go back and preview again.'
                                    : '预览已过期，请返回修改并重新预览。'}
                            </p>
                        )}
                    </>
                ) : (
                    <fieldset disabled={busy} className="space-y-4 disabled:opacity-60">
                        <label className="block text-sm font-medium">
                            {en ? 'Tier to edit' : '要改价的档次'}
                            <select
                                value={form.tier}
                                onChange={(event) => edit('tier', event.target.value)}
                                className={`mt-1 ${inputClass}`}
                            >
                                <option value="">{en ? 'Choose a tier' : '请选择档次'}</option>
                                {tiers.map((row) => (
                                    <option key={row.tier} value={row.tier}>
                                        {row.tier}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <p className={`text-sm ${muted}`}>
                            {en
                                ? 'Enter token prices or a request price. Preview shows every affected tier before anything changes.'
                                : '填写输入/输出价，或按次价格。预览会列出所有受影响档次，确认前不会改价。'}
                        </p>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            {fields.map((field) => (
                                <label key={field.key} className="block text-sm font-medium">
                                    {field.label}
                                    <input
                                        type="number"
                                        min="0"
                                        step="0.0001"
                                        value={form[field.key]}
                                        onChange={(event) => edit(field.key, event.target.value)}
                                        className={`mt-1 ${inputClass}`}
                                    />
                                </label>
                            ))}
                        </div>
                        {!input && form.tier && (
                            <p className={`text-xs ${muted}`}>
                                {en
                                    ? 'Use at most four decimal places. Token input must be positive; fill both token prices or a request price, without mixing them.'
                                    : '最多四位小数；输入价须大于零，输出价或按次价可为零。输入/输出价需成对填写，不能与按次价格混用。'}
                            </p>
                        )}
                    </fieldset>
                )}
                <div className="mt-6 flex flex-wrap justify-end gap-2">
                    <button type="button" disabled={busy} onClick={onClose} className={secondary}>
                        {en ? 'Cancel' : '取消'}
                    </button>
                    {prepared && (
                        <button type="button" disabled={busy} onClick={clearPreview} className={secondary}>
                            {en ? 'Back to edit' : '返回修改'}
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={prepared ? publish : preview}
                        disabled={busy || (prepared ? !confirmed || expired : !input)}
                        className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {busy
                            ? en
                                ? 'Processing…'
                                : '处理中…'
                            : prepared
                              ? en
                                  ? 'Confirm publication'
                                  : '确认发布'
                              : en
                                ? 'Preview publication'
                                : '预览发布'}
                    </button>
                </div>
            </div>
        </div>
    );
}
