/**
 * 「火山」渠道视频适配器(2026-07-29)。
 *
 * 与 cn/global/promax 三档不同:volc 上游是【火山方舟原生协议】provider
 * (POST /doubao/api/v3/contents/generations/tasks,body {model, content[], resolution, ...},
 *  查询 GET .../tasks/{id} → {id, status, content:{video_url}, usage})。近乎透传,不做
 * OpenAI 形翻译。返回【火山直链】(content.video_url 原样透传,不转存 R2)——volc 渠道特性。
 *
 * 平台级共享上游 key(env,非按客户):全平台 volc 走同一 provider 账号(operator 决策,
 * 与真人认证同 provider 不同端点)。计费仍走 usage.completion_tokens(与 cn 一致)。
 *
 * env(lazy 读):
 *   ENTERPRISE_VOLC_VIDEO_BASE_URL  例 http://121.11.236.57:3000
 *   ENTERPRISE_VOLC_VIDEO_KEY       例 sk-xxxx(Bearer)
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { VOLC_MODEL } from './cn-adapter';

function err(status: number, code: string, message: string) {
    return NextResponse.json({ error: { code, message, type: 'seedance_volc_adapter_error' } }, { status });
}

function getConfig(): { base: string; key: string } | null {
    const base = process.env.ENTERPRISE_VOLC_VIDEO_BASE_URL;
    const key = process.env.ENTERPRISE_VOLC_VIDEO_KEY;
    if (!base || !key) return null;
    return { base: base.replace(/\/$/, ''), key };
}

const ALLOWED_RATIOS = new Set(['16:9', '9:16', '4:3', '3:4', '1:1', '21:9']);

/** 对客 task id 伪装(2026-08-03):上游 provider(new-api 形)把火山真实 cgt- id 映射成了
 *  自己的 task_ id,但客户脚本按火山官方契约校验 id 必须 cgt- 开头 → 在本适配器边界做
 *  确定性双向映射:上游 task_X ↔ 对客 cgt-X。伪装后的 id 同时是 seedance_video_tasks 主键,
 *  proxy 归属门 / 计费 / dashboard 全链路一致。非 task_ 前缀的上游 id 原样透传(轮询侧有
 *  404 回退兜底);历史 task_ 形 id 轮询不转换,老任务继续可查。 */
function disguiseTaskId(upstreamId: string): string {
    return upstreamId.startsWith('task_') ? `cgt-${upstreamId.slice(5)}` : upstreamId;
}
function undisguiseTaskId(clientId: string): string {
    return clientId.startsWith('cgt-') ? `task_${clientId.slice(4)}` : clientId;
}

/** 从客户 body 抽 content 数组(火山方舟形);无则用 prompt 兜底成单条 text。 */
function buildContent(body: Record<string, unknown>): unknown[] | null {
    if (Array.isArray(body.content) && body.content.length > 0) return body.content;
    if (typeof body.prompt === 'string' && body.prompt.trim()) {
        return [{ type: 'text', text: body.prompt }];
    }
    return null;
}

/** 提交:火山方舟原生 body 透传 provider(model 锁 doubao-seedance-2.0)。
 *  resolution 由 caller(proxy 短名解析)传入;返回归一形 {id, task_id, status} 供 handleSubmit 记账。 */
