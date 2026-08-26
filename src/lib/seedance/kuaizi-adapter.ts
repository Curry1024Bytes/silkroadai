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
import { rememberVolcId, toUpstreamId } from '@/lib/enterprise/volc-id-map';
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

// 上游 `vendor_task_id` = 渠道侧原始任务号。落方舟时它就是**火山官方任务 id**(cgt-…),
// 也正是我们要对客暴露的号 —— 见 waitForVendorTaskId。

/** 火山原生任务号的形态(方舟 id)。非该形态 = 任务没落方舟。 */
function isArkTaskId(v: unknown): v is string {
    return typeof v === 'string' && v.startsWith('cgt-');
}

const VENDOR_TASK_POLL_MS = 2000;
function vendorWaitMs(): number {
    const raw = Number(process.env.ENTERPRISE_VOLC_VENDOR_WAIT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/**
 * 提交后压住等**渠道侧任务号**出现,判断这条任务到底落没落火山方舟。
 *
 * 落方舟时 `vendor_task_id` 就是**火山官方任务号**(cgt-…),正是我们要对客暴露的号;
 * 落别家时是那家自己的号(tsk-…)。上游受理后才给得出 —— 实测 ~10.5s(不必等出片)。
 * 这段等待消不掉,只能我们压着(operator 2026-08-19 拍板)。
 *
 * 返回 `{ vendorId, isArk }`;**只有超时才抛**(上游已受理,任务会照跑并计入我们的上游
 * 账单 → 我们自己吃掉,客户不收费)。落没落方舟由调用方决定怎么处理 —— 见 submitVolcVideo。
 */
async function waitForVendorTaskId(
    upstreamId: string,
    fetchTask: (id: string) => Promise<Response>,
    clientModel: string,
): Promise<{ vendorId: string; isArk: boolean }> {
    const deadline = Date.now() + vendorWaitMs();
    for (;;) {
        try {
            const res = await fetchTask(upstreamId);
            const j = (await res.json()) as {
                vendor_task_id?: unknown;
                status?: unknown;
                error?: unknown;
                message?: unknown;
            };
            const vendor = j.vendor_task_id;
            if (typeof vendor === 'string' && vendor) {
                return { vendorId: vendor, isArk: isArkTaskId(vendor) };
            }
            // 任务已终态失败却还没给任务号(素材不合格等)→ 立刻把**真实原因**返回,
            // 别空等满 60 秒再给一句笼统的「受理超时」。2026-08-26 实测:引用了一个
            // 入库失败的素材,客户等 60s 只拿到 upstream_timeout,看不出到底哪错了。
            if (mapStatus(j.status) === 'failed') {
                const reason = String(
                    (j.error as { message?: string } | undefined)?.message || j.message || 'generation failed',
                );
                throw new EarlyTaskFailure(classifyUpstreamError(reason, 400).message);
            }
        } catch (e) {
            // 任务已确定失败 —— 不是抖动,直接抛出去(带真实原因)。
            if (e instanceof EarlyTaskFailure) throw e;
            // 轮询本身抖动不算失败,继续等到 deadline。
            console.warn('[kuaizi-adapter] vendor task id poll error', { upstreamId, err: String(e) });
        }
        if (Date.now() + VENDOR_TASK_POLL_MS > deadline) {
            console.error('[kuaizi-adapter] vendor task id 超时(上游已受理,对客报错 → 我们自己吃掉这条)', {
                model: clientModel,
                upstreamId,
                waitedMs: vendorWaitMs(),
            });
            throw new VendorTaskTimeoutError();
        }
        await new Promise((r) => setTimeout(r, VENDOR_TASK_POLL_MS));
    }
}

class VendorTaskTimeoutError extends Error {}
/** 等任务号期间任务就已失败 —— 带着上游的真实原因短路出去。 */
class EarlyTaskFailure extends Error {}

/** 严格模式:落非方舟直接 502 拒掉(缺省【关】,operator 2026-08-19 决定先放开)。 */
function requireArk(): boolean {
    return process.env.ENTERPRISE_VOLC_REQUIRE_ARK === '1';
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

/**
 * 我们自己消费 / 翻译掉的键 —— 不能再原样透传给上游(会撞上游校验或语义重复)。
 * 不在这张表里的一律透传(见 submitVolcVideo 尾部的「原生透传」)。
 */
const CONSUMED_BODY_KEYS = new Set([
    // 我们显式构造的
    'model',
    'content',
    'prompt',
    'resolution',
    'duration',
    'seconds',
    'ratio',
    'aspect_ratio',
    'generate_audio',
    'moderation_options',
    // 参考输入的各种别名 —— proxy 已把它们并进 content,再透传上游会重复
    'first_frame',
    'last_frame',
    'image',
    'image_url',
    'images',
    'image_urls',
    'reference_image_urls',
    'video',
    'video_url',
    'videos',
    'reference_video',
    'reference_videos',
    'audio',
    'audio_url',
    'audios',
    'reference_audios',
    'video_config',
]);

/**
 * 认识但**故意不透传**的键。
 * `callback_url`:上游会直接回调客户,回调体里带的是上游自己的任务号(kz-cgt-…),
 * 既拆穿了原生形态也泄露了中间层(#271)。要支持得我们自己中转,另起一件事做。
 */
const NEVER_FORWARD_KEYS = new Set(['callback_url']);

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

    // ratio:**客户没传就不注入**,由上游按任务类型自己定。
    //
    // 此前硬塞 16:9 —— 这会主动打断「视频续写 / 视频编辑」:那两类任务上游只接受
    // ratio=adaptive,客户按火山官方用法不传 ratio,我们却替他填了 16:9 → 上游拒。
    // (2026-08-26 客户实测报障;与 images 面 `aspect_ratio=auto` 那次是同一个教训:
    //  「不指定」是一种有意义的取值,不能被我们的默认值吃掉。)
    const ratioRaw = body.ratio ?? body.aspect_ratio;
    const ratio = ratioRaw == null || ratioRaw === '' ? undefined : String(ratioRaw);

    const upstreamBody: Record<string, unknown> = {
        model: spec.upstream,
        content,
        resolution: opts.resolution,
        duration: opts.duration,
        generate_audio: body.generate_audio !== false,
    };
    // 显式传了才注入;非法值仍按 v1 面的宽松口径纠正成 16:9(ark 面有独立的严格校验)。
    if (ratio !== undefined) upstreamBody.ratio = ALLOWED_RATIOS.has(ratio) ? ratio : '16:9';
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

    // 其余字段【一律透传】给上游 —— 本渠道卖的是「原生火山」,能不能用由火山判,不由我们判。
    //
    // 起因:逐个列白名单必然落后于上游。2026-08-26 实测发现 5 个火山官方字段被我们吃掉:
    //   bitrate_mode / camera_fixed / service_tier / priority / callback_url
    // 其中 camera_fixed 我们【文档里明确写了支持】,客户传了以为生效,实际根本没到上游。
    // 改成反向白名单:只挡我们自己消费或翻译掉的键,其余原样过去。
    const extras: string[] = [];
    for (const [k, v] of Object.entries(body)) {
        if (CONSUMED_BODY_KEYS.has(k) || k in upstreamBody || v === undefined) continue;
        if (NEVER_FORWARD_KEYS.has(k)) {
            console.warn('[kuaizi-adapter] 该字段需要单独适配,未透传', { field: k });
            continue;
        }
        upstreamBody[k] = v;
        extras.push(k);
    }
    if (extras.length) console.log('[kuaizi-adapter] 透传客户额外字段', { fields: extras });

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
    // 对客 id = **火山官方任务号**(压着等上游受理后给出)。拿不到就报错,不吐非火山的号。
    const fetchTask = (tid: string) =>
        fetch(`${cfg.base}${TASKS_PATH}/${encodeURIComponent(tid)}`, {
            headers: { Authorization: `Bearer ${cfg.key}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(20000),
        });
    const fallbackTaskId = disguiseTaskId(taskId);
    let vendor: { vendorId: string; isArk: boolean };
    try {
        vendor = await waitForVendorTaskId(taskId, fetchTask, opts.clientModel);
    } catch (e) {
        if (e instanceof EarlyTaskFailure) {
            console.warn('[kuaizi-adapter] 任务在拿到任务号前就失败', {
                model: opts.clientModel,
                upstreamId: taskId,
                reason: e.message,
            });
            return err(400, 'upstream_error', e.message);
        }
        if (e instanceof VendorTaskTimeoutError) {
            return err(504, 'upstream_timeout', '上游受理超时(未返回任务编号)—— 请稍后重新提交');
        }
        throw e;
    }

    let clientTaskId: string;
    if (vendor.isArk) {
        clientTaskId = vendor.vendorId;
    } else {
        // 上游把这条任务路由到了【非方舟】渠道 —— 它给的号是那家自己的(tsk-…),不是火山号。
        //
        // 2026-08-19 实测:路由会漂,同一模型同参数 45 分钟内就从 cgt- 变成 tsk-,
        // 所以静态名单靠不住,只能每条实时判。operator 决定【先放行、同时向上游反馈】,
        // 因此这里不拒掉,而是**降级回火山方舟形的伪装号**(#398 之前的行为):
        //   - 不能把 tsk- 直接给客户 —— 破坏火山 SDK 的形态预期,还暴露了第三方(#271)
        //   - 落方舟的任务仍拿【真】火山号,#398 的收益不受影响
        // 严格模式 ENTERPRISE_VOLC_REQUIRE_ARK=1 恢复直接 502(上游修好后用它守回归)。
        console.error('[kuaizi-adapter] NON_ARK_ROUTE 任务未落火山方舟(已降级放行)', {
            model: opts.clientModel,
            upstreamId: taskId,
            vendor_task_id: vendor.vendorId,
            clientTaskId: fallbackTaskId,
        });
        if (requireArk()) {
            return err(
                502,
                'upstream_error',
                '该任务未由火山方舟受理,已为您中止 —— 请稍后重试或联系服务方',
                'non_ark_route',
            );
        }
        clientTaskId = fallbackTaskId;
    }
    // 火山号 → 上游号(轮询时换回去打上游)。降级形与上游形相同,remember 会自行跳过。
    await rememberVolcId(clientTaskId, fallbackTaskId, 'task');
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

    // 对客 id 现在是火山官方任务号 → 先换回上游号(存量任务查不到映射,原样返回,
    // 再走 undisguise 老路径 —— 宽进,老 id 继续能用)。
    const mapped = await toUpstreamId(id);
    const upstreamId = undisguiseTaskId(mapped);
    let upstream: Response;
    try {
        upstream = await fetchTask(upstreamId);
        if (upstream.status === 404 && upstreamId !== id) upstream = await fetchTask(id);
        if (upstream.status === 404 && mapped !== id && mapped !== upstreamId) upstream = await fetchTask(mapped);
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
    // ⚠️ 不再对客暴露 vendor_task_id —— 客户拿到的 `id` 本身就是火山官方任务号了
    // (提交时压着等来的,见 waitForVendorTaskId),再多一个键反而不原生:
    // 火山官方响应里根本没有 vendor_task_id 这个字段。仍落日志供排查。
    const vendorRaw = j.vendor_task_id;
    if (typeof vendorRaw === 'string' && vendorRaw && !isArkTaskId(vendorRaw)) {
        console.warn('[kuaizi-adapter] non-ark vendor task', { id, vendor_task_id: vendorRaw });
    }
    // 上游【已推导】的元数据 —— 必须优先于我们库里存的提交参数。
    //
    // 典型:客户传 duration=-1(智能时长),我们却一直回显 -1;上游在任务完成时会给出
    // 模型真正选的秒数(实测提交 -1 → 完成时 duration=5)。ratio 同理:客户不传时
    // 我们库里存的是补的 '16:9',而上游给的是实际采用的比例。
    // (2026-08-26 客户报障:「-1 推导响应给的还是 -1」。)
    const upstreamMeta: Record<string, unknown> = {};
    if (typeof j.duration === 'number') upstreamMeta.duration = j.duration;
    if (typeof j.ratio === 'string' && j.ratio) upstreamMeta.ratio = j.ratio;
    if (typeof j.resolution === 'string' && j.resolution) upstreamMeta.resolution = j.resolution;

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
            ...upstreamMeta,
        },
        { status: 200 },
    );
}

/** 取消任务:筷子开放平台【无取消/删除端点】(文档只有建任务 / 查任务两条)。
 *  返回 null = 不支持 —— proxy 侧 best-effort,不阻断客户删除本地任务记录。 */
export async function cancelVolcVideo(_id: string): Promise<Response | null> {
    return null;
}
