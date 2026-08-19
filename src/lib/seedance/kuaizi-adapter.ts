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
 *    火山官方 TOS 域名(operator 的「真实感」要求;实测 ark-acg-cn-beijing.tos-cn-beijing.volces.com
 *    + X-Tos-Signature —— 是火山【对象存储 TOS】,不是 cn 渠道那条 VOD/volcvideo.com,两者别混),
 *    且 kz_video_url 路径含 `ai_openapi/`
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

/** category:机器可读分类,供调用方判定终态 / 瞬时(见 upstream-error.isTerminalTaskFailure)。 */
function err(status: number, code: string, message: string, category?: string) {
    return NextResponse.json(
        { error: { code, message, type: 'seedance_volc_adapter_error', ...(category ? { category } : {}) } },
        { status },
    );
}

export function getKuaiziConfig(): { base: string; key: string } | null {
    const key = process.env.ENTERPRISE_KUAIZI_KEY;
    if (!key) return null;
    return { base: (process.env.ENTERPRISE_KUAIZI_BASE_URL || DEFAULT_BASE).replace(/\/$/, ''), key };
}

/**
 * 上游 `vendor_task_id`(渠道侧原始任务 id,文档 v1.3 起 running 阶段即返回)→ 对客透传。
 *
 * **默认全量透传**(operator 2026-08-19 拍板:下游就是要这个号)。
 *
 * ⚠️ 已知取舍 —— 它**不总是**火山原生 id:上游按渠道路由,字节方舟渠道给 `cgt-…`
 * (= 火山官方 id,可拿去跟火山对账),**其它三方渠道给该渠道自己的 id**
 * (实测 `tsk-ghubt0mgm8impt83`,同一 model/分辨率昨天还是 cgt- 形)。后者:
 *  ① 拿去跟火山对账查不到 —— 对「对账」这个用途无效;
 *  ② 形态上暴露「这单没走火山官方直连」,与 #271 隐藏中间商的口径有张力。
 * operator 知悉后仍要求透传,故默认放行;`ENTERPRISE_VENDOR_TASK_ID_ARK_ONLY=1`
 * 可收紧成「只透 cgt- 形」(逃生阀,改 env 即可,不用发版)。
 *
 * 注:成片域名与本字段无关 —— 两种形态实测都返回火山 TOS
 * (ark-acg-cn-beijing.tos-cn-beijing.volces.com);cn 渠道那条才是 VOD/volcvideo.com。
 */
function publicVendorTaskId(raw: unknown): string | undefined {
    if (typeof raw !== 'string' || !raw) return undefined;
    if (process.env.ENTERPRISE_VENDOR_TASK_ID_ARK_ONLY === '1' && !raw.startsWith('cgt-')) return undefined;
    return raw;
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

/**
 * 【2026-08-19 暂时下架】fast / mini 两档。
 *
 * 实测(每档一条 480p/4s 真机任务,mini 两次独立复现):
 *   doubao-seedance-2.0    → vendor_task_id = cgt-…  ✅ 落火山方舟
 *   doubao-seedance-2.5    → vendor_task_id = cgt-…  ✅ 落火山方舟
 *   doubao-seedance-2.0-fast → vendor_task_id = tsk-…  ❌ 非方舟渠道
 *   doubao-seedance-2.0-mini → vendor_task_id = tsk-…  ❌ 非方舟渠道
 * 切分是确定性的(贵的两档走火山、便宜的两档走别家),不是随机负载均衡。
 *
 * 本渠道的产品定义是「完全原生的火山体验」,而这两档的成片根本不是火山出的 ——
 * 属货不对板,先下架,待上游把我们这条线锁死在方舟渠道后再放开。
 * 逃生阀 `ENTERPRISE_VOLC_ALLOW_LOW_TIERS=1`:上游修好后先用它验证 vendor_task_id
 * 确实回到 cgt-,再删掉这一段。
 */
const WITHDRAWN_VOLC_MODELS = new Set(['doubao-seedance-2.0-fast', 'doubao-seedance-2.0-mini']);

/** 该 volc 模型是否已下架(见 WITHDRAWN_VOLC_MODELS)。 */
export function isVolcModelWithdrawn(model: string): boolean {
    if (process.env.ENTERPRISE_VOLC_ALLOW_LOW_TIERS === '1') return false;
    return WITHDRAWN_VOLC_MODELS.has(String(model || '').toLowerCase());
}

/** 下架档位的对客文案(proxy 与 adapter 两处共用,口径一致)。 */
export const WITHDRAWN_VOLC_HINT = '该档位暂停服务 —— 请改用 doubao-seedance-2.0 或 doubao-seedance-2.5';

/** 各档位支持的分辨率(上游「分档参数矩阵」):2.5 仅 480p/720p;4k 仅 pro。 */
export const VOLC_RESOLUTIONS: Record<SeedanceVariant, ReadonlyArray<'480p' | '720p' | '1080p' | '4k'>> = {
    pro: ['480p', '720p', '1080p', '4k'],
    fast: ['480p', '720p', '1080p'],
    mini: ['480p', '720p', '1080p'],
    // 上游 2026-08-18(文档 v1.2)放开 1080p;4k 仍不支持(实测错误文案
    // 「invalid resolution "4k" for mode seedance2.5, allowed: 480p, 720p, 1080p」)。
    '2.5': ['480p', '720p', '1080p'],
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
    // 兜底(主闸在 proxy 的 resolveEnterpriseModel):下架档位不打上游,避免白花钱。
    if (isVolcModelWithdrawn(opts.clientModel)) return err(400, 'model_unavailable', WITHDRAWN_VOLC_HINT);

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
        return err(upstream.status >= 400 ? upstream.status : 502, 'upstream_error', cls.message, cls.category);
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
        return err(upstream.status >= 400 ? upstream.status : 502, 'upstream_error', cls.message, cls.category);
    }
    const status = mapStatus(j.status);
    const contentObj = (j.content ?? undefined) as
        | { video_url?: unknown; kz_video_url?: unknown; last_frame_url?: unknown }
        | undefined;
    // 优先方舟原始直链(客户只看到火山官方 TOS 域名);缺失才兜底上游转存链。
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
    // 渠道侧原始任务 id:全量落日志(排查/对账用),对客只透火山原生形(见 publicVendorTaskId)。
    const vendorRaw = j.vendor_task_id;
    if (typeof vendorRaw === 'string' && vendorRaw && !vendorRaw.startsWith('cgt-')) {
        console.log('[kuaizi-adapter] non-ark vendor task', { id, vendor_task_id: vendorRaw });
    }
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
            vendor_task_id: publicVendorTaskId(vendorRaw),
        },
        { status: 200 },
    );
}

/** 取消任务:筷子开放平台【无取消/删除端点】(文档只有建任务 / 查任务两条)。
 *  返回 null = 不支持 —— proxy 侧 best-effort,不阻断客户删除本地任务记录。 */
export async function cancelVolcVideo(_id: string): Promise<Response | null> {
    return null;
}
