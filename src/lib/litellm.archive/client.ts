/**
 * LLmRoute Portal — LiteLLM Admin API Client
 * ================================================
 *
 * 替换原 src/lib/sub2api/client.ts
 *
 * 所有方法都用 LITELLM_MASTER_KEY 调 LiteLLM Admin API。
 * 设计参考 LiteLLM 1.82.6 的端点定义,见:
 *   https://github.com/BerriAI/litellm/blob/main/litellm/proxy/management_endpoints/key_management_endpoints.py
 *
 * 使用前请确保 .env 里设置了:
 *   LITELLM_BASE_URL=http://localhost:4000
 *   LITELLM_MASTER_KEY=sk-master-xxx
 */

import { z } from 'zod';

// ============================================
// 配置 + 工具
// ============================================

const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || 'http://localhost:4000';
const LITELLM_MASTER_KEY = process.env.LITELLM_MASTER_KEY;

if (!LITELLM_MASTER_KEY) {
    throw new Error('Missing required env var: LITELLM_MASTER_KEY');
}

class LiteLLMApiError extends Error {
    constructor(
        public status: number,
        public endpoint: string,
        public payload: unknown,
        message: string,
    ) {
        super(`LiteLLM API ${endpoint} ${status}: ${message}`);
        this.name = 'LiteLLMApiError';
    }
}

async function callLiteLLM<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    queryParams?: Record<string, string | number | undefined>,
): Promise<T> {
    const url = new URL(path, LITELLM_BASE_URL);
    if (queryParams) {
        for (const [k, v] of Object.entries(queryParams)) {
            if (v !== undefined) url.searchParams.set(k, String(v));
        }
    }

    const init: RequestInit = {
        method,
        headers: {
            Authorization: `Bearer ${LITELLM_MASTER_KEY}`,
            'Content-Type': 'application/json',
        },
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await fetch(url, init);
    const text = await res.text();
    let data: unknown = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = text;
    }

    if (!res.ok) {
        const detail = (data as { detail?: unknown } | null)?.detail;
        const errField = (data as { error?: unknown } | null)?.error;
        // LiteLLM frequently returns `detail` as a list of pydantic
        // validation issues. JSON-stringify so the message stays readable
        // instead of `[object Object]`.
        const stringify = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));
        const msg =
            detail !== undefined
                ? stringify(detail)
                : errField !== undefined
                  ? stringify(errField)
                  : text || res.statusText;
        throw new LiteLLMApiError(res.status, `${method} ${path}`, data, msg);
    }
    return data as T;
}

// ============================================
// 类型(基于 LiteLLM 1.82.6 schema)
// ============================================

export const LiteLLMUserSchema = z.object({
    user_id: z.string(),
    user_email: z.string().nullable().optional(),
    user_alias: z.string().nullable().optional(),
    user_role: z.string().nullable().optional(),
    max_budget: z.number().nullable().optional(),
    spend: z.number().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
});
export type LiteLLMUser = z.infer<typeof LiteLLMUserSchema>;

export const LiteLLMKeySchema = z.object({
    key_name: z.string().optional(),
    key_alias: z.string().nullable().optional(),
    user_id: z.string().nullable().optional(),
    spend: z.number().default(0),
    max_budget: z.number().nullable().optional(),
    soft_budget: z.number().nullable().optional(),
    expires: z.string().nullable().optional(),
    models: z.array(z.string()).default([]),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
});
export type LiteLLMKey = z.infer<typeof LiteLLMKeySchema>;

export interface GenerateKeyResponse extends LiteLLMKey {
    key: string; // 完整的 sk-xxx,只在创建时返回一次
    expires: string | null;
    user_id: string | null;
}

export interface SpendLogEntry {
    request_id: string;
    api_key: string;
    model: string;
    spend: number;
    total_tokens: number;
    prompt_tokens: number;
    completion_tokens: number;
    startTime: string; // UTC
    endTime: string; // UTC
    user: string | null;
    metadata: Record<string, unknown>;
}

// ============================================
// 用户管理
// ============================================

