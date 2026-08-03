/**
 * Silk Road AI Portal — new-api Admin Client
 * ===========================================
 *
 * Replaces src/lib/litellm/client.ts (W1 路线产物).
 *
 * 架构关键点(基于对 QuantumNous/new-api source code 的精确分析):
 *
 * 1. 双头部认证:
 *    - Authorization: <access_token>     (29-32 字符,在 new-api admin UI 生成)
 *    - New-Api-User: <int_user_id>       (持有该 token 的 user 的整数 ID)
 *
 * 2. 配额单位:
 *    - 1 USD = 500,000 quota(默认 QuotaPerUnit,可配置)
 *    - portal 显示给客户:cny = (quota / 500_000) * cnyRate
 *
 * 3. ⚠️ 关键架构约束:
 *    - new-api 的 POST /api/token/ 只能创建"当前认证用户"的 token
 *    - 没有 admin 给别人创建 token 的接口
 *    - 解决方案:portal 给每个客户分配独立的 access_token(secret 存 DB)
 *      portal 调 token 接口时用 Authorization=<customer_access_token> + New-Api-User=<customer_id>
 *
 * 4. CreateUser / AddToken 不返回 ID:
 *    - 必须创建后立即调 search/list 反查
 *    - 建议加锁或 username/name 用 UUID 保唯一
 *
 * 5. 充值不是 /topup,是 POST /api/user/manage 的 add_quota action:
 *    - 配额单位是 raw quota int,记得转换
 *
 * 全部 endpoint 来源:`controller/user.go`、`controller/token.go`、`controller/log.go`
 * 数据模型来源:`model/user.go`、`model/token.go`、`model/log.go`
 */

import { z } from 'zod';

// ============================================
// Server-only module guard (hotfix 2026-05-05)
// ============================================
//
// `import 'server-only'` causes Next.js / Turbopack to FAIL the build at
// compile time if any 'use client' file imports from this module. This
// closes the W6 D4 regression where `keys-list.tsx` (a client component)
// pulled in `quotaToCny` from here, and the bundler dragged the entire
// module — including the module-top-level admin-env check below — into
// the browser bundle. At runtime `process.env.NEWAPI_ADMIN_TOKEN` is
// undefined in the browser, so the throw fires and the page crashes.
//
// Pure helpers (quotaToCny, cnyToQuota, etc.) live in
// `./quota-units.ts` (no server-only marker, safe for client bundles).
// We re-export them at the bottom for back-compat with existing
// server-side imports.
import 'server-only';

// ============================================
// 配置 + 常量
// ============================================

const NEWAPI_BASE_URL = process.env.NEWAPI_BASE_URL || 'http://localhost:3000';

// new-api 默认 1 USD = 500,000 quota — 这两个常量从 quota-units 重新导出,
// 保留所有现有 import 路径(`from '@/lib/newapi/client'`)继续工作。
export {
    QUOTA_PER_USD,
    USD_TO_CNY_RATE,
    REAL_USD_TO_CNY,
    quotaToUsd,
    quotaToRealUsd,
    quotaToCny,
    usdToQuota,
    cnyToQuota,
} from './quota-units';

// Local imports for internal callers within this module (re-export above
// doesn't make the names visible in this file's scope).
import { cnyToQuota as _cnyToQuota } from './quota-units';

/**
 * Lazy admin-env check. The previous `if (!TOKEN) throw` at module top
 * level meant any importer (including bundlers traversing for tree-shake
 * candidates) that loaded this module would evaluate the throw — which
 * is what broke prod /keys when a client component reached for a pure
 * helper. The lazy form runs only inside `call()` (and other functions
 * that need the admin token), keeping module-load side-effect-free.
 */
function requireAdminEnv(): { token: string; userId: string } {
    const token = process.env.NEWAPI_ADMIN_TOKEN;
    const userId = process.env.NEWAPI_ADMIN_USER_ID;
    if (!token || !userId) {
        throw new Error(
            'Missing required env: NEWAPI_ADMIN_TOKEN + NEWAPI_ADMIN_USER_ID. ' +
                'Generate them in new-api admin UI under Personal Settings → System Access Token.',
        );
    }
    return { token, userId };
}

