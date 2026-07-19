/**
 * Seedance 国内企业级端口 适配器(火山方舟 doubao-seedance / token.xinhankr.com)。
 *
 * 上游网关「与 OpenAI 官方视频规范完全对齐」:提交 POST /v1/video/generations、
 * 轮询 GET /v1/video/generations/{task_id}、完成响应 { status, data:[{url}], usage }。
 * 因此本适配器比海外档(service-inference.ai 自定义 API)简单得多 —— 近乎透传,
 * 只做两件事:①档位模型名 → 上游单模型 artsdance2.0-pro-260701 + resolution + 参考模式门控;
 * ②入参图/视频/音频 data URL 先转存我们 R2(上游 images[]/videos[]/audios[] 只吃 http(s) 直链)。
 * 成片【不转存】,直接返回火山 volcvideo.com 原始直链(operator 要「真实感」:客户看到火山官方
 * VOD 域名,已隐藏 token.xinhankr 上游、只露 Volcengine=火山方舟)。⚠️ 火山直链是【签名 URL ~24h 过期】,
 * 客户须及时下载/转存(不像 R2 永久)。见 /docs 说明。
 *
 * 计费:【按 token 量】—— 上游按 token 计价(usage.completion_tokens 权威),我们对客 = 实际 token ×
 * 零售单价(官方价 × 0.85;上游给我们 0.75)。分辨率(720p/1080p/4k,共 6 个模型名 = 3×{无参考,-ref})
 * 决定每-token 费率档;pollVideo 回传 usage 供 new-api ModelRatio 或适配器自扣计费(见按 token 计费方案)。
 * ⚠️ 参考视频档(输入视频也计 token)成本高于无视频,不能按无视频档收 —— 待接入含视频费率档(off-peak)。
 * 适配器强制档位与实际输入一致(无参考档带图 → 400;参考档不带图/视频 → 400),防止客户挑便宜档串用。
 *
 * ⚠️ 上游账户余额 < ¥5 会对【所有】请求回 403「账户余额不足5元」—— 保持上游充值。
 */
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { uploadImage } from '@/lib/r2/client';

const XHK_BASE = process.env.SEEDANCE_XHK_BASE_URL || 'https://token.xinhankr.com';
/** 上游 pro 模型名(SEEDANCE_XHK_MODEL 仅覆盖 pro;fast/mini 上游 id 固定)。 */
const UPSTREAM_MODEL = process.env.SEEDANCE_XHK_MODEL || 'artsdance2.0-pro-260701';
const UPSTREAM_FAST = 'artsdance2.0-fast-260701';
const UPSTREAM_MINI = 'artsdance2.0-mini-260701';

const MAX_REF_IMAGES = 9;
const MAX_REF_VIDEOS = 3;

/** seedance 变体(2026-07-19 加 fast/mini):费率按 variant × resolution × 含视频 分档。 */
export type SeedanceVariant = 'pro' | 'fast' | 'mini';

export interface SeedanceModelSpec {
    resolution: '720p' | '1080p' | '4k';
    ref: boolean;
    variant: SeedanceVariant;
    /** 该档实际发给上游的模型 id(分辨率/参考模式由请求体承载)。 */
    upstream: string;
}

/** 客户/new-api 档位模型名 → 档位规格。pro 3 分辨率 × {无参考,-ref} = 6 名;
 *  fast/mini 上游只有 720p/1080p(无 4k)各 4 名 → 共 14 名。2k 已下线(2026-07-15)。 */
