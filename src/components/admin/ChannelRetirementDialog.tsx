'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { z } from 'zod';
import type { Locale } from '@/lib/locale';
import type {
    ChannelGroupRetirementPreview,
    ChannelGroupRetirementResult,
    ChannelGroupRetirementJobView,
    ChannelGroupRetirementOrphan,
} from '@/lib/admin/channel-group-retirement-types';

const keyCounts = z.object({ active: z.number().int().nonnegative(), total: z.number().int().nonnegative() });
const previewSchema = z
    .object({
        group: z.object({
            id: z.string(),
            key: z.string(),
            display_name: z.string(),
            newapi_group: z.string().nullable(),
            is_default: z.boolean(),
            enabled: z.boolean(),
        }),
        models: z.array(
            z.object({
                id: z.string(),
                slug: z.string(),
                display_name: z.string(),
                was_enabled: z.boolean(),
                will_disable: z.boolean(),
                remaining_tiers: z.array(z.string()),
            }),
        ),
        existing_keys: keyCounts,
        default_candidates: z.array(z.object({ id: z.string(), key: z.string(), display_name: z.string() })),
        replacement_default_id: z.string().nullable(),
        upstream: z.object({ status: z.enum(['missing', 'present', 'unknown']), message: z.string() }),
        issues: z.array(z.object({ code: z.string(), message: z.string() })),
        canApply: z.boolean(),
        preview_token: z.string().min(1),
        group_resolution: z
            .object({ source: z.enum(['history', 'current_keys', 'already_absent']), message: z.string() })
            .optional(),
        revocation: z.object({
            keys: z.array(
                z.object({
                    id: z.string(),
                    label: z.string(),
                    user_id: z.string(),
                    status: z.enum(['ready', 'already_absent', 'missing', 'blocked', 'unknown']),
                    actual_group: z.string().nullable(),
                    message: z.string(),
                }),
            ),
            customers: z.number().int().nonnegative(),
            expected_group: z.string().nullable(),
            orphaned: z.boolean(),
            archive_only: z.boolean().optional(),
        }),
    })
    .refine((preview) =>
        preview.revocation.archive_only
            ? preview.revocation.orphaned &&
              preview.group.newapi_group === null &&
              preview.revocation.expected_group === null
            : !!preview.revocation.expected_group && preview.group.newapi_group === preview.revocation.expected_group,
    );
const resultSchema = z.object({
    archive_only: z.boolean().optional(),
    group_key: z.string(),
    group_name: z.string(),
    updated_models: z.number().int().nonnegative(),
    disabled_models: z.number().int().nonnegative(),
    existing_keys: keyCounts,
    replacement_default_name: z.string().nullable(),
    revoked_keys: z.number().int().nonnegative(),
    already_absent_keys: z.number().int().nonnegative(),
});

const jobSchema = z.object({
    id: z.string(),
    tenant_id: z.string().nullable(),
    group_key: z.string(),
    group_name: z.string(),
    newapi_group: z.string().nullable(),
    orphaned: z.boolean(),
    archive_only: z.boolean().optional(),
    status: z.enum(['queued', 'running', 'needs_attention', 'succeeded', 'cancelled']),
    message: z.string(),
    summary: z.object({
        total: z.number().int().nonnegative(),
        confirmed: z.number().int().nonnegative(),
        pending: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        revoked: z.number().int().nonnegative(),
        already_absent: z.number().int().nonnegative(),
    }),
    keys: z.array(
        z.object({
            id: z.string(),
            label: z.string(),
            user_id: z.string(),
            status: z.enum(['pending', 'revoking', 'confirmed', 'already_absent', 'blocked']),
            message: z.string(),
        }),
    ),
    canResume: z.boolean(),
    canStop: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
    result: resultSchema.nullable(),
});
const tasksSchema = z.object({
    jobs: z.array(jobSchema),
    orphan_groups: z.array(
        z.object({
            tenant_id: z.string().nullable(),
            tier_key: z.string(),
            key_count: z.number().int().nonnegative(),
            active_key_count: z.number().int().nonnegative(),
        }),
    ),
});

export type ChannelRetirementTarget =
    | { kind: 'group'; groupId: string }
    | { kind: 'orphan'; tenantId: string | null; tierKey: string }
    | { kind: 'job'; jobId: string };
const taskEndpoint = '/api/admin/channel-group-retirement-jobs';

export class ChannelRetirementRequestError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly code: string,
    ) {
        super(message);
    }
}

type RetirementInput = {
    action: 'preview' | 'apply';
    replacement_default_id?: string | null;
    preview_token?: string;
    newapi_group?: string;
    archive_only?: boolean;
};

async function retirementRequest<T>(
    url: string,
    schema: z.ZodType<T>,
    en: boolean,
    body?: unknown,
    signal?: AbortSignal,
): Promise<T> {
    const response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
        throw new ChannelRetirementRequestError(
            response.status === 401
                ? en
                    ? 'Your session has expired. Please sign in again.'
                    : '登录已过期，请重新登录。'
                : typeof data?.message === 'string'
                  ? data.message
                  : en
                    ? 'Unable to complete this request. Refresh the preview and try again.'
                    : '请求未完成，请重新核对后再试。',
            response.status,
            typeof data?.error === 'string' ? data.error : '',
        );
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
        throw new ChannelRetirementRequestError(
            en
                ? 'The response could not be verified. Refresh before trying again.'
                : '未能核实返回结果，请刷新核对后再试。',
            response.status,
            'invalid_response',
        );
    }
    return parsed.data;
}

export async function requestChannelRetirement(
    targetOrId: ChannelRetirementTarget | string,
    input: RetirementInput,
    en: boolean,
    signal?: AbortSignal,
): Promise<{ preview: ChannelGroupRetirementPreview } | { job: ChannelGroupRetirementJobView }> {
    const target = typeof targetOrId === 'string' ? { kind: 'group' as const, groupId: targetOrId } : targetOrId;
    if (target.kind === 'job') throw new Error('Existing tasks must be resumed by ID.');
    const endpoint =
        target.kind === 'group'
            ? `/api/admin/channel-groups/${encodeURIComponent(target.groupId)}/retire`
            : taskEndpoint;
    const body =
        target.kind === 'group'
            ? input
            : {
                  action: input.action,
                  tenant_id: target.tenantId,
                  tier_key: target.tierKey,
                  ...(input.action === 'apply'
                      ? input.archive_only
                          ? { archive_only: true }
                          : { newapi_group: input.newapi_group }
                      : {}),
                  ...(input.preview_token ? { preview_token: input.preview_token } : {}),
              };
    return input.action === 'preview'
        ? retirementRequest(endpoint, z.object({ preview: previewSchema }), en, body, signal)
        : retirementRequest(endpoint, z.object({ job: jobSchema }), en, body, signal);
}

