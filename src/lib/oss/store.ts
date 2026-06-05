/**
 * UserOssConfig 的 DB 访问层(W9 D3 PR-C)。
 *
 * ⚠️ prisma client 类型 shim:本文件用一个最小 delegate 接口 cast
 * `prisma`,因为本 PR 新增的 `UserOssConfig` model 在某些环境(老的
 * 生成产物)里还没出现在 `PrismaClient` 类型上。`pnpm prisma generate`
 * 后 cast 依然正确(结构兼容),不影响运行时。集中在本文件一处,
 * 业务代码(API routes / proxy)只 import 这里的函数。
 */
import 'server-only';
import { prisma } from '@/lib/db';

export interface UserOssConfigRow {
    id: string;
    user_id: string;
    provider: string;
    endpoint: string | null;
    bucket: string;
    region: string | null;
    access_key_id: string;
    secret_access_key_encrypted: string;
    public_url_prefix: string;
    cdn_enabled: boolean;
    status: string;
    last_test_at: Date | null;
    last_test_message: string | null;
    created_at: Date;
    updated_at: Date;
}

export interface UserOssConfigWrite {
    provider: string;
    endpoint: string | null;
    bucket: string;
    region: string | null;
    access_key_id: string;
    secret_access_key_encrypted: string;
    public_url_prefix: string;
    cdn_enabled: boolean;
    status: string;
    last_test_at: Date | null;
    last_test_message: string | null;
}

interface UserOssConfigDelegate {
    findUnique(args: { where: { user_id: string } }): Promise<UserOssConfigRow | null>;
    upsert(args: {
        where: { user_id: string };
        create: UserOssConfigWrite & { user_id: string };
        update: UserOssConfigWrite;
    }): Promise<UserOssConfigRow>;
    delete(args: { where: { user_id: string } }): Promise<UserOssConfigRow>;
    deleteMany(args: { where: { user_id: string } }): Promise<{ count: number }>;
}

function delegate(): UserOssConfigDelegate {
    return (prisma as unknown as { userOssConfig: UserOssConfigDelegate }).userOssConfig;
}

export function getOssConfig(userId: string): Promise<UserOssConfigRow | null> {
    return delegate().findUnique({ where: { user_id: userId } });
}

export function upsertOssConfig(userId: string, data: UserOssConfigWrite): Promise<UserOssConfigRow> {
    return delegate().upsert({
        where: { user_id: userId },
        create: { ...data, user_id: userId },
        update: data,
    });
}

/** 清除配置(回平台默认 R2)。幂等 — 没配置也返回 count 0 不 throw。 */
export function deleteOssConfig(userId: string): Promise<{ count: number }> {
    return delegate().deleteMany({ where: { user_id: userId } });
}

/**
 * 从 proxy 的 Authorization header 反查 portal user id。
 *
 * - `Bearer sk-<48chars>` → 去前缀(DB 存的是无 sk- 的 48 字符,见
 *   src/lib/newapi/token-format.ts)→ 查 NewApiToken.newapi_token_value
 * - 查不到再试 User.newapi_system_token_value(portal-internal token,
 *   image-gen 等内部服务在用 — 它们的生图也应该尊重客户 OSS 配置)
 * - 任何失败返回 null(proxy 回退平台 R2,绝不 throw 阻断客户请求)
 */
export async function resolveUserIdFromAuthHeader(authHeader: string | null): Promise<string | null> {
    try {
        const m = authHeader?.match(/^Bearer\s+(.+)$/i);
        if (!m) return null;
        const raw = m[1].startsWith('sk-') ? m[1].slice(3) : m[1];
        if (!raw) return null;
        const token = await prisma.newApiToken.findUnique({
            where: { newapi_token_value: raw },
            select: { user_id: true },
        });
        if (token) return token.user_id;
        const sys = await prisma.user.findFirst({
            where: { newapi_system_token_value: raw },
            select: { id: true },
        });
        return sys?.id ?? null;
    } catch {
        return null;
    }
}