// ============================================
// 错误 + HTTP 工具
// ============================================

export class NewApiError extends Error {
    constructor(
        public status: number,
        public endpoint: string,
        public payload: unknown,
        message: string,
    ) {
        super(`new-api ${endpoint} ${status}: ${message}`);
        this.name = 'NewApiError';
    }
}

export interface NewApiEnvelope<T> {
    success: boolean;
    message: string;
    data?: T;
}

/**
 * Session credential returned by POST /api/user/login.
 *
 * new-api ≤ rc.2 sets a gorilla `session=` cookie; rc.22+ dropped that
 * entirely and instead returns a short-lived (~15 min) JWT in the response
 * body (`data.access_token`), meant to be sent as `Authorization: Bearer`.
 * Provisioning uses whichever the server handed back.
 */
export type LoginSessionAuth = { kind: 'cookie'; cookie: string } | { kind: 'bearer'; jwt: string };

interface CallOptions {
    /** 用哪个 access_token + user_id 调用。默认用 admin。 */
    asUser?: { accessToken: string; userId: number };
    /**
     * Use a login-session credential (cookie or Bearer JWT, see
     * LoginSessionAuth) instead of a long-lived access_token. Used during
     * provisioning to fetch a freshly-created customer's access_token via
     * GET /api/user/token (which requires session auth, not admin scope).
     */
    session?: { auth: LoginSessionAuth; userId: number };
}

async function call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    queryParams?: Record<string, string | number | undefined>,
    options: CallOptions = {},
): Promise<T> {
    const url = new URL(path, NEWAPI_BASE_URL);
    if (queryParams) {
        for (const [k, v] of Object.entries(queryParams)) {
            if (v !== undefined) url.searchParams.set(k, String(v));
        }
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.session) {
        if (options.session.auth.kind === 'cookie') {
            headers['Cookie'] = options.session.auth.cookie;
        } else {
            headers['Authorization'] = `Bearer ${options.session.auth.jwt}`;
        }
        headers['New-Api-User'] = String(options.session.userId);
    } else {
        let auth = options.asUser;
        if (!auth) {
            // Fall back to admin auth — env validated lazily so a missing
            // env at module load no longer crashes the browser bundle.
            const env = requireAdminEnv();
            auth = { accessToken: env.token, userId: parseInt(env.userId, 10) };
        }
        headers['Authorization'] = auth.accessToken; // no Bearer prefix
        headers['New-Api-User'] = String(auth.userId); // required by all endpoints
    }

    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await fetch(url, init);
    const text = await res.text();
    let data: NewApiEnvelope<T> | null = null;
    try {
        data = text ? (JSON.parse(text) as NewApiEnvelope<T>) : null;
    } catch {
        /* */
    }

    if (!res.ok || (data && !data.success)) {
        const msg = data?.message ?? text ?? res.statusText;
        throw new NewApiError(res.status, `${method} ${path}`, data, String(msg));
    }
    return (data?.data ?? null) as T;
}

/**
 * Login as a customer with username + password.
 *
 * Returns a session credential (legacy `session=` cookie on ≤ rc.2, Bearer
 * JWT from the response body on rc.22+) and the logged-in user payload.
 *
 * Used during provisioning: after admin creates the customer, portal logs
 * in as them so it can call GET /api/user/token (which requires session
 * auth, not admin scope) to obtain the customer's access_token. Admin
 * cannot set someone else's access_token — PUT /api/user/ silently
 * ignores the field — so we must go through login.
 */
const LoginUserSchema = z.object({
    id: z.number().int(),
    username: z.string(),
    role: z.number().int(),
});

// rc.22+ login payload: user nested, short-lived session JWT alongside.
const LoginJwtPayloadSchema = z.object({
    access_token: z.string().min(1),
    user: LoginUserSchema,
});

