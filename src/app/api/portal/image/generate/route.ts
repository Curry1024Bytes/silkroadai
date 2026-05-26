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
import {
    findImageModel,
    IMAGE_COUNT_MAX,
    IMAGE_COUNT_MIN,
    IMAGE_MODEL_IDS,
    IMAGE_SIZES,
} from '@/lib/image-gen/models';
import { extractB64Images } from '@/lib/image-gen/extract-b64';
import { imageKey, uploadImage, getPublicUrl } from '@/lib/r2/client';
import { record as recordAnalytics } from '@/lib/analytics/recorder';

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

const UPSTREAM_TIMEOUT_MS = 180_000;
const URL_FETCH_TIMEOUT_MS = 60_000;

interface ImagesGenerationsResponse {
    data?: Array<{ url?: string; b64_json?: string }>;
    error?: { message?: string; code?: string; type?: string };
}

interface ChatCompletionsResponse {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string; code?: string; type?: string };
}

/** Upstream returned a non-2xx with a typed error body (insufficient_user_quota,
 *  convert_request_failed, content_filter, etc). The route handler maps to
 *  402 / status passthrough / 502 depending on `code` and `status`. */
class UpstreamError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string | undefined,
        message: string,
    ) {
        super(message);
        this.name = 'UpstreamError';
    }
}

/** fetch() itself threw (network down, AbortSignal fired, DNS fail, etc.).
 *  Always surfaces as 502 to the customer with a generic upstream-unreachable
 *  message; the actual `err` is logged server-side for diagnosis. */
class TransportError extends Error {
    constructor(public readonly code: string = 'upstream_unreachable') {
        super(code);
        this.name = 'TransportError';
    }
}

/** Upstream returned 2xx but the payload had no images (empty data[] for
 *  images/generations, no markdown b64 matches for chat/completions). Most
 *  often a Google safety filter rejection — surface 502 with a friendly
 *  "try a different prompt" message. */
class EmptyResponseError extends Error {
    constructor() {
        super('upstream_empty_response');
        this.name = 'EmptyResponseError';
    }
}

/** Upstream content-policy / safety-filter rejection. Distinct from a
 *  generic UpstreamError so the route handler can surface a friendly
 *  modal ("调整 prompt") rather than a raw 502. Detected via:
 *    - error.code matching content_policy_violation / moderation_blocked /
 *      safety_filter_triggered / content_filter
 *    - message containing NSFW / violation / unsafe / blocked / safety
 *  Quota usually NOT charged when this fires — surface that to the
 *  customer. */
class ContentFilterError extends Error {
    constructor(public readonly upstreamCode?: string) {
        super('content_filter');
        this.name = 'ContentFilterError';
    }
}

/** Heuristic: is this UpstreamError actually a content-policy rejection?
 *  Detection is best-effort across providers (OpenAI / Google / sub2api
 *  rewrap). Bias toward false-positive rather than miss — the worst case
 *  of a false positive is "调整 prompt" instead of a generic 502, which
 *  is still a kinder message. */
const CONTENT_FILTER_CODES = new Set([
    'content_policy_violation',
    'moderation_blocked',
    'safety_filter_triggered',
    'content_filter',
    'image_safety_violations',
]);
const CONTENT_FILTER_MESSAGE_RE =
    /\b(nsfw|safety[ _-]?filter|content[ _-]?(policy|filter)|moderation|violat|unsafe|blocked|disallow)\b/i;

