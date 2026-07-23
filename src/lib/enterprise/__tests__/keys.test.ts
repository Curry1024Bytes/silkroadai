/**
 * 独立门户 sk-ent- key 体系单测:生成格式 / 鉴权解析各分支(401/503/happy)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, decryptUpstreamKey } = vi.hoisted(() => ({
    db: {
        enterpriseKey: { findUnique: vi.fn(), update: vi.fn() },
        enterpriseUpstreamKey: { findUnique: vi.fn() },
    },
    decryptUpstreamKey: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('../crypto', () => ({ decryptUpstreamKey }));

import { generateEnterpriseKey, hashEnterpriseKey, resolveEnterpriseCustomer } from '../keys';

beforeEach(() => {
    vi.clearAllMocks();
    db.enterpriseKey.update.mockResolvedValue({});
});

describe('generateEnterpriseKey', () => {
    it('sk-ent- 前缀 + 48 hex;hash = sha256(完整 key);prefix = 前 12 字符', () => {
        const g = generateEnterpriseKey();
        expect(g.key).toMatch(/^sk-ent-[0-9a-f]{48}$/);
        expect(g.hash).toBe(hashEnterpriseKey(g.key));
        expect(g.hash).toMatch(/^[0-9a-f]{64}$/);
        expect(g.prefix).toBe(g.key.slice(0, 12));
    });

    it('两次生成不同 key', () => {
        expect(generateEnterpriseKey().key).not.toBe(generateEnterpriseKey().key);
    });
});

describe('resolveEnterpriseCustomer', () => {
    const activeRow = { id: 'k1', user_id: 'u1', tenant_id: null, status: 'active', region: 'cn' };

    it('无 auth / 非 Bearer / 非 sk-ent- 前缀 → 401,不打 DB', async () => {
        for (const auth of [null, '', 'Bearer sk-abc123', 'Basic zzz']) {
            const r = await resolveEnterpriseCustomer(auth);
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.status).toBe(401);
        }
        expect(db.enterpriseKey.findUnique).not.toHaveBeenCalled();
    });

    it('hash 未命中 → 401', async () => {
        db.enterpriseKey.findUnique.mockResolvedValue(null);
        const r = await resolveEnterpriseCustomer('Bearer sk-ent-' + 'a'.repeat(48));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('invalid_api_key');
    });

    it('key 已禁用 → 401', async () => {
        db.enterpriseKey.findUnique.mockResolvedValue({ ...activeRow, status: 'disabled' });
        const r = await resolveEnterpriseCustomer('Bearer sk-ent-' + 'a'.repeat(48));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.status).toBe(401);
    });

    it('客户未配上游 key → 503 account_not_configured', async () => {
        db.enterpriseKey.findUnique.mockResolvedValue(activeRow);
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue(null);
        const r = await resolveEnterpriseCustomer('Bearer sk-ent-' + 'a'.repeat(48));
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.status).toBe(503);
            expect(r.code).toBe('account_not_configured');
        }
    });

    it('解密失败 → 503(配置态,非客户错)', async () => {
        db.enterpriseKey.findUnique.mockResolvedValue(activeRow);
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue({ upstream_key_enc: 'broken' });
        decryptUpstreamKey.mockImplementation(() => {
            throw new Error('bad ciphertext');
        });
        const r = await resolveEnterpriseCustomer('Bearer sk-ent-' + 'a'.repeat(48));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.status).toBe(503);
    });

    it('happy path:按 sha256(key) 查行,解密上游 key,返客户;last_used_at best-effort 更新', async () => {
        const key = 'sk-ent-' + 'b'.repeat(48);
        db.enterpriseKey.findUnique.mockResolvedValue(activeRow);
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue({ upstream_key_enc: 'enc-blob' });
        decryptUpstreamKey.mockReturnValue('sk-upstream-real');
        const r = await resolveEnterpriseCustomer(`Bearer ${key}`);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.customer).toEqual({
                userId: 'u1',
                tenantId: null,
                keyId: 'k1',
                region: 'cn',
                upstreamKey: 'sk-upstream-real',
            });
        }
        expect(db.enterpriseKey.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { key_hash: hashEnterpriseKey(key) } }),
        );
        expect(decryptUpstreamKey).toHaveBeenCalledWith('enc-blob');
        expect(db.enterpriseKey.update).toHaveBeenCalled();
    });

    it('last_used_at 更新失败不影响鉴权结果', async () => {
        db.enterpriseKey.findUnique.mockResolvedValue(activeRow);
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue({ upstream_key_enc: 'enc' });
        decryptUpstreamKey.mockReturnValue('up');
        db.enterpriseKey.update.mockRejectedValue(new Error('db down'));
        const r = await resolveEnterpriseCustomer('Bearer sk-ent-' + 'c'.repeat(48));
        expect(r.ok).toBe(true);
    });
});

describe('resolveEnterpriseCustomer — 版本门(2026-07-23 海外版)', () => {
    const cnRow = { id: 'k1', user_id: 'u1', tenant_id: null, status: 'active', region: 'cn' };
    const globalRow = { ...cnRow, id: 'k2', region: 'global' };

    it('expectedRegion 与 key 版本不符 → 403 region_mismatch,不查上游 key', async () => {
        db.enterpriseKey.findUnique.mockResolvedValue(cnRow);
        const r = await resolveEnterpriseCustomer('Bearer sk-ent-' + 'a'.repeat(48), 'global');
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.status).toBe(403);
            expect(r.code).toBe('region_mismatch');
        }
        expect(db.enterpriseUpstreamKey.findUnique).not.toHaveBeenCalled();
    });

    it('global key + expectedRegion global → 按 (user, global) 行取上游 key', async () => {
        db.enterpriseKey.findUnique.mockResolvedValue(globalRow);
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue({ upstream_key_enc: 'enc' });
        decryptUpstreamKey.mockReturnValue('sk-intl-upstream');
        const r = await resolveEnterpriseCustomer('Bearer sk-ent-' + 'a'.repeat(48), 'global');
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.customer.region).toBe('global');
            expect(r.customer.upstreamKey).toBe('sk-intl-upstream');
        }
        expect(db.enterpriseUpstreamKey.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { user_id_region: { user_id: 'u1', region: 'global' } } }),
        );
    });

    it('不传 expectedRegion(素材库等版本无关面)→ 任意版本 key 放行,按 key 自身版本解析', async () => {
        db.enterpriseKey.findUnique.mockResolvedValue(globalRow);
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue({ upstream_key_enc: 'enc' });
        decryptUpstreamKey.mockReturnValue('sk-intl-upstream');
        const r = await resolveEnterpriseCustomer('Bearer sk-ent-' + 'a'.repeat(48));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.customer.region).toBe('global');
    });
});
