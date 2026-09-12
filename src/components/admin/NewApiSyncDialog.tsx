'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Locale } from '@/lib/locale';
import type {
    NewApiSyncItem,
    NewApiSyncPreview,
    NewApiSyncResponse,
    NewApiSyncSelection,
} from '@/lib/admin/newapi-sync-types';

/** Add required changes together; removing a prerequisite also removes its dependants. */
export function toggleSyncSelection(items: NewApiSyncItem[], selected: string[], id: string): string[] {
    const byId = new Map(items.map((item) => [item.id, item]));
    const next = new Set(selected);
    if (next.has(id)) {
        next.delete(id);
        let changed = true;
        while (changed) {
            changed = false;
            for (const selectedId of next) {
                if (byId.get(selectedId)?.dependsOn.some((dependency) => !next.has(dependency))) {
                    next.delete(selectedId);
                    changed = true;
                }
            }
        }
    } else {
        const visiting = new Set<string>();
        function add(itemId: string): boolean {
            if (next.has(itemId)) return true;
            const item = byId.get(itemId);
            if (!item?.selectable) return false;
            if (visiting.has(itemId)) return true;
            visiting.add(itemId);
            if (!item.dependsOn.every(add)) return false;
            next.add(itemId);
            visiting.delete(itemId);
            return true;
        }
        // An incomplete dependency chain must not leave a partial selection behind.
        if (!add(id)) return selected;
    }
    return items.filter((item) => next.has(item.id) && item.selectable).map((item) => item.id);
}

export function defaultSyncSelection(items: NewApiSyncItem[]): NewApiSyncSelection {
    let selected: string[] = [];
    for (const item of items) {
        if (item.defaultSelected && item.selectable && !selected.includes(item.id)) {
            selected = toggleSyncSelection(items, selected, item.id);
        }
    }
    return { selected, activate: [] };
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
    if (!data?.preview || !Array.isArray(data.preview.items) || typeof data.preview.preview_token !== 'string') {
        throw new NewApiSyncRequestError(
            en ? 'The response was incomplete. Refresh the preview.' : '返回结果不完整，请重新预览。',
            response.status,
        );
    }
    return data as NewApiSyncResponse;
}

