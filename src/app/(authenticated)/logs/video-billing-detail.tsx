'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Check, Clipboard, Film } from 'lucide-react';
import { useMessages } from '@/lib/i18n/client';
import { logsMessages } from '@/lib/i18n/messages/logs';
import { formatSignedCny } from '@/lib/format/number';
import type { LogRow } from '@/app/api/portal/logs/route';
import type { CustomerVideoTask } from '@/lib/video-task-display';
import { formatDuration } from '../dashboard/format';

type VideoCopy = (typeof logsMessages)['zh']['video'];
type RowVideo = NonNullable<LogRow['video']>;

export function videoSpec(video: RowVideo, copy: VideoCopy): string {
    const parts: string[] = [];
    if (video.resolution) parts.push(video.resolution);
    if (video.videoInput) parts.push(video.videoInput === 'video' ? copy.withVideo : copy.noVideo);
    if (video.seconds !== null) parts.push(copy.seconds(String(video.seconds)));
    return parts.join(' · ');
}

export function videoPhaseLabel(phase: RowVideo['phase'], copy: VideoCopy): string {
    return phase === 'estimate'
        ? copy.estimate
        : phase === 'charge'
          ? copy.charge
          : phase === 'settle_extra'
            ? copy.settleExtra
            : copy.settleRefund;
}

export function videoTaskLabel(video: RowVideo, copy: VideoCopy): string {
    return copy.states[video.task?.status ?? 'unknown'];
}

async function fetchTaskDisplay(endpoint: string, signal: AbortSignal): Promise<CustomerVideoTask> {
    const response = await fetch(endpoint, { cache: 'no-store', signal });
    if (!response.ok) throw new Error('Task lookup failed');
    const data = (await response.json()) as { task: CustomerVideoTask };
    return data.task;
}

function CopyValue({ label, value }: { label: string; value: string }) {
    const copy = useMessages(logsMessages);
    const [copied, setCopied] = useState(false);
    return (
        <span className="flex min-w-0 items-start gap-2">
            <span className="min-w-0 break-all font-mono">{value}</span>
            <button
                type="button"
                aria-label={copied ? copy.table.copied : copy.video.copyValue(label)}
                title={copied ? copy.table.copied : copy.video.copyValue(label)}
                className="-mt-1 flex size-7 shrink-0 items-center justify-center rounded-md text-portal-muted transition-colors hover:bg-portal-active hover:text-portal-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/30"
                onClick={async () => {
                    try {
                        await navigator.clipboard.writeText(value);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                    } catch {
                        // The full value remains selectable when clipboard access is unavailable.
                    }
                }}
            >
                {copied ? <Check size={14} aria-hidden="true" /> : <Clipboard size={14} aria-hidden="true" />}
            </button>
        </span>
    );
}

function DetailList({ items }: { items: Array<[string, ReactNode]> }) {
    return (
        <dl className="m-0 space-y-3 text-sm">
            {items.map(([label, value]) => (
                <div
                    key={label}
                    className="grid min-w-0 grid-cols-[6rem_minmax(0,1fr)] items-start gap-x-3 sm:grid-cols-[7rem_minmax(0,1fr)]"
                >
                    <dt className="text-portal-muted">{label}</dt>
                    <dd className="m-0 min-w-0 break-words text-portal-ink [overflow-wrap:anywhere]">{value}</dd>
                </div>
            ))}
        </dl>
    );
}

const money = (value: number) => formatSignedCny(value, { perCall: true });
const unitMoney = (value: number) => `¥${value.toLocaleString('en-US', { maximumFractionDigits: 6 })}`;

