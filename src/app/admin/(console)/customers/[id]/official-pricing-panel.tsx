'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Locale } from '@/lib/locale';
import type {
    OfficialCustomerRule,
    OfficialModelContext,
    OfficialPricingDraft,
    OfficialPricingPreview,
    OfficialPricingView,
} from '@/lib/customer-pricing/types';
import { formatTieredPrice } from '@/lib/models/tiered-pricing-details';
import { buttonCls, errorText, inputCls, Notice } from '@/components/admin/sale-rules-ui';

interface Props {
    customerId: string;
    isDark: boolean;
    locale: Locale;
    onChanged?: () => void;
}

interface Confirmations {
    belowCost: boolean;
    increases: boolean;
}

export function parseOfficialMultiplier(raw: string): number | null {
    const text = raw.trim();
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return null;
    const value = Number(text);
    return Number.isFinite(value) && value > 0 && value <= 100 ? value : null;
}

/** Confirm precisely the server preview, rather than a form that may have changed since. */
export function officialPricingSaveRequest(preview: OfficialPricingPreview, confirmed: Confirmations) {
    if (preview.blocked.length > 0) throw new Error('请先处理预览中无法发布的问题。');
    if (preview.below_cost && !confirmed.belowCost) throw new Error('请确认低于采购成本的价格。');
    if (preview.has_increases && !confirmed.increases) throw new Error('请确认该客户的涨价项目。');
    return {
        action: 'save' as const,
        ...preview.draft,
        expected_version: preview.version,
        preview_hash: preview.hash,
        confirm_below_cost: confirmed.belowCost,
        confirm_increases: confirmed.increases,
    };
}

interface ReferenceDraft {
    currency: 'CNY' | 'USD';
    fx: string;
    source: string;
    prices: Record<string, string>;
}

export function officialReferenceRequest(model: OfficialModelContext, version: string, draft: ReferenceDraft) {
    if (!draft.source.trim()) throw new Error('请填写官方基准价的来源。');
    const fx = draft.currency === 'CNY' ? 1 : parseOfficialMultiplier(draft.fx);
    if (fx === null) throw new Error('请填写每 1 美元折合的人民币金额。');
    const cells = model.cells.map((cell) => {
        const text = (draft.prices[cell.key] ?? '').trim();
        const price = Number(text);
        if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text) || !Number.isFinite(price) || price < 0)
            throw new Error(`请填写「${cell.label}」的官方单价。`);
        return { key: cell.key, price };
    });
    if (cells.length === 0) throw new Error('该模型没有可确认的计费规格。');
    return {
        action: 'reference' as const,
        tier_key: model.tier_key,
        model_id: model.model_id,
        currency: draft.currency,
        fx,
        source_note: draft.source.trim(),
        cells,
        expected_version: version,
    };
}

