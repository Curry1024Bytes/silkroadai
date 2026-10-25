/**
 * 企业门户任务回调投递(2026-10-19,智象 10-18 四线报告「callback 四线全失败」后立项)。
 *
 * 语义对齐火山官方:任务到达终态(succeeded / failed)后,向提交时给的 `callback_url` POST 一次,
 * body = 客户按同一入口查询该任务会拿到的响应体(/v1 形或 /api/v3 火山形,按提交入口定)。
 * 终态由两条路发现:客户轮询(proxy.handlePoll)/ 对账器(reconcile,含定时 sweep)—— 两条路都调
 * `fireTaskCallback`,靠任务终态及 `callback_status` CAS(pending → sending)抢占一次投递流程。
 * 网络超时可能造成重复通知，接收方按 X-Task-Id 去重；进程中断后 sending 不自动重放，需人工核查。
 *
 * 安全:
 *  - `callback_url` 从不转发给上游(cn-adapter NEVER_FORWARD_KEYS,#271),由我们投递;
 *  - 默认关闭；启用后仅公网 http(s)/IPv4；URL校验与socket DNS检查共同防私网及重绑定;
 *  - 不跟随重定向(redirect: manual)、10s 超时、body 就是对客响应体(已脱敏,无上游号)。
 * 投递:2xx 视为送达;否则按 [0s, 5s, 30s] 重试共 3 次,仍失败标 failed(callback_error 记最后一次原因)。
 * 结果落企业请求日志(kind='callback'),后台可查。
 */
import 'server-only';
import { prisma } from '@/lib/db';
import { isIPv4 } from 'node:net';
import { callbackDispatcher, isPublicCallbackIpv4 } from './callback-network';
import { writeRequestLog, type RequestLogCtx } from './request-log';

export const CALLBACK_TIMEOUT_MS = 10_000;
export const CALLBACK_RETRY_DELAYS_MS: readonly number[] = [0, 5_000, 30_000];
const MAX_URL_LEN = 2000;

export const enterpriseCallbacksEnabled = (): boolean => process.env.PORTAL_ENTERPRISE_CALLBACK_ENABLED === 'true';

export type CallbackUrlCheck = { ok: true; url: string } | { ok: false; message: string };

/** 校验客户传的 callback_url。未传(undefined / null / '')→ null;传了但不合法 → {ok:false}。 */
export function validateCallbackUrl(raw: unknown): CallbackUrlCheck | null {
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'string') return { ok: false, message: 'callback_url 必须是字符串' };
    const s = raw.trim();
    if (!s) return null;
    if (s.length > MAX_URL_LEN) return { ok: false, message: `callback_url 过长(最多 ${MAX_URL_LEN} 字符)` };
    let u: URL;
    try {
        u = new URL(s);
    } catch {
        return { ok: false, message: 'callback_url 不是合法 URL' };
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return { ok: false, message: 'callback_url 仅支持 http(s)' };
    }
    const h = u.hostname.toLowerCase().replace(/\.$/, '');
    const bad =
        u.username !== '' ||
        u.password !== '' ||
        !h.includes('.') ||
        h === 'localhost' ||
        h.endsWith('.localhost') ||
        h.endsWith('.local') ||
        h.endsWith('.internal') ||
        h.includes(':') ||
        h.startsWith('[') ||
        (isIPv4(h) && !isPublicCallbackIpv4(h));
    if (bad) return { ok: false, message: 'callback_url 必须是公网可达的 http(s) 地址' };
    return { ok: true, url: u.toString() };
}

export interface CallbackTaskRef {
    id: string;
    callback_url?: string | null;
    callback_status?: string | null;
}

/** 该任务要不要投递:有 URL 且还没投过(pending)。sent / failed / sending 都不再投。 */
export function shouldFireCallback(t: CallbackTaskRef | null | undefined): boolean {
    return enterpriseCallbacksEnabled() && !!t && !!t.callback_url && t.callback_status === 'pending';
}

export type CallbackOutcome = 'sent' | 'failed' | 'skipped';

export interface DeliverOptions {
    /** 测试用:覆盖重试间隔。 */
    delaysMs?: readonly number[];
    fetchImpl?: typeof fetch;
}

/**
 * 投递一次(含重试)。CAS 抢占:只有 pending 行能被本次调用接走;抢不到(已投/并发在投)→ 'skipped'。
 * 绝不抛:任何异常都收敛成 'failed' 并落库,调用方 fire-and-forget 即可。
 */
