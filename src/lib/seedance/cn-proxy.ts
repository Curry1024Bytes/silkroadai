/**
 * seedance-cn 视频【/v1 代理端到端自扣】—— 绕过 new-api,代理直连本地适配器(带渠道 key),
 * 自己做:①客户身份+档次门控+余额门 ②记录任务(归属)③轮询完成按真 usage 扣费。
 *
 * 为什么绕过 new-api:new-api 对视频任务不读上游 usage、换 task-id、不给适配器客户身份,
 * 所以「精确按 token(含参考视频)」只能由拿得到客户 sk 的 /v1 代理来做(见 cn-billing 注释)。
 * 代理【自调本地适配器 HTTP 端点】(同一 portal 进程,无 new-api 居中 → usage 不被剥),
 * 用渠道 key 鉴权,复用适配器的全部翻译/媒体/R2 逻辑,不重复实现。
 *
 * ⚠️ 需 portal .env 配 SEEDANCE_XHK_KEY(渠道/上游 key);代理用它调适配器,适配器再用它调上游。
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCustomerBalance } from '@/lib/billing/customer-balance';
import { MODEL_MAP, extractVideoUrls } from './cn-adapter';
import { chargeSeedanceVideoTask, estimateCostCny, type Resolution } from './cn-billing';

/** 适配器内网地址(同 portal 进程自调);渠道 base_url 同款,默认自指 127.0.0.1。 */
const ADAPTER_BASE = process.env.SEEDANCE_CN_ADAPTER_BASE || 'http://127.0.0.1:3002/seedance-cn-adapter';
const CHANNEL_KEY = process.env.SEEDANCE_XHK_KEY || '';
/** 只有这个档次的 key 能调 seedance-cn 视频(= portal channel_groups.key)。 */
const ENTERPRISE_TIER = process.env.SEEDANCE_CN_TIER || 'seedance-cn-enterprise';

/** 是否 seedance-cn 视频模型(6 档)。 */
export function isSeedanceCnModel(model: string): boolean {
    return model in MODEL_MAP;
}

interface Customer {
    userId: string;
    tenantId: string | null;
    billingMode: string;
    newapiUserId: number | null;
    tier: string;
    active: boolean;
}

/** 客户 sk → { 用户, 档次, 状态, billing_mode }。找不到返 null。 */
async function resolveCustomer(auth: string | null): Promise<Customer | null> {
    const m = auth?.match(/^Bearer\s+(.+)$/i);
    if (!m) return null;
    const raw = m[1].startsWith('sk-') ? m[1].slice(3) : m[1];
    if (!raw) return null;
    const token = await prisma.newApiToken.findUnique({
        where: { newapi_token_value: raw },
        select: { user_id: true, tier: true, status: true },
    });
    if (!token) return null;
    const user = await prisma.user.findUnique({
        where: { id: token.user_id },
        select: { tenant_id: true, billing_mode: true, newapi_user_id: true },
    });
    if (!user) return null;
    return {
        userId: token.user_id,
        tenantId: user.tenant_id,
        billingMode: user.billing_mode,
        newapiUserId: user.newapi_user_id,
        tier: token.tier,
        active: token.status === 'active',
    };
}

const errJson = (status: number, code: string, message: string) =>
    NextResponse.json({ error: { code, message, type: 'invalid_request_error' } }, { status });

const adapter = (path: string, init: RequestInit = {}) =>
    fetch(`${ADAPTER_BASE}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${CHANNEL_KEY}`,
            'Content-Type': 'application/json',
            ...(init.headers || {}),
        },
    });

