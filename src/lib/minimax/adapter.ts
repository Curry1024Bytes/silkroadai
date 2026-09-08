/**
 * MiniMax-H3 视频适配器(token.xinhankr.com,2026-08-26)。
 *
 * 走 ch95/ch41 同款「portal 适配器 + new-api 渠道」模式:new-api 渠道(type=1 OpenAI,
 * base_url 指向本适配器)把客户的统一视频请求打到这里,本适配器转发上游
 * token.xinhankr.com。上游网关与 new-api 统一视频格式对齐(提交 POST /v1/video/generations、
 * 轮询 GET /v1/video/generations/{task_id}、完成 { status, data:[{url}] }),客户格式 =
 * 上游格式 → 近乎纯透传,只做:①鉴权透传(渠道 key = 上游 key,原样带给上游,
 * 不在代码里存任何 key);②duration 门控(计费一致性,见下);③data URL 入参转存 R2
 * (上游只吃 http(s) 直链);④响应包成 new-api Sora 中继吃的 OpenAI-video 形。
 *
 * 计费:new-api 按【ModelPrice × GroupRatio × 请求 duration(秒)】计(is_task 按秒口径,
 * 与 dreamina/ch41 线同款,2026-08-26 真实日志对账验证)。因此 duration 必须显式、
 * 且在上游合法区间 [4,15] 内 —— 缺失/非法直接 400(new-api 对失败任务退款),
 * 绝不静默改写(改写会造成「按 A 秒扣费、按 B 秒生成」)。
 * resolution(768P/2K)不影响计费(挂牌 ¥0.5/秒 一口价),缺省回落 768P。
 */
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { uploadImage } from '@/lib/r2/client';

const XHK_BASE = process.env.MINIMAX_XHK_BASE_URL || 'https://token.xinhankr.com';

/** 对客/上游同名(上游按平台实际上架名计费路由,不做映射)。 */
export const MINIMAX_VIDEO_MODEL = 'MiniMax-H3';

const MIN_DURATION = 4;
const MAX_DURATION = 15;

/** 上游生成为异步任务,提交/轮询本身应秒回;给宽超时防挂死连接池。 */
const UPSTREAM_TIMEOUT_MS = 120_000;

/** 是否本适配器负责的模型(渠道 models 只挂 MiniMax-H3;大小写宽容,转发用规范名)。 */
export function isMinimaxVideoModel(model: string): boolean {
    return String(model || '').toLowerCase() === MINIMAX_VIDEO_MODEL.toLowerCase();
}

function err(status: number, code: string, message: string) {
    return NextResponse.json({ error: { code, message, type: 'minimax_adapter_error' } }, { status });
}

function isAuthorized(auth: string): boolean {
    const key = auth.replace(/^Bearer\s+/i, '').trim();
    // 渠道 key(= 上游 key)。设了 MINIMAX_XHK_KEY 就精确校验(防公网路径被外部直打);
    // 未设时放行 sk- 前缀 —— 即便被外部直打,鉴权头原样转发上游,错 key 上游 401,无泄露面。
    const configured = process.env.MINIMAX_XHK_KEY || '';
    if (configured) return key === configured;
    return /^sk-/.test(key);
}

