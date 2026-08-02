/** resolveEnterpriseAuth 双通道单测(2026-07-28):Bearer sk-ent 委托 / AK/SK 验签路径。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, decryptUpstreamKey, decryptSecret, parseVolcAuthorization, verifyVolcSignature } = vi.hoisted(() => ({
    db: {
        enterpriseKey: { findUnique: vi.fn(), update: vi.fn() },
        enterpriseAkSk: { findUnique: vi.fn(), update: vi.fn() },
        enterpriseUpstreamKey: { findUnique: vi.fn() },
    },
    decryptUpstreamKey: vi.fn(),
    decryptSecret: vi.fn(),
    parseVolcAuthorization: vi.fn(),
    verifyVolcSignature: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('../crypto', () => ({ decryptUpstreamKey, decryptSecret }));
vi.mock('../signer-v4', () => ({ parseVolcAuthorization, verifyVolcSignature }));

import { resolveEnterpriseAuth } from '../keys';

function parts(auth: string | null) {
    return {
        authorization: auth,
        method: 'POST',
        path: '/api',
        query: new URLSearchParams('Action=CreateAsset'),
        headers: new Headers({ 'x-date': '20260728T142833Z' }),
        rawBody: '{}',
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    db.enterpriseKey.update.mockResolvedValue({});
    db.enterpriseAkSk.update.mockResolvedValue({});
    db.enterpriseUpstreamKey.findUnique.mockResolvedValue({ upstream_key_enc: 'enc' });
    decryptUpstreamKey.mockReturnValue('sk-upstream');
    decryptSecret.mockReturnValue('sk_ent_secret');
    parseVolcAuthorization.mockReturnValue(null); // 默认非火山头
});

describe('AK/SK 火山签名路径', () => {
    const PARSED = {
        accessKey: 'ak_ent_x',
        shortDate: '20260728',
        region: 'cn-beijing',
        service: 'ark',
        signedHeaders: ['host', 'x-content-sha256', 'x-date'],
        signature: 'abc',
    };

    it('签名有效 + 无 expectedRegion(/api 账号级)→ 身份直返,不绑/不查任何 region 上游 key', async () => {
        parseVolcAuthorization.mockReturnValue(PARSED);
        db.enterpriseAkSk.findUnique.mockResolvedValue({
            id: 'ak1',
            user_id: 'u1',
            tenant_id: null,
            status: 'active',
            secret_key_enc: 'enc-sk',
        });
        verifyVolcSignature.mockReturnValue(true);
        const r = await resolveEnterpriseAuth(parts('HMAC-SHA256 Credential=...'));
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.customer.userId).toBe('u1');
            expect(r.customer.keyId).toBe('ak1');
            expect(r.customer.upstreamKey).toBe(''); // /api 不消费上游 key
        }
        // 关键:纯火山客户没开 cn 也能用真人认证/素材库 —— 不查 region 上游 key
        expect(db.enterpriseUpstreamKey.findUnique).not.toHaveBeenCalled();
    });

    it('AK 未命中/禁用 → 401 UnauthorizedOperation,不验签', async () => {
        parseVolcAuthorization.mockReturnValue(PARSED);
        db.enterpriseAkSk.findUnique.mockResolvedValue(null);
        const r = await resolveEnterpriseAuth(parts('HMAC-SHA256 ...'));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.status).toBe(401);
        expect(verifyVolcSignature).not.toHaveBeenCalled();
    });

    it('签名验证失败 → 401 UnauthorizedOperation,不装载上游', async () => {
        parseVolcAuthorization.mockReturnValue(PARSED);
        db.enterpriseAkSk.findUnique.mockResolvedValue({
            id: 'ak1',
            user_id: 'u1',
            tenant_id: null,
            status: 'active',
            secret_key_enc: 'enc-sk',
        });
        verifyVolcSignature.mockReturnValue(false);
        const r = await resolveEnterpriseAuth(parts('HMAC-SHA256 ...'));
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.status).toBe(401);
            expect(r.code).toBe('UnauthorizedOperation');
        }
        expect(db.enterpriseUpstreamKey.findUnique).not.toHaveBeenCalled();
    });

    it('expectedRegion 传入 → AK/SK 按该 region 取上游 key(账户级无版本门)', async () => {
        parseVolcAuthorization.mockReturnValue(PARSED);
        db.enterpriseAkSk.findUnique.mockResolvedValue({
            id: 'ak1',
            user_id: 'u1',
            tenant_id: null,
            status: 'active',
            secret_key_enc: 'enc-sk',
        });
        verifyVolcSignature.mockReturnValue(true);
        const r = await resolveEnterpriseAuth(parts('HMAC-SHA256 ...'), 'global');
        expect(r.ok).toBe(true);
        expect(db.enterpriseUpstreamKey.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { user_id_region: { user_id: 'u1', region: 'global' } } }),
        );
    });
});

describe('Bearer sk_ent_(SK 直接当 API key,2026-07-30)', () => {
    const SK = 'sk_ent_' + 'b'.repeat(48);

    it('有效 SK + 无 expectedRegion(/api 账号级)→ 身份直返,按 hash 查、不解密不验签', async () => {
        parseVolcAuthorization.mockReturnValue(null);
        db.enterpriseAkSk.findUnique.mockResolvedValue({ id: 'ak1', user_id: 'u1', tenant_id: null, status: 'active' });
        const r = await resolveEnterpriseAuth(parts(`Bearer ${SK}`));
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.customer.userId).toBe('u1');
            expect(r.customer.accountLevel).toBe(true);
            expect(r.customer.upstreamKey).toBe('');
        }
        // 按 sha256(SK) 查 secret_key_hash,全程不碰解密/验签
        const where = db.enterpriseAkSk.findUnique.mock.calls[0][0].where;
        expect(where.secret_key_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(decryptSecret).not.toHaveBeenCalled();
        expect(verifyVolcSignature).not.toHaveBeenCalled();
        expect(db.enterpriseUpstreamKey.findUnique).not.toHaveBeenCalled();
        // 不落到 sk-ent 表
        expect(db.enterpriseKey.findUnique).not.toHaveBeenCalled();
    });

    it('SK 未命中 / 禁用 → 401', async () => {
        parseVolcAuthorization.mockReturnValue(null);
        db.enterpriseAkSk.findUnique.mockResolvedValue(null);
        const r1 = await resolveEnterpriseAuth(parts(`Bearer ${SK}`));
        expect(r1.ok).toBe(false);
        if (!r1.ok) expect(r1.status).toBe(401);
        db.enterpriseAkSk.findUnique.mockResolvedValue({
            id: 'ak1',
            user_id: 'u1',
            tenant_id: null,
            status: 'disabled',
        });
        const r2 = await resolveEnterpriseAuth(parts(`Bearer ${SK}`));
        expect(r2.ok).toBe(false);
        if (!r2.ok) expect(r2.code).toBe('UnauthorizedOperation');
    });

    it('expectedRegion 传入(视频)→ 按该 region 取上游 key + accountLevel(同 AK/SK 语义)', async () => {
        parseVolcAuthorization.mockReturnValue(null);
        db.enterpriseAkSk.findUnique.mockResolvedValue({ id: 'ak1', user_id: 'u1', tenant_id: null, status: 'active' });
        const r = await resolveEnterpriseAuth(parts(`Bearer ${SK}`), 'volc');
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.customer.accountLevel).toBe(true);
        expect(db.enterpriseUpstreamKey.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { user_id_region: { user_id: 'u1', region: 'volc' } } }),
        );
    });
});

describe('Bearer sk-ent 路径(委托 resolveEnterpriseCustomer)', () => {
    it('parseVolc 返 null → 走 sk-ent;有效 key → 客户', async () => {
        parseVolcAuthorization.mockReturnValue(null);
        db.enterpriseKey.findUnique.mockResolvedValue({
            id: 'k1',
            user_id: 'u1',
            tenant_id: null,
            status: 'active',
            region: 'cn',
        });
        const key = 'sk-ent-' + 'a'.repeat(48);
        const r = await resolveEnterpriseAuth(parts(`Bearer ${key}`));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.customer.region).toBe('cn');
    });

    it('无 auth → 401', async () => {
        parseVolcAuthorization.mockReturnValue(null);
        const r = await resolveEnterpriseAuth(parts(null));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.status).toBe(401);
    });
});
