/**
 * 独立门户 /v1 处理器(P1)—— PORTAL_FLAVOR=seedance-enterprise 实例上,/v1 只服务
 * seedance 视频端点(+ /models 目录),其余一律 404。
 *
 * 与 seedance-cn 渠道(cn-proxy)的差别:
 *  - 鉴权:门户自发 sk-ent- key(resolveEnterpriseCustomer),不是 new-api token;
 *  - 上游:每客户独立上游 key(决策②),进程内直调 cn-adapter 的 *WithKey 核心
 *    (不走 HTTP 自调,绕开适配器的全站单 key 鉴权);
 *  - 计费:纯 portal ¥账本(enterprise/billing),无 newapi 分支;
 *  - 任务行:seedance_video_tasks.tier = 'enterprise-portal' 区分归属,轮询按 tier 门。
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import {
    MODEL_MAP,
    isVolcModel,
    extractImageUrls,
    extractVideoUrls,
    extractAudioUrls,
    submitVideoWithKey,
    pollVideoWithKey,
    cancelVideoWithKey,
    regionForModel,
    maxDurationForVariant,
    type SeedanceModelSpec,
    type SeedanceVariant,
    type SeedanceRegion,
} from '@/lib/seedance/cn-adapter';
import {
    submitVolcVideo,
    pollVolcVideo,
    cancelVolcVideo,
    volcRefLimits,
    VOLC_MODELS,
    VOLC_RESOLUTIONS,
    isVolcModelWithdrawn,
    WITHDRAWN_VOLC_HINT,
} from '@/lib/seedance/kuaizi-adapter';
import { callerHasVolc, resolveEnterpriseAuth, getUpstreamKeyForUser, type EnterpriseCustomer } from './keys';
import { ENTERPRISE_TIER, estimateEnterpriseCostCny, chargeEnterpriseVideoTask } from './billing';
import { AssetError, resolveAssetRefs } from './assets';
import { normalizeArkModel, stripAssetUri, arkStatus, buildArkTaskResponse } from './ark-format';
import { maybeBrandVideoUrl } from '@/lib/seedance/volc-brand';
import { maybeStoreVideoToCustomerOss } from '@/lib/seedance/customer-oss-video';
import { isTerminalTaskFailure, type UpstreamErrorCategory } from '@/lib/seedance/upstream-error';
import { invalidatePollCache, pollWithCache } from './poll-cache';

/** 对客响应形态:'v1' = 我们现有形;'ark' = 火山方舟官方形(/api/v3/…)。 */
export type ClientFormat = 'v1' | 'ark';

/** 企业门户对客模型名(2026-07-20 归一,operator 拍板):按量计费下分辨率是参数不是模型名。
 *  `resolution` 参数选 480p/720p/1080p/4k(默认 720p;4k 仅 pro;480p 与 720p 同费率),带参考图/视频/音频自动识别
 *  (不再需要 -ref 后缀)。旧 14 个长名(seedance2.0-pro-720p 等)保留兼容,不再对外宣传。 */
export const ENTERPRISE_MODELS: Record<string, SeedanceVariant> = {
    'seedance-2-0': 'pro',
    'seedance-2-0-fast': 'fast',
    'seedance-2-0-mini': 'mini',
    // 国内版 seedance 2.5(2026-08-07):新代模型,仅 480p/720p,费率独立
    'seedance-2-5': '2.5',
    // 海外版(2026-07-23):同厂商国际端口,协议/档位/定价与国内一致,仅出片节点在海外(BytePlus)
    'seedance-2-0-global': 'pro',
    'seedance-2-0-global-fast': 'fast',
    'seedance-2-0-global-mini': 'mini',
    // 海外版proMax(2026-07-23):dreamina 系,费率独立(挂牌更高 ×0.85);fast/mini 仅 480p/720p
    'seedance-2-0-promax': 'promax',
    'seedance-2-0-promax-fast': 'promax-fast',
    'seedance-2-0-promax-mini': 'promax-mini',
    // 海外版 proMax seedance 2.5(2026-08-08):intl 新代,仅 720p/1080p,费率独立(按原价挂牌)
    'seedance-2-5-promax': 'promax-2.5',
};

// 2026-08-03 全线四档:volc 实测 480p 出片 864×496;cn/global/promax 上游挂牌本就含
// 480p(与 720p 统一价),MODEL_MAP 已加 480p SKU。
const RESOLUTIONS = ['480p', '720p', '1080p', '4k'] as const;