function VideoTaskPanel({ video }: { video: RowVideo }) {
    const copy = useMessages(logsMessages).video;
    const [task, setTask] = useState<CustomerVideoTask | undefined>(video.task);
    const [loading, setLoading] = useState(false);
    const [failed, setFailed] = useState(false);
    const [preview, setPreview] = useState(false);
    const [mediaFailed, setMediaFailed] = useState(false);
    const endpoint =
        video.taskId && /^task_[A-Za-z0-9]{32}$/.test(video.taskId)
            ? `/api/portal/video-tasks/${encodeURIComponent(video.taskId)}`
            : null;
    const needsProbe = video.task?.mediaAvailable && video.task.outputSeconds === null;
    useEffect(() => {
        if (!endpoint || !needsProbe) return;
        const controller = new AbortController();
        void fetchTaskDisplay(endpoint, AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]))
            .then((updated) => {
                if (controller.signal.aborted) return;
                setTask((current) =>
                    current?.outputSeconds != null
                        ? current
                        : { ...updated, request: { ...updated.request, ...current?.request } },
                );
            })
            .catch(() => {});
        return () => controller.abort();
    }, [endpoint, needsProbe]);
    const date = (seconds: number) => new Date(seconds * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const items: Array<[string, ReactNode]> = [[copy.taskState, copy.states[task?.status ?? 'unknown']]];
    if (task?.progress !== null && task?.progress !== undefined) items.push([copy.progress, `${task.progress}%`]);
    if (task?.submittedAt) items.push([copy.submittedAt, `${date(task.submittedAt)} (UTC+8)`]);
    if (task?.finishedAt) items.push([copy.finishedAt, `${date(task.finishedAt)} (UTC+8)`]);
    const elapsed = task ? task.elapsedSec : video.elapsedSec;
    if (elapsed != null) items.push([copy.taskElapsed, formatDuration(elapsed * 1000)]);
    if (task?.outputSeconds != null) items.push([copy.outputSeconds, copy.seconds(String(task.outputSeconds))]);
    if (task?.outputResolution) items.push([copy.outputResolution, task.outputResolution]);
    if (task?.outputRatio) items.push([copy.outputRatio, task.outputRatio]);
    const parameters = task?.request ?? {};
    const summary = Object.fromEntries(
        Object.entries({
            resolution: parameters.resolution,
            ratio: parameters.ratio,
            duration: parameters.duration,
            generate_audio: parameters.generateAudio,
            watermark: parameters.watermark,
            seed: parameters.seed,
            has_reference_video: parameters.hasVideo,
        }).filter(([, value]) => value !== undefined),
    );
    return (
        <div className="min-w-0 space-y-4 rounded-lg border border-portal-line bg-portal-panel p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h4 className="m-0 text-sm font-semibold text-portal-ink">{copy.taskState}</h4>
                {endpoint && (
                    <button
                        type="button"
                        disabled={loading}
                        className="min-h-10 rounded-md border border-portal-line px-3 text-xs text-portal-ink hover:bg-portal-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/30 disabled:opacity-50"
                        onClick={async () => {
                            setLoading(true);
                            setFailed(false);
                            try {
                                const updated = await fetchTaskDisplay(endpoint, AbortSignal.timeout(10_000));
                                setTask((current) => ({
                                    ...updated,
                                    request: { ...updated.request, ...current?.request },
                                }));
                                setMediaFailed(false);
                            } catch {
                                setFailed(true);
                            } finally {
                                setLoading(false);
                            }
                        }}
                    >
                        {loading ? copy.refreshing : copy.refreshTask}
                    </button>
                )}
            </div>
            <DetailList items={items} />
            <p className="m-0 text-xs leading-relaxed text-portal-muted">{copy.taskNote}</p>
            {failed && (
                <p role="alert" className="m-0 text-sm text-status-warning-text">
                    {copy.refreshFailed}
                </p>
            )}
            {!!Object.keys(summary).length && (
                <div className="min-w-0 space-y-2 border-t border-portal-line pt-4">
                    <h4 className="m-0 text-sm font-semibold text-portal-ink">{copy.requestSummary}</h4>
                    <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-portal-soft p-3 text-xs text-portal-ink">
                        {JSON.stringify(summary, null, 2)}
                    </pre>
                    <p className="m-0 text-xs leading-relaxed text-portal-muted">{copy.summaryNote}</p>
                </div>
            )}
            {task?.status === 'completed' && endpoint && (
                <div className="space-y-3 border-t border-portal-line pt-4">
                    {task.mediaAvailable ? (
                        <>
                            <div className="flex flex-wrap gap-3">
                                <button
                                    type="button"
                                    aria-expanded={preview}
                                    onClick={() => {
                                        setPreview(!preview);
                                        setMediaFailed(false);
                                    }}
                                    className="min-h-10 rounded-md border border-portal-line px-3 text-sm text-portal-ink hover:bg-portal-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/30"
                                >
                                    {copy.preview}
                                </button>
                                <a
                                    href={`${endpoint}/content?download=1`}
                                    className="inline-flex min-h-10 items-center rounded-md border border-portal-line px-3 text-sm text-portal-ink hover:bg-portal-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/30"
                                >
                                    {copy.download}
                                </a>
                            </div>
                            {preview && (
                                <video
                                    controls
                                    playsInline
                                    preload="none"
                                    aria-label={copy.preview}
                                    src={`${endpoint}/content`}
                                    className="max-h-[480px] w-full rounded-md bg-black"
                                    onError={() => setMediaFailed(true)}
                                    onLoadedMetadata={({ currentTarget }) => {
                                        const duration = currentTarget.duration;
                                        if (Number.isFinite(duration) && duration > 0 && duration <= 86400)
                                            setTask((current) =>
                                                current
                                                    ? { ...current, outputSeconds: Math.round(duration * 1000) / 1000 }
                                                    : current,
                                            );
                                    }}
                                />
                            )}
                            {mediaFailed && (
                                <p role="alert" className="m-0 text-sm text-status-warning-text">
                                    {copy.previewFailed}
                                </p>
                            )}
                        </>
                    ) : (
                        <p className="m-0 text-sm text-portal-muted">{copy.mediaUnavailable}</p>
                    )}
                </div>
            )}
        </div>
    );
}

