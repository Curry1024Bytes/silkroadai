/**
 * 「火山」渠道视频适配器 —— 上游 = 筷子 AI 开放平台(aiopenapi.kuaizi.cn,2026-08-17 换上游)。
 *
 * 背景:volc 渠道原先打 new-api 形 provider(`ENTERPRISE_VOLC_VIDEO_*`,见 git history 的
 * volc-adapter.ts)。本次换成筷子开放平台 —— 它对齐【火山方舟官方 contents/generations/tasks】
 * 契约(POST 建任务 → GET 轮询),我们对客的火山方舟形接口因此近乎直通,不做协议翻译:
 *   提交 POST {BASE}/ai-open-platform-api/api/v3/contents/generations/tasks
 *   轮询 GET  {BASE}/ai-open-platform-api/api/v3/contents/generations/tasks/{id}
 *   鉴权 Authorization: Bearer <平台 ApiKey>(kz-…)
 *
 * 与上一版 provider 的差异(全部在本文件内吸收,proxy/计费/对客契约不变):
 *  - 【四模型】pro / fast / mini / 2.5(上游收方舟 Model ID);原 provider 只有单模型。
 *  - 【task id】上游返 `kz-cgt-…` 前缀;客户脚本按火山官方契约校验 `cgt-` 开头 → 在本适配器
 *    边界做确定性双向映射 kz-cgt-X ↔ cgt-X(同 #308 的 task_ ↔ cgt- 伪装,换了前缀而已)。
 *  - 【成片 URL】上游给两条:`content.video_url`(方舟原始签名直链,~24h 过期)与
 *    `content.kz_video_url`(上游转存的持久链)。对客【优先 video_url】—— 保持客户只看到
 *    火山官方 VOD 域名(operator 的「真实感」要求),且 kz_video_url 路径含 `ai_openapi/`
 *    + 上游 task id,会泄露上游身份。仅 video_url 缺失时兜底用 kz_video_url。
 *  - 【无取消端点】筷子文档只有建/查两个接口 → cancel 返 null(proxy 侧 best-effort,不阻断删除)。
 *
 * 平台级共享上游 key(env,非按客户):全平台 volc 走同一账号(operator 决策,同上一版)。
 * 计费仍走 usage.completion_tokens × 官方挂牌费率 × 客户 discount(默认 1 = 官方原价)。
 *
 * env(lazy 读,便于改 key 不重启 + 可测):
 *   ENTERPRISE_KUAIZI_BASE_URL  缺省 https://aiopenapi.kuaizi.cn
 *   ENTERPRISE_KUAIZI_KEY       平台 ApiKey(kz-…),Bearer 携带
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { type SeedanceVariant } from './cn-adapter';
import { classifyUpstreamError } from './upstream-error';

const DEFAULT_BASE = 'https://aiopenapi.kuaizi.cn';
const TASKS_PATH = '/ai-open-platform-api/api/v3/contents/generations/tasks';

/** 上游任务 id 前缀(筷子平台形);对客伪装成火山官方 `cgt-`。 */
const UPSTREAM_ID_PREFIX = 'kz-cgt-';
const CLIENT_ID_PREFIX = 'cgt-';

function err(status: number, code: string, message: string) {
    return NextResponse.json({ error: { code, message, type: 'seedance_volc_adapter_error' } }, { status });
}

export function getKuaiziConfig(): { base: string; key: string } | null {
    const key = process.env.ENTERPRISE_KUAIZI_KEY;
    if (!key) return null;
    return { base: (process.env.ENTERPRISE_KUAIZI_BASE_URL || DEFAULT_BASE).replace(/\/$/, ''), key };
}

/** 上游 kz-cgt-X → 对客 cgt-X。非该前缀原样透传(轮询侧有 404 回退兜底)。 */
function disguiseTaskId(upstreamId: string): string {
    return upstreamId.startsWith(UPSTREAM_ID_PREFIX)
        ? CLIENT_ID_PREFIX + upstreamId.slice(UPSTREAM_ID_PREFIX.length)
        : upstreamId;
}
/** 对客 cgt-X → 上游 kz-cgt-X(打上游前还原)。 */
function undisguiseTaskId(clientId: string): string {
    return clientId.startsWith(CLIENT_ID_PREFIX) && !clientId.startsWith(UPSTREAM_ID_PREFIX)
        ? UPSTREAM_ID_PREFIX + clientId.slice(CLIENT_ID_PREFIX.length)
        : clientId;
}

/** 火山官方输出宽高比枚举(上游同集);非法值回落 16:9(v1 面宽松语义,ark 面 proxy 已前置 400)。 */
const ALLOWED_RATIOS = new Set(['16:9', '9:16', '4:3', '3:4', '1:1', '21:9', 'adaptive']);

