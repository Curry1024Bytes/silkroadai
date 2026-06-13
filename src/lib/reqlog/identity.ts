/**
 * 请求日志身份解析(数据存储 Phase 1 第②步)。
 *
 * 从 proxy 的 Authorization 头反查记日志要用的身份四元组,**一次 select**
 * 拿全(避免在热路径多次查 DB)。镜像 `src/lib/oss/store.ts` 的
 * `resolveUserIdFromAuthHeader`,但:
 *   - 多取 `token_id`(NewApiToken.id)和 `tenant_id`(经 user 关联,
 *     NewApiToken 本身无此列);
 *   - **best-effort、永不抛**:DB 故障 / token 不在库 / 无头 → 各 id 留 null,
 *     但 `newapi_token_hash`(sha256,无需 DB)只要有 token 就算出来,日志层
 *     事后仍可按 hash 反查归属(brief §8 硬要求:解析失败也不丢日志)。
 *
 * 这与 oss/store 的"重试一次后抛给调用方"语义【不同】—— 那条是出图存储,
 * 解析失败要让客户可检测(回落响应头);日志捕获是纯旁路观测,任何失败都
 * 不该冒泡,吞掉 + 留 hash 即可。
 */
import 'server-only';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/db';

export interface LogIdentity {
    user_id: string | null;
    token_id: string | null;
    tenant_id: string | null;
    newapi_token_hash: string | null;
}

const EMPTY: LogIdentity = { user_id: null, token_id: null, tenant_id: null, newapi_token_hash: null };

/** `Bearer sk-<48>` → 去 `Bearer ` 去 `sk-` 的裸 48 字符(DB 存的形态);
 *  形状不对 / 空 → null。 */
function extractRawToken(authHeader: string | null): string | null {
    const m = authHeader?.match(/^Bearer\s+(.+)$/i);
    if (!m) return null;
    const raw = m[1].startsWith('sk-') ? m[1].slice(3) : m[1];
    return raw || null;
}

export function hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
}

/**
 * 解析记日志身份。永不抛。
 * - 客户 token(NewApiToken.newapi_token_value)命中 → user_id + token_id + tenant_id(关联 user)
 * - 系统 token(User.newapi_system_token_value)命中 → user_id + tenant_id(token_id null)
 * - 都没命中 / DB 故障 / 无头 → id 全 null;有 token 就带 hash
 */
export async function resolveLogIdentity(authHeader: string | null): Promise<LogIdentity> {
    const raw = extractRawToken(authHeader);
    if (!raw) return { ...EMPTY };
    const newapi_token_hash = hashToken(raw);
    try {
        const token = await prisma.newApiToken.findUnique({
            where: { newapi_token_value: raw },
            select: { id: true, user_id: true, user: { select: { tenant_id: true } } },
        });
        if (token) {
            return {
                user_id: token.user_id,
                token_id: token.id,
                tenant_id: token.user?.tenant_id ?? null,
                newapi_token_hash,
            };
        }
        const sys = await prisma.user.findFirst({
            where: { newapi_system_token_value: raw },
            select: { id: true, tenant_id: true },
        });
        if (sys) {
            return { user_id: sys.id, token_id: null, tenant_id: sys.tenant_id ?? null, newapi_token_hash };
        }
        return { ...EMPTY, newapi_token_hash };
    } catch (e) {
        // best-effort:DB 故障不冒泡,留 hash 供事后反查(brief §8)
        console.warn('[reqlog] identity resolve failed (keeping token hash)', e);
        return { ...EMPTY, newapi_token_hash };
    }
}
