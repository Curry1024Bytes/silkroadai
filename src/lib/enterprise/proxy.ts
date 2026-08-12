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
    VOLC_MODEL,
    extractImageUrls,
    extractVideoUrls,
    extractAudioUrls,
    submitVideoWithKey,
    pollVideoWithKey,
    regionForModel,
    type SeedanceModelSpec,
    type SeedanceVariant,
    type SeedanceRegion,
} from '@/lib/seedance/cn-adapter';
import { submitVolcVideo, pollVolcVideo } from '@/lib/seedance/volc-adapter';
import { resolveEnterpriseAuth, getUpstreamKeyForUser, type EnterpriseCustomer } from './keys';
import { ENTERPRISE_TIER, estimateEnterpriseCostCny, chargeEnterpriseVideoTask } from './billing';
import { AssetError, resolveAssetRefs } from './assets';
import { normalizeArkModel, stripAssetUri, arkStatus, buildArkTaskResponse } from './ark-format';

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
    // 「火山」渠道:单模型 doubao-seedance-2.0,pro 档,resolution 参数 + ref 自动识别。
    // 走独立 provider(火山方舟原生),不经 MODEL_MAP 长名机制。
    if (lower === VOLC_MODEL) {
        const resRaw = String(body.resolution ?? '720p').toLowerCase();
        if (!(RESOLUTIONS as readonly string[]).includes(resRaw)) {
            return { error: errJson(400, 'invalid_request', 'resolution 仅支持 480p / 720p / 1080p / 4k') };
        }
        const hasRefs =
            extractImageUrls(body).length > 0 ||
            extractVideoUrls(body).length > 0 ||
            extractAudioUrls(body).length > 0 ||
            (typeof body.first_frame === 'string' && body.first_frame !== '') ||
            (typeof body.last_frame === 'string' && body.last_frame !== '');
        return {
            spec: {
                resolution: resRaw as '480p' | '720p' | '1080p' | '4k',
                ref: hasRefs,
                variant: 'pro',
                upstream: VOLC_MODEL,
                region: 'volc',
            },
            longName: VOLC_MODEL,
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
    const poll = /^\/contents\/generations\/tasks\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && poll) {
        return handlePoll(req, decodeURIComponent(poll[1]), 'ark');
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

/** 提交:key 鉴权(绑版本)→ 模型门 → 余额门(¥账本)→ 直调适配器核心(客户上游 key)→ 记任务(fail closed)。 */
async function handleSubmit(req: NextRequest, format: ClientFormat = 'v1'): Promise<NextResponse> {
    // 先读原始 body(AK/SK 验签对原始字节算 hash),再解析 + 归一。
    const rawBody = await req.text();
    let body: Record<string, unknown>;
    try {
        body = rawBody.trim() ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    } catch {
        return errJson(400, 'invalid_json', 'request body must be JSON');
    }

    // 入口归一:火山 model id(doubao-…)→ 内部短名(先归一 model 才能判 region)。
    body.model = normalizeArkModel(String(body.model || ''));

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

    const hasVideo = extractVideoUrls(body).length > 0;
    // duration:全渠道 4-15 任意整数秒(2026-08-03 探测:volc/cn/global 上游 3s/16s 皆 400,
    // 4s 全变体真出片)。缺省 5;显式非法值 400(不静默改秒数 —— 计费按 token,静默换时长=换价)。
    const durRaw = Number(body.duration ?? body.seconds);
    let duration: number;
    if (body.duration == null && body.seconds == null) {
        duration = 5;
    } else if (Number.isInteger(durRaw) && durRaw >= 4 && durRaw <= 15) {
        duration = durRaw;
    } else {
        return errJson(400, 'invalid_request', 'duration 仅支持 4-15 之间的整数秒');
    }

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
            duration,
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
            ? await submitVolcVideo(body, map.resolution, duration)
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

    // 非 volc 轮询要打客户上游:sk-ent 用鉴权时装载的 cust.upstreamKey;AK/SK 账号级(/api 轮询
    // 未按 region 装载,cust.upstreamKey='')→ 按【任务的 region】补加载客户上游 key。
    let upstreamKey = cust.upstreamKey;
    if (taskRegion !== 'volc' && cust.accountLevel) {
        const k = await getUpstreamKeyForUser(cust.userId, taskRegion);
        if (!k) return errJson(503, 'account_not_configured', 'no upstream key configured for this region');
        upstreamKey = k;
    }

    const res =
        taskRegion === 'volc'
            ? await pollVolcVideo(taskId)
            : await pollVideoWithKey(taskId, `Bearer ${upstreamKey}`, taskRegion);
    const text = await res.text();
    if (!res.ok) {
        console.warn('[enterprise-proxy] poll error', {
            user_id: cust.userId,
            task_id: taskId,
            status: res.status,
            body: text.slice(0, 2000),
        });
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
        return NextResponse.json(
            buildArkTaskResponse({
                taskId,
                internalModel: task.model,
                status: arkStatus(String(ourStatus)),
                videoUrl: typeof j?.video_url === 'string' ? j.video_url : ((j?.url as string | undefined) ?? null),
                lastFrameUrl: typeof j?.last_frame_url === 'string' ? j.last_frame_url : null,
                usage,
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

    return new NextResponse(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
}