export function requestRetirementTasks(
    en: boolean,
    signal?: AbortSignal,
): Promise<{
    jobs: ChannelGroupRetirementJobView[];
    orphan_groups: ChannelGroupRetirementOrphan[];
}> {
    return retirementRequest(taskEndpoint, tasksSchema, en, undefined, signal);
}

export function requestRetirementJob(
    jobId: string,
    en: boolean,
    action: false | 'stop' | 'resume' | true = false,
    signal?: AbortSignal,
): Promise<{ job: ChannelGroupRetirementJobView }> {
    return retirementRequest(
        `${taskEndpoint}/${encodeURIComponent(jobId)}`,
        z.object({ job: jobSchema }),
        en,
        action ? { action: action === 'stop' ? 'stop' : 'resume' } : undefined,
        signal,
    );
}

export interface ChannelRetirementState {
    preview: ChannelGroupRetirementPreview | null;
    displayedPreview: ChannelGroupRetirementPreview | null;
    replacementDefaultId: string | null;
    loading: boolean;
    applying: boolean;
    error: string;
    job: ChannelGroupRetirementJobView | null;
    startUncertain: boolean;
    paused: boolean;
}

/** Owns request ordering so an old preview can never authorize a newer selection. */
export function createChannelRetirementSession(targetOrId: ChannelRetirementTarget | string, en: boolean) {
    const target: ChannelRetirementTarget =
        typeof targetOrId === 'string' ? { kind: 'group', groupId: targetOrId } : targetOrId;
    let state: ChannelRetirementState = {
        preview: null,
        displayedPreview: null,
        replacementDefaultId: null,
        loading: false,
        applying: false,
        error: '',
        job: null,
        startUncertain: false,
        paused: false,
    };
    let sequence = 0;
    let disposed = false;
    let pendingPreview: AbortController | null = null;
    const listeners = new Set<() => void>();
    const change = (patch: Partial<ChannelRetirementState>) => {
        if (disposed) return;
        state = { ...state, ...patch };
        listeners.forEach((listener) => listener());
    };
    const failureText = (error: unknown) =>
        error instanceof Error
            ? error.message
            : en
              ? 'Unable to verify the result. Refresh before retrying.'
              : '未能确认操作结果，请刷新核对后重试。';

    async function refresh(replacementDefaultId = state.replacementDefaultId, notice = '') {
        if (disposed || state.applying || state.job || state.startUncertain || target.kind === 'job') return;
        const requestId = ++sequence;
        pendingPreview?.abort();
        pendingPreview = new AbortController();
        change({ preview: null, replacementDefaultId, loading: true, error: notice });
        try {
            const data = await requestChannelRetirement(
                target,
                {
                    action: 'preview',
                    replacement_default_id: replacementDefaultId,
                },
                en,
                pendingPreview.signal,
            );
            if (disposed || requestId !== sequence || !('preview' in data)) return;
            change({
                preview: data.preview,
                displayedPreview: data.preview,
                replacementDefaultId: data.preview.replacement_default_id,
            });
        } catch (error) {
            if (!disposed && requestId === sequence) change({ error: failureText(error) });
        } finally {
            if (!disposed && requestId === sequence) change({ loading: false });
        }
    }

    async function apply(): Promise<ChannelGroupRetirementJobView | null> {
        const preview = state.preview;
        if (
            disposed ||
            state.applying ||
            state.loading ||
            state.startUncertain ||
            state.job ||
            !preview?.canApply ||
            !preview.revocation ||
            (!preview.revocation.archive_only && !preview.revocation.expected_group)
        )
            return null;
        change({ applying: true, error: '' });
        try {
            const data = await requestChannelRetirement(
                target,
                {
                    action: 'apply',
                    preview_token: preview.preview_token,
                    replacement_default_id: preview.replacement_default_id,
                    ...(target.kind === 'orphan'
                        ? preview.revocation.archive_only
                            ? { archive_only: true }
                            : { newapi_group: preview.revocation.expected_group! }
                        : {}),
                },
                en,
            );
            if (disposed || !('job' in data)) return null;
            change({ applying: false, preview: null, job: data.job });
            return data.job;
        } catch (error) {
            if (disposed) return null;
            const message = failureText(error);
            const uncertain =
                !(error instanceof ChannelRetirementRequestError) ||
                error.status >= 500 ||
                error.code === 'invalid_response';
            change({ applying: false, preview: null, error: message, startUncertain: uncertain });
            if (
                error instanceof ChannelRetirementRequestError &&
                error.status === 409 &&
                /preview|stale|expired/.test(error.code)
            ) {
                await refresh(state.replacementDefaultId, message);
            }
            return null;
        }
    }

    async function loadJob(jobId = state.job?.id ?? (target.kind === 'job' ? target.jobId : ''), notice = '') {
        if (disposed || state.applying || state.loading || !jobId) return;
        const requestId = ++sequence;
        pendingPreview?.abort();
        pendingPreview = new AbortController();
        change({ loading: true, error: notice });
        try {
            const { job } = await requestRetirementJob(jobId, en, false, pendingPreview.signal);
            if (!disposed && requestId === sequence)
                change({ job, ...(job.status === 'needs_attention' ? { paused: true } : {}) });
        } catch (error) {
            if (!disposed && requestId === sequence) change({ error: failureText(error) });
        } finally {
            if (!disposed && requestId === sequence) change({ loading: false });
        }
    }

    async function resume(): Promise<ChannelGroupRetirementJobView | null> {
        const job = state.job;
        if (disposed || state.loading || state.applying || !job?.canResume || job.status === 'succeeded') return null;
        change({ applying: true, error: '', paused: false });
        try {
            const data = await requestRetirementJob(job.id, en, true);
            if (disposed) return null;
            change({ applying: false, job: data.job, paused: data.job.status === 'needs_attention' });
            return data.job;
        } catch (error) {
            if (disposed) return null;
            const notice = `${failureText(error)} ${
                job.archive_only
                    ? en
                        ? 'Some keys may already be archived. Check this saved task before continuing.'
                        : '部分 Key 可能已经归档，请核对这个已保存的任务后继续。'
                    : en
                      ? 'Some keys may already be revoked. Check this saved task before continuing.'
                      : '部分 Key 可能已经撤销，请核对这个已保存的任务后继续。'
            }`;
            change({ applying: false, error: notice, paused: true });
            // A failed resume response is not proof the revocation failed. Only read
            // the same persisted task here; a new explicit action is needed to retry.
            await loadJob(job.id, notice);
            return null;
        }
    }

    async function stop(): Promise<ChannelGroupRetirementJobView | null> {
        const job = state.job;
        if (disposed || state.loading || state.applying || !job?.canStop) return null;
        change({ applying: true, error: '', paused: true });
        try {
            const { job: stopped } = await requestRetirementJob(job.id, en, 'stop');
            if (disposed) return null;
            change({ applying: false, job: stopped });
            return stopped;
        } catch (error) {
            if (disposed) return null;
            const notice = failureText(error);
            change({ applying: false, error: notice });
            await loadJob(job.id, notice);
            return null;
        }
    }

    return {
        getState: () => state,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        refresh,
        apply,
        loadJob,
        resume,
        stop,
        start: () => {
            disposed = false;
            // Strict Mode may restart effects after an aborted read.
            change({ loading: false });
            return target.kind === 'job' ? loadJob() : refresh();
        },
        dispose: () => {
            disposed = true;
            sequence++;
            pendingPreview?.abort();
            listeners.clear();
        },
    };
}

