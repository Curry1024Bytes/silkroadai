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
const MAX_REF_IMAGES = 4;

/** 客户/new-api 模型名 → service-inference.ai model + resolution + 是否参考档(-ref)。 */
const MODEL_MAP: Record<string, { svc: string; resolution: string; ref: boolean }> = {
    // 无参考(文生):Phase 1
    'dreamina-seedance-2-0-480p': { svc: 'dreamina-seedance-2-0-260128', resolution: '480p', ref: false },
    'dreamina-seedance-2-0-720p': { svc: 'dreamina-seedance-2-0-260128', resolution: '720p', ref: false },
    'dreamina-seedance-2-0-1080p': { svc: 'dreamina-seedance-2-0-260128', resolution: '1080p', ref: false },
    'dreamina-seedance-2-0-fast-480p': { svc: 'dreamina-seedance-2-0-fast-260128', resolution: '480p', ref: false },
    'dreamina-seedance-2-0-fast-720p': { svc: 'dreamina-seedance-2-0-fast-260128', resolution: '720p', ref: false },
    // 带参考图(图生/参考生):Phase 2 —— WITH_REF 费率(更便宜)
    'dreamina-seedance-2-0-480p-ref': { svc: 'dreamina-seedance-2-0-260128', resolution: '480p', ref: true },
    'dreamina-seedance-2-0-720p-ref': { svc: 'dreamina-seedance-2-0-260128', resolution: '720p', ref: true },
    'dreamina-seedance-2-0-1080p-ref': { svc: 'dreamina-seedance-2-0-260128', resolution: '1080p', ref: true },
    'dreamina-seedance-2-0-fast-480p-ref': { svc: 'dreamina-seedance-2-0-fast-260128', resolution: '480p', ref: true },
    'dreamina-seedance-2-0-fast-720p-ref': { svc: 'dreamina-seedance-2-0-fast-260128', resolution: '720p', ref: true },
};
const ALLOWED_RATIOS = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']);

