/**
 * POST /api/portal/image/generate (PR-T1 Phase 3a)
 *
 * Customer-facing image gen entry. Forwards to new-api's customer
 * /v1/images/generations using the user's portal-internal system
 * token (PR-T1 Phase 0), then mirrors the resulting image bytes to
 * R2 and writes an `ImageGeneration` row.
 *
 * Flow:
 *   1. Cookie auth via getCurrentUser (W3 D3+)
 *   2. Rate limit (in-memory sliding window, 10/min/user)
 *   3. Validate { prompt, model, count, size } via zod
 *   4. Resolve portal system token (lazy provision if needed)
 *   5. Forward to https://ai.silkroadai.io/v1/images/generations
 *   6. Fetch each returned image URL → buffer (in parallel)
 *   7. Upload each buffer to R2 with deterministic key
 *   8. Insert ImageGeneration row
 *   9. Return { id, image_urls, cost_usd, quota_consumed }
 *
 * Failure modes (each maps to a clean status):
 *   - Auth missing               → 401
 *   - Rate limit                 → 429 with retry hint
 *   - Validation                 → 400
 *   - System token unavailable   → 503 (transient) / 500 (permanent)
 *   - Upstream 4xx (NSFW / 402)  → passthrough status + body
 *   - Upstream 5xx               → 502
 *   - R2 upload fail             → 500 + Sentry, NO row written
 *
 * Quota was already deducted by new-api before R2 upload begins. We
 * don't refund on R2 failure (operator decision in PR-T1 brief —
 * accept the lost-image risk for launch; revisit if R2 reliability
 * surfaces complaints).
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as Sentry from '@sentry/nextjs';
import { randomUUID } from 'crypto';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { getOrCreateSystemToken, PortalSystemTokenError } from '@/lib/newapi/system-token';
import { rateLimitCheck } from '@/lib/image-gen/rate-limit';
import { findImageModel, IMAGE_COUNT_MAX, IMAGE_COUNT_MIN, IMAGE_MODEL_IDS, IMAGE_SIZES } from '@/lib/image-gen/models';
import { imageKey, uploadImage, getPublicUrl } from '@/lib/r2/client';

export const runtime = 'nodejs';
/** Vercel-only deadline (self-hosted Node ignores). Bumped from 60→300
 *  in PR-T2 timeout fix (2026-05-09): post-launch smoke showed
 *  gpt-image-2 sub2api/Codex queue can park a request at 60s exactly
 *  (probed live, hit 60.3s on a tiny prompt) and Caddy's
 *  read_timeout=60s on the portal upstream surfaced as a 504 to the
 *  customer. New ceiling = 300s, paired with Caddy 300s + upstream
 *  AbortSignal 180s below. */
export const maxDuration = 300;

const PROMPT_MAX_CHARS = 1000;

const GenerateSchema = z.object({
    prompt: z.string().trim().min(1, 'prompt required').max(PROMPT_MAX_CHARS, `prompt > ${PROMPT_MAX_CHARS} chars`),
    model: z.enum(IMAGE_MODEL_IDS as [string, ...string[]]),
    count: z.number().int().min(IMAGE_COUNT_MIN).max(IMAGE_COUNT_MAX),
    size: z.enum(IMAGE_SIZES as unknown as [string, ...string[]]),
});

/** Day-30 cutoff for non-favorite generations. Cleanup cron uses this
 *  as the hard delete trigger (with `is_favorite=false`). */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const NEWAPI_PROXY_URL = process.env.NEWAPI_CUSTOMER_BASE_URL || 'https://ai.silkroadai.io';

interface UpstreamImageResponse {
    data?: Array<{ url?: string; b64_json?: string }>;
    error?: { message?: string; code?: string; type?: string };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
    const user = await getCurrentUser(req);
    if (!user) {
        return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }

