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
import { decryptUpstreamKey, decryptSecret } from './crypto';
import { parseVolcAuthorization, verifyVolcSignature } from './signer-v4';

export const ENTERPRISE_KEY_PREFIX = 'sk-ent-';
export const ENTERPRISE_AK_PREFIX = 'ak_ent_';

export function hashEnterpriseKey(key: string): string {
    return createHash('sha256').update(key).digest('hex');
}

/** 生成新客户 key。明文 key 只在这里出现一次,调用方展示后即弃。 */
export function generateEnterpriseKey(): { key: string; hash: string; prefix: string } {
    const key = ENTERPRISE_KEY_PREFIX + randomBytes(24).toString('hex');
    return { key, hash: hashEnterpriseKey(key), prefix: key.slice(0, 12) };
}

/** 生成新 AK/SK 对(火山签名鉴权)。SK 明文只在创建时返回一次。 */
export function generateAkSk(): { accessKey: string; secretKey: string } {
    return {
        accessKey: ENTERPRISE_AK_PREFIX + randomBytes(12).toString('hex'), // ak_ent_<24hex>
        secretKey: 'sk_ent_' + randomBytes(24).toString('hex'), // sk_ent_<48hex>
    };
}

export interface EnterpriseCustomer {
    userId: string;
    tenantId: string | null;
    keyId: string;
    /** 本 key 绑定的版本('cn' | 'global',2026-07-23)。 */
    region: string;
    /** 该客户对应版本的独立上游 key(已解密)。 */
    upstreamKey: string;
}

/** 对账器用:按 (user, region) 直取解密后的上游 key(无 sk-ent 语境)。缺行/解密失败 → null。 */
export async function getUpstreamKeyForUser(userId: string, region: string): Promise<string | null> {
    const up = await prisma.enterpriseUpstreamKey.findUnique({
        where: { user_id_region: { user_id: userId, region } },
        select: { upstream_key_enc: true },
    });
    if (!up) return null;
    try {
        return decryptUpstreamKey(up.upstream_key_enc);
    } catch (e) {
        console.error('[enterprise-keys] reconcile decrypt failed', { userId, region, err: String(e) });
        return null;
    }
}

export type ResolveResult =
    | { ok: true; customer: EnterpriseCustomer }
    | { ok: false; status: number; code: string; message: string };

/** 按 (user, region) 装载解密上游 key,拼成 EnterpriseCustomer。缺行/解密失败 → 503。
 *  sk-ent 与 AK/SK 两条鉴权路径共用(2026-07-28)。 */
async function loadUpstreamCustomer(
    userId: string,
    tenantId: string | null,
    keyId: string,
    region: string,
): Promise<ResolveResult> {
    const up = await prisma.enterpriseUpstreamKey.findUnique({
        where: { user_id_region: { user_id: userId, region } },
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
    try {
        const upstreamKey = decryptUpstreamKey(up.upstream_key_enc);
        return { ok: true, customer: { userId, tenantId, keyId, region, upstreamKey } };
    } catch (e) {
        console.error('[enterprise-keys] upstream key decrypt failed', { userId, region, err: String(e) });
        return {
            ok: false,
            status: 503,
            code: 'account_not_configured',
            message: 'upstream key unavailable, contact support',
        };
    }
}

export interface AuthRequestParts {
    authorization: string | null;
    method: string;
    path: string;
    query: URLSearchParams;
    headers: Headers;
    rawBody: string;
}

/**
 * 双通道鉴权(2026-07-28):Bearer sk-ent-… 或 火山 SignerV4 AK/SK 签名。
 * AK/SK 无版本绑定(账户级),region 由调用面决定(expectedRegion,缺省 cn)。
 * expectedRegion 只对 sk-ent 做版本门(不匹配 403);AK/SK 直接按 expectedRegion 取上游 key。
 */
export async function resolveEnterpriseAuth(parts: AuthRequestParts, expectedRegion?: string): Promise<ResolveResult> {
    const auth = parts.authorization;
    // 火山 SignerV4 AK/SK
    const parsed = parseVolcAuthorization(auth);
    if (parsed) {
        const row = await prisma.enterpriseAkSk.findUnique({
            where: { access_key: parsed.accessKey },
            select: { id: true, user_id: true, tenant_id: true, status: true, secret_key_enc: true },
        });
        if (!row || row.status !== 'active') {
            return { ok: false, status: 401, code: 'UnauthorizedOperation', message: 'invalid or inactive access key' };
        }
        let secretKey: string;
        try {
            secretKey = decryptSecret(row.secret_key_enc);
        } catch {
            return {
                ok: false,
                status: 503,
                code: 'account_not_configured',
                message: 'credential unavailable, contact support',
            };
        }
        const ok = verifyVolcSignature({
            method: parts.method,
            path: parts.path,
            query: parts.query,
            headers: parts.headers,
            rawBody: parts.rawBody,
            secretKey,
            parsed,
        });
        if (!ok) {
            return { ok: false, status: 401, code: 'UnauthorizedOperation', message: 'signature verification failed' };
        }
        prisma.enterpriseAkSk.update({ where: { id: row.id }, data: { last_used_at: new Date() } }).catch(() => {});
        return loadUpstreamCustomer(row.user_id, row.tenant_id, row.id, expectedRegion ?? 'cn');
    }
    // Bearer sk-ent
    return resolveEnterpriseCustomer(auth, expectedRegion);
}

/**
 * Bearer sk-ent-… → 客户 + 对应版本上游 key。无效/禁用 401;未配上游 key/解密失败 503。
 * expectedRegion 传入时(视频提交/轮询)校验 key 绑定版本一致,不一致 403 —— 国内/海外
 * 是单独的 key(operator 决策);不传(素材库等版本无关面)按 key 自身版本解析。
 */
export async function resolveEnterpriseCustomer(auth: string | null, expectedRegion?: string): Promise<ResolveResult> {
    const m = auth?.match(/^Bearer\s+(.+)$/i);
    const key = m?.[1]?.trim();
    if (!key || !key.startsWith(ENTERPRISE_KEY_PREFIX)) {
        return { ok: false, status: 401, code: 'invalid_api_key', message: 'invalid or inactive API key' };
    }
    const row = await prisma.enterpriseKey.findUnique({
        where: { key_hash: hashEnterpriseKey(key) },
        select: { id: true, user_id: true, tenant_id: true, status: true, region: true },
    });
    if (!row || row.status !== 'active') {
        return { ok: false, status: 401, code: 'invalid_api_key', message: 'invalid or inactive API key' };
    }
    if (expectedRegion && row.region !== expectedRegion) {
        return {
            ok: false,
            status: 403,
            code: 'region_mismatch',
            message: `this API key is bound to the ${row.region === 'global' ? 'global' : 'cn'} region; create a ${expectedRegion} key in the dashboard to call ${expectedRegion} models`,
        };
    }
    // last_used_at:best-effort,不阻塞请求
    prisma.enterpriseKey.update({ where: { id: row.id }, data: { last_used_at: new Date() } }).catch(() => {});
    return loadUpstreamCustomer(row.user_id, row.tenant_id, row.id, row.region);
}