/** 短名 + body 参数 → 内部长名规格。非短名返回 null(走长名/未知分支)。 */
function resolveEnterpriseModel(
    rawModel: string,
    body: Record<string, unknown>,
): { spec: SeedanceModelSpec; longName: string } | { error: NextResponse } | null {
    const lower = rawModel.toLowerCase();
    // 「火山」渠道:四档模型(doubao-seedance-2.0 / -fast / -mini / doubao-seedance-2.5),
    // resolution 参数 + ref 自动识别。走独立 adapter(火山方舟原生),不经 MODEL_MAP 长名机制。
    if (isVolcModel(lower)) {
        // 下架档位(fast/mini 实测不落方舟,见 kuaizi-adapter 的 WITHDRAWN_VOLC_MODELS)——
        // 在解析最前面拦掉,连参数校验都不必走。
        if (isVolcModelWithdrawn(lower)) {
            return { error: errJson(400, 'model_unavailable', `${rawModel}:${WITHDRAWN_VOLC_HINT}`) };
        }
        const volc = VOLC_MODELS[lower];
        const allowed = VOLC_RESOLUTIONS[volc.variant];
        const resRaw = String(body.resolution ?? '720p').toLowerCase();
        if (!(allowed as readonly string[]).includes(resRaw)) {
            return {
                error: errJson(400, 'invalid_request', `${rawModel} 的 resolution 仅支持 ${allowed.join(' / ')}`),
            };
        }
        const images = extractImageUrls(body);
        const videos = extractVideoUrls(body);
        const audios = extractAudioUrls(body);
        const explicitFrames =
            (typeof body.first_frame === 'string' && body.first_frame !== '' ? 1 : 0) +
            (typeof body.last_frame === 'string' && body.last_frame !== '' ? 1 : 0);
        // 单次输入素材上限(上游分档矩阵):超限先给清晰 400,不白打上游。
        const limits = volcRefLimits(volc.variant);
        const totalImages = images.length + explicitFrames;
        if (totalImages > limits.images)
            return { error: errJson(400, 'invalid_request', `${rawModel} 最多 ${limits.images} 张参考图`) };
        if (videos.length > limits.videos)
            return { error: errJson(400, 'invalid_request', `${rawModel} 最多 ${limits.videos} 个参考视频`) };
        if (audios.length > limits.audios)
            return { error: errJson(400, 'invalid_request', `${rawModel} 最多 ${limits.audios} 段参考音频`) };
        // seedance 2.5 首帧/首尾帧任务上游仅支持 ratio=adaptive(创建时同步拒)。这里前置拦
        // 一次,给出可操作文案 —— 视频编辑/延长两类由模型按提示词意图判定,我们判不了,
        // 仍由上游异步返回 InvalidParameter.TaskTypeConstraint。
        if (volc.variant === '2.5') {
            const hasFrameRole =
                explicitFrames > 0 ||
                (Array.isArray(body.content) &&
                    body.content.some((c) => {
                        const role = (c as { role?: unknown })?.role;
                        return role === 'first_frame' || role === 'last_frame';
                    }));
            const rr = body.ratio ?? body.aspect_ratio;
            if (hasFrameRole && rr != null && String(rr) !== 'adaptive') {
                return {
                    error: errJson(
                        400,
                        'invalid_request',
                        `${rawModel} 的首帧/首尾帧任务仅支持 ratio=adaptive(输出宽高比跟随输入素材),当前 "${String(rr)}"`,
                    ),
                };
            }
        }
        return {
            spec: {
                resolution: resRaw as '480p' | '720p' | '1080p' | '4k',
                ref: totalImages > 0 || videos.length > 0 || audios.length > 0,
                variant: volc.variant,
                upstream: volc.upstream,
                region: 'volc',
            },
            longName: lower,
        };
    }
    const variant = ENTERPRISE_MODELS[lower];
    if (!variant) return null;
    const region = lower.includes('-promax') ? 'promax' : lower.includes('-global') ? 'global' : 'cn';
    const resRaw = String(body.resolution ?? '720p').toLowerCase();
    if (!(RESOLUTIONS as readonly string[]).includes(resRaw)) {
        return { error: errJson(400, 'invalid_request', 'resolution 仅支持 480p / 720p / 1080p / 4k') };
    }
    // 海外版(global)上游无 480p(intl 三变体实测均拒,2026-08-06);国内/火山有 480p,proMax 2026-08-08 起也无
    if (region === 'global' && resRaw === '480p') {
        return {
            error: errJson(
                400,
                'invalid_request',
                `${rawModel} 无 480p 档(海外版仅 720p / 1080p / 4k);480p 请用国内版`,
            ),
        };
    }
    // proMax 上游 2026-08-08 全档迁到 artsdance intl,不支持 480p(pro=720p/1080p/4k,fast/mini=仅720p)
    if (region === 'promax' && resRaw === '480p') {
        return {
            error: errJson(
                400,
                'invalid_request',
                `${rawModel} 无 480p 档(proMax pro 支持 720p / 1080p / 4k,fast/mini 仅 720p)`,
            ),
        };
    }
    if (resRaw === '4k' && variant !== 'pro' && variant !== 'promax') {
        const tiers = region === 'global' ? '720p / 1080p' : '480p / 720p / 1080p';
        return { error: errJson(400, 'invalid_request', `${rawModel} 无 4k 档(resolution 仅 ${tiers})`) };
    }
    // proMax fast/mini(上游 artsdance intl,2026-08-08)仅 720p
    if ((variant === 'promax-fast' || variant === 'promax-mini') && resRaw !== '720p') {
        return { error: errJson(400, 'invalid_request', `${rawModel} 仅支持 720p 档`) };
    }
    // seedance 2.5(上游 artsdance-2-5-pro):仅 720p / 1080p(不支持 480p)
    if (variant === '2.5' && resRaw !== '720p' && resRaw !== '1080p') {
        return { error: errJson(400, 'invalid_request', `${rawModel} 仅支持 720p / 1080p 档`) };
    }
    const hasRefs =
        extractImageUrls(body).length > 0 ||
        extractVideoUrls(body).length > 0 ||
        extractAudioUrls(body).length > 0 ||
        (typeof body.first_frame === 'string' && body.first_frame !== '') ||
        (typeof body.last_frame === 'string' && body.last_frame !== '');
    // 长名:2.5 系是新代独立前缀 seedance2.5-…(cn = seedance2.5-{res};proMax = seedance2.5-promax-{res});
    // 其余走 seedance2.0-… 老机制(global 前缀在 variant 前;promax 系 variant 自带前缀)。
    const ref = hasRefs ? '-ref' : '';
    const longName =
        variant === '2.5'
            ? `seedance2.5-${resRaw}${ref}`
            : variant === 'promax-2.5'
              ? `seedance2.5-promax-${resRaw}${ref}`
              : `seedance2.0-${region === 'global' ? 'global-' : ''}${variant}-${resRaw}${ref}`;
    const spec = MODEL_MAP[longName];
    if (!spec) {
        // 组合表齐全时到不了这里;防御性兜底
        return { error: errJson(400, 'invalid_request', `unsupported combination: ${rawModel} @ ${resRaw}`) };
    }
    return { spec, longName };
}

