import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockVerifyAdminToken = vi.fn();
const mockGetAllSystemConfigs = vi.fn();
const mockSetSystemConfigs = vi.fn();
const mockGetSystemConfig = vi.fn();
const mockGroupBy = vi.fn();

vi.mock('@/lib/admin-auth', () => ({
    verifyAdminToken: (...args: unknown[]) => mockVerifyAdminToken(...args),
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));

vi.mock('@/lib/system-config', () => ({
    getAllSystemConfigs: (...args: unknown[]) => mockGetAllSystemConfigs(...args),
    setSystemConfigs: (...args: unknown[]) => mockSetSystemConfigs(...args),
    getSystemConfig: (...args: unknown[]) => mockGetSystemConfig(...args),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        paymentProviderInstance: {
            groupBy: (...args: unknown[]) => mockGroupBy(...args),
        },
    },
}));

import { GET, PUT } from '@/app/api/admin/config/route';

function createRequest(method = 'GET', body?: object) {
    const headers: Record<string, string> = { Authorization: 'Bearer test-admin-token' };
    if (body) headers['Content-Type'] = 'application/json';
    return new NextRequest('https://pay.example.com/api/admin/config', {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });
}

describe('GET /api/admin/config', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockVerifyAdminToken.mockResolvedValue(true);
    });

    it('returns 401 when unauthenticated', async () => {
        mockVerifyAdminToken.mockResolvedValue(false);
        const res = await GET(createRequest());
        expect(res.status).toBe(401);
    });

    it('returns configs with sensitive values masked', async () => {
        mockGetAllSystemConfigs.mockResolvedValue([
            { key: 'LITELLM_MASTER_KEY', value: 'my-super-secret-key-12345', group: 'general', label: null },
            { key: 'RECHARGE_MIN_AMOUNT', value: '10', group: 'general', label: null },
        ]);

        const res = await GET(createRequest());
        const data = await res.json();

        expect(res.status).toBe(200);
        // LITELLM_MASTER_KEY contains "KEY" → sensitive → masked
        expect(data.configs[0].value).toBe('*********************2345');
        expect(data.configs[0].value).not.toBe('my-super-secret-key-12345');
        // RECHARGE_MIN_AMOUNT → not sensitive → not masked
        expect(data.configs[1].value).toBe('10');
    });

    it('masks short sensitive values (<=4 chars) to ****', async () => {
        mockGetAllSystemConfigs.mockResolvedValue([
            { key: 'STRIPE_SECRET_KEY', value: 'ab', group: 'general', label: null },
        ]);

        const res = await GET(createRequest());
        const data = await res.json();

        expect(data.configs[0].value).toBe('****');
    });

    it('masks values for keys containing PASSWORD, PRIVATE, SECRET', async () => {
        mockGetAllSystemConfigs.mockResolvedValue([
            { key: 'DB_PASSWORD', value: 'longpassword123', group: 'general', label: null },
            { key: 'ALIPAY_PRIVATE_KEY', value: 'private-key-data', group: 'general', label: null },
            { key: 'MY_SECRET', value: 'secret-val', group: 'general', label: null },
        ]);

        const res = await GET(createRequest());
        const data = await res.json();

        expect(data.configs[0].value).toMatch(/^\*+d123$/);
        expect(data.configs[1].value).toMatch(/^\*+data$/);
        expect(data.configs[2].value).toMatch(/^\*+-val$/);
    });

    it('returns 500 on error', async () => {
        mockGetAllSystemConfigs.mockRejectedValue(new Error('DB error'));
        const res = await GET(createRequest());
        expect(res.status).toBe(500);
    });
});

