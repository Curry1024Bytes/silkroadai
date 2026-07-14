/**
 * Seedance 海外满血 适配器核心逻辑(OpenAI-video ↔ service-inference.ai 翻译)。
 *
 * new-api 把视频请求转发到上游的路径实测是 /v1/videos(提交)+ /v1/videos/{id}(轮询),
 * 不是 /v1/video/generations。为稳妥两个路径都挂(见 app/seedance-adapter/...),
 * 共用本文件的 submitVideo / pollVideo。
 *
 * 计费由 new-api 按「请求 duration × ModelPrice × GroupRatio」算,与本适配器无关。
 * 见 seedance-overseas-adaptor-brief.md。
 *
 * Phase 1:文生(无参考图)。Phase 2:`-ref` 档 = 图生/参考生 —— 入参图经
 * service-inference.ai 的 asset 流(建组→传图→轮询就绪→`asset://{id}` + role=reference_image)。
 * 上游只收 http(s) 图床 URL(不收 data URL)→ data URL 先转存我们 R2 拿 http URL。
 */
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { uploadImage } from '@/lib/r2/client';

const SVC_BASE = process.env.SEEDANCE_INFERENCE_BASE_URL || 'https://model.service-inference.ai';
const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_REF_IMAGES = 9; // 对齐文档 reference_image_urls ≤9
const MAX_REF_VIDEOS = 3; // 对齐文档 reference_videos ≤3

/** 客户/new-api 模型名 → service-inference.ai model + resolution + 是否参考档(-ref)。
 *  满血档上游模型 2026-07-13 由 `dreamina-seedance-2-0-260128` 升级到 `dreamina-seedance-2-0-hc`
 *  —— 上游契约不变(generate/poll/asset 流实测全兼容),仅换模型名。fast 档上游无 hc 版,
 *  仍走 `dreamina-seedance-2-0-fast-260128`(实测仍可用)。 */
const MODEL_MAP: Record<string, { svc: string; resolution: string; ref: boolean }> = {
    // 无参考(文生):Phase 1
    'dreamina-seedance-2-0-480p': { svc: 'dreamina-seedance-2-0-hc', resolution: '480p', ref: false },
    'dreamina-seedance-2-0-720p': { svc: 'dreamina-seedance-2-0-hc', resolution: '720p', ref: false },
    'dreamina-seedance-2-0-1080p': { svc: 'dreamina-seedance-2-0-hc', resolution: '1080p', ref: false },
    'dreamina-seedance-2-0-4k': { svc: 'dreamina-seedance-2-0-hc', resolution: '4k', ref: false }, // hc 新增 4K 档
    'dreamina-seedance-2-0-fast-480p': { svc: 'dreamina-seedance-2-0-fast-260128', resolution: '480p', ref: false },
    'dreamina-seedance-2-0-fast-720p': { svc: 'dreamina-seedance-2-0-fast-260128', resolution: '720p', ref: false },
    // 带参考图(图生/参考生):Phase 2 —— WITH_REF 费率(更便宜)
    'dreamina-seedance-2-0-480p-ref': { svc: 'dreamina-seedance-2-0-hc', resolution: '480p', ref: true },
    'dreamina-seedance-2-0-720p-ref': { svc: 'dreamina-seedance-2-0-hc', resolution: '720p', ref: true },
    'dreamina-seedance-2-0-1080p-ref': { svc: 'dreamina-seedance-2-0-hc', resolution: '1080p', ref: true },
    'dreamina-seedance-2-0-4k-ref': { svc: 'dreamina-seedance-2-0-hc', resolution: '4k', ref: true }, // hc 新增 4K 参考档
    'dreamina-seedance-2-0-fast-480p-ref': { svc: 'dreamina-seedance-2-0-fast-260128', resolution: '480p', ref: true },
    'dreamina-seedance-2-0-fast-720p-ref': { svc: 'dreamina-seedance-2-0-fast-260128', resolution: '720p', ref: true },
};
const ALLOWED_RATIOS = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']);

function err(status: number, code: string, message: string) {
    return NextResponse.json({ error: { code, message, type: 'seedance_adapter_error' } }, { status });
}

