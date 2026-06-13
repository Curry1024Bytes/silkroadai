/**
 * 数据存储 Phase 1 第②步 — 身份解析单测。
 *
 * mock prisma(@/lib/db),锁住:
 *   - 客户 token 命中 → user_id + token_id + tenant_id(经 user 关联)
 *   - 系统 token 命中 → user_id + tenant_id(token_id null)
 *   - 查无 / 无头 / 形状不对 → id 全 null
 *   - DB 抛错 → best-effort:id 全 null 但带 token hash(永不冒泡)
 *   - sk- 前缀剥离 + sha256 hash 正确
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockTokenFindUnique = vi.fn();
const mockUserFindFirst = vi.fn();

vi.mock('@/lib/db', () => ({
    prisma: {
        newApiToken: { findUnique: (a: unknown) => mockTokenFindUnique(a) },
        user: { findFirst: (a: unknown) => mockUserFindFirst(a) },
    },
}));

import { resolveLogIdentity, hashToken } from '@/lib/reqlog/identity';

beforeEach(() => {
    vi.clearAllMocks();
    mockTokenFindUnique.mockResolvedValue(null);
    mockUserFindFirst.mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('hashToken', () => {
    it('= sha256 hex of the raw value', () => {
        expect(hashToken('abc')).toBe(sha('abc'));
    });
});

describe('resolveLogIdentity', () => {
    it('customer token hit → user_id + token_id + tenant_id (via user) + hash', async () => {
        mockTokenFindUnique.mockResolvedValueOnce({
            id: 'tok-uuid',
            user_id: 'user-uuid',
            user: { tenant_id: 'tenant-uuid' },
        });
        const id = await resolveLogIdentity('Bearer sk-RAW48');
        expect(id).toEqual({
            user_id: 'user-uuid',
            token_id: 'tok-uuid',
            tenant_id: 'tenant-uuid',
            newapi_token_hash: sha('RAW48'),
        });
        // 查询用的是去 sk- 的裸值
        expect(mockTokenFindUnique).toHaveBeenCalledWith({
            where: { newapi_token_value: 'RAW48' },
            select: { id: true, user_id: true, user: { select: { tenant_id: true } } },
        });
        // 命中客户 token 不再查 system token
        expect(mockUserFindFirst).not.toHaveBeenCalled();
    });

    it('customer token with null tenant on user → tenant_id null', async () => {
        mockTokenFindUnique.mockResolvedValueOnce({ id: 't', user_id: 'u', user: { tenant_id: null } });
        const id = await resolveLogIdentity('Bearer sk-X');
        expect(id.tenant_id).toBeNull();
        expect(id.token_id).toBe('t');
    });

    it('system token hit → user_id + tenant_id, token_id null', async () => {
        mockUserFindFirst.mockResolvedValueOnce({ id: 'sys-user', tenant_id: 'tenant-2' });
        const id = await resolveLogIdentity('Bearer sk-SYS');
        expect(id).toEqual({
            user_id: 'sys-user',
            token_id: null,
            tenant_id: 'tenant-2',
            newapi_token_hash: sha('SYS'),
        });
    });

    it('unknown token → all ids null but hash present', async () => {
        const id = await resolveLogIdentity('Bearer sk-NOPE');
        expect(id).toEqual({
            user_id: null,
            token_id: null,
            tenant_id: null,
            newapi_token_hash: sha('NOPE'),
        });
    });

    it('no Authorization header → all null incl hash', async () => {
        expect(await resolveLogIdentity(null)).toEqual({
            user_id: null,
            token_id: null,
            tenant_id: null,
            newapi_token_hash: null,
        });
        expect(mockTokenFindUnique).not.toHaveBeenCalled();
    });

    it('malformed header (not Bearer) → all null, no DB call', async () => {
        expect((await resolveLogIdentity('Basic xyz')).newapi_token_hash).toBeNull();
        expect(mockTokenFindUnique).not.toHaveBeenCalled();
    });

    it('accepts a raw token without sk- prefix (hashes/queries as-is)', async () => {
        await resolveLogIdentity('Bearer RAWNOPREFIX');
        expect(mockTokenFindUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { newapi_token_value: 'RAWNOPREFIX' } }),
        );
    });

    it('DB throw → best-effort: ids null + hash kept, never rejects', async () => {
        mockTokenFindUnique.mockRejectedValueOnce(new Error('pool exhausted'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const id = await resolveLogIdentity('Bearer sk-BOOM');
        expect(id).toEqual({
            user_id: null,
            token_id: null,
            tenant_id: null,
            newapi_token_hash: sha('BOOM'),
        });
        expect(warn).toHaveBeenCalled();
    });
});
