import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockVerifyAdminToken = vi.fn();
const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockOrderCount = vi.fn();

vi.mock('@/lib/admin-auth', () => ({
    verifyAdminToken: (...args: unknown[]) => mockVerifyAdminToken(...args),
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        paymentProviderInstance: {
            findUnique: (...args: unknown[]) => mockFindUnique(...args),
            update: (...args: unknown[]) => mockUpdate(...args),
            delete: (...args: unknown[]) => mockDelete(...args),
        },
        order: {
            count: (...args: unknown[]) => mockOrderCount(...args),
        },
    },
}));

vi.mock('@/lib/crypto', () => ({
    encrypt: (text: string) => `enc:${text}`,
    decrypt: (text: string) => text.replace(/^enc:/, ''),
}));

import { GET, PUT, DELETE } from '@/app/api/admin/provider-instances/[id]/route';

const MOCK_CONFIG = { pid: '123', pkey: 'secret-key-value-1234' };
const MOCK_ENCRYPTED_CONFIG = `enc:${JSON.stringify(MOCK_CONFIG)}`;

function createInstance(overrides?: Partial<Record<string, unknown>>) {
    return {
        id: 'inst-1',
        providerKey: 'easypay',
        name: 'Test Instance',
        config: MOCK_ENCRYPTED_CONFIG,
        enabled: true,
        sortOrder: 0,
        supportedTypes: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...overrides,
    };
}

function createRequest(method = 'GET', body?: object) {
    const headers: Record<string, string> = { Authorization: 'Bearer test-admin-token' };
    if (body) headers['Content-Type'] = 'application/json';
    return new NextRequest('https://pay.example.com/api/admin/provider-instances/inst-1', {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });
}

function params(id = 'inst-1') {
    return Promise.resolve({ id });
}

describe('GET /api/admin/provider-instances/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockVerifyAdminToken.mockResolvedValue(true);
    });

    it('returns 401 when unauthenticated', async () => {
        mockVerifyAdminToken.mockResolvedValue(false);
        const res = await GET(createRequest(), { params: params() });
        expect(res.status).toBe(401);
    });

    it('returns 404 when instance not found', async () => {
        mockFindUnique.mockResolvedValue(null);
        const res = await GET(createRequest(), { params: params() });
        expect(res.status).toBe(404);
    });

    it('returns instance with decrypted and masked config', async () => {
        mockFindUnique.mockResolvedValue(createInstance());
        const res = await GET(createRequest(), { params: params() });
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data.id).toBe('inst-1');
        // "pid" is not sensitive → unchanged
        expect(data.config.pid).toBe('123');
        // "pkey" contains "key" → sensitive → masked (last 4 chars visible)
        expect(data.config.pkey).toMatch(/^\*+1234$/);
        expect(data.config.pkey).not.toBe('secret-key-value-1234');
    });

    it('does not mask empty sensitive values (falsy check skips masking)', async () => {
        const instance = createInstance({ config: `enc:${JSON.stringify({ pkey: '' })}` });
        mockFindUnique.mockResolvedValue(instance);
        const res = await GET(createRequest(), { params: params() });
        const data = await res.json();

        // decryptAndMaskConfig: `isSensitiveField(key) && value` → '' is falsy → not masked
        expect(data.config.pkey).toBe('');
    });

    it('masks short sensitive values (<=4 chars) to ****', async () => {
        const instance = createInstance({ config: `enc:${JSON.stringify({ pkey: 'ab' })}` });
        mockFindUnique.mockResolvedValue(instance);
        const res = await GET(createRequest(), { params: params() });
        const data = await res.json();

        expect(data.config.pkey).toBe('****');
    });
});

