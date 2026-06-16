/**
 * Seedance 海外满血 适配器核心逻辑(OpenAI-video ↔ service-inference.ai 翻译)。
 *
 * new-api 把视频请求转发到上游的路径实测是 /v1/videos(提交)+ /v1/videos/{id}(轮询),
 * 不是 /v1/video/generations。为稳妥两个路径都挂(见 app/seedance-adapter/...),
 * 共用本文件的 submitVideo / pollVideo。
 *
 * 计费由 new-api 按「请求 duration × ModelPrice × GroupRatio」算,与本适配器无关。
 * 见 seedance-overseas-adaptor-brief.md。
 */
import { NextRequest, NextResponse } from 'next/server';

const SVC_BASE = process.env.SEEDANCE_INFERENCE_BASE_URL || 'https://model.service-inference.ai';
const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** 客户/new-api 模型名 → service-inference.ai 真实 model + resolution 档。 */
const MODEL_MAP: Record<string, { svc: string; resolution: string }> = {
    'dreamina-seedance-2-0-480p': { svc: 'dreamina-seedance-2-0-260128', resolution: '480p' },
    'dreamina-seedance-2-0-720p': { svc: 'dreamina-seedance-2-0-260128', resolution: '720p' },
    'dreamina-seedance-2-0-1080p': { svc: 'dreamina-seedance-2-0-260128', resolution: '1080p' },
    'dreamina-seedance-2-0-fast-480p': { svc: 'dreamina-seedance-2-0-fast-260128', resolution: '480p' },
    'dreamina-seedance-2-0-fast-720p': { svc: 'dreamina-seedance-2-0-fast-260128', resolution: '720p' },
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

    const durRaw = Number(body.duration);
    const duration = Number.isFinite(durRaw) && durRaw >= 1 ? Math.floor(durRaw) : 4;
    let ratio = String(body.ratio || body.aspect_ratio || '16:9');
    if (!ALLOWED_RATIOS.has(ratio)) ratio = '16:9';

    const svcBody = {
        model: map.svc,
        content: [{ type: 'text', text: prompt }],
        duration,
        resolution: map.resolution,
        ratio,
        generate_audio: body.generate_audio === true,
        watermark: false,
    };
    console.log('[seedance-adapter] submit', { model, svc: map.svc, resolution: map.resolution, duration, ratio });

    let upstream: Response;
    try {
        upstream = await fetch(`${SVC_BASE}/v1/video/generate`, {
            method: 'POST',
            headers: {
                Authorization: auth,
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'User-Agent': UA,
            },
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
        upstream = await fetch(`${SVC_BASE}/v1/video/tasks/${encodeURIComponent(id)}`, {
            headers: { Authorization: auth, Accept: 'application/json', 'User-Agent': UA },
        });
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