export async function deliverTaskCallback(
    taskId: string,
    body: Record<string, unknown>,
    opts: DeliverOptions = {},
): Promise<CallbackOutcome> {
    if (!enterpriseCallbacksEnabled()) return 'skipped';
    const terminalStatus =
        body.status === 'succeeded' || body.status === 'completed'
            ? 'completed'
            : body.status === 'failed'
              ? 'failed'
              : null;
    if (!terminalStatus) return 'skipped';
    const t0 = Date.now();
    let row: { callback_url: string | null; user_id: string; model: string; status: string } | null = null;
    try {
        const claimed = await prisma.seedanceVideoTask.updateMany({
            where: {
                id: taskId,
                callback_status: 'pending',
                status: terminalStatus,
                ...(terminalStatus === 'failed' ? { billed: false } : {}),
            },
            data: { callback_status: 'sending' },
        });
        if (claimed.count === 0) return 'skipped';
        row = await prisma.seedanceVideoTask.findUnique({
            where: { id: taskId },
            select: { callback_url: true, user_id: true, model: true, status: true },
        });
    } catch (e) {
        console.warn('[enterprise-callback] claim failed', { taskId, err: String(e) });
        return 'failed';
    }
    const url = row?.callback_url;
    const check = validateCallbackUrl(url);
    if (!url || !check?.ok || row?.status !== terminalStatus) {
        await finish(taskId, 'failed', 'callback URL or terminal state is invalid');
        return 'failed';
    }
    const delays = opts.delaysMs ?? CALLBACK_RETRY_DELAYS_MS;
    const doFetch = opts.fetchImpl ?? fetch;
    const payload = JSON.stringify(body);
    let lastErr = '';
    let lastStatus: number | null = null;
    for (let i = 0; i < delays.length; i++) {
        if (delays[i] > 0) await new Promise((r) => setTimeout(r, delays[i]));
        try {
            const res = await doFetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'LLmRoute-callback/1.0',
                    'X-Task-Id': taskId,
                },
                body: payload,
                redirect: 'manual',
                signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
                dispatcher: callbackDispatcher,
            } as RequestInit & { dispatcher: typeof callbackDispatcher });
            await res.body?.cancel().catch(() => {});
            lastStatus = res.status;
            if (res.status >= 200 && res.status < 300) {
                await finish(taskId, 'sent', null);
                console.log('[enterprise-callback] sent', { taskId, status: res.status, attempt: i + 1 });
                logCallback(row, taskId, t0, 'sent', res.status, i + 1);
                return 'sent';
            }
            lastErr = `HTTP ${res.status}`;
        } catch (e) {
            lastErr = String(e).slice(0, 200);
        }
        console.warn('[enterprise-callback] attempt failed', { taskId, attempt: i + 1, err: lastErr });
    }
    await finish(taskId, 'failed', lastErr || 'unknown');
    logCallback(row, taskId, t0, 'failed', lastStatus, delays.length, lastErr);
    return 'failed';
}

async function finish(taskId: string, status: 'sent' | 'failed', error: string | null): Promise<void> {
    try {
        await prisma.seedanceVideoTask.updateMany({
            where: { id: taskId, callback_status: 'sending' },
            data: {
                callback_status: status,
                callback_sent_at: status === 'sent' ? new Date() : null,
                callback_error: error ? error.slice(0, 500) : null,
            },
        });
    } catch (e) {
        console.warn('[enterprise-callback] finish write failed', { taskId, status, err: String(e) });
    }
}

function logCallback(
    row: { user_id: string; model: string } | null,
    taskId: string,
    startedAt: number,
    outcome: 'sent' | 'failed',
    status: number | null,
    attempts: number,
    err?: string,
): void {
    const ctx: RequestLogCtx = {
        kind: 'callback',
        startedAt,
        userId: row?.user_id ?? null,
        model: row?.model ?? null,
        taskId,
        outcome,
        upstreamStatus: status,
        upstreamBody: err ? `attempts=${attempts} ${err}` : `attempts=${attempts}`,
    };
    writeRequestLog(ctx);
}

/** fire-and-forget:客户轮询 / 对账路径上调用,不阻塞响应、不抛。 */
export function fireTaskCallback(taskId: string, body: Record<string, unknown>): void {
    void deliverTaskCallback(taskId, body).catch((e) =>
        console.warn('[enterprise-callback] deliver threw', { taskId, err: String(e) }),
    );
}
