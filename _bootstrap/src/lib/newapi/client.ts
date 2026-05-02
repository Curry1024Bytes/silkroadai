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
// 配置 + 常量
// ============================================

const NEWAPI_BASE_URL = process.env.NEWAPI_BASE_URL || 'http://localhost:3000';
const NEWAPI_ADMIN_TOKEN = process.env.NEWAPI_ADMIN_TOKEN;
const NEWAPI_ADMIN_USER_ID = process.env.NEWAPI_ADMIN_USER_ID;

// new-api 默认 1 USD = 500,000 quota(可在 admin 后台改)
// 如果你改了,这里也要同步,或者改用 GET /api/option/ 动态拉取
export const QUOTA_PER_USD = parseInt(process.env.NEWAPI_QUOTA_PER_USD || '500000', 10);
export const USD_TO_CNY_RATE = parseFloat(process.env.USD_TO_CNY_RATE || '7.2');

if (!NEWAPI_ADMIN_TOKEN || !NEWAPI_ADMIN_USER_ID) {
    throw new Error(
        'Missing required env: NEWAPI_ADMIN_TOKEN + NEWAPI_ADMIN_USER_ID. ' +
        'Generate them in new-api admin UI under Personal Settings → System Access Token.',
    );
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

interface CallOptions {
    /** 用哪个 access_token + user_id 调用。默认用 admin。 */
    asUser?: { accessToken: string; userId: number };
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

    const auth = options.asUser ?? {
        accessToken: NEWAPI_ADMIN_TOKEN!,
        userId: parseInt(NEWAPI_ADMIN_USER_ID!, 10),
    };

    const init: RequestInit = {
        method,
        headers: {
            'Authorization': auth.accessToken,           // 注意:不带 Bearer 前缀也接受
            'New-Api-User': String(auth.userId),         // ⚠️ 必填,否则 401
            'Content-Type': 'application/json',
        },
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await fetch(url, init);
    const text = await res.text();
    let data: NewApiEnvelope<T> | null = null;
    try { data = text ? JSON.parse(text) as NewApiEnvelope<T> : null; } catch { /* */ }

    if (!res.ok || (data && !data.success)) {
        const msg = data?.message ?? text ?? res.statusText;
        throw new NewApiError(res.status, `${method} ${path}`, data, String(msg));
    }
    return (data?.data ?? null) as T;
}

// ============================================
// 类型(基于 new-api source code 实际 schema)
// ============================================

export const NewApiUserSchema = z.object({
    id: z.number().int(),
    username: z.string(),
    display_name: z.string(),
    role: z.union([z.literal(1), z.literal(10), z.literal(100)]),  // common | admin | root
    status: z.union([z.literal(1), z.literal(2)]),                  // enabled | disabled
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
    key: z.string(),                                                // sk-... ; 通常被 mask
    status: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    name: z.string(),
    created_time: z.number(),
    accessed_time: z.number(),
    expired_time: z.number(),                                       // -1 = 永不过期
    remain_quota: z.number().int(),
    unlimited_quota: z.boolean(),
    model_limits_enabled: z.boolean(),
    model_limits: z.string(),                                       // CSV
    used_quota: z.number().int(),
    group: z.string(),
});
export type NewApiToken = z.infer<typeof NewApiTokenSchema>;

export interface NewApiUsageLog {
    id: number;
    user_id: number;
    created_at: number;                                             // unix seconds
    type: 0 | 1 | 2 | 3 | 4 | 5 | 6;                                // unknown|topup|consume|manage|system|error|refund
    content: string;
    username: string;
    token_name: string;
    model_name: string;
    quota: number;
    prompt_tokens: number;
    completion_tokens: number;
    use_time: number;                                               // ms
    is_stream: boolean;
    channel: number;
    token_id: number;
    group: string;
}

// ============================================
// 工具函数:配额单位转换
// ============================================

/** quota → USD */
export function quotaToUsd(quota: number): number {
    return quota / QUOTA_PER_USD;
}

/** quota → CNY(展示给中国客户) */
export function quotaToCny(quota: number): number {
    return quotaToUsd(quota) * USD_TO_CNY_RATE;
}

/** USD → quota */
export function usdToQuota(usd: number): number {
    return Math.round(usd * QUOTA_PER_USD);
}

/** CNY → quota(用户充 100 元 → portal 算出对应 quota 调 add_quota) */
export function cnyToQuota(cny: number): number {
    return usdToQuota(cny / USD_TO_CNY_RATE);
}

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
    username: string;       // 必须唯一,max 20 字符
    password: string;       // 8-20 字符
    display_name?: string;  // max 20
    email?: string;         // max 50
}): Promise<void> {
    await call<null>('POST', '/api/user/', {
        username: args.username,
        password: args.password,
        display_name: args.display_name ?? args.username,
        email: args.email ?? '',
        role: 1,            // 1 = common user
    });
}