async function loginAsUser(args: { username: string; password: string }): Promise<{
    auth: LoginSessionAuth;
    user: { id: number; username: string; role: number };
}> {
    const url = new URL('/api/user/login', NEWAPI_BASE_URL);
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: args.username, password: args.password }),
    });
    const text = await res.text();
    let data: NewApiEnvelope<unknown> | null = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        /* */
    }

    if (!res.ok || (data && !data.success)) {
        const msg = data?.message ?? text ?? res.statusText;
        throw new NewApiError(res.status, 'POST /api/user/login', data, String(msg));
    }

    const jwtPayload = LoginJwtPayloadSchema.safeParse(data?.data);
    if (jwtPayload.success) {
        return {
            auth: { kind: 'bearer', jwt: jwtPayload.data.access_token },
            user: jwtPayload.data.user,
        };
    }

    const setCookie = res.headers.get('set-cookie') ?? '';
    const sessionMatch = setCookie.match(/(session=[^;]+)/);
    const legacyUser = LoginUserSchema.safeParse(data?.data);
    if (sessionMatch && legacyUser.success) {
        return {
            auth: { kind: 'cookie', cookie: sessionMatch[1] },
            user: legacyUser.data,
        };
    }

    throw new NewApiError(
        res.status,
        'POST /api/user/login',
        data,
        'Login OK but no session credential returned (neither rc.22 body JWT nor legacy session cookie)',
    );
}

// ============================================
// 类型(基于 new-api source code 实际 schema)
// ============================================

export const NewApiUserSchema = z.object({
    id: z.number().int(),
    username: z.string(),
    display_name: z.string(),
    role: z.union([z.literal(1), z.literal(10), z.literal(100)]), // common | admin | root
    status: z.union([z.literal(1), z.literal(2)]), // enabled | disabled
    email: z.string(),
    group: z.string(),
    quota: z.number().int(),
    used_quota: z.number().int(),
    request_count: z.number().int(),
    aff_code: z.string(),
    inviter_id: z.number().int(),
    access_token: z.string().nullable(),
    created_at: z.number(),
});
export type NewApiUser = z.infer<typeof NewApiUserSchema>;

export const NewApiTokenSchema = z.object({
    id: z.number().int(),
    user_id: z.number().int(),
    key: z.string(), // sk-... ; 通常被 mask
    status: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    name: z.string(),
    created_time: z.number(),
    accessed_time: z.number(),
    expired_time: z.number(), // -1 = 永不过期
    remain_quota: z.number().int(),
    unlimited_quota: z.boolean(),
    model_limits_enabled: z.boolean(),
    model_limits: z.string(), // CSV
    used_quota: z.number().int(),
    group: z.string(),
});
export type NewApiToken = z.infer<typeof NewApiTokenSchema>;

export interface NewApiUsageLog {
    id: number;
    user_id: number;
    created_at: number; // unix seconds
    type: 0 | 1 | 2 | 3 | 4 | 5 | 6; // unknown|topup|consume|manage|system|error|refund
    content: string;
    username: string;
    token_name: string;
    model_name: string;
    quota: number;
    prompt_tokens: number;
    completion_tokens: number;
    use_time: number; // ms
    is_stream: boolean;
    channel: number;
    token_id: number;
    group: string;
    /** 计费元信息 JSON 串(model_price / model_ratio / completion_ratio / group_ratio 等)。
     *  展示层用 `model_price` 区分「按张(≥0)」vs「按 token(-1)」计费 —— 见 log-display
     *  `isPerImageBilled`。rows 未经 zod 校验,老行可能缺此字段(空串)。 */
    other: string;
    /** new-api 为每条请求生成的唯一 ID(前 14 位是 UTC 时间戳)。客户排障 /
     *  跟我们对账时的定位句柄 —— HTTP `GET /api/log/` 已直接返回此字段
     *  (rows 未经 zod 校验,历史极老行可能是空串)。 */
    request_id: string;
}

// ============================================
// 工具函数:配额单位转换
// ============================================
//
// Pure helpers (quotaToUsd / quotaToCny / usdToQuota / cnyToQuota +
// QUOTA_PER_USD / USD_TO_CNY_RATE constants) live in `./quota-units.ts`
// — see the re-export block at the top of this file. The split avoids
// dragging this server-only module into client bundles when a 'use
// client' component needs only the conversion math.

// ============================================
// A. User 管理(admin scope)
// ============================================