/**
 * 从上游错误响应里挖出**最具体**的人类可读原因。
 * service-inference.ai 把真错误层层包成嵌套 JSON(常是 message 字段里再塞一段转义的 JSON),
 * 直接 String(j.error) 会得到 "[object Object]"、客户什么都看不到(实测 user 465 因此盲目重试
 * 60 次)。本函数深度优先递归(限深 + try/catch),把内嵌 JSON 串也解开,返回如
 * "InputTextSensitiveContentDetected: The request failed because the input text may contain ...";
 * 解不出就回退到原始串。见 2026-06-26 诊断。
 */
function digUpstreamError(raw: unknown, depth = 0): string {
    if (depth > 6 || raw == null) return '';
    if (typeof raw === 'string') {
        const s = raw.trim();
        if (!s) return '';
        // 整串就是 JSON → 解开递归
        if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
            try {
                return digUpstreamError(JSON.parse(s), depth + 1) || s;
            } catch {
                return s;
            }
        }
        // 串里内嵌一段 JSON(如 "... failed (400): {\"code\":...}") → 抽出来挖更具体的
        const m = s.match(/\{[\s\S]*\}/);
        if (m) {
            try {
                const inner = digUpstreamError(JSON.parse(m[0]), depth + 1);
                if (inner) return inner;
            } catch {
                /* 内嵌片段非合法 JSON,忽略,用原串 */
            }
        }
        return s;
    }
    if (typeof raw === 'object') {
        const o = raw as Record<string, unknown>;
        if (o.error != null) {
            const inner = digUpstreamError(o.error, depth + 1);
            if (inner) return inner;
        }
        // fail_to_fetch_task 是 service-inference 的外壳码,无信息量,跳过只取内层
        const code = typeof o.code === 'string' && o.code !== 'fail_to_fetch_task' ? o.code : '';
        const msg = o.message != null ? digUpstreamError(o.message, depth + 1) : '';
        if (code && msg) return `${code}: ${msg}`;
        return msg || code || '';
    }
    return '';
}

function extractPrompt(body: Record<string, unknown>): string {
    if (typeof body.prompt === 'string') return body.prompt;
    const content = body.content;
    if (Array.isArray(content)) {
        return content
            .filter((c): c is { type: string; text: string } => {
                const o = c as { type?: unknown; text?: unknown };
                return o?.type === 'text' && typeof o?.text === 'string';
            })
            .map((c) => c.text)
            .join('\n');
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

/** 抽出所有入参图 URL(OpenAI content[].image_url + 顶层 image/images)。 */
function extractImageUrls(body: Record<string, unknown>): string[] {
    const urls: string[] = [];
    const pushUrl = (u: unknown) => {
        if (typeof u === 'string' && u) urls.push(u);
        else if (u && typeof u === 'object' && typeof (u as { url?: unknown }).url === 'string')
            urls.push((u as { url: string }).url);
    };
    // 文档承诺的字段(满血上游原生):顶层 image_url(单张)+ reference_image_urls(数组,@ImageN 按序),放最前保证顺序
    pushUrl(body.image_url);
    if (Array.isArray(body.reference_image_urls)) for (const i of body.reference_image_urls) pushUrl(i);
    const content = body.content;
    if (Array.isArray(content)) {
        for (const c of content) {
            const o = c as { type?: string; image_url?: unknown };
            if (o?.type === 'image_url' || o?.type === 'input_image') pushUrl(o.image_url);
        }
    }
    if (typeof body.image === 'string') urls.push(body.image);
    if (Array.isArray(body.images)) for (const i of body.images) pushUrl(i);
    return urls;
}

/** 抽出所有入参视频 URL(reference_videos / reference_video / content[].video_url)。 */
function extractVideoUrls(body: Record<string, unknown>): string[] {
    const urls: string[] = [];
    const pushUrl = (u: unknown) => {
        if (typeof u === 'string' && u) urls.push(u);
        else if (u && typeof u === 'object' && typeof (u as { url?: unknown }).url === 'string')
            urls.push((u as { url: string }).url);
    };
    pushUrl(body.reference_video);
    if (Array.isArray(body.reference_videos)) for (const v of body.reference_videos) pushUrl(v);
    const content = body.content;
    if (Array.isArray(content)) {
        for (const c of content) {
            const o = c as { type?: string; video_url?: unknown };
            if (o?.type === 'video_url' || o?.type === 'input_video') pushUrl(o.video_url);
        }
    }
    return urls;
}

const fetchSvc = (path: string, auth: string, init: RequestInit = {}) =>
    fetch(`${SVC_BASE}${path}`, {
        ...init,
        headers: { Authorization: auth, Accept: 'application/json', 'User-Agent': UA, ...(init.headers || {}) },
    });

// ⚠️ NO file extension on the R2 key: service-inference.ai 的 asset 抓取器对 URL 末尾
// `.jpg` 扩展名会走坏分支报 "Asset provider error"(`.png` / 无扩展名正常,实测 2026-06-16)。
// 无扩展名 key + R2 对象正确 content-type(picsum 同款)对所有格式都通。
async function uploadCleanMedia(buf: Buffer, mime: string): Promise<string> {
    if (buf.length > 20 * 1024 * 1024) throw new Error('media exceeds 20MB');
    const r2url = await uploadImage(`seedance-ref/${randomUUID()}`, buf, mime);
    console.log('[seedance-adapter] r2 upload', { mime, bytes: buf.length, url: r2url });
    return r2url;
}

/** dep-free 近似尺寸解析(PNG IHDR / JPEG SOF),仅用于报错提示,不做 EXIF 旋转校正。 */
function imageDimensions(buf: Buffer): { w: number; h: number } | null {
    if (
        buf.length >= 24 &&
        buf[0] === 0x89 &&
        buf[1] === 0x50 &&
        buf[2] === 0x4e &&
        buf[3] === 0x47 &&
        buf.toString('latin1', 12, 16) === 'IHDR'
    ) {
        const w = buf.readUInt32BE(16),
            h = buf.readUInt32BE(20);
        return w > 0 && h > 0 ? { w, h } : null;
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
        let i = 2;
        while (i + 9 <= buf.length) {
            if (buf[i] !== 0xff) return null;
            const marker = buf[i + 1];
            if (marker === 0xff) {
                i += 1;
                continue;
            }
            if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
                i += 2;
                continue;
            }
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                const h = buf.readUInt16BE(i + 5),
                    w = buf.readUInt16BE(i + 7);
                return w > 0 && h > 0 ? { w, h } : null;
            }
            i += 2 + buf.readUInt16BE(i + 2);
        }
    }
    return null;
}