export const MODEL_MAP: Record<string, SeedanceModelSpec> = {
    'seedance2.0-pro-720p': { resolution: '720p', ref: false, variant: 'pro', upstream: UPSTREAM_MODEL },
    'seedance2.0-pro-1080p': { resolution: '1080p', ref: false, variant: 'pro', upstream: UPSTREAM_MODEL },
    'seedance2.0-pro-4k': { resolution: '4k', ref: false, variant: 'pro', upstream: UPSTREAM_MODEL },
    'seedance2.0-pro-720p-ref': { resolution: '720p', ref: true, variant: 'pro', upstream: UPSTREAM_MODEL },
    'seedance2.0-pro-1080p-ref': { resolution: '1080p', ref: true, variant: 'pro', upstream: UPSTREAM_MODEL },
    'seedance2.0-pro-4k-ref': { resolution: '4k', ref: true, variant: 'pro', upstream: UPSTREAM_MODEL },
    'seedance2.0-fast-720p': { resolution: '720p', ref: false, variant: 'fast', upstream: UPSTREAM_FAST },
    'seedance2.0-fast-1080p': { resolution: '1080p', ref: false, variant: 'fast', upstream: UPSTREAM_FAST },
    'seedance2.0-fast-720p-ref': { resolution: '720p', ref: true, variant: 'fast', upstream: UPSTREAM_FAST },
    'seedance2.0-fast-1080p-ref': { resolution: '1080p', ref: true, variant: 'fast', upstream: UPSTREAM_FAST },
    'seedance2.0-mini-720p': { resolution: '720p', ref: false, variant: 'mini', upstream: UPSTREAM_MINI },
    'seedance2.0-mini-1080p': { resolution: '1080p', ref: false, variant: 'mini', upstream: UPSTREAM_MINI },
    'seedance2.0-mini-720p-ref': { resolution: '720p', ref: true, variant: 'mini', upstream: UPSTREAM_MINI },
    'seedance2.0-mini-1080p-ref': { resolution: '1080p', ref: true, variant: 'mini', upstream: UPSTREAM_MINI },
};

/** 任务行只存 model 名 → 变体(计费用)。长名走 MODEL_MAP;企业门户短名
 *  (seedance-2-0[-fast|-mini],2026-07-20 归一)按后缀识别;未知名回落 pro(宁多收不少收)。 */
export function variantForModel(model: string): SeedanceVariant {
    const hit = MODEL_MAP[model]?.variant;
    if (hit) return hit;
    const m = model.toLowerCase();
    if (m.includes('-fast')) return 'fast';
    if (m.includes('-mini')) return 'mini';
    return 'pro';
}

const ALLOWED_RATIOS = new Set(['16:9', '9:16', '4:3', '3:4', '1:1', '21:9']);

function err(status: number, code: string, message: string) {
    return NextResponse.json({ error: { code, message, type: 'seedance_cn_adapter_error' } }, { status });
}

function isAuthorized(auth: string): boolean {
    const key = auth.replace(/^Bearer\s+/i, '').trim();
    // 渠道 key(= new-api 下发的 channel key)。设了 SEEDANCE_XHK_KEY 就精确校验,防路由被外部直接打;
    // 未设(本地/测试)时放行任何 sk- 前缀。运行时读 env(不缓存),便于改 key 不重启 + 可测。
    const configured = process.env.SEEDANCE_XHK_KEY || '';
    if (configured) return key === configured;
    return /^sk-/.test(key);
}

/** OpenAI/视频两种风格都抽:prompt / content[].text / messages[].content。 */
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
    const messages = body.messages;
    if (Array.isArray(messages)) {
        const lastUser = [...messages].reverse().find((m) => (m as { role?: string })?.role === 'user') as
            | { content?: unknown }
            | undefined;
        const mc = lastUser?.content;
        if (typeof mc === 'string') return mc;
        if (Array.isArray(mc)) {
            return mc
                .filter((c): c is { text: string } => (c as { type?: string })?.type === 'text')
                .map((c) => c.text)
                .join('\n');
        }
    }
    return '';
}

function pushUrl(list: string[], u: unknown) {
    if (typeof u === 'string' && u) list.push(u);
    else if (u && typeof u === 'object' && typeof (u as { url?: unknown }).url === 'string')
        list.push((u as { url: string }).url);
}