describe('PUT /api/admin/provider-instances/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockVerifyAdminToken.mockResolvedValue(true);
        mockOrderCount.mockResolvedValue(0);
    });

    it('returns 401 when unauthenticated', async () => {
        mockVerifyAdminToken.mockResolvedValue(false);
        const res = await PUT(createRequest('PUT', { name: 'New Name' }), { params: params() });
        expect(res.status).toBe(401);
    });

    it('returns 404 when instance not found', async () => {
        mockFindUnique.mockResolvedValue(null);
        const res = await PUT(createRequest('PUT', { name: 'New Name' }), { params: params() });
        expect(res.status).toBe(404);
    });

    it('returns 400 for invalid providerKey', async () => {
        mockFindUnique.mockResolvedValue(createInstance());
        const res = await PUT(createRequest('PUT', { providerKey: 'invalid' }), { params: params() });
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toContain('providerKey');
    });

    it('returns 400 for empty name', async () => {
        mockFindUnique.mockResolvedValue(createInstance());
        const res = await PUT(createRequest('PUT', { name: '  ' }), { params: params() });
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toContain('name');
    });

    it('returns 400 when config is not an object', async () => {
        mockFindUnique.mockResolvedValue(createInstance());
        const res = await PUT(createRequest('PUT', { config: 'string-value' }), { params: params() });
        expect(res.status).toBe(400);
    });

    it('returns 400 for negative sortOrder', async () => {
        mockFindUnique.mockResolvedValue(createInstance());
        const res = await PUT(createRequest('PUT', { sortOrder: -1 }), { params: params() });
        expect(res.status).toBe(400);
    });

    it('returns 400 for non-integer sortOrder', async () => {
        mockFindUnique.mockResolvedValue(createInstance());
        const res = await PUT(createRequest('PUT', { sortOrder: 1.5 }), { params: params() });
        expect(res.status).toBe(400);
    });

    it('preserves masked config values (unchanged by user)', async () => {
        const instance = createInstance();
        mockFindUnique.mockResolvedValue(instance);
        mockUpdate.mockResolvedValue(instance);

        await PUT(createRequest('PUT', { config: { pid: '456', pkey: '****************1234' } }), { params: params() });

        const updateCall = mockUpdate.mock.calls[0][0];
        const savedConfig = JSON.parse(updateCall.data.config.replace('enc:', ''));
        // pid was changed to '456'
        expect(savedConfig.pid).toBe('456');
        // pkey was masked → preserved original value
        expect(savedConfig.pkey).toBe('secret-key-value-1234');
    });

    it('accepts actual config value changes', async () => {
        const instance = createInstance();
        mockFindUnique.mockResolvedValue(instance);
        mockUpdate.mockResolvedValue(instance);

        await PUT(createRequest('PUT', { config: { pid: '456', pkey: 'brand-new-key' } }), { params: params() });

        const updateCall = mockUpdate.mock.calls[0][0];
        const savedConfig = JSON.parse(updateCall.data.config.replace('enc:', ''));
        expect(savedConfig.pkey).toBe('brand-new-key');
    });

    it('returns 409 when changing credentials with pending orders', async () => {
        mockFindUnique.mockResolvedValue(createInstance());
        mockOrderCount.mockResolvedValue(3);

        const res = await PUT(createRequest('PUT', { config: { pid: '123', pkey: 'new-secret-key' } }), {
            params: params(),
        });

        expect(res.status).toBe(409);
        const data = await res.json();
        expect(data.error).toContain('3');
        expect(data.error).toContain('订单');
    });

    it('allows credential change when no pending orders', async () => {
        const instance = createInstance();
        mockFindUnique.mockResolvedValue(instance);
        mockUpdate.mockResolvedValue(instance);
        mockOrderCount.mockResolvedValue(0);

        const res = await PUT(createRequest('PUT', { config: { pid: '123', pkey: 'new-secret-key' } }), {
            params: params(),
        });

        expect(res.status).toBe(200);
    });

    it('allows non-credential config changes even with pending orders', async () => {
        const instance = createInstance();
        mockFindUnique.mockResolvedValue(instance);
        mockUpdate.mockResolvedValue(instance);
        mockOrderCount.mockResolvedValue(5);

        // Only changing pid (not sensitive) → should not trigger credential change check
        const res = await PUT(createRequest('PUT', { config: { pid: '999', pkey: '****************1234' } }), {
            params: params(),
        });

        expect(res.status).toBe(200);
    });

    it('updates name, enabled, sortOrder, supportedTypes', async () => {
        const instance = createInstance();
        mockFindUnique.mockResolvedValue(instance);
        mockUpdate.mockResolvedValue({ ...instance, name: 'Updated', enabled: false, sortOrder: 5 });

        const res = await PUT(
            createRequest('PUT', { name: 'Updated', enabled: false, sortOrder: 5, supportedTypes: 'alipay,wxpay' }),
            { params: params() },
        );

        expect(res.status).toBe(200);
        const updateCall = mockUpdate.mock.calls[0][0];
        expect(updateCall.data.name).toBe('Updated');
        expect(updateCall.data.enabled).toBe(false);
        expect(updateCall.data.sortOrder).toBe(5);
        expect(updateCall.data.supportedTypes).toBe('alipay,wxpay');
    });

    it('accepts valid providerKey values', async () => {
        for (const key of ['easypay', 'alipay', 'wxpay', 'stripe']) {
            mockFindUnique.mockResolvedValue(createInstance());
            mockUpdate.mockResolvedValue(createInstance({ providerKey: key }));

            const res = await PUT(createRequest('PUT', { providerKey: key }), { params: params() });
            expect(res.status).toBe(200);
        }
    });
});

describe('DELETE /api/admin/provider-instances/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockVerifyAdminToken.mockResolvedValue(true);
    });

    it('returns 401 when unauthenticated', async () => {
        mockVerifyAdminToken.mockResolvedValue(false);
        const res = await DELETE(createRequest('DELETE'), { params: params() });
        expect(res.status).toBe(401);
    });

    it('returns 404 when instance not found', async () => {
        mockFindUnique.mockResolvedValue(null);
        const res = await DELETE(createRequest('DELETE'), { params: params() });
        expect(res.status).toBe(404);
    });

    it('returns 409 when instance has pending orders', async () => {
        mockFindUnique.mockResolvedValue(createInstance());
        mockOrderCount.mockResolvedValue(2);

        const res = await DELETE(createRequest('DELETE'), { params: params() });
        expect(res.status).toBe(409);
        const data = await res.json();
        expect(data.error).toContain('2');
    });

    it('deletes instance when no pending orders', async () => {
        mockFindUnique.mockResolvedValue(createInstance());
        mockOrderCount.mockResolvedValue(0);
        mockDelete.mockResolvedValue(undefined);

        const res = await DELETE(createRequest('DELETE'), { params: params() });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(mockDelete).toHaveBeenCalled();
    });
});