/** 查 user(by id) */
export async function getUser(id: number): Promise<NewApiUser> {
    return await call<NewApiUser>('GET', `/api/user/${id}`);
}

/** 搜 user(by 用户名/邮箱关键词) */
export async function searchUser(keyword: string, page = 1, pageSize = 20): Promise<{
    items: NewApiUser[];
    total: number;
}> {
    return await call('GET', '/api/user/search', undefined, { keyword, p: page, page_size: pageSize });
}

/**
 * 更新 user(全字段 PUT,密码留空表示不改)
 *
 * 用途:portal 给客户设置一个已知的 access_token(关键步骤,见上面架构注释 #3)
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
    quotaDelta: number;                                  // raw quota
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
        name: string;                    // token 别名,max 50
        unlimited_quota?: boolean;       // 默认 false
        remain_quota?: number;           // 默认按 user 总 quota,unlimited 时忽略
        expired_time?: number;           // unix seconds, -1 = 永不过期(默认)
        model_limits_enabled?: boolean;
        model_limits?: string;           // CSV "gpt-4,deepseek-v4-flash"
        allow_ips?: string | null;       // newline-separated
        group?: string;                  // 所属分组(决定计费倍率)
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
    return await call(
        'GET',
        '/api/token/',
        undefined,
        { p: page, page_size: pageSize },
        { asUser: customerAuth },
    );
}

/** 拿 token 的真实 key(masked 之外) */
export async function getTokenKey(
    customerAuth: { accessToken: string; userId: number },
    tokenId: number,
): Promise<string> {
    return await call<string>(
        'POST',
        `/api/token/${tokenId}/key`,
        undefined,
        undefined,
        { asUser: customerAuth },
    );
}

/** 删 token */
export async function deleteToken(
    customerAuth: { accessToken: string; userId: number },
    tokenId: number,
): Promise<void> {
    await call<null>(
        'DELETE',
        `/api/token/${tokenId}`,
        undefined,
        undefined,
        { asUser: customerAuth },
    );
}

// ============================================
// C. Logs / 用量
// ============================================

/**
 * 查询用量日志
 *
 * ⚠️ filter 是 username (string) 不是 user_id!
 * portal 要在 users 表里维护 username 字段或缓存 id→username
 */
export async function queryLogs(args: {
    username?: string;
    type?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
    start_timestamp?: number;
    end_timestamp?: number;
    model_name?: string;
    token_name?: string;
    page?: number;
    page_size?: number;
}): Promise<{ items: NewApiUsageLog[]; total: number }> {
    return await call('GET', '/api/log/', undefined, {
        p: args.page ?? 1,
        page_size: args.page_size ?? 50,
        username: args.username,
        type: args.type,
        start_timestamp: args.start_timestamp,
        end_timestamp: args.end_timestamp,
        model_name: args.model_name,
        token_name: args.token_name,
    });
}