function isContentFilter(err: UpstreamError): boolean {
    if (err.code && CONTENT_FILTER_CODES.has(err.code)) return true;
    if (err.message && CONTENT_FILTER_MESSAGE_RE.test(err.message)) return true;
    return false;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
    const user = await getCurrentUser(req);
    if (!user) {
        return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }
    const startedAt = Date.now();

    // Rate limit before any heavy work.
    const rl = rateLimitCheck(user.id);
    if (!rl.allowed) {
        console.log(`[image-generate] rate_limited user=${user.id} retry_after_ms=${rl.retryAfterMs}`);
        await recordAnalytics({
            userId: user.id,
            eventType: 'image_rate_limited',
            properties: { retry_after_ms: rl.retryAfterMs },
        });
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
        const latencyMs = Date.now() - startedAt;
        if (err instanceof PortalSystemTokenError) {
            const status = err.code === 'user_not_provisioned' ? 500 : 503;
            console.log(`[image-generate-fail] system_token user=${user.id} code=${err.code} latency_ms=${latencyMs}`);
            await recordAnalytics({
                userId: user.id,
                eventType: 'image_generate_failed',
                properties: { model, count, size, code: err.code, latency_ms: latencyMs },
            });
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
        console.error(`[image-generate-fail] system_token user=${user.id} latency_ms=${latencyMs}:`, err);
        Sentry.captureException(err, { tags: { area: 'image-gen', user_id: user.id } });
        return NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }

    // PR-T2 v2 fix (2026-05-09): branch upstream by model. Gemini-class
    // image SKUs (Nano Banana / 3.1-flash-image / 3-pro-image) reject
    // /v1/images/generations with `convert_request_failed: only imagen
    // models are supported`; they must be called via /v1/chat/completions
    // and the image extracted from a markdown `data:image/...;base64,…`
    // payload in `choices[0].message.content`. Imagen + gpt-image-2 use
    // the OpenAI-shaped /v1/images/generations as before.
    let imageBuffers: Buffer[];
    try {
        imageBuffers = await fetchImagesFromUpstream({
            model,
            prompt,
            count,
            size,
            systemToken,
            userId: user.id,
        });
    } catch (err) {
        const latencyMs = Date.now() - startedAt;
        // Promote upstream errors that look like content-policy hits.
        // Quota is typically NOT charged when this fires; surfaces as a
        // friendly "调整 prompt" modal client-side (PR-T3 Item 3).
        if (err instanceof UpstreamError && isContentFilter(err)) {
            err = new ContentFilterError(err.code);
        }
        // EmptyResponseError on chat/completions = Gemini safety filter
        // (200 with empty content). Same UX as ContentFilterError.
        if (err instanceof EmptyResponseError) {
            err = new ContentFilterError('upstream_empty_response');
        }

        if (err instanceof ContentFilterError) {
            console.log(
                `[image-generate] content_filter user=${user.id} model=${model} upstream_code=${err.upstreamCode ?? 'none'} latency_ms=${latencyMs}`,
            );
            await recordAnalytics({
                userId: user.id,
                eventType: 'image_content_filter',
                properties: { model, count, size, upstream_code: err.upstreamCode ?? null, latency_ms: latencyMs },
            });
            return NextResponse.json(
                {
                    error: 'content_filter',
                    message: '您的提示词触发了内容审核,本次生成已取消',
                    quota_charged: false,
                },
                { status: 400 },
            );
        }
        if (err instanceof UpstreamError) {
            // Friendly remap for the common 403 insufficient_user_quota case
            if (err.code === 'insufficient_user_quota' || err.status === 403) {
                console.log(
                    `[image-generate] balance_shortfall user=${user.id} model=${model} latency_ms=${latencyMs}`,
                );
                await recordAnalytics({
                    userId: user.id,
                    eventType: 'image_balance_shortfall',
                    properties: { model, count, size, latency_ms: latencyMs },
                });
                return NextResponse.json(
                    {
                        error: 'insufficient_user_quota',
                        message: '余额不足,请前往 /pay 充值',
                        upstream_status: err.status,
                    },
                    { status: 402 },
                );
            }
            console.log(
                `[image-generate-fail] user=${user.id} model=${model} upstream_status=${err.status} upstream_code=${err.code ?? 'none'} latency_ms=${latencyMs}`,
            );
            await recordAnalytics({
                userId: user.id,
                eventType: 'image_generate_failed',
                properties: { model, count, size, status: err.status, code: err.code ?? null, latency_ms: latencyMs },
            });
            return NextResponse.json(
                { error: err.code ?? 'upstream_error', message: err.message },
                { status: err.status >= 500 ? 502 : err.status },
            );
        }
        if (err instanceof TransportError) {
            console.error(
                `[image-generate-fail] transport_error user=${user.id} model=${model} latency_ms=${latencyMs}:`,
                err,
            );
            await recordAnalytics({
                userId: user.id,
                eventType: 'image_generate_failed',
                properties: { model, count, size, code: 'transport_error', latency_ms: latencyMs },
            });
            return NextResponse.json({ error: err.code }, { status: 502 });
        }
        // Unknown error class — bubble to 500
        console.error(`[image-generate-fail] unexpected user=${user.id} latency_ms=${latencyMs}:`, err);
        Sentry.captureException(err, { tags: { area: 'image-gen', user_id: user.id } });
        await recordAnalytics({
            userId: user.id,
            eventType: 'image_generate_failed',
            properties: { model, count, size, code: 'internal_error', latency_ms: latencyMs },
        });
        return NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }

    // Generation id we'll use both for R2 keying and the DB row PK.
    const generationId = randomUUID();

    const uploads: Array<Promise<{ key: string; url: string }>> = imageBuffers.map(async (buf, i) => {
        const key = imageKey(user.id, generationId, i);
        await uploadImage(key, buf);
        return { key, url: getPublicUrl(key) };
    });

    let uploadResults: Array<{ key: string; url: string }>;
    try {
        uploadResults = await Promise.all(uploads);
    } catch (err) {
        const latencyMs = Date.now() - startedAt;
        console.error(
            `[image-generate-fail] r2_upload_failed user=${user.id} gen=${generationId} latency_ms=${latencyMs}:`,
            err,
        );
        Sentry.captureException(err, {
            tags: { area: 'image-gen', user_id: user.id, generation_id: generationId },
        });
        await recordAnalytics({
            userId: user.id,
            eventType: 'image_generate_failed',
            properties: { model, count, size, code: 'r2_upload_failed', latency_ms: latencyMs },
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

    const totalLatencyMs = Date.now() - startedAt;
    console.log(
        `[image-generate] ok user=${user.id} model=${model} count=${count} size=${size} cost_usd=${costUsdPreview.toFixed(4)} latency_ms=${totalLatencyMs}`,
    );
    await recordAnalytics({
        userId: user.id,
        eventType: 'image_generated',
        properties: {
            generation_id: created.id,
            model,
            count,
            size,
            cost_usd: costUsdPreview,
            latency_ms: totalLatencyMs,
        },
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

// ──────────────────────────────────────────────────────────────────────
// Upstream fetch helpers — W8 D7(2026-05-26)重构:smart auto-fallback,
// 不再按 model.apiPath 分类。先试 /v1/chat/completions(多模态 chat 路径,
// 大多数现代图像模型走这里:Gemini Nano Banana / GPT image-2 / 等),
// 失败时如果是"wrong-endpoint" signal(`convert_request_failed` /
// "only imagen models" 等)就 fallback 到老的 /v1/images/generations
// (Imagen 系还走这条)。其它错误(quota / safety filter / 网络)直接
// 上抛,不 fallback。
// ──────────────────────────────────────────────────────────────────────

interface FetchArgs {
    model: string;
    prompt: string;
    count: number;
    size: string;
    systemToken: string;
    userId: string;
}

/**
 * Specific upstream error patterns that signal "this endpoint doesn't
 * support this model". When we see these on /v1/chat/completions, fall
 * back to /v1/images/generations.
 *
 * Known cases:
 *   - Imagen via chat/completions → `{"code":"convert_request_failed",
 *     "message":"not supported model for image generation, only imagen
 *     models are supported"}` (Google saying "wrong endpoint")
 */
function isWrongEndpointSignal(err: unknown): boolean {
    if (!(err instanceof UpstreamError)) return false;
    if (err.code === 'convert_request_failed') return true;
    if (err.message && /not supported|only imagen/i.test(err.message)) return true;
    return false;
}

/** Top-level dispatch with auto-fallback. Returns raw image buffers. */
async function fetchImagesFromUpstream(args: FetchArgs): Promise<Buffer[]> {
    // Default: try /v1/chat/completions first (modern multimodal path)
    try {
        return await fetchViaChatCompletions(args);
    } catch (err) {
        if (!isWrongEndpointSignal(err)) throw err;
        // Wrong-endpoint signal → fall back to legacy /v1/images/generations
        // (Imagen 系列等)
    }
    return fetchViaImagesGenerations(args);
}

/** OpenAI-style /v1/images/generations: single request with `n=count`,
 *  response shape `{ data: [{ b64_json | url }] }`. Used for gpt-image-2
 *  and Imagen models. */
async function fetchViaImagesGenerations(args: FetchArgs): Promise<Buffer[]> {
    const upstreamRes = await fetch(`${NEWAPI_PROXY_URL}/v1/images/generations`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${args.systemToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: args.model,
            prompt: args.prompt,
            n: args.count,
            size: args.size,
            response_format: 'url',
        }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    }).catch((err) => {
        throw new TransportError(err instanceof Error ? err.message : 'unknown');
    });

    let body: ImagesGenerationsResponse;
    try {
        body = (await upstreamRes.json()) as ImagesGenerationsResponse;
    } catch {
        throw new UpstreamError(upstreamRes.status, 'upstream_invalid_response', 'non-JSON upstream body');
    }

    if (!upstreamRes.ok) {
        throw new UpstreamError(
            upstreamRes.status,
            body.error?.code,
            body.error?.message ?? `upstream error ${upstreamRes.status}`,
        );
    }

    const items = body.data ?? [];
    if (items.length === 0) throw new EmptyResponseError();

    return Promise.all(
        items.map(async (item, i) => {
            if (item.b64_json) {
                return Buffer.from(item.b64_json, 'base64');
            }
            if (item.url) {
                const imgRes = await fetch(item.url, {
                    signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
                });
                if (!imgRes.ok) {
                    throw new Error(`fetch ${item.url} → ${imgRes.status}`);
                }
                return Buffer.from(await imgRes.arrayBuffer());
            }
            throw new Error(`upstream item ${i}: neither url nor b64_json`);
        }),
    );
}

/** Gemini-style /v1/chat/completions: response is markdown text with
 *  `data:image/...;base64,...` payloads inline. We make `count` parallel
 *  requests (the chat shape doesn't accept `n` like images/generations
 *  does, and Gemini consistently returns one image per response). Returns
 *  the union of decoded images across all parallel calls.
 *
 *  Empty across all calls → EmptyResponseError (most often Google
 *  safety-filter rejection, surfaced as 502 with friendly message). */
async function fetchViaChatCompletions(args: FetchArgs): Promise<Buffer[]> {
    const single = async (): Promise<Buffer[]> => {
        const upstreamRes = await fetch(`${NEWAPI_PROXY_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${args.systemToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: args.model,
                messages: [{ role: 'user', content: args.prompt }],
            }),
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        }).catch((err) => {
            throw new TransportError(err instanceof Error ? err.message : 'unknown');
        });

        let body: ChatCompletionsResponse;
        try {
            body = (await upstreamRes.json()) as ChatCompletionsResponse;
        } catch {
            throw new UpstreamError(upstreamRes.status, 'upstream_invalid_response', 'non-JSON upstream body');
        }

        if (!upstreamRes.ok) {
            throw new UpstreamError(
                upstreamRes.status,
                body.error?.code,
                body.error?.message ?? `upstream error ${upstreamRes.status}`,
            );
        }

        const content = body.choices?.[0]?.message?.content ?? '';
        const decoded = extractB64Images(content);
        return decoded.map((d) => d.buffer);
    };

    // Parallel `count` requests; concat results.
    const batches = await Promise.all(Array.from({ length: args.count }, () => single()));
    const all = batches.flat();
    if (all.length === 0) throw new EmptyResponseError();
    return all;
}
