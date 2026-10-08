/**
 * 「火山」渠道视频适配器 —— 上游 = service-inference.ai `/v2` doubao-sd-max 线(2026-09-22 换上游)。
 *
 * 历史:volc 渠道先后走过 new-api 形 provider(727 系)→ 筷子开放平台(2026-08-17,kuaizi-adapter.ts,
 * 已删)。与筷子合作终止后换到 service-inference.ai:
 *   提交 POST {BASE}/v2/video/generate        → { task: { id: "mvt-…", status } }
 *   轮询 GET  {BASE}/v2/video/tasks/{id}      → { task: { …, metadata: <火山方舟原生任务体> } }
 *   鉴权 Authorization: Bearer <sk-inf-v1-…>
 *
 * 实测(2026-09-22,四档各一条真金任务)要点,全部在本文件内吸收,proxy / 计费 / 对客契约不变:
 *  - 【四档全落真火山方舟】`task.metadata` 就是方舟原生任务体(`id: cgt-…`、`content.video_url` 为
 *    ark-acg-cn-beijing.tos-cn-beijing.volces.com 直链、duration/ratio/resolution/seed/framespersecond/
 *    generate_audio/execution_expires_after/created_at/updated_at/usage …),token 数与筷子时代逐字一致。
 *    筷子时代 fast/mini 漂到非方舟渠道的问题在这家不存在 → 两档恢复在售(下架名单改由 env 控制)。
 *  - 【task id】上游受理号 `mvt-…`(唯一可轮询句柄)。对客沿用「提交即自造火山方舟形号
 *    `cgt-YYYYMMDDHHMMSS-xxxxx`」(makeArkTaskId)+ volc_id_map 映射(对客号 → mvt-)供轮询换回。
 *    方舟真号(metadata.id)仅落日志供内部对账,不对客(#271 同口径:客户的 id 本身就是火山型号)。
 *  - 【状态】preparing(素材上传中,尚无 metadata)/ pending / processing / completed / failed。
 *    失败原因在 `task.error`(**字符串**,含 TOS 内部噪音如 `RequestID=… EC=`,对客前剥掉)。
 *  - 【resolution 必填】文档写缺省 720p,实测缺失 → 400 `Missing required field: resolution`;
 *    我们本就总传,记录在此以防将来改成"不传交上游定"。
 *  - 【未知字段原样转给方舟】文档写"忽略",实测 camera_fixed / service_tier 在 fast t2v 被方舟 400 拒
 *    → 反向白名单「其余一律透传、能不能用由火山判」语义与筷子时代完全一致。
 *  - 【错误信封】`{error:{message,type:'proxy_error'},request_id}`,方舟原始报错以**转义 JSON 且常被截断**
 *    的形式嵌在 message 里(外壳码 `fail_to_fetch_task` 无信息量)—— 见 unwrapUpstreamError。
 *  - 【无取消端点】cancel 返 null(proxy 侧 best-effort,不阻断删除)。
 *  - 【素材】上游只有「传 URL 拿句柄 / 按 id 查」两条,无 list / delete / 组 → 素材库不再接上游,
 *    volc 客户与其它渠道一样走平台素材库(R2 + 行级归属);生成时 `asset://` 由 proxy 解析成 R2 直链
 *    发上游,上游自动经 `preparing` 上传(实测 ~4s)。
 *
 * 平台级共享上游 key(env,非按客户);客户在 enterprise_upstream_keys(region='volc')配了自己的
 * `sk-inf-` key 时优先用它(customerVolcUpstreamKey),否则回落平台 env key。
 * 计费仍走 usage.completion_tokens × 官方挂牌费率 × 客户 discount。
 *
 * env(lazy 读,便于改 key 不重启 + 可测):
 *   ENTERPRISE_VOLC_UPSTREAM_BASE_URL   缺省 https://model.service-inference.ai
 *   ENTERPRISE_VOLC_UPSTREAM_KEY        平台 key(sk-inf-v1-…),Bearer 携带
 *   ENTERPRISE_VOLC_MODEL_{PRO,FAST,MINI,25}  上游模型名覆盖(缺省 = 方舟 id + `-max`;
 *                                        文档说部分套餐看到的名字不带 -max,以 GET /v1/models 为准)
 *   ENTERPRISE_VOLC_WITHDRAWN_MODELS    逗号分隔的对客模型名,临时下架用(缺省空 = 四档全在售)
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { type SeedanceVariant } from './cn-adapter';
import { rememberVolcId, toUpstreamId } from '@/lib/enterprise/volc-id-map';
import {
    SVCINF_DEFAULT_BASE,
    SVCINF_KEY_PREFIX,
    makeArkTaskId,
    pollSvcinfTask,
    submitSvcinfTask,
    type SvcinfConfig,
} from './svcinf-client';
import { DraftTaskError, extractDraftTaskRef, resolveDraftTaskArkId, rewriteDraftTaskId } from './draft-task';

// 提交/轮询信封、错误拆包、失败原因脱敏 → svcinf-client.ts(cn 2.5 480p 单档也用同一上游,2026-09-22 抽出)。
export { unwrapUpstreamError } from './svcinf-client';

const ERR_TYPE = 'seedance_volc_adapter_error';
const LOG = 'volc-adapter';

/** category:机器可读分类,供调用方判定终态 / 瞬时(见 upstream-error.isTerminalTaskFailure)。 */
function err(status: number, code: string, message: string, category?: string) {
    return NextResponse.json(
        { error: { code, message, type: ERR_TYPE, ...(category ? { category } : {}) } },
        { status },
    );
}

