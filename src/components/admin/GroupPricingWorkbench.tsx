'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Locale } from '@/lib/locale';
import type { PricingGroupCatalog, PricingGroupModel, PricingGroupTier } from '@/lib/admin/pricing-group-types';
import type { PricingPublishJob, PricingPublishPreview, TieredPricingDetails } from '@/lib/admin/pricing-publish-types';
import type { StoredPricingCostRule } from '@/lib/admin/pricing-cost-types';
import { calculateCostPricing } from '@/lib/admin/pricing-cost';
import type { CostPricingDraft } from './CostPricingWorkbench.helpers';
import {
    GroupPricingRequestError,
    groupInitialDrafts,
    groupInitialSettings,
    groupModelConfig,
    groupModelIssue,
    groupPreviewInput,
    groupSettingsValue,
    publishGroupPricing,
    requestGroupPricingPreview,
    type GroupModelDrafts,
    type GroupPricingPrepared,
    type GroupSettingsDraft,
} from './GroupPricingWorkbench.helpers';

const tokenKeys = ['input', 'output', 'cache_read', 'cache_write', 'cache_write_1h'] as const;
const tokenLabels = {
    input: '输入',
    output: '输出',
    cache_read: '缓存读取',
    cache_write: '缓存写入',
    cache_write_1h: '缓存写入 / 1 小时',
};
const englishLabels = {
    input: 'Input',
    output: 'Output',
    cache_read: 'Cache read',
    cache_write: 'Cache write',
    cache_write_1h: 'Cache write / 1 hour',
};
const emptySettings: GroupSettingsDraft = {
    currency: 'credits',
    credits_per_cny: '',
    upstream_multiplier: '',
    retail_multiplier: '',
};
const money = (value: number) => `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 12 })}`;
const plain = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 12 });

function PriceLines({ details, en }: { details: TieredPricingDetails; en: boolean }) {
    const rates = details.tiers[0]?.rates;
    if (!rates) return null;
    return (
        <dl className="grid grid-cols-2 gap-x-5 gap-y-1 text-sm sm:grid-cols-3">
            {tokenKeys.map((key) =>
                rates[key] == null ? null : (
                    <div key={key} className="flex flex-wrap justify-between gap-2">
                        <dt className="opacity-75">{en ? englishLabels[key] : tokenLabels[key]}</dt>
                        <dd className="font-medium tabular-nums">{money(rates[key]!)}</dd>
                    </div>
                ),
            )}
        </dl>
    );
}