/** 入参图 URL(顶层 image_url / image / images / reference_image_urls + content[].image_url)。 */
export function extractImageUrls(body: Record<string, unknown>): string[] {
    const urls: string[] = [];
    pushUrl(urls, body.image_url);
    if (typeof body.image === 'string') urls.push(body.image);
    if (Array.isArray(body.images)) for (const i of body.images) pushUrl(urls, i);
    if (Array.isArray(body.image_urls)) for (const i of body.image_urls) pushUrl(urls, i);
    if (Array.isArray(body.reference_image_urls)) for (const i of body.reference_image_urls) pushUrl(urls, i);
    const content = body.content;
    if (Array.isArray(content)) {
        for (const c of content) {
            const o = c as { type?: string; image_url?: unknown };
            if (o?.type === 'image_url' || o?.type === 'input_image') pushUrl(urls, o.image_url);
        }
    }
    return urls;
}

/** 入参视频 URL(reference_video / reference_videos / videos + content[].video_url)。 */
export function extractVideoUrls(body: Record<string, unknown>): string[] {
    const urls: string[] = [];
    pushUrl(urls, body.reference_video);
    if (Array.isArray(body.reference_videos)) for (const v of body.reference_videos) pushUrl(urls, v);
    if (Array.isArray(body.videos)) for (const v of body.videos) pushUrl(urls, v);
    const content = body.content;
    if (Array.isArray(content)) {
        for (const c of content) {
            const o = c as { type?: string; video_url?: unknown };
            if (o?.type === 'video_url' || o?.type === 'input_video') pushUrl(urls, o.video_url);
        }
    }
    return urls;
}

/** 入参音频 URL(audio_url / audio / audios / reference_audios + content[].audio_url)。 */
export function extractAudioUrls(body: Record<string, unknown>): string[] {
    const urls: string[] = [];
    pushUrl(urls, body.audio_url);
    if (typeof body.audio === 'string') urls.push(body.audio);
    if (Array.isArray(body.audios)) for (const a of body.audios) pushUrl(urls, a);
    if (Array.isArray(body.reference_audios)) for (const a of body.reference_audios) pushUrl(urls, a);
    const content = body.content;
    if (Array.isArray(content)) {
        for (const c of content) {
            const o = c as { type?: string; audio_url?: unknown };
            if (o?.type === 'audio_url' || o?.type === 'input_audio') pushUrl(urls, o.audio_url);
        }
    }
    return urls;
}

/** media URL → 上游能抓的 http(s) 直链。data URL 解码上传我们 R2(无扩展名,content-type 权威);
 *  http(s) 原样透传(上游 Volcengine 抓取器直接吃网络直链)。 */
async function toHttpMediaUrl(url: string): Promise<string> {
    const u = url.trim();
    const m = /^data:((?:image|audio|video)\/[a-z0-9.+-]+);base64,(.+)$/i.exec(u);
    if (m) {
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > 20 * 1024 * 1024) throw new Error('media exceeds 20MB');
        return uploadImage(`seedance-cn-ref/${randomUUID()}`, buf, m[1]);
    }
    if (!/^https?:\/\//i.test(u)) throw new Error('media must be an http(s) URL or a base64 data URL');
    return u;
}

const fetchXhk = (path: string, auth: string, init: RequestInit = {}) =>
    fetch(`${XHK_BASE}${path}`, {
        ...init,
        headers: { Authorization: auth, Accept: 'application/json', ...(init.headers || {}) },
    });

/** POST 提交:OpenAI-video → token.xinhankr.com /v1/video/generations。 */
export async function submitVideo(req: NextRequest): Promise<NextResponse> {
    const auth = req.headers.get('authorization') || '';
    if (!isAuthorized(auth)) return err(401, 'unauthorized', 'invalid credentials for seedance-cn adapter');

    let body: Record<string, unknown>;
    try {
        body = (await req.json()) as Record<string, unknown>;
    } catch {
        return err(400, 'invalid_json', 'request body must be JSON');
    }
    return submitVideoWithKey(body, auth);
}