function err(status: number, code: string, message: string) {
    return NextResponse.json({ error: { code, message, type: 'seedance_adapter_error' } }, { status });
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

const fetchSvc = (path: string, auth: string, init: RequestInit = {}) =>
    fetch(`${SVC_BASE}${path}`, {
        ...init,
        headers: { Authorization: auth, Accept: 'application/json', 'User-Agent': UA, ...(init.headers || {}) },
    });

/** data URL(image/audio)→ 转存 R2 拿 http URL;http(s) URL 原样返回(上游只收 http 链接)。 */
async function toHttpMediaUrl(url: string): Promise<string> {
    const m = /^data:((?:image|audio)\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url.trim());
    if (!m) {
        if (/^https?:\/\//i.test(url)) return url;
        throw new Error('media must be an http(s) URL or a base64 data URL');
    }
    const mime = m[1];
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 20 * 1024 * 1024) throw new Error('image exceeds 20MB');
    // ⚠️ NO file extension on the R2 key: service-inference.ai 的 asset 抓取器对
    // URL 末尾 `.jpg` 扩展名会走坏分支报 "Asset provider error"(`.png` / 无扩展名正常,
    // 实测 2026-06-16)。无扩展名 key + R2 对象正确 content-type(picsum 同款)对所有格式都通。
    const r2url = await uploadImage(`seedance-ref/${randomUUID()}`, buf, mime);
    console.log('[seedance-adapter] r2 upload', { mime, bytes: buf.length, url: r2url });
    return r2url;
}

/** 把一张 http 图传成 service-inference.ai 的 asset,轮询到 completed,返回 asset_id。 */
async function uploadAndReadyAsset(auth: string, groupId: string, httpUrl: string): Promise<string> {
    const up = await fetchSvc('/v1/assets', auth, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_id: groupId, url: httpUrl, asset_type: 'Image', name: 'ref' }),
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

    // 收集图输入(带角色):参考图(reference_image)+ 首帧(first_frame)+ 尾帧(last_frame)
    const imageInputs: Array<{ url: string; role: string }> = extractImageUrls(body).map((url) => ({
        url,
        role: 'reference_image',
    }));
    if (typeof body.first_frame === 'string' && body.first_frame)
        imageInputs.push({ url: body.first_frame, role: 'first_frame' });
    if (typeof body.last_frame === 'string' && body.last_frame)
        imageInputs.push({ url: body.last_frame, role: 'last_frame' });
    // 音频(直链或 base64;上游要求音频需配 ≥1 张图)
    const audioField = body.audio_url as { url?: unknown } | string | undefined;
    const audioRaw =
        typeof body.audio === 'string'
            ? body.audio
            : typeof audioField === 'string'
              ? audioField
              : typeof audioField?.url === 'string'
                ? audioField.url
                : null;

    // 防串档 + 校验
    if (!map.ref && (imageInputs.length > 0 || audioRaw))
        return err(400, 'invalid_request', `${model} is text-only; use a "-ref" model for image/audio inputs`);
    if (map.ref && imageInputs.length === 0)
        return err(400, 'invalid_request', `${model} requires an image (image / first_frame / last_frame)`);
    if (imageInputs.length > MAX_REF_IMAGES) return err(400, 'invalid_request', `at most ${MAX_REF_IMAGES} images`);
    if (audioRaw && !imageInputs.some((i) => i.role === 'reference_image' || i.role === 'first_frame'))
        return err(400, 'invalid_request', 'audio requires at least one reference_image or first_frame');

    const durRaw = Number(body.duration);
    const duration = Number.isFinite(durRaw) && durRaw >= 1 ? Math.floor(durRaw) : 4;
    let ratio = String(body.ratio || body.aspect_ratio || '16:9');
    if (!ALLOWED_RATIOS.has(ratio)) ratio = '16:9';

    const content: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }];

    // -ref 路径:每个媒体转 http(data URL→R2)→ 图建素材组并行上传+轮询拿 asset:// + 角色;音频走直链
    if (map.ref) {
        try {
            const grp = await fetchSvc('/v1/asset-groups', auth, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: `sk-${randomUUID().slice(0, 8)}`,
                    description: 'silkroadai seedance ref',
                }),
            });
            const groupId = ((await grp.json().catch(() => null)) as { id?: string } | null)?.id;
            if (!grp.ok || !groupId) throw new Error(`asset-group create failed (${grp.status})`);
            const assets = await Promise.all(
                imageInputs.map(async (inp) => ({
                    role: inp.role,
                    id: await uploadAndReadyAsset(auth, groupId, await toHttpMediaUrl(inp.url)),
                })),
            );
            for (const a of assets)
                content.push({ type: 'image_url', image_url: { url: `asset://${a.id}` }, role: a.role });
            if (audioRaw) {
                const audioUrl = await toHttpMediaUrl(audioRaw);
                content.push({ type: 'audio_url', audio_url: { url: audioUrl }, role: 'reference_audio' });
            }
        } catch (e) {
            console.warn('[seedance-adapter] ref media prep failed', String(e));
            return err(400, 'invalid_request', `reference media processing failed: ${String(e).slice(0, 160)}`);
        }
    }

    const svcBody = {
        model: map.svc,
        content,
        duration,
        resolution: map.resolution,
        ratio,
        generate_audio: body.generate_audio === true || !!audioRaw,
        watermark: false,
    };
    console.log('[seedance-adapter] submit', {
        model,
        svc: map.svc,
        resolution: map.resolution,
        ref: map.ref,
        images: imageInputs.length,
        roles: imageInputs.map((i) => i.role),
        audio: !!audioRaw,
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
            String((j?.error as string) || text || 'submit failed').slice(0, 300),
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
            String(text || 'poll failed').slice(0, 300),
        );
    }
    const status = mapStatus(task.status);
    const outputs = Array.isArray(task.outputs) ? (task.outputs as unknown[]) : [];
    const videoUrl = typeof outputs[0] === 'string' ? (outputs[0] as string) : null;
    const failReason = task.error ? (typeof task.error === 'string' ? task.error : JSON.stringify(task.error)) : '';
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
        { status: 200 },
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
