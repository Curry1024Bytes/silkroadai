'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import type { Locale } from '@/lib/locale';
import type { PricingCostCapability, PricingCostLine, StoredPricingCostRule } from '@/lib/admin/pricing-cost-types';
import {
    calculateCostPricing,
    calculateCostSample,
    getCostMultiplierDelta,
    pricingCostConfigSchema,
} from '@/lib/admin/pricing-cost';
import type { PricingPublishJob } from '@/lib/admin/pricing-publish-types';
import { PricingPublishPreviewDetails } from '@/components/admin/PricingPublishDialog';
import {
    costConfigFromDraft,
    costReviewReducer,
    costRulePublishBlock,
    costRuleSelections,
    draftFromCostConfig,
    newCostDraft,
    publishCostPricingReview,
    requestCostPricingPreview,
    saveCostPricingRules,
    type CostPricingDraft,
} from './CostPricingWorkbench.helpers';

export interface CostPricingModel {
    id: string;
    slug: string;
    display_name: string;
    enabled: boolean;
}

interface CostData {
    rules: StoredPricingCostRule[];
    capabilities: PricingCostCapability[];
    source_error: string | null;
}

function money(value: number) {
    return Math.abs(value) > 0 && Math.abs(value) < 0.000001
        ? `¥${value.toPrecision(4)}`
        : `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 6 })}`;
}

function unitLabel(unit: PricingCostLine['unit'], en: boolean) {
    return unit === 'million_tokens'
        ? en
            ? '/ 1M tokens'
            : '/ 百万 token'
        : unit === 'image'
          ? en
              ? '/ image'
              : '/ 张'
          : en
            ? '/ second'
            : '/ 秒';
}

function basisLabel(basis: string, en: boolean) {
    return basis === 'token'
        ? en
            ? 'Text · tokens'
            : '文本 · token'
        : basis === 'image'
          ? en
              ? 'Image · per image'
              : '图片 · 按张'
          : basis === 'video'
            ? en
                ? 'Video · per second'
                : '视频 · 按秒试算'
            : en
              ? 'Unverified billing'
              : '计费规则待确认';
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
    return (
        <label className="block min-w-0 space-y-1.5 text-sm">
            <span className="block font-medium">{label}</span>
            {children}
            {hint && <span className="block text-xs leading-relaxed opacity-75">{hint}</span>}
        </label>
    );
}

function NumericField({
    label,
    value,
    onChange,
    hint,
    className,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    hint?: string;
    className: string;
}) {
    return (
        <Field label={label} hint={hint}>
            <input
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                className={className}
                value={value}
                onChange={(event) => onChange(event.target.value)}
            />
        </Field>
    );
}

function positiveFiniteMultiplier(value: string): number | null {
    const number = Number(value);
    return value.trim() !== '' && Number.isFinite(number) && number > 0 ? number : null;
}

function validMultiplier(value: string): number | null {
    const number = positiveFiniteMultiplier(value);
    return number !== null && number <= Number.MAX_SAFE_INTEGER ? number : null;
}

export function CostMultiplierSummary({ upstream, retail, en }: { upstream: string; retail: string; en: boolean }) {
    // A valid legacy percentage rule can derive a target above the direct-input limit.
    const upstreamValue = positiveFiniteMultiplier(upstream);
    const retailValue = positiveFiniteMultiplier(retail);
    if (upstreamValue === null || retailValue === null || retailValue < upstreamValue) return null;
    const difference = String(getCostMultiplierDelta(upstreamValue, retailValue));
    return (
        <span>
            {en
                ? `Supplier ${upstream.trim()}× → Retail ${retail.trim()}× (+${difference}×)`
                : `上游 ${upstream.trim()} 倍 → 售价 ${retail.trim()} 倍（加 ${difference} 倍）`}
        </span>
    );
}

export function CostMultiplierFields({
    draft,
    en,
    className,
    onChange,
    onInvalidate,
}: {
    draft: CostPricingDraft;
    en: boolean;
    className: string;
    onChange: (draft: CostPricingDraft) => void;
    onInvalidate: () => void;
}) {
    const change = (field: 'upstream_multiplier' | 'retail_multiplier', value: string) => {
        onInvalidate();
        onChange({ ...draft, [field]: value });
    };
    return (
        <>
            <NumericField
                label={en ? 'Supplier multiplier' : '上游倍率'}
                value={draft.upstream_multiplier}
                onChange={(value) => change('upstream_multiplier', value)}
                hint={
                    en
                        ? 'Applied to the base quote below. If the quote already includes this multiplier, enter 1; your retail multiplier then uses that quoted price as its base.'
                        : '按下方基础报价计算成本。报价已含上游倍率时填 1；此时售价倍率也以这份报价为基准。'
                }
                className={className}
            />
            <NumericField
                label={en ? 'My retail multiplier' : '我的售价倍率'}
                value={draft.retail_multiplier}
                onChange={(value) => change('retail_multiplier', value)}
                hint={
                    en
                        ? 'Enter the final multiplier directly, e.g. 1.6 for a supplier multiplier of 1.3. It must not be lower than the supplier multiplier.'
                        : '直接填最终倍率，例如上游 1.3，售价填 1.6。不能低于上游倍率。'
                }
                className={className}
            />
        </>
    );
}

export function CostResolutionField({
    resolution,
    fixedResolution,
    className,
    en,
    onChange,
}: {
    resolution: string;
    fixedResolution: string | null;
    className: string;
    en: boolean;
    onChange: (resolution: string) => void;
}) {
    // Keep a mismatched historical value visible and editable. Never silently
    // rewrite a saved quote's specification or lock the operator out of fixing it.
    const matchesFixed = !!fixedResolution && resolution.trim().toLowerCase() === fixedResolution.trim().toLowerCase();
    return (
        <Field
            label={en ? 'Resolution' : '分辨率'}
            hint={
                fixedResolution
                    ? en
                        ? `This model requires ${fixedResolution}. Confirm that the supplier quote is for this resolution.`
                        : `此模型对应 ${fixedResolution}，请确认上游报价属于该分辨率。`
                    : en
                      ? 'Use default when the price does not depend on resolution.'
                      : '不区分分辨率时填 default。'
            }
        >
            <input
                className={className}
                maxLength={64}
                value={resolution}
                readOnly={matchesFixed}
                onChange={(event) => onChange(event.target.value)}
            />
        </Field>
    );
}