/**
 * 创建 new-api user(admin scope)
 *
 * ⚠️ 这个 API 不返回新建 user 的 ID!必须立即调 searchUser 反查。
 * 推荐:portal 用 portal_user_id 的前 8 字符作为 username 后缀,确保唯一好查
 */
export async function createUser(args: {
    username: string; // 必须唯一,max 20 字符
    password: string; // 8-20 字符
    display_name?: string; // max 20
    email?: string; // max 50
}): Promise<void> {
    await call<null>('POST', '/api/user/', {
        username: args.username,
        password: args.password,
        display_name: args.display_name ?? args.username,
        email: args.email ?? '',
        role: 1, // 1 = common user
    });
}

/** 查 user(by id) */
export async function getUser(id: number): Promise<NewApiUser> {
    return await call<NewApiUser>('GET', `/api/user/${id}`);
}

/** 搜 user(by 用户名/邮箱关键词) */
export async function searchUser(
    keyword: string,
    page = 1,
    pageSize = 20,
): Promise<{
    items: NewApiUser[];
    total: number;
}> {
    return await call('GET', '/api/user/search', undefined, { keyword, p: page, page_size: pageSize });
}

/**
 * 更新 user。new-api 的 PUT 接受部分字段,但有些字段它会静默忽略——
 * 实测 access_token 是其中之一(2026-05 W2 D6 验证;new-api v1.0.0-rc.2)。
 * 要 (re)generate 客户的 access_token,得让那个客户自己 GET /api/user/token
 * (走 login session 凭据:≤rc.2 cookie / rc.22+ Bearer JWT),不能 admin 改。
 *
 * 别用这个改 username — 内部似乎走 INSERT-or-UPDATE,空字段会和已有
 * username='' 行冲突触发 unique violation。fetch + merge 后 PUT 才稳。
 */
export async function updateUser(user: Partial<NewApiUser> & { id: number }): Promise<void> {
    await call<null>('PUT', '/api/user/', user);
}

/** 删 user(soft delete) */
export async function deleteUser(id: number): Promise<void> {
    await call<null>('DELETE', `/api/user/${id}`);
}

/**
 * 给 user 加额度(THIS IS PORTAL TOPUP CALL)
 *
 * @param userId  new-api user 的 int ID
 * @param quotaDelta  raw quota 单位的增量(用 cnyToQuota / usdToQuota 转换)
 * @param mode  'add' = 增加(默认),'subtract' = 减少,'override' = 覆盖
 */
export async function addQuota(args: {
    userId: number;
    quotaDelta: number; // raw quota
    mode?: 'add' | 'subtract' | 'override';
}): Promise<void> {
    await call<null>('POST', '/api/user/manage', {
        id: args.userId,
        action: 'add_quota',
        mode: args.mode ?? 'add',
        value: args.quotaDelta,
    });
}

// ============================================
// B. Token 管理(必须 act as customer)
// ============================================

/**
 * 给指定 customer 创建一个 token
 *
 * ⚠️ 必须用该 customer 的 access_token 调用(因为 new-api 是 per-user 限制)
 *
 * @param customerAuth 该 customer 的 { accessToken, userId } — 由 portal 维护
 * @param args  token 配置
 *
 * @returns void(同样不返回 ID,要立即 listTokensForCustomer 反查)
 */
export async function createTokenForCustomer(
    customerAuth: { accessToken: string; userId: number },
    args: {
        name: string; // token 别名,max 50
        unlimited_quota?: boolean; // 默认 false
        remain_quota?: number; // 默认按 user 总 quota,unlimited 时忽略
        expired_time?: number; // unix seconds, -1 = 永不过期(默认)
        model_limits_enabled?: boolean;
        model_limits?: string; // CSV "gpt-4,deepseek-v4-flash"
        allow_ips?: string | null; // newline-separated
        group?: string; // 所属分组(决定计费倍率)
    },
): Promise<void> {
    await call<null>(
        'POST',
        '/api/token/',
        {
            name: args.name,
            unlimited_quota: args.unlimited_quota ?? false,
            remain_quota: args.remain_quota ?? 0,
            expired_time: args.expired_time ?? -1,
            model_limits_enabled: args.model_limits_enabled ?? false,
            model_limits: args.model_limits ?? '',
            allow_ips: args.allow_ips ?? null,
            group: args.group ?? 'default',
        },
        undefined,
        { asUser: customerAuth },
    );
}