export function channelRetirementSuccessText(result: ChannelGroupRetirementResult, en: boolean): string {
    if (result.archive_only)
        return en
            ? `Archived ${result.already_absent_keys ?? 0} inactive keys for “${result.group_name}”. No key deletion requests were sent to new-api. History and customer balances are retained.`
            : `已归档「${result.group_name}」的 ${result.already_absent_keys ?? 0} 个失效 Key。未向 new-api 发送 Key 删除请求，历史记录保留，客户余额不变。`;
    const replacement = result.replacement_default_name
        ? en
            ? ` Default tier: ${result.replacement_default_name}.`
            : `默认档次已改为「${result.replacement_default_name}」。`
        : '';
    return en
        ? `Completed cleanup for “${result.group_name}”: ${result.revoked_keys ?? 0} keys revoked now, ${result.already_absent_keys ?? 0} already inactive or absent, ${result.updated_models} model mappings removed, and ${result.disabled_models} models unlisted. History and customer balances are retained.${replacement}`
        : `已完成「${result.group_name}」分组清理：本次撤销 ${result.revoked_keys ?? 0} 个 Key，另有 ${result.already_absent_keys ?? 0} 个原已失效或不存在；清理 ${result.updated_models} 个模型的本档关联，下架 ${result.disabled_models} 个没有其他档次关联的模型。历史记录保留，客户余额不变。${replacement}`;
}

