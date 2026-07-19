/**
 * 独立门户自发 key 体系(P1,决策①):sk-ent-<48hex>,DB 只存 sha256(比主站
 * NewApiToken 存明文更严 —— 新体系无历史包袱)。明文只在创建时返回一次。
 *
 * 鉴权路径:Bearer sk-ent-… → sha256 → enterprise_keys → user + status 门 →
 * enterprise_upstream_keys 解密出该客户独立上游 key。全程不碰 new-api。
 */
import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { decryptUpstreamKey } from './crypto';

export const ENTERPRISE_KEY_PREFIX = 'sk-ent-';

export function hashEnterpriseKey(key: string): string {
    return createHash('sha256').update(key).digest('hex');
}

/** 生成新客户 key。明文 key 只在这里出现一次,调用方展示后即弃。 */
export function generateEnterpriseKey(): { key: string; hash: string; prefix: string } {
    const key = ENTERPRISE_KEY_PREFIX + randomBytes(24).toString('hex');
    return { key, hash: hashEnterpriseKey(key), prefix: key.slice(0, 12) };
}

export interface EnterpriseCustomer {
    userId: string;
    tenantId: string | null;
    keyId: string;
    /** 该客户的独立上游 key(已解密)。 */
    upstreamKey: string;
}

export type ResolveResult =
    | { ok: true; customer: EnterpriseCustomer }
    | { ok: false; status: number; code: string; message: string };

/** Bearer sk-ent-… → 客户 + 独立上游 key。无效/禁用 401;未配上游 key/解密失败 503(配置态问题,非客户错)。 */
export async function resolveEnterpriseCustomer(auth: string | null): Promise<ResolveResult> {
    const m = auth?.match(/^Bearer\s+(.+)$/i);
    const key = m?.[1]?.trim();
    if (!key || !key.startsWith(ENTERPRISE_KEY_PREFIX)) {
        return { ok: false, status: 401, code: 'invalid_api_key', message: 'invalid or inactive API key' };
    }
    const row = await prisma.enterpriseKey.findUnique({
        where: { key_hash: hashEnterpriseKey(key) },
        select: { id: true, user_id: true, tenant_id: true, status: true },
    });
    if (!row || row.status !== 'active') {
        return { ok: false, status: 401, code: 'invalid_api_key', message: 'invalid or inactive API key' };
    }
    const up = await prisma.enterpriseUpstreamKey.findUnique({
        where: { user_id: row.user_id },
        select: { upstream_key_enc: true },
    });
    if (!up) {
        return {
            ok: false,
            status: 503,
            code: 'account_not_configured',
            message: 'no upstream key configured for this account, contact support',
        };
    }
    let upstreamKey: string;
    try {
        upstreamKey = decryptUpstreamKey(up.upstream_key_enc);
    } catch (e) {
        console.error('[enterprise-keys] upstream key decrypt failed', { userId: row.user_id, err: String(e) });
        return {
            ok: false,
            status: 503,
            code: 'account_not_configured',
            message: 'upstream key unavailable, contact support',
        };
    }
    // last_used_at:best-effort,不阻塞请求
    prisma.enterpriseKey.update({ where: { id: row.id }, data: { last_used_at: new Date() } }).catch(() => {});
    return {
        ok: true,
        customer: { userId: row.user_id, tenantId: row.tenant_id, keyId: row.id, upstreamKey },
    };
}