/** 提交核心(独立门户直调:body + 上游 key 授权头,进程内调用,不走 HTTP/适配器单 key 鉴权)。 */
export async function submitVideoWithKey(body: Record<string, unknown>, auth: string): Promise<NextResponse> {
    const model = String(body.model || '');
    const map = MODEL_MAP[model];
    if (!map) return err(400, 'model_not_found', `unknown seedance-cn model: ${model}`);

    const prompt = extractPrompt(body);
    if (!prompt) return err(400, 'invalid_request', 'prompt (text) is required');

    // 入参图/视频 + 帧角色(first_frame/last_frame 显式优先;reference_mode 次之;否则智能模式)
    const rawImages = extractImageUrls(body);
    const rawVideos = extractVideoUrls(body);
    const refMode = String(
        (body.video_config as { reference_mode?: unknown } | undefined)?.reference_mode || '',
    ).toLowerCase();
    const explicitFirst = typeof body.first_frame === 'string' ? body.first_frame : '';
    const explicitLast = typeof body.last_frame === 'string' ? body.last_frame : '';
    const rawAudios = extractAudioUrls(body);
    const totalImages = rawImages.length + (explicitFirst ? 1 : 0) + (explicitLast ? 1 : 0);

    // 档位与输入一致性门控(防串档薅便宜档)
    const hasInputs = totalImages > 0 || rawVideos.length > 0 || rawAudios.length > 0;
    if (!map.ref && hasInputs)
        return err(400, 'invalid_request', `${model} is text-only; use a "-ref" model for image/video/audio inputs`);
    if (map.ref && !hasInputs)
        return err(
            400,
            'invalid_request',
            `${model} requires a reference (image_url / images / reference_image_urls / first_frame / last_frame / reference_videos)`,
        );
    // 音频需配 ≥1 张图(对齐上游文档)
    if (rawAudios.length > 0 && totalImages === 0)
        return err(400, 'invalid_request', 'audio requires at least one reference image (image / first_frame)');
    if (totalImages > MAX_REF_IMAGES) return err(400, 'invalid_request', `at most ${MAX_REF_IMAGES} images`);
    if (rawVideos.length > MAX_REF_VIDEOS) return err(400, 'invalid_request', `at most ${MAX_REF_VIDEOS} videos`);

    // duration:5 或 10(上游只收这两档);ratio 白名单外回落 16:9
    const durRaw = Number(body.duration ?? body.seconds);
    const duration = durRaw === 10 ? 10 : 5;
    let ratio = String(body.ratio || body.aspect_ratio || '16:9');
    if (!ALLOWED_RATIOS.has(ratio)) ratio = '16:9';
    const generateAudio = body.generate_audio !== false; // 满血企业档默认出声;传 false 关(音频零额外 token 成本)

    // 上游请求体(images/videos 用带 role 的对象;帧角色显式指定优先)
    const upstreamBody: Record<string, unknown> = {
        model: map.upstream,
        prompt,
        resolution: map.resolution,
        ratio,
        duration,
        generate_audio: generateAudio,
    };
    if (typeof body.camera_fixed === 'boolean') upstreamBody.camera_fixed = body.camera_fixed;
    if (typeof body.seed === 'number') upstreamBody.seed = body.seed;

    if (map.ref) {
        try {
            const images: Array<{ url: string; role: string }> = [];
            if (explicitFirst) images.push({ url: await toHttpMediaUrl(explicitFirst), role: 'first_frame' });
            if (explicitLast) images.push({ url: await toHttpMediaUrl(explicitLast), role: 'last_frame' });
            if (!explicitFirst && !explicitLast && refMode === 'start_frame' && rawImages.length >= 1) {
                images.push({ url: await toHttpMediaUrl(rawImages[0]), role: 'first_frame' });
            } else if (!explicitFirst && !explicitLast && refMode === 'start_end' && rawImages.length >= 2) {
                images.push({ url: await toHttpMediaUrl(rawImages[0]), role: 'first_frame' });
                images.push({ url: await toHttpMediaUrl(rawImages[1]), role: 'last_frame' });
            } else if (!explicitFirst && !explicitLast) {
                for (const u of rawImages) images.push({ url: await toHttpMediaUrl(u), role: 'reference_image' });
            }
            if (images.length) upstreamBody.images = images;
            if (rawVideos.length) {
                const videos = await Promise.all(rawVideos.map((u) => toHttpMediaUrl(u)));
                upstreamBody.videos = videos;
            }
            if (rawAudios.length) {
                const audios = await Promise.all(rawAudios.map((u) => toHttpMediaUrl(u)));
                upstreamBody.audios = audios;
            }
        } catch (e) {
            return err(400, 'invalid_request', `reference media processing failed: ${String(e).slice(0, 160)}`);
        }
    }

    console.log('[seedance-cn-adapter] submit', {
        model,
        resolution: map.resolution,
        ref: map.ref,
        images: totalImages,
        videos: rawVideos.length,
        audios: rawAudios.length,
        duration,
        ratio,
        genAudio: generateAudio,
    });

    let upstream: Response;
    try {
        upstream = await fetchXhk('/v1/video/generations', auth, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(upstreamBody),
        });
    } catch (e) {
        return err(502, 'upstream_unreachable', `token.xinhankr.com unreachable: ${String(e)}`);
    }
    const text = await upstream.text();
    let j: { id?: string; task_id?: string; error?: { message?: string } } | null;
    try {
        j = JSON.parse(text) as { id?: string; task_id?: string };
    } catch {
        j = null;
    }
    const taskId = j?.task_id || j?.id;
    if (!upstream.ok || !taskId) {
        console.warn('[seedance-cn-adapter] submit failed', upstream.status, text.slice(0, 300));
        return err(
            upstream.status >= 400 ? upstream.status : 502,
            'upstream_error',
            (j?.error?.message || text || 'submit failed').slice(0, 300),
        );
    }
    return NextResponse.json(
        {
            id: taskId,
            task_id: taskId,
            object: 'video',
            model,
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
    return pollVideoWithKey(id, req.headers.get('authorization') || '');
}

/** 轮询核心(独立门户直调:id + 上游 key 授权头)。 */
export async function pollVideoWithKey(id: string, auth: string): Promise<NextResponse> {
    let upstream: Response;
    try {
        upstream = await fetchXhk(`/v1/video/generations/${encodeURIComponent(id)}`, auth);
    } catch (e) {
        return err(502, 'upstream_unreachable', String(e));
    }
    const text = await upstream.text();
    let j: Record<string, unknown> | null;
    try {
        j = JSON.parse(text) as Record<string, unknown>;
    } catch {
        j = null;
    }
    if (!upstream.ok || !j) {
        const msg = (j?.error as { message?: string } | undefined)?.message || text || 'poll failed';
        return err(upstream.status >= 400 ? upstream.status : 502, 'upstream_error', String(msg).slice(0, 300));
    }
    const status = mapStatus(j.status);
    const videoUrl = firstVideoUrl(j.data);
    const failReason =
        status === 'failed'
            ? String((j.error as { message?: string } | undefined)?.message || j.message || 'generation failed')
            : '';
    // 上游按 token 计费(usage.completion_tokens = 权威 token 数,= 火山公式 (输入+输出时长)×宽×高×帧率/1024;
    // 参考视频档因输入视频时长也计入,token 更多)。回传给下游做【按 token 量计费】—— 见按 token 计费方案。
    // ⚠️ 早期上游报的 token 数偏小一半(2026-07-15 修复),现以 usage 实报为准。
    const usage = (j.usage ?? undefined) as Record<string, unknown> | undefined;
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
            // 完成时透传上游 usage(供 new-api ModelRatio 或适配器自扣按 token 计费)
            usage: status === 'completed' ? usage : undefined,
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
        return err(502, 'upstream_unreachable', String(e));
    }
    const j = (await taskRes.json().catch(() => null)) as { data?: unknown } | null;
    const videoUrl = firstVideoUrl(j?.data);
    if (!videoUrl) return err(409, 'not_ready', 'video not available yet');
    let vid: Response;
    try {
        vid = await fetch(videoUrl, { headers: { Authorization: auth } });
    } catch (e) {
        return err(502, 'upstream_unreachable', `fetch video failed: ${String(e)}`);
    }
    if (!vid.ok || !vid.body) return err(502, 'upstream_error', `video fetch ${vid.status}`);
    const headers: Record<string, string> = { 'Content-Type': vid.headers.get('content-type') || 'video/mp4' };
    const len = vid.headers.get('content-length');
    if (len) headers['Content-Length'] = len;
    return new Response(vid.body, { status: 200, headers });
}