async function api<T>(url: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const response = await fetch(url, {
        method: body ? 'POST' : 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const data = (await response.json().catch(() => null)) as (T & { message?: string; error?: string }) | null;
    if (!response.ok || !data) throw new Error(data?.message ?? data?.error ?? '专属价格读取或保存失败，请稍后重试。');
    return data;
}

const amount = (value: number | null) => (value === null ? '—' : `¥${formatTieredPrice(value)}`);
const ratio = (value: number) => formatTieredPrice(value);

export function OfficialReferenceEditor({
    model,
    isDark,
    locale,
    busy,
    onConfirm,
    onCancel,
}: {
    model: OfficialModelContext;
    isDark: boolean;
    locale: Locale;
    busy: boolean;
    onConfirm: (draft: ReferenceDraft) => void;
    onCancel: () => void;
}) {
    const en = locale === 'en';
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';
    const [draft, setDraft] = useState<ReferenceDraft>({ currency: 'CNY', fx: '1', source: '', prices: {} });
    return (
        <div
            className={`space-y-3 rounded-lg border p-3 ${isDark ? 'border-amber-700 bg-amber-950/20' : 'border-amber-200 bg-amber-50/50'}`}
        >
            <h3 className="m-0 text-sm font-semibold">
                {en ? 'Confirm the official reference' : '确认官方基准价'}：{model.display_name || model.model_name}
            </h3>
            <p className={`m-0 text-xs leading-relaxed ${muted}`}>
                {en
                    ? 'Enter the official list prices for every specification. Public sale prices are not filled in as official prices. This reference will be used to calculate customer prices.'
                    : '请按官方价目表填写全部计费规格。公开售价不会自动当成官方价填入；此基准用于计算客户的官方价专属倍率。'}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs">
                    <span>{en ? 'Official currency' : '官方标价币种'}</span>
                    <select
                        className={`${inputCls(isDark, 'w-full')} h-9`}
                        disabled={busy}
                        value={draft.currency}
                        onChange={(event) =>
                            setDraft((previous) => ({
                                ...previous,
                                currency: event.target.value as 'CNY' | 'USD',
                                fx: event.target.value === 'CNY' ? '1' : '',
                            }))
                        }
                    >
                        <option value="CNY">{en ? 'CNY' : '人民币 CNY'}</option>
                        <option value="USD">{en ? 'USD' : '美元 USD'}</option>
                    </select>
                </label>
                {draft.currency === 'USD' && (
                    <label className="space-y-1 text-xs">
                        <span>{en ? 'CNY for 1 USD' : '每 1 美元折合人民币（元）'}</span>
                        <input
                            className={`${inputCls(isDark, 'w-full')} h-9`}
                            inputMode="decimal"
                            disabled={busy}
                            value={draft.fx}
                            placeholder={en ? 'Enter the confirmed exchange rate' : '填写已确认的换算汇率'}
                            onChange={(event) => setDraft((previous) => ({ ...previous, fx: event.target.value }))}
                        />
                    </label>
                )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {model.cells.map((cell) => (
                    <label key={cell.key} className="space-y-1 text-xs">
                        <span className="block">{cell.label}</span>
                        <span className={`block ${muted}`}>
                            {draft.currency === 'USD' ? (en ? 'USD' : '美元') : en ? 'CNY' : '元'}
                            {cell.unit === 'million_tokens'
                                ? en
                                    ? ' / 1M tokens'
                                    : '／百万 token'
                                : en
                                  ? ' / call'
                                  : '／次'}
                        </span>
                        <input
                            className={`${inputCls(isDark, 'w-full')} h-9`}
                            inputMode="decimal"
                            aria-label={`${en ? 'Official price' : '官方单价'} ${cell.label}`}
                            disabled={busy}
                            value={draft.prices[cell.key] ?? ''}
                            onChange={(event) =>
                                setDraft((previous) => ({
                                    ...previous,
                                    prices: { ...previous.prices, [cell.key]: event.target.value },
                                }))
                            }
                        />
                    </label>
                ))}
            </div>
            <label className="block space-y-1 text-xs">
                <span>{en ? 'Source and verification date' : '来源及核对日期'}</span>
                <input
                    className={`${inputCls(isDark, 'w-full')} h-9`}
                    disabled={busy}
                    value={draft.source}
                    maxLength={1000}
                    placeholder={
                        en
                            ? 'For example, the official price page and date checked'
                            : '例如：官方价目表地址、版本和核对日期'
                    }
                    onChange={(event) => setDraft((previous) => ({ ...previous, source: event.target.value }))}
                />
            </label>
            <div className="flex gap-2">
                <button
                    type="button"
                    className={buttonCls('primary', isDark)}
                    disabled={busy}
                    onClick={() => onConfirm(draft)}
                >
                    {busy
                        ? en
                            ? 'Saving…'
                            : '保存中…'
                        : en
                          ? 'Confirm official prices and save'
                          : '确认以上官方基准并保存'}
                </button>
                <button type="button" className={buttonCls('plain', isDark)} disabled={busy} onClick={onCancel}>
                    {en ? 'Cancel' : '取消'}
                </button>
            </div>
        </div>
    );
}

export function OfficialPricingPreviewTable({
    preview,
    isDark,
    locale,
}: {
    preview: OfficialPricingPreview;
    isDark: boolean;
    locale: Locale;
}) {
    const en = locale === 'en';
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';
    return (
        <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-left text-xs">
                <caption className={`pb-2 text-left ${muted}`}>
                    {en
                        ? 'Prices are CNY per million tokens or per call, as specified in each row. Margin uses this model’s purchasing cost.'
                        : '金额按各行注明的「元／百万 token」或「元／次」显示。毛利按各模型的采购成本分别计算。'}
                </caption>
                <thead className={muted}>
                    <tr>
                        {[
                            en ? 'Model / specification' : '模型／计费规格',
                            en ? 'Official price' : '官方单价',
                            en ? 'Purchasing cost' : '采购成本',
                            en ? 'Current customer price' : '当前客户价',
                            en ? 'Target customer price' : '目标客户价',
                            en ? 'Price after saving' : '保存后实际单价',
                            en ? 'Margin' : '毛利率',
                        ].map((title, index) => (
                            <th key={title} className={`px-2 py-2 font-medium ${index ? 'text-right' : ''}`}>
                                {title}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {preview.cells.map((cell, index) => (
                        <tr
                            key={`${cell.model_id}:${cell.label}:${index}`}
                            className={isDark ? 'border-t border-slate-700' : 'border-t border-slate-200'}
                        >
                            <td className="px-2 py-2">
                                <div className="font-medium break-all">{cell.model_name}</div>
                                <div className={`mt-1 ${muted}`}>{cell.label}</div>
                                <div className={muted}>
                                    {cell.unit === 'million_tokens'
                                        ? en
                                            ? 'CNY / 1M tokens'
                                            : '元／百万 token'
                                        : en
                                          ? 'CNY / call'
                                          : '元／次'}
                                </div>
                                {cell.official_multiplier !== null && (
                                    <div className="mt-1 font-medium text-indigo-600">
                                        {en ? 'Official price' : '官方价'} × {ratio(cell.official_multiplier)}
                                        {cell.rule_scope === 'model'
                                            ? en
                                                ? ' (model rule)'
                                                : '（模型专属）'
                                            : cell.rule_scope === 'tier'
                                              ? en
                                                  ? ' (group rule)'
                                                  : '（分组专属）'
                                              : ''}
                                    </div>
                                )}
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums">{amount(cell.official_cny)}</td>
                            <td className="px-2 py-2 text-right tabular-nums">
                                {cell.cost_cny === null ? (en ? 'Unknown' : '未确认') : amount(cell.cost_cny)}
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums">{amount(cell.before_cny)}</td>
                            <td className="px-2 py-2 text-right tabular-nums">{amount(cell.target_cny)}</td>
                            <td className="px-2 py-2 text-right font-semibold tabular-nums">
                                {amount(cell.actual_cny)}
                            </td>
                            <td
                                className={`px-2 py-2 text-right tabular-nums ${cell.margin !== null && cell.margin < 0 ? 'font-semibold text-red-600' : ''}`}
                            >
                                {cell.margin === null ? '—' : `${(cell.margin * 100).toFixed(2)}%`}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

export function OfficialPricingRecoveryNotice({
    view,
    isDark,
    locale,
    busy,
    onRecover,
}: {
    view: OfficialPricingView;
    isDark: boolean;
    locale: Locale;
    busy: boolean;
    onRecover: (changeId: string) => void;
}) {
    if (!view.pending_changes?.length) return null;
    const en = locale === 'en';
    return (
        <div
            role="alert"
            className={`space-y-2 rounded-lg border p-3 ${isDark ? 'border-amber-700 bg-amber-950/20' : 'border-amber-200 bg-amber-50'}`}
        >
            <p className="m-0 text-sm font-semibold">
                {en ? 'A price publication needs recovery' : '有未完成的定价发布'}
            </p>
            <p className="m-0 text-xs leading-relaxed">
                {en
                    ? 'Verify the saved publication before editing prices. Recovery checks whether it committed and restores the previous settings if it did not.'
                    : '请先核验保存的发布记录，再修改价格。恢复会检查发布是否已提交；尚未提交时，恢复到发布前的配置。'}
            </p>
            {view.pending_changes.map((change) => (
                <div key={change.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span>
                        {view.tiers.find((tier) => tier.key === change.tier_key)?.display_name ?? change.tier_key}
                        {' · '}
                        <code>{change.id}</code>
                    </span>
                    <button
                        type="button"
                        className={buttonCls('plain', isDark)}
                        disabled={busy}
                        onClick={() => onRecover(change.id)}
                    >
                        {busy ? (en ? 'Recovering…' : '核验恢复中…') : en ? 'Verify and recover' : '核验并恢复'}
                    </button>
                </div>
            ))}
        </div>
    );
}

export function OfficialPricingPanel({ customerId, isDark, locale, onChanged }: Props) {
    const en = locale === 'en';
    const url = `/api/admin/customers/${encodeURIComponent(customerId)}/official-pricing`;
    const [view, setView] = useState<OfficialPricingView | null>(null);
    const [tierKey, setTierKey] = useState('');
    const [modelId, setModelId] = useState('');
    const [multiplier, setMultiplier] = useState('');
    const [preview, setPreview] = useState<OfficialPricingPreview | null>(null);
    const [confirmed, setConfirmed] = useState<Confirmations>({ belowCost: false, increases: false });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [referenceModelId, setReferenceModelId] = useState<string | null>(null);
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';
    const card = isDark ? 'border-slate-700 bg-slate-800/70 text-slate-100' : 'border-slate-200 bg-white shadow-sm';
    const selectedTier = view?.tiers.find((tier) => tier.key === tierKey) ?? null;
    const selectedRule = view?.rules.find((rule) => rule.tier_key === tierKey && rule.model_id === (modelId || null));
    const selectedRuleMultiplier = selectedRule?.official_multiplier;
    const selectedModels = selectedTier?.models.filter((model) => !modelId || model.model_id === modelId) ?? [];
    const unavailable = selectedModels.filter((model) => !model.reference_available);
    const value = parseOfficialMultiplier(multiplier);
    const referenceModel = selectedTier?.models.find((model) => model.model_id === referenceModelId) ?? null;

    const resetPreview = () => {
        setPreview(null);
        setConfirmed({ belowCost: false, increases: false });
    };

    const load = useCallback(
        async (signal?: AbortSignal) => {
            const data = await api<OfficialPricingView>(url, undefined, signal);
            if (signal?.aborted) return;
            setView(data);
            setTierKey((previous) =>
                data.tiers.some((tier) => tier.key === previous) ? previous : (data.tiers[0]?.key ?? ''),
            );
        },
        [url],
    );

    useEffect(() => {
        const controller = new AbortController();
        // eslint-disable-next-line react-hooks/set-state-in-effect -- initial server context read
        void load(controller.signal).catch((caught) => {
            if (!controller.signal.aborted) setError(errorText(caught));
        });
        return () => controller.abort();
    }, [load]);

    useEffect(() => {
        // Synchronize the editor only when the selected persisted rule changes.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setMultiplier(selectedRuleMultiplier === undefined ? '' : String(selectedRuleMultiplier));
    }, [tierKey, modelId, selectedRuleMultiplier]);

    const requestPreview = async (draft: OfficialPricingDraft) => {
        setBusy(true);
        setError('');
        setNotice('');
        resetPreview();
        try {
            const result = await api<{ preview: OfficialPricingPreview }>(url, { action: 'preview', ...draft });
            setPreview(result.preview);
        } catch (caught) {
            setError(errorText(caught));
        } finally {
            setBusy(false);
        }
    };

    const save = async () => {
        if (!preview) return;
        setBusy(true);
        setError('');
        try {
            const result = await api<{ ok: boolean }>(url, officialPricingSaveRequest(preview, confirmed));
            if (!result.ok) throw new Error(en ? 'The price change was not confirmed.' : '未确认价格保存成功。');
            resetPreview();
            setNotice(en ? 'Customer prices saved and verified.' : '客户专属价已保存并核对。');
            await load();
            onChanged?.();
        } catch (caught) {
            setError(errorText(caught));
            await load().catch(() => undefined);
        } finally {
            setBusy(false);
        }
    };

    const recover = async (changeId: string) => {
        setBusy(true);
        setError('');
        setNotice('');
        resetPreview();
        setReferenceModelId(null);
        try {
            const result = await api<{ ok: boolean }>(url, { action: 'recover', change_id: changeId });
            if (!result.ok) throw new Error(en ? 'Recovery was not verified.' : '未确认恢复成功。');
            await load();
            setNotice(
                en ? 'Publication verified. You can preview prices again.' : '发布记录已核验恢复，可以重新预览价格。',
            );
            onChanged?.();
        } catch (caught) {
            setError(errorText(caught));
            await load().catch(() => undefined);
        } finally {
            setBusy(false);
        }
    };

    const editRule = (rule: OfficialCustomerRule) => {
        resetPreview();
        setReferenceModelId(null);
        setTierKey(rule.tier_key);
        setModelId(rule.model_id ?? '');
        setMultiplier(String(rule.official_multiplier));
    };

    const refresh = async () => {
        setBusy(true);
        setError('');
        resetPreview();
        setReferenceModelId(null);
        try {
            await load();
        } catch (caught) {
            setError(errorText(caught));
        } finally {
            setBusy(false);
        }
    };

    const saveReference = async (draft: ReferenceDraft) => {
        if (!referenceModel || !view) return;
        setBusy(true);
        setError('');
        resetPreview();
        try {
            const result = await api<{ ok: boolean; view: OfficialPricingView }>(
                url,
                officialReferenceRequest(referenceModel, view.version, draft),
            );
            if (!result.ok) throw new Error(en ? 'The reference was not confirmed.' : '未确认官方基准保存成功。');
            setView(result.view);
            setReferenceModelId(null);
            setNotice(
                en
                    ? 'Official reference saved. Preview the customer price before applying it.'
                    : '官方基准已保存。请预览客户价格，再确认专属定价。',
            );
        } catch (caught) {
            setError(errorText(caught));
        } finally {
            setBusy(false);
        }
    };

    return (
        <section aria-label={en ? 'Customer official-price multipliers' : '客户官方价专属倍率'}>
            <div className="mb-2 flex items-center justify-between gap-3">
                <h2 className="m-0 text-sm font-semibold">{en ? 'Customer exclusive prices' : '客户专属价'}</h2>
                <button
                    type="button"
                    className={buttonCls('plain', isDark)}
                    disabled={busy}
                    onClick={() => void refresh()}
                >
                    {en ? 'Refresh' : '刷新'}
                </button>
            </div>
            <p className={`mb-3 text-xs leading-relaxed ${muted}`}>
                {en
                    ? 'Customer price = official price × the multiplier entered here. A model rule takes priority over a customer group rule, then the standard price applies. These rules do not multiply each other.'
                    : '客户价格 = 官方价 × 此处填写的倍率。优先使用客户指定模型规则，其次客户整组规则，未设置时沿用普通售价。各规则不叠乘。'}
            </p>
            <div className={`space-y-4 rounded-xl border p-4 ${card}`}>
                {error && (
                    <p role="alert" className="m-0 text-sm text-red-600">
                        {error}
                    </p>
                )}
                {notice && (
                    <p role="status" className="m-0 text-sm text-emerald-600">
                        {notice}
                    </p>
                )}
                {view && (
                    <OfficialPricingRecoveryNotice
                        view={view}
                        isDark={isDark}
                        locale={locale}
                        busy={busy}
                        onRecover={(changeId) => void recover(changeId)}
                    />
                )}
                {!view ? (
                    <p className={`m-0 text-sm ${muted}`}>
                        {error ? (en ? 'Refresh to retry.' : '点击刷新重试。') : en ? 'Loading…' : '读取专属价格…'}
                    </p>
                ) : view.tiers.length === 0 ? (
                    <p className={`m-0 text-sm ${muted}`}>{en ? 'No available groups.' : '当前没有可设置的分组。'}</p>
                ) : (
                    <>
                        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(12rem,1fr)]">
                            <label className="space-y-1 text-xs">
                                <span>{en ? 'Group' : '分组'}</span>
                                <select
                                    className={`${inputCls(isDark, 'w-full')} h-10`}
                                    value={tierKey}
                                    disabled={busy}
                                    onChange={(event) => {
                                        resetPreview();
                                        setReferenceModelId(null);
                                        setTierKey(event.target.value);
                                        setModelId('');
                                    }}
                                >
                                    {view.tiers.map((tier) => (
                                        <option key={tier.key} value={tier.key}>
                                            {tier.display_name}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label className="space-y-1 text-xs">
                                <span>{en ? 'Apply to' : '适用范围'}</span>
                                <select
                                    className={`${inputCls(isDark, 'w-full')} h-10`}
                                    value={modelId}
                                    disabled={busy || !selectedTier}
                                    onChange={(event) => {
                                        resetPreview();
                                        setReferenceModelId(null);
                                        setModelId(event.target.value);
                                    }}
                                >
                                    <option value="">{en ? 'Entire group' : '整个分组'}</option>
                                    {selectedTier?.models.map((model) => (
                                        <option key={model.model_id} value={model.model_id}>
                                            {model.display_name || model.model_name}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label className="space-y-1 text-xs">
                                <span>{en ? 'Official-price multiplier' : '官方价倍率（0.2 = 官方价 2 折）'}</span>
                                <input
                                    className={`${inputCls(isDark, 'w-full')} h-10`}
                                    inputMode="decimal"
                                    placeholder="0.2"
                                    value={multiplier}
                                    disabled={busy}
                                    onChange={(event) => {
                                        resetPreview();
                                        setMultiplier(event.target.value);
                                    }}
                                />
                            </label>
                        </div>
                        {selectedTier?.legacy_multiplier != null && (
                            <p className={`m-0 text-xs leading-relaxed ${muted}`}>
                                {en
                                    ? `This group has a legacy multiplier of ${selectedTier.legacy_multiplier}. Its billing meaning is preserved until a new rule is confirmed; it is not an official-price multiplier.`
                                    : `该组已有旧版倍率 ${selectedTier.legacy_multiplier}，原计费含义继续保留；它不会自动解释成官方价倍率。确认新规则前，请核对下面的逐模型价格变化。`}
                            </p>
                        )}
                        {unavailable.length > 0 && (
                            <div className="space-y-2">
                                <Notice
                                    tone="amber"
                                    isDark={isDark}
                                    items={unavailable.map(
                                        (model) =>
                                            `${model.display_name || model.model_name}：${model.unavailable_reason ?? (en ? 'Confirm the official reference price first.' : '尚未确认官方基准价，请先补齐并确认。')}`,
                                    )}
                                />
                                <div className="flex flex-wrap gap-2">
                                    {unavailable
                                        .filter((model) => model.cells.length > 0)
                                        .map((model) => (
                                            <button
                                                key={model.model_id}
                                                type="button"
                                                className={buttonCls('plain', isDark)}
                                                disabled={busy}
                                                onClick={() => {
                                                    resetPreview();
                                                    setReferenceModelId(model.model_id);
                                                }}
                                            >
                                                {en ? 'Set official reference' : '确认官方基准'}：
                                                {model.display_name || model.model_name}
                                            </button>
                                        ))}
                                </div>
                            </div>
                        )}
                        {referenceModel && (
                            <OfficialReferenceEditor
                                key={referenceModel.model_id}
                                model={referenceModel}
                                isDark={isDark}
                                locale={locale}
                                busy={busy}
                                onConfirm={(draft) => void saveReference(draft)}
                                onCancel={() => setReferenceModelId(null)}
                            />
                        )}
                        <div className="flex flex-wrap gap-2">
                            <button
                                type="button"
                                className={buttonCls('primary', isDark)}
                                disabled={
                                    busy ||
                                    !selectedTier ||
                                    selectedModels.length === 0 ||
                                    value === null ||
                                    unavailable.length > 0
                                }
                                onClick={() =>
                                    value !== null &&
                                    void requestPreview({
                                        tier_key: tierKey,
                                        model_id: modelId || null,
                                        official_multiplier: value,
                                    })
                                }
                            >
                                {busy
                                    ? en
                                        ? 'Checking…'
                                        : '处理中…'
                                    : en
                                      ? 'Preview customer prices'
                                      : '预览客户价格'}
                            </button>
                            {selectedRule && (
                                <button
                                    type="button"
                                    className={buttonCls('plain', isDark)}
                                    disabled={busy}
                                    onClick={() =>
                                        void requestPreview({
                                            tier_key: tierKey,
                                            model_id: modelId || null,
                                            official_multiplier: null,
                                        })
                                    }
                                >
                                    {en ? 'Preview removing this rule' : '预览取消此规则'}
                                </button>
                            )}
                        </div>

                        {preview && (
                            <div
                                className={`space-y-3 rounded-lg border p-3 ${isDark ? 'border-indigo-700 bg-indigo-950/20' : 'border-indigo-200 bg-indigo-50/40'}`}
                            >
                                <h3 className="m-0 text-sm font-semibold">
                                    {preview.draft.official_multiplier === null
                                        ? en
                                            ? 'Prices after removing this rule'
                                            : '取消此规则后的价格'
                                        : en
                                          ? 'Customer prices after saving'
                                          : '保存后的客户价格'}
                                </h3>
                                <p className={`m-0 text-xs ${muted}`}>
                                    {en
                                        ? `${preview.affected_keys} keys in this group are affected. Other groups keep their existing use.`
                                        : `本次涉及该组 ${preview.affected_keys} 把 Key；其他分组的 Key 保持原用途。`}
                                </p>
                                <Notice tone="red" items={preview.blocked} isDark={isDark} />
                                <Notice tone="amber" items={preview.warnings} isDark={isDark} />
                                {preview.cells.length > 0 && (
                                    <OfficialPricingPreviewTable preview={preview} isDark={isDark} locale={locale} />
                                )}
                                {preview.below_cost && (
                                    <label className="flex items-start gap-2 text-xs text-red-600">
                                        <input
                                            type="checkbox"
                                            className="mt-0.5"
                                            checked={confirmed.belowCost}
                                            disabled={busy}
                                            onChange={(event) =>
                                                setConfirmed((previous) => ({
                                                    ...previous,
                                                    belowCost: event.target.checked,
                                                }))
                                            }
                                        />
                                        {en
                                            ? 'I understand that the highlighted prices are below purchasing cost and confirm them.'
                                            : '我已核对低于采购成本的项目，确认按这些价格销售。'}
                                    </label>
                                )}
                                {preview.has_increases && (
                                    <label className="flex items-start gap-2 text-xs">
                                        <input
                                            type="checkbox"
                                            className="mt-0.5"
                                            checked={confirmed.increases}
                                            disabled={busy}
                                            onChange={(event) =>
                                                setConfirmed((previous) => ({
                                                    ...previous,
                                                    increases: event.target.checked,
                                                }))
                                            }
                                        />
                                        {en
                                            ? 'I have reviewed and confirm the price increases for this customer.'
                                            : '我已核对该客户的涨价项目，确认保存。'}
                                    </label>
                                )}
                                <div className="flex gap-2">
                                    <button
                                        type="button"
                                        className={buttonCls('primary', isDark)}
                                        disabled={
                                            busy ||
                                            preview.blocked.length > 0 ||
                                            (preview.below_cost && !confirmed.belowCost) ||
                                            (preview.has_increases && !confirmed.increases)
                                        }
                                        onClick={() => void save()}
                                    >
                                        {busy ? (en ? 'Saving…' : '保存中…') : en ? 'Confirm and save' : '确认保存'}
                                    </button>
                                    <button
                                        type="button"
                                        className={buttonCls('plain', isDark)}
                                        disabled={busy}
                                        onClick={resetPreview}
                                    >
                                        {en ? 'Cancel' : '取消'}
                                    </button>
                                </div>
                            </div>
                        )}

                        {view.rules.length > 0 && (
                            <div className={`border-t pt-3 ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
                                <h3 className="m-0 mb-2 text-xs font-semibold">
                                    {en ? 'Saved official-price rules' : '已保存的官方价专属规则'}
                                </h3>
                                <ul className="m-0 list-none space-y-2 p-0">
                                    {view.rules.map((rule) => {
                                        const tier = view.tiers.find((item) => item.key === rule.tier_key);
                                        const model = tier?.models.find((item) => item.model_id === rule.model_id);
                                        return (
                                            <li
                                                key={rule.id}
                                                className="flex flex-wrap items-center justify-between gap-2 text-xs"
                                            >
                                                <span>
                                                    {tier?.display_name ?? rule.tier_key} ·{' '}
                                                    {rule.model_id
                                                        ? model?.display_name || model?.model_name || rule.model_id
                                                        : en
                                                          ? 'Entire group'
                                                          : '整个分组'}
                                                    {' · '}
                                                    {en ? 'Official price' : '官方价'} ×{' '}
                                                    <strong>{ratio(rule.official_multiplier)}</strong>
                                                </span>
                                                <button
                                                    type="button"
                                                    className={buttonCls('plain', isDark)}
                                                    disabled={busy}
                                                    onClick={() => editRule(rule)}
                                                >
                                                    {en ? 'Edit / remove' : '修改／取消'}
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        )}
                    </>
                )}
            </div>
        </section>
    );
}