/** 列出某 customer 的全部 tokens */
export async function listTokensForCustomer(
    customerAuth: { accessToken: string; userId: number },
    page = 1,
    pageSize = 20,
): Promise<{ items: NewApiToken[]; total: number }> {
    return await call('GET', '/api/token/', undefined, { p: page, page_size: pageSize }, { asUser: customerAuth });
}

/** 拿 token 的真实 key(masked 之外)
 *
 * Response shape: `{data: {key: "sk-..."}}` — the inner `.key` is the real
 * sk-... value. Bootstrap client typed this as `Promise<string>` directly;
 * empirically it's a `{ key: string }` object on new-api v1.0.0-rc.2.
 */
export async function getTokenKey(
    customerAuth: { accessToken: string; userId: number },
    tokenId: number,
): Promise<string> {
    const result = await call<{ key: string }>('POST', `/api/token/${tokenId}/key`, undefined, undefined, {
        asUser: customerAuth,
    });
    return result.key;
}

/** 删 token */
export async function deleteToken(
    customerAuth: { accessToken: string; userId: number },
    tokenId: number,
): Promise<void> {
    await call<null>('DELETE', `/api/token/${tokenId}`, undefined, undefined, { asUser: customerAuth });
}

// ============================================
// C. Logs / 用量
// ============================================

/**
 * 查询用量日志
 *
 * ⚠️ Filter preference:**use `user_id` (int) — `username` filter has been
 * empirically observed returning 0 results even when matching logs exist
 * (W3 D2 F2 finding). Both params are forwarded to new-api so callers can
 * still pick username explicitly, but portal default is user_id.
 *
 * @param user_id    new-api int user id(preferred filter)
 * @param username   string username(legacy / debug — likely buggy upstream)
 */
export async function queryLogs(args: {
    user_id?: number;
    username?: string;
    type?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
    start_timestamp?: number;
    end_timestamp?: number;
    model_name?: string;
    token_name?: string;
    /** W6 D4: forwarded as `token_id` query param so new-api can filter
     *  upstream when supported. Callers MUST also post-filter by
     *  `log.token_id === token_id` because (a) older new-api builds
     *  silently ignore unknown query params, (b) `token_name` is not
     *  unique across renamed tokens. */
    token_id?: number;
    /** /api/log/ 实测支持精确 `request_id` / `channel` 过滤(命中单条 / 单渠道),转发给 new-api。 */
    request_id?: string;
    channel?: number;
    page?: number;
    page_size?: number;
}): Promise<{ items: NewApiUsageLog[]; total: number }> {
    return await call('GET', '/api/log/', undefined, {
        p: args.page ?? 1,
        page_size: args.page_size ?? 50,
        user_id: args.user_id,
        username: args.username,
        type: args.type,
        start_timestamp: args.start_timestamp,
        end_timestamp: args.end_timestamp,
        model_name: args.model_name,
        token_name: args.token_name,
        token_id: args.token_id,
        request_id: args.request_id,
        channel: args.channel,
    });
}

/**
 * 拉某客户在时间窗内的退款(type=6)明细。
 *
 * 背景:Seedance 等视频任务失败/未出片时,new-api 退还已扣 quota(加回 user.quota
 * 余额),但 user.used_quota 字段【不减退款】—— 仍是毛消费。净消费 = 毛 − Σ退款,
 * 故历史/本期消费展示都要扣掉退款,否则虚高(2026-06 客户 zyt1735867 反馈)。
 *
 * 过滤:username 是 admin 下真正生效的维度(gotcha #15;/api/log/ 忽略 user_id),
 * 但仍按 user_id 二次过滤防御(万一 username 不唯一/被忽略,不泄漏他人退款)。
 * /api/log/ page_size 硬钳 100(gotcha),故分页累加;退款条数远少于消费,通常 1-2 页,
 * MAX_PAGES 兜底防极端不卡死。
 */