/** 火山渠道走 `/v2`(直传 URL 素材经 preparing 自动上传 + 支持预传句柄)。 */
export function getVolcUpstreamConfig(overrideKey?: string): SvcinfConfig | null {
    const key = overrideKey || process.env.ENTERPRISE_VOLC_UPSTREAM_KEY;
    if (!key) return null;
    return {
        base: (process.env.ENTERPRISE_VOLC_UPSTREAM_BASE_URL || SVCINF_DEFAULT_BASE).replace(/\/$/, ''),
        key,
        api: 'v2',
    };
}

/** 客户 upstream key 行里存的是真实上游 key 还是占位符?(占位 = 走平台 env key) */
export function customerVolcUpstreamKey(upstreamKey: string | undefined | null): string | undefined {
    return upstreamKey?.startsWith(SVCINF_KEY_PREFIX) ? upstreamKey : undefined;
}

/** 火山官方输出宽高比枚举(上游同集);非法值回落 16:9(v1 面宽松语义,ark 面 proxy 已前置 400)。 */
const ALLOWED_RATIOS = new Set(['16:9', '9:16', '4:3', '3:4', '1:1', '21:9', 'adaptive']);

/**
 * 对客模型名(火山方舟点分形,volc 渠道专用)→ 火山方舟官方 Model ID(`upstream`,对客文档展示用、
 * 也是 ark 面原生 id 归一的目标)+ 档位。
 *  ⚠️ 点分形是刻意的:连字符形(doubao-seedance-2-0-260128 等)已被 ark-format 的
 *  normalizeArkModel 归一到国内版短名 seedance-2-0 系(走 cn 渠道),两套命名不能相撞。
 *  真正发给 service-inference.ai 的模型名见 upstreamModelName(缺省 = upstream + '-max')。
 */
export const VOLC_MODELS: Record<string, { upstream: string; variant: SeedanceVariant }> = {
    'doubao-seedance-2.0': { upstream: 'doubao-seedance-2-0-260128', variant: 'pro' },
    'doubao-seedance-2.0-fast': { upstream: 'doubao-seedance-2-0-fast-260128', variant: 'fast' },
    'doubao-seedance-2.0-mini': { upstream: 'doubao-seedance-2-0-mini-260615', variant: 'mini' },
    'doubao-seedance-2.5': { upstream: 'doubao-seedance-2-5-260628', variant: '2.5' },
};

const MODEL_ENV: Partial<Record<SeedanceVariant, string>> = {
    pro: 'ENTERPRISE_VOLC_MODEL_PRO',
    fast: 'ENTERPRISE_VOLC_MODEL_FAST',
    mini: 'ENTERPRISE_VOLC_MODEL_MINI',
    '2.5': 'ENTERPRISE_VOLC_MODEL_25',
};

