'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Locale } from '@/lib/locale';
import type {
    NewApiSyncItem,
    NewApiSyncPreview,
    NewApiSyncResponse,
    NewApiSyncSummary,
} from '@/lib/admin/newapi-sync-types';

/** One-line summary, e.g. 将上架 3、下架 1、价格更新 2、档次新增 1. */
export function syncSummaryText(summary: NewApiSyncSummary, en: boolean): string {
    const parts: [number, string, string][] = [
        [summary.models_published, 'publish', '上架'],
        [summary.models_unpublished, 'unpublish', '下架'],
        [summary.models_updated, 'remap', '映射更新'],
        [summary.prices_updated, 'price updates', '价格更新'],
        [summary.groups_created, 'new tiers', '档次新增'],
        [summary.groups_updated, 'tier updates', '档次更新'],
    ];
    const shown = parts.filter(([count]) => count > 0);
    if (!shown.length) return en ? 'No changes' : '没有变化';
    return en
        ? `Will ${shown.map(([count, label]) => `${label} ${count}`).join(', ')}`
        : `将${shown.map(([count, , label]) => `${label} ${count}`).join('、')}`;
}

export class NewApiSyncRequestError extends Error {
    constructor(
        message: string,
        public status: number,
    ) {
        super(message);
    }
}

