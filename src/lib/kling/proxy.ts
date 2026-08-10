/**
 * Kling 视频【/v1 代理端到端自扣】—— 绕过 new-api,直连上游 token.xinhankr.com。
 *
 * 为什么绕过 new-api:上游是自研网关(tokensbyte),提交/查询格式 = new-api 统一视频格式
 * (`POST /v1/video/generations` → `{id,status}`,`GET .../{id}` → `{id,status,data:[{url}]}`),
 * 但 new-api 没有「上游也是统一格式」的中继适配器 —— Kling 渠道类型(50)会拼 `/kling` 前缀
 * (上游 405)且按可灵官方格式解析(不合);OpenAI 类型走 Sora 适配器打 `/v1/videos`(上游 404)。
 * 穷举验证见 2026-08-10 session。客户格式 = 上游格式 → 本模块纯转发,只加鉴权 + 计费。
 *
 * 计费(镜像 seedance/cn-proxy):提交时按价表算定总价(¥/秒 × duration)+ 余额门 + 落库;
 * 轮询 completed → chargeKlingVideoTask 幂等扣费;failed → 不收费。
 *
 * ⚠️ 需 portal .env 配 KLING_UPSTREAM_KEY(上游渠道 key);缺配 → 提交 503(有声报错,不静默)。
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCustomerBalance } from '@/lib/billing/customer-balance';
import { resolveCustomer } from '@/lib/seedance/cn-proxy';
import { isKlingVideoModel, normalizeKlingResolution, computeKlingCostCny, chargeKlingVideoTask } from './billing';

export { isKlingVideoModel };

const UPSTREAM_BASE = process.env.KLING_UPSTREAM_BASE_URL || 'https://token.xinhankr.com';
const UPSTREAM_KEY = process.env.KLING_UPSTREAM_KEY || '';

/** 上游生成耗时实测 ~20s,但排队期未知;给宽超时防挂死连接池。 */
const UPSTREAM_TIMEOUT_MS = 120_000;

const errJson = (status: number, code: string, message: string) =>
    NextResponse.json({ error: { code, message, type: 'invalid_request_error' } }, { status });

const upstream = (path: string, init: RequestInit = {}) =>
    fetch(`${UPSTREAM_BASE}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${UPSTREAM_KEY}`,
            'Content-Type': 'application/json',
            ...(init.headers || {}),
        },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

/** 输入是否含参考视频(kling-v3-omni 的 videos 数组)→ 含视频费率档。 */
function hasVideoInput(body: Record<string, unknown>): boolean {
    return Array.isArray(body.videos) && body.videos.length > 0;
}

/** 计费时长:整数 1-600 透传值,其余回落 5(与上游缺省一致;body 原样转发不改写)。 */
function billableDuration(body: Record<string, unknown>): number {
    const d = Number(body.duration);
    return Number.isInteger(d) && d >= 1 && d <= 600 ? d : 5;
}