export function isEnterpriseFlavor(): boolean {
    return process.env.PORTAL_FLAVOR === 'seedance-enterprise';
}

const errJson = (status: number, code: string, message: string) =>
    NextResponse.json({ error: { code, message, type: 'invalid_request_error' } }, { status });

/** /v1 分发:models / 提交 / 轮询,其余 404。 */
export async function handleEnterpriseV1(req: NextRequest, path: string): Promise<NextResponse> {
    if (req.method === 'GET' && path === '/models') {
        // 只列 3 个归一短名(resolution 是参数);旧长名仍可调但不再列出
        return NextResponse.json({
            object: 'list',
            data: Object.keys(ENTERPRISE_MODELS).map((id) => ({
                id,
                object: 'model',
                owned_by: 'silkroadai-enterprise',
            })),
        });
    }
    if (req.method === 'POST' && (path === '/video/generations' || path === '/videos')) {
        return handleSubmit(req);
    }
    const poll = /^\/(?:video\/generations|videos)\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && poll) {
        return handlePoll(req, decodeURIComponent(poll[1]));
    }
    return errJson(404, 'not_found', 'this endpoint is not available on the seedance enterprise portal');
}

/**
 * 火山方舟(Ark)形态入口:/api/v3/*(对齐 docs.volcengine.com/docs/82379)。
 * 内部复用 handleSubmit/handlePoll 核心,仅出口序列化为火山形。models 形态与 v1 一致。
 */
/** GET /api/v3/contents/generations/tasks —— 查询该客户的任务列表(火山官方形)。
 *  从 seedance_video_tasks 按 user_id 分页返回;成片 URL 不落库 → 列表项 content 留空,
 *  客户查单个任务(GET .../tasks/{id})时实时取直链。分页 page_num/page_size,可选 status/model 过滤。 */
async function handleListTasks(req: NextRequest): Promise<NextResponse> {
    const cust = await resolveOr401(req);
    if (cust instanceof NextResponse) return cust;
    const sp = req.nextUrl.searchParams;
    const pageNum = Math.max(1, Math.trunc(Number(sp.get('page_num')) || 1));
    const pageSize = Math.min(500, Math.max(1, Math.trunc(Number(sp.get('page_size')) || 10)));
    const where: Record<string, unknown> = { user_id: cust.userId, tier: ENTERPRISE_TIER };
    const modelFilter = sp.get('model');
    if (modelFilter) where.model = normalizeArkModel(modelFilter);
    const statusFilter = sp.get('status');
    if (statusFilter) where.status = ARK_STATUS_TO_INTERNAL[statusFilter] ?? statusFilter;
    const [total, rows] = await Promise.all([
        prisma.seedanceVideoTask.count({ where }),
        prisma.seedanceVideoTask.findMany({
            where,
            orderBy: { created_at: 'desc' },
            skip: (pageNum - 1) * pageSize,
            take: pageSize,
        }),
    ]);
    const items = rows.map((t) => {
        const region = regionForModel(t.model);
        return buildArkTaskResponse({
            taskId: t.id,
            internalModel: t.model,
            status: arkStatus(t.status),
            videoUrl: null, // 成片不落库,列表不逐个回源;查单个任务取直链
            lastFrameUrl: null,
            usage: t.tokens ? { completion_tokens: Number(t.tokens), total_tokens: Number(t.tokens) } : null,
            failReason: t.fail_reason,
            createdAt: t.created_at,
            resolution: t.resolution,
            duration: t.duration,
            ratio: t.ratio,
            seed: t.seed,
            generateAudio: t.generate_audio,
            extended: region === 'global' || region === 'promax',
        });
    });
    return NextResponse.json({ items, total, page_num: pageNum, page_size: pageSize });
}

/** DELETE /api/v3/contents/generations/tasks/{task_id} —— 取消排队中的任务 / 删除任务记录(火山官方)。
 *  归属校验:仅本人任务(IDOR-safe),未找到 → 404;版本门与轮询一致(sk-ent 绑 region)。
 *  非终态(queued/in_progress)→ 尽力取消上游(停止排队/生成,从而不产生 completed 计费);上游不支持
 *  或报错都不阻断客户删除,也绝不透传上游报错(#271)。一律删库任务记录(火山「删除任务记录」语义);
 *  已计费任务的对客 ¥ 账本条目在 ledger 独立留存,删任务行不影响对账。成功 → 204 无体。 */
async function handleDeleteTask(req: NextRequest, taskId: string): Promise<NextResponse> {
    const cust = await resolveOr401(req);
    if (cust instanceof NextResponse) return cust;

    const task = await prisma.seedanceVideoTask.findUnique({ where: { id: taskId } });
    if (!task || task.tier !== ENTERPRISE_TIER || task.user_id !== cust.userId) {
        return errJson(404, 'not_found', 'task not found');
    }
    const taskRegion: SeedanceRegion = regionForModel(task.model);
    if (taskRegion !== 'volc' && !cust.accountLevel && cust.region !== taskRegion) {
        return errJson(
            403,
            'region_mismatch',
            `this task belongs to the ${taskRegion} region; use your ${taskRegion} API key to delete it`,
        );
    }

    // 非终态才需取消上游(终态任务已无排队可取消)。best-effort:任何失败只落日志,不阻断删除。
    if (task.status !== 'completed' && task.status !== 'failed') {
        try {
            if (taskRegion === 'volc') {
                await cancelVolcVideo(taskId);
            } else {
                let upstreamKey = cust.upstreamKey;
                if (cust.accountLevel) upstreamKey = (await getUpstreamKeyForUser(cust.userId, taskRegion)) ?? '';
                if (upstreamKey) await cancelVideoWithKey(taskId, `Bearer ${upstreamKey}`, taskRegion);
            }
        } catch (e) {
            console.warn('[enterprise-proxy] upstream cancel best-effort failed', { taskId, err: String(e) });
        }
    }

    await prisma.seedanceVideoTask
        .delete({ where: { id: taskId } })
        .catch((e) => console.warn('[enterprise-proxy] delete task row failed', { taskId, err: String(e) }));

    return new NextResponse(null, { status: 204 });
}