export async function fetchUserRefunds(args: {
    user_id: number;
    username: string;
    start_timestamp?: number;
    end_timestamp?: number;
}): Promise<NewApiUsageLog[]> {
    const PAGE_SIZE = 100;
    const MAX_PAGES = 20;
    const out: NewApiUsageLog[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
        const { items } = await queryLogs({
            user_id: args.user_id,
            username: args.username,
            type: 6,
            page,
            page_size: PAGE_SIZE,
            start_timestamp: args.start_timestamp,
            end_timestamp: args.end_timestamp,
        });
        for (const it of items) {
            if (it.user_id === args.user_id) out.push(it);
        }
        if (items.length < PAGE_SIZE) return out;
    }
    console.warn(`[fetchUserRefunds] user ${args.user_id} 退款超过 ${MAX_PAGES * PAGE_SIZE} 条,统计可能偏低`);
    return out;
}

/** 聚合统计 */
export async function getLogStats(args: {
    username?: string;
    start_timestamp?: number;
    end_timestamp?: number;
    model_name?: string;
}): Promise<{ quota: number; rpm: number; tpm: number }> {
    return await call('GET', '/api/log/stat', undefined, {
        type: 2, // consume only
        username: args.username,
        start_timestamp: args.start_timestamp,
        end_timestamp: args.end_timestamp,
        model_name: args.model_name,
    });
}

/**
 * new-api 数据看板行 —— `/api/data/` 返回的【按 (天 × 模型) 预聚合】桶。
 * 这是 new-api 自己看板用的端点:服务端已聚合,**不分页、不受 `/api/log/`
 * 的 page_size≤100 上限影响**,一次请求拿全周期。
 *
 * - `created_at`: 该桶的日期(unix 秒,日粒度)
 * - `count`:     该桶请求次数
 * - `quota`:     该桶消费 quota
 * - `token_used`:该桶 token 合计(prompt+completion 合并计)
 */
export interface NewApiDataPoint {
    user_id: number;
    username: string;
    model_name: string;
    created_at: number;
    count: number;
    quota: number;
    token_used: number;
}

/**
 * 拉某客户(或全局)在时间窗内的【按天×模型】用量聚合。
 *
 * 为什么不用 `queryLogs` 累加:new-api 把 `/api/log/` 的 page_size 硬钳在 100
 * (实测请求 1000 仍只回 100),用它做总量统计会被截断成「永远 ≤100」。
 * `/api/data/` 是服务端预聚合,count/quota/token_used 都是精确总量。
 *
 * 过滤维度沿用 gotcha #15:传 `username`(admin 认证下真正生效的维度);
 * 调用方仍可按 `user_id` 做防御性二次过滤。
 */
export async function getUsageDashboard(args: {
    username?: string;
    start_timestamp?: number;
    end_timestamp?: number;
}): Promise<NewApiDataPoint[]> {
    const data = await call<NewApiDataPoint[] | null>('GET', '/api/data/', undefined, {
        username: args.username,
        start_timestamp: args.start_timestamp,
        end_timestamp: args.end_timestamp,
    });
    return Array.isArray(data) ? data : [];
}

// ============================================
// D. 模型列表
// ============================================

/** 列出所有可用模型(给 portal 前端展示) */
export async function listAvailableModels(): Promise<string[]> {
    return await call<string[]>('GET', '/api/channel/models_enabled');
}

/**
 * new-api 渠道对象 —— 字段多且动态(model_ratio / completion_ratio / models /
 * model_mapping / setting / other …)。我们只读/改 model_ratio + completion_ratio,
 * 但 PUT 时【必须回传整个对象】(gotcha #15:不带 models/model_mapping 会被静默
 * 清掉)。故类型放宽为 Record<string, unknown> + 我们关心的两个字段。
 */
export type NewApiChannel = Record<string, unknown> & {
    id: number;
    model_ratio?: string | Record<string, number> | null;
    completion_ratio?: string | Record<string, number> | null;
};

/** GET 单个渠道完整对象(P2 定价 sync 用)。 */
export async function getChannel(id: number): Promise<NewApiChannel> {
    return await call<NewApiChannel>('GET', `/api/channel/${id}`);
}