export function GroupPricingPreview({
    preview,
    en,
    isDark,
}: {
    preview: PricingPublishPreview;
    en: boolean;
    isDark: boolean;
}) {
    const border = isDark ? 'border-slate-700' : 'border-slate-200';
    return (
        <div className="space-y-3">
            {preview.rows.map((row, index) => (
                <article
                    key={`${row.model_id}:${row.tier}:${index}`}
                    className={`space-y-3 rounded-lg border p-3 ${border}`}
                >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="font-medium">
                            {row.model_name} · {row.tier}
                        </h4>
                        <span className="text-xs opacity-75">
                            {row.after.per_image_cny != null
                                ? en
                                    ? 'CNY / image'
                                    : '元 / 张'
                                : en
                                  ? 'CNY / 1M tokens'
                                  : '元 / 百万 token'}
                        </span>
                    </div>
                    {row.after_details ? (
                        <PriceLines details={row.after_details} en={en} />
                    ) : row.after.per_image_cny !== null ? (
                        <p className="font-medium tabular-nums">
                            {money(row.after.per_image_cny)} / {en ? 'image' : '张'}
                        </p>
                    ) : (
                        <p className="text-sm">
                            {en ? 'Input' : '输入'} {money(row.after.input_cny_per_1m!)} · {en ? 'Output' : '输出'}{' '}
                            {money(row.after.output_cny_per_1m!)}
                        </p>
                    )}
                </article>
            ))}
            {!!preview.customer_overrides?.length && (
                <details className={`rounded-lg border p-3 ${border}`}>
                    <summary className="cursor-pointer text-sm font-medium">
                        {en ? 'Customer-specific prices' : '客户专属价格'} ({preview.customer_overrides.length})
                    </summary>
                    <p className="my-3 text-xs opacity-75">
                        {en
                            ? 'Existing customer-specific multipliers replace the public group multiplier.'
                            : '已有客户专属倍率替代公共分组倍率，以下为这些客户的价格。'}
                    </p>
                    <div className="space-y-3">
                        {preview.customer_overrides.map((row, index) => (
                            <section key={`${row.group}:${index}`} className="space-y-2">
                                <h5 className="text-sm font-medium">
                                    {row.model_name && `${row.model_name} · `}
                                    {row.group} · {row.count} {en ? 'customer overrides' : '条专属配置'} · {row.ratio}×
                                </h5>
                                <PriceLines details={row.after} en={en} />
                            </section>
                        ))}
                    </div>
                </details>
            )}
            {!!preview.customer_request_overrides?.length && (
                <details className={`rounded-lg border p-3 ${border}`}>
                    <summary className="cursor-pointer text-sm font-medium">
                        {en ? 'Customer-specific image prices' : '客户专属图片价格'} (
                        {preview.customer_request_overrides.length})
                    </summary>
                    <div className="mt-3 space-y-2">
                        {preview.customer_request_overrides.map((row, index) => (
                            <p key={`${row.model_id}:${row.group}:${index}`} className="text-sm">
                                {row.model_name} · {row.group} · {row.count} {en ? 'overrides' : '条专属配置'}:{' '}
                                {money(row.after_per_image_cny)} / {en ? 'image' : '张'}
                            </p>
                        ))}
                    </div>
                </details>
            )}
            {preview.warnings.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-xs opacity-80">
                    {preview.warnings.map((warning, index) => (
                        <li key={index}>{warning}</li>
                    ))}
                </ul>
            )}
        </div>
    );
}

