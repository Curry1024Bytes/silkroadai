/**
 * 企业门户请求日志采集(2026-09-03)—— 持久化的「一条请求的全貌」。
 *
 * 背景:此前请求级细节(入参 / 上游响应 / 耗时 / 归属)只在 console.log → docker logs,
 * 容器重建即清零(#260 教训),3 副本分散无法筛选导出;持久化的只有 seedance_video_tasks
 * 任务终态账本。本模块把每条请求落 enterprise_request_logs,供 /enterprise-admin/logs
 * 筛选 / 查错 / 对账 / 导出。
 *
 * 写入策略(operator 拍板 2026-09-03):
 *  - submit:全量记录,含没过鉴权/余额门就被拒的(对账要数得到被拒的);
 *  - poll:只记有信息量的 —— 出错(含没打到上游的 401/403/404/400)/ 状态迁移 / 终态;
 *    上游错误只记「真打了上游」那次(缓存重放不刷屏);ENTERPRISE_REQLOG_POLL_ALL=1 临时全量;
 *  - reconcile:对账器补的终态动作(补扣 / 标失败 / 过期);
 *  - asset_action(P2 2026-09-04):素材库 /api Action 全量(CRUD + 真人认证;量级远低于
 *    轮询,全记;format 列复用为素材落库位置 platform | kuaizi)。
 *
 * 红线:写日志绝不影响客户请求 —— fire-and-forget,任何失败(含同步异常)只 console.warn。
 * upstream_body 含上游中间商域名,该表 admin-only(#271)。
 */
import 'server-only';
import { prisma } from '@/lib/db';
import { parseDay } from './query';

/** 保留天数(主站实例定时清理用;企业实例不跑 cron,同库)。 */
export function reqlogRetentionDays(): number {
    const n = Number(process.env.ENTERPRISE_REQLOG_RETENTION_DAYS);
    return Number.isInteger(n) && n > 0 ? n : 60;
}

const MAX_BODY_BYTES = 32 * 1024; // request_body / upstream_body 各自上限
const MAX_INLINE_STRING = 2048; // 入参里超过这个长度的字符串按媒体/大块内容处理,替换成占位符
const MAX_ERROR_MESSAGE = 500;

export interface RequestLogCtx {
    kind: 'submit' | 'poll' | 'reconcile' | 'asset_action';
    format?: 'v1' | 'ark' | 'platform' | 'kuaizi';
    startedAt: number;
    userId?: string | null;
    keyId?: string | null;
    region?: string | null;
    model?: string | null;
    taskId?: string | null;
    vendorTaskId?: string | null;
    clientRequestId?: string | null;
    /** 素材库 Action 名(asset_action 行专用)。 */
    action?: string | null;
    /** 素材/素材组 id(asset_action 行专用;检索 q 也命中它)。 */
    resourceId?: string | null;
    requestBody?: string | null; // 已脱媒 + 截断
    upstreamStatus?: number | null;
    upstreamBody?: string | null;
    upstreamMs?: number | null;
    cacheHit?: boolean;
    clientIp?: string | null;
    userAgent?: string | null;
    /** poll 用:进入时库里的状态 / 本次轮询后的状态(用于「状态迁移才记」判定)。 */
    statusBefore?: string | null;
    statusAfter?: string | null;
    /** 显式结果标签(reconcile 动作);缺省由 statusBefore→statusAfter 迁移推导。 */
    outcome?: string | null;
}

export function newRequestLogCtx(
    kind: RequestLogCtx['kind'],
    format?: RequestLogCtx['format'],
    req?: { headers: Headers },
): RequestLogCtx {
    const ctx: RequestLogCtx = { kind, format, startedAt: Date.now() };
    try {
        if (req) {
            const fwd = req.headers.get('x-forwarded-for');
            ctx.clientIp = fwd ? fwd.split(',')[0].trim().slice(0, 64) : null;
            ctx.userAgent = req.headers.get('user-agent')?.slice(0, 256) ?? null;
        }
    } catch {
        // header 读取失败不影响主链路
    }
    return ctx;
}