/** 对客模型名(火山方舟点分形,volc 渠道专用)→ 上游方舟 Model ID + 档位。
 *  ⚠️ 点分形是刻意的:连字符形(doubao-seedance-2-0-260128 等)已被 ark-format 的
 *  normalizeArkModel 归一到国内版短名 seedance-2-0 系(走 cn 渠道),两套命名不能相撞。 */
export const VOLC_MODELS: Record<string, { upstream: string; variant: SeedanceVariant }> = {
    'doubao-seedance-2.0': { upstream: 'doubao-seedance-2-0-260128', variant: 'pro' },
    'doubao-seedance-2.0-fast': { upstream: 'doubao-seedance-2-0-fast-260128', variant: 'fast' },
    'doubao-seedance-2.0-mini': { upstream: 'doubao-seedance-2-0-mini-260615', variant: 'mini' },
    'doubao-seedance-2.5': { upstream: 'doubao-seedance-2-5-260628', variant: '2.5' },
};

/** 各档位支持的分辨率(上游「分档参数矩阵」):2.5 仅 480p/720p;4k 仅 pro。 */
export const VOLC_RESOLUTIONS: Record<SeedanceVariant, ReadonlyArray<'480p' | '720p' | '1080p' | '4k'>> = {
    pro: ['480p', '720p', '1080p', '4k'],
    fast: ['480p', '720p', '1080p'],
    mini: ['480p', '720p', '1080p'],
    '2.5': ['480p', '720p'],
    // proMax 系不在 volc 渠道(海外档,走 cn-adapter);列全只为类型完整。
    promax: [],
    'promax-fast': [],
    'promax-mini': [],
    'promax-2.5': [],
};

/** 单次输入素材上限(上游「分档参数矩阵」):2.5 放宽到 30/10/10,2.0 系 9/3/3。 */
export function volcRefLimits(variant: SeedanceVariant): { images: number; videos: number; audios: number } {
    return variant === '2.5' ? { images: 30, videos: 10, audios: 10 } : { images: 9, videos: 3, audios: 3 };
}

/** 从客户 body 抽 content 数组(火山方舟形);无则用 prompt 兜底成单条 text。 */
function buildContent(body: Record<string, unknown>): unknown[] | null {
    if (Array.isArray(body.content) && body.content.length > 0) return body.content;
    if (typeof body.prompt === 'string' && body.prompt.trim()) {
        return [{ type: 'text', text: body.prompt }];
    }
    return null;
}

export interface KuaiziSubmitOptions {
    /** 对客模型名(VOLC_MODELS 的 key);caller(proxy 短名解析)已校验。 */
    clientModel: string;
    resolution: '480p' | '720p' | '1080p' | '4k';
    /** 秒数,或 -1 = 智能时长。 */
    duration: number;
}

/**
 * 提交:火山方舟原生 body 透传上游(model 换成上游方舟 Model ID)。
 * 返回归一形 {id, task_id, model, status} 供 proxy.handleSubmit 记账 —— id 已伪装成 cgt- 形。
 */