/** 拉一个(我们 R2 的)图 URL 量尺寸,失败返回 null。仅报错路径用。 */
async function imageDimsFromUrl(url: string): Promise<{ w: number; h: number } | null> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    try {
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) return null;
        return imageDimensions(Buffer.from(await r.arrayBuffer()));
    } catch {
        return null;
    } finally {
        clearTimeout(t);
    }
}

/**
 * 媒体 URL → 上游 asset 抓取器能吃下的「干净」http 链接。
 * - data URL(image/audio)→ 解码上传我们 R2,返回无扩展名干净链接。
 * - http(s) URL:
 *   - rehostHttp=true(图片):也把字节拉到我们 R2 再返回干净链接。客户图床的 presigned /
 *     长 query / `.jpg` 扩展名 URL 直接喂上游 /v1/assets 会报 "Asset provider error"(502),
 *     统一过一遍我们 R2 即根治;拉取失败回退原 URL(不比原来更糟)。
 *   - rehostHttp=false(音频):原样透传(音频走直链不经 /v1/assets,客户直链本就能用,不动)。
 * kind 仅在 http rehost 拿不到合法 content-type 时决定回退 mime(image→jpeg / video→mp4)。
 */
async function toHttpMediaUrl(
    url: string,
    opts: { rehostHttp?: boolean; kind?: 'image' | 'video' } = {},
): Promise<string> {
    const u = url.trim();
    const m = /^data:((?:image|audio|video)\/[a-z0-9.+-]+);base64,(.+)$/i.exec(u);
    if (m) return uploadCleanMedia(Buffer.from(m[2], 'base64'), m[1]);
    if (!/^https?:\/\//i.test(u)) throw new Error('media must be an http(s) URL or a base64 data URL');
    if (!opts.rehostHttp) return u;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15_000);
        let resp: Response;
        try {
            resp = await fetch(u, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
        } finally {
            clearTimeout(timer);
        }
        if (!resp.ok) throw new Error(`fetch ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length === 0) throw new Error('empty body');
        let mime = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!/^(image|video)\//.test(mime)) mime = opts.kind === 'video' ? 'video/mp4' : 'image/jpeg';
        return await uploadCleanMedia(buf, mime);
    } catch (e) {
        console.warn('[seedance-adapter] http media rehost failed, passing raw url', String(e).slice(0, 140));
        return u;
    }
}

/** 把一张图 / 一段视频传成 service-inference.ai 的 asset,轮询到 completed,返回 asset_id。 */
async function uploadAndReadyAsset(
    auth: string,
    groupId: string,
    httpUrl: string,
    assetType: 'Image' | 'Video' = 'Image',
): Promise<string> {
    const up = await fetchSvc('/v1/assets', auth, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_id: groupId, url: httpUrl, asset_type: assetType, name: 'ref' }),
    });
    const upText = await up.text();
    let upJson: { id?: string; task_id?: string | null; error?: unknown };
    try {
        upJson = JSON.parse(upText);
    } catch {
        throw new Error(`asset upload bad response: ${upText.slice(0, 120)}`);
    }
    const assetId = upJson.id;
    if (!up.ok || !assetId) {
        console.warn('[seedance-adapter] /v1/assets reject', {
            url: httpUrl,
            status: up.status,
            body: upText.slice(0, 200),
        });
        throw new Error(`asset upload failed (${up.status}): ${upText.slice(0, 160)}`);
    }
    // poll until completed (~资产把图下载落地;实测数秒~数十秒)
    const deadline = Date.now() + 75_000;
    while (Date.now() < deadline) {
        const r = await fetchSvc('/v1/assets/get', auth, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ asset_id: assetId, task_id: upJson.task_id ?? null }),
        });
        const j = (await r.json().catch(() => null)) as { status?: string } | null;
        const st = String(j?.status || '').toLowerCase();
        if (st === 'completed') return assetId;
        if (st === 'failed' || st === 'error') throw new Error(`asset ${assetId} failed`);
        await new Promise((res) => setTimeout(res, 3000));
    }
    throw new Error(`asset ${assetId} not ready in time`);
}

/** hc 档的 asset:走新 `/v1/sd/assets`(POST {URL,Name,AssetType} → data.Id;GET /v1/sd/assets/{id} 轮询到
 *  Status=Active),不需要 asset-group。
 *  ⚠️ 2026-07-14:hc 与 fast-260128 的 asset 存储【互不相认】——hc 只认这个新 API 建的 asset,拿旧
 *  `/v1/asset-groups`+`/v1/assets` 建的去 hc generate 会报 `The specified asset ... is not found`(切 hc
 *  后客户 -ref 图生视频报错就是这个);反之 fast-260128 只认旧 API。故 submitVideo 按 map.svc 分流。 */
async function uploadSdAsset(auth: string, httpUrl: string, assetType: 'Image' | 'Video' = 'Image'): Promise<string> {
    // 上游 CreateAsset 有【账号级流控】,突发会回 400 `AccountFlowLimitExceeded`(status_code=1033)——
    // 瞬时的,退避重试几次即恢复(2026-07-14 高频客户 user 465 报障)。非限流错不重试。
    let up!: Response;
    let upText = '';
    for (let attempt = 0; attempt < 4; attempt++) {
        up = await fetchSvc('/v1/sd/assets', auth, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ URL: httpUrl, Name: 'ref', AssetType: assetType }),
        });
        upText = await up.text();
        if (up.ok) break;
        const rateLimited = /AccountFlowLimitExceeded|FlowLimitExceeded|status_code=1033|too many|rate ?limit/i.test(
            upText,
        );
        if (attempt < 3 && rateLimited) {
            await new Promise((r) => setTimeout(r, 2500 * (attempt + 1))); // 2.5s / 5s / 7.5s
            continue;
        }
        break;
    }
    let upJson: { data?: { Id?: string } };
    try {
        upJson = JSON.parse(upText);
    } catch {
        throw new Error(`asset upload bad response: ${upText.slice(0, 120)}`);
    }
    const assetId = upJson.data?.Id;
    if (!up.ok || !assetId) {
        console.warn('[seedance-adapter] /v1/sd/assets reject', {
            url: httpUrl,
            status: up.status,
            body: upText.slice(0, 200),
        });
        throw new Error(`asset upload failed (${up.status}): ${upText.slice(0, 160)}`);
    }
    // poll GET /v1/sd/assets/{id} until Status=Active(实测就绪极快,通常首轮即 Active)
    const deadline = Date.now() + 75_000;
    while (Date.now() < deadline) {
        const r = await fetchSvc(`/v1/sd/assets/${encodeURIComponent(assetId)}`, auth);
        const j = (await r.json().catch(() => null)) as { data?: { Status?: string } } | null;
        const st = String(j?.data?.Status || '').toLowerCase();
        if (st === 'active') return assetId;
        if (st === 'failed' || st === 'error') throw new Error(`asset ${assetId} failed`);
        await new Promise((res) => setTimeout(res, 3000));
    }
    throw new Error(`asset ${assetId} not ready in time`);
}

/** POST 提交:OpenAI-video → service-inference.ai /v1/video/generate。 */
export async function submitVideo(req: NextRequest): Promise<NextResponse> {
    const auth = req.headers.get('authorization') || '';
    if (!/sk-inf-/.test(auth)) return err(401, 'unauthorized', 'invalid credentials for seedance adapter');

    let body: Record<string, unknown>;
    try {
        body = (await req.json()) as Record<string, unknown>;
    } catch {
        return err(400, 'invalid_json', 'request body must be JSON');
    }

    const model = String(body.model || '');
    const map = MODEL_MAP[model];
    if (!map) return err(400, 'model_not_found', `unknown seedance model: ${model}`);

    const prompt = extractPrompt(body);
    if (!prompt) return err(400, 'invalid_request', 'prompt (text) is required');

    // 收集图输入并按 video_config.reference_mode 派角色:
    //   start_frame=首帧(取第1张) / start_end=首尾帧(取前2张) / auto(默认/缺省)=多图参考。
    //   顶层 first_frame/last_frame(legacy 显式指定)优先,与 reference_mode 互斥。
    const refUrls = extractImageUrls(body);
    const refMode = String(
        (body.video_config as { reference_mode?: unknown } | undefined)?.reference_mode || '',
    ).toLowerCase();
    const explicitFirst = typeof body.first_frame === 'string' ? body.first_frame : '';
    const explicitLast = typeof body.last_frame === 'string' ? body.last_frame : '';
    const imageInputs: Array<{ url: string; role: string }> = [];
    if (!explicitFirst && !explicitLast && refMode === 'start_frame' && refUrls.length >= 1) {
        imageInputs.push({ url: refUrls[0], role: 'first_frame' });
    } else if (!explicitFirst && !explicitLast && refMode === 'start_end' && refUrls.length >= 2) {
        imageInputs.push({ url: refUrls[0], role: 'first_frame' }, { url: refUrls[1], role: 'last_frame' });
    } else {
        for (const url of refUrls) imageInputs.push({ url, role: 'reference_image' });
    }
    if (explicitFirst) imageInputs.push({ url: explicitFirst, role: 'first_frame' });
    if (explicitLast) imageInputs.push({ url: explicitLast, role: 'last_frame' });

    // 参考视频(reference_videos / reference_video / content[].video_url):上游 asset_type=Video,@VideoN 按序
    const videoUrls = extractVideoUrls(body);

    // 音频(直链或 base64;上游要求音频需配 ≥1 张图):audio / audio_url / reference_audios[0]
    const audioField = body.audio_url as { url?: unknown } | string | undefined;
    const refAudios = body.reference_audios;
    const firstRefAudio =
        Array.isArray(refAudios) && refAudios.length
            ? typeof refAudios[0] === 'string'
                ? (refAudios[0] as string)
                : typeof (refAudios[0] as { url?: unknown })?.url === 'string'
                  ? (refAudios[0] as { url: string }).url
                  : null
            : null;
    const audioRaw =
        typeof body.audio === 'string'
            ? body.audio
            : typeof audioField === 'string'
              ? audioField
              : typeof audioField?.url === 'string'
                ? audioField.url
                : firstRefAudio;

    // 防串档 + 校验
    if (!map.ref && (imageInputs.length > 0 || videoUrls.length > 0 || audioRaw))
        return err(400, 'invalid_request', `${model} is text-only; use a "-ref" model for image/video/audio inputs`);
    if (map.ref && imageInputs.length === 0 && videoUrls.length === 0)
        return err(
            400,
            'invalid_request',
            `${model} requires a reference (image_url / reference_image_urls / first_frame / last_frame / reference_videos)`,
        );
    if (imageInputs.length > MAX_REF_IMAGES) return err(400, 'invalid_request', `at most ${MAX_REF_IMAGES} images`);
    if (videoUrls.length > MAX_REF_VIDEOS) return err(400, 'invalid_request', `at most ${MAX_REF_VIDEOS} videos`);
    if (audioRaw && !imageInputs.some((i) => i.role === 'reference_image' || i.role === 'first_frame'))
        return err(400, 'invalid_request', 'audio requires at least one reference_image or first_frame');

    // duration:文档用 seconds(常为字符串,如 "15"),兼容 legacy duration
    const durRaw = Number(body.seconds ?? body.duration);
    const duration = Number.isFinite(durRaw) && durRaw >= 1 ? Math.floor(durRaw) : 4;
    let ratio = String(body.ratio || body.aspect_ratio || '16:9');
    if (!ALLOWED_RATIOS.has(ratio)) ratio = '16:9';

    const content: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }];

    // -ref 路径:图片 + 视频都走上游 asset 流(建组→传素材→轮询就绪→asset://),与上游文档一致
    // (reference 媒体走 asset,音频例外走直链)。客户 URL / data URL 先转存我们 R2 拿上游能抓的干净链接,
    // 再传 /v1/assets(asset_type=Image / Video)。⚠️ 早前(#172)误判视频 asset 不可用改成直链 video_url,
    // 实为当时上游 video-asset 暂态 / 测试视频上游解不动;2026-06-26 实测真 mp4 走 asset 流端到端通(传素材
    // completed → generate asset:// 建 task),且直链 video_url 会被上游按内容审核拦(privacy/sensitive),
    // 故视频改回 asset 流。音频仍直链(文档示例即直链,上游不经 /v1/assets)。
    if (map.ref) {
        // hc 走新 /v1/sd/assets(无 group);fast-260128 走旧 /v1/asset-groups+/v1/assets。两套 asset 存储互不相认。
        const useSd = map.svc === 'dreamina-seedance-2-0-hc';
        const uploadAsset = (url: string, type: 'Image' | 'Video', gid?: string) =>
            useSd ? uploadSdAsset(auth, url, type) : uploadAndReadyAsset(auth, gid!, url, type);
        try {
            // 旧档(fast-260128)才需要素材组;hc 的 /v1/sd/assets 无 group。
            let groupId: string | undefined;
            if (!useSd && (imageInputs.length || videoUrls.length)) {
                const grp = await fetchSvc('/v1/asset-groups', auth, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: `sk-${randomUUID().slice(0, 8)}`,
                        description: 'silkroadai seedance ref',
                    }),
                });
                groupId = ((await grp.json().catch(() => null)) as { id?: string } | null)?.id;
                if (!grp.ok || !groupId) throw new Error(`asset-group create failed (${grp.status})`);
            }
            // 图片 asset → asset:// + 角色(reference_image / first_frame / last_frame)
            if (imageInputs.length) {
                const assets = await Promise.all(
                    imageInputs.map(async (inp) => {
                        const r2url = await toHttpMediaUrl(inp.url, { rehostHttp: true });
                        try {
                            return { role: inp.role, id: await uploadAsset(r2url, 'Image', groupId) };
                        } catch (e) {
                            // 上游 asset 拒最常见的是「参考图过小」——上游 /v1/assets 只回笼统
                            // "Asset provider error",客户看不懂(实测 438×320 被拒、448² 通过)。
                            // 这里量出该图尺寸补进错误,给客户可懂的原因,而非让他对着 "Asset provider error" 猜。
                            if (!/Asset provider error/i.test(String(e))) throw e;
                            const dims = await imageDimsFromUrl(r2url);
                            const sz = dims ? `(该参考图 ${dims.w}×${dims.h})` : '';
                            throw new Error(
                                `参考图被上游拒绝${sz}:请换更大更清晰的图 —— 上游对参考图有最小尺寸要求(短边过小会被拒,建议 ≥512px),且需为常见格式(jpg / png)`,
                            );
                        }
                    }),
                );
                for (const a of assets)
                    content.push({ type: 'image_url', image_url: { url: `asset://${a.id}` }, role: a.role });
            }
            // 视频 asset → asset:// + role reference_video
            if (videoUrls.length) {
                const vassets = await Promise.all(
                    videoUrls.map((url) =>
                        toHttpMediaUrl(url, { rehostHttp: true, kind: 'video' }).then((u) =>
                            uploadAsset(u, 'Video', groupId),
                        ),
                    ),
                );
                for (const id of vassets)
                    content.push({ type: 'video_url', video_url: { url: `asset://${id}` }, role: 'reference_video' });
            }
            // 音频:直链(上游不经 /v1/assets)
            if (audioRaw) {
                const audioUrl = await toHttpMediaUrl(audioRaw);
                content.push({ type: 'audio_url', audio_url: { url: audioUrl }, role: 'reference_audio' });
            }
        } catch (e) {
            const msg = String(e);
            console.warn('[seedance-adapter] ref media prep failed', msg);
            // 账号级流控重试仍失败 → 给客户可懂的「稍后重试」,不外抛上游原始 CreateAsset 错误
            if (/AccountFlowLimitExceeded|FlowLimitExceeded|status_code=1033/i.test(msg))
                return err(429, 'rate_limited', '参考图上传上游暂时繁忙(限流),请稍后重试');
            return err(400, 'invalid_request', `reference media processing failed: ${msg.slice(0, 160)}`);
        }
    }

    // Seedance 2.0 原生出声:实测同一 prompt 带音轨(aac)vs 纯画面,上游 completion_tokens
    // 完全相同(50638/50638)→ 音频零额外成本。故默认开(满血定位 + 客户期望有声,且 new-api
    // 按秒固定计费,开关音频客户付费不变),传 generate_audio:false 可关;给了参考音频则强制开。
    const generateAudio = body.generate_audio !== false || !!audioRaw;
    const svcBody = {
        model: map.svc,
        content,
        duration,
        resolution: map.resolution,
        ratio,
        generate_audio: generateAudio,
        watermark: false,
    };
    console.log('[seedance-adapter] submit', {
        model,
        svc: map.svc,
        resolution: map.resolution,
        ref: map.ref,
        images: imageInputs.length,
        videos: videoUrls.length,
        roles: imageInputs.map((i) => i.role),
        genAudio: generateAudio,
        refAudio: !!audioRaw,
        duration,
        ratio,
    });

    let upstream: Response;
    try {
        upstream = await fetchSvc('/v1/video/generate', auth, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(svcBody),
        });
    } catch (e) {
        return err(502, 'upstream_unreachable', `service-inference.ai unreachable: ${String(e)}`);
    }
    const text = await upstream.text();
    let j: { task?: { id?: string }; error?: unknown } | null;
    try {
        j = JSON.parse(text) as { task?: { id?: string } };
    } catch {
        j = null;
    }
    const taskId = j?.task?.id;
    if (!upstream.ok || !taskId) {
        console.warn('[seedance-adapter] submit failed', upstream.status, text.slice(0, 300));
        return err(
            upstream.status >= 400 ? upstream.status : 502,
            'upstream_error',
            (digUpstreamError(text) || 'submit failed').slice(0, 300),
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
    if (x === 'queued') return 'queued';
    return 'in_progress';
}

/** ISO 串 / 毫秒 / 秒 → Unix 秒整数(new-api responseTask.created_at 是 int64,不能给字符串)。 */
function toEpoch(v: unknown): number {
    if (typeof v === 'number') return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
    if (typeof v === 'string') {
        const t = Date.parse(v);
        if (Number.isFinite(t)) return Math.floor(t / 1000);
    }
    return Math.floor(Date.now() / 1000);
}

/**
 * 成片转存到我们 R2:拉上游视频字节 → 上传 R2 → 返回我们域名的公网永久直链。
 * 解决三件事:(1) 藏上游 service-inference.ai 域名;(2) R2 永久不过期(上游直链是临时的);
 * (3) 公网可直接浏览器打开(不像 new-api 的 result_url 要带 key)。
 * key 用上游任务 id(确定性 → 重复轮询不会重复上传)。任何失败返回 null,调用方回退上游直链。
 */
export async function mirrorVideoToR2(videoUrl: string, auth: string, id: string): Promise<string | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
        const vid = await fetch(videoUrl, {
            headers: { Authorization: auth, 'User-Agent': UA },
            signal: ctrl.signal,
        });
        if (!vid.ok) return null;
        const len = Number(vid.headers.get('content-length') || 0);
        if (len > 200 * 1024 * 1024) return null; // 太大不转存,回退上游
        const buf = Buffer.from(await vid.arrayBuffer());
        if (buf.length === 0) return null;
        const ct = vid.headers.get('content-type') || 'video/mp4';
        const ext = ct.includes('webm') ? 'webm' : 'mp4';
        return await uploadImage(`seedance-video/${id}.${ext}`, buf, ct.startsWith('video/') ? ct : 'video/mp4');
    } catch (e) {
        console.warn('[seedance-adapter] r2 video mirror failed', String(e).slice(0, 160));
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** GET 轮询:service-inference.ai /v1/video/tasks/{id} → OpenAI-video 形。 */
export async function pollVideo(req: NextRequest, id: string): Promise<NextResponse> {
    const auth = req.headers.get('authorization') || '';
    let upstream: Response;
    try {
        upstream = await fetchSvc(`/v1/video/tasks/${encodeURIComponent(id)}`, auth);
    } catch (e) {
        return err(502, 'upstream_unreachable', String(e));
    }
    const text = await upstream.text();
    let j: { task?: Record<string, unknown> } | null;
    try {
        j = JSON.parse(text) as { task?: Record<string, unknown> };
    } catch {
        j = null;
    }
    const task = j?.task;
    if (!upstream.ok || !task) {
        return err(
            upstream.status >= 400 ? upstream.status : 502,
            'upstream_error',
            (digUpstreamError(text) || 'poll failed').slice(0, 300),
        );
    }
    const status = mapStatus(task.status);
    const outputs = Array.isArray(task.outputs) ? (task.outputs as unknown[]) : [];
    let videoUrl = typeof outputs[0] === 'string' ? (outputs[0] as string) : null;
    const failReason = task.error ? (typeof task.error === 'string' ? task.error : JSON.stringify(task.error)) : '';
    // 完成出片后转存我们 R2,返回公网永久直链(藏上游 + 不过期 + 浏览器可开);R2 故障回退上游直链。
    let r2Fallback = false;
    if (status === 'completed' && videoUrl) {
        const mirrored = await mirrorVideoToR2(videoUrl, auth, id);
        if (mirrored) videoUrl = mirrored;
        else r2Fallback = true;
    }
    return NextResponse.json(
        {
            id,
            task_id: id,
            object: 'video',
            model: task.model,
            status,
            progress: status === 'completed' || status === 'failed' ? 100 : 50,
            created_at: toEpoch(task.created_at),
            completed_at: task.completed_at ? toEpoch(task.completed_at) : null,
            seconds: task.duration_seconds != null ? String(task.duration_seconds) : '',
            video_url: videoUrl ?? undefined,
            url: videoUrl ?? undefined,
            fail_reason: failReason || undefined,
        },
        { status: 200, headers: r2Fallback ? { 'X-Silkroadai-R2-Fallback': '1' } : {} },
    );
}

/**
 * GET 内容代理:GET /seedance-adapter/v1/videos/{id}/content —— new-api 的 result_url
 * 内容代理会回抓本端点(渠道 base_url 走公网 443 域名,过 new-api SSRF 白名单),
 * 本端点查上游任务拿 outputs[0] 视频直链,拉取后流式回(隐藏上游 URL,给客户稳定可用的
 * result_url)。客户也可直接用轮询响应里的 `data.data.video_url`(等价)。
 */
export async function streamContent(req: NextRequest, id: string): Promise<Response> {
    const auth = req.headers.get('authorization') || '';
    let taskRes: Response;
    try {
        taskRes = await fetchSvc(`/v1/video/tasks/${encodeURIComponent(id)}`, auth);
    } catch (e) {
        return err(502, 'upstream_unreachable', String(e));
    }
    const task = ((await taskRes.json().catch(() => null)) as { task?: { outputs?: unknown[] } } | null)?.task;
    const outputs = Array.isArray(task?.outputs) ? (task.outputs as unknown[]) : [];
    const videoUrl = typeof outputs[0] === 'string' ? (outputs[0] as string) : null;
    if (!videoUrl) return err(409, 'not_ready', 'video not available yet');

    let vid: Response;
    try {
        vid = await fetch(videoUrl, { headers: { 'User-Agent': UA } });
    } catch (e) {
        return err(502, 'upstream_unreachable', `fetch video failed: ${String(e)}`);
    }
    if (!vid.ok || !vid.body) return err(502, 'upstream_error', `video fetch ${vid.status}`);
    const headers: Record<string, string> = { 'Content-Type': vid.headers.get('content-type') || 'video/mp4' };
    const len = vid.headers.get('content-length');
    if (len) headers['Content-Length'] = len;
    return new Response(vid.body, { status: 200, headers });
}
