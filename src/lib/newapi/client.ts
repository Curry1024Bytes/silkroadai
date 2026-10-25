/**
 * LLmRoute Portal — new-api Admin Client
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
import { customerKeyMutationTimeout } from './customer-key-mutation';

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

/** 管理面 `call()` 的单次请求超时(env `NEWAPI_CALL_TIMEOUT_MS` 可调)。
 *  30s 远高于正常值(实测 /api/user 4ms、/api/token 8ms、最慢的 /api/log/
 *  在 3600 万行 logs 表上约 2s),只用来兜住上游卡死,不误杀慢查询。
 *  ⚠️ 只作用于这个管理面 helper;客户 /v1 代理走 route.ts 自己的 fetch,
 *  有独立的 600s 超时(instrumentation.ts 的 undici Agent),不受影响。 */
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

function callTimeoutMs(): number {
    const raw = process.env.NEWAPI_CALL_TIMEOUT_MS;
    if (raw == null || raw === '') return DEFAULT_CALL_TIMEOUT_MS;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_CALL_TIMEOUT_MS;
    return Math.floor(n);
}

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

/** Short-lived login credential, used only to issue persistent customer access. */
export type LoginSessionAuth = { kind: 'cookie'; cookie: string } | { kind: 'bearer'; jwt: string };

interface CallOptions {
    /** Bounded management operations such as serialized price publications. */
    timeoutMs?: number;
    /** Price write acknowledgement requires an explicit application envelope. */
    requireSuccess?: boolean;
    /** Internal readers that need non-data response metadata, such as group_ratio. */
    returnEnvelope?: boolean;
    /** Public runtime pricing must not inherit an administrator's group override. */
    anonymous?: boolean;
    /** Strict management reads must never reuse caches or follow redirects. */
    cache?: RequestCache;
    redirect?: RequestRedirect;
    /** 用哪个 access_token + user_id 调用。默认用 admin。 */
    asUser?: { accessToken: string; userId: number };
    /**
     * Use a legacy login-session cookie instead of a long-lived access token.
     * Older new-api releases require it for GET /api/user/token during
     * provisioning.
     */
    session?: { auth: LoginSessionAuth; userId: number };
    /** Single-use proof, scoped to this one authenticated operation. */
    securityProof?: string;
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
    if (options.anonymous) {
        if (options.session || options.asUser) throw new Error('Conflicting new-api authentication options');
    } else if (options.session) {
        if (options.session.auth.kind === 'cookie') headers['Cookie'] = options.session.auth.cookie;
        else headers['Authorization'] = `Bearer ${options.session.auth.jwt}`;
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
    if (options.securityProof) headers['X-Security-Proof'] = options.securityProof;

    const guardTimeoutMs = await customerKeyMutationTimeout();
    const timeoutMs = Math.min(options.timeoutMs ?? callTimeoutMs(), guardTimeoutMs ?? Infinity);
    const init: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        ...(options.cache ? { cache: options.cache } : {}),
        // Unknown API routes may redirect to HTML. Never follow credentials to that page.
        redirect: options.redirect ?? 'manual',
        ...(options.anonymous ? { credentials: 'omit' as const } : {}),
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    let res: Response;
    try {
        res = await fetch(url, init);
    } catch (e) {
        // 超时在这里现形。此前 call() 无 timeout —— new-api 一慢,SSR 的
        // server component 就无限期挂住(Promise.allSettled 也等不出结果,
        // 它只等 settle 不设 deadline),客户看到的是页面一直转圈。
        // 归一成 NewApiError 504,让既有的 try/catch + 降级分支能接住。
        if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
            throw new NewApiError(504, `${method} ${path}`, null, `new-api timeout after ${timeoutMs}ms`);
        }
        throw e;
    }
    const text = await res.text();
    let data: NewApiEnvelope<T> | null = null;
    try {
        data = text ? (JSON.parse(text) as NewApiEnvelope<T>) : null;
    } catch {
        /* */
    }

    if (!res.ok || (data && !data.success)) {
        const sensitive = !!body && typeof body === 'object' && 'password' in body;
        const msg = sensitive ? 'Credential operation failed' : (data?.message ?? text ?? res.statusText);
        throw new NewApiError(res.status, `${method} ${path}`, sensitive ? null : data, String(msg));
    }
    if (options.requireSuccess && data?.success !== true) {
        throw new NewApiError(502, `${method} ${path}`, null, 'Unconfirmed management response');
    }
    return (options.returnEnvelope ? data : (data?.data ?? null)) as T;
}

interface NewApiLoginUser {
    id: number;
    username: string;
    role: number;
}

export interface NewApiLoginResult {
    user: NewApiLoginUser;
    accessToken: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function parseNewApiLoginUser(value: unknown): NewApiLoginUser | null {
    if (!isRecord(value)) return null;
    if (typeof value.id !== 'number' || typeof value.username !== 'string' || typeof value.role !== 'number') {
        return null;
    }
    return { id: value.id, username: value.username, role: value.role };
}

/**
 * Normalize old and current new-api login payloads.
 *
 * Older releases put the user fields directly in `data` and required a
 * `session` cookie for the next call. Current releases put the user under
 * `data.user` and return a short-lived session JWT in `data.access_token`;
 * exchange it through GET /api/user/token before persisting. Their
 * `new_api_refresh` cookie is not a legacy session cookie.
 */
export function parseNewApiLoginResult(data: unknown): NewApiLoginResult | null {
    if (!isRecord(data)) return null;
    const user = parseNewApiLoginUser(data.user) ?? parseNewApiLoginUser(data);
    if (!user) return null;
    const accessToken = typeof data.access_token === 'string' && data.access_token ? data.access_token : null;
    return { user, accessToken };
}

/** Extract the legacy customer session cookie from new-api's login response. */
export function extractNewApiSessionCookie(setCookie: string): string | null {
    return setCookie.match(/(session=[^;]+)/)?.[1] ?? null;
}

/** Login as a customer and normalize current plus legacy response shapes. */
async function loginAsUser(args: { username: string; password: string }): Promise<{
    auth: LoginSessionAuth;
    cookie: string | null;
    user: NewApiLoginUser;
    accessToken: string | null;
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
        throw new NewApiError(res.status, 'POST /api/user/login', null, 'Customer login failed');
    }