/** 提交:鉴权 → 定价(fail closed)→ 余额门 → 直连上游 → 记录任务(归属 + 定价)。 */
export async function handleKlingVideoSubmit(req: NextRequest, body: Record<string, unknown>): Promise<NextResponse> {
    const model = String(body.model || '');
    if (!isKlingVideoModel(model)) return errJson(400, 'model_not_found', `unknown kling model: ${model}`);
    if (!UPSTREAM_KEY) {
        console.error('[kling-proxy] KLING_UPSTREAM_KEY not configured');
        return errJson(503, 'temporarily_unavailable', 'kling upstream not configured');
    }

    // 1) 客户身份 + key 状态(portal 全量客户可用,无档次门)
    let cust;
    try {
        cust = await resolveCustomer(req.headers.get('authorization'));
    } catch (e) {
        console.error('[kling-proxy] resolveCustomer failed', e);
        return errJson(503, 'temporarily_unavailable', 'account lookup failed, please retry');
    }
    if (!cust || !cust.active) return errJson(401, 'invalid_api_key', 'invalid or inactive API key');

    // 2) 定价(fail closed:价表没有的组合直接 400,不猜价)
    const resolution = normalizeKlingResolution(body.resolution);
    if (!resolution) return errJson(400, 'invalid_request_error', `unsupported resolution: ${String(body.resolution)}`);
    const generateAudio = body.generate_audio === true;
    const hasVideo = hasVideoInput(body);
    const duration = billableDuration(body);
    const costCny = computeKlingCostCny(model, resolution, generateAudio, hasVideo, duration);
    if (costCny == null) return errJson(400, 'invalid_request_error', `${model} 不支持 ${resolution} 档(无挂牌价)`);

    // 3) 余额门(时长计费提交时即知总价,精确挡)
    try {
        const bal = await getCustomerBalance(cust.userId);
        if (bal.balanceCny < costCny)
            return errJson(
                402,
                'insufficient_balance',
                `余额不足(需 ¥${costCny.toFixed(2)},当前 ¥${bal.balanceCny.toFixed(2)})`,
            );
    } catch (e) {
        console.warn('[kling-proxy] balance gate skipped (lookup failed)', e);
        // 余额查询失败不硬阻断(避免 new-api/DB 抖动误杀),记日志继续
    }

    // 4) 直连上游提交(客户 body 原样转发 —— 上游格式即客户格式)
    let up: Response;
    try {
        up = await upstream('/v1/video/generations', { method: 'POST', body: JSON.stringify(body) });
    } catch (e) {
        return errJson(502, 'upstream_unreachable', `kling upstream unreachable: ${String(e)}`);
    }
    const text = await up.text();
    if (!up.ok) return new NextResponse(text, { status: up.status, headers: { 'Content-Type': 'application/json' } });
    let j: { id?: string; task_id?: string } | null;
    try {
        j = JSON.parse(text) as { id?: string; task_id?: string };
    } catch {
        j = null;
    }
    const taskId = j?.id || j?.task_id;
    if (!taskId) return errJson(502, 'upstream_error', 'no task id from kling upstream');

    // 5) 记录任务(归属 + 定价),供轮询扣费 + IDOR
    try {
        await prisma.klingVideoTask.create({
            data: {
                id: taskId,
                tenant_id: cust.tenantId,
                user_id: cust.userId,
                newapi_user_id: cust.newapiUserId,
                model,
                resolution,
                generate_audio: generateAudio,
                has_video: hasVideo,
                duration,
                cost_cny: costCny,
            },
        });
    } catch (e) {
        // 记录失败 = 无法扣费 → 拒绝(fail closed,防生成了却收不到钱)
        console.error('[kling-proxy] task record failed, rejecting submit', e);
        return errJson(503, 'temporarily_unavailable', 'billing record failed, please retry');
    }
    return new NextResponse(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** 是否我们记录过的 kling 任务(轮询路由用)。 */
export async function isKlingVideoTask(taskId: string): Promise<boolean> {
    const t = await prisma.klingVideoTask.findUnique({ where: { id: taskId }, select: { id: true } });
    return !!t;
}

/** 轮询:IDOR 校验 → 直连上游 → completed 幂等扣费 / failed 免单 → 响应原样返回。 */
export async function handleKlingVideoPoll(req: NextRequest, taskId: string): Promise<NextResponse> {
    const task = await prisma.klingVideoTask.findUnique({ where: { id: taskId } });
    if (!task) return errJson(404, 'not_found', 'task not found');
    // IDOR:只有归属客户能轮询
    const cust = await resolveCustomer(req.headers.get('authorization')).catch(() => null);
    if (!cust || cust.userId !== task.user_id) return errJson(404, 'not_found', 'task not found');

    let up: Response;
    try {
        up = await upstream(`/v1/video/generations/${encodeURIComponent(taskId)}`);
    } catch (e) {
        return errJson(502, 'upstream_unreachable', `kling upstream unreachable: ${String(e)}`);
    }
    const text = await up.text();
    if (!up.ok) return new NextResponse(text, { status: up.status, headers: { 'Content-Type': 'application/json' } });
    let j: Record<string, unknown> | null;
    try {
        j = JSON.parse(text) as Record<string, unknown>;
    } catch {
        j = null;
    }

    if (j && j.status === 'completed') {
        if (task.status !== 'completed') {
            await prisma.klingVideoTask
                .update({ where: { id: taskId }, data: { status: 'completed' } })
                .catch((e) => console.warn('[kling-proxy] write status failed', e));
        }
        try {
            const r = await chargeKlingVideoTask(taskId);
            if (r.outcome === 'deduct_failed')
                console.error('[kling-proxy] charge deduct_failed', { taskId, cost: r.costCny });
        } catch (e) {
            console.error('[kling-proxy] charge threw', e);
        }
    } else if (j && j.status === 'failed' && task.status !== 'failed') {
        // 失败不计费(上游时长计费按成片收)
        await prisma.klingVideoTask.update({ where: { id: taskId }, data: { status: 'failed' } }).catch(() => {});
    }

    return new NextResponse(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
}