export async function handleEnterpriseArkV3(req: NextRequest, path: string): Promise<NextResponse> {
    if (req.method === 'GET' && path === '/models') {
        // 火山形 models:列火山 id + owned_by=doubao;仍保留我们短名可调
        return NextResponse.json({
            object: 'list',
            data: [
                { id: 'doubao-seedance-2-0-260128', object: 'model', owned_by: 'doubao', type: 'video_generation' },
                {
                    id: 'doubao-seedance-2-0-fast-260128',
                    object: 'model',
                    owned_by: 'doubao',
                    type: 'video_generation',
                },
                {
                    id: 'doubao-seedance-2-0-mini-260615',
                    object: 'model',
                    owned_by: 'doubao',
                    type: 'video_generation',
                },
                { id: 'doubao-seedance-2-5-260628', object: 'model', owned_by: 'doubao', type: 'video_generation' },
            ],
        });
    }
    if (req.method === 'POST' && path === '/contents/generations/tasks') {
        return handleSubmit(req, 'ark');
    }
    // 任务列表(火山官方 GET /contents/generations/tasks,不带 id)——须在单任务 poll 正则之前判。
    if (req.method === 'GET' && path === '/contents/generations/tasks') {
        return handleListTasks(req);
    }
    const poll = /^\/contents\/generations\/tasks\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && poll) {
        return handlePoll(req, decodeURIComponent(poll[1]), 'ark');
    }
    // 取消排队中的任务 / 删除任务记录(火山官方 DELETE .../tasks/{id},204=成功)。
    if (req.method === 'DELETE' && poll) {
        return handleDeleteTask(req, decodeURIComponent(poll[1]));
    }
    return errJson(404, 'not_found', 'this endpoint is not available');
}

/** 双通道鉴权(Bearer sk-ent / 火山 SignerV4 AK/SK)。AK/SK 验签需原始 body,故 caller 传 rawBody。 */
async function resolveOr401(
    req: NextRequest,
    expectedRegion?: string,
    rawBody = '',
): Promise<EnterpriseCustomer | NextResponse> {
    let r: Awaited<ReturnType<typeof resolveEnterpriseAuth>>;
    try {
        r = await resolveEnterpriseAuth(
            {
                authorization: req.headers.get('authorization'),
                method: req.method,
                path: req.nextUrl.pathname,
                query: req.nextUrl.searchParams,
                headers: req.headers,
                rawBody,
            },
            expectedRegion,
        );
    } catch (e) {
        console.error('[enterprise-proxy] resolve customer failed', e);
        return errJson(503, 'temporarily_unavailable', 'account lookup failed, please retry');
    }
    if (!r.ok) return errJson(r.status, r.code, r.message);
    return r.customer;
}

// ── 火山方舟形(ark)严格契约校验(仅 /api/v3 面;/v1 与主站保持宽松,不误伤存量宽松客户)──
/** 火山官方输出宽高比枚举(2.0/2.5 同集)。非法值 → 400(不再静默纠正成 16:9)。 */
const ARK_ALLOWED_RATIOS = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive']);
/** ark 提交接受的顶层字段白名单(火山官方字段 + 我们支持的 OpenAI 形别名)。
 *  未声明字段 → 400(对齐火山严格校验;客户契约测试要求)。 */
const ARK_ALLOWED_FIELDS = new Set([
    // 火山官方
    'model',
    'content',
    'resolution',
    'ratio',
    'duration',
    'seed',
    'camera_fixed',
    'generate_audio',
    'watermark',
    'omni_reference_task_type',
    'output_format',
    'return_last_frame',
    'callback_url',
    'safety_identifier',
    'service_tier',
    'priority',
    // 我们支持的别名/OpenAI 形入参(保留兼容,均为已知字段)
    'prompt',
    'seconds',
    'aspect_ratio',
    'first_frame',
    'last_frame',
    'video_config',
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
]);

/** 火山 status(查询列表 filter 用)→ 我们内部 task.status(反向映射,对齐 arkStatus)。 */
const ARK_STATUS_TO_INTERNAL: Record<string, string> = {
    succeeded: 'completed',
    running: 'in_progress',
    queued: 'queued',
    failed: 'failed',
};

