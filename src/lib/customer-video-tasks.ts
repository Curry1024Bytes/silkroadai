import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { getSdVideoDeliveryPool } from '@/lib/sd-special-video-delivery';
import { sdSpecialPublicModelForSku } from '@/lib/sd-special-video';
import { probeVideoMeta } from '@/lib/enterprise/video-probe';
import { safeVideoRequestSummary, type CustomerVideoTask, type VideoTaskStatus } from '@/lib/video-task-display';

const taskIdPattern = /^task_[A-Za-z0-9]{32}$/;
const mediaOrigins = new Set([
    'https://oss.aigasapi.com',
    'https://v5-octo-download.jianying.com',
    'https://v11-octo-download.jianying.com',
    'https://v26-octo-download.jianying.com',
    'https://ark-acg-cn-beijing.tos-cn-beijing.volces.com',
    'https://2129163741-amk-2123777871-default-963137.vod.cn-north-1.volcvideo.com',
    'https://2133400172-amk-2103989665-default-531064.vod.cn-north-1.volcvideo.com',
]);
const statuses: Record<string, VideoTaskStatus> = {
    NOT_START: 'queued',
    SUBMITTED: 'queued',
    QUEUED: 'queued',
    IN_PROGRESS: 'in_progress',
    SUCCESS: 'completed',
    FAILURE: 'failed',
};
const privateHeaders = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' };

type TaskRow = {
    task_id: string;
    owner_id: number;
    model: string;
    status: string;
    progress: string | null;
    submit_time: number;
    finish_time: number;
    output_seconds: unknown;
    output_resolution: unknown;
    output_ratio: unknown;
    request_summary: unknown;
    media_url: string | null;
    result_url: string | null;
};

export type ReadCustomerVideoTask = { model: string; display: CustomerVideoTask; mediaUrl: URL | null };

function mediaUrl(raw: string | null, taskId: string): URL | null {
    if (!raw || !taskIdPattern.test(taskId)) return null;
    try {
        const url = new URL(raw);
        if (url.username || url.password || url.hash || url.pathname === '/') return null;
        if (mediaOrigins.has(url.origin)) return url;
        const base = new URL(process.env.NEWAPI_BASE_URL || 'http://127.0.0.1:3000');
        if (
            ['http:', 'https:'].includes(base.protocol) &&
            [base.origin, 'http://localhost:3000', 'http://127.0.0.1:3000'].includes(url.origin) &&
            url.pathname === `/video-cache/${taskId}.mp4` &&
            !url.search
        )
            return new URL(url.pathname, base.origin);
    } catch {
        return null;
    }
    return null;
}

function timestamp(value: number): number | null {
    return Number.isSafeInteger(value) && value > 0 && value <= 253402300799 ? value : null;
}