/** Shared customer-facing presentation; billing and upstream routing remain in new-api. */
export function VideoBillingDetail({
    row,
}: {
    row: Pick<LogRow, 'model' | 'requestId' | 'tokenName' | 'costCny'> & { video?: LogRow['video'] };
}) {
    const copy = useMessages(logsMessages);
    const v = copy.video;
    const video = row.video;
    if (!video) return null;
    const settled =
        (video.phase === 'settle_extra' || video.phase === 'settle_refund') &&
        video.preConsumedCny !== null &&
        video.actualCny !== null;
    const total = settled ? video.actualCny! : row.costCny;
    const perSecond = video.billingUnit === 'seconds';
    const quantity = (perSecond ? video.seconds! : video.tokens).toLocaleString('en-US');
    const unit = perSecond ? video.unitCnyPerSecond : video.unitCnyPer1M;
    const taskItems: Array<[string, ReactNode]> = [
        [
            copy.table.colModel,
            <span key="model" className="font-mono">
                {row.model}
            </span>,
        ],
    ];
    if (video.taskId) taskItems.push([v.taskId, <CopyValue key="task" label={v.taskId} value={video.taskId} />]);
    if (row.requestId)
        taskItems.push([copy.table.colRequestId, <CopyValue key="request" label="Request ID" value={row.requestId} />]);
    if (row.tokenName) taskItems.push([copy.table.colKey, row.tokenName]);
    if (video.requestPath)
        taskItems.push([
            v.requestPath,
            <span key="path" className="font-mono">
                {video.requestPath}
            </span>,
        ]);

    const billingItems: Array<[string, ReactNode]> = [
        [v.billingMode, perSecond ? v.bySeconds : v.byTokens],
        [v.resolution, video.resolution ?? v.unknown],
        [v.reference, video.videoInput === 'video' ? v.withVideo : video.videoInput === 'none' ? v.noVideo : v.unknown],
    ];
    if (video.ratio) billingItems.push([perSecond ? v.requestedRatio : v.ratio, video.ratio]);
    billingItems.push([
        perSecond ? v.billedDuration : v.tokens,
        <span key="quantity" className="font-mono tabular-nums">
            {perSecond
                ? v.seconds(quantity)
                : video.phase === 'estimate'
                  ? v.estimatedTokens(quantity)
                  : v.actualTokens(quantity)}
        </span>,
    ]);
    if (unit !== null)
        billingItems.push([
            v.unitPrice,
            <span key="unit" className="font-mono tabular-nums">
                {perSecond ? v.perSecond(unitMoney(unit)) : v.perMillion(unitMoney(unit))}
            </span>,
        ]);

    return (
        <section aria-label={v.heading} className="min-w-0 space-y-4 py-1">
            <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-portal-line bg-portal-panel p-4 sm:p-5">
                <div className="min-w-0 space-y-2">
                    <h3 className="m-0 flex items-center gap-2 text-sm font-semibold text-portal-ink">
                        <Film size={17} className="text-portal-muted" aria-hidden="true" />
                        {v.heading}
                        <span className="whitespace-nowrap rounded-md bg-portal-soft px-2 py-1 text-xs font-medium text-portal-muted">
                            {videoPhaseLabel(video.phase, v)}
                        </span>
                    </h3>
                    <p className="m-0 text-sm text-portal-muted">
                        {videoSpec(video, v) || (perSecond ? v.bySeconds : v.byTokens)}
                    </p>
                </div>
                <div className="shrink-0 text-right">
                    <p className="m-0 text-xs text-portal-muted">
                        {settled ? v.totalCharge : video.phase === 'estimate' ? v.preCharge : v.chargeAmount}
                    </p>
                    <p className="m-0 mt-1 whitespace-nowrap font-mono text-xl font-semibold tabular-nums text-portal-ink">
                        {money(total)}
                    </p>
                    {settled && (
                        <p className="m-0 mt-1 text-xs text-portal-muted">
                            {v.recordCharge} · {videoPhaseLabel(video.phase, v)} {money(Math.abs(row.costCny))}
                        </p>
                    )}
                </div>
            </div>
            <div className="grid min-w-0 gap-4 lg:grid-cols-2">
                <div className="min-w-0 rounded-lg border border-portal-line bg-portal-panel p-4 sm:p-5">
                    <h4 className="m-0 mb-4 text-sm font-semibold text-portal-ink">{v.taskInfo}</h4>
                    <DetailList items={taskItems} />
                </div>
                <div className="min-w-0 rounded-lg border border-portal-line bg-portal-panel p-4 sm:p-5">
                    <h4 className="m-0 mb-4 text-sm font-semibold text-portal-ink">{v.billingInfo}</h4>
                    <DetailList items={billingItems} />
                    <div className="mt-4 rounded-md bg-portal-soft p-3">
                        <p className="m-0 mb-1 text-xs font-medium text-portal-muted">{v.formula}</p>
                        <p className="m-0 break-words font-mono text-sm leading-relaxed tabular-nums text-portal-ink [overflow-wrap:anywhere]">
                            {unit === null
                                ? v.priceUnavailable
                                : `${perSecond ? v.seconds(quantity) : quantity} × ${unitMoney(unit)}${perSecond ? '' : ' / 1,000,000'} = ${money(total)}`}
                        </p>
                    </div>
                </div>
            </div>
            <VideoTaskPanel video={video} />
            {settled && (
                <div className="rounded-lg border border-portal-line bg-portal-panel p-4 sm:p-5">
                    <h4 className="m-0 mb-4 text-sm font-semibold text-portal-ink">{v.settlement}</h4>
                    <dl className="m-0 grid gap-4 sm:grid-cols-3">
                        {[
                            [v.preCharge, video.preConsumedCny!],
                            [v.totalCharge, video.actualCny!],
                            [
                                video.phase === 'settle_refund' ? v.refunded : v.extraCharge,
                                Math.abs(video.actualCny! - video.preConsumedCny!),
                            ],
                        ].map(([label, amount]) => (
                            <div key={label} className="space-y-1">
                                <dt className="text-xs text-portal-muted">{label}</dt>
                                <dd className="m-0 font-mono text-base font-medium tabular-nums text-portal-ink">
                                    {money(Number(amount))}
                                </dd>
                            </div>
                        ))}
                    </dl>
                </div>
            )}
            <p className="m-0 text-xs leading-relaxed text-portal-muted">
                {video.phase === 'estimate' ? v.estimateNote : video.phase === 'charge' ? v.secondsNote : v.sameTask}
            </p>
        </section>
    );
}