export async function submitVolcVideo(
    body: Record<string, unknown>,
    resolution: '480p' | '720p' | '1080p' | '4k',
    duration: number,
): Promise<NextResponse> {
    const cfg = getConfig();
    if (!cfg) return err(503, 'temporarily_unavailable', '火山渠道未配置,请联系服务方');

    const content = buildContent(body);
    if (!content) return err(400, 'invalid_request', 'prompt (text) or content is required');

    let ratio = String(body.ratio || body.aspect_ratio || '16:9');
    if (!ALLOWED_RATIOS.has(ratio)) ratio = '16:9';

    const upstreamBody: Record<string, unknown> = {
        model: VOLC_MODEL,
        content,
        resolution,
        ratio,
        duration,
        generate_audio: body.generate_audio !== false,
    };
    if (typeof body.camera_fixed === 'boolean') upstreamBody.camera_fixed = body.camera_fixed;
    if (typeof body.seed === 'number') upstreamBody.seed = body.seed;
    if (typeof body.watermark === 'boolean') upstreamBody.watermark = body.watermark;
    if (typeof body.return_last_frame === 'boolean') upstreamBody.return_last_frame = body.return_last_frame;

    let upstream: Response;
    try {
        upstream = await fetch(`${cfg.base}/doubao/api/v3/contents/generations/tasks`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(upstreamBody),
            signal: AbortSignal.timeout(30000),
        });
    } catch (e) {
        console.warn('[volc-adapter] submit unreachable', { err: String(e) });
        return err(502, 'upstream_unreachable', 'upstream temporarily unavailable, please retry');
    }
    const text = await upstream.text();
    let j: { id?: string; status?: string } | null;
    try {
        j = JSON.parse(text) as { id?: string; status?: string };
    } catch {
        j = null;
    }
    const taskId = j?.id;
    if (!upstream.ok || !taskId) {
        console.warn('[volc-adapter] submit failed', { status: upstream.status, body: text.slice(0, 2000) });
        return err(upstream.status >= 400 ? upstream.status : 502, 'upstream_error', 'upstream rejected the request');
    }
    const clientTaskId = disguiseTaskId(taskId);
    return NextResponse.json(
        { id: clientTaskId, task_id: clientTaskId, object: 'video', model: VOLC_MODEL, status: 'queued', progress: 0 },
        { status: 200 },
    );
}

function mapStatus(s: unknown): 'queued' | 'in_progress' | 'completed' | 'failed' {
    const x = String(s || '').toLowerCase();
    if (['completed', 'success', 'succeeded'].includes(x)) return 'completed';
    if (['failed', 'error', 'cancelled', 'canceled', 'expired'].includes(x)) return 'failed';
    if (x === 'queued' || x === 'pending') return 'queued';
    return 'in_progress';
}

/** 轮询:GET provider task → 归一形 {status, video_url, usage}。video_url 是火山直链,原样透传。
 *  入参 id 是对客形(cgt-X):打上游前还原成 task_X;404 时用原始 id 回退一次
 *  (兜住上游本来就返 cgt- 形 id 被我们原样透传的罕见情形)。响应回显对客形 id。 */
export async function pollVolcVideo(id: string): Promise<NextResponse> {
    const cfg = getConfig();
    if (!cfg) return err(503, 'temporarily_unavailable', '火山渠道未配置,请联系服务方');

    const fetchTask = (taskId: string) =>
        fetch(`${cfg.base}/doubao/api/v3/contents/generations/tasks/${encodeURIComponent(taskId)}`, {
            headers: { Authorization: `Bearer ${cfg.key}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(20000),
        });

    const upstreamId = undisguiseTaskId(id);
    let upstream: Response;
    try {
        upstream = await fetchTask(upstreamId);
        if (upstream.status === 404 && upstreamId !== id) upstream = await fetchTask(id);
    } catch (e) {
        console.warn('[volc-adapter] poll unreachable', { id, err: String(e) });
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
        console.warn('[volc-adapter] poll failed', { id, status: upstream.status, body: text.slice(0, 2000) });
        return err(upstream.status >= 400 ? upstream.status : 502, 'upstream_error', 'upstream rejected the request');
    }
    const status = mapStatus(j.status);
    const contentObj = (j.content ?? undefined) as { video_url?: unknown; last_frame_url?: unknown } | undefined;
    const videoUrl = typeof contentObj?.video_url === 'string' ? contentObj.video_url : undefined;
    const lastFrameUrl = typeof contentObj?.last_frame_url === 'string' ? contentObj.last_frame_url : undefined;
    const failReason =
        status === 'failed'
            ? String((j.error as { message?: string } | undefined)?.message || j.message || 'generation failed')
            : '';
    if (failReason) console.warn('[volc-adapter] task failed upstream', { id, fail_reason: failReason });
    const usage = (j.usage ?? undefined) as Record<string, unknown> | undefined;
    return NextResponse.json(
        {
            id,
            task_id: id,
            object: 'video',
            status,
            progress: status === 'completed' || status === 'failed' ? 100 : 50,
            video_url: videoUrl,
            url: videoUrl,
            last_frame_url: lastFrameUrl,
            fail_reason: failReason || undefined,
            usage: status === 'completed' ? usage : undefined,
        },
        { status: 200 },
    );
}
