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
import { resolveEnterpriseCustomer, type EnterpriseCustomer } from './keys';
import { ENTERPRISE_TIER, estimateEnterpriseCostCny, chargeEnterpriseVideoTask } from './billing';
import { AssetError, resolveAssetRefs } from './assets';

/** 企业门户对客模型名(2026-07-20 归一,operator 拍板):按量计费下分辨率是参数不是模型名。
 *  `resolution` 参数选 720p/1080p/4k(默认 720p;4k 仅 pro),带参考图/视频/音频自动识别
 *  (不再需要 -ref 后缀)。旧 14 个长名(seedance2.0-pro-720p 等)保留兼容,不再对外宣传。 */
export const ENTERPRISE_MODELS: Record<string, SeedanceVariant> = {
    'seedance-2-0': 'pro',
    'seedance-2-0-fast': 'fast',
    'seedance-2-0-mini': 'mini',
    // 海外版(2026-07-23):同厂商国际端口,协议/档位/定价与国内一致,仅出片节点在海外(BytePlus)
    'seedance-2-0-global': 'pro',
    'seedance-2-0-global-fast': 'fast',
    'seedance-2-0-global-mini': 'mini',
    // 海外版proMax(2026-07-23):dreamina 系,费率独立(挂牌更高 ×0.85);fast/mini 仅 720p
    'seedance-2-0-promax': 'promax',
    'seedance-2-0-promax-fast': 'promax-fast',
    'seedance-2-0-promax-mini': 'promax-mini',
};

const RESOLUTIONS = ['720p', '1080p', '4k'] as const;

/** 短名 + body 参数 → 内部长名规格。非短名返回 null(走长名/未知分支)。 */
function resolveEnterpriseModel(
    rawModel: string,
    body: Record<string, unknown>,
): { spec: SeedanceModelSpec; longName: string } | { error: NextResponse } | null {
    const lower = rawModel.toLowerCase();
    const variant = ENTERPRISE_MODELS[lower];
    if (!variant) return null;
    const region = lower.includes('-promax') ? 'promax' : lower.includes('-global') ? 'global' : 'cn';
    const resRaw = String(body.resolution ?? '720p').toLowerCase();
    if (!(RESOLUTIONS as readonly string[]).includes(resRaw)) {
        return { error: errJson(400, 'invalid_request', 'resolution 仅支持 720p / 1080p / 4k') };
    }
    if (resRaw === '4k' && variant !== 'pro' && variant !== 'promax') {
        return { error: errJson(400, 'invalid_request', `${rawModel} 无 4k 档(resolution 仅 720p / 1080p)`) };
    }
    if ((variant === 'promax-fast' || variant === 'promax-mini') && resRaw !== '720p') {
        return { error: errJson(400, 'invalid_request', `${rawModel} 仅支持 720p 档`) };
    }
    const hasRefs =
        extractImageUrls(body).length > 0 ||
        extractVideoUrls(body).length > 0 ||
        extractAudioUrls(body).length > 0 ||
        (typeof body.first_frame === 'string' && body.first_frame !== '') ||
        (typeof body.last_frame === 'string' && body.last_frame !== '');
    // 长名:global 前缀在 variant 前;promax 系 variant 自带前缀(seedance2.0-promax[-fast|-mini]-…)
    const longName = `seedance2.0-${region === 'global' ? 'global-' : ''}${variant}-${resRaw}${hasRefs ? '-ref' : ''}`;
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

async function resolveOr401(req: NextRequest, expectedRegion?: string): Promise<EnterpriseCustomer | NextResponse> {
    let r: Awaited<ReturnType<typeof resolveEnterpriseCustomer>>;
    try {
        r = await resolveEnterpriseCustomer(req.headers.get('authorization'), expectedRegion);
    } catch (e) {
        console.error('[enterprise-proxy] resolve customer failed', e);
        return errJson(503, 'temporarily_unavailable', 'account lookup failed, please retry');
    }
    if (!r.ok) return errJson(r.status, r.code, r.message);
    return r.customer;
}

/** 提交:key 鉴权(绑版本)→ 模型门 → 余额门(¥账本)→ 直调适配器核心(客户上游 key)→ 记任务(fail closed)。 */
async function handleSubmit(req: NextRequest): Promise<NextResponse> {
    let body: Record<string, unknown>;
    try {
        body = (await req.json()) as Record<string, unknown>;
    } catch {
        return errJson(400, 'invalid_json', 'request body must be JSON');
    }

    const model = String(body.model || '');
    // 版本先于鉴权确定(模型名承载):key 与模型版本必须一致(单独 key,operator 决策),
    // 上游 key 也按版本行解密。未知模型按 cn 解析,后续 model_not_found 分支照常 400。
    const cust = await resolveOr401(req, regionForModel(model));
    if (cust instanceof NextResponse) return cust;

    // P3 素材库引用:asset-…/group-… → R2 公网 URL(必须在 ref/hasVideo 检测之前,
    // 视频素材引用也要计入含视频费率档)。未知/非本人 id → 400。
    try {
        body = await resolveAssetRefs(body, cust.userId);
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
    const durRaw = Number(body.duration ?? body.seconds);
    const duration = durRaw === 10 || durRaw === 15 ? durRaw : 5; // 与 cn-adapter 同步:5/10/15 三档

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

    const res = await submitVideoWithKey({ ...body, model: adapterModel }, `Bearer ${cust.upstreamKey}`);
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
            },
        });
    } catch (e) {
        // 记录失败 = 无法扣费 → 拒绝(fail closed,防生成了却收不到钱)
        console.error('[enterprise-proxy] task record failed, rejecting submit', e);
        return errJson(503, 'temporarily_unavailable', 'billing record failed, please retry');
    }
    return j
        ? NextResponse.json(j)
        : new NextResponse(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** 轮询:归属 + tier + 版本三门(IDOR)→ 直调适配器核心(按版本 base)→ 完成写 tokens + 幂等扣费 → 透传响应。 */
async function handlePoll(req: NextRequest, taskId: string): Promise<NextResponse> {
    const cust = await resolveOr401(req);
    if (cust instanceof NextResponse) return cust;

    const task = await prisma.seedanceVideoTask.findUnique({ where: { id: taskId } });
    if (!task || task.tier !== ENTERPRISE_TIER || task.user_id !== cust.userId) {
        return errJson(404, 'not_found', 'task not found');
    }
    const taskRegion: SeedanceRegion = regionForModel(task.model);
    if (cust.region !== taskRegion) {
        // 本人任务但 key 版本不符:提示换对应版本 key(不藏 404,自己的任务无枚举风险)
        return errJson(
            403,
            'region_mismatch',
            `this task belongs to the ${taskRegion} region; use your ${taskRegion} API key to poll it`,
        );
    }

    const res = await pollVideoWithKey(taskId, `Bearer ${cust.upstreamKey}`, taskRegion);
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

    return new NextResponse(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
}