export async function submitVolcVideo(body: Record<string, unknown>, opts: KuaiziSubmitOptions): Promise<NextResponse> {
    const cfg = getKuaiziConfig();
    if (!cfg) return err(503, 'temporarily_unavailable', '火山渠道未配置,请联系服务方');

    const spec = VOLC_MODELS[opts.clientModel];
    if (!spec) return err(400, 'model_not_found', `unknown model: ${opts.clientModel}`);

    const content = buildContent(body);
    if (!content) return err(400, 'invalid_request', 'prompt (text) or content is required');

    let ratio = String(body.ratio || body.aspect_ratio || '16:9');
    if (!ALLOWED_RATIOS.has(ratio)) ratio = '16:9';

    const upstreamBody: Record<string, unknown> = {
        model: spec.upstream,
        content,
        resolution: opts.resolution,
        ratio,
        duration: opts.duration,
        generate_audio: body.generate_audio !== false,
    };
    if (typeof body.seed === 'number') upstreamBody.seed = body.seed;
    if (typeof body.watermark === 'boolean') upstreamBody.watermark = body.watermark;
    if (typeof body.return_last_frame === 'boolean') upstreamBody.return_last_frame = body.return_last_frame;
    // 上游支持但我们只做「有则透传」的火山官方字段(校验交上游,避免我们的白名单落后于上游)。
    if (typeof body.safety_identifier === 'string' && body.safety_identifier)
        upstreamBody.safety_identifier = body.safety_identifier.slice(0, 64);
    if (typeof body.output_format === 'string' && ['mp4', 'mov'].includes(body.output_format.toLowerCase()))
        upstreamBody.output_format = body.output_format.toLowerCase();
    if (
        typeof body.omni_reference_task_type === 'string' &&
        ['auto', 'reference', 'edit', 'extend'].includes(body.omni_reference_task_type)
    )
        upstreamBody.omni_reference_task_type = body.omni_reference_task_type;
    if (Array.isArray(body.tools) && body.tools.length) upstreamBody.tools = body.tools;
    // 版权放行:只透传 ips(上游明确【不接受】ip_mode,由平台统一控制)。
    const mod = body.moderation_options as { ips?: unknown } | undefined;
    if (mod && Array.isArray(mod.ips) && mod.ips.length) upstreamBody.moderation_options = { ips: mod.ips };

    let upstream: Response;
    try {
        upstream = await fetch(`${cfg.base}${TASKS_PATH}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(upstreamBody),
            signal: AbortSignal.timeout(30000),
        });
    } catch (e) {
        console.warn('[kuaizi-adapter] submit unreachable', { err: String(e) });
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
        // 上游原始报错体(含 request_id / 上游域名)只落日志;对客给【分类后】文案(#271)。
        const cls = classifyUpstreamError(text, upstream.status);
        console.warn('[kuaizi-adapter] submit failed', {
            model: opts.clientModel,
            upstream_model: spec.upstream,
            status: upstream.status,
            category: cls.category,
            body: text.slice(0, 2000),
        });
        return err(upstream.status >= 400 ? upstream.status : 502, 'upstream_error', cls.message);
    }
    const clientTaskId = disguiseTaskId(taskId);
    return NextResponse.json(
        {
            id: clientTaskId,
            task_id: clientTaskId,
            object: 'video',
            model: opts.clientModel,
            status: 'queued',
            progress: 0,
        },
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

/**
 * 轮询:GET 上游任务 → 归一形 {status, video_url, last_frame_url, usage}。
 * 入参 id 是对客形(cgt-X):打上游前还原成 kz-cgt-X;404 时用原始 id 回退一次
 * (兜住上一版 provider 遗留的 task_/cgt- 形 id,以及上游直接返 cgt- 的罕见情形)。
 */
export async function pollVolcVideo(id: string): Promise<NextResponse> {
    const cfg = getKuaiziConfig();
    if (!cfg) return err(503, 'temporarily_unavailable', '火山渠道未配置,请联系服务方');

    const fetchTask = (taskId: string) =>
        fetch(`${cfg.base}${TASKS_PATH}/${encodeURIComponent(taskId)}`, {
            headers: { Authorization: `Bearer ${cfg.key}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(20000),
        });

    const upstreamId = undisguiseTaskId(id);
    let upstream: Response;
    try {
        upstream = await fetchTask(upstreamId);
        if (upstream.status === 404 && upstreamId !== id) upstream = await fetchTask(id);
    } catch (e) {
        console.warn('[kuaizi-adapter] poll unreachable', { id, err: String(e) });
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
        const cls = classifyUpstreamError(text, upstream.status);
        console.warn('[kuaizi-adapter] poll failed', {
            id,
            status: upstream.status,
            category: cls.category,
            body: text.slice(0, 2000),
        });
        return err(upstream.status >= 400 ? upstream.status : 502, 'upstream_error', cls.message);
    }
    const status = mapStatus(j.status);
    const contentObj = (j.content ?? undefined) as
        | { video_url?: unknown; kz_video_url?: unknown; last_frame_url?: unknown }
        | undefined;
    // 优先方舟原始直链(客户只看到火山官方 VOD 域名);缺失才兜底上游转存链。
    const videoUrl =
        typeof contentObj?.video_url === 'string'
            ? contentObj.video_url
            : typeof contentObj?.kz_video_url === 'string'
              ? contentObj.kz_video_url
              : undefined;
    const lastFrameUrl = typeof contentObj?.last_frame_url === 'string' ? contentObj.last_frame_url : undefined;
    const failReason =
        status === 'failed'
            ? String((j.error as { message?: string } | undefined)?.message || j.message || 'generation failed')
            : '';
    if (failReason) console.warn('[kuaizi-adapter] task failed upstream', { id, fail_reason: failReason });
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

/** 取消任务:筷子开放平台【无取消/删除端点】(文档只有建任务 / 查任务两条)。
 *  返回 null = 不支持 —— proxy 侧 best-effort,不阻断客户删除本地任务记录。 */
export async function cancelVolcVideo(_id: string): Promise<Response | null> {
    return null;
}