/** 提交:key 鉴权(绑版本)→ 模型门 → 余额门(¥账本)→ 直调适配器核心(客户上游 key)→ 记任务(fail closed)。 */
/** 上游回的已推导值(字符串);缺失/非法 → null,交由调用方回落库值。 */
function upstreamStr(v: unknown): string | null {
    return typeof v === 'string' && v ? v : null;
}
/** 上游回的已推导值(数字);缺失/非法 → null。 */
function upstreamNum(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

async function handleSubmit(req: NextRequest, format: ClientFormat = 'v1'): Promise<NextResponse> {
    // 先读原始 body(AK/SK 验签对原始字节算 hash),再解析 + 归一。
    const rawBody = await req.text();
    let body: Record<string, unknown>;
    try {
        body = rawBody.trim() ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    } catch {
        return errJson(400, 'invalid_json', 'request body must be JSON');
    }

    // 调用方是不是 volc 客户?(鉴权前的探测,只用来决定「模型名与未知字段按哪个渠道处理」)
    // ⚠️ 同一个火山原生 id 对 cn 客户与 volc 客户是两个意思 —— 2026-08-26 客户实测:
    // volc 客户传 doubao-seedance-2-5-260628 被按 cn 解释,直接 403 region_mismatch。
    const callerIsVolc = await callerHasVolc(req.headers.get('authorization'));

    // ark 面严格契约:未声明顶层字段 → 400(在任何 body 变换前,按原始键判)。
    if (format === 'ark') {
        const unknown = Object.keys(body).filter((k) => !ARK_ALLOWED_FIELDS.has(k));
        // volc =「原生火山」渠道:未知字段不由我们判,原样交给火山判 —— 我们的白名单
        // 只会越来越落后于上游(2026-08-26 实测:bitrate_mode / camera_fixed /
        // service_tier / priority 四个官方字段我们要么 400 要么静默丢)。只落日志。
        if (unknown.length && callerIsVolc) {
            console.log('[enterprise-proxy] volc 透传未声明字段给上游', { fields: unknown });
        } else if (unknown.length) {
            return errJson(400, 'invalid_request', `unknown parameter(s): ${unknown.join(', ')}`);
        }
    }

    // 入口归一:火山 model id(doubao-…)→ 内部短名(先归一 model 才能判 region)。
    // volc 客户下原生 id 解释成火山渠道对客名(见上面的 callerIsVolc)。
    body.model = normalizeArkModel(String(body.model || ''), callerIsVolc);

    const model = String(body.model || '');
    const isVolc = regionForModel(model) === 'volc';

    // 剥 asset:// 前缀(对 v1 也安全:v1 客户素材引用是裸 id,归一后不变)——
    // 仅非 volc:后面 resolveAssetRefs 认裸 asset-…。「火山」渠道素材由上游 provider
    // 解析,契约就是 asset://<id> 整串,剥了前缀上游按 URL 解析必 400
    // (`content[N].image_url is not valid`,2026-08-03 客户实测)。
    if (!isVolc) body = stripAssetUri(body);

    // 版本先于鉴权确定(模型名承载):key 与模型版本必须一致(单独 key,operator 决策),
    // 上游 key 也按版本行解密。未知模型按 cn 解析,后续 model_not_found 分支照常 400。
    // AK/SK 验签用原始 body(客户签的是含 doubao 名的原始字节,不能用归一后的)。
    const cust = await resolveOr401(req, regionForModel(model), rawBody);
    if (cust instanceof NextResponse) return cust;

    // P3 素材库引用:asset-…/group-… → R2 公网 URL(必须在 ref/hasVideo 检测之前,
    // 视频素材引用也要计入含视频费率档)。未知/非本人 id → 400。
    // 「火山」渠道走【混合解析】(lenient,2026-08-06):平台库素材(AIGC,全渠道共用)
    // 换 R2 直链发上游;认不出的引用(真人素材 / 存量 provider 素材,asset:// 整串)
    // 原样透传给 provider 解析 —— volc 也能用平台库素材,真人素材链路不变。
    try {
        body = await resolveAssetRefs(body, cust.userId, isVolc ? { lenient: true } : undefined);
    } catch (e) {
        if (e instanceof AssetError) return errJson(e.status, e.code, e.message);
        console.error('[enterprise-proxy] asset ref resolve failed', e);
        return errJson(503, 'temporarily_unavailable', 'asset lookup failed, please retry');
    }

    // 模型解析:归一短名(seedance-2-0[-fast|-mini] + resolution 参数 + ref 自动识别)
    // 优先;旧长名(MODEL_MAP)保留兼容。任务行存客户实际调用的名字。
    let map: SeedanceModelSpec;
    let adapterModel: string; // 发给适配器核心的长名
    const short = resolveEnterpriseModel(model, body);
    if (short && 'error' in short) return short.error;
    if (short) {
        map = short.spec;
        adapterModel = short.longName;
    } else if (MODEL_MAP[model]) {
        map = MODEL_MAP[model];
        adapterModel = model;
    } else {
        return errJson(400, 'model_not_found', `unknown seedance model: ${model}`);
    }

    // ark 面严格契约:非法 ratio 值 → 400(不再静默纠正成 16:9;v1 面仍宽松纠正)。
    if (format === 'ark') {
        const rr = body.ratio ?? body.aspect_ratio;
        if (rr != null && !ARK_ALLOWED_RATIOS.has(String(rr))) {
            return errJson(400, 'invalid_request', `ratio 仅支持 ${[...ARK_ALLOWED_RATIOS].join(' / ')}`);
        }
    }

    const hasVideo = extractVideoUrls(body).length > 0;
    // duration:2.5 系 4-30s,2.0 系 4-15s(火山官方 2026-08 提升 2.5 至 30s;探测 volc/cn/global
    // 2.0 上游 3s/16s 皆 400,4s 全变体真出片)。缺省 5;显式非法值 400(不静默改秒数 —— 计费
    // 按 token,静默换时长=换价)。
    const durRaw = Number(body.duration ?? body.seconds);
    const maxDur = maxDurationForVariant(map.variant);
    let duration: number;
    if (body.duration == null && body.seconds == null) {
        duration = 5;
    } else if (durRaw === -1) {
        duration = -1; // 智能时长(上游自选,落库 -1;余额门按上限估价)
    } else if (Number.isInteger(durRaw) && durRaw >= 4 && durRaw <= maxDur) {
        duration = durRaw;
    } else {
        return errJson(400, 'invalid_request', `duration 仅支持 4-${maxDur} 之间的整数秒或 -1(智能时长)`);
    }
    // 余额门:-1 时长未定,按【上限】估价挡防欠扣(最终按 token 结算,不受影响)。
    const estDuration = duration === -1 ? maxDur : duration;

    // 余额门(视频后付费,提交时按估价挡,防大额透支)。企业客户余额 = Account.balance_cny 唯一真相。
    try {
        const account = await prisma.account.findUnique({
            where: { user_id: cust.userId },
            select: { balance_cny: true },
        });
        const balance = account ? Number(account.balance_cny) : 0;
        const est = await estimateEnterpriseCostCny(
            cust.userId,
            map.resolution,
            estDuration,
            hasVideo,
            map.variant,
            map.region ?? 'cn',
        );
        if (balance < est) {
            return errJson(
                402,
                'insufficient_balance',
                `余额不足(需约 ¥${est.toFixed(2)},当前 ¥${balance.toFixed(2)})`,
            );
        }
    } catch (e) {
        // 余额查询失败不硬阻断(避免 DB 抖动误杀),记日志继续 —— 同 cn-proxy 语义
        console.warn('[enterprise-proxy] balance gate skipped (lookup failed)', e);
    }

    const res =
        map.region === 'volc'
            ? await submitVolcVideo(body, { clientModel: adapterModel, resolution: map.resolution, duration })
            : await submitVideoWithKey({ ...body, model: adapterModel }, `Bearer ${cust.upstreamKey}`);
    const text = await res.text();
    if (!res.ok) {
        // 带客户身份落日志(适配器层只有上游视角):upstream_error 投诉可直接定位到人
        console.warn('[enterprise-proxy] submit error', {
            user_id: cust.userId,
            model,
            status: res.status,
            body: text.slice(0, 2000),
        });
        return new NextResponse(text, { status: res.status, headers: { 'Content-Type': 'application/json' } });
    }
    let j: { id?: string; task_id?: string; model?: string } | null;
    try {
        j = JSON.parse(text) as { id?: string; task_id?: string; model?: string };
    } catch {
        j = null;
    }
    const taskId = j?.task_id || j?.id;
    if (!taskId) return errJson(502, 'upstream_error', 'no task_id from upstream');
    // 响应 model 回显客户调用的名字(短名路径下适配器回显的是内部长名)
    if (j && j.model && j.model !== model) j.model = model;

    try {
        // 提交参数落库(2026-08-06):火山方舟形查询响应要逐字段回显 ratio/seed/generate_audio
        const ratioRaw = String(body.ratio || body.aspect_ratio || '16:9');
        await prisma.seedanceVideoTask.create({
            data: {
                id: taskId,
                tenant_id: cust.tenantId,
                user_id: cust.userId,
                newapi_user_id: null,
                tier: ENTERPRISE_TIER,
                model,
                resolution: map.resolution,
                has_video: hasVideo,
                duration,
                ratio: ratioRaw.slice(0, 16),
                seed:
                    typeof body.seed === 'number' && Number.isFinite(body.seed) ? BigInt(Math.trunc(body.seed)) : null,
                generate_audio: body.generate_audio !== false,
            },
        });
    } catch (e) {
        // 记录失败 = 无法扣费 → 拒绝(fail closed,防生成了却收不到钱)
        console.error('[enterprise-proxy] task record failed, rejecting submit', e);
        return errJson(503, 'temporarily_unavailable', 'billing record failed, please retry');
    }
    // 火山形提交成功仅返 { id }(前缀 cgt-);v1 形返完整对象。
    if (format === 'ark') return NextResponse.json({ id: taskId });
    return j
        ? NextResponse.json(j)
        : new NextResponse(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** 轮询:归属 + tier + 版本三门(IDOR)→ 直调适配器核心(按版本 base)→ 完成写 tokens + 幂等扣费 → 透传响应。 */
async function handlePoll(req: NextRequest, taskId: string, format: ClientFormat = 'v1'): Promise<NextResponse> {
    const cust = await resolveOr401(req);
    if (cust instanceof NextResponse) return cust;

    const task = await prisma.seedanceVideoTask.findUnique({ where: { id: taskId } });
    if (!task || task.tier !== ENTERPRISE_TIER || task.user_id !== cust.userId) {
        return errJson(404, 'not_found', 'task not found');
    }
    const taskRegion: SeedanceRegion = regionForModel(task.model);
    // 版本门只对 sk-ent(绑 region)生效:本人任务但 key 版本不符 → 提示换对应版本 key。
    // volc 用平台 env、AK/SK 账号级(能查自己所有渠道任务)→ 不做版本门(归属已由 user_id 把关)。
    if (taskRegion !== 'volc' && !cust.accountLevel && cust.region !== taskRegion) {
        return errJson(
            403,
            'region_mismatch',
            `this task belongs to the ${taskRegion} region; use your ${taskRegion} API key to poll it`,
        );
    }

    /** 失败终态的对客响应(v1 形 / 火山形)。库里 fail_reason 是权威。 */
    const failedResponse = (failReason: string): NextResponse => {
        if (format === 'ark') {
            const extended = taskRegion === 'global' || taskRegion === 'promax';
            return NextResponse.json(
                buildArkTaskResponse({
                    taskId,
                    internalModel: task.model,
                    status: 'failed',
                    failReason,
                    createdAt: task.created_at,
                    resolution: task.resolution,
                    duration: task.duration,
                    ratio: task.ratio,
                    seed: task.seed,
                    generateAudio: task.generate_audio,
                    extended,
                }),
            );
        }
        return NextResponse.json({
            id: taskId,
            task_id: taskId,
            object: 'video',
            status: 'failed',
            progress: 100,
            fail_reason: failReason,
        });
    };

    /**
     * 上游轮询【瞬时】失败时的降级响应:返回库里最后已知状态(queued / in_progress)。
     *
     * 轮询失败 ≠ 任务失败 —— 上游 429/5xx 时任务多半还在跑,但客户脚本拿到 4xx/5xx
     * 往往直接当异常中断整条流水线(2026-08-18 客户就是这么报障的)。降级后客户照常轮询,
     * 任务真出片时自然拿到结果。响应带 `X-Silkroadai-Poll-Degraded: 1` 供我们排查区分。
     */
    const lastKnownResponse = (): NextResponse => {
        const headers = { 'X-Silkroadai-Poll-Degraded': '1' };
        const our = task.status === 'in_progress' ? 'in_progress' : 'queued';
        if (format === 'ark') {
            const extended = taskRegion === 'global' || taskRegion === 'promax';
            return NextResponse.json(
                buildArkTaskResponse({
                    taskId,
                    internalModel: task.model,
                    status: arkStatus(our),
                    createdAt: task.created_at,
                    resolution: task.resolution,
                    duration: task.duration,
                    ratio: task.ratio,
                    seed: task.seed,
                    generateAudio: task.generate_audio,
                    extended,
                }),
                { headers },
            );
        }
        return NextResponse.json(
            { id: taskId, task_id: taskId, object: 'video', status: our, progress: our === 'queued' ? 0 : 50 },
            { headers },
        );
    };

    // 已终态失败短路:库里已 failed 就不再打上游(上游会清除失败任务,再查返「任务不存在」,
    // 真实原因反而丢失)。
    if (task.status === 'failed') {
        return failedResponse(task.fail_reason || 'generation failed');
    }

    // 非 volc 轮询要打客户上游:sk-ent 用鉴权时装载的 cust.upstreamKey;AK/SK 账号级(/api 轮询
    // 未按 region 装载,cust.upstreamKey='')→ 按【任务的 region】补加载客户上游 key。
    let upstreamKey = cust.upstreamKey;
    if (taskRegion !== 'volc' && cust.accountLevel) {
        const k = await getUpstreamKeyForUser(cust.userId, taskRegion);
        if (!k) return errJson(503, 'account_not_configured', 'no upstream key configured for this region');
        upstreamKey = k;
    }

    // 短 TTL 缓存 + 同任务并发合流:客户的轮询频率不再 1:1 传导到上游(见 poll-cache 头部)。
    // 缓存的是原始 (status, text),下游逻辑照常全跑 —— 落 tokens / 幂等扣费 / 客户 OSS 转存
    // 一个不少,对客语义完全不变。
    const { result: upstream, cached } = await pollWithCache(taskId, async () => {
        const r =
            taskRegion === 'volc'
                ? await pollVolcVideo(taskId)
                : await pollVideoWithKey(taskId, `Bearer ${upstreamKey}`, taskRegion);
        return { status: r.status, text: await r.text() };
    });
    const res = { ok: upstream.status < 400, status: upstream.status };
    const text = upstream.text;
    if (!res.ok) {
        // 上游用 HTTP 4xx 表达【任务已废】(如 seedance 2.5 的 TaskTypeConstraint、内容审核、
        // 参数不合法):这类再轮询多少次都是同一个错。以前我们一律当「轮询瞬时失败」透传,
        // 任务永远停在 queued,客户脚本无限重试 —— 2026-08-18 实测一条这样的任务被轮询了
        // 8925 次 / 22 小时,还顺带把上游打到 429。现在:终态化落库 + 返回 status=failed,
        // 客户拿到终态自然停止。5xx / 429 / 上游账户异常仍按瞬时透传,绝不误杀在跑的任务。
        const category = (() => {
            try {
                return (JSON.parse(text) as { error?: { category?: string } })?.error?.category ?? '';
            } catch {
                return '';
            }
        })();
        const failMsg = (() => {
            try {
                return (JSON.parse(text) as { error?: { message?: string } })?.error?.message ?? '';
            } catch {
                return '';
            }
        })();
        const terminal = isTerminalTaskFailure(category as UpstreamErrorCategory, res.status);
        console.warn('[enterprise-proxy] poll error', {
            user_id: cust.userId,
            task_id: taskId,
            status: res.status,
            category,
            terminal,
            cached,
            body: text.slice(0, 2000),
        });
        if (terminal) {
            const reason = failMsg || '上游判定任务失败';
            await prisma.seedanceVideoTask
                .updateMany({ where: { id: taskId }, data: { status: 'failed', fail_reason: reason.slice(0, 500) } })
                .catch((e) => console.warn('[enterprise-proxy] terminalize failed', { taskId, err: String(e) }));
            invalidatePollCache(taskId);
            return failedResponse(reason);
        }
        // 【瞬时】失败(上游限流 429 / 5xx / 不可达)→ 降级返库内最后已知状态,不把错误抛给客户。
        // 只认这两类明确的瞬时信号:4xx 的 unknown / task_gone 仍照常透传 —— 对那些降级会造出
        // 新的无限轮询(客户永远拿到 in_progress、却永远等不到完成)。
        if (res.status === 429 || res.status >= 500) {
            return lastKnownResponse();
        }
        return new NextResponse(text, { status: res.status, headers: { 'Content-Type': 'application/json' } });
    }
    let j: Record<string, unknown> | null;
    try {
        j = JSON.parse(text) as Record<string, unknown>;
    } catch {
        j = null;
    }

    if (j && j.status === 'completed') {
        const usage = j.usage as { completion_tokens?: number; total_tokens?: number } | undefined;
        const tokens = usage?.completion_tokens ?? usage?.total_tokens;
        if (tokens && tokens > 0 && task.tokens == null) {
            await prisma.seedanceVideoTask
                .update({ where: { id: taskId }, data: { tokens: BigInt(tokens), status: 'completed' } })
                .catch((e) => console.warn('[enterprise-proxy] write tokens failed', e));
        }
        try {
            const r = await chargeEnterpriseVideoTask(taskId);
            if (r.outcome === 'deduct_failed')
                console.error('[enterprise-proxy] charge deduct_failed', { taskId, cost: r.costCny });
        } catch (e) {
            console.error('[enterprise-proxy] charge threw', e);
        }
    } else if (j && j.status === 'failed' && task.status !== 'failed') {
        // 失败不计费(火山对失败不收费);fail_reason 落库(2026-07-24 企业权责透明)
        await prisma.seedanceVideoTask
            .update({
                where: { id: taskId },
                data: {
                    status: 'failed',
                    fail_reason: typeof j.fail_reason === 'string' ? j.fail_reason.slice(0, 500) : null,
                },
            })
            .catch(() => {});
    }

    // 成片落客户自定义 OSS(客户在 /enterprise/storage 配了自己的桶时):把上游成片(火山签名直链,
    // ~24h 过期)转存客户 bucket,返回客户域名下的永久 URL。region/format 无关,ark + v1 两个面共用;
    // 未配置 / 任何失败 → null,回退上游直链(不断流)。幂等 by taskId(helper 内 HEAD 客户桶)。
    const rawVideoUrl = typeof j?.video_url === 'string' ? j.video_url : ((j?.url as string | undefined) ?? null);
    let customerOssVideoUrl: string | null = null;
    if (rawVideoUrl && j?.status === 'completed') {
        customerOssVideoUrl = await maybeStoreVideoToCustomerOss({
            userId: cust.userId,
            taskId,
            upstreamUrl: rawVideoUrl,
        });
    }

    // 2026-08-19 起不再有 X-Silkroadai-Vendor-Task-Id 头 —— volc 客户拿到的 `id` 本身
    // 就是火山官方任务号了(提交时压着等来的),再单出一个「渠道侧原始 id」既冗余、
    // 也提示了中间层的存在。火山官方既没有这个头也没有这个字段。
    const vendorHeaders: Record<string, string> = {};

    // 火山形查询响应:status 翻译 + video_url/last_frame_url 挪进 content + 元数据回填。
    if (format === 'ark') {
        const ourStatus = typeof j?.status === 'string' ? j.status : task.status;
        const usage = (j?.usage ?? null) as { completion_tokens?: number; total_tokens?: number } | null;
        const failReason =
            typeof j?.fail_reason === 'string'
                ? j.fail_reason
                : typeof task.fail_reason === 'string'
                  ? task.fail_reason
                  : null;
        // 按渠道分形:global/promax = BytePlus ModelArk 形(带扩展字段,#326);
        // cn/volc = 火山方舟官方形(只出官方声明字段,客户严格白名单校验用)。
        const taskRegion = regionForModel(task.model);
        const extended = taskRegion === 'global' || taskRegion === 'promax';
        // 优先客户自定义 OSS(落客户自己的桶);未配才回退火山形品牌化,再回退上游直链。
        let videoUrl = customerOssVideoUrl ?? rawVideoUrl;
        // 火山形视频 URL 品牌化(仅国内渠道 + 白名单客户;env 双开关都设才生效,否则内部直接返 null)。
        // 转存成片到我们 R2 + 返回火山形域名 URL;任何失败回退原上游直链(不断流)。
        if (!customerOssVideoUrl && videoUrl && taskRegion === 'cn' && arkStatus(String(ourStatus)) === 'succeeded') {
            const branded = await maybeBrandVideoUrl({ userId: cust.userId, taskId, upstreamUrl: videoUrl });
            if (branded) videoUrl = branded;
        }
        return NextResponse.json(
            buildArkTaskResponse({
                taskId,
                internalModel: task.model,
                status: arkStatus(String(ourStatus)),
                videoUrl,
                lastFrameUrl: typeof j?.last_frame_url === 'string' ? j.last_frame_url : null,
                usage,
                failReason,
                createdAt: task.created_at,
                // 上游给了【已推导】的值就用它,库里的提交参数只作兜底。
                // 客户传 duration=-1(智能时长)时,库里存的就是 -1,一直回显 -1 是错的 ——
                // 上游完成时会给模型真正选的秒数(2026-08-26 客户报障)。ratio 同理。
                // 其余渠道的适配器不返回这几个字段 → 自动回落 task.*,行为不变。
                resolution: upstreamStr(j?.resolution) ?? task.resolution,
                duration: upstreamNum(j?.duration) ?? task.duration,
                ratio: upstreamStr(j?.ratio) ?? task.ratio,
                seed: task.seed,
                generateAudio: task.generate_audio,
                extended,
            }),
            { headers: vendorHeaders },
        );
    }

    // v1(OpenAI-video)形:成片落客户 OSS 时,把 video_url/url 换成客户域名 URL 再回序列化;
    // 否则原样透传上游归一 JSON。
    if (customerOssVideoUrl && j) {
        j.video_url = customerOssVideoUrl;
        j.url = customerOssVideoUrl;
        return NextResponse.json(j, { status: 200, headers: vendorHeaders });
    }
    return new NextResponse(text, {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...vendorHeaders },
    });
}