/** 提交:门控 → 调适配器 → 记录任务(归属 + 分辨率 + 是否含视频)。 */
export async function handleSeedanceVideoSubmit(
    req: NextRequest,
    body: Record<string, unknown>,
): Promise<NextResponse> {
    const model = String(body.model || '');
    const map = MODEL_MAP[model];
    if (!map) return errJson(400, 'model_not_found', `unknown seedance-cn model: ${model}`);

    // 1) 客户身份 + 档次门控 + key 状态
    let cust: Customer | null;
    try {
        cust = await resolveCustomer(req.headers.get('authorization'));
    } catch (e) {
        console.error('[seedance-cn-proxy] resolveCustomer failed', e);
        return errJson(503, 'temporarily_unavailable', 'account lookup failed, please retry');
    }
    if (!cust || !cust.active) return errJson(401, 'invalid_api_key', 'invalid or inactive API key');
    if (cust.tier !== ENTERPRISE_TIER)
        return errJson(403, 'model_not_available', `${model} 需「seedance 国内企业级端口」档 key`);

    const hasVideo = extractVideoUrls(body).length > 0;
    const durRaw = Number(body.duration ?? body.seconds);
    const duration = durRaw === 10 ? 10 : 5;

    // 2) 余额门(视频后付费 + 绕过 new-api,提交时先估价挡,防大额透支)
    try {
        const bal = await getCustomerBalance(cust.userId);
        const est = estimateCostCny(map.resolution as Resolution, duration, hasVideo, map.variant);
        if (bal.balanceCny < est)
            return errJson(
                402,
                'insufficient_balance',
                `余额不足(需约 ¥${est.toFixed(2)},当前 ¥${bal.balanceCny.toFixed(2)})`,
            );
    } catch (e) {
        console.warn('[seedance-cn-proxy] balance gate skipped (lookup failed)', e);
        // 余额查询失败不硬阻断(避免 new-api/DB 抖动误杀),记日志继续
    }

    // 3) 调本地适配器提交(渠道 key)
    let up: Response;
    try {
        up = await adapter('/v1/videos', { method: 'POST', body: JSON.stringify(body) });
    } catch (e) {
        return errJson(502, 'upstream_unreachable', `adapter unreachable: ${String(e)}`);
    }
    const text = await up.text();
    if (!up.ok) return new NextResponse(text, { status: up.status, headers: { 'Content-Type': 'application/json' } });
    let j: { id?: string; task_id?: string } | null;
    try {
        j = JSON.parse(text) as { id?: string; task_id?: string };
    } catch {
        j = null;
    }
    const taskId = j?.task_id || j?.id;
    if (!taskId) return errJson(502, 'upstream_error', 'no task_id from adapter');

    // 4) 记录任务(归属),供轮询扣费 + dashboard 用量
    try {
        await prisma.seedanceVideoTask.create({
            data: {
                id: taskId,
                tenant_id: cust.tenantId,
                user_id: cust.userId,
                newapi_user_id: cust.newapiUserId,
                tier: cust.tier,
                model,
                resolution: map.resolution,
                has_video: hasVideo,
                duration,
            },
        });
    } catch (e) {
        // 记录失败 = 无法扣费 → 拒绝(fail closed,防生成了却收不到钱)
        console.error('[seedance-cn-proxy] task record failed, rejecting submit', e);
        return errJson(503, 'temporarily_unavailable', 'billing record failed, please retry');
    }
    return new NextResponse(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** 是否我们记录过的 seedance-cn 任务(轮询路由用)。 */
export async function isSeedanceCnTask(taskId: string): Promise<boolean> {
    const t = await prisma.seedanceVideoTask.findUnique({ where: { id: taskId }, select: { id: true } });
    return !!t;
}

/** 轮询:IDOR 校验 → 调适配器 → 完成时写 tokens + 扣费 → 返成片。 */
export async function handleSeedanceVideoPoll(req: NextRequest, taskId: string): Promise<NextResponse> {
    const task = await prisma.seedanceVideoTask.findUnique({ where: { id: taskId } });
    if (!task) return errJson(404, 'not_found', 'task not found');
    // IDOR:只有归属客户能轮询
    const cust = await resolveCustomer(req.headers.get('authorization')).catch(() => null);
    if (!cust || cust.userId !== task.user_id) return errJson(404, 'not_found', 'task not found');

    let up: Response;
    try {
        up = await adapter(`/v1/videos/${encodeURIComponent(taskId)}`);
    } catch (e) {
        return errJson(502, 'upstream_unreachable', `adapter unreachable: ${String(e)}`);
    }
    const text = await up.text();
    if (!up.ok) return new NextResponse(text, { status: up.status, headers: { 'Content-Type': 'application/json' } });
    let j: Record<string, unknown> | null;
    try {
        j = JSON.parse(text) as Record<string, unknown>;
    } catch {
        j = null;
    }

    // 完成 → 写真实 tokens(若尚未)→ 扣费(幂等)
    if (j && j.status === 'completed') {
        const usage = j.usage as { completion_tokens?: number; total_tokens?: number } | undefined;
        const tokens = usage?.completion_tokens ?? usage?.total_tokens;
        if (tokens && tokens > 0 && task.tokens == null) {
            await prisma.seedanceVideoTask
                .update({ where: { id: taskId }, data: { tokens: BigInt(tokens), status: 'completed' } })
                .catch((e) => console.warn('[seedance-cn-proxy] write tokens failed', e));
        }
        try {
            const r = await chargeSeedanceVideoTask(taskId);
            if (r.outcome === 'deduct_failed')
                console.error('[seedance-cn-proxy] charge deduct_failed', { taskId, cost: r.costCny });
        } catch (e) {
            console.error('[seedance-cn-proxy] charge threw', e);
        }
    } else if (j && j.status === 'failed' && task.status !== 'failed') {
        await prisma.seedanceVideoTask.update({ where: { id: taskId }, data: { status: 'failed' } }).catch(() => {}); // 失败不计费(火山对失败不收费)
    }

    return new NextResponse(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
}
