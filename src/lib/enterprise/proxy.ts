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
import { MODEL_MAP, extractVideoUrls, submitVideoWithKey, pollVideoWithKey } from '@/lib/seedance/cn-adapter';
import { resolveEnterpriseCustomer, type EnterpriseCustomer } from './keys';
import { ENTERPRISE_TIER, estimateEnterpriseCostCny, chargeEnterpriseVideoTask } from './billing';
import { AssetError, resolveAssetRefs } from './assets';

export function isEnterpriseFlavor(): boolean {
    return process.env.PORTAL_FLAVOR === 'seedance-enterprise';
}

const errJson = (status: number, code: string, message: string) =>
    NextResponse.json({ error: { code, message, type: 'invalid_request_error' } }, { status });

/** /v1 分发:models / 提交 / 轮询,其余 404。 */
export async function handleEnterpriseV1(req: NextRequest, path: string): Promise<NextResponse> {
    if (req.method === 'GET' && path === '/models') {
        return NextResponse.json({
            object: 'list',
            data: Object.keys(MODEL_MAP).map((id) => ({ id, object: 'model', owned_by: 'silkroadai-enterprise' })),
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

async function resolveOr401(req: NextRequest): Promise<EnterpriseCustomer | NextResponse> {
    let r: Awaited<ReturnType<typeof resolveEnterpriseCustomer>>;
    try {
        r = await resolveEnterpriseCustomer(req.headers.get('authorization'));
    } catch (e) {
        console.error('[enterprise-proxy] resolve customer failed', e);
        return errJson(503, 'temporarily_unavailable', 'account lookup failed, please retry');
    }
    if (!r.ok) return errJson(r.status, r.code, r.message);
    return r.customer;
}

/** 提交:key 鉴权 → 模型门 → 余额门(¥账本)→ 直调适配器核心(客户上游 key)→ 记任务(fail closed)。 */
async function handleSubmit(req: NextRequest): Promise<NextResponse> {
    const cust = await resolveOr401(req);
    if (cust instanceof NextResponse) return cust;

    let body: Record<string, unknown>;
    try {
        body = (await req.json()) as Record<string, unknown>;
    } catch {
        return errJson(400, 'invalid_json', 'request body must be JSON');
    }

    const model = String(body.model || '');
    const map = MODEL_MAP[model];
    if (!map) return errJson(400, 'model_not_found', `unknown seedance model: ${model}`);

    // P3 素材库引用:asset-…/group-… → R2 公网 URL(必须在 hasVideo 检测之前,
    // 视频素材引用也要计入含视频费率档)。未知/非本人 id → 400。
    try {
        body = await resolveAssetRefs(body, cust.userId);
    } catch (e) {
        if (e instanceof AssetError) return errJson(e.status, e.code, e.message);
        console.error('[enterprise-proxy] asset ref resolve failed', e);
        return errJson(503, 'temporarily_unavailable', 'asset lookup failed, please retry');
    }

    const hasVideo = extractVideoUrls(body).length > 0;
    const durRaw = Number(body.duration ?? body.seconds);
    const duration = durRaw === 10 ? 10 : 5;

    // 余额门(视频后付费,提交时按估价挡,防大额透支)。企业客户余额 = Account.balance_cny 唯一真相。
    try {
        const account = await prisma.account.findUnique({
            where: { user_id: cust.userId },
            select: { balance_cny: true },
        });
        const balance = account ? Number(account.balance_cny) : 0;
        const est = await estimateEnterpriseCostCny(cust.userId, map.resolution, duration, hasVideo);
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

    const res = await submitVideoWithKey(body, `Bearer ${cust.upstreamKey}`);
    const text = await res.text();
    if (!res.ok) return new NextResponse(text, { status: res.status, headers: { 'Content-Type': 'application/json' } });
    let j: { id?: string; task_id?: string } | null;
    try {
        j = JSON.parse(text) as { id?: string; task_id?: string };
    } catch {
        j = null;
    }
    const taskId = j?.task_id || j?.id;
    if (!taskId) return errJson(502, 'upstream_error', 'no task_id from upstream');

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
    return new NextResponse(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** 轮询:归属 + tier 双门(IDOR)→ 直调适配器核心 → 完成写 tokens + 幂等扣费 → 透传响应。 */
async function handlePoll(req: NextRequest, taskId: string): Promise<NextResponse> {
    const cust = await resolveOr401(req);
    if (cust instanceof NextResponse) return cust;

    const task = await prisma.seedanceVideoTask.findUnique({ where: { id: taskId } });
    if (!task || task.tier !== ENTERPRISE_TIER || task.user_id !== cust.userId) {
        return errJson(404, 'not_found', 'task not found');
    }

    const res = await pollVideoWithKey(taskId, `Bearer ${cust.upstreamKey}`);
    const text = await res.text();
    if (!res.ok) return new NextResponse(text, { status: res.status, headers: { 'Content-Type': 'application/json' } });
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
        // 失败不计费(火山对失败不收费)
        await prisma.seedanceVideoTask.update({ where: { id: taskId }, data: { status: 'failed' } }).catch(() => {});
    }

    return new NextResponse(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
}