    // Rate limit before any heavy work.
    const rl = rateLimitCheck(user.id);
    if (!rl.allowed) {
        return NextResponse.json(
            {
                error: 'rate_limit_exceeded',
                message: '1 分钟内最多 10 次,稍候再试',
                retry_after_ms: rl.retryAfterMs,
            },
            {
                status: 429,
                headers: { 'Retry-After': Math.ceil(rl.retryAfterMs / 1000).toString() },
            },
        );
    }

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input', message: 'body must be JSON' }, { status: 400 });
    }
    const parsed = GenerateSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const { prompt, model, count, size } = parsed.data;

    // Cost preview — server-side authoritative is new-api's deduct,
    // but we surface this for the row + UI so customers can see what
    // they're about to spend. Drift > 10% means the table needs a
    // refresh (PR-T1 Phase 3 brief).
    const modelInfo = findImageModel(model)!;
    const costUsdPreview = modelInfo.pricePerImageUsd * count;

    // Resolve the customer's portal-internal sk-… token. Lazy-provisions
    // on first use; failures map to a 503 so the customer can retry.
    let systemToken: string;
    try {
        systemToken = await getOrCreateSystemToken(user.id);
    } catch (err) {
        if (err instanceof PortalSystemTokenError) {
            const status = err.code === 'user_not_provisioned' ? 500 : 503;
            return NextResponse.json(
                {
                    error: err.code,
                    message:
                        err.code === 'user_not_provisioned'
                            ? '账户未完成 new-api 关联,联系客服 Global_Ads'
                            : '生图服务暂不可用,请稍后再试',
                },
                { status },
            );
        }
        console.error(`[image/generate] unexpected system-token error for ${user.id}:`, err);
        Sentry.captureException(err, { tags: { area: 'image-gen', user_id: user.id } });
        return NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }

    // Forward to new-api customer endpoint.
    const upstreamRes = await fetch(`${NEWAPI_PROXY_URL}/v1/images/generations`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${systemToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            prompt,
            n: count,
            size,
            response_format: 'url',
        }),
        // 180s — post-launch probe (2026-05-09) hit 60.3s on a tiny
        // gpt-image-2 prompt and 47.5s on a 380-char 1024×1792
        // generation. 60s was right at the edge; 180s gives headroom
        // for sub2api/Codex queue spikes without keeping the customer
        // hanging indefinitely on a genuinely stuck upstream.
        signal: AbortSignal.timeout(180_000),
    }).catch((err) => {
        console.error(`[image/generate] upstream fetch threw for ${user.id}:`, err);
        return null;
    });

    if (!upstreamRes) {
        return NextResponse.json({ error: 'upstream_unreachable' }, { status: 502 });
    }

    let upstreamBody: UpstreamImageResponse;
    try {
        upstreamBody = (await upstreamRes.json()) as UpstreamImageResponse;
    } catch (parseErr) {
        console.error(`[image/generate] upstream non-json body for ${user.id} (${upstreamRes.status}):`, parseErr);
        return NextResponse.json({ error: 'upstream_invalid_response' }, { status: 502 });
    }

    if (!upstreamRes.ok) {
        // Surface upstream error code where possible (gotcha: error.code
        // is more stable than HTTP status; see /docs section 08).
        const upstreamCode = upstreamBody.error?.code;
        const upstreamMessage = upstreamBody.error?.message ?? 'upstream error';
        // Friendly remap for the common 403 insufficient_user_quota case
        if (upstreamCode === 'insufficient_user_quota' || upstreamRes.status === 403) {
            return NextResponse.json(
                {
                    error: 'insufficient_user_quota',
                    message: '余额不足,请前往 /pay 充值',
                    upstream_status: upstreamRes.status,
                },
                { status: 402 },
            );
        }
        return NextResponse.json(
            {
                error: upstreamCode ?? 'upstream_error',
                message: upstreamMessage,
            },
            { status: upstreamRes.status >= 500 ? 502 : upstreamRes.status },
        );
    }

    const items = upstreamBody.data ?? [];
    if (items.length === 0) {
        return NextResponse.json({ error: 'upstream_empty_response' }, { status: 502 });
    }

    // Generation id we'll use both for R2 keying and the DB row PK.
    const generationId = randomUUID();

    // Fetch + upload in parallel. We accept either { url } (most models)
    // or { b64_json } (gpt-image-2 returns base64 even when we asked for
    // url) — handle both shapes.
    const uploads: Array<Promise<{ key: string; url: string }>> = items.map(async (item, i) => {
        let buf: Buffer;
        if (item.b64_json) {
            buf = Buffer.from(item.b64_json, 'base64');
        } else if (item.url) {
            // 60s (was 30s pre-PR-T2 504 fix): some Google `url` responses
            // serve via cold CDN edges that take 15-25s; bumping to 60s
            // preserves margin without keeping the route hanging on a
            // truly dead URL.
            const imgRes = await fetch(item.url, {
                signal: AbortSignal.timeout(60_000),
            });
            if (!imgRes.ok) {
                throw new Error(`fetch ${item.url} → ${imgRes.status}`);
            }
            const ab = await imgRes.arrayBuffer();
            buf = Buffer.from(ab);
        } else {
            throw new Error(`upstream item ${i}: neither url nor b64_json`);
        }
        const key = imageKey(user.id, generationId, i);
        await uploadImage(key, buf);
        return { key, url: getPublicUrl(key) };
    });

    let uploadResults: Array<{ key: string; url: string }>;
    try {
        uploadResults = await Promise.all(uploads);
    } catch (err) {
        console.error(`[image/generate] R2 upload failed for ${user.id} gen=${generationId}:`, err);
        Sentry.captureException(err, {
            tags: { area: 'image-gen', user_id: user.id, generation_id: generationId },
        });
        return NextResponse.json(
            {
                error: 'r2_upload_failed',
                message: '图片已生成但保存失败,请重试。已扣额度无法自动退款,请联系客服',
            },
            { status: 500 },
        );
    }

    // Persist the row. expires_at = now + 30 days; the cleanup cron
    // honors this. Favorite toggle later flips expires_at to null.
    const now = new Date();
    const created = await prisma.imageGeneration.create({
        data: {
            id: generationId,
            user_id: user.id,
            prompt,
            model_name: model,
            size,
            count,
            r2_keys: uploadResults.map((u) => u.key),
            cost_usd: costUsdPreview.toFixed(6),
            // new-api charged this many raw quota units; we don't have
            // the exact number from the response (it's logged in
            // /api/log/), so we record the preview converted at QPU=1M.
            quota_consumed: BigInt(Math.round(costUsdPreview * 1_000_000)),
            is_favorite: false,
            is_deleted: false,
            created_at: now,
            expires_at: new Date(now.getTime() + RETENTION_MS),
        },
        select: { id: true, created_at: true, expires_at: true },
    });

    return NextResponse.json({
        id: created.id,
        image_urls: uploadResults.map((u) => u.url),
        cost_usd: costUsdPreview,
        quota_consumed: Math.round(costUsdPreview * 1_000_000),
        created_at: created.created_at.toISOString(),
        expires_at: created.expires_at?.toISOString() ?? null,
        rate_limit_remaining: rl.remaining,
    });
}