/** 发给 service-inference.ai 的模型名:env 覆盖,否则方舟 id + `-max`(本平台套餐实测形态)。 */
export function upstreamModelName(clientModel: string): string | null {
    const spec = VOLC_MODELS[clientModel];
    if (!spec) return null;
    const envKey = MODEL_ENV[spec.variant];
    const override = envKey ? process.env[envKey]?.trim() : '';
    return override || `${spec.upstream}-max`;
}

/**
 * 临时下架名单(env `ENTERPRISE_VOLC_WITHDRAWN_MODELS`,逗号分隔对客模型名,缺省空)。
 *
 * 筷子时代 fast / mini 因实测不落方舟被硬编码下架;新上游四档实测全落方舟(metadata.id 皆 cgt-),
 * 两档恢复在售。保留这道闸只为运维:上游某档出问题时改 env 即可下架、不必发版。
 */
export function isVolcModelWithdrawn(model: string): boolean {
    const raw = process.env.ENTERPRISE_VOLC_WITHDRAWN_MODELS || '';
    if (!raw.trim()) return false;
    const set = new Set(
        raw
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean),
    );
    return set.has(String(model || '').toLowerCase());
}

/** 下架档位的对客文案(proxy 与 adapter 两处共用,口径一致)。 */
export const WITHDRAWN_VOLC_HINT = '该档位暂停服务 —— 请改用 doubao-seedance-2.0 或 doubao-seedance-2.5';

/** 各档位支持的分辨率(上游模型表,2026-09-22 实测:fast/mini 传 1080p → 400):
 *  pro 480p/720p/1080p/4k;fast、mini 仅 480p/720p;2.5 480p/720p/1080p(无 4k)。 */
export const VOLC_RESOLUTIONS: Record<SeedanceVariant, ReadonlyArray<'480p' | '720p' | '1080p' | '4k'>> = {
    pro: ['480p', '720p', '1080p', '4k'],
    fast: ['480p', '720p'],
    mini: ['480p', '720p'],
    '2.5': ['480p', '720p', '1080p'],
    // proMax 系不在 volc 渠道(海外档,走 cn-adapter);列全只为类型完整。
    promax: [],
    'promax-fast': [],
    'promax-mini': [],
    'promax-2.5': [],
};

/** 单次输入素材上限(上游素材限制表):2.5 放宽到 30/10/10,2.0 系 9/3/3。 */
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
 * `callback_url`:上游会直接回调客户,回调体是上游自己的任务对象(mvt- 号 + metadata),
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

export interface VolcSubmitOptions {
    /** 客户自己的上游 key(sk-inf-…);缺省用平台 env key。 */
    upstreamKey?: string;
    /** 对客模型名(VOLC_MODELS 的 key);caller(proxy 短名解析)已校验。 */
    clientModel: string;
    resolution: '480p' | '720p' | '1080p' | '4k';
    /** 秒数,或 -1 = 智能时长。 */
    duration: number;
}

/**
 * 提交:火山方舟原生 body 透传上游(model 换成 service-inference.ai 的模型名)。
 * 返回归一形 {id, task_id, model, status} 供 proxy.handleSubmit 记账 —— id 已是 cgt- 形。
 */