/**
 * 创建一个新的 LiteLLM user(对应 portal 注册流程的最后一步)
 *
 * 注意:auto_create_key 默认是 true,这里关掉,我们让 portal 显式调 generateKey
 * 因为 portal 想自己控制 key 的 alias 和 max_budget
 */
export async function createUser(args: {
    user_email: string;
    user_alias?: string;
    max_budget?: number;
    user_role?: 'internal_user' | 'internal_user_viewer';
}): Promise<{ user_id: string; user_email: string }> {
    // LiteLLM 1.82.6 LitellmUserRoles enum: proxy_admin | proxy_admin_viewer
    // | internal_user | internal_user_viewer. Portal customers map to
    // `internal_user` (key/budget owner with no admin endpoints).
    const result = await callLiteLLM<{ user_id: string; user_email: string }>('POST', '/user/new', {
        user_email: args.user_email,
        user_alias: args.user_alias,
        max_budget: args.max_budget,
        user_role: args.user_role || 'internal_user',
        auto_create_key: false,
    });
    return { user_id: result.user_id, user_email: result.user_email };
}

/**
 * 查询 LiteLLM user 信息(包括所有 keys)
 */
export async function getUserInfo(user_id: string): Promise<{
    user_info: LiteLLMUser;
    keys: LiteLLMKey[];
}> {
    return await callLiteLLM('GET', '/user/info', undefined, { user_id });
}

// ============================================
// Key 管理(核心)
// ============================================

/**
 * 给一个 user 生成新的 Virtual Key
 *
 * 返回值里的 `key` 字段是完整的 sk-xxx,只这一次返回,之后只能拿 key_name(hash)
 * Portal 必须在数据库里立即保存这个 key 给客户看
 */
export async function generateKey(args: {
    user_id: string;
    key_alias?: string;
    max_budget?: number;
    models?: string[]; // 空数组 = 所有模型
    metadata?: Record<string, unknown>;
}): Promise<GenerateKeyResponse> {
    return await callLiteLLM<GenerateKeyResponse>('POST', '/key/generate', {
        user_id: args.user_id,
        key_alias: args.key_alias,
        max_budget: args.max_budget,
        models: args.models ?? [],
        metadata: args.metadata,
    });
}

/**
 * 更新 Key 的 max_budget
 *
 * ⚠️ 重要:LiteLLM 的 max_budget 是 REPLACE 不是 ADD!
 * 充值流程必须:
 *   1. Portal 维护 recharge_logs,算 newMax = SUM(amount) 累计总充值
 *   2. 调本函数 PUT 这个总值
 *   3. 充值后立刻调 getKeyInfo 强制刷新 LiteLLM 缓存(否则 60 秒内余额可能不生效)
 */
export async function updateKeyBudget(args: {
    key: string; // 完整的 sk-xxx
    max_budget: number; // 替换为这个总值
}): Promise<LiteLLMKey> {
    const result = await callLiteLLM<LiteLLMKey>('POST', '/key/update', { key: args.key, max_budget: args.max_budget });
    // 强制刷新缓存
    await getKeyInfo(args.key).catch(() => {
        /* ignore */
    });
    return result;
}

/**
 * 查 Key 详情(spend、max_budget 等)
 *
 * 同时会触发 LiteLLM 把这个 key 的状态从 DB 重新加载到内存缓存
 */
export async function getKeyInfo(key: string): Promise<{
    info: LiteLLMKey;
}> {
    return await callLiteLLM('GET', '/key/info', undefined, { key });
}

/**
 * 列出某 user 的所有 keys(支持分页)
 */
export async function listKeys(args: {
    user_id?: string;
    page?: number;
    size?: number;
    sort_by?: 'created_at' | 'spend' | 'updated_at';
    sort_order?: 'asc' | 'desc';
    return_full_object?: boolean;
}): Promise<{
    keys: LiteLLMKey[];
    total_count: number;
    current_page: number;
    total_pages: number;
}> {
    return await callLiteLLM('GET', '/key/list', undefined, {
        user_id: args.user_id,
        page: args.page ?? 1,
        size: args.size ?? 20,
        sort_by: args.sort_by ?? 'created_at',
        sort_order: args.sort_order ?? 'desc',
        return_full_object: String(args.return_full_object ?? true),
    });
}

