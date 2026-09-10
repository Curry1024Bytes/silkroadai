'use client';

import { useEffect, useRef, useState } from 'react';
import type { Locale } from '@/lib/locale';
import type { ChannelReplacementOptions, ChannelReplacementPreview } from '@/lib/admin/channel-replacement-types';

export default function ChannelReplacementDialog({
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
    onComplete: (preview: ChannelReplacementPreview) => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const [options, setOptions] = useState<ChannelReplacementOptions | null>(null);
    const [source, setSource] = useState('');
    const [target, setTarget] = useState('');
    const [preview, setPreview] = useState<ChannelReplacementPreview | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
    const [error, setError] = useState('');
    const en = locale === 'en';
    const endpoint = `/api/admin/channel-groups/${groupId}/replace-channel`;

    useEffect(() => {
        const el = dialog.current;
        el?.showModal();
        return () => el?.close();
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        async function load() {
            try {
                const response = await fetch(endpoint, { signal: controller.signal });
                const data = await response.json();
                if (!response.ok)
                    throw new Error(data.message || (en ? 'Unable to load channels.' : '无法读取渠道列表。'));
                setOptions(data);
                setSource(String(data.group.newapi_channel_ids[0] ?? ''));
            } catch (err) {
                if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '加载失败');
            } finally {
                if (!controller.signal.aborted) setLoading(false);
            }
        }
        void load();
        return () => controller.abort();
    }, [endpoint, en]);

    async function submit(apply: boolean) {
        if (apply && !preview?.canApply) return;
        setBusy(apply ? 'apply' : 'preview');
        setError('');
        try {
            const response = await fetch(`${endpoint}?dryRun=${!apply}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    source_channel_id: Number(source),
                    target_channel_id: Number(target),
                    ...(apply ? { preview_token: preview!.preview_token } : {}),
                }),
            });
            const data = await response.json();
            if (!response.ok)
                throw new Error(
                    data.message || (en ? 'Request failed. Refresh the preview.' : '请求失败，请重新预览。'),
                );
            if (apply) onComplete(data.preview);
            else setPreview(data.preview);
        } catch (err) {
            setPreview(null);
            setError(
                err instanceof Error
                    ? err.message
                    : en
                      ? 'Result unknown. Refresh before retrying.'
                      : '未能确认操作结果，请刷新后再试。',
            );
        } finally {
            setBusy(null);
        }
    }

    const control = `mt-2 min-h-11 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 ${isDark ? 'border-slate-600 bg-slate-800 text-slate-100' : 'border-slate-300 bg-white text-slate-900'}`;
    const secondary = `min-h-11 rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50 ${isDark ? 'border-slate-600 hover:bg-slate-700' : 'border-slate-300 hover:bg-slate-50'}`;
    const muted = isDark ? 'text-slate-300' : 'text-slate-600';

    return (
        <dialog
            ref={dialog}
            aria-labelledby="replacement-title"
            aria-describedby="replacement-description"
            onCancel={(event) => {
                event.preventDefault();
                if (!busy) onClose();
            }}
            className={`m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-2xl border p-0 shadow-2xl backdrop:bg-black/60 ${isDark ? 'border-slate-700 bg-slate-800 text-slate-100' : 'border-slate-200 bg-white text-slate-900'}`}
        >
            <div className="space-y-5 p-5 sm:p-6">
                <header>
                    <h2 id="replacement-title" className="text-xl font-semibold">
                        {en ? 'Replace channel' : '替换渠道'}
                    </h2>
                    <p id="replacement-description" className={`mt-2 text-sm leading-6 ${muted}`}>
                        {en
                            ? 'Choose a replacement and review the affected models. Confirm once to update the tier and all model references.'
                            : '选择新渠道，核对受影响的模型。确认后，系统一次更新档次登记和全部模型引用。'}
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
                {loading && <p role="status">{en ? 'Loading channels…' : '正在读取渠道…'}</p>}
                {options && (
                    <>
                        <div className={`rounded-lg p-3 text-sm ${isDark ? 'bg-slate-900/60' : 'bg-slate-50'}`}>
                            <p className="font-medium">{options.group.display_name}</p>
                            <p className={`mt-1 ${muted}`}>new-api group: {options.group.newapi_group}</p>
                        </div>
                        <fieldset disabled={!!busy} className="grid gap-4 sm:grid-cols-2 disabled:opacity-70">
                            <label className="text-sm font-medium">
                                {en ? 'Original channel' : '原渠道'}
                                <select
                                    value={source}
                                    className={control}
                                    onChange={(event) => {
                                        setSource(event.target.value);
                                        setPreview(null);
                                        setError('');
                                    }}
                                >
                                    {options.group.newapi_channel_ids.map((id) => {
                                        const channel = options.channels.find((item) => item.id === id);
                                        return (
                                            <option key={id} value={id}>
                                                #{id} ·{' '}
                                                {channel?.name ?? (en ? 'Not in new-api list' : '未在 new-api 列表中')}
                                            </option>
                                        );
                                    })}
                                </select>
                            </label>
                            <label className="text-sm font-medium">
                                {en ? 'New channel' : '新渠道'}
                                <select
                                    value={target}
                                    className={control}
                                    onChange={(event) => {
                                        setTarget(event.target.value);
                                        setPreview(null);
                                        setError('');
                                    }}
                                >
                                    <option value="">{en ? 'Select a channel' : '请选择新渠道'}</option>
                                    {options.channels
                                        .filter((item) => item.id !== Number(source))
                                        .map((channel) => {
                                            const reason =
                                                channel.owner && channel.owner !== options.group.key
                                                    ? en
                                                        ? 'assigned to another tier'
                                                        : '已归属其他档次'
                                                    : !channel.groups.includes(options.group.newapi_group)
                                                      ? en
                                                          ? 'different group'
                                                          : '分组不匹配'
                                                      : channel.status !== 1
                                                        ? en
                                                            ? 'not enabled'
                                                            : '未启用'
                                                        : '';
                                            return (
                                                <option key={channel.id} value={channel.id} disabled={!!reason}>
                                                    #{channel.id} · {channel.name}
                                                    {reason ? ` (${reason})` : ''}
                                                </option>
                                            );
                                        })}
                                </select>
                            </label>
                        </fieldset>
                        <p className={`text-sm ${muted}`}>
                            {en
                                ? 'Available replacements must be enabled, in this new-api group, and free of ownership conflicts. Model coverage is checked in the preview.'
                                : '可选渠道须已启用、属于本 new-api 分组，且没有档次归属冲突。预览时会进一步检查模型是否齐全。'}
                        </p>
                        <button
                            type="button"
                            className={secondary}
                            disabled={!!busy || !source || !target || source === target}
                            onClick={() => submit(false)}
                        >
                            {busy === 'preview'
                                ? en
                                    ? 'Checking…'
                                    : '正在核对…'
                                : en
                                  ? 'Preview affected models'
                                  : '预览受影响模型'}
                        </button>
                    </>
                )}
                {preview && (
                    <section aria-live="polite" className="space-y-3">
                        <h3 className="font-semibold">
                            {en
                                ? `${preview.models.length} model references to update`
                                : `将更新 ${preview.models.length} 个模型的渠道引用`}
                        </h3>
                        <p className={`text-sm ${muted}`}>
                            #{preview.source_channel_id} → #{preview.target.id} · {preview.target.name}
                        </p>
                        {preview.issues.length > 0 && (
                            <div
                                role="alert"
                                className={`rounded-lg border p-3 text-sm ${isDark ? 'border-amber-700 bg-amber-950/40 text-amber-200' : 'border-amber-300 bg-amber-50 text-amber-900'}`}
                            >
                                <p className="font-medium">
                                    {en ? 'Resolve these issues before replacing' : '以下问题解决后才能替换'}
                                </p>
                                <ul className="mt-2 list-disc space-y-1 pl-5">
                                    {preview.issues.map((issue, index) => (
                                        <li key={`${issue.code}-${index}`}>{issue.message}</li>
                                    ))}
                                </ul>
                            </div>
                        )}
                        <ul
                            className={`max-h-64 divide-y overflow-y-auto rounded-lg border ${isDark ? 'divide-slate-700 border-slate-600' : 'divide-slate-200 border-slate-200'}`}
                        >
                            {preview.models.map((model) => (
                                <li
                                    key={model.id}
                                    className="flex flex-wrap items-start justify-between gap-2 px-3 py-2 text-sm"
                                >
                                    <div className="min-w-0 break-all">
                                        <p className="font-medium">{model.slug}</p>
                                        <p className={`text-xs ${muted}`}>
                                            {model.upstream_model}
                                            {!model.enabled ? (en ? ' · disabled model' : ' · 已下架模型') : ''}
                                        </p>
                                    </div>
                                    <span
                                        className={
                                            model.supported
                                                ? isDark
                                                    ? 'text-emerald-300'
                                                    : 'text-emerald-700'
                                                : isDark
                                                  ? 'text-amber-200'
                                                  : 'text-amber-800'
                                        }
                                    >
                                        {model.supported
                                            ? en
                                                ? 'Available'
                                                : '已覆盖'
                                            : en
                                              ? 'Missing'
                                              : '新渠道缺少此模型'}
                                    </span>
                                </li>
                            ))}
                        </ul>
                        <p className={`rounded-lg p-3 text-sm leading-6 ${isDark ? 'bg-slate-900/60' : 'bg-slate-50'}`}>
                            {en
                                ? 'Prices, price history, customer keys and model names stay unchanged. This checks configuration; it does not test paid inference.'
                                : '保留已有价格、价格历史、客户 Key 和模型名。本次核对渠道配置，不发起收费推理。'}
                        </p>
                    </section>
                )}
            </div>
            <footer
                className={`sticky bottom-0 flex flex-wrap justify-end gap-3 border-t p-4 ${isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-200 bg-white'}`}
            >
                <button type="button" className={secondary} disabled={!!busy} onClick={onClose}>
                    {en ? 'Cancel' : '取消'}
                </button>
                <button
                    type="button"
                    onClick={() => submit(true)}
                    disabled={!!busy || !preview?.canApply}
                    className="min-h-11 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {busy === 'apply' ? (en ? 'Replacing…' : '正在替换…') : en ? 'Confirm replacement' : '确认替换'}
                </button>
            </footer>
        </dialog>
    );
}