export function GroupModelQuote({
    model,
    draft,
    settings,
    isDark,
    en,
    disabled,
    allowQuoteEditing = true,
    onChange,
}: {
    model: PricingGroupModel;
    draft?: CostPricingDraft;
    settings: GroupSettingsDraft;
    isDark: boolean;
    en: boolean;
    disabled: boolean;
    allowQuoteEditing?: boolean;
    onChange: (draft: CostPricingDraft) => void;
}) {
    const issue = groupModelIssue(model, draft, settings, en);
    const [expanded, setExpanded] = useState(() => !!issue);
    const config = groupModelConfig(model, draft, settings);
    const calculation = config ? calculateCostPricing(config) : null;
    const labels = en ? englishLabels : tokenLabels;
    const border = isDark ? 'border-slate-700' : 'border-slate-200';
    const inputClass = `min-h-11 w-full rounded-lg border px-3 py-2 tabular-nums focus-visible:outline-2 focus-visible:outline-emerald-500 disabled:opacity-50 ${isDark ? 'border-slate-600 bg-slate-950' : 'border-slate-300 bg-white'}`;
    const source =
        model.base_source === 'saved'
            ? en
                ? 'Saved base quote'
                : '已保存基础报价'
            : model.base_source === 'reference'
              ? en
                  ? 'System reference quote'
                  : '系统读取的上游参考价'
              : en
                ? 'Supplier quote required'
                : '请填写上游基础价';
    return (
        <article className={`rounded-xl border p-4 ${border}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h4 className="font-semibold">{model.display_name}</h4>
                    <p className="mt-1 break-all text-xs opacity-70">{model.upstream_model}</p>
                </div>
                <span
                    className={`rounded-md px-2 py-1 text-xs ${issue ? (isDark ? 'bg-amber-950/50 text-amber-200' : 'bg-amber-50 text-amber-900') : isDark ? 'bg-emerald-950/50 text-emerald-200' : 'bg-emerald-50 text-emerald-800'}`}
                >
                    {issue ? (en ? 'Needs attention' : '待处理') : en ? 'Ready' : '可定价'}
                </span>
            </div>
            {issue && <p className="mt-3 text-sm text-amber-700 dark:text-amber-300">{issue}</p>}
            {draft && (
                <>
                    <div className="mt-3 grid gap-4 lg:grid-cols-2">
                        <div>
                            <p className="mb-2 text-xs opacity-70">
                                {source} ·{' '}
                                {settings.currency === 'credits' ? (en ? 'credits' : '额度') : en ? 'CNY' : '元'} /{' '}
                                {draft.basis === 'token'
                                    ? en
                                        ? '1M tokens'
                                        : '百万 token'
                                    : draft.basis === 'image'
                                      ? en
                                          ? 'image'
                                          : '张'
                                      : en
                                        ? 'second'
                                        : '秒'}
                            </p>
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums">
                                {draft.basis === 'token'
                                    ? tokenKeys.map((key) =>
                                          draft.token_rates[key]?.trim() ? (
                                              <span key={key}>
                                                  {labels[key]} {plain(Number(draft.token_rates[key]))}
                                              </span>
                                          ) : null,
                                      )
                                    : draft.variants.map((variant) => (
                                          <span key={variant.key}>
                                              {variant.label || variant.resolution}:{' '}
                                              {variant.price.trim() ? plain(Number(variant.price)) : '—'}
                                          </span>
                                      ))}
                            </div>
                        </div>
                        <div>
                            <p className="mb-2 text-xs opacity-70">
                                {en ? 'Planned retail price' : '计划售价'} · {en ? 'CNY' : '人民币'}
                            </p>
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm font-medium tabular-nums">
                                {calculation ? (
                                    calculation.lines.map((line) => (
                                        <span key={line.key}>
                                            {en && tokenKeys.includes(line.key as (typeof tokenKeys)[number])
                                                ? englishLabels[line.key as (typeof tokenKeys)[number]]
                                                : line.label}{' '}
                                            {money(line.retail)}
                                        </span>
                                    ))
                                ) : (
                                    <span className="font-normal opacity-70">
                                        {en ? 'Complete shared settings and base quotes' : '填写三项参数后显示'}
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                    {model.selectable && allowQuoteEditing && (
                        <details
                            className="mt-3"
                            open={expanded}
                            onToggle={(event) => setExpanded(event.currentTarget.open)}
                        >
                            <summary className="w-fit cursor-pointer py-2 text-sm font-medium text-indigo-600 dark:text-indigo-300">
                                {issue
                                    ? en
                                        ? 'Complete base quote'
                                        : '补齐基础报价'
                                    : en
                                      ? 'Edit base quote'
                                      : '修改基础报价'}
                            </summary>
                            <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                                {draft.basis === 'token'
                                    ? tokenKeys
                                          .filter(
                                              (key) =>
                                                  key !== 'cache_write_1h' ||
                                                  draft.token_rates[key] ||
                                                  model.capability?.required_token_rates?.includes(key),
                                          )
                                          .map((key) => (
                                              <label key={key} className="space-y-1 text-sm">
                                                  <span>
                                                      {labels[key]}
                                                      {key === 'input' ||
                                                      key === 'output' ||
                                                      model.capability?.required_token_rates?.includes(key)
                                                          ? ' *'
                                                          : ''}
                                                  </span>
                                                  <input
                                                      type="number"
                                                      min="0"
                                                      step="any"
                                                      aria-label={`${model.display_name} ${labels[key]}`}
                                                      value={draft.token_rates[key] ?? ''}
                                                      disabled={disabled}
                                                      onChange={(event) =>
                                                          onChange({
                                                              ...draft,
                                                              token_rates: {
                                                                  ...draft.token_rates,
                                                                  [key]: event.target.value,
                                                              },
                                                          })
                                                      }
                                                      className={inputClass}
                                                  />
                                              </label>
                                          ))
                                    : draft.variants.map((variant, index) => (
                                          <label key={variant.key} className="space-y-1 text-sm">
                                              <span>
                                                  {variant.label || variant.resolution} /{' '}
                                                  {draft.basis === 'image'
                                                      ? en
                                                          ? 'image'
                                                          : '张'
                                                      : en
                                                        ? 'second'
                                                        : '秒'}{' '}
                                                  *
                                              </span>
                                              <input
                                                  type="number"
                                                  min="0"
                                                  step="any"
                                                  aria-label={`${model.display_name} ${variant.label || variant.resolution}`}
                                                  value={variant.price}
                                                  disabled={disabled}
                                                  onChange={(event) =>
                                                      onChange({
                                                          ...draft,
                                                          variants: draft.variants.map((row, rowIndex) =>
                                                              rowIndex === index
                                                                  ? { ...row, price: event.target.value }
                                                                  : row,
                                                          ),
                                                      })
                                                  }
                                                  className={inputClass}
                                              />
                                          </label>
                                      ))}
                            </div>
                            <p className="mt-2 text-xs opacity-70">
                                {en
                                    ? 'Enter base rates before the supplier multiplier. Leave unavailable cache rates empty; empty does not mean free.'
                                    : '填写乘上游倍率之前的基础价。未提供的缓存价留空，留空不代表免费。'}
                            </p>
                        </details>
                    )}
                    {model.selectable && !allowQuoteEditing && issue && (
                        <p className="mt-3 text-xs opacity-70">
                            {en
                                ? 'The supplier base quote is incomplete. Reload the new-api directory or fix the model registration before pricing this tier.'
                                : '系统没有读取到完整的上游基础价，请先更新 new-api 目录或处理模型登记；这里不需要手填价格。'}
                        </p>
                    )}
                </>
            )}
        </article>
    );
}

export default function GroupPricingWorkbench({
    isDark,
    locale,
    onPublished,
    onUncertain,
}: {
    isDark: boolean;
    locale: Locale;
    onPublished: (job: PricingPublishJob) => void;
    onUncertain: (message?: string) => void;
}) {
    const en = locale === 'en';
    const [groups, setGroups] = useState<PricingGroupTier[]>([]);
    const [groupId, setGroupId] = useState('');
    const [catalog, setCatalog] = useState<PricingGroupCatalog | null>(null);
    const [settings, setSettings] = useState<GroupSettingsDraft>(emptySettings);
    const [drafts, setDrafts] = useState<GroupModelDrafts>({});
    const [prepared, setPrepared] = useState<GroupPricingPrepared | null>(null);
    const [confirmed, setConfirmed] = useState(false);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<'preview' | 'publish' | null>(null);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [refresh, setRefresh] = useState(0);
    const [now, setNow] = useState(() => Date.now());
    const lock = useRef(false);
    const reviewRef = useRef<HTMLDivElement>(null);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    useEffect(() => {
        const controller = new AbortController();
        const url = groupId
            ? `/api/admin/pricing/group-workbench?group_id=${encodeURIComponent(groupId)}`
            : '/api/admin/pricing/group-workbench';
        void fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
            .then(async (response) => {
                const data = await response.json();
                if (!response.ok)
                    throw new Error(data.message || (en ? 'Unable to read this group.' : '读取档次失败。'));
                if (controller.signal.aborted) return;
                if (groupId) {
                    if (!data.catalog?.tier || data.catalog.tier.id !== groupId || !Array.isArray(data.catalog.models))
                        throw new Error(en ? 'Invalid group response.' : '档次信息不完整，请重试。');
                    setCatalog(data.catalog);
                    setSettings(groupInitialSettings(data.catalog));
                    setDrafts(groupInitialDrafts(data.catalog));
                } else {
                    if (!Array.isArray(data.groups))
                        throw new Error(en ? 'Invalid tier list.' : '档次列表不完整，请重试。');
                    setGroups(data.groups);
                }
            })
            .catch((caught) => {
                if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught));
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [groupId, refresh, en]);
    const resetCatalog = () => {
        setLoading(true);
        setError('');
        setCatalog(null);
        setDrafts({});
        setSettings(emptySettings);
        setPrepared(null);
        setConfirmed(false);
        setNotice('');
    };
    const input = useMemo(
        () => (catalog ? groupPreviewInput(catalog, drafts, settings) : null),
        [catalog, drafts, settings],
    );
    const issues = catalog?.models.filter((model) => groupModelIssue(model, drafts[model.id], settings, en)) ?? [];
    const invalidate = () => {
        setPrepared(null);
        setConfirmed(false);
        setNotice('');
        setError('');
    };
    const applySaved = (rules?: StoredPricingCostRule[], fingerprint?: string) => {
        if (!rules || !fingerprint) return;
        setCatalog((current) =>
            current
                ? {
                      ...current,
                      fingerprint,
                      models: current.models.map((row) => {
                          const rule = rules.find(
                              (candidate) => candidate.model_id === row.model_id && candidate.tier === current.tier.key,
                          );
                          return rule
                              ? { ...row, config: rule.config, saved_revision: rule.revision, saved_rule_id: rule.id }
                              : row;
                      }),
                  }
                : current,
        );
    };
    const preview = async () => {
        if (!input || lock.current) return;
        lock.current = true;
        setBusy('preview');
        setError('');
        setNotice('');
        setPrepared(null);
        setConfirmed(false);
        try {
            const result = await requestGroupPricingPreview(input, en);
            if (!mounted.current) return;
            applySaved(result.rules, result.catalog_fingerprint);
            setPrepared(result);
            setNotice(
                en
                    ? 'Group prices are ready. Review the complete group before publication.'
                    : '整组价格已准备好，请核对下方发布价格。',
            );
            requestAnimationFrame(() => reviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        } catch (caught) {
            if (!mounted.current) return;
            if (caught instanceof GroupPricingRequestError)
                applySaved(caught.saved.rules, caught.saved.catalog_fingerprint);
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            lock.current = false;
            if (mounted.current) setBusy(null);
        }
    };
    const publish = async () => {
        if (!prepared || !confirmed || lock.current || Date.parse(prepared.preview.expires_at) <= Date.now()) return;
        lock.current = true;
        setBusy('publish');
        setError('');
        try {
            const job = await publishGroupPricing(prepared, en);
            if (!mounted.current) return;
            setPrepared(null);
            setConfirmed(false);
            setNotice(
                en
                    ? 'Group publication submitted. Follow the Publication tasks tab until verified.'
                    : '整组发布任务已提交，请在「发布任务」标签查看进度；显示「已生效」后完成。',
            );
            onPublished(job);
        } catch (caught) {
            if (!mounted.current) return;
            setPrepared(null);
            setConfirmed(false);
            setError(caught instanceof Error ? caught.message : String(caught));
            onUncertain(caught instanceof Error ? caught.message : undefined);
        } finally {
            lock.current = false;
            if (mounted.current) setBusy(null);
        }
    };
    const card = isDark ? 'border-slate-700 bg-slate-900 text-slate-100' : 'border-slate-200 bg-white text-slate-900';
    const field = `min-h-11 w-full rounded-lg border px-3 py-2 focus-visible:outline-2 focus-visible:outline-emerald-500 disabled:opacity-50 ${isDark ? 'border-slate-600 bg-slate-950' : 'border-slate-300 bg-white'}`;
    const button =
        'min-h-11 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 disabled:cursor-not-allowed disabled:opacity-40';
    const expired = prepared ? Date.parse(prepared.preview.expires_at) <= now : false;
    return (
        <section
            aria-labelledby="group-pricing-title"
            className={`mb-6 space-y-5 rounded-xl border p-4 sm:p-6 ${card}`}
        >
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 id="group-pricing-title" className="text-lg font-semibold">
                        {en ? 'Price a whole tier' : '按档次统一定价'}
                    </h2>
                    <p className="mt-1 text-sm opacity-75">
                        {en
                            ? 'Choose a tier. The system reads its models and supplier base quotes; you only enter the recharge ratio and two multipliers.'
                            : '选择档次后，系统自动读取该分组的模型和上游基础价；你只需填写充值比例、上游倍率和售价倍率。'}
                    </p>
                </div>
                <button
                    type="button"
                    className={`min-h-11 rounded-lg border px-3 text-sm ${isDark ? 'border-slate-600' : 'border-slate-300'}`}
                    disabled={!!busy || loading}
                    onClick={() => {
                        resetCatalog();
                        setRefresh((value) => value + 1);
                    }}
                >
                    {en ? 'Reload models' : '重新读取模型'}
                </button>
            </div>
            <ol className="grid gap-2 text-xs opacity-70 sm:grid-cols-3">
                <li>{en ? '1. Choose tier' : '1. 选择档次'}</li>
                <li>{en ? '2. Enter the three pricing values' : '2. 填写充值比例和两种倍率'}</li>
                <li>{en ? '3. Preview and publish the group' : '3. 预览并发布整组'}</li>
            </ol>
            <label className="block max-w-2xl space-y-2 text-sm font-medium">
                <span>{en ? 'Tier' : '档次'}</span>
                <select
                    id="pricing-group-select"
                    value={groupId}
                    className={field}
                    disabled={!!busy}
                    onChange={(event) => {
                        resetCatalog();
                        setGroupId(event.target.value);
                    }}
                >
                    <option value="">{en ? 'Select a tier' : '请选择档次'}</option>
                    {groups.map((group) => (
                        <option key={group.id} value={group.id}>
                            {group.label}
                        </option>
                    ))}
                </select>
            </label>
            {loading && (
                <p role="status" className="text-sm opacity-70">
                    {en ? 'Reading group models…' : '正在读取档次与模型…'}
                </p>
            )}
            {!loading && !groupId && !groups.length && !error && (
                <p className="text-sm">
                    {en ? 'No enabled tiers. Configure a channel group first.' : '暂无启用档次，请先配置渠道分组。'}
                </p>
            )}
            {error && (
                <p
                    role="alert"
                    className={`rounded-lg border p-3 text-sm ${isDark ? 'border-red-800 bg-red-950/30 text-red-200' : 'border-red-200 bg-red-50 text-red-700'}`}
                >
                    {error}
                </p>
            )}
            {notice && (
                <p
                    role="status"
                    className={`rounded-lg p-3 text-sm ${isDark ? 'bg-emerald-950/40 text-emerald-200' : 'bg-emerald-50 text-emerald-800'}`}
                >
                    {notice}
                </p>
            )}
            {catalog && (
                <>
                    <p className="text-sm opacity-75">
                        new-api group: <strong className="font-medium">{catalog.tier.newapi_group}</strong> ·{' '}
                        {catalog.models.length} {en ? 'models' : '个模型'}
                    </p>
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                        <label className="space-y-2 text-sm">
                            <span>{en ? 'Base quote unit' : '基础报价单位'}</span>
                            <select
                                className={field}
                                value={settings.currency}
                                disabled={!!busy}
                                onChange={(event) => {
                                    invalidate();
                                    setSettings((value) => ({
                                        ...value,
                                        currency: event.target.value as 'credits' | 'cny',
                                        credits_per_cny: event.target.value === 'cny' ? '1' : '',
                                    }));
                                }}
                            >
                                <option value="credits">{en ? 'Supplier account credits' : '上游账户额度'}</option>
                                <option value="cny">{en ? 'CNY' : '人民币（元）'}</option>
                            </select>
                        </label>
                        {settings.currency === 'credits' && (
                            <label className="space-y-2 text-sm">
                                <span>{en ? 'Credits received per ¥1' : '每充值 1 元到账额度'}</span>
                                <input
                                    className={field}
                                    type="number"
                                    min="0"
                                    step="any"
                                    placeholder="10"
                                    value={settings.credits_per_cny}
                                    disabled={!!busy}
                                    onChange={(event) => {
                                        invalidate();
                                        setSettings((value) => ({ ...value, credits_per_cny: event.target.value }));
                                    }}
                                />
                                <p className="text-xs opacity-65">
                                    {en ? 'For a 1:10 recharge ratio, enter 10.' : '上游 1:10 充值，就填 10。'}
                                </p>
                            </label>
                        )}
                        <label className="space-y-2 text-sm">
                            <span>{en ? 'Supplier multiplier' : '上游倍率'}</span>
                            <input
                                className={field}
                                type="number"
                                min="0"
                                step="any"
                                placeholder="1.3"
                                value={settings.upstream_multiplier}
                                disabled={!!busy}
                                onChange={(event) => {
                                    invalidate();
                                    setSettings((value) => ({ ...value, upstream_multiplier: event.target.value }));
                                }}
                            />
                        </label>
                        <label className="space-y-2 text-sm">
                            <span>{en ? 'My retail multiplier' : '我的售价倍率'}</span>
                            <input
                                className={field}
                                type="number"
                                min="0"
                                step="any"
                                placeholder="1.6"
                                value={settings.retail_multiplier}
                                disabled={!!busy}
                                onChange={(event) => {
                                    invalidate();
                                    setSettings((value) => ({ ...value, retail_multiplier: event.target.value }));
                                }}
                            />
                            <p className="text-xs opacity-65">
                                {en ? 'Enter the final multiplier, for example 1.6.' : '直接填最终倍率，例如 1.6。'}
                            </p>
                        </label>
                    </div>
                    {groupSettingsValue(settings) ? (
                        <p className={`rounded-lg p-3 text-sm ${isDark ? 'bg-emerald-950/30' : 'bg-emerald-50'}`}>
                            {en ? 'For each unit of base quote: cost' : '每 1 单位基础价：成本'}{' '}
                            {money(
                                groupSettingsValue(settings)!.upstream_multiplier /
                                    groupSettingsValue(settings)!.credits_per_cny,
                            )}{' '}
                            · {en ? 'retail' : '售价'}{' '}
                            {money(
                                groupSettingsValue(settings)!.retail_multiplier /
                                    groupSettingsValue(settings)!.credits_per_cny,
                            )}
                            。{en ? 'Applies to every model below.' : '下方所有模型使用这组倍率。'}
                        </p>
                    ) : (
                        <p className="text-sm opacity-70">
                            {en
                                ? 'Complete the recharge ratio and multipliers. Retail must not be lower than the supplier multiplier.'
                                : '请填写充值比例和倍率，售价倍率不能低于上游倍率。'}
                        </p>
                    )}
                    {!!catalog.notices?.length && (
                        <details className="text-sm opacity-75">
                            <summary className="cursor-pointer">
                                {en ? 'Catalog notes' : '目录提示'} ({catalog.notices.length})
                            </summary>
                            <ul className="mt-2 list-disc space-y-1 pl-5">
                                {catalog.notices.map((message, index) => (
                                    <li key={index}>{message}</li>
                                ))}
                            </ul>
                        </details>
                    )}
                    {catalog.models.length > 30 && (
                        <p role="alert" className="text-sm text-amber-700">
                            {en
                                ? 'This group exceeds the current limit of 30 models. Group publication is unavailable.'
                                : '此档次超过当前支持的 30 个模型，暂不能整组发布。'}
                        </p>
                    )}
                    {catalog.reference_error && (
                        <p className="text-sm text-amber-700 dark:text-amber-300">{catalog.reference_error}</p>
                    )}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="font-semibold">
                            {en ? 'Models in this tier' : '本档次模型'} ({catalog.models.length})
                        </h3>
                        <p className="text-sm opacity-75">
                            {catalog.models.length - issues.length} {en ? 'ready' : '项已就绪'} · {issues.length}{' '}
                            {en ? 'need attention' : '项待处理'}
                        </p>
                    </div>
                    {issues.length > 0 && (
                        <p
                            className={`rounded-lg border p-3 text-sm ${isDark ? 'border-amber-800 bg-amber-950/30 text-amber-200' : 'border-amber-200 bg-amber-50 text-amber-900'}`}
                        >
                            {en
                                ? 'This tier cannot be previewed until every model is registered and has a supplier quote. Reload the directory or resolve the model registration below.'
                                : '统一倍率会影响整组模型，请先更新目录或处理下方模型登记问题，再预览整组。'}{' '}
                            <a className="underline" href="/admin/models">
                                {en ? 'Model management' : '前往模型管理'}
                            </a>
                        </p>
                    )}
                    {catalog.models.length === 0 ? (
                        <p className="text-sm">
                            {en ? 'No models found in this new-api group.' : '此 new-api 分组暂无模型。'}
                        </p>
                    ) : (
                        <div className="space-y-3">
                            {catalog.models.map((model) => (
                                <GroupModelQuote
                                    key={`${catalog.tier.id}:${model.id}`}
                                    model={model}
                                    draft={drafts[model.id]}
                                    settings={settings}
                                    isDark={isDark}
                                    en={en}
                                    disabled={!!busy}
                                    allowQuoteEditing={false}
                                    onChange={(draft) => {
                                        invalidate();
                                        setDrafts((value) => ({ ...value, [model.id]: draft }));
                                    }}
                                />
                            ))}
                        </div>
                    )}
                    <p className={`rounded-lg p-3 text-sm ${isDark ? 'bg-slate-800/80' : 'bg-slate-50'}`}>
                        {en
                            ? 'Supplier base quotes are read from the synced directory and shown above. Missing quotes block the preview; you do not need to re-enter them here.'
                            : '上游基础价由同步后的目录自动读取并在上方展示。缺少基础价时会阻止预览，你不需要在这里重新填写。'}
                    </p>
                    <p
                        className={`rounded-lg border p-3 text-sm ${isDark ? 'border-indigo-800 bg-indigo-950/20 text-indigo-200' : 'border-indigo-200 bg-indigo-50 text-indigo-900'}`}
                    >
                        {en
                            ? 'The model base price is global. This page changes only the selected new-api group multiplier. If a shared model does not match the target, open Global model pricing first and correct its official base expression; do not compensate by changing this group multiplier.'
                            : '模型官方基础价是全局共用的。本页只修改当前 new-api 分组倍率；共享模型若与目标价不一致，请先打开「全局模型定价」校正官方基础表达式，不要用本档次倍率去补偿。'}
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
                        <button
                            type="button"
                            className={button}
                            disabled={!input || !!busy}
                            onClick={() => void preview()}
                        >
                            {busy === 'preview'
                                ? en
                                    ? 'Preparing group…'
                                    : '正在核对整组…'
                                : en
                                  ? 'Preview group prices'
                                  : '预览整组价格'}
                        </button>
                        <p className="text-xs opacity-70">
                            {en ? 'Customer billing changes only after publication.' : '确认发布后才会改变客户扣费。'}
                        </p>
                    </div>
                </>
            )}
            {prepared && (
                <div
                    ref={reviewRef}
                    className={`scroll-mt-4 space-y-4 rounded-xl border p-4 ${isDark ? 'border-emerald-800 bg-emerald-950/20' : 'border-emerald-200 bg-emerald-50/30'}`}
                >
                    <h3 className="font-semibold">{en ? 'Review group publication' : '核对整组发布价格'}</h3>
                    <p className="text-sm">
                        {catalog?.tier.label} · {prepared.selections.length}{' '}
                        {en ? 'models in one publication task' : '个模型，一次提交发布任务'}
                    </p>
                    <GroupPricingPreview preview={prepared.preview} en={en} isDark={isDark} />
                    {expired && (
                        <p role="alert" className="text-sm text-amber-700">
                            {en ? 'Preview expired. Preview the group again.' : '预览已过期，请重新预览整组价格。'}
                        </p>
                    )}
                    <label className="flex items-start gap-2 text-sm">
                        <input
                            type="checkbox"
                            className="mt-1 size-4 shrink-0 accent-emerald-600"
                            checked={confirmed}
                            disabled={!!busy || expired}
                            onChange={(event) => setConfirmed(event.target.checked)}
                        />
                        <span>
                            {en
                                ? 'I confirm these prices for this tier and have reviewed customer-specific prices.'
                                : '确认本档次按以上价格收费，并已核对客户专属价格。'}
                        </span>
                    </label>
                    <button
                        type="button"
                        className={button}
                        disabled={!confirmed || expired || !!busy}
                        onClick={() => void publish()}
                    >
                        {busy === 'publish'
                            ? en
                                ? 'Submitting…'
                                : '正在提交…'
                            : en
                              ? 'Confirm and publish group'
                              : '确认并发布整组'}
                    </button>
                </div>
            )}
        </section>
    );
}