export function NewApiSyncPreviewList({
    preview,
    selection,
    disabled,
    en,
    isDark,
    onToggle,
    onActivate,
}: {
    preview: NewApiSyncPreview;
    selection: NewApiSyncSelection;
    disabled: boolean;
    en: boolean;
    isDark: boolean;
    onToggle: (id: string) => void;
    onActivate: (id: string) => void;
}) {
    const muted = isDark ? 'text-slate-300' : 'text-slate-600';
    const kinds = [
        { key: 'group', title: en ? 'Tiers and channels' : '档次与渠道' },
        { key: 'model', title: en ? 'Models' : '模型' },
        { key: 'price', title: en ? 'Prices' : '价格' },
    ] as const;
    const changes = en
        ? { new: 'New', update: 'Update', unavailable: 'Needs review', missing: 'Missing information' }
        : { new: '新增', update: '更新', unavailable: '需核对', missing: '信息缺失' };
    return (
        <div className="space-y-6">
            {kinds.map(({ key, title }) => {
                const items = preview.items.filter((item) => item.kind === key);
                if (!items.length) return null;
                return (
                    <section key={key} aria-label={title} className="space-y-3">
                        <h3 className="font-semibold">
                            {title} <span className={`text-sm font-normal ${muted}`}>({items.length})</span>
                        </h3>
                        {key === 'price' && (
                            <p className={`text-sm leading-6 ${muted}`}>
                                {en
                                    ? 'Read current new-api prices into the Portal catalog. This does not change new-api billing. Changes to existing catalog prices require your selection.'
                                    : '将 new-api 当前价格读入 Portal 目录。此操作不修改 new-api 扣费；已有目录价格的变化需单独勾选。'}
                            </p>
                        )}
                        {key === 'price' && items.some((item) => !item.selectable) && (
                            <a
                                href={`/admin/pricing?lang=${en ? 'en' : 'zh'}&theme=${isDark ? 'dark' : 'light'}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                aria-disabled={disabled}
                                onClick={(event) => {
                                    if (disabled) event.preventDefault();
                                }}
                                className={`inline-block text-sm underline underline-offset-4 ${isDark ? 'text-emerald-300' : 'text-emerald-700'} ${disabled ? 'pointer-events-none opacity-50' : ''}`}
                            >
                                {en
                                    ? 'Review missing prices on the Pricing page (new tab)'
                                    : '前往定价页核对缺失价格（新窗口）'}
                            </a>
                        )}
                        {items.map((item) => {
                            const selected = selection.selected.includes(item.id);
                            return (
                                <article
                                    key={item.id}
                                    className={`rounded-xl border p-4 ${isDark ? 'border-slate-600 bg-slate-900/40' : 'border-slate-200 bg-white'}`}
                                >
                                    <div className="flex flex-wrap items-start justify-between gap-2">
                                        <label className="flex min-w-0 items-start gap-3 font-medium">
                                            <input
                                                type="checkbox"
                                                className="mt-1 size-4 shrink-0 accent-emerald-600"
                                                checked={selected}
                                                disabled={disabled || !item.selectable}
                                                onChange={() => onToggle(item.id)}
                                            />
                                            <span className="break-words">{item.title}</span>
                                        </label>
                                        <span
                                            className={`rounded px-2 py-0.5 text-xs ${item.selectable ? (isDark ? 'bg-slate-700 text-slate-200' : 'bg-slate-100 text-slate-600') : isDark ? 'bg-amber-950/50 text-amber-200' : 'bg-amber-50 text-amber-800'}`}
                                        >
                                            {changes[item.change]}
                                        </span>
                                    </div>
                                    <dl className={`mt-3 grid gap-3 text-sm sm:grid-cols-2 ${muted}`}>
                                        <div>
                                            <dt className="mb-1 font-medium">{en ? 'Portal now' : 'Portal 当前'}</dt>
                                            <dd className="space-y-1 break-words">
                                                {item.before.length ? (
                                                    item.before.map((line, index) => <p key={index}>{line}</p>)
                                                ) : (
                                                    <p>{en ? 'None' : '暂无'}</p>
                                                )}
                                            </dd>
                                        </div>
                                        <div>
                                            <dt className="mb-1 font-medium">
                                                {en ? 'Catalog after update' : '目录更新后'}
                                            </dt>
                                            <dd className="space-y-1 break-words">
                                                {item.after.length ? (
                                                    item.after.map((line, index) => <p key={index}>{line}</p>)
                                                ) : (
                                                    <p>—</p>
                                                )}
                                            </dd>
                                        </div>
                                    </dl>
                                    {item.notes.length > 0 && (
                                        <ul className={`mt-3 list-disc space-y-1 pl-5 text-sm ${muted}`}>
                                            {item.notes.map((note, index) => (
                                                <li key={index}>{note}</li>
                                            ))}
                                        </ul>
                                    )}
                                    {item.dependsOn.length > 0 && (
                                        <p className={`mt-2 text-xs ${muted}`}>
                                            {en
                                                ? 'Required related changes are selected together.'
                                                : '勾选时会同时选择所需的关联变更。'}
                                        </p>
                                    )}
                                    {item.canActivate && item.selectable && (
                                        <label className="mt-3 flex items-start gap-2 border-t border-slate-300/30 pt-3 text-sm">
                                            <input
                                                type="checkbox"
                                                className="mt-1 size-4 shrink-0 accent-emerald-600"
                                                checked={selection.activate.includes(item.id)}
                                                disabled={disabled || !selected}
                                                onChange={() => onActivate(item.id)}
                                                aria-label={`${item.kind === 'group' ? (en ? 'Enable tier' : '同时启用档次') : en ? 'Publish model' : '同时上架模型'}：${item.title}`}
                                            />
                                            <span>
                                                {item.kind === 'group'
                                                    ? en
                                                        ? 'Also enable this tier for customers'
                                                        : '同时启用档次，允许客户选择'
                                                    : en
                                                      ? 'Also publish this model'
                                                      : '同时上架模型'}
                                                <span className={`mt-1 block text-xs ${muted}`}>
                                                    {en ? 'Leave unchecked to keep it inactive.' : '不勾选则保持停用。'}
                                                </span>
                                            </span>
                                        </label>
                                    )}
                                </article>
                            );
                        })}
                    </section>
                );
            })}
        </div>
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
    const [selection, setSelection] = useState<NewApiSyncSelection>({ selected: [], activate: [] });
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
            setSelection({ selected: [], activate: [] });
            try {
                const data = await requestNewApiSync({}, false, en, signal);
                if (!signal?.aborted) {
                    setPreview(data.preview);
                    setSelection(defaultSyncSelection(data.preview.items));
                }
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
        if (inFlight.current || !preview || !selection.selected.length || applied) return;
        inFlight.current = true;
        setBusy('apply');
        setError('');
        try {
            const data = await requestNewApiSync({ preview_token: preview.preview_token, ...selection }, true, en);
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
            setSelection({ selected: [], activate: [] });
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
                            ? 'Read tiers, channels, models and current prices from new-api. Review the differences, then confirm which Portal catalog entries to update.'
                            : '从 new-api 读取档次、渠道、模型和当前价格，核对差异后更新 Portal 目录。此操作不会把价格发布到 new-api。'}
                    </p>
                </header>
                <p
                    className={`rounded-xl p-3 text-sm leading-6 ${isDark ? 'bg-slate-900/60 text-slate-200' : 'bg-slate-50 text-slate-700'}`}
                >
                    {en
                        ? 'New tiers and models are saved as inactive candidates by default. Enabling or publishing requires a separate selection. Sync checks configuration; paid model availability still needs verification.'
                        : '新增档次和模型默认保存为停用候选；启用或上架需额外勾选。同步只核对配置，实际模型调用是否可用仍需单独验收。'}
                </p>
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
                        <p className="mt-2 text-sm">
                            {en
                                ? 'Review candidates before making them available to customers.'
                                : '候选内容请核对后再向客户开放。'}
                        </p>
                    </div>
                ) : (
                    preview && (
                        <>
                            {preview.warnings.length > 0 && (
                                <div
                                    role="status"
                                    className={`rounded-lg border p-3 text-sm ${isDark ? 'border-amber-700 bg-amber-950/40 text-amber-200' : 'border-amber-300 bg-amber-50 text-amber-900'}`}
                                >
                                    <p className="font-medium">{en ? 'Needs your attention' : '需要核对'}</p>
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
                            {!preview.items.length ? (
                                <p role="status" className="py-6 text-center font-medium">
                                    {preview.warnings.length
                                        ? en
                                            ? 'No changes can be applied. Review the notes above.'
                                            : '暂无可更新的目录内容，请先核对上方提示。'
                                        : en
                                          ? 'Everything is up to date.'
                                          : '当前目录已与 new-api 对齐，没有新的变更。'}
                                </p>
                            ) : (
                                <>
                                    {!preview.items.some((item) => item.selectable) && (
                                        <p role="status" className="text-sm">
                                            {en
                                                ? 'These items need review and cannot be applied yet.'
                                                : '本次只有需核对项，处理提示后再重新预览。'}
                                        </p>
                                    )}
                                    {preview.items.some((item) => item.selectable) && (
                                        <div className="flex flex-wrap gap-2">
                                            <button
                                                type="button"
                                                disabled={!!busy}
                                                className={secondary}
                                                onClick={() => setSelection(defaultSyncSelection(preview.items))}
                                            >
                                                {en ? 'Select suggested changes' : '选择建议项'}
                                            </button>
                                            <button
                                                type="button"
                                                disabled={!!busy}
                                                className={secondary}
                                                onClick={() => setSelection({ selected: [], activate: [] })}
                                            >
                                                {en ? 'Clear selection' : '取消全部'}
                                            </button>
                                        </div>
                                    )}
                                    <NewApiSyncPreviewList
                                        preview={preview}
                                        selection={selection}
                                        disabled={!!busy}
                                        en={en}
                                        isDark={isDark}
                                        onToggle={(id) => {
                                            if (inFlight.current) return;
                                            setSelection((current) => {
                                                const selected = toggleSyncSelection(
                                                    preview.items,
                                                    current.selected,
                                                    id,
                                                );
                                                return {
                                                    selected,
                                                    activate: current.activate.filter((itemId) =>
                                                        selected.includes(itemId),
                                                    ),
                                                };
                                            });
                                        }}
                                        onActivate={(id) => {
                                            if (inFlight.current) return;
                                            setSelection((current) => ({
                                                ...current,
                                                activate: current.activate.includes(id)
                                                    ? current.activate.filter((itemId) => itemId !== id)
                                                    : [...current.activate, id],
                                            }));
                                        }}
                                    />
                                </>
                            )}
                        </>
                    )
                )}
            </div>
            <footer
                className={`sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t p-4 sm:px-6 ${isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-200 bg-white'}`}
            >
                <p aria-live="polite" className={`text-sm ${muted}`}>
                    {!applied &&
                        (en
                            ? `${selection.selected.length} selected · ${selection.activate.length} to enable or publish`
                            : `已选 ${selection.selected.length} 项 · 启用或上架 ${selection.activate.length} 项`)}
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
                                disabled={!!busy || !preview || !selection.selected.length}
                                onClick={() => void apply()}
                            >
                                {busy === 'apply'
                                    ? en
                                        ? 'Updating catalog…'
                                        : '正在更新目录…'
                                    : en
                                      ? 'Confirm catalog update'
                                      : '确认更新目录'}
                            </button>
                        </>
                    )}
                </div>
            </footer>
        </dialog>
    );
}
