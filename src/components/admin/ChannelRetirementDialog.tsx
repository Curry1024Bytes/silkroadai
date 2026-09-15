'use client';

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { z } from 'zod';
import type { Locale } from '@/lib/locale';
import type {
    ChannelGroupRetirementPreview,
    ChannelGroupRetirementResult,
} from '@/lib/admin/channel-group-retirement-types';

const keyCounts = z.object({ active: z.number().int().nonnegative(), total: z.number().int().nonnegative() });
const previewSchema = z.object({
    group: z.object({
        id: z.string(),
        key: z.string(),
        display_name: z.string(),
        newapi_group: z.string(),
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
});
const resultSchema = z.object({
    group_key: z.string(),
    group_name: z.string(),
    updated_models: z.number().int().nonnegative(),
    disabled_models: z.number().int().nonnegative(),
    existing_keys: keyCounts,
    replacement_default_name: z.string().nullable(),
});

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
};

export async function requestChannelRetirement(
    groupId: string,
    input: RetirementInput,
    en: boolean,
    signal?: AbortSignal,
): Promise<{ preview: ChannelGroupRetirementPreview } | { result: ChannelGroupRetirementResult }> {
    const response = await fetch(`/api/admin/channel-groups/${encodeURIComponent(groupId)}/retire`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
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
    const parsed =
        input.action === 'preview'
            ? z.object({ preview: previewSchema }).safeParse(data)
            : z.object({ success: z.literal(true), result: resultSchema }).safeParse(data);
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

export interface ChannelRetirementState {
    preview: ChannelGroupRetirementPreview | null;
    displayedPreview: ChannelGroupRetirementPreview | null;
    replacementDefaultId: string | null;
    loading: boolean;
    applying: boolean;
    error: string;
}

/** Owns request ordering so an old preview can never authorize a newer selection. */
export function createChannelRetirementSession(groupId: string, en: boolean) {
    let state: ChannelRetirementState = {
        preview: null,
        displayedPreview: null,
        replacementDefaultId: null,
        loading: false,
        applying: false,
        error: '',
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
        if (disposed || state.applying) return;
        const requestId = ++sequence;
        pendingPreview?.abort();
        pendingPreview = new AbortController();
        change({ preview: null, replacementDefaultId, loading: true, error: notice });
        try {
            const data = await requestChannelRetirement(
                groupId,
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

    async function apply(): Promise<ChannelGroupRetirementResult | null> {
        const preview = state.preview;
        if (disposed || state.applying || state.loading || !preview?.canApply) return null;
        change({ applying: true, error: '' });
        try {
            const data = await requestChannelRetirement(
                groupId,
                {
                    action: 'apply',
                    preview_token: preview.preview_token,
                    replacement_default_id: preview.replacement_default_id,
                },
                en,
            );
            if (disposed || !('result' in data)) return null;
            change({ applying: false, preview: null });
            return data.result;
        } catch (error) {
            if (disposed) return null;
            const message = failureText(error);
            change({ applying: false, preview: null, error: message });
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
        start: () => {
            disposed = false;
            return refresh();
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
    const replacement = result.replacement_default_name
        ? en
            ? ` Default tier: ${result.replacement_default_name}.`
            : `默认档次已改为「${result.replacement_default_name}」。`
        : '';
    return en
        ? `Deleted “${result.group_name}” from Portal; removed its mappings from ${result.updated_models} models and unlisted ${result.disabled_models} models without any remaining tier mappings. History is retained; existing keys were not revoked.${replacement}`
        : `已从 Portal 删除「${result.group_name}」，清理 ${result.updated_models} 个模型的本档关联，下架 ${result.disabled_models} 个没有其他档次关联的模型。历史记录已保留，已有 Key 未撤销。${replacement}`;
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
    return (
        <div className="space-y-4">
            <div className={`rounded-lg p-3 text-sm ${isDark ? 'bg-slate-900/60' : 'bg-slate-50'}`}>
                <p className="break-words font-semibold">{preview.group.display_name}</p>
                <p className={`mt-1 break-words ${muted}`}>new-api group: {preview.group.newapi_group}</p>
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
                    {preview.upstream.status === 'missing'
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
                {preview.upstream.status !== 'missing' && (
                    <p>
                        {en
                            ? 'You can still clean up Portal. This action does not delete or disable anything in new-api.'
                            : '仍可清理 Portal；此操作不会删除或停用 new-api 中的配置。'}
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
            <section aria-label={en ? 'Deletion impact' : '删除影响'} className="space-y-3">
                <h3 className="font-semibold">
                    {en ? 'Portal will make these changes together' : 'Portal 将一次完成以下清理'}
                </h3>
                <p className={`text-sm leading-6 ${muted}`}>
                    {en
                        ? `Remove this tier from ${preview.models.length} models; unlist ${disabledCount} models without any remaining tier mappings. Other tiers and their mappings are retained.`
                        : `清理 ${preview.models.length} 个模型的本档关联，其中 ${disabledCount} 个没有其他档次关联的模型将自动下架。其他档次及其关联保留。`}
                </p>
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
                            ? 'Model records, price history, cost rules and their history, and usage records are retained.'
                            : '模型记录、价格历史、成本规则及其历史、用量记录均保留。'}
                    </p>
                    <p className="mt-1">
                        {en
                            ? 'Customers can no longer select this tier when creating keys or see its models in the Portal catalog. Customer tier permissions and multiplier settings are retained. Customers restricted to this tier will need access to another available tier.'
                            : '删除后，客户不能再选择此档新建 Key，Portal 目录也不再展示本档模型。客户档次权限和倍率配置保留；仅获准使用此档的客户，需要另行分配其他可用档次。'}
                    </p>
                    <p className="mt-1">
                        {en
                            ? `${preview.existing_keys.total} existing keys are recorded for this tier, including ${preview.existing_keys.active} active keys. They will not be revoked or moved to another group. If the upstream group was removed, these keys may no longer work.`
                            : `本档记录了 ${preview.existing_keys.total} 个已有 Key，其中 ${preview.existing_keys.active} 个仍为启用状态。删除不会撤销或迁移这些 Key；上游分组删除后，它们可能已无法调用。`}
                    </p>
                </div>
            </section>
            {preview.issues.length > 0 && (
                <div
                    role="alert"
                    className={`rounded-lg border p-3 text-sm leading-6 ${isDark ? 'border-amber-700 bg-amber-950/40 text-amber-200' : 'border-amber-300 bg-amber-50 text-amber-900'}`}
                >
                    <p className="font-medium">
                        {en ? 'Resolve these items before deleting' : '以下事项处理后即可删除'}
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

export default function ChannelRetirementDialog({
    groupId,
    locale,
    isDark,
    onClose,
    onComplete,
}: {
    groupId: string;
    locale: Locale;
    isDark: boolean;
    onClose: () => void;
    onComplete: (result: ChannelGroupRetirementResult) => void;
}) {
    const en = locale === 'en';
    const dialog = useRef<HTMLDialogElement>(null);
    const session = useMemo(() => createChannelRetirementSession(groupId, en), [groupId, en]);
    const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
    const busy = state.loading || state.applying;
    useEffect(() => {
        const el = dialog.current;
        el?.showModal();
        void session.start();
        return () => {
            session.dispose();
            el?.close();
        };
    }, [session]);
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
                        {en ? 'Delete group' : '删除分组'}
                    </h2>
                    <p
                        id="retirement-description"
                        className={`mt-2 text-sm leading-6 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}
                    >
                        {en
                            ? 'Review the impact, then confirm once to delete this Portal group and clean up its model references.'
                            : '核对影响后确认一次，即可删除 Portal 分组并清理模型关联，无需逐个编辑模型。'}
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
                        {en ? 'Checking the group and affected models…' : '正在核对分组和受影响模型…'}
                    </p>
                )}
                {state.displayedPreview && (
                    <ChannelRetirementPreviewDetails
                        preview={state.displayedPreview}
                        replacementDefaultId={state.replacementDefaultId}
                        isDark={isDark}
                        en={en}
                        disabled={state.applying}
                        onDefaultChange={(id) => void session.refresh(id)}
                    />
                )}
                {!busy && (
                    <button type="button" className={secondary} onClick={() => void session.refresh()}>
                        {en ? 'Refresh impact' : '重新核对'}
                    </button>
                )}
            </div>
            <footer
                className={`sticky bottom-0 flex flex-wrap justify-end gap-3 border-t p-4 ${isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-200 bg-white'}`}
            >
                <button type="button" className={secondary} disabled={busy} onClick={onClose} autoFocus>
                    {en ? 'Cancel' : '取消'}
                </button>
                <button
                    type="button"
                    disabled={busy || !state.preview?.canApply}
                    onClick={async () => {
                        const result = await session.apply();
                        if (result) onComplete(result);
                    }}
                    className="min-h-11 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {state.applying ? (en ? 'Deleting…' : '正在删除…') : en ? 'Confirm deletion' : '确认删除并清理关联'}
                </button>
            </footer>
        </dialog>
    );
}