/**
 * 入参脱媒 + 截断:base64 data URL / 超长字符串(内联媒体、巨型 prompt)替换成占位符,
 * 整体 JSON 超 32KB 再硬截。日志要的是「客户传了什么参数」,不是媒体字节本身。
 */
export function sanitizeRequestBody(raw: string): string {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // 非 JSON(客户端发错了)原样留前缀 —— 这正是排障要看的
        return raw.slice(0, 4096);
    }
    const walk = (v: unknown): unknown => {
        if (typeof v === 'string') {
            if (/^data:/i.test(v)) {
                const mime = /^data:([a-z0-9/.+-]+)[;,]/i.exec(v)?.[1] ?? 'unknown';
                return `[data-url ${mime} ${formatBytes(v.length)} omitted]`;
            }
            if (v.length > MAX_INLINE_STRING) {
                return `${v.slice(0, MAX_INLINE_STRING)}…[${v.length} chars total]`;
            }
            return v;
        }
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
            return out;
        }
        return v;
    };
    const s = JSON.stringify(walk(parsed));
    return s.length > MAX_BODY_BYTES ? s.slice(0, MAX_BODY_BYTES) + '…[truncated]' : s;
}

function formatBytes(n: number): string {
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
    if (n >= 1024) return `${Math.round(n / 1024)}KB`;
    return `${n}B`;
}

/**
 * poll 要不要落行?(submit / reconcile 恒记,不走这里)
 *  - 到达终态(completed/failed 且库里此前不是)→ 记(首次完成行里带 usage 上游原文);
 *    queued→in_progress 不算 —— 库里不写 in_progress,每次轮询都会「迁移」,记了就是全量;
 *  - 上游报错 → 只记真打了上游那次(缓存 TTL 内的重放同一份错,记一次就够);
 *  - 我们自己拒的(401/403/404/400,没到上游)→ 记;
 *  - 200 且状态没变(例行轮询,含缓存命中)→ 不记(高峰 350 次/分钟,全记没意义)。
 */
export function shouldLogPoll(ctx: RequestLogCtx, httpStatus: number): boolean {
    if (process.env.ENTERPRISE_REQLOG_POLL_ALL === '1') return true;
    const terminalAfter = ctx.statusAfter === 'completed' || ctx.statusAfter === 'failed';
    if (terminalAfter && ctx.statusAfter !== (ctx.statusBefore ?? null)) return true;
    if (ctx.upstreamStatus != null && ctx.upstreamStatus >= 400) return !ctx.cacheHit;
    if (httpStatus >= 400) return true;
    return false;
}

export interface ReqlogFilters {
    from?: string | null;
    to?: string | null;
    user?: string | null; // user_id(uuid)
    region?: string | null;
    kind?: string | null;
    model?: string | null; // contains
    result?: string | null; // '' | ok | 4xx | 5xx | upstream_err
    q?: string | null; // task_id / client_request_id / vendor_task_id(contains)
}

const REGIONS = new Set(['cn', 'global', 'promax', 'volc']);
const KINDS = new Set(['submit', 'poll', 'reconcile', 'asset_action']);

/** 筛选参数 → prisma where(后台列表页与 CSV 导出共用,保证两边结果一致)。 */
export function buildReqlogWhere(f: ReqlogFilters): Record<string, unknown> {
    const from = parseDay(f.from ?? null);
    const to = parseDay(f.to ?? null, true);
    const where: Record<string, unknown> = {};
    if (from || to) where.created_at = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
    if (f.user && /^[0-9a-f-]{36}$/i.test(f.user)) where.user_id = f.user;
    if (f.region && REGIONS.has(f.region)) where.region = f.region;
    if (f.kind && KINDS.has(f.kind)) where.kind = f.kind;
    if (f.model) where.model = { contains: f.model.slice(0, 128) };
    switch (f.result) {
        case 'ok':
            where.http_status = { gte: 200, lt: 400 };
            break;
        case '4xx':
            where.http_status = { gte: 400, lt: 500 };
            break;
        case '5xx':
            where.http_status = { gte: 500 };
            break;
        case 'upstream_err':
            where.upstream_status = { gte: 400 };
            break;
    }
    if (f.q) {
        const q = f.q.trim().slice(0, 128);
        if (q) {
            where.OR = [
                { task_id: { contains: q } },
                { client_request_id: { contains: q } },
                { vendor_task_id: { contains: q } },
                { resource_id: { contains: q } },
            ];
        }
    }
    return where;
}