/**
 * 列出所有渠道(P2.5 导入预览的「渠道菜单」用,让 operator 看到/挑选要导哪几个)。
 *
 * new-api list 端点的 envelope `data` 形态在不同版本间不一致(可能是裸数组,也
 * 可能是 `{ items, total }`),这里两种都兜住。page_size 拉大(100)一次取够 ——
 * 旗舰部署渠道数 ~20,远小于此;真正的导入仍按 id 逐个 getChannel(权威全量对象),
 * 故菜单不全也不影响导入正确性(仅影响发现体验)。
 */
export async function listChannels(): Promise<NewApiChannel[]> {
    const res = await call<NewApiChannel[] | { items?: NewApiChannel[] } | null>('GET', '/api/channel/', undefined, {
        p: 1,
        page_size: 100,
    });
    if (Array.isArray(res)) return res;
    return res?.items ?? [];
}

/**
 * PUT 整个渠道对象回 new-api。调用方负责传【完整】对象(在 getChannel 结果上
 * merge 改动后整体回传),否则未带的字段会被清空(gotcha #15)。
 */
export async function updateChannel(channel: NewApiChannel): Promise<void> {
    await call<unknown>('PUT', '/api/channel/', channel);
}

// ============================================
// D′. 全局 Option(System Settings)
// ============================================
//
// new-api `GET /api/option/` 返回【全部】系统设置,envelope.data 形态在不同版本间
// 不一致(可能是 `[{key, value}, …]` 数组,也可能是 `{key: value}` 对象),两种都兜住。
// 图片模型计费走全局 `ModelPrice`(option key,JSON 字符串 dict `{model: usd_per_image}`,
// 全局按模型名、不分渠道 —— P2.8 Part B 实测确认)。
//
// ⚠️ 这是只读的安全 GET(可重复调,不像 GET /api/user/token 会 rotate,见 gotcha #13)。

/** 读单个全局 option 的原始 value 字符串;不存在返回 null。 */
export async function getOption(key: string): Promise<string | null> {
    const data = await call<Array<{ key: string; value: unknown }> | Record<string, unknown> | null>(
        'GET',
        '/api/option/',
    );
    if (Array.isArray(data)) {
        const found = data.find((i) => i && i.key === key);
        return found && found.value != null ? String(found.value) : null;
    }
    if (data && typeof data === 'object') {
        const v = (data as Record<string, unknown>)[key];
        return v == null ? null : String(v);
    }
    return null;
}

/**
 * 写单个全局 option(new-api `PUT /api/option/` body `{key, value}` —— 只更新这一个
 * key,不影响其它 option)。value 必须是字符串(JSON dict 需调用方先 stringify)。
 */
export async function putOption(key: string, value: string): Promise<void> {
    await call<unknown>('PUT', '/api/option/', { key, value });
}

// ============================================
// E. Portal 业务高层封装
// ============================================

import { randomBytes } from 'crypto';

// access_tokens are issued by new-api itself via GET /api/user/token after
// session login — portal does not generate them. (W2 D6 finding: PUT
// /api/user/ silently ignores any access_token field passed by admin.)

/** 生成随机密码(8-20 字符,符合 new-api validator) */
function generateUserPassword(): string {
    return randomBytes(8).toString('hex').slice(0, 16); // 16 字符
}

export interface ProvisionedCustomer {
    newapi_user_id: number;
    newapi_username: string;
    newapi_access_token: string; // portal 内部 secret
    newapi_token_id: number;
    newapi_token_value: string; // sk-xxx 给客户
}

/**
 * 高层封装:开通新客户
 *
 * 流程(empirically verified against new-api v1.0.0-rc.2):
 *   1. POST /api/user/             admin 创建 new-api user
 *   2. POST /api/user/login        portal 用刚生成的密码登录该 user,拿 session 凭据
 *                                  (≤rc.2: session cookie;rc.22+: 响应体短效 Bearer JWT)
 *                                  (顺便从响应里拿到 user.id,省掉一次 search)
 *   3. GET  /api/user/token        以 session 身份拿(并 rotate)access_token
 *                                  ⚠️ 这个端点 admin 调不动:必须用该用户自己的 session
 *                                     PUT /api/user/ 里的 access_token 字段是被静默忽略的
 *   4. POST /api/token/            以 customer 的 access_token 身份创建第一个 token
 *   5. GET  /api/token/            反查 token.id(create 不返回 ID)
 *   6. POST /api/token/{id}/key    拿真实 key(sk-xxx)
 *
 * @param portal_user_id portal 自己 User 表的 UUID(作为 username 后缀确保唯一)
 * @param email  客户邮箱
 */