const fetchXhk = (path: string, auth: string, init: RequestInit = {}) =>
    fetch(`${XHK_BASE}${path}`, {
        ...init,
        headers: { Authorization: auth, Accept: 'application/json', ...(init.headers || {}) },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

/** prompt:顶层 prompt 优先,MiniMax 原生 content[].text 兜底。 */
function extractPrompt(body: Record<string, unknown>): string {
    if (typeof body.prompt === 'string' && body.prompt.trim()) return body.prompt;
    const content = body.content;
    if (Array.isArray(content)) {
        const t = content
            .filter((c): c is { type: string; text: string } => {
                const o = c as { type?: unknown; text?: unknown };
                return o?.type === 'text' && typeof o?.text === 'string';
            })
            .map((c) => c.text)
            .join('\n');
        if (t.trim()) return t;
    }
    return '';
}

/** data URL → 上传 R2 返直链;http(s) 原样。其余形态报错(上游只吃网络直链)。 */
async function toHttpMediaUrl(url: string): Promise<string> {
    const u = url.trim();
    const m = /^data:((?:image|audio|video)\/[a-z0-9.+-]+);base64,(.+)$/i.exec(u);
    if (m) {
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > 20 * 1024 * 1024) throw new Error('media exceeds 20MB');
        return uploadImage(`minimax-input/${randomUUID()}`, buf, m[1]);
    }
    if (!/^https?:\/\//i.test(u)) throw new Error('media must be an http(s) URL or a base64 data URL');
    return u;
}

/** 就地重写一个媒体数组(images/videos/audios):string / {url, role} 两形都收,
 *  仅把 data URL 换成 R2 直链,其余字段(role 等)原样保留。 */
async function rehostMediaArray(list: unknown): Promise<unknown> {
    if (!Array.isArray(list)) return list;
    return Promise.all(
        list.map(async (item) => {
            if (typeof item === 'string') return toHttpMediaUrl(item);
            if (item && typeof item === 'object') {
                const o = item as Record<string, unknown>;
                if (typeof o.url === 'string') return { ...o, url: await toHttpMediaUrl(o.url) };
                // MiniMax 原生 content 项形({type, image_url:{url}, role})
                const iu = o.image_url as { url?: unknown } | undefined;
                if (iu && typeof iu.url === 'string')
                    return { ...o, image_url: { ...iu, url: await toHttpMediaUrl(iu.url) } };
            }
            return item;
        }),
    );
}

/** POST 提交:透传 → token.xinhankr.com /v1/video/generations。 */
export async function submitVideo(req: NextRequest): Promise<NextResponse> {
    const auth = req.headers.get('authorization') || '';
    if (!isAuthorized(auth)) return err(401, 'unauthorized', 'invalid credentials for minimax adapter');

    let body: Record<string, unknown>;
    try {
        body = (await req.json()) as Record<string, unknown>;
    } catch {
        return err(400, 'invalid_json', 'request body must be JSON');
    }

    const model = String(body.model || '');
    if (!isMinimaxVideoModel(model)) return err(400, 'model_not_found', `unknown minimax model: ${model}`);

    const prompt = extractPrompt(body);
    if (!prompt) return err(400, 'invalid_request', 'prompt (text) is required');

    // duration 门控:new-api 按请求 duration 秒计费,这里必须与实际生成严格一致 —
    // 缺失/非整数/越界一律 400(失败任务 new-api 退款),不回落不改写。
    const duration = Number(body.duration ?? body.seconds);
    if (!Number.isInteger(duration) || duration < MIN_DURATION || duration > MAX_DURATION)
        return err(
            400,
            'invalid_request',
            `duration is required and must be an integer between ${MIN_DURATION} and ${MAX_DURATION} (seconds)`,
        );

    // resolution:768P / 2K(大小写宽容),缺省 768P;非法 400(不打上游)
    const resRaw = String(body.resolution ?? '768P')
        .trim()
        .toUpperCase();
    if (resRaw !== '768P' && resRaw !== '2K')
        return err(400, 'invalid_request', `unsupported resolution: ${String(body.resolution)} (use 768P or 2K)`);

    // 上游请求体 = 客户 body 透传(ratio/watermark/callback_url/首尾帧 role 等上游语义原样),
    // 只规范 model/resolution/duration + 转存 data URL 媒体。
    const upstreamBody: Record<string, unknown> = {
        ...body,
        model: MINIMAX_VIDEO_MODEL,
        resolution: resRaw,
        duration,
    };
    delete upstreamBody.seconds;
    try {
        for (const k of ['images', 'image_urls', 'videos', 'audios', 'content'] as const) {
            if (k in upstreamBody) upstreamBody[k] = await rehostMediaArray(upstreamBody[k]);
        }
    } catch (e) {
        return err(400, 'invalid_request', `reference media processing failed: ${String(e).slice(0, 160)}`);
    }

    console.log('[minimax-adapter] submit', {
        model: MINIMAX_VIDEO_MODEL,
        resolution: resRaw,
        duration,
        images: Array.isArray(body.images) ? body.images.length : 0,
        videos: Array.isArray(body.videos) ? body.videos.length : 0,
        audios: Array.isArray(body.audios) ? body.audios.length : 0,
    });

    let upstream: Response;
    try {
        upstream = await fetchXhk('/v1/video/generations', auth, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(upstreamBody),
        });
    } catch (e) {
        console.warn('[minimax-adapter] submit unreachable', { err: String(e) });
        return err(502, 'upstream_unreachable', 'upstream temporarily unavailable, please retry');
    }
    const text = await upstream.text();
    let j: { id?: string; task_id?: string } | null;
    try {
        j = JSON.parse(text) as { id?: string; task_id?: string };
    } catch {
        j = null;
    }
    const taskId = j?.task_id || j?.id;
    if (!upstream.ok || !taskId) {
        // 上游报错体(OpenAI 形,同 kling 线实测不含内部标识)原样透传,完整落日志供反查
        console.warn('[minimax-adapter] submit failed', { status: upstream.status, body: text.slice(0, 2000) });
        if (upstream.ok) return err(502, 'upstream_error', 'no task id from minimax upstream');
        return new NextResponse(text, { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
    }
    return NextResponse.json(
        {
            id: taskId,
            task_id: taskId,
            object: 'video',
            model: MINIMAX_VIDEO_MODEL,
            status: 'queued',
            progress: 0,
            created_at: Math.floor(Date.now() / 1000),
        },
        { status: 200 },
    );
}

function mapStatus(s: unknown): 'queued' | 'in_progress' | 'completed' | 'failed' {
    const x = String(s || '').toLowerCase();
    if (['completed', 'success', 'succeeded'].includes(x)) return 'completed';
    if (['failed', 'error', 'cancelled', 'canceled'].includes(x)) return 'failed';
    if (x === 'queued' || x === 'pending') return 'queued';
    return 'in_progress';
}

/** 上游完成响应 data 是数组 [{url}];取第一条视频直链。 */
function firstVideoUrl(data: unknown): string | null {
    if (!Array.isArray(data)) return null;
    const first = data[0] as { url?: unknown } | undefined;
    return typeof first?.url === 'string' ? first.url : null;
}

/** GET 轮询:token.xinhankr.com /v1/video/generations/{id} → OpenAI-video 形。 */
export async function pollVideo(req: NextRequest, id: string): Promise<NextResponse> {
    const auth = req.headers.get('authorization') || '';
    let upstream: Response;
    try {
        upstream = await fetchXhk(`/v1/video/generations/${encodeURIComponent(id)}`, auth);
    } catch (e) {
        console.warn('[minimax-adapter] poll unreachable', { id, err: String(e) });
        return err(502, 'upstream_unreachable', 'upstream temporarily unavailable, please retry');
    }
    const text = await upstream.text();
    let j: Record<string, unknown> | null;
    try {
        j = JSON.parse(text) as Record<string, unknown>;
    } catch {
        j = null;
    }
    if (!upstream.ok || !j) {
        console.warn('[minimax-adapter] poll failed', { id, status: upstream.status, body: text.slice(0, 2000) });
        if (upstream.ok) return err(502, 'upstream_error', 'invalid response from minimax upstream');
        return new NextResponse(text, { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
    }
    const status = mapStatus(j.status);
    const videoUrl = firstVideoUrl(j.data);
    const failReason =
        status === 'failed'
            ? String((j.error as { message?: string } | undefined)?.message || j.message || 'generation failed')
            : '';
    if (failReason) console.warn('[minimax-adapter] task failed upstream', { id, fail_reason: failReason });
    return NextResponse.json(
        {
            id,
            task_id: id,
            object: 'video',
            status,
            progress: status === 'completed' || status === 'failed' ? 100 : 50,
            video_url: videoUrl ?? undefined,
            url: videoUrl ?? undefined,
            fail_reason: failReason || undefined,
        },
        { status: 200 },
    );
}

/** GET 内容代理:new-api result_url 回抓这里 → 拉上游成片流式回(隐藏上游直链)。 */
export async function streamContent(req: NextRequest, id: string): Promise<Response> {
    const auth = req.headers.get('authorization') || '';
    let taskRes: Response;
    try {
        taskRes = await fetchXhk(`/v1/video/generations/${encodeURIComponent(id)}`, auth);
    } catch (e) {
        console.warn('[minimax-adapter] streamContent poll unreachable', { id, err: String(e) });
        return err(502, 'upstream_unreachable', 'upstream temporarily unavailable, please retry');
    }
    const j = (await taskRes.json().catch(() => null)) as { data?: unknown } | null;
    const videoUrl = firstVideoUrl(j?.data);
    if (!videoUrl) return err(409, 'not_ready', 'video not available yet');
    let vid: Response;
    try {
        vid = await fetch(videoUrl, { headers: { Authorization: auth } });
    } catch (e) {
        console.warn('[minimax-adapter] streamContent fetch video failed', { id, err: String(e) });
        return err(502, 'upstream_unreachable', 'upstream temporarily unavailable, please retry');
    }
    if (!vid.ok || !vid.body) return err(502, 'upstream_error', `video fetch ${vid.status}`);
    const headers: Record<string, string> = { 'Content-Type': vid.headers.get('content-type') || 'video/mp4' };
    const len = vid.headers.get('content-length');
    if (len) headers['Content-Length'] = len;
    return new Response(vid.body, { status: 200, headers });
}
