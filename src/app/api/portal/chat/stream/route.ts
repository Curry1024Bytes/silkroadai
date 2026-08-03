/**
 * POST /api/portal/chat/stream — Chat UI (stateless) streaming proxy.
 *
 * Background
 * ----------
 * The chat UI is deliberately *stateless*: the customer picks a model,
 * sends a turn, streams the reply, and nothing is persisted. No schema
 * change, no new table — conversation history lands later as its own
 * coordinated migration (see PROJECT-PLAN-B3 roadmap).
 *
 * v2 adds two upstream-capability features without changing this contract:
 *   - multimodal `content` (text + image_url parts) forwarded verbatim so
 *     vision models can take images;
 *   - optional `web_search`: prepend a system message with live search
 *     results (best-effort, model-agnostic; see src/lib/chat/web-search.ts).
 *
 * This route is the only server piece. It mirrors the proven image-gen
 * pattern (POST /api/portal/image/generate):
 *   1. Cookie auth via getCurrentUser (W3 D3+).
 *   2. In-memory sliding-window rate limit (scope `chat_stream`).
 *   3. zod-validate { model, messages }.
 *   4. Resolve the customer's portal-internal system token
 *      (getOrCreateSystemToken) — the sk-… NEVER reaches the browser.
 *   5. Forward to https://api.llmroute.club/v1/chat/completions with
 *      stream:true and pipe the upstream SSE ReadableStream straight
 *      back to the client (no buffering — same passthrough the /v1/*
 *      proxy uses).
 *
 * Quota deducts from the customer's new-api account exactly as a direct
 * sk-… call would. We write nothing to Postgres here.
 *
 * Why proxy server-side instead of letting the browser call /v1 with a
 * revealed key: (a) the key stays server-side, (b) we keep one rate-limit
 * choke point, (c) the customer doesn't need to have minted a manual key
 * to use the chat — the system token is lazily provisioned.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/lib/auth/session';
import { SUPPORT_WECHAT } from '@/lib/public-config';
import { getOrCreateSystemToken, PortalSystemTokenError } from '@/lib/newapi/system-token';
import { runWebSearch } from '@/lib/chat/web-search';
import { resolveModelGroup } from '@/lib/chat/model-groups';
import { guardSseStream } from '@/lib/sse/stream-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Self-hosted Node ignores this; Vercel deadline guard. Chat turns can
 *  be long (reasoning models), so we give a generous ceiling paired with
 *  the upstream AbortSignal below. */
export const maxDuration = 300;

const NEWAPI_PROXY_URL = process.env.NEWAPI_CUSTOMER_BASE_URL || 'https://api.llmroute.club';

/** Abort the upstream connection if it stalls. Generous — reasoning
 *  models legitimately think for a while before the first token. */
const UPSTREAM_TIMEOUT_MS = 180_000;

const MAX_MESSAGES = 100;
const MAX_CONTENT_CHARS = 32_000;

/** v2: a message's content is either a plain string OR an OpenAI-style
 *  multimodal parts array (text + image_url) so vision models can take
 *  images. Multimodal content is forwarded verbatim to new-api; non-vision
 *  models will 4xx upstream if handed an image, so the client disables the
 *  upload button unless a vision model is selected (defense-in-depth, not
 *  enforced here — the upstream owns capability). */
const TextPart = z.object({ type: z.literal('text'), text: z.string().max(MAX_CONTENT_CHARS) });
const ImageUrlPart = z.object({
    type: z.literal('image_url'),
    // data: URL (base64) or http(s) URL. Cap ~2MB of chars (≈1.5MB image
    // as a data URL) so a single request stays bounded.
    image_url: z.object({ url: z.string().max(2_000_000), detail: z.string().optional() }),
});
const ContentPart = z.union([TextPart, ImageUrlPart]);

/** Stateless: the client re-sends the full (in-memory) transcript each
 *  turn. We cap message count + per-message size to keep a single
 *  request bounded; the customer's own context window is the real
 *  upstream limit. */
const MessageSchema = z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.union([
        z.string().max(MAX_CONTENT_CHARS, `message > ${MAX_CONTENT_CHARS} chars`),
        z.array(ContentPart).max(20),
    ]),
});