export async function provisionNewCustomer(args: {
    portal_user_id: string;
    email: string;
    initial_quota?: number; // 默认 0
}): Promise<ProvisionedCustomer> {
    const username = `c-${args.portal_user_id.slice(0, 8)}`; // c-25a69821
    const password = generateUserPassword();

    // Step 1: admin creates user.
    // display_name has a 20-char limit on new-api side; emails routinely exceed
    // that, so we use the (already <20) username as the display name and keep
    // the full email in the email field (which has a 50-char limit).
    await createUser({ username, password, display_name: username, email: args.email });

    // Step 2: log in as the customer to obtain a session credential
    // (cookie ≤ rc.2, Bearer JWT on rc.22+) + their user.id.
    const session = await loginAsUser({ username, password });
    const userId = session.user.id;

    // Step 3: ask new-api to (re)generate this user's access_token. Returns
    // the new token; the previous value (if any) is invalidated server-side.
    const accessToken = await call<string>('GET', '/api/user/token', undefined, undefined, {
        session: { auth: session.auth, userId },
    });

    // Step 4: create the first token. Must act-as the customer.
    //
    // unlimited_quota=true is deliberate: the BUDGET gate is `user.quota`
    // (raised via /api/user/manage add_quota when portal sees a successful
    // top-up). Per-token remain_quota=0 with unlimited_quota=false makes
    // new-api reject all calls with "Invalid token", which is unhelpful for
    // a user who just topped up their account. Per-token caps are a
    // future feature when customers want sub-budgets.
    const customerAuth = { accessToken, userId };
    const tokenName = `default-${args.portal_user_id.slice(0, 8)}`;
    await createTokenForCustomer(customerAuth, {
        name: tokenName,
        unlimited_quota: true,
        remain_quota: args.initial_quota ?? 0,
        expired_time: -1,
    });

    // Step 5: look up token.id (create doesn't return it).
    const tokens = await listTokensForCustomer(customerAuth, 1, 10);
    const token = tokens.items.find((t) => t.name === tokenName);
    if (!token) {
        throw new Error(`Failed to find newly created token ${tokenName} after createTokenForCustomer.`);
    }

    // Step 6: fetch the real sk-xxx (the list endpoint masks it).
    const realKey = await getTokenKey(customerAuth, token.id);

    return {
        newapi_user_id: userId,
        newapi_username: username,
        newapi_access_token: accessToken,
        newapi_token_id: token.id,
        newapi_token_value: realKey,
    };
}

/**
 * 充值入账(portal 收到易支付通知后调用)
 *
 * @param newapi_user_id  new-api user 的 int ID
 * @param cnyAmount       充值人民币金额
 *
 * 注意:这是 ADD(增量),不是 SET。
 * 配额单位换算:1 USD = QUOTA_PER_USD(默认 500_000)quota,1 USD = USD_TO_CNY_RATE 元
 */
export async function applyTopup(args: {
    newapi_user_id: number;
    cnyAmount: number;
    /**
     * W6 D1: 额外的 bonus quota(raw,不经汇率换算)。
     * 主 quota = cnyToQuota(cnyAmount),total = main + extraBonusQuota,
     * 一次 addQuota(add) 调用一并入账。首充 20% 福利就走这个参数;
     * 非首充时 caller 不传(默认 0,行为与改动前一致)。
     */
    extraBonusQuota?: number;
}): Promise<void> {
    const mainQuota = _cnyToQuota(args.cnyAmount);
    const bonus = args.extraBonusQuota ?? 0;
    await addQuota({
        userId: args.newapi_user_id,
        quotaDelta: mainQuota + bonus,
        mode: 'add',
    });
}

/** 健康检查 */
export async function checkNewApiHealth(): Promise<boolean> {
    try {
        await call<unknown>('GET', '/api/status');
        return true;
    } catch {
        return false;
    }
}