/** 聚合统计 */
export async function getLogStats(args: {
    username?: string;
    start_timestamp?: number;
    end_timestamp?: number;
    model_name?: string;
}): Promise<{ quota: number; rpm: number; tpm: number }> {
    return await call('GET', '/api/log/stat', undefined, {
        type: 2,             // consume only
        username: args.username,
        start_timestamp: args.start_timestamp,
        end_timestamp: args.end_timestamp,
        model_name: args.model_name,
    });
}

// ============================================
// D. 模型列表
// ============================================

/** 列出所有可用模型(给 portal 前端展示) */
export async function listAvailableModels(): Promise<string[]> {
    return await call<string[]>('GET', '/api/channel/models_enabled');
}

// ============================================
// E. Portal 业务高层封装
// ============================================

import { randomBytes } from 'crypto';

/** 生成 32 字符的 access_token(给 customer 用) */
function generateAccessToken(): string {
    return randomBytes(16).toString('hex');                 // 32 字符 hex
}

/** 生成随机密码(8-20 字符,符合 new-api validator) */
function generateUserPassword(): string {
    return randomBytes(8).toString('hex').slice(0, 16);     // 16 字符
}

export interface ProvisionedCustomer {
    newapi_user_id: number;
    newapi_username: string;
    newapi_access_token: string;                            // portal 内部 secret
    newapi_token_id: number;
    newapi_token_value: string;                             // sk-xxx 给客户
}

/**
 * 高层封装:开通新客户
 *
 * 流程:
 *   1. POST /api/user/         创建 new-api user
 *   2. GET  /api/user/search   反查 user.id
 *   3. PUT  /api/user/         给 user 设置一个 access_token(portal 自己生成,存 DB)
 *   4. POST /api/token/        as 该 user,创建第一个 token
 *   5. GET  /api/token/        反查 token.id
 *   6. POST /api/token/{id}/key 拿真实 key(sk-xxx)
 *
 * @param portal_user_id portal 自己 User 表的 UUID(作为 username 后缀确保唯一)
 * @param email  客户邮箱
 */
export async function provisionNewCustomer(args: {
    portal_user_id: string;
    email: string;
    initial_quota?: number;            // 默认 0
}): Promise<ProvisionedCustomer> {
    const username = `c-${args.portal_user_id.slice(0, 8)}`;     // c-25a69821
    const password = generateUserPassword();
    const accessToken = generateAccessToken();

    // Step 1: 创建 user
    await createUser({ username, password, display_name: args.email, email: args.email });

    // Step 2: 反查 user.id
    const search = await searchUser(username, 1, 5);
    const user = search.items.find(u => u.username === username);
    if (!user) {
        throw new Error(`Failed to find newly created user ${username} after createUser. Race condition?`);
    }

    // Step 3: 给 user 设置 portal 控制的 access_token
    await updateUser({ id: user.id, access_token: accessToken });

    // Step 4: 创建 token(必须 act as 该 user)
    const customerAuth = { accessToken, userId: user.id };
    const tokenName = `default-${args.portal_user_id.slice(0, 8)}`;
    await createTokenForCustomer(customerAuth, {
        name: tokenName,
        unlimited_quota: false,
        remain_quota: args.initial_quota ?? 0,
        expired_time: -1,
    });

    // Step 5: 反查 token.id
    const tokens = await listTokensForCustomer(customerAuth, 1, 10);
    const token = tokens.items.find(t => t.name === tokenName);
    if (!token) {
        throw new Error(`Failed to find newly created token ${tokenName} after createTokenForCustomer.`);
    }

    // Step 6: 拿 token 的真实 key
    const realKey = await getTokenKey(customerAuth, token.id);

    return {
        newapi_user_id: user.id,
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
}): Promise<void> {
    const quotaDelta = cnyToQuota(args.cnyAmount);
    await addQuota({
        userId: args.newapi_user_id,
        quotaDelta,
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
