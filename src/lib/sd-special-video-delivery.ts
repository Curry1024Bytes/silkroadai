import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';
import { z } from 'zod';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import { prisma } from '@/lib/db';
import { getTokenRevocationCustomerIdentity, getVideoDeliveryTokenForCustomer } from '@/lib/newapi/client';
import { CUSTOMER_API_BASE_URL } from '@/lib/public-config';
import { SD_SPECIAL_GROUP, sdSpecialPublicModelForSku } from '@/lib/sd-special-video';

const videoPath = /^\/videos\/(task_[A-Za-z0-9]{32})(\/content)?$/;
const taskSchema = z.object({
    sku: z.string(),
    status: z.enum(['NOT_START', 'SUBMITTED', 'QUEUED', 'IN_PROGRESS', 'SUCCESS', 'FAILURE']),
    progress: z.string().nullable(),
    submit_time: z.number().int().nonnegative(),
    finish_time: z.number().int().nonnegative(),
    media_url: z.string().nullable(),
});
const statuses = {
    NOT_START: 'queued',
    SUBMITTED: 'queued',
    QUEUED: 'queued',
    IN_PROGRESS: 'in_progress',
    SUCCESS: 'completed',
    FAILURE: 'failed',
} as const;
const mediaOrigins = new Set(['https://oss.aigasapi.com', 'https://v26-octo-download.jianying.com']);
const fileHeaders = ['accept-ranges', 'content-range', 'content-type', 'etag', 'last-modified'];
const privateHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
let reader: Pool | undefined;

function readPool(): Pool | null {
    const connectionString = process.env.NEWAPI_SD_VIDEO_DELIVERY_DATABASE_URL;
    if (!connectionString) return null;
    reader ??= new Pool({
        connectionString,
        max: 3,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 30_000,
        statement_timeout: 2000,
    });
    return reader;
}

function errorResponse(status: number, code: string, message: string): NextResponse {
    return NextResponse.json(
        { error: { code, message, type: status >= 500 ? 'server_error' : 'invalid_request_error' } },
        { status, headers: privateHeaders },
    );
}

async function exhaustedKeyOwner(key: string): Promise<number | null> {
    const local = await prisma.newApiToken.findUnique({
        where: { newapi_token_value: key },
        select: {
            status: true,
            tier: true,
            newapi_token_id: true,
            user: { select: { tenant_id: true, status: true, newapi_user_id: true, newapi_access_token: true } },
        },
    });
    if (
        !local ||
        local.status !== 'active' ||
        local.user.status !== 'active' ||
        local.user.tenant_id !== PLATFORM_TENANT_ID ||
        local.user.newapi_user_id === null ||
        !local.user.newapi_access_token
    )
        return null;

    const group = await prisma.channelGroup.findFirst({
        where: { tenant_id: PLATFORM_TENANT_ID, enabled: true, key: local.tier, newapi_group: SD_SPECIAL_GROUP },
        select: { key: true },
    });
    if (!group) return null;

    const auth = { accessToken: local.user.newapi_access_token, userId: local.user.newapi_user_id };
    const [owner, token] = await Promise.all([
        getTokenRevocationCustomerIdentity(auth),
        getVideoDeliveryTokenForCustomer(auth, local.newapi_token_id),
    ]);
    if (
        owner.id !== auth.userId ||
        owner.status !== 1 ||
        token.user_id !== auth.userId ||
        token.id !== local.newapi_token_id ||
        token.group !== SD_SPECIAL_GROUP ||
        (token.status !== 1 && token.status !== 4) || // Enabled with zero quota, or recorded as exhausted.
        token.unlimited_quota ||
        token.remain_quota > 0 ||
        (token.expired_time !== -1 && token.expired_time <= Math.floor(Date.now() / 1000)) ||
        token.allow_ips?.trim() // Keep IP-restricted keys on native authorization.
    )
        return null;
    return owner.id;
}