/**
 * 落一行。fire-and-forget:任何失败(含 prisma model 缺失等同步异常)只 warn,绝不抛。
 * res 传我们即将返给客户的响应 —— 4xx/5xx 时从 clone 里提取 error code/message
 * (客户看到什么,日志就存什么,支援时不用再猜)。
 */
export function writeRequestLog(ctx: RequestLogCtx, res?: { status: number; clone(): Response }): void {
    void (async () => {
        let errorCode: string | null = null;
        let errorMessage: string | null = null;
        const httpStatus = res?.status ?? null;
        try {
            if (res && res.status >= 400) {
                const j = (await res
                    .clone()
                    .json()
                    .catch(() => null)) as {
                    error?: { code?: unknown; message?: unknown };
                    // 素材库 Action 面的火山 envelope(fail() 形):{ResponseMetadata:{Error:{Code,Message}}}
                    ResponseMetadata?: { Error?: { Code?: unknown; Message?: unknown } };
                } | null;
                const err =
                    j?.error ??
                    (j?.ResponseMetadata?.Error && {
                        code: j.ResponseMetadata.Error.Code,
                        message: j.ResponseMetadata.Error.Message,
                    });
                if (err) {
                    errorCode = typeof err.code === 'string' ? err.code.slice(0, 64) : null;
                    errorMessage = typeof err.message === 'string' ? err.message.slice(0, MAX_ERROR_MESSAGE) : null;
                }
            }
            await prisma.enterpriseRequestLog.create({
                data: {
                    kind: ctx.kind,
                    format: ctx.format ?? null,
                    user_id: ctx.userId ?? null,
                    key_id: ctx.keyId ?? null,
                    region: ctx.region ?? null,
                    model: ctx.model?.slice(0, 128) ?? null,
                    task_id: ctx.taskId?.slice(0, 128) ?? null,
                    vendor_task_id: ctx.vendorTaskId?.slice(0, 128) ?? null,
                    client_request_id: ctx.clientRequestId?.slice(0, 128) ?? null,
                    action: ctx.action?.slice(0, 64) ?? null,
                    resource_id: ctx.resourceId?.slice(0, 128) ?? null,
                    http_status: httpStatus,
                    upstream_status: ctx.upstreamStatus ?? null,
                    cache_hit: ctx.cacheHit ?? false,
                    outcome:
                        ctx.outcome ??
                        (ctx.statusAfter && ctx.statusAfter !== (ctx.statusBefore ?? null) ? ctx.statusAfter : null),
                    error_code: errorCode,
                    error_message: errorMessage,
                    duration_ms: Math.max(0, Date.now() - ctx.startedAt),
                    upstream_ms: ctx.upstreamMs ?? null,
                    request_body: ctx.requestBody ?? null,
                    upstream_body: ctx.upstreamBody?.slice(0, MAX_BODY_BYTES) ?? null,
                    client_ip: ctx.clientIp ?? null,
                    user_agent: ctx.userAgent ?? null,
                },
            });
        } catch (e) {
            console.warn('[enterprise-reqlog] write failed', { kind: ctx.kind, task_id: ctx.taskId, err: String(e) });
        }
    })().catch((e) => console.warn('[enterprise-reqlog] write failed(outer)', String(e)));
}