/**
 * 删除一个或多个 key
 */
export async function deleteKeys(keys: string[]): Promise<{ deleted_keys: string[] }> {
    return await callLiteLLM('POST', '/key/delete', { keys });
}

/**
 * 重置 Key 的 spend 到 0
 *
 * 只在退款 / 客户主动请求 reset 时用!
 * 平时不要调,会让用量曲线断层。
 */
export async function resetKeySpend(key: string): Promise<{ key: string; spend: number }> {
    // 路径里的 key 需要 URL encode
    return await callLiteLLM('POST', `/key/${encodeURIComponent(key)}/reset_spend`, { reset_to: 0 });
}

// ============================================
// Spend / 用量查询
// ============================================

/**
 * 查询某个 key 在某段时间的消费日志
 *
 * 时间是 UTC,格式 YYYY-MM-DD HH:MM:SS
 * Portal 客户端时间要转 UTC 再调
 */
export async function getSpendLogs(args: {
    api_key?: string;
    user_id?: string;
    start_date: string; // "YYYY-MM-DD HH:MM:SS" UTC
    end_date: string; // 同上
    page?: number;
    page_size?: number;
}): Promise<{
    logs: SpendLogEntry[];
    total: number;
    page: number;
    page_size: number;
}> {
    return await callLiteLLM('GET', '/spend/logs/v2', undefined, {
        api_key: args.api_key,
        user_id: args.user_id,
        start_date: args.start_date,
        end_date: args.end_date,
        page: args.page ?? 1,
        page_size: args.page_size ?? 50,
    });
}

// ============================================
// 健康检查 + 模型列表(给 portal 前端用)
// ============================================

/**
 * 拿当前 LiteLLM 配置的所有可用模型
 */
export async function listModels(): Promise<{
    data: Array<{ id: string; object: string; created: number; owned_by: string }>;
}> {
    return await callLiteLLM('GET', '/v1/models');
}

/**
 * Liveness 检查(给 cron 监控用)
 */
export async function checkLiteLLMHealth(): Promise<{ status: string }> {
    return await callLiteLLM('GET', '/health/liveliness');
}

// ============================================
// Portal 业务封装(高层 API)
// ============================================

/**
 * Portal 高层封装:为新注册的客户做"开户 + 发首个 Key"
 *
 * 流程:
 *   1. 在 LiteLLM 创建 user
 *   2. 给该 user 生成第一个 Key(模式 X:每客户一 Key)
 *   3. 返回 { litellm_user_id, litellm_key, key_alias }
 *
 * Portal 要把这三个字段存到自己的 users + litellm_keys 表
 */
export async function provisionNewCustomer(args: {
    portal_user_id: string; // Portal 自己的 user UUID
    email: string;
    initial_max_budget?: number; // 默认 0
}): Promise<{
    litellm_user_id: string;
    litellm_key: string;
    key_alias: string;
}> {
    // 1. 创建 LiteLLM user
    const user = await createUser({
        user_email: args.email,
        user_alias: args.portal_user_id,
        user_role: 'internal_user',
    });

    // 2. 给 user 创建第一个 Key
    const keyAlias = `default-${args.portal_user_id.slice(0, 8)}`;
    const key = await generateKey({
        user_id: user.user_id,
        key_alias: keyAlias,
        max_budget: args.initial_max_budget ?? 0,
        models: [], // 所有模型
        metadata: { portal_user_id: args.portal_user_id, type: 'default' },
    });

    return {
        litellm_user_id: user.user_id,
        litellm_key: key.key,
        key_alias: keyAlias,
    };
}