function aigasMediaUrl(raw: string | null): URL | null {
    if (!raw) return null;
    try {
        const url = new URL(raw);
        return mediaOrigins.has(url.origin) && !url.username && !url.password && url.pathname !== '/' ? url : null;
    } catch {
        return null;
    }
}

async function downloadVideo(req: NextRequest, task: z.infer<typeof taskSchema>): Promise<NextResponse> {
    if (task.status !== 'SUCCESS') return errorResponse(400, 'video_not_completed', 'Video is not completed.');
    const url = aigasMediaUrl(task.media_url);
    if (!url) return errorResponse(502, 'video_unavailable', 'Video file is unavailable.');

    try {
        const headers = new Headers();
        for (const name of ['range', 'if-range']) {
            const value = req.headers.get(name);
            if (value) headers.set(name, value);
        }
        const response = await fetch(url, {
            method: req.method,
            headers,
            cache: 'no-store',
            redirect: 'error',
            signal: AbortSignal.timeout(60_000),
        });
        const output = new Headers(privateHeaders);
        if (response.status === 416) {
            const range = response.headers.get('content-range');
            if (range) output.set('content-range', range);
            void response.body?.cancel().catch(() => {});
            return new NextResponse(null, { status: 416, headers: output });
        }
        const mediaType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        if (![200, 206].includes(response.status) || mediaType !== 'video/mp4') {
            void response.body?.cancel().catch(() => {});
            return errorResponse(502, 'video_unavailable', 'Video file is unavailable.');
        }
        for (const name of fileHeaders) {
            const value = response.headers.get(name);
            if (value) output.set(name, value);
        }
        return new NextResponse(req.method === 'HEAD' ? null : response.body, {
            status: response.status,
            headers: output,
        });
    } catch {
        return errorResponse(502, 'video_unavailable', 'Video file is unavailable.');
    }
}

/** Called only after the normal new-api read was rejected. Null keeps the original response. */
export async function deliverExhaustedSdVideo(req: NextRequest, path: string): Promise<NextResponse | null> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return null;
    const match = videoPath.exec(path);
    const key = req.headers.get('authorization')?.match(/^Bearer\s+(?:sk-)?([a-z\d]+)$/i)?.[1];
    if (!match || !key) return null;
    const pool = readPool();
    if (!pool) return null;

    let owner: number | null;
    try {
        owner = await exhaustedKeyOwner(key);
    } catch {
        return null;
    }
    if (owner === null) return null;
    const [, id, content] = match;
    try {
        const { rows } = await pool.query(
            `SELECT sku, status, progress, submit_time::float8, finish_time::float8, media_url
             FROM portal_sd_video.delivery_tasks WHERE owner_id = $1 AND task_id = $2 LIMIT 2`,
            [owner, id],
        );
        if (rows.length !== 1) return errorResponse(404, 'video_not_found', 'Video task not found.');
        const task = taskSchema.parse(rows[0]);
        const model = sdSpecialPublicModelForSku(task.sku);
        if (!model) return errorResponse(404, 'video_not_found', 'Video task not found.');
        if (content) return downloadVideo(req, task);
        const progress = Number.parseInt(task.progress ?? '', 10);
        return NextResponse.json(
            {
                id,
                object: 'video',
                model,
                status: statuses[task.status],
                progress: Number.isFinite(progress) ? Math.min(Math.max(progress, 0), 100) : 0,
                created_at: task.submit_time,
                ...(task.finish_time ? { completed_at: task.finish_time } : {}),
                ...(task.status === 'SUCCESS'
                    ? { metadata: { url: `${CUSTOMER_API_BASE_URL}/v1/videos/${id}/content` } }
                    : {}),
                ...(task.status === 'FAILURE'
                    ? { error: { code: 'video_generation_failed', message: 'Video generation failed.' } }
                    : {}),
            },
            { headers: privateHeaders },
        );
    } catch {
        return errorResponse(503, 'video_lookup_unavailable', 'Video status is temporarily unavailable.');
    }
}