const ChatStreamSchema = z.object({
    model: z.string().trim().min(1, 'model required').max(200),
    messages: z.array(MessageSchema).min(1, 'at least one message').max(MAX_MESSAGES, `too many messages`),
    /** Optional sampling knob; clamped server-side. Defaults to upstream
     *  default when omitted. */
    temperature: z.number().min(0).max(2).optional(),
    /** v2: opt-in web search. When true AND a provider is configured
     *  (TAVILY_API_KEY), the route prepends a system message with search
     *  results for the latest user query. No-op (plain chat) otherwise. */
    web_search: z.boolean().optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
    const user = await getCurrentUser(req);
    if (!user) {
        return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }

    // 限流已移除(运营策略:不对客户 API 用量设节流)。

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input', message: 'body must be JSON' }, { status: 400 });
    }
    const parsed = ChatStreamSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const { model, messages, temperature, web_search } = parsed.data;

    // v2: optional web-search injection. Best-effort + model-agnostic —
    // prepend a system message carrying search results for the latest user
    // query so any chat model can ground on it. No-op when the toggle is
    // off, no provider env is configured, or the search fails/returns empty
    // (runWebSearch never throws). The customer-facing toggle stays stable
    // even if a real tool-call loop replaces this later.
    let finalMessages: typeof messages = messages;
    if (web_search) {
        const q = extractLatestUserText(messages);
        const ctx = q ? await runWebSearch(q) : null;
        if (ctx) finalMessages = [{ role: 'system', content: ctx }, ...messages];
    }

    // Route premium / official-only models through their group's system
    // token. The group is resolved SERVER-SIDE (not trusting the client) from
    // channel data — the cheapest group serving the model; default-group
    // models keep the primary token. resolveModelGroup never throws.
    const group = await resolveModelGroup(model);

    // Resolve the customer's portal-internal sk-… token for that group
    // (lazy-provisions on first use). Failure maps to a friendly 4xx/503.
    let systemToken: string;
    try {
        systemToken = await getOrCreateSystemToken(user.id, group);
    } catch (err) {
        if (err instanceof PortalSystemTokenError) {
            const status = err.code === 'user_not_provisioned' ? 500 : 503;
            console.log(`[chat-stream-fail] system_token user=${user.id} code=${err.code}`);
            return NextResponse.json(
                {
                    error: err.code,
                    message:
                        err.code === 'user_not_provisioned'
                            ? `账户未完成 new-api 关联,联系客服 ${SUPPORT_WECHAT}`
                            : '对话服务暂不可用,请稍后再试',
                },
                { status },
            );
        }
        console.error(`[chat-stream-fail] system_token user=${user.id}:`, err);
        return NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }

    // Forward to the customer-facing /v1/chat/completions with streaming.
    let upstream: Response;
    try {
        upstream = await fetch(`${NEWAPI_PROXY_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${systemToken}`,
                'Content-Type': 'application/json',
                Accept: 'text/event-stream',
            },
            body: JSON.stringify({
                model,
                messages: finalMessages,
                stream: true,
                ...(temperature != null ? { temperature } : {}),
            }),
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
    } catch (err) {
        console.error(`[chat-stream-fail] transport user=${user.id} model=${model}:`, err);
        return NextResponse.json({ error: 'upstream_unreachable' }, { status: 502 });
    }

    // Non-2xx upstream: surface the (JSON) error body + a sane status.
    // new-api returns OpenAI-shaped { error: { message, code, type } }.
    if (!upstream.ok || !upstream.body) {
        let detail: unknown = null;
        try {
            detail = await upstream.json();
        } catch {
            /* non-JSON upstream error — leave detail null */
        }
        const status = upstream.status >= 500 ? 502 : upstream.status;
        console.log(`[chat-stream-fail] upstream user=${user.id} model=${model} status=${upstream.status}`);
        return NextResponse.json({ error: 'upstream_error', upstream_status: upstream.status, detail }, { status });
    }

    console.log(`[chat-stream] ok user=${user.id} model=${model} group=${group} msgs=${messages.length}`);

    // Pipe the upstream SSE stream straight through. No buffering — tokens
    // reach the client as new-api emits them. Strip hop-by-hop headers and
    // pin the content-type to text/event-stream.
    // SSE 流式两件套(stream-guard):静默期 keep-alive 注释(reasoning 模型思考期不被
    // CF/代理/SDK 空闲超时掐线;drainSse 忽略注释行)+ 上游流中断时注入
    // finish_reason:"error" 尾帧(chat-console 渲染成可见的「连接中断」提示,而非莫名断流)。
    const guarded = guardSseStream(upstream.body, { shape: 'openai', model, label: 'portal-chat-stream' });
    return new Response(guarded, {
        status: 200,
        headers: {
            'Content-Type': upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        },
    });
}

/** Pull the latest user turn's text for the web-search query: string
 *  content as-is; multimodal content → its text parts joined. Returns ''
 *  when there's no user text (e.g. an image-only turn) so the caller skips
 *  the search. */
function extractLatestUserText(msgs: Array<{ role: string; content: unknown }>): string {
    for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role !== 'user') continue;
        const c = msgs[i].content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) {
            return (c as Array<{ type?: string; text?: string }>)
                .filter((p) => p?.type === 'text')
                .map((p) => p.text ?? '')
                .join(' ')
                .trim();
        }
    }
    return '';
}