export async function submitVolcVideo(body: Record<string, unknown>, opts: VolcSubmitOptions): Promise<NextResponse> {
    const cfg = getVolcUpstreamConfig(opts.upstreamKey);
    if (!cfg) return err(503, 'temporarily_unavailable', '火山渠道未配置,请联系服务方');

    const spec = VOLC_MODELS[opts.clientModel];
    const upstreamModel = upstreamModelName(opts.clientModel);
    if (!spec || !upstreamModel) return err(400, 'model_not_found', `unknown model: ${opts.clientModel}`);
    // 兜底(主闸在 proxy 的 resolveEnterpriseModel):下架档位不打上游,避免白花钱。
    if (isVolcModelWithdrawn(opts.clientModel)) return err(400, 'model_unavailable', WITHDRAWN_VOLC_HINT);

    let content = buildContent(body);
    if (!content) return err(400, 'invalid_request', 'prompt (text) or content is required');
    // 样片出正片(draft_task,2026-10-08):客户样片号 → 方舟真号(上游不翻译 mvt- 号)。
    let draftRef: { id: string } | null = null;
    try {
        draftRef = extractDraftTaskRef(body);
    } catch (e) {
        if (e instanceof DraftTaskError) return err(400, 'invalid_request', e.message);
        throw e;
    }
    if (draftRef) {
        const r = await resolveDraftTaskArkId(cfg, draftRef.id, LOG);
        if (!r.ok) return err(r.status, r.code, r.message);
        content = rewriteDraftTaskId(content, r.arkId);
    }

    // ratio:**客户没传就不注入**,由上游按任务类型自己定。
    // 硬塞 16:9 会主动打断「视频续写 / 视频编辑」:那两类任务上游只接受 ratio=adaptive,客户按火山
    // 官方用法不传 ratio,我们却替他填了 16:9 → 上游拒。「不指定」是一种有意义的取值。
    const ratioRaw = body.ratio ?? body.aspect_ratio;
    const ratio = ratioRaw == null || ratioRaw === '' ? undefined : String(ratioRaw);

    const upstreamBody: Record<string, unknown> = {
        model: upstreamModel,
        content,
        resolution: opts.resolution, // 上游必填(实测缺失 400),我们总传
        duration: opts.duration,
        generate_audio: body.generate_audio !== false,
    };
    // 样片出正片:时长 / 音频官方语义是「沿用样片」,客户没显式传就不注入默认值(显式传了由上游判)。
    if (draftRef) {
        if (body.duration == null && body.seconds == null) delete upstreamBody.duration;
        if (typeof body.generate_audio !== 'boolean') delete upstreamBody.generate_audio;
    }
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
    // 版权放行:只透传 ips(ip_mode 由平台统一控制,不透传)。
    const mod = body.moderation_options as { ips?: unknown } | undefined;
    if (mod && Array.isArray(mod.ips) && mod.ips.length) upstreamBody.moderation_options = { ips: mod.ips };

    // 其余字段【一律透传】给上游 —— 本渠道卖的是「原生火山」,能不能用由火山判,不由我们判。
    // 上游实测会把未知字段原样转给方舟(camera_fixed / service_tier 等由方舟按任务类型判)。
    // 改成反向白名单:只挡我们自己消费或翻译掉的键,其余原样过去。
    const extras: string[] = [];
    for (const [k, v] of Object.entries(body)) {
        if (CONSUMED_BODY_KEYS.has(k) || k in upstreamBody || v === undefined) continue;
        if (NEVER_FORWARD_KEYS.has(k)) {
            console.warn('[volc-adapter] 该字段需要单独适配,未透传', { field: k });
            continue;
        }
        upstreamBody[k] = v;
        extras.push(k);
    }
    if (extras.length) console.log('[volc-adapter] 透传客户额外字段', { fields: extras });

    const r = await submitSvcinfTask(cfg, upstreamBody, { log: LOG, errType: ERR_TYPE, model: opts.clientModel });
    if (!r.ok) return r.res;
    const taskId = r.taskId;
    // 对客 id = 我们【即时自造】的火山方舟形任务号;上游受理号(mvt-…)是唯一可轮询句柄,
    // 存映射供轮询换回去打上游。方舟真号在轮询响应 metadata.id 里,只落日志供内部对账。
    const clientTaskId = makeArkTaskId();
    await rememberVolcId(clientTaskId, taskId, 'task');
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

/**
 * 轮询:GET 上游任务 → 归一形 {status, video_url, last_frame_url, usage, …火山官方字段}(见 svcinf-client)。
 * 入参 id 是对客形(cgt-X):经 volc_id_map 换回上游号(mvt-X)再打上游;查不到映射时原样打
 * (宽进 —— 上游本来就 404,由报错分支如实返回)。
 */
export async function pollVolcVideo(id: string, upstreamKey?: string): Promise<NextResponse> {
    const cfg = getVolcUpstreamConfig(upstreamKey);
    if (!cfg) return err(503, 'temporarily_unavailable', '火山渠道未配置,请联系服务方');
    const upstreamId = await toUpstreamId(id);
    return pollSvcinfTask(cfg, id, upstreamId, { log: LOG, errType: ERR_TYPE });
}

/** 取消任务:上游【无取消/删除端点】(文档只有建/查/列三条)。
 *  返回 null = 不支持 —— proxy 侧 best-effort,不阻断客户删除本地任务记录。 */
export async function cancelVolcVideo(_id: string): Promise<Response | null> {
    return null;
}