    const login = parseNewApiLoginResult(data?.data);
    const sessionCookie = extractNewApiSessionCookie(res.headers.get('set-cookie') ?? '');
    if (!login || (!login.accessToken && !sessionCookie)) {
        throw new NewApiError(
            res.status,
            'POST /api/user/login',
            data,
            'Login OK but no access token or legacy session cookie returned',
        );
    }
    return {
        auth: login.accessToken
            ? { kind: 'bearer', jwt: login.accessToken }
            : { kind: 'cookie', cookie: sessionCookie! },
        cookie: sessionCookie,
        user: login.user,
        accessToken: login.accessToken,
    };
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
    // These fields are writable through PUT /api/token/. Keep them in the
    // customer-facing model so an administrative group migration preserves
    // every other token setting.
    allow_ips: z.string().nullable().optional(),
    cross_group_retry: z.boolean().optional().default(false),
    auto_groups: z.array(z.string()).nullable().optional().default(null),
});
export type NewApiToken = z.infer<typeof NewApiTokenSchema>;

/** No key, name, IP restrictions or quota data may enter retirement evidence. */
const TokenRevocationMetadataSchema = z.object({
    id: z.number().int().positive().safe(),
    user_id: z.number().int().positive().safe(),
    group: z.string(),
    status: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
});
export type TokenRevocationMetadata = z.infer<typeof TokenRevocationMetadataSchema>;

