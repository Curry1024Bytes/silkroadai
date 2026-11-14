import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const {
    mockResolveAdmin,
    mockJobs,
    mockUsers,
    mockTokens,
    mockGetUser,
    mockGetCustomerIdentity,
    mockGetToken,
    mockGetTokenKey,
} = vi.hoisted(() => ({
    mockResolveAdmin: vi.fn(),
    mockJobs: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    mockUsers: { findUnique: vi.fn(), update: vi.fn() },
    mockTokens: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    mockGetUser: vi.fn(),
    mockGetCustomerIdentity: vi.fn(),
    mockGetToken: vi.fn(),
    mockGetTokenKey: vi.fn(),
}));

vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...args: unknown[]) => mockResolveAdmin(...args) }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        customerProvisioningJob: mockJobs,
        user: mockUsers,
        newApiToken: mockTokens,
        $transaction: (callback: (tx: unknown) => unknown) =>
            callback({
                customerProvisioningJob: mockJobs,
                user: mockUsers,
                newApiToken: mockTokens,
            }),
    },
}));
vi.mock('@/lib/newapi/client', () => ({
    customerProvisioningUsername: (id: string) => `c-${id.replaceAll('-', '').slice(0, 18)}`,
    getTokenForCustomer: (...args: unknown[]) => mockGetToken(...args),
    getTokenKey: (...args: unknown[]) => mockGetTokenKey(...args),
    getTokenRevocationCustomerIdentity: (...args: unknown[]) => mockGetCustomerIdentity(...args),
    getUser: (...args: unknown[]) => mockGetUser(...args),
}));

import { POST } from '@/app/api/admin/customer-provisioning/[id]/resolve/route';
import { encryptCustomerProvisioningPassword } from '@/lib/auth/customer-provisioning-secret';

const ADMIN = { role: 'superadmin', user: { id: 'admin-1' }, tenant_id: null, viaBreakGlass: false };
const USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const JOB = {
    id: 'job-1',
    user_id: USER_ID,
    email: 'customer@example.com',
    tier_key: 'standard',
    newapi_group: 'standard-group',
    password_ciphertext: 'encrypted-password',
};

function request(body: unknown) {
    return new NextRequest('https://portal.test/api/admin/customer-provisioning/job-1/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

const params = Promise.resolve({ id: 'job-1' });

beforeEach(() => {
    vi.clearAllMocks();
    process.env.PORTAL_CUSTOMER_PROVISIONING_ENC_KEY = '11'.repeat(32);
    mockResolveAdmin.mockResolvedValue(ADMIN);
    mockJobs.findFirst.mockResolvedValue({
        ...JOB,
        password_ciphertext: encryptCustomerProvisioningPassword('stable-password'),
    });
    mockJobs.updateMany.mockResolvedValue({ count: 1 });
    mockUsers.findUnique.mockResolvedValue({
        newapi_user_id: null,
        newapi_username: null,
        newapi_access_token: null,
    });
    mockTokens.findUnique.mockResolvedValue(null);
    mockGetUser.mockResolvedValue({
        id: 41,
        username: `c-${USER_ID.replaceAll('-', '').slice(0, 18)}`,
        email: 'customer@example.com',
    });
    mockGetCustomerIdentity.mockResolvedValue({ id: 41, status: 1 });
    mockGetToken.mockResolvedValue({
        id: 51,
        user_id: 41,
        name: `default-${USER_ID.slice(0, 8)}`,
        status: 1,
        unlimited_quota: true,
        expired_time: -1,
        model_limits_enabled: false,
        model_limits: '',
        group: 'standard-group',
    });
    mockGetTokenKey.mockResolvedValue('sk-sensitive');
});

describe('admin customer provisioning recovery', () => {
    it('requires a superadmin before reading or mutating provisioning jobs', async () => {
        mockResolveAdmin.mockResolvedValue(null);

        const response = await POST(request({ action: 'keep_failed' }), { params });

        expect(response.status).toBe(401);
        expect(mockJobs.updateMany).not.toHaveBeenCalled();
    });

    it('allows keep_failed without remote credentials and clears its retry secret', async () => {
        const response = await POST(request({ action: 'keep_failed' }), { params });

        expect(response.status).toBe(200);
        expect(mockJobs.updateMany).toHaveBeenCalledWith({
            where: { id: 'job-1', status: 'failed', last_error_code: 'pat_outcome_unknown' },
            data: {
                password_ciphertext: '',
                last_error_code: 'pat_outcome_unknown_kept',
                last_error_message: '人工选择保留失败；加密临时密码已清除。',
                updated_at: expect.any(Date),
            },
        });
    });

    it('retries with the preserved encrypted password instead of replacing it', async () => {
        const response = await POST(request({ action: 'retry_after_confirmed_absent' }), { params });

        expect(response.status).toBe(200);
        expect(mockJobs.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ select: expect.objectContaining({ password_ciphertext: true }) }),
        );
        const update = mockJobs.updateMany.mock.calls[0][0];
        expect(update.data).toMatchObject({ status: 'queued', attempts: 0 });
        expect(update.data).not.toHaveProperty('password_ciphertext');
        expect(mockGetUser).not.toHaveBeenCalled();
    });

    it('rejects link_existing when any required identity field is missing', async () => {
        const response = await POST(request({ action: 'link_existing', newapi_user_id: 41 }), { params });

        expect(response.status).toBe(400);
        expect(mockJobs.findFirst).not.toHaveBeenCalled();
        expect(mockGetUser).not.toHaveBeenCalled();
    });

    it('rejects a short-lived JWT as a persisted customer access token', async () => {
        const response = await POST(
            request({
                action: 'link_existing',
                newapi_user_id: 41,
                newapi_access_token: 'header.payload.signature',
                newapi_token_id: 51,
            }),
            { params },
        );

        expect(response.status).toBe(400);
        expect(mockGetUser).not.toHaveBeenCalled();
    });

    it('links a verified remote key using numeric token IDs and never returns secrets', async () => {
        const response = await POST(
            request({
                action: 'link_existing',
                newapi_user_id: 41,
                newapi_access_token: 'opaque-sensitive',
                newapi_token_id: 51,
            }),
            { params },
        );

        expect(response.status).toBe(200);
        expect(mockTokens.findUnique).toHaveBeenCalledWith({ where: { newapi_token_id: 51 } });
        expect(mockTokens.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ newapi_token_id: 51, newapi_token_value: 'sk-sensitive' }),
        });
        const body = await response.text();
        expect(body).not.toContain('opaque-sensitive');
        expect(body).not.toContain('sk-sensitive');
    });
});