describe('PUT /api/admin/config', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockVerifyAdminToken.mockResolvedValue(true);
        mockSetSystemConfigs.mockResolvedValue(undefined);
    });

    it('returns 401 when unauthenticated', async () => {
        mockVerifyAdminToken.mockResolvedValue(false);
        const res = await PUT(createRequest('PUT', { configs: [{ key: 'RECHARGE_MIN_AMOUNT', value: '5' }] }));
        expect(res.status).toBe(401);
    });

    it('returns 400 when configs is missing', async () => {
        const res = await PUT(createRequest('PUT', {}));
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toContain('configs');
    });

    it('returns 400 when configs is empty array', async () => {
        const res = await PUT(createRequest('PUT', { configs: [] }));
        expect(res.status).toBe(400);
    });

    it('returns 400 when config entry missing key or value', async () => {
        const res = await PUT(createRequest('PUT', { configs: [{ key: 'RECHARGE_MIN_AMOUNT' }] }));
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toContain('key');
    });

    it('returns 400 for disallowed config key', async () => {
        const res = await PUT(createRequest('PUT', { configs: [{ key: 'DANGEROUS_KEY', value: 'hack' }] }));
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toContain('DANGEROUS_KEY');
    });

    it('updates allowed configs successfully', async () => {
        const res = await PUT(
            createRequest('PUT', {
                configs: [
                    { key: 'RECHARGE_MIN_AMOUNT', value: '5' },
                    { key: 'RECHARGE_MAX_AMOUNT', value: '500' },
                ],
            }),
        );

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(mockSetSystemConfigs).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({ key: 'RECHARGE_MIN_AMOUNT', value: '5' }),
                expect.objectContaining({ key: 'RECHARGE_MAX_AMOUNT', value: '500' }),
            ]),
        );
    });

    it('filters out masked sensitive values (unchanged by user)', async () => {
        const res = await PUT(
            createRequest('PUT', {
                configs: [
                    { key: 'LITELLM_MASTER_KEY', value: '********************2345' },
                    { key: 'RECHARGE_MIN_AMOUNT', value: '10' },
                ],
            }),
        );

        expect(res.status).toBe(200);
        // Only the non-masked config should be passed to setSystemConfigs
        expect(mockSetSystemConfigs).toHaveBeenCalledWith([
            expect.objectContaining({ key: 'RECHARGE_MIN_AMOUNT', value: '10' }),
        ]);
    });

    it('passes through actual (non-masked) sensitive values', async () => {
        const res = await PUT(
            createRequest('PUT', {
                configs: [{ key: 'LITELLM_MASTER_KEY', value: 'new-real-api-key' }],
            }),
        );

        expect(res.status).toBe(200);
        expect(mockSetSystemConfigs).toHaveBeenCalledWith([
            expect.objectContaining({ key: 'LITELLM_MASTER_KEY', value: 'new-real-api-key' }),
        ]);
    });

    it('returns 409 when removing a provider that has instances', async () => {
        mockGetSystemConfig.mockResolvedValue('easypay,alipay,wxpay');
        mockGroupBy.mockResolvedValue([{ providerKey: 'easypay', _count: 2 }]);

        const res = await PUT(
            createRequest('PUT', {
                configs: [{ key: 'ENABLED_PROVIDERS', value: 'alipay,wxpay' }],
            }),
        );

        expect(res.status).toBe(409);
        const data = await res.json();
        expect(data.error).toContain('easypay');
    });

    it('allows removing a provider that has no instances', async () => {
        mockGetSystemConfig.mockResolvedValue('easypay,alipay');
        mockGroupBy.mockResolvedValue([]);

        const res = await PUT(
            createRequest('PUT', {
                configs: [{ key: 'ENABLED_PROVIDERS', value: 'alipay' }],
            }),
        );

        expect(res.status).toBe(200);
    });

    it('allows adding new providers', async () => {
        mockGetSystemConfig.mockResolvedValue('easypay');
        // No providers removed, so groupBy should not block
        mockGroupBy.mockResolvedValue([]);

        const res = await PUT(
            createRequest('PUT', {
                configs: [{ key: 'ENABLED_PROVIDERS', value: 'easypay,alipay,stripe' }],
            }),
        );

        expect(res.status).toBe(200);
    });

    it('skips provider validation when ENABLED_PROVIDERS is not being updated', async () => {
        const res = await PUT(
            createRequest('PUT', {
                configs: [{ key: 'RECHARGE_MIN_AMOUNT', value: '5' }],
            }),
        );

        expect(res.status).toBe(200);
        expect(mockGetSystemConfig).not.toHaveBeenCalled();
    });

    it('skips provider validation when no current ENABLED_PROVIDERS exists', async () => {
        mockGetSystemConfig.mockResolvedValue(undefined);

        const res = await PUT(
            createRequest('PUT', {
                configs: [{ key: 'ENABLED_PROVIDERS', value: 'easypay' }],
            }),
        );

        expect(res.status).toBe(200);
        expect(mockGroupBy).not.toHaveBeenCalled();
    });

    it('returns 500 on error', async () => {
        mockSetSystemConfigs.mockRejectedValue(new Error('DB error'));
        const res = await PUT(createRequest('PUT', { configs: [{ key: 'RECHARGE_MIN_AMOUNT', value: '5' }] }));
        expect(res.status).toBe(500);
    });
});
