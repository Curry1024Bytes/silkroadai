/**
 * W9 D3 PR-C — /api/portal/oss CRUD + test-connection 单测(brief test 20)。
 *
 * Mock getCurrentUser / oss store / testOssConnection;encryption 用真实现
 * (env key 在 beforeEach 注入),顺带覆盖 PUT 的加密落库路径。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
}));

const mockTestOssConnection = vi.fn();
vi.mock('@/lib/oss/client', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/lib/oss/client')>();
    return {
        ...original,
        testOssConnection: (...args: unknown[]) => mockTestOssConnection(...args),
        uploadToCustomerOss: vi.fn(),
    };
});

const mockGetOssConfig = vi.fn();
const mockUpsertOssConfig = vi.fn();
const mockDeleteOssConfig = vi.fn();
vi.mock('@/lib/oss/store', () => ({
    getOssConfig: (...args: unknown[]) => mockGetOssConfig(...args),
    upsertOssConfig: (...args: unknown[]) => mockUpsertOssConfig(...args),
    deleteOssConfig: (...args: unknown[]) => mockDeleteOssConfig(...args),
    resolveUserIdFromAuthHeader: vi.fn(),
}));

import { DELETE, GET, PUT } from '@/app/api/portal/oss/route';
import { POST as TEST_CONNECTION } from '@/app/api/portal/oss/test-connection/route';
import { decryptSecret } from '@/lib/oss/encryption';

const USER = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', email: 'oss@test.io' };

const VALID_BODY = {
    provider: 'r2',
    endpoint: 'https://acct.r2.cloudflarestorage.com',
    bucket: 'my-bucket',
    region: null,
    access_key_id: 'AKID1234567890',
    secret_access_key: 'super-secret-value',
    public_url_prefix: 'https://images.example.com',
};

function req(method: string, body?: unknown): NextRequest {
    return new NextRequest('http://internal/api/portal/oss', {
        method,
        headers: { 'content-type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    process.env.PORTAL_OSS_ENC_KEY = 'f'.repeat(64);
    mockGetCurrentUser.mockResolvedValue(USER);
});

describe('GET /api/portal/oss', () => {
    it('401 without session', async () => {
        mockGetCurrentUser.mockResolvedValue(null);
        const res = await GET(req('GET'));
        expect(res.status).toBe(401);
    });

    it('returns null config when none saved', async () => {
        mockGetOssConfig.mockResolvedValue(null);
        const res = await GET(req('GET'));
        expect(await res.json()).toEqual({ config: null });
    });

    it('returns config with masked AK and NO secret', async () => {
        mockGetOssConfig.mockResolvedValue({
            provider: 'r2',
            endpoint: 'https://e',
            bucket: 'b',
            region: null,
            access_key_id: 'AKID1234567890',
            secret_access_key_encrypted: 'ENCRYPTED-BLOB',
            public_url_prefix: 'https://p',
            cdn_enabled: false,
            status: 'active',
            last_test_at: null,
            last_test_message: null,
        });
        const res = await GET(req('GET'));
        const text = await res.text();
        expect(text).not.toContain('ENCRYPTED-BLOB');
        expect(text).not.toContain('secret');
        const data = JSON.parse(text) as { config: { access_key_id_masked: string } };
        expect(data.config.access_key_id_masked).toBe('AKID****7890');
    });
});

describe('PUT /api/portal/oss', () => {
    it('401 without session', async () => {
        mockGetCurrentUser.mockResolvedValue(null);
        expect((await PUT(req('PUT', VALID_BODY))).status).toBe(401);
    });

    it('400 on schema violation (missing bucket)', async () => {
        const res = await PUT(req('PUT', { ...VALID_BODY, bucket: '' }));
        expect(res.status).toBe(400);
        expect(mockTestOssConnection).not.toHaveBeenCalled();
    });

    it('400 when non-AWS provider lacks endpoint', async () => {
        const res = await PUT(req('PUT', { ...VALID_BODY, endpoint: null }));
        expect(res.status).toBe(400);
    });

    it('422 + message when connection test fails — nothing persisted', async () => {
        mockTestOssConnection.mockResolvedValue({ ok: false, message: 'AccessDenied' });
        const res = await PUT(req('PUT', VALID_BODY));
        expect(res.status).toBe(422);
        expect(((await res.json()) as { message: string }).message).toBe('AccessDenied');
        expect(mockUpsertOssConfig).not.toHaveBeenCalled();
    });

    it('test passes → secret encrypted (decryptable roundtrip) → upsert status=active', async () => {
        mockTestOssConnection.mockResolvedValue({ ok: true });
        mockUpsertOssConfig.mockResolvedValue({ status: 'active' });
        const res = await PUT(req('PUT', VALID_BODY));
        expect(res.status).toBe(200);

        expect(mockUpsertOssConfig).toHaveBeenCalledTimes(1);
        const [userId, data] = mockUpsertOssConfig.mock.calls[0] as [
            string,
            { secret_access_key_encrypted: string; status: string },
        ];
        expect(userId).toBe(USER.id);
        expect(data.status).toBe('active');
        // 落库的是密文,且能用同 key 解回原文
        expect(data.secret_access_key_encrypted).not.toContain('super-secret-value');
        expect(decryptSecret(data.secret_access_key_encrypted)).toBe('super-secret-value');
    });

    it('503 when PORTAL_OSS_ENC_KEY is missing', async () => {
        delete process.env.PORTAL_OSS_ENC_KEY;
        const res = await PUT(req('PUT', VALID_BODY));
        expect(res.status).toBe(503);
        expect(mockUpsertOssConfig).not.toHaveBeenCalled();
    });
});

describe('DELETE /api/portal/oss', () => {
    it('deletes config for current user (idempotent)', async () => {
        mockDeleteOssConfig.mockResolvedValue({ count: 1 });
        const res = await DELETE(req('DELETE'));
        expect(res.status).toBe(200);
        expect(mockDeleteOssConfig).toHaveBeenCalledWith(USER.id);
    });
});

describe('POST /api/portal/oss/test-connection', () => {
    it('returns test result without persisting', async () => {
        mockTestOssConnection.mockResolvedValue({ ok: false, message: 'timeout' });
        const res = await TEST_CONNECTION(req('POST', VALID_BODY));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: false, message: 'timeout' });
        expect(mockUpsertOssConfig).not.toHaveBeenCalled();
    });

    it('401 without session', async () => {
        mockGetCurrentUser.mockResolvedValue(null);
        expect((await TEST_CONNECTION(req('POST', VALID_BODY))).status).toBe(401);
    });
});