/**
 * Portal 高层封装:充值入账
 *
 * 流程:
 *   1. Portal 在自己的 recharge_logs 加一条记录
 *   2. 算出该 key 的累计充值总额(SUM)
 *   3. 调 LiteLLM updateKeyBudget 把 max_budget 设为这个总值
 *
 * 调用方负责事务管理 — 这个函数只做 LiteLLM 那边的写入
 */
export async function applyRecharge(args: {
    litellm_key: string;
    new_total_max_budget: number; // 该 key 的累计充值总额(由 portal 算)
}): Promise<LiteLLMKey> {
    return await updateKeyBudget({
        key: args.litellm_key,
        max_budget: args.new_total_max_budget,
    });
}

// ============================================
// Deprecated: Sub2ApiPay legacy compatibility stubs (W1 D5, R3 decision)
// ============================================
//
// User decision R3: subscription-related UI/API routes are kept compiling
// but functionally inert until the product team revisits monthly plans.
//
// These stubs let the legacy route handlers and order/service deduction
// path keep type-checking. Returning null/[] (or throwing) at runtime
// means: the deprecated code paths gracefully degrade rather than crash
// with "function is not exported" at module load.
//
// Return types are intentionally typed as `any` so existing callers that
// destructure subscription / user shapes (.group_id, .balance, .name,
// .platform, ...) compile without forcing us to either re-derive the old
// Sub2API DTOs or annotate every call site. New code MUST NOT import any
// of these — use the typed LiteLLM Admin API helpers above instead.
//
// Removal plan: when subscription functionality is decided, delete the
// stubs and either implement real LiteLLM-backed versions or rip out the
// dependent routes entirely. Search call sites with:
//   grep -rE "(getCurrentUserByToken|getUser|getUserSubscriptions|listSubscriptions|getAllGroups|getGroup|searchUsers|createAndRedeem|subtractBalance|addBalance|extendSubscription)" src --include="*.ts" --include="*.tsx"
// ============================================

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */

/** @deprecated R3 stub — portal sessions go through src/lib/auth/session.ts now. */
export async function getCurrentUserByToken(_token: string): Promise<any> {
    return null;
}

/** @deprecated R3 stub — use prisma.user.findUnique for portal users. */
export async function getUser(_userId: string | number | null): Promise<any> {
    return null;
}

/** @deprecated R3 stub — subscription model is on hold (R3). */
export async function getUserSubscriptions(_userId: string | number | null): Promise<any[]> {
    return [];
}

/** @deprecated R3 stub — subscription model is on hold (R3). */
export async function listSubscriptions(_args?: any): Promise<any> {
    return { items: [], total: 0, page: 1, page_size: 50 };
}

/** @deprecated R3 stub — group/channel UI shows "no data" until R3 revisits. */
export async function getAllGroups(): Promise<any[]> {
    return [];
}

/** @deprecated R3 stub — group/channel UI shows "no data" until R3 revisits. */
export async function getGroup(_groupId: string | number): Promise<any> {
    return null;
}

/** @deprecated R3 stub — admin user search disabled while subscription is on hold. */
export async function searchUsers(_query: string): Promise<any[]> {
    return [];
}

/** @deprecated R3 stub — recharge flow now goes through applyRecharge / updateKeyBudget. */
export async function createAndRedeem(..._args: unknown[]): Promise<never> {
    throw new Error('createAndRedeem is deprecated — use applyRecharge in the new flow');
}

/** @deprecated R3 stub — balance manipulation belongs to the LiteLLM key, not a separate user balance. */
export async function subtractBalance(..._args: unknown[]): Promise<never> {
    throw new Error('subtractBalance is deprecated — LiteLLM tracks spend per key');
}

/** @deprecated R3 stub — balance manipulation belongs to the LiteLLM key, not a separate user balance. */
export async function addBalance(..._args: unknown[]): Promise<never> {
    throw new Error('addBalance is deprecated — use applyRecharge in the new flow');
}

/** @deprecated R3 stub — subscription extension on hold (R3). */
export async function extendSubscription(..._args: unknown[]): Promise<never> {
    throw new Error('extendSubscription is deprecated — subscriptions are on hold (R3)');
}

/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