export function CostEstimateTable({ lines, en, isDark }: { lines: PricingCostLine[]; en: boolean; isDark: boolean }) {
    return (
        <div className={`overflow-x-auto rounded-lg border ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
            <table className="w-full min-w-[530px] text-sm">
                <caption className="sr-only">
                    {en ? 'Estimated costs, retail prices and gross margins' : '预计成本、售价与毛利'}
                </caption>
                <thead className={isDark ? 'bg-slate-900/50 text-slate-300' : 'bg-slate-50 text-slate-600'}>
                    <tr>
                        {[
                            en ? 'Item / unit' : '项目／单位',
                            en ? 'Quoted cost' : '报价成本',
                            en ? 'Proposed retail' : '计划售价',
                            en ? 'Gross profit' : '预计毛利',
                            en ? 'Margin' : '毛利率',
                        ].map((label, index) => (
                            <th
                                key={label}
                                className={`px-3 py-2.5 font-medium ${index === 0 ? 'text-left' : 'text-right'}`}
                            >
                                {label}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {lines.map((line) => (
                        <tr key={line.key} className={`border-t ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
                            <td className="px-3 py-3">
                                {line.label}
                                <span className="ml-2 text-xs opacity-70">{unitLabel(line.unit, en)}</span>
                            </td>
                            <td className="px-3 py-3 text-right tabular-nums">{money(line.cost)}</td>
                            <td className="px-3 py-3 text-right font-medium tabular-nums">{money(line.retail)}</td>
                            <td className="px-3 py-3 text-right tabular-nums">{money(line.profit)}</td>
                            <td className="px-3 py-3 text-right tabular-nums">{line.margin_percent.toFixed(2)}%</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

export function SavedCostRuleList({
    rules,
    capabilities,
    models,
    selectedIds,
    busy,
    en,
    isDark,
    onSelect,
    onEdit,
}: {
    rules: StoredPricingCostRule[];
    capabilities: PricingCostCapability[];
    models: CostPricingModel[];
    selectedIds: string[];
    busy: boolean;
    en: boolean;
    isDark: boolean;
    onSelect: (id: string, selected: boolean) => void;
    onEdit: (rule: StoredPricingCostRule) => void;
}) {
    return (
        <div className="space-y-2">
            {rules.map((rule) => {
                const model = models.find((row) => row.id === rule.model_id);
                const capability = capabilities.find((row) => row.model_id === rule.model_id && row.tier === rule.tier);
                const block = costRulePublishBlock(rule, capability, en);
                return (
                    <article
                        key={rule.id}
                        className={`flex flex-wrap items-start gap-3 rounded-lg border p-3 ${isDark ? 'border-slate-700' : 'border-slate-200'}`}
                    >
                        <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-start gap-3">
                            <input
                                type="checkbox"
                                className="mt-1 h-5 w-5 shrink-0 accent-emerald-600"
                                checked={selectedIds.includes(rule.id)}
                                disabled={busy}
                                onChange={(event) => onSelect(rule.id, event.target.checked)}
                            />
                            <span className="min-w-0 space-y-1">
                                <span className="block break-words text-sm font-medium">
                                    {model?.display_name ?? rule.model_id} · {rule.tier}
                                </span>
                                <span className="block text-xs opacity-75">
                                    {basisLabel(rule.config.basis, en)} ·{' '}
                                    <CostMultiplierSummary
                                        upstream={String(rule.config.upstream_multiplier)}
                                        retail={draftFromCostConfig(rule.config).retail_multiplier}
                                        en={en}
                                    />{' '}
                                    · {en ? 'Revision' : '版本'} {rule.revision}
                                </span>
                                <span className="block text-xs opacity-75">
                                    {en ? 'Cost saved at ' : '成本保存于 '}
                                    {new Date(rule.updated_at).toLocaleString(en ? 'en-GB' : 'zh-CN', {
                                        timeZone: 'Asia/Shanghai',
                                    })}
                                    {en ? ' (Beijing)' : '（北京时间）'}
                                </span>
                                {block && (
                                    <span
                                        className={`block text-xs leading-relaxed ${isDark ? 'text-amber-300' : 'text-amber-800'}`}
                                    >
                                        {block}
                                    </span>
                                )}
                            </span>
                        </label>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => onEdit(rule)}
                            className={`min-h-11 shrink-0 rounded-lg px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 ${isDark ? 'text-indigo-300 hover:bg-slate-800' : 'text-indigo-700 hover:bg-indigo-50'} disabled:opacity-50`}
                        >
                            {en ? 'Edit cost' : '编辑成本'}
                        </button>
                    </article>
                );
            })}
        </div>
    );
}

export default function CostPricingWorkbench({
    models,
    isDark,
    locale,
    onPublished,
    onUncertain,
}: {
    models: CostPricingModel[];
    isDark: boolean;
    locale: Locale;
    onPublished: (job: PricingPublishJob) => void;
    onUncertain: () => void;
}) {
    const en = locale === 'en';
    const [data, setData] = useState<CostData>({ rules: [], capabilities: [], source_error: null });
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [modelId, setModelId] = useState('');
    const [tier, setTier] = useState('');
    const [draft, setDraft] = useState<CostPricingDraft>(() => newCostDraft());
    const [savedDraft, setSavedDraft] = useState('');
    const [editorRevision, setEditorRevision] = useState<number | null>(null);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [bulkRetailMultiplier, setBulkRetailMultiplier] = useState('');
    const [sampleUnits, setSampleUnits] = useState('');
    const [review, dispatchReview] = useReducer(costReviewReducer, { prepared: null, confirmed: false });
    const [now, setNow] = useState(() => Date.now());
    const lock = useRef(false);
    const mounted = useRef(true);
    const revision = useRef(0);
    const editor = useRef<HTMLDivElement>(null);
    const selectedRules = data.rules.filter((rule) => selectedIds.includes(rule.id));
    const selectedModel = models.find((model) => model.id === modelId);
    const capability = data.capabilities.find((row) => row.model_id === modelId && row.tier === tier);
    const dirty = !!modelId && !!tier && JSON.stringify(draft) !== savedDraft;
    const bulkDirty =
        bulkRetailMultiplier.trim() !== '' &&
        selectedRules.some(
            (rule) => Number(draftFromCostConfig(rule.config).retail_multiplier) !== Number(bulkRetailMultiplier),
        );
    const bulkMultiplierValid =
        validMultiplier(bulkRetailMultiplier) !== null &&
        selectedRules.every((rule) => Number(bulkRetailMultiplier) >= rule.config.upstream_multiplier);
    const bulkMultiplierError =
        bulkRetailMultiplier.trim() !== '' && selectedRules.length > 0 && !bulkMultiplierValid
            ? en
                ? 'Enter a positive retail multiplier at least as high as every selected supplier multiplier.'
                : '售价倍率须为正数，且不能低于任一所选规则的上游倍率。'
            : null;
    const selectedBlocked = selectedRules.find((rule) =>
        costRulePublishBlock(
            rule,
            data.capabilities.find((row) => row.model_id === rule.model_id && row.tier === rule.tier),
            en,
        ),
    );
    const selectedBlockReason = selectedBlocked
        ? costRulePublishBlock(
              selectedBlocked,
              data.capabilities.find(
                  (row) => row.model_id === selectedBlocked.model_id && row.tier === selectedBlocked.tier,
              ),
              en,
          )
        : null;
    const draftValidation = useMemo(() => {
        const upstream = positiveFiniteMultiplier(draft.upstream_multiplier);
        const retail = positiveFiniteMultiplier(draft.retail_multiplier);
        if (upstream !== null && retail !== null && retail < upstream)
            return {
                calculation: null,
                message: en
                    ? 'Your retail multiplier cannot be lower than the supplier multiplier. Below-cost pricing is not supported.'
                    : '我的售价倍率不能低于上游倍率，当前不支持低于成本定价。',
            };
        const raw = costConfigFromDraft(draft);
        if (!raw) return { calculation: null, message: null };
        const parsed = pricingCostConfigSchema.safeParse(raw);
        if (!parsed.success) return { calculation: null, message: parsed.error.issues[0]?.message ?? null };
        try {
            return { calculation: { config: parsed.data, ...calculateCostPricing(parsed.data) }, message: null };
        } catch {
            return { calculation: null, message: null };
        }
    }, [draft, en]);
    const calculation = draftValidation.calculation;
    const classes = {
        muted: isDark ? 'text-slate-400' : 'text-slate-600',
        input: `min-h-11 w-full min-w-0 rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-60 ${isDark ? 'border-slate-600 bg-slate-900 text-slate-100' : 'border-slate-300 bg-white text-slate-900'}`,
        button: `min-h-11 rounded-lg border px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${isDark ? 'border-slate-600 text-slate-200 hover:bg-slate-800' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`,
        primary:
            'min-h-11 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:cursor-not-allowed disabled:opacity-50',
        warning: `rounded-lg border p-3 text-sm leading-relaxed ${isDark ? 'border-amber-800 bg-amber-950/30 text-amber-200' : 'border-amber-200 bg-amber-50 text-amber-900'}`,
    };

    const invalidate = () => {
        revision.current++;
        dispatchReview({ type: 'invalidate' });
        setNotice('');
        setError('');
    };

    const reload = useCallback(async () => {
        if (lock.current) return;
        lock.current = true;
        setLoading(true);
        setError('');
        revision.current++;
        dispatchReview({ type: 'invalidate' });
        try {
            const response = await fetch('/api/admin/pricing/cost-rules', {
                credentials: 'same-origin',
                cache: 'no-store',
            });
            const value = await response.json();
            if (!response.ok)
                throw new Error(
                    typeof value.message === 'string'
                        ? value.message
                        : en
                          ? 'Could not load costs and billing capabilities.'
                          : '无法加载成本与计费能力。',
                );
            if (!Array.isArray(value.rules) || !Array.isArray(value.capabilities))
                throw new Error(en ? 'The cost response is incomplete.' : '成本数据响应不完整。');
            if (mounted.current) {
                setData(value as CostData);
                setSelectedIds((ids) =>
                    ids.filter((id) => value.rules.some((rule: StoredPricingCostRule) => rule.id === id)),
                );
            }
        } catch (caught) {
            if (mounted.current) {
                const message =
                    caught instanceof Error ? caught.message : en ? 'Could not load costs.' : '成本加载失败。';
                setError(message);
                setData((previous) => ({ ...previous, source_error: message }));
            }
        } finally {
            lock.current = false;
            if (mounted.current) setLoading(false);
        }
    }, [en]);

    useEffect(() => {
        mounted.current = true;
        const timer = window.setTimeout(() => void reload(), 0);
        return () => {
            window.clearTimeout(timer);
            mounted.current = false;
        };
    }, [reload]);
    useEffect(() => {
        if (!review.prepared) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [review.prepared]);

    const changeDraft = (next: CostPricingDraft) => {
        invalidate();
        setDraft(next);
    };
    const loadTarget = (nextModel: string, nextTier: string) => {
        invalidate();
        setModelId(nextModel);
        setTier(nextTier);
        const current = data.rules.find((rule) => rule.model_id === nextModel && rule.tier === nextTier);
        const cap = data.capabilities.find((row) => row.model_id === nextModel && row.tier === nextTier);
        const next = current ? draftFromCostConfig(current.config) : newCostDraft(cap);
        setDraft(next);
        setSavedDraft(current ? JSON.stringify(next) : '');
        setEditorRevision(current?.revision ?? null);
        setSampleUnits('');
    };
    const mergeSaved = (saved: StoredPricingCostRule[]) => {
        setData((previous) => ({
            ...previous,
            rules: [
                ...previous.rules.filter(
                    (rule) =>
                        !saved.some(
                            (row) => row.id === rule.id || (row.model_id === rule.model_id && row.tier === rule.tier),
                        ),
                ),
                ...saved,
            ],
        }));
    };
    const run = async (action: string, operation: () => Promise<void>) => {
        if (lock.current) return;
        lock.current = true;
        setBusy(action);
        setError('');
        setNotice('');
        try {
            await operation();
        } catch (caught) {
            if (mounted.current) {
                dispatchReview({ type: 'invalidate' });
                setError(
                    caught instanceof Error
                        ? caught.message
                        : en
                          ? 'The operation could not be completed.'
                          : '操作未完成。',
                );
            }
        } finally {
            lock.current = false;
            if (mounted.current) setBusy(null);
        }
    };
    const save = () =>
        run('save', async () => {
            if (!modelId || !tier || !calculation || !capability) return;
            const saved = await saveCostPricingRules(
                [{ model_id: modelId, tier, expected_revision: editorRevision, config: calculation.config }],
                en,
            );
            if (!mounted.current) return;
            invalidate();
            mergeSaved(saved);
            const next = draftFromCostConfig(saved[0].config);
            setDraft(next);
            setSavedDraft(JSON.stringify(next));
            setEditorRevision(saved[0].revision);
            setSelectedIds((ids) => Array.from(new Set([...ids, saved[0].id])));
            setNotice(
                en
                    ? 'Cost rule saved. Customer prices have not changed. Select saved rules below to preview publication.'
                    : '成本规则已保存，客户售价未变。可在下方勾选已保存规则，预览发布。',
            );
        });
    const bulkSave = () =>
        run('bulk', async () => {
            if (!bulkMultiplierValid || selectedRules.length === 0) return;
            const inputs = selectedRules.map((rule) => {
                const config = costConfigFromDraft({
                    ...draftFromCostConfig(rule.config),
                    retail_multiplier: bulkRetailMultiplier,
                });
                if (!config)
                    throw new Error(
                        en
                            ? 'Review the saved quote and retail multiplier before saving.'
                            : '请核对已保存的报价和售价倍率后再保存。',
                    );
                return { model_id: rule.model_id, tier: rule.tier, expected_revision: rule.revision, config };
            });
            for (const input of inputs) calculateCostPricing(pricingCostConfigSchema.parse(input.config));
            const saved = await saveCostPricingRules(inputs, en);
            if (!mounted.current) return;
            invalidate();
            mergeSaved(saved);
            const updatedEditor = saved.find((rule) => rule.model_id === modelId && rule.tier === tier);
            if (updatedEditor) {
                const next = draftFromCostConfig(updatedEditor.config);
                setDraft(next);
                setSavedDraft(JSON.stringify(next));
                setEditorRevision(updatedEditor.revision);
            }
            setBulkRetailMultiplier('');
            setNotice(
                en
                    ? `Retail multipliers saved for ${saved.length} rules. Customer prices are unchanged; preview publication next.`
                    : `已保存 ${saved.length} 条规则的售价倍率，客户售价未变；下一步请预览发布。`,
            );
        });
    const preview = () =>
        run('preview', async () => {
            if (
                selectedRules.length === 0 ||
                selectedBlockReason ||
                dirty ||
                bulkDirty ||
                bulkMultiplierError ||
                data.source_error
            )
                return;
            const expectedRevision = revision.current;
            const prepared = await requestCostPricingPreview(costRuleSelections(data.rules, selectedIds), en);
            if (!mounted.current || revision.current !== expectedRevision) return;
            setNow(Date.now());
            dispatchReview({ type: 'prepare', prepared });
        });
    const publish = () =>
        run('publish', async () => {
            if (
                !review.prepared ||
                !review.confirmed ||
                dirty ||
                bulkDirty ||
                bulkMultiplierError ||
                selectedBlockReason ||
                data.source_error
            )
                return;
            try {
                const job = await publishCostPricingReview(review.prepared, en);
                if (!mounted.current) return;
                dispatchReview({ type: 'invalidate' });
                setNotice(
                    en
                        ? 'Publication task submitted. Prices become effective only after verification; check Publication tasks below.'
                        : '发布任务已提交；核验通过才会生效，请查看下方发布任务。',
                );
                onPublished(job);
            } finally {
                onUncertain();
            }
        });

    const formBlocked = busy !== null || loading;
    const previewExpired = review.prepared !== null && Date.parse(review.prepared.preview.expires_at) <= now;
    const editorBlock =
        capability && !capability.publishable
            ? capability.reason ||
              (en
                  ? 'Estimation and saving are available. Publication is not supported yet.'
                  : '可保存和试算，当前未支持发布。')
            : null;
    const sourceUnit = draft.currency === 'cny' ? '¥' : en ? 'credits' : '额度';

    return (
        <section
            aria-labelledby="cost-pricing-title"
            className={`mb-8 rounded-xl border p-4 sm:p-6 ${isDark ? 'border-slate-700 bg-slate-800/70 text-slate-100' : 'border-slate-200 bg-white text-slate-900 shadow-sm'}`}
        >
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <h2 id="cost-pricing-title" className="text-lg font-semibold">
                        {en ? 'Set your retail multiplier' : '按倍率定价'}
                    </h2>
                    <p className={`mt-1 text-sm leading-relaxed ${classes.muted}`}>
                        {en
                            ? 'Save the supplier quote, enter your retail multiplier, review every affected tier, then publish.'
                            : '保存上游报价，直接填写你的售价倍率，核对各档影响后发布。'}
                    </p>
                </div>
                <button type="button" disabled={formBlocked} onClick={() => void reload()} className={classes.button}>
                    {loading ? (en ? 'Loading…' : '加载中…') : en ? 'Reload costs' : '重新加载成本'}
                </button>
            </div>
            <ol className={`my-5 grid gap-2 text-sm sm:grid-cols-3 ${classes.muted}`}>
                <li>{en ? '1. Choose a model and tier' : '1. 选择模型与档次'}</li>
                <li>{en ? '2. Save costs and retail multiplier' : '2. 保存成本与售价倍率'}</li>
                <li>{en ? '3. Review and publish' : '3. 预览并发布'}</li>
            </ol>
            {error && (
                <p
                    role="alert"
                    className={`mb-4 rounded-lg border p-3 text-sm ${isDark ? 'border-red-800 bg-red-950/30 text-red-300' : 'border-red-200 bg-red-50 text-red-700'}`}
                >
                    {error}
                </p>
            )}
            {notice && (
                <p
                    role="status"
                    className={`mb-4 rounded-lg border p-3 text-sm ${isDark ? 'border-emerald-800 bg-emerald-950/30 text-emerald-200' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}
                >
                    {notice}
                </p>
            )}
            {data.source_error && (
                <p role="alert" className={`mb-4 ${classes.warning}`}>
                    {en
                        ? 'Billing verification is unavailable; publication is disabled. '
                        : '暂时无法核对实际计费配置，已暂停发布。'}
                    {data.source_error}
                </p>
            )}

            <div ref={editor} className="scroll-mt-6">
                <fieldset disabled={formBlocked} className="space-y-5">
                    <legend className="sr-only">{en ? 'Supplier cost settings' : '上游成本设置'}</legend>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <Field label={en ? 'Model' : '模型'}>
                            <select
                                value={modelId}
                                className={classes.input}
                                onChange={(event) => loadTarget(event.target.value, '')}
                            >
                                <option value="">{en ? 'Choose a model' : '请选择模型'}</option>
                                {models
                                    .filter((model) => data.capabilities.some((row) => row.model_id === model.id))
                                    .map((model) => (
                                        <option key={model.id} value={model.id}>
                                            {model.display_name} · {model.slug}
                                            {!model.enabled ? (en ? ' (not listed)' : '（未上架）') : ''}
                                        </option>
                                    ))}
                            </select>
                        </Field>
                        <Field label={en ? 'Tier' : '档次'}>
                            <select
                                value={tier}
                                className={classes.input}
                                disabled={!modelId || formBlocked}
                                onChange={(event) => loadTarget(modelId, event.target.value)}
                            >
                                <option value="">{en ? 'Choose a registered tier' : '请选择已登记档次'}</option>
                                {data.capabilities
                                    .filter((row) => row.model_id === modelId)
                                    .map((row) => (
                                        <option key={row.tier} value={row.tier}>
                                            {row.tier}
                                        </option>
                                    ))}
                            </select>
                        </Field>
                    </div>
                    {modelId && tier && capability && (
                        <>
                            <div className="flex flex-wrap items-center gap-3">
                                <button type="button" className={classes.button} onClick={() => loadTarget('', '')}>
                                    {dirty
                                        ? en
                                            ? 'Discard edits'
                                            : '放弃未保存修改'
                                        : en
                                          ? 'Close editor'
                                          : '收起编辑'}
                                </button>
                                <h3 className="text-sm font-semibold">
                                    {selectedModel?.display_name} · {tier}
                                </h3>
                                <span
                                    className={`rounded-full px-3 py-1 text-xs ${isDark ? 'bg-slate-700 text-slate-200' : 'bg-slate-100 text-slate-700'}`}
                                >
                                    {basisLabel(capability.basis, en)}
                                </span>
                                <span className={`text-xs ${classes.muted}`}>
                                    {dirty
                                        ? en
                                            ? 'Unsaved changes'
                                            : '有未保存修改'
                                        : en
                                          ? 'Cost saved · retail unchanged'
                                          : '成本已保存 · 售价未变'}
                                </span>
                            </div>
                            {editorBlock && <p className={classes.warning}>{editorBlock}</p>}
                            {capability.basis === 'unknown' && (
                                <Field
                                    label={
                                        en
                                            ? 'Estimation unit (does not change billing)'
                                            : '试算单位（不会改变计费方式）'
                                    }
                                >
                                    <select
                                        className={classes.input}
                                        value={draft.basis}
                                        onChange={(event) =>
                                            changeDraft(
                                                newCostDraft({
                                                    ...capability,
                                                    basis: event.target.value as 'token' | 'image' | 'video',
                                                }),
                                            )
                                        }
                                    >
                                        <option value="token">{en ? 'Tokens' : '按 token'}</option>
                                        <option value="image">{en ? 'Images' : '按张'}</option>
                                        <option value="video">{en ? 'Video seconds' : '按秒'}</option>
                                    </select>
                                </Field>
                            )}
                            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                                <Field label={en ? 'Base quote currency' : '基础报价单位'}>
                                    <select
                                        className={classes.input}
                                        value={draft.currency}
                                        onChange={(event) =>
                                            changeDraft({ ...draft, currency: event.target.value as 'cny' | 'credits' })
                                        }
                                    >
                                        <option value="cny">{en ? 'Chinese yuan (CNY)' : '人民币（元）'}</option>
                                        <option value="credits">{en ? 'Supplier credits' : '上游账户额度'}</option>
                                    </select>
                                </Field>
                                {draft.currency === 'credits' && (
                                    <NumericField
                                        label={en ? 'Credits received per ¥1' : '每充值 1 元到账额度'}
                                        value={draft.credits_per_cny}
                                        onChange={(value) => changeDraft({ ...draft, credits_per_cny: value })}
                                        hint={
                                            en
                                                ? 'Use the actual credits received after the recharge discount.'
                                                : '按实际充值兑换比例填写，包含充值折扣。'
                                        }
                                        className={classes.input}
                                    />
                                )}
                                <CostMultiplierFields
                                    draft={draft}
                                    en={en}
                                    className={classes.input}
                                    onChange={setDraft}
                                    onInvalidate={invalidate}
                                />
                            </div>
                            <p className="text-sm font-medium" aria-live="polite">
                                <CostMultiplierSummary
                                    upstream={draft.upstream_multiplier}
                                    retail={draft.retail_multiplier}
                                    en={en}
                                />
                            </p>
                            <p className={`text-xs leading-relaxed ${classes.muted}`}>
                                {en
                                    ? 'Cost = base quote × supplier multiplier ÷ credits per CNY. Retail = base quote × my retail multiplier ÷ credits per CNY. Base quotes exclude multipliers. CNY quotes need no credit conversion. Profit estimates exclude payment fees.'
                                    : '成本 = 基础报价 × 上游倍率 ÷ 每元到账额度；售价 = 基础报价 × 我的售价倍率 ÷ 每元到账额度。基础报价不含倍率，人民币报价无需额度换算；预计毛利未扣支付手续费等费用。'}
                            </p>
                            {draft.basis === 'token' ? (
                                <div className="space-y-3">
                                    <h4 className="text-sm font-semibold">
                                        {en
                                            ? `Base quote, before multipliers (${sourceUnit} / 1M tokens)`
                                            : `基础报价，不含倍率（${sourceUnit}／百万 token）`}
                                    </h4>
                                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                                        {(['input', 'output', 'cache_read', 'cache_write'] as const).map((key) => (
                                            <NumericField
                                                key={key}
                                                label={
                                                    {
                                                        input: en ? 'Input · required' : '输入 · 必填',
                                                        output: en ? 'Output · required' : '输出 · 必填',
                                                        cache_read: en ? 'Cache read · optional' : '缓存读取 · 可选',
                                                        cache_write: en ? 'Cache write · optional' : '缓存写入 · 可选',
                                                    }[key]
                                                }
                                                value={draft.token_rates[key]}
                                                onChange={(value) =>
                                                    changeDraft({
                                                        ...draft,
                                                        token_rates: { ...draft.token_rates, [key]: value },
                                                    })
                                                }
                                                className={classes.input}
                                            />
                                        ))}
                                    </div>
                                    <p className={`text-xs ${classes.muted}`}>
                                        {en
                                            ? 'Blank cache prices mean not provided, not free. Cache estimates may be saved; cache publication is not supported yet.'
                                            : '缓存留空表示未提供，不代表免费；缓存可保存试算，当前尚未支持发布缓存价格。'}
                                    </p>
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    <h4 className="text-sm font-semibold">
                                        {en ? 'Base quotes by specification' : '各规格基础报价（不含倍率）'}
                                    </h4>
                                    {draft.variants.map((variant, index) => {
                                        const update = (changes: Partial<CostPricingDraft['variants'][number]>) =>
                                            changeDraft({
                                                ...draft,
                                                variants: draft.variants.map((row, rowIndex) =>
                                                    rowIndex === index ? { ...row, ...changes } : row,
                                                ),
                                            });
                                        return (
                                            <div
                                                key={variant.key}
                                                className={`space-y-4 rounded-lg border p-4 ${isDark ? 'border-slate-700' : 'border-slate-200'}`}
                                            >
                                                <div className="flex items-center justify-between gap-3">
                                                    <span className="text-sm font-medium">
                                                        {en ? 'Specification' : '规格'} {index + 1}
                                                    </span>
                                                    {draft.variants.length > 1 && (
                                                        <button
                                                            type="button"
                                                            className={classes.button}
                                                            onClick={() =>
                                                                changeDraft({
                                                                    ...draft,
                                                                    variants: draft.variants.filter(
                                                                        (_, rowIndex) => rowIndex !== index,
                                                                    ),
                                                                })
                                                            }
                                                        >
                                                            {en ? 'Remove specification' : '移除此规格'}
                                                        </button>
                                                    )}
                                                </div>
                                                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                                                    <Field label={en ? 'Name' : '规格名称'}>
                                                        <input
                                                            className={classes.input}
                                                            maxLength={120}
                                                            value={variant.label}
                                                            onChange={(event) => update({ label: event.target.value })}
                                                        />
                                                    </Field>
                                                    <CostResolutionField
                                                        resolution={variant.resolution}
                                                        fixedResolution={capability.resolution}
                                                        className={classes.input}
                                                        en={en}
                                                        onChange={(resolution) => update({ resolution })}
                                                    />
                                                    {
                                                        <NumericField
                                                            label={
                                                                en
                                                                    ? `Reference quote (${sourceUnit} / ${draft.basis === 'image' ? 'image' : 'second'})`
                                                                    : `上游参考价（${sourceUnit}／${draft.basis === 'image' ? '张' : '秒'}）`
                                                            }
                                                            value={variant.price}
                                                            onChange={(value) => update({ price: value })}
                                                            className={classes.input}
                                                        />
                                                    }
                                                    {draft.basis === 'video' && (
                                                        <>
                                                            <Field label={en ? 'Audio' : '声音'}>
                                                                <select
                                                                    className={classes.input}
                                                                    value={variant.audio}
                                                                    onChange={(event) =>
                                                                        update({
                                                                            audio: event.target
                                                                                .value as typeof variant.audio,
                                                                        })
                                                                    }
                                                                >
                                                                    <option value="any">
                                                                        {en
                                                                            ? 'Same price / not distinguished'
                                                                            : '不区分／同价'}
                                                                    </option>
                                                                    <option value="silent">
                                                                        {en ? 'Silent' : '无声'}
                                                                    </option>
                                                                    <option value="audio">
                                                                        {en ? 'With audio' : '有声'}
                                                                    </option>
                                                                </select>
                                                            </Field>
                                                            <Field label={en ? 'Reference video' : '参考视频'}>
                                                                <select
                                                                    className={classes.input}
                                                                    value={variant.reference_video}
                                                                    onChange={(event) =>
                                                                        update({
                                                                            reference_video: event.target
                                                                                .value as typeof variant.reference_video,
                                                                        })
                                                                    }
                                                                >
                                                                    <option value="any">
                                                                        {en
                                                                            ? 'Same price / not distinguished'
                                                                            : '不区分／同价'}
                                                                    </option>
                                                                    <option value="without">
                                                                        {en ? 'Without reference video' : '无参考视频'}
                                                                    </option>
                                                                    <option value="with">
                                                                        {en ? 'With reference video' : '有参考视频'}
                                                                    </option>
                                                                </select>
                                                            </Field>
                                                            {
                                                                <NumericField
                                                                    label={
                                                                        en ? 'Minimum billable seconds' : '最低计费秒数'
                                                                    }
                                                                    value={variant.minimum_units}
                                                                    onChange={(value) =>
                                                                        update({ minimum_units: value })
                                                                    }
                                                                    className={classes.input}
                                                                />
                                                            }
                                                            {
                                                                <NumericField
                                                                    label={
                                                                        en
                                                                            ? 'Rounding step (seconds)'
                                                                            : '计费步长（秒）'
                                                                    }
                                                                    value={variant.step_units}
                                                                    onChange={(value) => update({ step_units: value })}
                                                                    hint={
                                                                        en
                                                                            ? 'Time beyond the minimum is rounded up by this step.'
                                                                            : '超过最低时长的部分，按此步长向上取整。'
                                                                    }
                                                                    className={classes.input}
                                                                />
                                                            }
                                                        </>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                    {!capability.resolution && (
                                        <button
                                            type="button"
                                            className={classes.button}
                                            onClick={() =>
                                                changeDraft({
                                                    ...draft,
                                                    variants: [
                                                        ...draft.variants,
                                                        {
                                                            key: `spec_${crypto.randomUUID().replaceAll('-', '')}`,
                                                            label: '',
                                                            resolution: 'default',
                                                            audio: 'any',
                                                            reference_video: 'any',
                                                            price: '',
                                                            minimum_units: draft.basis === 'image' ? '1' : '',
                                                            step_units: draft.basis === 'image' ? '1' : '',
                                                        },
                                                    ],
                                                })
                                            }
                                        >
                                            {en ? 'Add specification' : '添加规格'}
                                        </button>
                                    )}
                                    {draft.basis === 'video' && (
                                        <p className={classes.warning}>
                                            {en
                                                ? 'These are per-second cost estimates. They do not convert token-based or fixed-task video billing into per-second billing. Video publication is not supported yet.'
                                                : '这里保存按秒成本试算，不会把按 token 或按任务计费的视频改成按秒扣费。视频价格发布暂未开放。'}
                                        </p>
                                    )}
                                </div>
                            )}
                            <Field
                                label={en ? 'Cost source / note' : '成本来源／备注'}
                                hint={
                                    en
                                        ? 'Record the quote source and date. Do not enter API keys, passwords or other credentials.'
                                        : '可记录供应商报价来源和日期；不要填写 API Key、密码等凭据。'
                                }
                            >
                                <textarea
                                    rows={2}
                                    className={classes.input}
                                    maxLength={500}
                                    value={draft.source_note}
                                    onChange={(event) => changeDraft({ ...draft, source_note: event.target.value })}
                                />
                            </Field>
                            {calculation ? (
                                <div className="space-y-3">
                                    <h4 className="text-sm font-semibold">
                                        {en ? 'Cost and retail estimate' : '成本与售价试算'}
                                    </h4>
                                    <CostEstimateTable lines={calculation.lines} en={en} isDark={isDark} />
                                    {draft.basis !== 'token' && (
                                        <div className="space-y-2">
                                            {
                                                <NumericField
                                                    label={
                                                        en
                                                            ? draft.basis === 'image'
                                                                ? 'Example image count'
                                                                : 'Example duration (seconds)'
                                                            : draft.basis === 'image'
                                                              ? '试算张数'
                                                              : '试算时长（秒）'
                                                    }
                                                    value={sampleUnits}
                                                    onChange={setSampleUnits}
                                                    className={classes.input}
                                                />
                                            }
                                            {sampleUnits.trim() !== '' &&
                                                Number.isFinite(Number(sampleUnits)) &&
                                                Number(sampleUnits) >= 0 &&
                                                calculation.config.variants.map((variant) => {
                                                    try {
                                                        const sample = calculateCostSample(
                                                            calculation.config,
                                                            variant.key,
                                                            Number(sampleUnits),
                                                        );
                                                        return (
                                                            <p key={variant.key} className={`text-sm ${classes.muted}`}>
                                                                {variant.label}：{en ? 'Billable quantity' : '计费用量'}{' '}
                                                                {sample.billed_units}{' '}
                                                                {draft.basis === 'image'
                                                                    ? en
                                                                        ? 'images'
                                                                        : '张'
                                                                    : en
                                                                      ? 'seconds'
                                                                      : '秒'}{' '}
                                                                · {en ? 'Cost' : '成本'} {money(sample.cost)} ·{' '}
                                                                {en ? 'Retail' : '售价'} {money(sample.retail)} ·{' '}
                                                                {en ? 'Gross profit' : '预计毛利'}{' '}
                                                                {money(sample.profit)}
                                                            </p>
                                                        );
                                                    } catch {
                                                        return (
                                                            <p key={variant.key} className={`text-sm ${classes.muted}`}>
                                                                {en ? 'Check the sample quantity.' : '请检查试算数量。'}
                                                            </p>
                                                        );
                                                    }
                                                })}
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <p
                                    className={`rounded-lg border border-dashed p-4 text-sm ${isDark ? 'border-slate-600 text-slate-300' : 'border-slate-300 text-slate-600'}`}
                                >
                                    {draftValidation.message ??
                                        (en
                                            ? 'Enter the actual base quote, supplier multiplier and your retail multiplier to calculate. Required numeric values must be valid; blank prices will not be assumed.'
                                            : '填好真实基础报价、上游倍率和我的售价倍率后显示试算。请补齐有效必填数值，系统不会猜测空白价格。')}
                                </p>
                            )}
                            <div className="flex flex-wrap items-center gap-3">
                                <button
                                    type="button"
                                    className={classes.primary}
                                    disabled={!calculation || !dirty || formBlocked}
                                    onClick={() => void save()}
                                >
                                    {busy === 'save'
                                        ? en
                                            ? 'Saving…'
                                            : '保存中…'
                                        : en
                                          ? 'Save cost rule'
                                          : '保存成本规则'}
                                </button>
                                <p className={`text-xs ${classes.muted}`}>
                                    {en
                                        ? 'Saving costs does not change customer prices or new-api settings.'
                                        : '仅保存成本草稿，不改变客户售价或 new-api 配置。'}
                                </p>
                            </div>
                        </>
                    )}
                </fieldset>
            </div>

            <div className={`mt-6 border-t pt-6 ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
                <h3 className="mb-2 text-base font-semibold">
                    {en ? 'Saved costs · batch pricing' : '已保存成本 · 批量定价'}
                </h3>
                <p className={`mb-4 text-sm ${classes.muted}`}>
                    {en
                        ? 'Choose saved rules, set one retail multiplier for them, then preview the complete publication impact.'
                        : '勾选已保存的成本规则，可统一设置售价倍率，再预览完整发布影响。'}
                </p>
                {data.rules.length === 0 ? (
                    <p
                        className={`rounded-lg border border-dashed p-5 text-sm ${isDark ? 'border-slate-600' : 'border-slate-300'} ${classes.muted}`}
                    >
                        {loading
                            ? en
                                ? 'Loading saved rules…'
                                : '正在加载成本规则…'
                            : en
                              ? 'No saved costs. Choose a model and tier above to add one.'
                              : '还没有成本规则，先在上方选择模型和档次，保存第一条。'}
                    </p>
                ) : (
                    <>
                        <div className="mb-3 flex flex-wrap items-center gap-3">
                            <button
                                type="button"
                                disabled={formBlocked}
                                className={classes.button}
                                onClick={() => {
                                    invalidate();
                                    setSelectedIds(data.rules.map((rule) => rule.id));
                                }}
                            >
                                {en ? 'Select all' : '全选'}
                            </button>
                            <button
                                type="button"
                                disabled={formBlocked}
                                className={classes.button}
                                onClick={() => {
                                    invalidate();
                                    setSelectedIds([]);
                                }}
                            >
                                {en ? 'Clear selection' : '取消选择'}
                            </button>
                            <span className={`text-sm ${classes.muted}`}>
                                {en ? `${selectedRules.length} selected` : `已选 ${selectedRules.length} 条`}
                            </span>
                        </div>
                        <SavedCostRuleList
                            rules={data.rules}
                            capabilities={data.capabilities}
                            models={models}
                            selectedIds={selectedIds}
                            busy={formBlocked}
                            en={en}
                            isDark={isDark}
                            onSelect={(id, selected) => {
                                invalidate();
                                setSelectedIds((ids) =>
                                    selected
                                        ? Array.from(new Set([...ids, id]))
                                        : ids.filter((current) => current !== id),
                                );
                            }}
                            onEdit={(rule) => {
                                loadTarget(rule.model_id, rule.tier);
                                editor.current?.scrollIntoView({
                                    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
                                        ? 'instant'
                                        : 'smooth',
                                    block: 'start',
                                });
                            }}
                        />
                        <fieldset disabled={formBlocked} className="mt-4 flex flex-wrap items-end gap-3">
                            <div className="w-full sm:max-w-xs">
                                {
                                    <NumericField
                                        label={en ? 'Retail multiplier for selected rules' : '统一售价倍率'}
                                        value={bulkRetailMultiplier}
                                        onChange={(value) => {
                                            invalidate();
                                            setBulkRetailMultiplier(value);
                                        }}
                                        hint={
                                            en
                                                ? 'Apply the same final multiplier to every selected rule; each keeps its own base quote and supplier multiplier.'
                                                : '所选规则使用同一最终倍率，各自的基础报价和上游倍率保持不变。'
                                        }
                                        className={classes.input}
                                    />
                                }
                            </div>
                            <button
                                type="button"
                                disabled={formBlocked || dirty || selectedRules.length === 0 || !bulkMultiplierValid}
                                className={classes.button}
                                onClick={() => void bulkSave()}
                            >
                                {busy === 'bulk'
                                    ? en
                                        ? 'Saving…'
                                        : '保存中…'
                                    : en
                                      ? 'Save selected retail multipliers'
                                      : '保存所选规则的售价倍率'}
                            </button>
                        </fieldset>
                        {bulkMultiplierError && (
                            <p role="alert" className={`mt-3 ${classes.warning}`}>
                                {bulkMultiplierError}
                            </p>
                        )}
                        {dirty && (
                            <p className={`mt-3 text-sm ${classes.muted}`}>
                                {en
                                    ? 'Save the edited cost above before batch changes or publication.'
                                    : '上方有未保存的成本修改，请先保存，再批量调整或预览发布。'}
                            </p>
                        )}
                        {bulkDirty && (
                            <p className={`mt-3 text-sm ${classes.muted}`}>
                                {en
                                    ? 'Save the batch retail multiplier or clear its input before publication.'
                                    : '批量售价倍率尚未保存，请先保存或清空此输入，再预览发布。'}
                            </p>
                        )}
                        {selectedBlockReason && (
                            <p className={`mt-3 ${classes.warning}`}>
                                {selectedBlockReason}
                                <span className="mt-1 block">
                                    {en
                                        ? 'You can still save costs. Deselect unsupported rules to publish the other rules.'
                                        : '仍可保存成本；取消勾选未支持发布的规则后，可发布其他规则。'}
                                </span>
                            </p>
                        )}
                        <button
                            type="button"
                            disabled={
                                formBlocked ||
                                dirty ||
                                bulkDirty ||
                                !!bulkMultiplierError ||
                                selectedRules.length === 0 ||
                                !!selectedBlockReason ||
                                !!data.source_error
                            }
                            className={`mt-4 ${classes.primary}`}
                            onClick={() => void preview()}
                        >
                            {busy === 'preview'
                                ? en
                                    ? 'Preparing preview…'
                                    : '正在生成预览…'
                                : en
                                  ? 'Preview selected prices'
                                  : '预览所选价格'}
                        </button>
                    </>
                )}
            </div>

            {review.prepared && (
                <div
                    className={`mt-6 space-y-4 rounded-xl border p-4 sm:p-5 ${isDark ? 'border-emerald-800 bg-slate-900/40' : 'border-emerald-200 bg-emerald-50/30'}`}
                >
                    <h3 className="text-base font-semibold">
                        {en ? 'Confirm publication impact' : '核对本次发布影响'}
                    </h3>
                    {review.prepared.cost_rows.length > 0 && (
                        <CostEstimateTable
                            lines={review.prepared.cost_rows.map((line, index) => ({
                                ...line,
                                key: `${line.model_id}:${line.tier}:${line.variant_key ?? index}`,
                                label: `${models.find((model) => model.id === line.model_id)?.display_name ?? line.model_id} · ${line.tier} · ${line.label}`,
                            }))}
                            en={en}
                            isDark={isDark}
                        />
                    )}
                    {review.prepared.preview.batch && (
                        <p className={`text-sm ${classes.muted}`}>
                            {en ? 'Models in this publication: ' : '本次批量发布模型：'}
                            {review.prepared.preview.batch.upstream_models.join('、')}
                        </p>
                    )}
                    <PricingPublishPreviewDetails preview={review.prepared.preview} en={en} isDark={isDark} />
                    <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-relaxed">
                        <input
                            type="checkbox"
                            checked={review.confirmed}
                            disabled={formBlocked || previewExpired}
                            onChange={(event) => dispatchReview({ type: 'confirm', confirmed: event.target.checked })}
                            className="mt-1 h-5 w-5 shrink-0 accent-emerald-600"
                        />
                        <span>
                            {en
                                ? 'I reviewed every affected model and tier, including changes to other tiers sharing the base price.'
                                : '我已核对全部受影响模型和档次，包括共享基础价格导致的其他档次变化。'}
                        </span>
                    </label>
                    {previewExpired && (
                        <p role="status" className={classes.warning}>
                            {en
                                ? 'This preview expired. Preview again before publishing.'
                                : '预览已过期，请重新预览后发布。'}
                        </p>
                    )}
                    <button
                        type="button"
                        className={classes.primary}
                        disabled={
                            formBlocked ||
                            !review.confirmed ||
                            previewExpired ||
                            dirty ||
                            bulkDirty ||
                            !!bulkMultiplierError
                        }
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
        </section>
    );
}