export async function requestNewApiSync(
    body: Record<string, unknown>,
    apply: boolean,
    en: boolean,
    signal?: AbortSignal,
): Promise<NewApiSyncResponse> {
    const response = await fetch(`/api/admin/newapi-sync?dryRun=${!apply}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
        const fallback =
            response.status === 409
                ? en
                    ? 'The configuration changed. Refresh the preview.'
                    : '配置已变化，请重新预览。'
                : en
                  ? 'Unable to load the result. Refresh the preview.'
                  : '未能读取结果，请重新预览。';
        throw new NewApiSyncRequestError(typeof data?.message === 'string' ? data.message : fallback, response.status);
    }
    if (
        !data?.preview ||
        !Array.isArray(data.preview.items) ||
        typeof data.preview.preview_token !== 'string' ||
        !data.preview.summary
    ) {
        throw new NewApiSyncRequestError(
            en ? 'The response was incomplete. Refresh the preview.' : '返回结果不完整，请重新预览。',
            response.status,
        );
    }
    return data as NewApiSyncResponse;
}

export function NewApiSyncChangeList({ items, en, isDark }: { items: NewApiSyncItem[]; en: boolean; isDark: boolean }) {
    const muted = isDark ? 'text-slate-300' : 'text-slate-600';
    const kinds = en
        ? { group: 'Tier', model: 'Model', price: 'Price' }
        : { group: '档次', model: '模型', price: '价格' };
    const changes = en
        ? { create: 'New', update: 'Update', publish: 'Publish', unpublish: 'Unpublish' }
        : { create: '新增', update: '更新', publish: '上架', unpublish: '下架' };
    return (
        <details className={`rounded-xl border ${isDark ? 'border-slate-600' : 'border-slate-200'}`}>
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                {en ? `View details (${items.length})` : `查看明细（${items.length} 项）`}
            </summary>
            <ul className={`divide-y text-sm ${isDark ? 'divide-slate-700' : 'divide-slate-100'}`}>
                {items.map((item) => (
                    <li key={item.id} className="px-4 py-3">
                        <p className="flex flex-wrap items-center gap-2 font-medium">
                            <span
                                className={`rounded px-2 py-0.5 text-xs ${item.change === 'unpublish' ? (isDark ? 'bg-amber-950/50 text-amber-200' : 'bg-amber-50 text-amber-800') : isDark ? 'bg-slate-700 text-slate-200' : 'bg-slate-100 text-slate-600'}`}
                            >
                                {kinds[item.kind]} · {changes[item.change]}
                            </span>
                            <span className="break-words">{item.title}</span>
                        </p>
                        <div className={`mt-2 grid gap-2 sm:grid-cols-2 ${muted}`}>
                            <div className="break-words">
                                <p className="text-xs font-medium">{en ? 'Now' : '当前'}</p>
                                {item.before.map((line, index) => (
                                    <p key={index}>{line}</p>
                                ))}
                            </div>
                            <div className="break-words">
                                <p className="text-xs font-medium">{en ? 'After sync' : '同步后'}</p>
                                {item.after.map((line, index) => (
                                    <p key={index}>{line}</p>
                                ))}
                            </div>
                        </div>
                    </li>
                ))}
            </ul>
        </details>
    );
}

export default function NewApiSyncDialog({
    locale,
    isDark,
    onClose,
    onComplete,
}: {
    locale: Locale;
    isDark: boolean;
    onClose: () => void;
    onComplete: (applied: NonNullable<NewApiSyncResponse['applied']>) => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const inFlight = useRef(false);
    const titleId = useId();
    const descriptionId = useId();
    const en = locale === 'en';
    const [preview, setPreview] = useState<NewApiSyncPreview | null>(null);
    const [busy, setBusy] = useState<'preview' | 'apply' | null>('preview');
    const [error, setError] = useState('');
    const [applied, setApplied] = useState<NewApiSyncResponse['applied']>();
    const loadPreview = useCallback(
        async (signal?: AbortSignal) => {
            if (inFlight.current) return;
            inFlight.current = true;
            setBusy('preview');
            setPreview(null);
            setError('');
            try {
                const data = await requestNewApiSync({}, false, en, signal);
                if (!signal?.aborted) setPreview(data.preview);
            } catch (err) {
                if (!signal?.aborted)
                    setError(err instanceof Error ? err.message : en ? 'Unable to load preview.' : '预览加载失败。');
            } finally {
                inFlight.current = false;
                if (!signal?.aborted) setBusy(null);
            }
        },
        [en],
    );

    useEffect(() => {
        const element = dialog.current;
        const previousFocus = document.activeElement;
        element?.showModal();
        return () => {
            element?.close();
            if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
        };
    }, []);
    useEffect(() => {
        // Deferring to a microtask avoids two initial requests under Strict Mode.
        const controller = new AbortController();
        queueMicrotask(() => {
            if (!controller.signal.aborted) void loadPreview(controller.signal);
        });
        return () => controller.abort();
    }, [loadPreview]);

    async function apply() {
        if (inFlight.current || !preview || preview.blocked || !preview.items.length || applied) return;
        inFlight.current = true;
        setBusy('apply');
        setError('');
        try {
            const data = await requestNewApiSync({ preview_token: preview.preview_token }, true, en);
            if (!data.applied)
                throw new Error(
                    en
                        ? 'Result unknown. Refresh the preview before retrying.'
                        : '未能确认操作结果，请重新预览后核对。',
                );
            setApplied(data.applied);
            onComplete(data.applied);
        } catch (err) {
            // A stale or uncertain result always requires a fresh preview, never a replay.
            setPreview(null);
            setError(
                err instanceof Error
                    ? err.message
                    : en
                      ? 'Result unknown. Refresh the preview.'
                      : '未能确认操作结果，请重新预览。',
            );
        } finally {
            inFlight.current = false;
            setBusy(null);
        }
    }

    const muted = isDark ? 'text-slate-300' : 'text-slate-600';
    const secondary = `min-h-11 rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 ${isDark ? 'border-slate-600 hover:bg-slate-700' : 'border-slate-300 hover:bg-slate-50'}`;
    return (
        <dialog
            ref={dialog}
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            onCancel={(event) => {
                event.preventDefault();
                if (!inFlight.current && !busy) onClose();
            }}
            className={`m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-4xl overflow-y-auto rounded-2xl border p-0 shadow-2xl backdrop:bg-black/60 ${isDark ? 'border-slate-700 bg-slate-800 text-slate-100' : 'border-slate-200 bg-white text-slate-900'}`}
        >
            <div className="space-y-5 p-5 sm:p-6">
                <header>
                    <h2 id={titleId} className="text-xl font-semibold">
                        {en ? 'Update catalog from new-api' : '从 new-api 更新目录'}
                    </h2>
                    <p id={descriptionId} className={`mt-2 text-sm leading-6 ${muted}`}>
                        {en
                            ? 'Align the Portal catalog with new-api: models offered by enabled channels are published, models no longer offered are unpublished, and catalog prices follow new-api. This does not publish prices to new-api.'
                            : '让 Portal 目录与 new-api 保持一致：启用渠道里有的模型自动上架，渠道已不提供的模型自动下架（不删除），目录价格跟随 new-api。此操作不会把价格发布到 new-api。'}
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
                {busy === 'preview' && (
                    <p role="status" className="py-8 text-center">
                        {en ? 'Reading new-api and comparing changes…' : '正在读取 new-api 并核对差异…'}
                    </p>
                )}
                {applied ? (
                    <div
                        role="status"
                        className={`rounded-xl border p-4 ${isDark ? 'border-emerald-700 bg-emerald-950/40 text-emerald-200' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}
                    >
                        <h3 className="font-semibold">{en ? 'Catalog updated' : '目录更新完成'}</h3>
                        <p className="mt-2 text-sm">
                            {en
                                ? `${applied.groups} tiers, ${applied.models} models, ${applied.prices} prices updated.`
                                : `已处理 ${applied.groups} 个档次、${applied.models} 个模型、${applied.prices} 条价格。`}
                        </p>
                    </div>
                ) : (
                    preview && (
                        <>
                            <p className="text-lg font-semibold">{syncSummaryText(preview.summary, en)}</p>
                            {preview.blocked && (
                                <p
                                    role="alert"
                                    className={`rounded-lg border p-3 text-sm ${isDark ? 'border-red-700 bg-red-950/40 text-red-200' : 'border-red-200 bg-red-50 text-red-700'}`}
                                >
                                    {en ? 'Cannot sync yet: ' : '暂不能同步：'}
                                    {preview.blocked}
                                </p>
                            )}
                            {preview.items.length > 0 && (
                                <NewApiSyncChangeList items={preview.items} en={en} isDark={isDark} />
                            )}
                            {preview.warnings.length > 0 && (
                                <div
                                    role="status"
                                    className={`rounded-lg border p-3 text-sm ${isDark ? 'border-amber-700 bg-amber-950/40 text-amber-200' : 'border-amber-300 bg-amber-50 text-amber-900'}`}
                                >
                                    <p className="font-medium">
                                        {en ? 'Not handled automatically' : '以下情况不会自动处理，请核对'}
                                    </p>
                                    <ul className="mt-2 list-disc space-y-1 pl-5">
                                        {preview.warnings.map((warning, index) => (
                                            <li key={index}>{warning}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            <p className={`text-sm ${muted}`}>
                                {en
                                    ? `Unchanged: ${preview.unchanged.groups} tiers · ${preview.unchanged.models} models · ${preview.unchanged.prices} prices`
                                    : `保持不变：${preview.unchanged.groups} 个档次 · ${preview.unchanged.models} 个模型 · ${preview.unchanged.prices} 条价格`}
                            </p>
                        </>
                    )
                )}
            </div>
            <footer
                className={`sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t p-4 sm:px-6 ${isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-200 bg-white'}`}
            >
                <p aria-live="polite" className={`text-sm ${muted}`}>
                    {!applied && preview && !preview.blocked && !preview.items.length
                        ? en
                            ? 'Already in sync with new-api.'
                            : '目录已与 new-api 一致。'
                        : ''}
                </p>
                <div className="flex flex-wrap gap-2">
                    <button
                        type="button"
                        className={secondary}
                        disabled={!!busy}
                        onClick={() => {
                            if (!inFlight.current) onClose();
                        }}
                    >
                        {en ? 'Close' : '关闭'}
                    </button>
                    {!applied && (
                        <>
                            <button
                                type="button"
                                className={secondary}
                                disabled={!!busy}
                                onClick={() => void loadPreview()}
                            >
                                {en ? 'Refresh preview' : '重新预览'}
                            </button>
                            <button
                                type="button"
                                className="min-h-11 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
                                disabled={!!busy || !preview || !!preview.blocked || !preview.items.length}
                                onClick={() => void apply()}
                            >
                                {busy === 'apply'
                                    ? en
                                        ? 'Updating catalog…'
                                        : '正在更新目录…'
                                    : en
                                      ? 'Confirm sync'
                                      : '确认同步'}
                            </button>
                        </>
                    )}
                </div>
            </footer>
        </dialog>
    );
}