const TOKEN_REVOCATION_CALL_OPTIONS = {
    requireSuccess: true,
    timeoutMs: 10_000,
    cache: 'no-store',
    redirect: 'error',
} as const;

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
export async function updateUser(user: Partial<NewApiUser> & { id: number }, timeoutMs?: number): Promise<void> {
    await call<null>('PUT', '/api/user/', user, undefined, { timeoutMs });
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
        group: string; // 所属分组(决定计费倍率);必须由 ChannelGroup 显式解析
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
            group: args.group,
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

/** Read one customer token, including its current billing group, for post-write verification. */
export async function getTokenForCustomer(
    customerAuth: { accessToken: string; userId: number },
    tokenId: number,
    timeoutMs?: number,
): Promise<NewApiToken> {
    return await call('GET', `/api/token/${tokenId}`, undefined, undefined, {
        asUser: customerAuth,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
}

/** Strict, uncached owner identity read; never rotates the customer's access token. */
export async function getTokenRevocationCustomerIdentity(customerAuth: {
    accessToken: string;
    userId: number;
}): Promise<{ id: number; status: 1 | 2 }> {
    const data = await call<unknown>('GET', '/api/user/self', undefined, undefined, {
        ...TOKEN_REVOCATION_CALL_OPTIONS,
        asUser: customerAuth,
    });
    const parsed = z
        .object({ id: z.number().int().positive().safe(), status: z.union([z.literal(1), z.literal(2)]) })
        .safeParse(data);
    if (!parsed.success) {
        throw new NewApiError(502, 'GET /api/user/self', null, 'Unconfirmed customer identity');
    }
    return parsed.data;
}

/** rc.23 returns { success:true, data:token }; metadata is parsed and secrets discarded. */
export async function getTokenRevocationMetadataForCustomer(
    customerAuth: { accessToken: string; userId: number },
    tokenId: number,
): Promise<TokenRevocationMetadata> {
    const data = await call<unknown>('GET', `/api/token/${tokenId}`, undefined, undefined, {
        ...TOKEN_REVOCATION_CALL_OPTIONS,
        asUser: customerAuth,
    });
    const parsed = TokenRevocationMetadataSchema.safeParse(data);
    if (!parsed.success) {
        throw new NewApiError(502, `GET /api/token/${tokenId}`, null, 'Unconfirmed token metadata');
    }
    return parsed.data;
}

/** An HTTP 200/204/HTML response alone is not a deletion acknowledgement. */
export async function deleteTokenForCustomerStrict(
    customerAuth: { accessToken: string; userId: number },
    tokenId: number,
): Promise<void> {
    await call<null>('DELETE', `/api/token/${tokenId}`, undefined, undefined, {
        ...TOKEN_REVOCATION_CALL_OPTIONS,
        asUser: customerAuth,
    });
}

/**
 * Update a customer token while preserving its existing editable settings.
 *
 * new-api's PUT endpoint is `/api/token/` (not `/api/token/:id`) and replaces
 * all editable token fields. Deliberately omit `key`: new-api loads the
 * existing token first, so this changes settings without rotating the API key.
 */
async function updateCompleteTokenForCustomer(
    customerAuth: { accessToken: string; userId: number },
    token: NewApiToken,
    timeoutMs?: number,
): Promise<void> {
    await call<null>(
        'PUT',
        '/api/token/',
        {
            id: token.id,
            status: token.status,
            name: token.name,
            expired_time: token.expired_time,
            remain_quota: token.remain_quota,
            unlimited_quota: token.unlimited_quota,
            model_limits_enabled: token.model_limits_enabled,
            model_limits: token.model_limits,
            allow_ips: token.allow_ips ?? null,
            group: token.group,
            // Target groups used by Portal are concrete groups, not `auto`.
            // Explicitly retain this field for completeness; new-api itself
            // clears it when the selected group is non-auto.
            cross_group_retry: token.cross_group_retry,
            auto_groups: token.auto_groups,
        },
        undefined,
        { asUser: customerAuth, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
    );
}

export interface TokenBudgetPatch {
    name?: string;
    unlimited_quota?: boolean;
    remain_quota?: number;
    expired_time?: number;
}
export interface TokenBudgetUpdateResult {
    /** Settings were saved, but an inactive Key was never re-enabled by Portal. */
    requiresReactivation: true;
}

async function patchTokenForCustomer(
    customerAuth: { accessToken: string; userId: number },
    tokenId: number,
    patch: TokenBudgetPatch,
): Promise<TokenBudgetUpdateResult | void> {
    const existing = await getTokenForCustomer(customerAuth, tokenId);
    const parsed = NewApiTokenSchema.safeParse(existing);
    if (!parsed.success || parsed.data.id !== tokenId || parsed.data.user_id !== customerAuth.userId) {
        throw new NewApiError(502, `GET /api/token/${tokenId}`, null, 'Unconfirmed customer token metadata');
    }
    await call<null>('PUT', '/api/token/', { ...existing, id: tokenId, ...patch }, undefined, {
        asUser: customerAuth,
        requireSuccess: true,
    });
    // Saving settings is not authorization to re-enable this token. new-api has no
    // atomic expected-status precondition: a status-only write could undo an external
    // operator disable after any read, even while Portal holds its own mutex.
    // Preserve the original active-token GET→PUT contract and never write status_only.
    if (parsed.data.status !== 1) return { requiresReactivation: true };
}

export function updateTokenForCustomer(
    customerAuth: { accessToken: string; userId: number },
    token: NewApiToken,
    timeoutMs?: number,
): Promise<void>;
export function updateTokenForCustomer(
    customerAuth: { accessToken: string; userId: number },
    tokenId: number,
    patch: TokenBudgetPatch,
): Promise<TokenBudgetUpdateResult | void>;
export async function updateTokenForCustomer(
    customerAuth: { accessToken: string; userId: number },
    tokenOrId: NewApiToken | number,
    patchOrTimeout?: TokenBudgetPatch | number,
): Promise<TokenBudgetUpdateResult | void> {
    if (typeof tokenOrId === 'number') {
        if (!patchOrTimeout || typeof patchOrTimeout !== 'object') throw new Error('Missing token patch');
        return patchTokenForCustomer(customerAuth, tokenOrId, patchOrTimeout);
    }
    return updateCompleteTokenForCustomer(
        customerAuth,
        tokenOrId,
        typeof patchOrTimeout === 'number' ? patchOrTimeout : undefined,
    );
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

/** 改 token 别名(act-as customer)。
 *
 *  ⚠️ new-api `PUT /api/token/` 不是 partial update:非 `status_only` 模式下
 *  会把 name / expired_time / remain_quota / unlimited_quota /
 *  model_limits_enabled / model_limits / allow_ips / group **全部**用请求体
 *  覆盖。只传 `{id, name}` 会把 `unlimited_quota` 刷成 false、
 *  `remain_quota` 刷成 0 → token 立刻被判耗尽拒调(gotcha #12)。
 *  所以先 GET 拿全量,再把 `name` 换掉整体 PUT 回去。 */
export async function renameToken(
    customerAuth: { accessToken: string; userId: number },
    tokenId: number,
    name: string,
): Promise<void> {
    const existing = await getTokenForCustomer(customerAuth, tokenId);
    await call<null>('PUT', '/api/token/', { ...existing, id: tokenId, name }, undefined, { asUser: customerAuth });
}

/** 删 token */
/**
 * 客户视角的可用分组 + **有效倍率**(2026-10-23 专属倍率读路径)。
 *
 * `GET /api/user/self/groups`(act-as 客户)—— new-api 服务端按该用户的用户分组查
 * `GroupGroupRatio[userGroup][group]` 覆盖矩阵,命中返专属倍率,否则返全局 GroupRatio。
 * 与 new-api 自家前端同一数据源,所以客户在 portal 看到的倍率 = 实际扣费倍率。
 * `auto` 项 ratio 为字符串 "auto",调用方忽略。
 */
export async function getUsableGroupsForCustomer(customerAuth: {
    accessToken: string;
    userId: number;
}): Promise<Record<string, { ratio: number | 'auto'; desc: string }>> {
    const raw = await call<Record<string, { ratio?: unknown; desc?: unknown }>>(
        'GET',
        '/api/user/self/groups',
        undefined,
        undefined,
        { asUser: customerAuth, requireSuccess: true, cache: 'no-store', redirect: 'error' },
    );
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid customer group ratios');
    const out: Record<string, { ratio: number | 'auto'; desc: string }> = {};
    for (const [group, v] of Object.entries(raw ?? {})) {
        if (!group.trim() || !v || typeof v !== 'object' || Array.isArray(v))
            throw new Error('Invalid customer group ratios');
        const ratio = (v as { ratio?: unknown }).ratio;
        const desc = (v as { desc?: unknown }).desc;
        if (ratio === 'auto') out[group] = { ratio: 'auto', desc: typeof desc === 'string' ? desc : '' };
        else if (typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= 0)
            out[group] = { ratio, desc: typeof desc === 'string' ? desc : '' };
        else throw new Error('Invalid customer group ratios');
    }
    return out;
}

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

/** Synchronization must never interpret a truncated menu as deleted channels. */
export async function listChannelsForCatalogSync(): Promise<NewApiChannel[]> {
    const channels: NewApiChannel[] = [];
    const seen = new Set<number>();
    let expectedTotal: number | undefined;
    for (let page = 1; page <= 100; page++) {
        const result = await call<NewApiChannel[] | { items: NewApiChannel[]; total?: number }>(
            'GET',
            '/api/channel/',
            undefined,
            { p: page, page_size: 100 },
        );
        const items = Array.isArray(result) ? result : result?.items;
        if (!Array.isArray(items)) throw new Error('Invalid channel list');
        const total = !Array.isArray(result) ? result.total : undefined;
        if (total !== undefined) {
            if (!Number.isSafeInteger(total) || total < 0 || (expectedTotal !== undefined && total !== expectedTotal))
                throw new Error('Channel list changed during pagination');
            expectedTotal = total;
        }
        for (const channel of items) {
            if (!Number.isSafeInteger(channel.id) || channel.id <= 0 || seen.has(channel.id))
                throw new Error('Incomplete or repeated channel page');
            seen.add(channel.id);
            channels.push(channel);
        }
        if (expectedTotal !== undefined && channels.length >= expectedTotal) {
            if (channels.length !== expectedTotal) throw new Error('Channel count mismatch');
            return channels;
        }
        if (items.length < 100) {
            if (expectedTotal !== undefined) throw new Error('Incomplete channel list');
            return channels;
        }
    }
    throw new Error('Channel list exceeds synchronization limit');
}

/** One consistent options read; only the requested, non-secret values escape this function. */
export async function getCatalogSyncOptions(): Promise<Record<string, unknown>> {
    const data = await call<Array<{ key: string; value: unknown }> | Record<string, unknown>>('GET', '/api/option/');
    if (!data || typeof data !== 'object') throw new Error('Invalid options response');
    const keys = ['UserUsableGroups', 'GroupRatio', 'ModelRatio', 'CompletionRatio', 'ModelPrice'];
    const optional = [
        'CacheRatio',
        'CreateCacheRatio',
        'billing_setting.billing_mode',
        'billing_setting.billing_expr',
        'ImageResolutionPrice',
        'billing_setting.task_billing_pricing',
        'billing_setting.scheduled_discount',
        'billing_setting.plugin_billing_expr',
    ];
    const result = Object.fromEntries(
        keys.map((key) => [
            key,
            Array.isArray(data)
                ? (data.find((item) => item && item.key === key)?.value ?? null)
                : Object.hasOwn(data, key)
                  ? data[key]
                  : null,
        ]),
    );
    for (const key of optional) {
        if (Array.isArray(data)) {
            const row = data.find((item) => item && item.key === key);
            if (row) result[key] = row.value;
        } else if (Object.hasOwn(data, key)) result[key] = data[key];
    }
    return result;
}

/** Pricing-only allowlist. Never retain/log the complete admin option response. */
export async function getPricingPublishOptions(): Promise<Record<string, unknown>> {
    const data = await call<Array<{ key: string; value: unknown }> | Record<string, unknown>>(
        'GET',
        '/api/option/',
        undefined,
        undefined,
        { timeoutMs: 10_000 },
    );
    if (!data || typeof data !== 'object') throw new Error('Invalid pricing options response');
    const keys = [
        'GroupRatio',
        'ModelRatio',
        'CompletionRatio',
        'ModelPrice',
        'CompletionRatioMeta',
        'CacheRatio',
        'CreateCacheRatio',
        'GroupGroupRatio',
        'QuotaPerUnit',
        'ImageResolutionPrice',
        'billing_setting.task_billing_pricing',
        'billing_setting.plugin_billing_expr',
        'billing_setting.billing_mode',
        'billing_setting.billing_expr',
        'billing_setting.scheduled_discount',
        'group_ratio_setting.group_ratio',
    ];
    // Preserve absence separately from an explicitly invalid null value. rc.23
    // predates two optional billing features; its complete option list omits
    // their keys. Required pricing dictionaries are still validated downstream.
    return Object.fromEntries(
        keys.flatMap((key): Array<[string, unknown]> => {
            if (Array.isArray(data)) {
                const row = data.find((item) => item && item.key === key);
                return row ? [[key, row.value]] : [];
            }
            return Object.hasOwn(data, key) ? [[key, data[key]]] : [];
        }),
    );
}

export const PRICING_WRITABLE_OPTIONS = [
    'ModelRatio',
    'CompletionRatio',
    'ModelPrice',
    'CacheRatio',
    'CreateCacheRatio',
    'billing_setting.billing_mode',
    'billing_setting.billing_expr',
    'GroupRatio',
    'group_ratio_setting.group_ratio',
] as const;
export type PricingWritableOption = (typeof PRICING_WRITABLE_OPTIONS)[number];

export async function putPricingPublishOption(key: PricingWritableOption, value: string): Promise<void> {
    if (!(PRICING_WRITABLE_OPTIONS as readonly string[]).includes(key))
        throw new Error('Unsupported pricing publication option');
    await call<unknown>('PUT', '/api/option/', { key, value }, undefined, { timeoutMs: 10_000, requireSuccess: true });
}

export interface NewApiRuntimePricingModel {
    model_name: string;
    quota_type: 0 | 1;
    model_ratio: number;
    model_price: number;
    completion_ratio: number;
    enable_groups: string[];
    cache_ratio?: number;
    create_cache_ratio?: number;
    billing_mode?: string;
    billing_expr?: string;
}

export interface NewApiRuntimePricing {
    models: NewApiRuntimePricingModel[];
    /** Anonymous public group ratios, without any customer's group overrides. */
    group_ratio: Record<string, number>;
}

/**
 * Read pricing built from new-api's running ratio/billing structures, not its
 * OptionMap. new-api can cache this view for up to a minute; callers must keep
 * verification pending when it still disagrees with persisted target values.
 * Missing models are not evidence of deletion: visibility also depends on the
 * endpoint's public usable groups. Never send admin credentials, which could
 * select its customer group overrides. No fallback to option values is allowed.
 */
export async function getPricingRuntimeModels(modelNames: string[]): Promise<NewApiRuntimePricing> {
    if (
        !Array.isArray(modelNames) ||
        modelNames.length === 0 ||
        modelNames.length > 30 ||
        modelNames.some((name) => typeof name !== 'string' || !name.trim() || name !== name.trim()) ||
        new Set(modelNames).size !== modelNames.length
    )
        throw new Error('Invalid runtime pricing model selection');
    const envelope = await call<unknown>('GET', '/api/pricing', undefined, undefined, {
        timeoutMs: 10_000,
        requireSuccess: true,
        returnEnvelope: true,
        anonymous: true,
        cache: 'no-store',
        redirect: 'error',
    });
    const invalid = () => new Error('Invalid runtime pricing response');
    const isObject = (value: unknown): value is Record<string, unknown> =>
        value !== null && typeof value === 'object' && !Array.isArray(value);
    const number = (value: unknown): value is number =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0;
    if (!isObject(envelope) || !Array.isArray(envelope.data) || !isObject(envelope.group_ratio)) throw invalid();
    const groupRatio: Array<[string, number]> = [];
    for (const [group, ratio] of Object.entries(envelope.group_ratio)) {
        if (!group.trim() || !number(ratio)) throw invalid();
        groupRatio.push([group, ratio]);
    }
    const requested = new Set(modelNames);
    const models = new Map<string, NewApiRuntimePricingModel>();
    for (const row of envelope.data) {
        if (!isObject(row) || typeof row.model_name !== 'string' || !row.model_name.trim()) throw invalid();
        if (!requested.has(row.model_name)) continue;
        if (
            models.has(row.model_name) ||
            (row.quota_type !== 0 && row.quota_type !== 1) ||
            !number(row.model_ratio) ||
            !number(row.model_price) ||
            !number(row.completion_ratio) ||
            !Array.isArray(row.enable_groups) ||
            row.enable_groups.some((group) => typeof group !== 'string' || !group.trim())
        )
            throw invalid();
        const result: NewApiRuntimePricingModel = {
            model_name: row.model_name,
            quota_type: row.quota_type,
            model_ratio: row.model_ratio,
            model_price: row.model_price,
            completion_ratio: row.completion_ratio,
            enable_groups: [...row.enable_groups] as string[],
        };
        for (const field of ['cache_ratio', 'create_cache_ratio'] as const) {
            if (!Object.hasOwn(row, field)) continue;
            if (!number(row[field])) throw invalid();
            result[field] = row[field];
        }
        for (const field of ['billing_mode', 'billing_expr'] as const) {
            if (!Object.hasOwn(row, field)) continue;
            if (typeof row[field] !== 'string' || !row[field].trim()) throw invalid();
            result[field] = row[field];
        }
        models.set(result.model_name, result);
    }
    if (models.size !== modelNames.length) throw new Error('Requested runtime pricing models are unavailable');
    return { models: modelNames.map((name) => models.get(name)!), group_ratio: Object.fromEntries(groupRatio) };
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
export async function getOption(key: string, strict = false): Promise<string | null> {
    const data = await call<Array<{ key: string; value: unknown }> | Record<string, unknown> | null>(
        'GET',
        '/api/option/',
        undefined,
        undefined,
        strict ? { requireSuccess: true, cache: 'no-store', redirect: 'error' } : {},
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
export async function putOption(key: string, value: string, timeoutMs?: number): Promise<void> {
    await call<unknown>('PUT', '/api/option/', { key, value }, undefined, { timeoutMs });
}

// ============================================
// E. Portal 业务高层封装
// ============================================

import { randomBytes } from 'crypto';

// ============================================
// F. Dashboard access tokens(portal act-as 凭据)
// ============================================
//
// new-api v1.0.0-rc.41 replaced the single per-user dashboard access_token
// (`users.access_token`, 32 chars, rotated via GET /api/user/token) with up
// to 20 named, scoped personal access tokens (PAT, prefix `nap_`):
//   - GET /api/user/token is GONE (NoRoute → 301 to the frontend).
//   - Legacy 32-char tokens keep working for 30 days after the first rc.41+
//     boot (`options.LegacyAccessTokenRetireAt`), then are rejected for good
//     and cannot be regenerated.
//   - Minting a PAT needs a dashboard LOGIN SESSION (Bearer JWT from
//     POST /api/user/login — a PAT cannot mint another PAT) plus a
//     single-use security proof: POST /api/verify {method:'password', ...}
//     → proof_token → header `X-Security-Proof` on POST /api/user/access_tokens.
//   - `expires_at: 0` = never expires. Scopes must be ones the owner can
//     already exercise; a common user can grant api_key:{read,write,reveal}.
//
// `issueCustomerAccessToken` picks the right flow per server version so the
// SAME portal build can be deployed before and after the upgrade:
//   NEWAPI_ACCESS_TOKEN_MODE = legacy | pat | auto(default)
//   auto → GET /api/status `version` once per 5 min: rc ≥ 41 (or any GA
//          ≥ v1.0.0) → pat, else legacy.

export type NewApiAccessTokenMode = 'legacy' | 'pat';

/** Prefix new-api puts on every rc.41+ personal access token. */
export const NEWAPI_PAT_PREFIX = 'nap_';

/** Scopes the per-customer act-as PAT needs: exactly the /api/token/* routes
 *  portal calls on the customer's behalf (create / list / rename / delete /
 *  reveal). Kept minimal on purpose — usage, balance and quota are read via
 *  the admin credential. Sorted: the verify-step context must normalise to
 *  the same set as the create-step body. */
export const CUSTOMER_PAT_SCOPES: readonly string[] = ['api_key:read', 'api_key:reveal', 'api_key:write'];

/** Name shown in the customer's new-api "Security & Access" list. */
export const CUSTOMER_PAT_NAME = 'portal-act-as';

/** Verification scope new-api binds the PAT-create proof to. */
const VERIFICATION_SCOPE_ACCESS_TOKEN_GENERATE = 'access_token.generate';
const VERIFICATION_SCOPE_ADMIN_USER_UPDATE = 'admin.user.update';

/** true for a pre-rc.41 32-char `users.access_token`; false for a `nap_` PAT. */
export function isLegacyNewApiAccessToken(token: string): boolean {
    return !token.startsWith(NEWAPI_PAT_PREFIX);
}

const ACCESS_TOKEN_MODE_CACHE_MS = 5 * 60_000;
let cachedAccessTokenMode: { mode: NewApiAccessTokenMode; at: number } | null = null;

/** Test hook: forget the cached auto-detected mode. */
export function _resetAccessTokenModeCache(): void {
    cachedAccessTokenMode = null;
}

/**
 * Map a new-api `version` string to the access-token flow it supports.
 * Empty/custom versions are not evidence of PAT support. They require a read-only
 * capability probe on the fresh customer login session.
 */
export function accessTokenModeForVersion(version: string | null | undefined): NewApiAccessTokenMode | 'probe' {
    if (typeof version !== 'string' || !version.trim()) return 'probe';
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
    if (!m) return 'probe';
    const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (major > 1 || (major === 1 && (minor > 0 || patch > 0))) return 'pat';
    if (major < 1) return 'legacy';
    // 1.0.0 exactly: GA → pat; rc.N → pat from rc.41 (PR #7598-era release).
    if (m[4] === undefined) return 'pat';
    return Number(m[4]) >= 41 ? 'pat' : 'legacy';
}

/**
 * Resolve which access-token flow to use. Env pin wins; otherwise detect
 * from GET /api/status (known versions cached 5 min). A missing/unreadable/custom
 * version selects a read-only PAT catalog probe; no password verification or
 * credential issuance is used for capability detection.
 */
export async function resolveAccessTokenMode(): Promise<NewApiAccessTokenMode | 'probe'> {
    const pinned = (process.env.NEWAPI_ACCESS_TOKEN_MODE ?? 'auto').trim().toLowerCase();
    if (pinned === 'legacy' || pinned === 'pat') return pinned;
    const now = Date.now();
    if (cachedAccessTokenMode && now - cachedAccessTokenMode.at < ACCESS_TOKEN_MODE_CACHE_MS) {
        return cachedAccessTokenMode.mode;
    }
    try {
        const status = await call<{ version?: string } | null>('GET', '/api/status', undefined, undefined, {
            anonymous: true,
            requireSuccess: true,
            cache: 'no-store',
        });
        const mode = accessTokenModeForVersion(status?.version);
        if (mode !== 'probe') cachedAccessTokenMode = { mode, at: now };
        return mode;
    } catch {
        return 'probe';
    }
}

const SecurityProofSchema = z.object({ proof_token: z.string().min(1) });
const CreatedAccessTokenSchema = z.object({ token: z.string().startsWith(NEWAPI_PAT_PREFIX) });

/**
 * rc.41+: obtain a single-use security proof for `scope` with the account's
 * password. `session` must be a dashboard LOGIN session (Bearer JWT) — or a
 * scoped PAT whose own grant covers the operation; legacy tokens cannot.
 */
async function obtainSecurityProof(args: {
    session: LoginSessionAuth;
    userId: number;
    password: string;
    scope: string;
    context: Record<string, unknown>;
}): Promise<string> {
    let res: unknown;
    try {
        res = await call<unknown>(
            'POST',
            '/api/verify',
            { method: 'password', scope: args.scope, password: args.password, context: args.context },
            undefined,
            { session: { auth: args.session, userId: args.userId }, requireSuccess: true, cache: 'no-store' },
        );
    } catch (error) {
        if (error instanceof NewApiError)
            throw new NewApiError(error.status, error.endpoint, null, 'Password verification failed');
        throw error;
    }
    const parsed = SecurityProofSchema.safeParse(res);
    if (!parsed.success) {
        throw new NewApiError(200, 'POST /api/verify', null, 'verify OK but no proof_token in response');
    }
    return parsed.data.proof_token;
}

/**
 * rc.41+: mint the customer's never-expiring act-as PAT.
 * Two calls on the customer's login session: verify (password) → create.
 */
export async function createCustomerPersonalAccessToken(args: {
    session: LoginSessionAuth;
    userId: number;
    password: string;
    name?: string;
}): Promise<string> {
    const scopes = [...CUSTOMER_PAT_SCOPES];
    const proof = await obtainSecurityProof({
        session: args.session,
        userId: args.userId,
        password: args.password,
        scope: VERIFICATION_SCOPE_ACCESS_TOKEN_GENERATE,
        // Must carry exactly {scopes, expires_at} and match the create body.
        context: { scopes, expires_at: 0 },
    });
    const created = await call<unknown>(
        'POST',
        '/api/user/access_tokens',
        { name: args.name ?? CUSTOMER_PAT_NAME, scopes, expires_at: 0 },
        undefined,
        {
            session: { auth: args.session, userId: args.userId },
            securityProof: proof,
            requireSuccess: true,
            cache: 'no-store',
        },
    );
    const parsed = CreatedAccessTokenSchema.safeParse(created);
    if (!parsed.success) {
        throw new NewApiError(200, 'POST /api/user/access_tokens', null, 'create OK but no nap_ token in response');
    }
    return parsed.data.token;
}

/** Missing-route responses are considered only for the dedicated read-only capability URL.
 * In old servers /api/user/access_tokens can collide with the admin /api/user/:id route,
 * so probing that list path would turn a missing capability into an ambiguous 403.
 * Official rc.44 exposes GET /api/user/access_tokens/catalog on the same browser-session
 * middleware as ListAccessTokens and CreateAccessToken, without issuing a token/proof.
 */
async function probeCustomerAccessTokenMode(args: {
    session: LoginSessionAuth;
    userId: number;
}): Promise<NewApiAccessTokenMode> {
    let catalog: unknown;
    try {
        catalog = await call<unknown>('GET', '/api/user/access_tokens/catalog', undefined, undefined, {
            session: { auth: args.session, userId: args.userId },
            requireSuccess: true,
            cache: 'no-store',
            redirect: 'manual',
        });
    } catch (error) {
        if (error instanceof NewApiError && [301, 404, 405].includes(error.status)) return 'legacy';
        // Auth failures, timeout/connection uncertainty and malformed successes do not
        // authorize rotating a different credential as a fallback.
        throw error;
    }
    const parsed = z
        .object({
            groups: z.array(z.unknown()),
            max_tokens: z.number().int().positive(),
            default_expiry_days: z.number().int().nonnegative(),
        })
        .safeParse(catalog);
    if (!parsed.success)
        throw new NewApiError(
            502,
            'GET /api/user/access_tokens/catalog',
            null,
            'Unconfirmed personal access token capability',
        );
    return 'pat';
}

/**
 * Obtain a customer's dashboard access_token on whatever new-api version is
 * running — the one call provisioning (and the legacy-token migration) use.
 *
 * `password` is the customer's new-api password (known at provision time,
 * or freshly reset by admin during migration); it is only sent to
 * POST /api/verify on rc.41+ and never stored by portal.
 */
export async function issueCustomerAccessToken(args: {
    session: LoginSessionAuth;
    userId: number;
    password: string;
}): Promise<string> {
    const detected = await resolveAccessTokenMode();
    const mode = detected === 'probe' ? await probeCustomerAccessTokenMode(args) : detected;
    if (mode === 'legacy') return rotateLegacyAccessToken(args);
    // Once support is confirmed (or explicitly pinned), verification/create errors must
    // propagate. Never turn a failed or ambiguous PAT mutation into a legacy rotation.
    return createCustomerPersonalAccessToken(args);
}

/**
 * Migration helper for customers provisioned before rc.41: portal holds
 * their legacy `users.access_token` but NOT their new-api password, so a PAT
 * cannot be minted on their session directly. Admin (root) resets the
 * customer's password (PUT /api/user/ with a password requires an admin
 * security proof bound to `{user_id}`), then we log in as the customer and
 * mint the PAT exactly like provisioning does.
 *
 * Side effect: the customer's new-api password changes (customers never use
 * it — they log into portal, not new-api) and their legacy access_token
 * stays valid until new-api's retire date, so a half-finished run is safe
 * to resume.
 *
 * `admin` must be a dashboard login session of a user allowed to manage the
 * customer (root for everybody) — obtained via `loginNewApiUser`.
 */
export async function reissueCustomerAccessTokenViaAdminReset(args: {
    admin: { session: LoginSessionAuth; userId: number; password: string };
    customer: { userId: number };
}): Promise<{ accessToken: string; username: string }> {
    const existing = await call<NewApiUser>('GET', `/api/user/${args.customer.userId}`, undefined, undefined, {
        session: { auth: args.admin.session, userId: args.admin.userId },
    });
    const newPassword = generateUserPassword();
    const proof = await obtainSecurityProof({
        session: args.admin.session,
        userId: args.admin.userId,
        password: args.admin.password,
        scope: VERIFICATION_SCOPE_ADMIN_USER_UPDATE,
        context: { user_id: args.customer.userId },
    });
    // PUT /api/user/ validates the whole struct (username required) → send
    // the fetched user back with only the password changed.
    // Strip server-managed echoes before sending the user back: a non-null
    // `admin_permissions` map makes new-api treat the PUT as a permission
    // rewrite (rc.44 rehearsal finding), gorm:"-" fields are noise.
    const {
        admin_permissions: _perm,
        DeletedAt: _deleted,
        original_password: _orig,
        verification_code: _code,
        ...editable
    } = existing as NewApiUser & Record<string, unknown>;
    void _perm;
    void _deleted;
    void _orig;
    void _code;
    await call<null>('PUT', '/api/user/', { ...editable, password: newPassword }, undefined, {
        session: { auth: args.admin.session, userId: args.admin.userId },
        securityProof: proof,
    });
    const session = await loginAsUser({ username: existing.username, password: newPassword });
    const accessToken = await issueCustomerAccessToken({
        session: session.auth,
        userId: session.user.id,
        password: newPassword,
    });
    return { accessToken, username: existing.username };
}

/** Public wrapper over the login call for scripts (e.g. root login during migration). */
export async function loginNewApiUser(args: { username: string; password: string }): Promise<{
    auth: LoginSessionAuth;
    user: { id: number; username: string; role: number };
}> {
    return loginAsUser(args);
}

// access_tokens are issued by new-api itself after a session login — portal
// never mints them. (W2 D6 finding: PUT /api/user/ silently ignores any
// access_token field passed by admin.) How they are issued depends on the
// new-api version — see the "F. Dashboard access tokens" section below.

/** 生成随机密码(8-20 字符,符合 new-api validator) */
function generateUserPassword(): string {
    return randomBytes(8).toString('hex').slice(0, 16); // 16 字符
}

/** Exchange the login credential without ever persisting the short-lived JWT.
 * Newer new-api requires password re-verification and a single-use operation
 * proof. Only that explicit challenge enables this flow; other failures and
 * ambiguous network outcomes must not cause another token rotation.
 */
async function rotateLegacyAccessToken(args: {
    session: LoginSessionAuth;
    userId: number;
    password: string;
}): Promise<string> {
    const options: CallOptions = {
        session: { auth: args.session, userId: args.userId },
        requireSuccess: true,
        cache: 'no-store',
        redirect: 'manual',
    };
    let token: unknown;
    try {
        token = await call<unknown>('GET', '/api/user/token', undefined, undefined, options);
    } catch (error) {
        if (
            args.session.kind !== 'bearer' ||
            !(error instanceof NewApiError) ||
            error.status !== 403 ||
            !isRecord(error.payload) ||
            error.payload.code !== 'SECURITY_PROOF_REQUIRED'
        ) {
            throw error;
        }

        const scope = 'access_token.generate';
        const requirements = await call<unknown>('GET', '/api/verify/methods', undefined, { scope }, options);
        const policy = z
            .object({
                scope: z.literal(scope),
                password_encryption_enabled: z.literal(false),
                methods: z.array(z.object({ method: z.string(), available: z.boolean() })),
            })
            .safeParse(requirements);
        if (
            !policy.success ||
            !policy.data.methods.some((method) => method.method === 'password' && method.available)
        ) {
            throw new NewApiError(
                403,
                'GET /api/verify/methods',
                null,
                'Password verification is unavailable for provisioning',
            );
        }

        let verification: unknown;
        try {
            verification = await call<unknown>(
                'POST',
                '/api/verify',
                { method: 'password', scope, password: args.password },
                undefined,
                options,
            );
        } catch (error) {
            // Never retain an upstream response that could echo the password.
            if (error instanceof NewApiError) {
                throw new NewApiError(error.status, error.endpoint, null, 'Provisioning password verification failed');
            }
            throw error;
        }
        const proof = z
            .object({
                proof_token: z.string().trim().min(1),
                method: z.literal('password'),
                scope: z.literal(scope),
                expires_at: z
                    .number()
                    .int()
                    .refine((value) => value > Date.now() / 1000),
            })
            .safeParse(verification);
        if (!proof.success) {
            throw new NewApiError(502, 'POST /api/verify', null, 'Invalid provisioning security proof');
        }
        token = await call<unknown>('GET', '/api/user/token', undefined, undefined, {
            ...options,
            securityProof: proof.data.proof_token,
        });
    }
    if (
        typeof token !== 'string' ||
        !token.trim() ||
        (args.session.kind === 'bearer' && token === args.session.jwt) ||
        token.split('.').length === 3
    ) {
        throw new NewApiError(502, 'GET /api/user/token', null, 'Invalid persistent access token');
    }
    return token;
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
 *   2. POST /api/user/login        新版返回短效 JWT + user;旧版返回 session cookie
 *   3. GET  /api/user/token        以 JWT/cookie 换取(并 rotate)持久 access_token
 *                                  ⚠️ 这个端点 admin 调不动:必须用该用户自己的 session
 *                                     PUT /api/user/ 里的 access_token 字段是被静默忽略的
 *   4. POST /api/token/            以 customer 的 access_token 身份创建第一个 token
 *   5. GET  /api/token/            反查 token.id(create 不返回 ID)
 *   6. POST /api/token/{id}/key    拿真实 key(sk-xxx)
 *
 * @param portal_user_id portal 自己 User 表的 UUID(作为 username 后缀确保唯一)
 * @param email  客户邮箱
 * @param newapi_group 首个客户 Key 使用的 new-api 计费分组
 */
export async function provisionNewCustomer(args: {
    portal_user_id: string;
    email: string;
    newapi_group: string;
    initial_quota?: number; // 默认 0
}): Promise<ProvisionedCustomer> {
    const username = `c-${args.portal_user_id.slice(0, 8)}`; // c-25a69821
    const password = generateUserPassword();

    // Step 1: admin creates user.
    // display_name has a 20-char limit on new-api side; emails routinely exceed
    // that, so we use the (already <20) username as the display name and keep
    // the full email in the email field (which has a 50-char limit).
    await createUser({ username, password, display_name: username, email: args.email });

    // Step 2: log in as the customer. Current new-api returns a short-lived
    // session JWT; older versions only return a session cookie.
    const login = await loginAsUser({ username, password });
    const userId = login.user.id;

    // Step 3: exchange the login credential for new-api's persistent access
    // token. Saving the login JWT here makes Portal key management fail once
    // that short-lived session expires. Current releases accept the JWT;
    // older releases require the legacy session cookie.
    const accessToken = await issueCustomerAccessToken({ session: login.auth, userId, password });

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
        group: args.newapi_group,
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
 * 配额单位换算:1 个技术计费单位 = QUOTA_PER_USD(默认 500_000)quota,
 * 1 个技术计费单位 = USD_TO_CNY_RATE 元。变量/函数中的 USD 命名仅为历史兼容。
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