export function ChannelRetirementPreviewDetails({
    preview,
    replacementDefaultId,
    isDark,
    en,
    disabled,
    onDefaultChange,
}: {
    preview: ChannelGroupRetirementPreview;
    replacementDefaultId: string | null;
    isDark: boolean;
    en: boolean;
    disabled: boolean;
    onDefaultChange: (id: string | null) => void;
}) {
    const muted = isDark ? 'text-slate-300' : 'text-slate-600';
    const disabledCount = preview.models.filter((model) => model.will_disable).length;
    const archiveOnly = preview.revocation?.archive_only === true;
    const resolution = preview.group_resolution;
    return (
        <div className="space-y-4">
            <div className={`rounded-lg p-3 text-sm ${isDark ? 'bg-slate-900/60' : 'bg-slate-50'}`}>
                <p className="break-words font-semibold">{preview.group.display_name}</p>
                <p className={`mt-1 break-words ${muted}`}>
                    {archiveOnly ? (
                        en ? (
                            'Original group not recovered; only verified inactive keys will be archived.'
                        ) : (
                            '未恢复原分组名称；仅归档已经核实失效的 Key。'
                        )
                    ) : (
                        <>new-api group: {preview.group.newapi_group}</>
                    )}
                </p>
                {resolution && (
                    <div className={`mt-2 space-y-1 leading-6 ${muted}`}>
                        <p className="font-medium">
                            {resolution.source === 'history'
                                ? en
                                    ? 'Source: saved group history'
                                    : '识别来源：历史分组记录'
                                : resolution.source === 'current_keys'
                                  ? en
                                      ? 'Source: current key membership'
                                      : '识别来源：Key 当前归属'
                                  : en
                                    ? 'Source: keys verified inactive or absent'
                                    : '识别来源：Key 已核实失效或不存在'}
                        </p>
                        {resolution.source === 'current_keys' && (
                            <p>
                                {en
                                    ? 'Identified from current key membership. This does not prove the original group name; review the keys to revoke below.'
                                    : '根据 Key 当前归属识别，无法证明历史名称，请核对下方待撤销清单。'}
                            </p>
                        )}
                        <p>{resolution.message}</p>
                    </div>
                )}
            </div>
            <div
                className={`rounded-lg border p-3 text-sm leading-6 ${
                    preview.upstream.status === 'missing'
                        ? isDark
                            ? 'border-emerald-700 bg-emerald-950/40 text-emerald-200'
                            : 'border-emerald-200 bg-emerald-50 text-emerald-800'
                        : isDark
                          ? 'border-amber-700 bg-amber-950/40 text-amber-200'
                          : 'border-amber-300 bg-amber-50 text-amber-900'
                }`}
            >
                <p className="font-medium">
                    {archiveOnly
                        ? en
                            ? 'Only verified inactive keys will be archived'
                            : '仅归档已核实失效的 Key'
                        : preview.upstream.status === 'missing'
                          ? en
                              ? 'No group or channel reference found for this group in new-api'
                              : 'new-api 未发现该分组或引用关系'
                          : preview.upstream.status === 'present'
                            ? en
                                ? 'This group or channel still exists in new-api'
                                : 'new-api 仍有对应分组或渠道'
                            : en
                              ? 'The new-api state could not be confirmed'
                              : '暂时无法确认 new-api 状态'}
                </p>
                <p>{preview.upstream.message}</p>
                {!archiveOnly && preview.upstream.status !== 'missing' && (
                    <p>
                        {en
                            ? 'This cleanup does not delete new-api channels. It will revoke the keys belonging to this group after confirmation.'
                            : '本次清理不会删除 new-api 渠道；确认后将撤销属于本档的 Key。'}
                    </p>
                )}
            </div>
            {preview.group.is_default && (
                <div>
                    {preview.default_candidates.length > 1 ? (
                        <label className="block text-sm font-medium">
                            {en ? 'Replacement default tier' : '删除后的默认档次'}
                            <select
                                value={replacementDefaultId ?? ''}
                                disabled={disabled}
                                onChange={(event) => onDefaultChange(event.target.value || null)}
                                className={`mt-2 min-h-11 w-full rounded-lg border px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-60 ${isDark ? 'border-slate-600 bg-slate-800 text-slate-100' : 'border-slate-300 bg-white text-slate-900'}`}
                            >
                                <option value="">{en ? 'Choose an enabled tier' : '请选择一个启用档次'}</option>
                                {preview.default_candidates.map((candidate) => (
                                    <option key={candidate.id} value={candidate.id}>
                                        {candidate.display_name}
                                    </option>
                                ))}
                            </select>
                        </label>
                    ) : (
                        preview.replacement_default_id && (
                            <p className={`text-sm leading-6 ${muted}`}>
                                {en ? 'Default tier will change to: ' : '默认档次将自动改为：'}
                                <span className="font-medium">
                                    {
                                        preview.default_candidates.find(
                                            (candidate) => candidate.id === preview.replacement_default_id,
                                        )?.display_name
                                    }
                                </span>
                            </p>
                        )
                    )}
                </div>
            )}
            <section
                aria-label={archiveOnly ? (en ? 'Archival impact' : '归档影响') : en ? 'Deletion impact' : '删除影响'}
                className="space-y-3"
            >
                <h3 className="font-semibold">
                    {en ? 'Portal will make these changes together' : 'Portal 将一次完成以下清理'}
                </h3>
                {!preview.revocation?.orphaned && (
                    <p className={`text-sm leading-6 ${muted}`}>
                        {en
                            ? `Remove this tier from ${preview.models.length} models; unlist ${disabledCount} models without any remaining tier mappings. Other tiers and their mappings are retained.`
                            : `清理 ${preview.models.length} 个模型的本档关联，其中 ${disabledCount} 个没有其他档次关联的模型将自动下架。其他档次及其关联保留。`}
                    </p>
                )}
                {preview.models.length > 0 && (
                    <ul
                        className={`max-h-52 divide-y overflow-y-auto rounded-lg border ${isDark ? 'divide-slate-700 border-slate-600' : 'divide-slate-200 border-slate-200'}`}
                    >
                        {preview.models.map((model) => (
                            <li
                                key={model.id}
                                className="flex flex-wrap items-start justify-between gap-2 px-3 py-2 text-sm"
                            >
                                <div className="min-w-0 flex-1 break-words">
                                    <p className="font-medium">{model.display_name}</p>
                                    <p className={`break-all text-xs ${muted}`}>{model.slug}</p>
                                    {model.remaining_tiers.length > 0 && (
                                        <p className={`mt-1 text-xs ${muted}`}>
                                            {en ? 'Retained tiers: ' : '保留档次：'}
                                            {model.remaining_tiers.join('、')}
                                        </p>
                                    )}
                                </div>
                                <span
                                    className={
                                        model.will_disable ? (isDark ? 'text-amber-200' : 'text-amber-800') : muted
                                    }
                                >
                                    {model.will_disable
                                        ? en
                                            ? 'Will be unlisted'
                                            : '将自动下架'
                                        : !model.was_enabled
                                          ? en
                                              ? 'Already unlisted'
                                              : '维持已下架'
                                          : en
                                            ? 'Other tiers retained'
                                            : '保留其他档次'}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
                <div className={`rounded-lg p-3 text-sm leading-6 ${isDark ? 'bg-slate-900/60' : 'bg-slate-50'}`}>
                    <p>
                        {en
                            ? 'Model records, price history, cost rules and their history, and usage records are retained. Customer balances do not change.'
                            : '模型记录、价格历史、成本规则及其历史、用量记录均保留，客户余额不变。'}
                    </p>
                    {!preview.revocation?.orphaned && (
                        <p className="mt-1">
                            {en
                                ? 'Customers can no longer select this tier when creating keys or see its models in the Portal catalog. Customer tier permissions and multiplier settings are retained. Customers restricted to this tier will need access to another available tier.'
                                : '删除后，客户不能再选择此档新建 Key，Portal 目录也不再展示本档模型。客户档次权限和倍率配置保留；仅获准使用此档的客户，需要另行分配其他可用档次。'}
                        </p>
                    )}
                    <p className="mt-1">
                        {archiveOnly
                            ? en
                                ? `${preview.revocation?.keys.length ?? 0} keys have been verified inactive or absent. After confirmation, Portal will verify them again and archive their records without sending key deletion requests to new-api.`
                                : `${preview.revocation?.keys.length ?? 0} 个 Key 已核实失效或不存在。确认后会再次核对并归档 Portal 记录，不会向 new-api 发送 Key 删除请求。`
                            : en
                              ? `${preview.revocation?.keys.length ?? 0} keys belonging to this tier will be checked and revoked in new-api. Revoked keys cannot make new requests and will not be moved to another group. Historical key records are retained.`
                              : `将逐个核对并在 new-api 撤销本档所属的 ${preview.revocation?.keys.length ?? 0} 个 Key。已撤销的 Key 不能再发起调用，也不会迁移到其他分组；Key 历史记录保留。`}
                    </p>
                    <p className="mt-1">
                        {archiveOnly
                            ? en
                                ? 'Archival stops if any key becomes active or its state cannot be verified. The saved task can be reopened to continue verification. History and balances are retained.'
                                : '如发现 Key 恢复有效或无法确认状态，将停止归档。可从已保存任务继续核对，历史记录和余额保留。'
                            : en
                              ? 'Portal cleanup finishes only after every key is confirmed revoked or already absent. If a step fails, the saved task can be resumed; keys already revoked will not be restored.'
                              : '全部 Key 确认撤销或已不存在后，才完成 Portal 清理。途中失败可继续处理已保存的任务；已经撤销的 Key 不会恢复。'}
                    </p>
                </div>
                {preview.revocation && (
                    <details
                        className={`rounded-lg border p-3 text-sm ${isDark ? 'border-slate-600' : 'border-slate-200'}`}
                    >
                        <summary className="min-h-6 cursor-pointer font-medium">
                            {en
                                ? `Review ${preview.revocation.keys.length} keys across ${preview.revocation.customers} customers`
                                : `查看 ${preview.revocation.customers} 位客户的 ${preview.revocation.keys.length} 个 Key`}
                        </summary>
                        <ul className="mt-2 max-h-48 space-y-3 overflow-y-auto">
                            {preview.revocation.keys.map((key) => (
                                <li key={key.id} className="break-words">
                                    <p className="font-medium">
                                        {key.label} ·{' '}
                                        {key.status === 'ready'
                                            ? en
                                                ? 'Ready to revoke'
                                                : '待撤销'
                                            : key.status === 'missing' || key.status === 'already_absent'
                                              ? en
                                                  ? 'Already inactive or absent'
                                                  : '原已失效或不存在'
                                              : key.status === 'unknown'
                                                ? en
                                                    ? 'Needs verification'
                                                    : '待核对'
                                                : en
                                                  ? 'Needs attention'
                                                  : '需处理'}
                                    </p>
                                    <p className={`mt-1 text-xs ${muted}`}>{key.message}</p>
                                </li>
                            ))}
                        </ul>
                    </details>
                )}
            </section>
            {preview.issues.length > 0 && (
                <div
                    role="alert"
                    className={`rounded-lg border p-3 text-sm leading-6 ${isDark ? 'border-amber-700 bg-amber-950/40 text-amber-200' : 'border-amber-300 bg-amber-50 text-amber-900'}`}
                >
                    <p className="font-medium">
                        {en ? 'Resolve these items before continuing' : '处理以下事项后才能继续'}
                    </p>
                    <ul className="mt-1 list-disc space-y-1 pl-5">
                        {preview.issues.map((issue, index) => (
                            <li key={`${issue.code}-${index}`}>{issue.message}</li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}

export function channelRetirementJobStatus(job: ChannelGroupRetirementJobView, en: boolean): string {
    return {
        queued: job.archive_only
            ? en
                ? 'Waiting to archive inactive keys'
                : '等待归档已失效 Key'
            : en
              ? 'Waiting to revoke keys'
              : '等待撤销 Key',
        running: job.archive_only
            ? en
                ? 'Verifying and archiving inactive keys'
                : '正在核对并归档已失效 Key'
            : en
              ? 'Revoking and verifying keys'
              : '正在撤销并核对 Key',
        needs_attention: en ? 'Needs attention' : '需继续处理',
        succeeded: en ? 'Completed' : '已完成',
        cancelled: en ? 'Stopped' : '已停止',
    }[job.status];
}

export function shouldAutomaticallyResumeRetirement(state: ChannelRetirementState): boolean {
    return (
        !state.loading &&
        !state.applying &&
        !state.error &&
        !state.paused &&
        !!state.job?.canResume &&
        (state.job.status === 'queued' || state.job.status === 'running')
    );
}

export function ChannelRetirementJobProgress({
    job,
    isDark,
    en,
}: {
    job: ChannelGroupRetirementJobView;
    isDark: boolean;
    en: boolean;
}) {
    const muted = isDark ? 'text-slate-300' : 'text-slate-600';
    const finished = job.status === 'succeeded';
    const stopped = job.status === 'cancelled';
    return (
        <section
            aria-label={
                job.archive_only
                    ? en
                        ? 'Archival task progress'
                        : '归档任务进度'
                    : en
                      ? 'Deletion task progress'
                      : '删除任务进度'
            }
            className="space-y-4"
        >
            <div
                className={`rounded-lg border p-3 text-sm leading-6 ${
                    finished
                        ? isDark
                            ? 'border-emerald-700 bg-emerald-950/40 text-emerald-200'
                            : 'border-emerald-200 bg-emerald-50 text-emerald-800'
                        : isDark
                          ? 'border-slate-600 bg-slate-900/60'
                          : 'border-slate-200 bg-slate-50'
                }`}
            >
                <p className="break-words font-semibold">
                    {job.group_name} · {channelRetirementJobStatus(job, en)}
                </p>
                <p className="mt-1">{job.message}</p>
                <p className={`mt-2 break-all text-xs ${muted}`}>
                    {en ? 'Saved task: ' : '已保存任务：'}
                    {job.id}
                </p>
            </div>
            <div role="status" aria-live="polite" className="space-y-2 text-sm">
                <p className="font-medium">
                    {job.archive_only
                        ? en
                            ? 'Inactive key verification and archival'
                            : '已失效 Key 核对与归档'
                        : en
                          ? 'Key revocation and verification'
                          : 'Key 撤销与核对'}{' '}
                    · {job.summary.confirmed} / {job.summary.total}
                </p>
                <progress
                    className="h-2 w-full accent-emerald-600"
                    value={job.summary.confirmed}
                    max={Math.max(1, job.summary.total)}
                    aria-label={
                        job.archive_only
                            ? en
                                ? 'Keys verified inactive or absent'
                                : '已核实失效或不存在的 Key'
                            : en
                              ? 'Keys confirmed revoked or absent'
                              : '已确认撤销或不存在的 Key'
                    }
                />
                <div className="flex flex-wrap gap-x-5 gap-y-1">
                    {!job.archive_only && (
                        <span>
                            {en ? 'Revoked now: ' : '本次撤销：'}
                            {job.summary.revoked}
                        </span>
                    )}
                    <span>
                        {en ? 'Already inactive / absent: ' : '原已失效或不存在：'}
                        {job.summary.already_absent}
                    </span>
                    <span>
                        {en ? 'Pending: ' : '待处理：'}
                        {job.summary.pending}
                    </span>
                    <span>
                        {en ? 'Needs attention: ' : '需处理：'}
                        {job.summary.failed}
                    </span>
                </div>
                <p className={muted}>
                    {job.archive_only
                        ? stopped
                            ? en
                                ? 'Archival stopped. Key history and customer balances are retained.'
                                : '归档已停止，Key 历史记录和客户余额保留。'
                            : finished
                              ? en
                                  ? 'Inactive key archival is complete.'
                                  : '已失效 Key 归档已完成。'
                              : en
                                ? 'Only keys verified inactive or absent will be archived. No key deletion requests will be sent to new-api.'
                                : '仅归档核实失效或不存在的 Key，不会向 new-api 发送 Key 删除请求。'
                        : stopped
                          ? en
                              ? 'Task stopped. The Portal group and model mappings are retained.'
                              : '任务已停止，Portal 分组和模型关联保留。'
                          : finished
                            ? en
                                ? 'Portal cleanup is complete.'
                                : 'Portal 分组和模型关联清理已完成。'
                            : en
                              ? 'Portal cleanup waits until all keys are confirmed revoked or absent.'
                              : '全部 Key 确认撤销或不存在后，才完成 Portal 清理。'}
                </p>
            </div>
            {job.keys.length > 0 && (
                <ul
                    className={`max-h-56 divide-y overflow-y-auto rounded-lg border ${isDark ? 'divide-slate-700 border-slate-600' : 'divide-slate-200 border-slate-200'}`}
                >
                    {job.keys.map((key) => (
                        <li key={key.id} className="px-3 py-2 text-sm">
                            <div className="flex flex-wrap justify-between gap-2">
                                <span className="break-words font-medium">{key.label}</span>
                                <span>
                                    {key.status === 'confirmed'
                                        ? en
                                            ? 'Revoked now'
                                            : '本次已撤销'
                                        : key.status === 'already_absent'
                                          ? en
                                              ? 'Already inactive or absent'
                                              : '原已失效或不存在'
                                          : key.status === 'pending'
                                            ? en
                                                ? 'Pending'
                                                : '待处理'
                                            : key.status === 'revoking'
                                              ? en
                                                  ? 'Verifying result'
                                                  : '核对结果中'
                                              : en
                                                ? 'Needs attention'
                                                : '需处理'}
                                </span>
                            </div>
                            {key.message && (
                                <p className={`mt-1 break-words text-xs leading-5 ${muted}`}>{key.message}</p>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {finished && job.result && (
                <p className="text-sm leading-6">{channelRetirementSuccessText(job.result, en)}</p>
            )}
            {!finished && (
                <p className={`text-sm leading-6 ${muted}`}>
                    {job.archive_only
                        ? en
                            ? 'The saved archival task can be reopened from “Deletion tasks and leftover keys”. History and customer balances remain unchanged.'
                            : '可从「删除任务与遗留 Key」找回已保存的归档任务，历史记录和客户余额保持不变。'
                        : en
                          ? stopped
                              ? 'This task is stopped. Fix the configuration and start a new preview if cleanup is still needed. Keys already revoked stay revoked. History and customer balances remain unchanged.'
                              : 'This task is saved on the server. If interrupted, reopen it from “Deletion tasks and leftover keys”. Keys already revoked stay revoked. History and customer balances remain unchanged.'
                          : stopped
                            ? '任务已停止。如仍需清理，请修正配置后重新预览。已撤销的 Key 不会恢复，历史记录和客户余额保持不变。'
                            : '任务已保存在服务器，刷新或中断后可从「删除任务与遗留 Key」找回并继续。已撤销的 Key 不会恢复，历史记录和客户余额保持不变。'}
                </p>
            )}
        </section>
    );
}

export default function ChannelRetirementDialog({
    target,
    locale,
    isDark,
    onClose,
    onComplete,
    onOpenTasks,
}: {
    target: ChannelRetirementTarget;
    locale: Locale;
    isDark: boolean;
    onClose: () => void;
    onComplete: (result: ChannelGroupRetirementResult) => void;
    onOpenTasks: () => void;
}) {
    const en = locale === 'en';
    const dialog = useRef<HTMLDialogElement>(null);
    const session = useMemo(() => createChannelRetirementSession(target, en), [target, en]);
    const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
    const busy = state.loading || state.applying;
    const archiveOnly = (state.job?.archive_only ?? state.displayedPreview?.revocation?.archive_only) === true;
    const [confirmStop, setConfirmStop] = useState(false);
    useEffect(() => {
        const el = dialog.current;
        el?.showModal();
        void session.start();
        return () => {
            session.dispose();
            el?.close();
        };
    }, [session]);
    useEffect(() => {
        if (confirmStop || !shouldAutomaticallyResumeRetirement(state)) return;
        const timer = setTimeout(() => void session.resume(), 1200);
        return () => clearTimeout(timer);
    }, [session, state, confirmStop]);
    const secondary = `min-h-11 rounded-lg border px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:cursor-not-allowed disabled:opacity-50 ${isDark ? 'border-slate-600 hover:bg-slate-700' : 'border-slate-300 hover:bg-slate-50'}`;
    return (
        <dialog
            ref={dialog}
            aria-labelledby="retirement-title"
            aria-describedby="retirement-description"
            onCancel={(event) => {
                event.preventDefault();
                if (!busy) onClose();
            }}
            className={`m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-2xl border p-0 shadow-2xl backdrop:bg-black/60 ${isDark ? 'border-slate-700 bg-slate-800 text-slate-100' : 'border-slate-200 bg-white text-slate-900'}`}
        >
            <div className="space-y-5 p-5 sm:p-6" aria-busy={busy}>
                <header>
                    <h2 id="retirement-title" className="text-xl font-semibold">
                        {archiveOnly
                            ? en
                                ? 'Archive inactive keys'
                                : '归档已失效 Key'
                            : state.job
                              ? en
                                  ? 'Deletion task'
                                  : '删除任务'
                              : target.kind === 'orphan'
                                ? en
                                    ? 'Clean up leftover keys'
                                    : '清理遗留 Key'
                                : en
                                  ? 'Delete group and revoke keys'
                                  : '删除分组并撤销 Key'}
                    </h2>
                    <p
                        id="retirement-description"
                        className={`mt-2 text-sm leading-6 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}
                    >
                        {archiveOnly
                            ? en
                                ? 'Confirm once to verify and archive keys already inactive or absent. No key deletion requests will be sent to new-api; history and balances are retained.'
                                : '确认后再次核对并归档已失效或不存在的 Key，不会向 new-api 发送 Key 删除请求；历史记录和余额保留。'
                            : target.kind === 'orphan'
                              ? en
                                  ? 'The original group will be identified automatically. Review the result and key list before confirming cleanup.'
                                  : '系统会自动识别原分组。请核对识别结果及 Key 清单，再确认清理。'
                              : en
                                ? 'Confirm once to revoke the keys belonging to this group in new-api, then clean up Portal. The saved task records each step.'
                                : '确认一次后，先在 new-api 撤销本档所属 Key，再清理 Portal 分组及模型关联。每一步都会记录在删除任务中。'}
                    </p>
                </header>
                {state.error && (
                    <p
                        role="alert"
                        className={`rounded-lg border p-3 text-sm leading-6 ${isDark ? 'border-red-700 bg-red-950/40 text-red-200' : 'border-red-200 bg-red-50 text-red-700'}`}
                    >
                        {state.error}
                    </p>
                )}
                {state.loading && (
                    <p role="status" className="text-sm">
                        {state.job || target.kind === 'job'
                            ? en
                                ? 'Reading the saved task…'
                                : '正在读取已保存任务…'
                            : en
                              ? 'Checking the group, models and keys…'
                              : '正在核对分组、模型和 Key…'}
                    </p>
                )}
                {target.kind === 'orphan' && !state.job && !state.displayedPreview && (
                    <p className={`text-sm leading-6 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                        {en
                            ? `Checking history and current key membership for “${target.tierKey}”; no group name needs to be entered. Cleanup stays unavailable if ownership cannot be verified.`
                            : `正在核对「${target.tierKey}」的历史记录及 Key 当前归属，无需填写分组名。无法确认归属时，不会开放清理。`}
                    </p>
                )}
                {state.displayedPreview && !state.job && (
                    <ChannelRetirementPreviewDetails
                        preview={state.displayedPreview}
                        replacementDefaultId={state.replacementDefaultId}
                        isDark={isDark}
                        en={en}
                        disabled={state.applying}
                        onDefaultChange={(id) => void session.refresh(id)}
                    />
                )}
                {state.job && <ChannelRetirementJobProgress job={state.job} isDark={isDark} en={en} />}
                {state.job?.canStop && !busy && !confirmStop && (
                    <button type="button" className={secondary} onClick={() => setConfirmStop(true)}>
                        {en ? 'Stop this task' : '停止此任务'}
                    </button>
                )}
                {confirmStop && state.job && (
                    <div
                        role="alert"
                        className={`space-y-3 rounded-lg border p-3 text-sm leading-6 ${isDark ? 'border-amber-700 bg-amber-950/40 text-amber-200' : 'border-amber-300 bg-amber-50 text-amber-900'}`}
                    >
                        <p>
                            {archiveOnly
                                ? en
                                    ? 'Stop this archival task? Already archived records will not be restored; history and customer balances remain unchanged.'
                                    : '停止此归档任务？已归档记录不会恢复；历史记录和客户余额保持不变。'
                                : en
                                  ? `Stop this task and retain the group and its model mappings? ${state.job.summary.revoked} keys already revoked will not be restored. You can fix the configuration and start a new preview later.`
                                  : `停止后将保留分组和模型关联。已撤销的 ${state.job.summary.revoked} 个 Key 不会恢复；修正配置后可以重新预览发起清理。`}
                        </p>
                        <div className="flex flex-wrap gap-3">
                            <button
                                type="button"
                                className={secondary}
                                disabled={busy}
                                onClick={() => setConfirmStop(false)}
                            >
                                {en ? 'Keep task' : '保留任务'}
                            </button>
                            <button
                                type="button"
                                className={secondary}
                                disabled={busy || !state.job.canStop}
                                onClick={async () => {
                                    await session.stop();
                                    setConfirmStop(false);
                                }}
                            >
                                {en ? 'Confirm stop' : '确认停止'}
                            </button>
                        </div>
                    </div>
                )}
                {state.applying && (
                    <p role="status" className="text-sm">
                        {archiveOnly
                            ? en
                                ? 'Verifying and archiving inactive keys…'
                                : '正在核对并归档已失效 Key…'
                            : state.job
                              ? en
                                  ? 'Revoking and verifying the next keys…'
                                  : '正在撤销并核对下一批 Key…'
                              : en
                                ? 'Saving the deletion task…'
                                : '正在保存删除任务…'}
                    </p>
                )}
                {state.startUncertain && (
                    <div
                        role="alert"
                        className={`rounded-lg border p-3 text-sm leading-6 ${isDark ? 'border-amber-700 bg-amber-950/40 text-amber-200' : 'border-amber-300 bg-amber-50 text-amber-900'}`}
                    >
                        <p>
                            {en
                                ? 'The task may already be saved. Find it in deletion tasks before starting another operation.'
                                : '删除任务可能已经保存。请先到任务列表核对，避免重复发起操作。'}
                        </p>
                        <button type="button" className={`${secondary} mt-3`} onClick={onOpenTasks}>
                            {en ? 'Find saved task' : '查找已保存任务'}
                        </button>
                    </div>
                )}
                {!busy && !state.job && !state.startUncertain && target.kind !== 'job' && (
                    <button type="button" className={secondary} onClick={() => void session.refresh()}>
                        {en ? 'Refresh impact' : '重新核对'}
                    </button>
                )}
                {!busy && (state.job || target.kind === 'job') && (
                    <button type="button" className={secondary} onClick={() => void session.loadJob()}>
                        {en ? 'Refresh task status' : '刷新任务状态'}
                    </button>
                )}
            </div>
            <footer
                className={`sticky bottom-0 flex flex-wrap justify-end gap-3 border-t p-4 ${isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-200 bg-white'}`}
            >
                <button type="button" className={secondary} disabled={busy} onClick={onClose} autoFocus>
                    {state.job ? (en ? 'Close window' : '关闭窗口') : en ? 'Cancel' : '取消'}
                </button>
                {state.job?.status === 'succeeded' && state.job.result ? (
                    <button
                        type="button"
                        className="min-h-11 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
                        onClick={() => onComplete(state.job!.result!)}
                    >
                        {en ? 'Done' : '完成'}
                    </button>
                ) : state.job && state.job.status !== 'cancelled' ? (
                    <button
                        type="button"
                        className="min-h-11 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={busy || confirmStop || !state.job.canResume}
                        onClick={() => void session.resume()}
                    >
                        {state.applying
                            ? en
                                ? 'Processing…'
                                : '正在处理…'
                            : en
                              ? 'Continue verification and retry'
                              : '继续核对并重试'}
                    </button>
                ) : (
                    !state.job &&
                    target.kind !== 'job' && (
                        <button
                            type="button"
                            disabled={busy || state.startUncertain || !state.preview?.canApply}
                            onClick={() => void session.apply()}
                            className="min-h-11 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {state.applying
                                ? en
                                    ? 'Saving task…'
                                    : '正在保存任务…'
                                : archiveOnly
                                  ? en
                                      ? 'Confirm inactive key archival'
                                      : '确认归档已失效 Key'
                                  : target.kind === 'orphan'
                                    ? en
                                        ? 'Confirm key revocation'
                                        : '确认撤销遗留 Key'
                                    : en
                                      ? 'Delete group and revoke its keys'
                                      : '确认删除分组并撤销所属 Key'}
                        </button>
                    )
                )}
            </footer>
        </dialog>
    );
}

export function ChannelRetirementTasksDialog({
    locale,
    isDark,
    onClose,
    onOpen,
}: {
    locale: Locale;
    isDark: boolean;
    onClose: () => void;
    onOpen: (target: ChannelRetirementTarget) => void;
}) {
    const en = locale === 'en';
    const dialog = useRef<HTMLDialogElement>(null);
    const [data, setData] = useState<{
        jobs: ChannelGroupRetirementJobView[];
        orphan_groups: ChannelGroupRetirementOrphan[];
    } | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [refreshCount, setRefreshCount] = useState(0);
    useEffect(() => {
        const el = dialog.current;
        el?.showModal();
        return () => el?.close();
    }, []);
    useEffect(() => {
        const controller = new AbortController();
        void requestRetirementTasks(en, controller.signal)
            .then((value) => {
                if (!controller.signal.aborted) setData(value);
            })
            .catch((err) => {
                if (!controller.signal.aborted)
                    setError(
                        err instanceof Error ? err.message : en ? 'Unable to load saved tasks.' : '读取任务失败。',
                    );
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [en, refreshCount]);
    const muted = isDark ? 'text-slate-300' : 'text-slate-600';
    const secondary = `min-h-11 rounded-lg border px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:opacity-50 ${isDark ? 'border-slate-600 hover:bg-slate-700' : 'border-slate-300 hover:bg-slate-50'}`;
    const rowClass = `rounded-lg border p-3 ${isDark ? 'border-slate-600 bg-slate-900/40' : 'border-slate-200 bg-slate-50'}`;
    return (
        <dialog
            ref={dialog}
            aria-labelledby="retirement-tasks-title"
            aria-describedby="retirement-tasks-description"
            onCancel={(event) => {
                event.preventDefault();
                onClose();
            }}
            className={`m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-2xl border p-0 shadow-2xl backdrop:bg-black/60 ${isDark ? 'border-slate-700 bg-slate-800 text-slate-100' : 'border-slate-200 bg-white text-slate-900'}`}
        >
            <div className="space-y-5 p-5 sm:p-6">
                <header>
                    <h2 id="retirement-tasks-title" className="text-xl font-semibold">
                        {en ? 'Deletion tasks and leftover keys' : '删除任务与遗留 Key'}
                    </h2>
                    <p id="retirement-tasks-description" className={`mt-2 text-sm leading-6 ${muted}`}>
                        {en
                            ? 'Find saved progress here after refreshing or closing a window. Leftover key cleanup requires a separate preview and confirmation.'
                            : '刷新页面或关闭窗口后，可在这里找回已保存的进度。历史遗留 Key 需要先预览，再确认清理。'}
                    </p>
                </header>
                {error && (
                    <p
                        role="alert"
                        className={`rounded-lg border p-3 text-sm ${isDark ? 'border-red-700 bg-red-950/40 text-red-200' : 'border-red-200 bg-red-50 text-red-700'}`}
                    >
                        {error}
                    </p>
                )}
                {loading && (
                    <p role="status" className="text-sm">
                        {en ? 'Reading tasks…' : '正在读取任务…'}
                    </p>
                )}
                {data && (
                    <>
                        <section aria-label={en ? 'Saved tasks' : '已保存任务'} className="space-y-3">
                            <h3 className="font-semibold">
                                {en ? 'Saved tasks' : '已保存任务'} · {data.jobs.length}
                            </h3>
                            {!data.jobs.length && (
                                <p className={`text-sm ${muted}`}>{en ? 'No deletion tasks yet.' : '暂无删除任务。'}</p>
                            )}
                            {data.jobs.map((job) => (
                                <div key={job.id} className={rowClass}>
                                    <div className="flex flex-wrap items-center justify-between gap-3">
                                        <div className="min-w-0 flex-1 text-sm">
                                            <p className="break-words font-medium">
                                                {job.group_name} · {channelRetirementJobStatus(job, en)}
                                            </p>
                                            <p className={`mt-1 ${muted}`}>
                                                {en ? 'Keys confirmed: ' : 'Key 已确认：'}
                                                {job.summary.confirmed} / {job.summary.total} ·{' '}
                                                {en ? 'Needs attention: ' : '需处理：'}
                                                {job.summary.failed}
                                            </p>
                                            <p className={`mt-1 break-words text-xs ${muted}`}>{job.message}</p>
                                            <p className={`mt-1 break-all text-xs ${muted}`}>{job.id}</p>
                                        </div>
                                        <button
                                            type="button"
                                            className={secondary}
                                            disabled={loading}
                                            onClick={() => onOpen({ kind: 'job', jobId: job.id })}
                                        >
                                            {job.status === 'succeeded'
                                                ? en
                                                    ? 'View result'
                                                    : '查看结果'
                                                : en
                                                  ? 'View / continue'
                                                  : '查看／继续'}
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </section>
                        <section
                            aria-label={en ? 'Leftover keys from deleted groups' : '已删除分组的遗留 Key'}
                            className="space-y-3"
                        >
                            <h3 className="font-semibold">
                                {en ? 'Leftover keys from deleted groups' : '已删除分组的遗留 Key'} ·{' '}
                                {data.orphan_groups.length}
                            </h3>
                            <p className={`text-sm leading-6 ${muted}`}>
                                {en
                                    ? 'These Portal groups are gone, but key records remain. Opening a preview does not revoke keys.'
                                    : '这些 Portal 分组已不存在，但仍有 Key 需要清理。打开预览不会撤销 Key。'}
                            </p>
                            {!data.orphan_groups.length && (
                                <p className={`text-sm ${muted}`}>
                                    {en ? 'No leftover keys found.' : '未发现遗留 Key。'}
                                </p>
                            )}
                            {data.orphan_groups.map((group) => (
                                <div key={`${group.tenant_id ?? 'platform'}:${group.tier_key}`} className={rowClass}>
                                    <div className="flex flex-wrap items-center justify-between gap-3">
                                        <div className="min-w-0 flex-1 text-sm">
                                            <p className="break-words font-medium">{group.tier_key}</p>
                                            <p className={`mt-1 ${muted}`}>
                                                {group.key_count} {en ? 'keys' : '个 Key'} · {group.active_key_count}{' '}
                                                {en ? 'active records' : '个启用记录'}
                                            </p>
                                            <p className={`mt-1 break-all text-xs ${muted}`}>
                                                {group.tenant_id
                                                    ? `${en ? 'Tenant' : '租户'}：${group.tenant_id}`
                                                    : en
                                                      ? 'Platform'
                                                      : '平台档次'}
                                            </p>
                                        </div>
                                        <button
                                            type="button"
                                            className={secondary}
                                            disabled={loading}
                                            onClick={() =>
                                                onOpen({
                                                    kind: 'orphan',
                                                    tenantId: group.tenant_id,
                                                    tierKey: group.tier_key,
                                                })
                                            }
                                        >
                                            {en ? 'Preview cleanup' : '预览清理'}
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </section>
                    </>
                )}
            </div>
            <footer
                className={`sticky bottom-0 flex flex-wrap justify-end gap-3 border-t p-4 ${isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-200 bg-white'}`}
            >
                <button
                    type="button"
                    className={secondary}
                    disabled={loading}
                    onClick={() => {
                        setLoading(true);
                        setError('');
                        setRefreshCount((count) => count + 1);
                    }}
                >
                    {en ? 'Refresh list' : '刷新列表'}
                </button>
                <button type="button" className={secondary} onClick={onClose} autoFocus>
                    {en ? 'Close' : '关闭'}
                </button>
            </footer>
        </dialog>
    );
}
