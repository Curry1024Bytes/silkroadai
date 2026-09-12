'use client';

import type { PricingPublishJob, PricingPublishJobStatus } from '@/lib/admin/pricing-publish-types';

export function pricingPublishJobLabel(status: PricingPublishJobStatus, en = false): string {
    const labels: Record<PricingPublishJobStatus, [string, string]> = {
        queued: ['待发布', 'Queued'],
        retry_wait: ['等待重试 · 待核验', 'Retry pending · unverified'],
        conflict: ['配置冲突 · 待处理', 'Configuration conflict'],
        failed: ['发布失败 · 待核验', 'Failed · unverified'],
        succeeded: ['已生效', 'Effective'],
        cancelled: ['已取消', 'Cancelled'],
    };
    return labels[status]?.[en ? 1 : 0] ?? (en ? 'Awaiting verification' : '待核验');
}

export async function requestPricingJobAction(
    id: string,
    action: 'retry' | 'cancel',
    en = false,
): Promise<PricingPublishJob> {
    const response = await fetch(`/api/admin/pricing/publish/${encodeURIComponent(id)}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
        throw new Error(
            typeof data.message === 'string'
                ? data.message
                : en
                  ? 'The task could not be updated. Refresh to verify its status.'
                  : '任务操作未完成，请刷新核对状态。',
        );
    if (!data.job?.id)
        throw new Error(en ? 'The task status is unconfirmed. Please refresh.' : '任务状态尚未确认，请刷新核对。');
    return data.job;
}

export function PricingPublishJobs({
    jobs,
    en,
    isDark,
    busyId,
    error,
    onAction,
}: {
    jobs: PricingPublishJob[];
    en: boolean;
    isDark: boolean;
    busyId: string | null;
    error: string;
    onAction: (job: PricingPublishJob, action: 'retry' | 'cancel') => void;
}) {
    const muted = isDark ? 'text-slate-400' : 'text-slate-500';
    const date = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    return (
        <section
            aria-label={en ? 'Price publication tasks' : '价格发布任务'}
            className={`mb-6 rounded-xl border p-4 ${isDark ? 'border-slate-700 bg-slate-800/70' : 'border-slate-200 bg-white'}`}
        >
            <h2 className="text-sm font-semibold">{en ? 'Price publication tasks' : '价格发布任务'}</h2>
            <p className={`mt-1 text-xs ${muted}`}>
                {en
                    ? 'Tasks are saved on the server and refresh automatically. Only Effective means both sides have been verified.'
                    : '任务保存在服务器，刷新页面不会丢失。状态自动更新；只有「已生效」表示两端已完成核验。'}
            </p>
            {error && (
                <p role="alert" className={`mt-3 text-sm ${isDark ? 'text-red-300' : 'text-red-700'}`}>
                    {error}
                </p>
            )}
            {jobs.length === 0 ? (
                <p className={`mt-4 text-sm ${muted}`}>{en ? 'No recent publication tasks.' : '暂无近期发布任务。'}</p>
            ) : (
                <div className="mt-4 space-y-3" aria-live="polite">
                    {jobs.map((job) => {
                        const finished = job.status === 'succeeded' || job.status === 'cancelled';
                        const successful = job.status === 'succeeded';
                        return (
                            <article
                                key={job.id}
                                className={`rounded-lg border p-3 ${isDark ? 'border-slate-700' : 'border-slate-200'}`}
                            >
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="break-all text-sm font-medium">{job.upstream_model}</span>
                                    <span
                                        className={`rounded-full px-2 py-1 text-xs font-medium ${successful ? (isDark ? 'bg-emerald-950 text-emerald-300' : 'bg-emerald-50 text-emerald-700') : isDark ? 'bg-slate-700 text-slate-200' : 'bg-slate-100 text-slate-700'}`}
                                    >
                                        {pricingPublishJobLabel(job.status, en)}
                                    </span>
                                </div>
                                <p className="mt-2 text-sm">{job.message}</p>
                                <p className={`mt-2 text-xs ${muted}`}>
                                    {en ? 'Updated ' : '更新于 '}
                                    {date(job.updated_at)} ·{' '}
                                    {en ? `Attempts: ${job.attempts}` : `已尝试 ${job.attempts} 次`}
                                </p>
                                {job.next_attempt_at && !finished && (
                                    <p className={`mt-1 text-xs ${muted}`}>
                                        {en ? 'Next check: ' : '下次核验：'}
                                        {date(job.next_attempt_at)}
                                    </p>
                                )}
                                {!finished && (
                                    <div className="mt-3 flex flex-wrap gap-3">
                                        {job.status !== 'queued' && (
                                            <button
                                                type="button"
                                                disabled={busyId !== null}
                                                onClick={() => onAction(job, 'retry')}
                                                className="text-sm font-medium text-emerald-600 hover:underline disabled:opacity-50"
                                            >
                                                {busyId === job.id
                                                    ? en
                                                        ? 'Processing…'
                                                        : '处理中…'
                                                    : en
                                                      ? 'Retry verification'
                                                      : '重新核验 / 重试'}
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            disabled={busyId !== null}
                                            onClick={() => onAction(job, 'cancel')}
                                            className={`text-sm hover:underline disabled:opacity-50 ${muted}`}
                                        >
                                            {en ? 'Request cancellation' : '申请取消'}
                                        </button>
                                    </div>
                                )}
                            </article>
                        );
                    })}
                </div>
            )}
            {jobs.some((job) => !['succeeded', 'cancelled'].includes(job.status)) && (
                <p className={`mt-3 text-xs ${muted}`}>
                    {en
                        ? 'Cancellation is allowed only before an upstream write, or when both sides still have the previous price. A rejected cancellation leaves the task active.'
                        : '只有尚未写入上游，或两端仍为旧价格时才能取消。取消被拒绝后，任务仍需继续核验。'}
                </p>
            )}
        </section>
    );
}