export async function readCustomerVideoTasks(ownerId: number, taskIds: string[]) {
    const result = new Map<string, ReadCustomerVideoTask>();
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) return result;
    const ids = [...new Set(taskIds.filter((id) => taskIdPattern.test(id)))];
    const pool = getSdVideoDeliveryPool();
    if (!pool || !ids.length) return result;
    for (let offset = 0; offset < ids.length; offset += 500) {
        const batch = ids.slice(offset, offset + 500);
        const expected = new Set(batch);
        const seen = new Set<string>();
        const { rows } = await pool.query<TaskRow>(
            `SELECT task_id, owner_id::float8, model, status, progress, submit_time::float8, finish_time::float8,
                    output_seconds, output_resolution, output_ratio, request_summary, media_url, result_url
             FROM portal_sd_video.customer_tasks
             WHERE owner_id = $1 AND task_id = ANY($2::text[])`,
            [ownerId, batch],
        );
        for (const row of rows) {
            if (row.owner_id !== ownerId || !expected.has(row.task_id)) continue;
            if (seen.has(row.task_id)) {
                result.delete(row.task_id);
                continue;
            }
            seen.add(row.task_id);
            if (!row.model) continue;
            const status = Object.hasOwn(statuses, row.status) ? statuses[row.status] : 'unknown';
            const terminal = status === 'completed' || status === 'failed';
            const submittedAt = timestamp(row.submit_time);
            const finish = timestamp(row.finish_time);
            const finishedAt =
                terminal && finish !== null && (submittedAt === null || finish >= submittedAt) ? finish : null;
            const seconds = Number(row.output_seconds);
            const output = safeVideoRequestSummary({ resolution: row.output_resolution, ratio: row.output_ratio });
            const progress =
                typeof row.progress === 'string' && /^\d{1,3}%?$/.test(row.progress)
                    ? Math.min(100, Number.parseInt(row.progress, 10))
                    : null;
            const url =
                status === 'completed'
                    ? (mediaUrl(row.result_url, row.task_id) ?? mediaUrl(row.media_url, row.task_id))
                    : null;
            result.set(row.task_id, {
                model: sdSpecialPublicModelForSku(row.model) ?? row.model,
                display: {
                    status,
                    progress,
                    submittedAt,
                    finishedAt,
                    elapsedSec: finishedAt !== null && submittedAt !== null ? finishedAt - submittedAt : null,
                    outputSeconds:
                        status === 'completed' && Number.isFinite(seconds) && seconds > 0 && seconds <= 86400
                            ? seconds
                            : null,
                    outputResolution: status === 'completed' ? (output.resolution ?? null) : null,
                    outputRatio: status === 'completed' && output.ratio !== 'adaptive' ? (output.ratio ?? null) : null,
                    request: safeVideoRequestSummary(row.request_summary),
                    mediaAvailable: url !== null,
                },
                mediaUrl: url,
            });
        }
    }
    return result;
}

export async function customerVideoDisplay(task: ReadCustomerVideoTask): Promise<CustomerVideoTask> {
    if (!task.mediaUrl || task.display.outputSeconds != null) return task.display;
    const metadata = await probeVideoMeta(task.mediaUrl.href, { redirect: 'error', mp4Only: true });
    const duration = metadata?.durationSec;
    return duration != null && Number.isFinite(duration) && duration <= 86400
        ? { ...task.display, outputSeconds: Math.round(duration * 1000) / 1000 }
        : task.display;
}

export async function streamCustomerVideo(req: NextRequest, task: ReadCustomerVideoTask, taskId: string) {
    if (task.display.status !== 'completed')
        return NextResponse.json({ error: 'video_not_completed' }, { status: 409, headers: privateHeaders });
    if (!task.mediaUrl)
        return NextResponse.json({ error: 'video_unavailable' }, { status: 410, headers: privateHeaders });
    try {
        const headers = new Headers();
        for (const name of ['range', 'if-range']) {
            const value = req.headers.get(name);
            if (value) headers.set(name, value);
        }
        const response = await fetch(task.mediaUrl, {
            method: req.method,
            headers,
            redirect: 'error',
            cache: 'no-store',
            signal: AbortSignal.any([req.signal, AbortSignal.timeout(60_000)]),
        });
        const output = new Headers(privateHeaders);
        if (response.status === 416) {
            const range = response.headers.get('content-range');
            if (range) output.set('content-range', range);
            await response.body?.cancel();
            return new NextResponse(null, { status: 416, headers: output });
        }
        if (
            ![200, 206].includes(response.status) ||
            response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'video/mp4'
        ) {
            await response.body?.cancel();
            return NextResponse.json({ error: 'video_unavailable' }, { status: 410, headers: privateHeaders });
        }
        for (const name of [
            'content-type',
            'content-length',
            'content-range',
            'accept-ranges',
            'etag',
            'last-modified',
        ]) {
            if (name === 'content-length' && response.headers.has('content-encoding')) continue;
            const value = response.headers.get(name);
            if (value) output.set(name, value);
        }
        output.set(
            'content-disposition',
            `${req.nextUrl.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename="${taskId}.mp4"`,
        );
        return new NextResponse(req.method === 'HEAD' ? null : response.body, {
            status: response.status,
            headers: output,
        });
    } catch {
        return NextResponse.json({ error: 'video_unavailable' }, { status: 502, headers: privateHeaders });
    }
}
