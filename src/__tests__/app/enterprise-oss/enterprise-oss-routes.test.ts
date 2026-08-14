/**
 * /api/enterprise/oss CRUD + test-connection 单测(2026-08-14)。
 * = 主站 /api/portal/oss 的企业版,鉴权走 requireEnterpriseUser。
 * Mock 鉴权 / store / testOssConnection;encryption 真实(env key 注入),覆盖 PUT 加密落库。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockRequireEnterpriseUser = vi.fn();
vi.mock('@/lib/enterprise/session', () => ({
    requireEnterpriseUser: (...args: unknown[]) => mockRequireEnterpriseUser(...args),
}));

const mockTestOssConnection = vi.fn();
vi.mock('@/lib/oss/client', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/lib/oss/client')>();
    return { ...original, testOssConnection: (...args: unknown[]) => mockTestOssConnection(...args) };
});

const mockGetOssConfig = vi.fn();
const mockUpsertOssConfig = vi.fn();
const mockDeleteOssConfig = vi.fn();
vi.mock('@/lib/oss/store', () => ({
    getOssConfig: (...args: unknown[]) => mockGetOssConfig(...args),
    upsertOssConfig: (...args: unknown[]) => mockUpsertOssConfig(...args),
    deleteOssConfig: (...args: unknown[]) => mockDeleteOssConfig(...args),
}));

import { DELETE, GET, PUT } from '@/app/api/enterprise/oss/route';
import { POST as TEST_CONNECTION } from '@/app/api/enterprise/oss/test-connection/route';
import { decryptSecret } from '@/lib/oss/encryption';

const USER = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', email: 'ent@test.io' };
const VALID_BODY = {
    provider: 'r2',
    endpoint: 'https://acct.r2.cloudflarestorage.com',
    bucket: 'my-bucket',
    region: null,
    access_key_id: 'AKID1234567890',
    secret_access_key: 'super-secret-value',
    public_url_prefix: 'https://cdn.customer.com',
};

function req(method: string, body?: unknown): NextRequest {
    return new NextRequest('http://internal/api/enterprise/oss', {
        method,
        headers: { 'content-type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    process.env.PORTAL_OSS_ENC_KEY = 'a'.repeat(64);
    mockRequireEnterpriseUser.mockResolvedValue(USER);
    mockTestOssConnection.mockResolvedValue({ ok: true });
    mockGetOssConfig.mockResolvedValue(null);
    mockUpsertOssConfig.mockResolvedValue({ status: 'active' });
    mockDeleteOssConfig.mockResolvedValue({ count: 1 });
});

describe('/api/enterprise/oss 鉴权', () => {
    it('非企业客户 / 未登录 → 401(全部 method)', async () => {
        mockRequireEnterpriseUser.mockResolvedValue(null);
        expect((await GET(req('GET'))).status).toBe(401);
        expect((await PUT(req('PUT', VALID_BODY))).status).toBe(401);
        expect((await DELETE(req('DELETE'))).status).toBe(401);
        expect((await TEST_CONNECTION(req('POST', VALID_BODY))).status).toBe(401);
        expect(mockUpsertOssConfig).not.toHaveBeenCalled();
    });
});

describe('GET /api/enterprise/oss', () => {
    it('无配置 → { config: null }', async () => {
        const res = await GET(req('GET'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ config: null });
    });
    it('有配置 → 返 mask 后的 access_key,不返 secret', async () => {
        mockGetOssConfig.mockResolvedValue({
            provider: 'r2',
            endpoint: 'https://e',
            bucket: 'b',
            region: null,
            access_key_id: 'AKID1234567890',
            secret_access_key_encrypted: 'ENC',
            public_url_prefix: 'https://cdn.customer.com',
            cdn_enabled: false,
            status: 'active',
            last_test_at: null,
            last_test_message: null,
        });
        const res = await GET(req('GET'));
        const j = (await res.json()) as { config: Record<string, unknown> };
        expect(j.config.access_key_id_masked).toBe('AKID****7890');
        expect(JSON.stringify(j)).not.toContain('ENC');
        expect(JSON.stringify(j)).not.toContain('secret');
    });
});

describe('PUT /api/enterprise/oss', () => {
    it('校验通过 + 连接测试通过 → 加密落库(secret 可 roundtrip 解回)', async () => {
        const res = await PUT(req('PUT', VALID_BODY));
        expect(res.status).toBe(200);
        expect(mockUpsertOssConfig).toHaveBeenCalledWith(USER.id, expect.objectContaining({ status: 'active' }));
        const encrypted = mockUpsertOssConfig.mock.calls[0][1].secret_access_key_encrypted as string;
        expect(decryptSecret(encrypted)).toBe('super-secret-value');
    });
    it('连接测试失败 → 422,不落库', async () => {
        mockTestOssConnection.mockResolvedValue({ ok: false, message: 'AccessDenied' });
        const res = await PUT(req('PUT', VALID_BODY));
        expect(res.status).toBe(422);
        expect(mockUpsertOssConfig).not.toHaveBeenCalled();
    });
    it('schema 非法 → 400', async () => {
        const res = await PUT(req('PUT', { provider: 'nope' }));
        expect(res.status).toBe(400);
        expect(mockUpsertOssConfig).not.toHaveBeenCalled();
    });
});

describe('DELETE /api/enterprise/oss', () => {
    it('清除配置 → { ok: true }', async () => {
        const res = await DELETE(req('DELETE'));
        expect(res.status).toBe(200);
        expect(mockDeleteOssConfig).toHaveBeenCalledWith(USER.id);
    });
});

describe('POST /api/enterprise/oss/test-connection', () => {
    it('put+delete 临时对象 → { ok: true }', async () => {
        const res = await TEST_CONNECTION(req('POST', VALID_BODY));
        expect(res.status).toBe(200);
        expect((await res.json()).ok).toBe(true);
    });
});
