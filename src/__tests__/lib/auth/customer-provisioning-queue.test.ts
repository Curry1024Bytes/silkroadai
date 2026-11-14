import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDb, mockProvisionNewCustomerResumable, mockPool, mockPoolClients, mockLoadChannelGroupTopology } =
    vi.hoisted(() => ({
        mockDb: {
            $transaction: vi.fn(),
            $queryRaw: vi.fn(),
            customerProvisioningJob: {
                upsert: vi.fn(),
                findUnique: vi.fn(),
                findMany: vi.fn(),
                updateMany: vi.fn(),
            },
            user: {
                findUnique: vi.fn(),
                update: vi.fn(),
            },
            newApiToken: {
                findUnique: vi.fn(),
                create: vi.fn(),
                update: vi.fn(),
            },
            channelGroupRetirementJob: { findFirst: vi.fn() },
        },
        mockPool: { connect: vi.fn() },
        mockPoolClients: [
            { query: vi.fn(), release: vi.fn() },
            { query: vi.fn(), release: vi.fn() },
        ],
        mockProvisionNewCustomerResumable: vi.fn(),
        mockLoadChannelGroupTopology: vi.fn(),
    }));

vi.mock('@/lib/db', () => ({ prisma: mockDb }));
vi.mock('@/lib/config', () => ({ getEnv: () => ({ DATABASE_URL: 'postgres://test' }) }));
vi.mock('@/lib/channel-group-topology', () => ({ loadChannelGroupTopology: mockLoadChannelGroupTopology }));
vi.mock('pg', () => ({
    Pool: class MockPool {
        constructor() {
            return mockPool as never;
        }
    },
}));
vi.mock('@/lib/newapi/client', async () => {
    const actual = await vi.importActual<typeof import('@/lib/newapi/client')>('@/lib/newapi/client');
    return { ...actual, provisionNewCustomerResumable: mockProvisionNewCustomerResumable };
});

import { NewApiError } from '@/lib/newapi/client';
import {
    claimCustomerProvisioningJob,
    enqueueCustomerProvisioningJob,
    getCustomerProvisioningStatus,
    processNextCustomerProvisioningJob,
} from '@/lib/auth/customer-provisioning-queue';
import {
    decryptCustomerProvisioningPassword,
    encryptCustomerProvisioningPassword,
} from '@/lib/auth/customer-provisioning-secret';

const USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NOW = new Date();

function candidate(overrides: Record<string, unknown> = {}) {
    return {
        id: '11111111-2222-4333-8444-555555555555',
        user_id: USER_ID,
        email: 'customer@example.com',
        tier_key: 'standard',
        newapi_group: 'standard-group',
        initial_quota: 0,
        password_ciphertext: encryptCustomerProvisioningPassword('stable-password'),
        status: 'queued',
        attempts: 0,
        max_attempts: 8,
        next_attempt_at: NOW,
        lease_until: new Date(NOW.getTime() + 120_000),
        user: { tenant_id: null },
        created_at: NOW,
        ...overrides,
    };
}

beforeEach(() => {
    process.env.PORTAL_CUSTOMER_PROVISIONING_ENC_KEY = '11'.repeat(32);
    vi.clearAllMocks();
    let nextClient = 0;
    mockPool.connect.mockImplementation(async () => mockPoolClients[nextClient++ % mockPoolClients.length]);
    for (const client of mockPoolClients) {
        client.query.mockImplementation(async (query: string) =>
            query.includes('pg_advisory_unlock') ? { rows: [{ unlocked: true }] } : { rows: [{ locked: true }] },
        );
    }
    mockDb.$transaction.mockImplementation(async (callback: (tx: typeof mockDb) => unknown) => callback(mockDb));
    mockDb.channelGroupRetirementJob.findFirst.mockResolvedValue(null);
    mockLoadChannelGroupTopology.mockResolvedValue({
        defaultGroup: { key: 'standard', newapi_group: 'standard-group' },
    });
});

describe('customer provisioning queue', () => {
    it('encrypts passwords with authenticated encryption and rejects tampering', () => {
        const ciphertext = encryptCustomerProvisioningPassword('provisioning-secret');
        expect(ciphertext).not.toContain('provisioning-secret');
        expect(decryptCustomerProvisioningPassword(ciphertext)).toBe('provisioning-secret');
        const changed = `${ciphertext.slice(0, -4)}AAAA`;
        expect(() => decryptCustomerProvisioningPassword(changed)).toThrow();
    });

    it('uses an atomic user-key upsert and stores an encrypted password', async () => {
        mockDb.customerProvisioningJob.upsert.mockResolvedValue({ id: 'job-1', status: 'queued' });

        const result = await enqueueCustomerProvisioningJob(mockDb as never, {
            userId: USER_ID,
            email: 'customer@example.com',
            tierKey: 'standard',
            newapiGroup: 'standard-group',
            initialQuota: 12,
        });

        expect(result).toEqual({ id: 'job-1', status: 'queued' });
        const args = mockDb.customerProvisioningJob.upsert.mock.calls[0][0];
        expect(args.where).toEqual({ user_id: USER_ID });
        expect(args.create).toMatchObject({
            user_id: USER_ID,
            idempotency_key: `customer-provisioning:${USER_ID}`,
            tier_key: 'standard',
            newapi_group: 'standard-group',
            initial_quota: 12,
        });
        expect(args.create.password_ciphertext).not.toContain('stable-password');
    });

    it('reports a safe status message without exposing stored error details', async () => {
        const nextAttemptAt = new Date('2026-11-13T00:01:00.000Z');
        mockDb.customerProvisioningJob.findUnique.mockResolvedValue({
            status: 'retry_wait',
            next_attempt_at: nextAttemptAt,
        });

        await expect(getCustomerProvisioningStatus(USER_ID)).resolves.toEqual({
            status: 'retry_wait',
            nextAttemptAt,
            message: '开户任务暂时未完成，将自动重试。',
        });
    });

    it('honors each job max_attempts while claiming', async () => {
        mockDb.customerProvisioningJob.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                candidate({ attempts: 8, max_attempts: 8 }),
                candidate({ id: '22222222-3333-4444-8555-666666666666', attempts: 1, max_attempts: 2 }),
            ]);
        mockDb.customerProvisioningJob.updateMany.mockResolvedValue({ count: 1 });

        const claimed = await claimCustomerProvisioningJob({ now: NOW, leaseMs: 30_000 });

        expect(claimed?.id).toBe('22222222-3333-4444-8555-666666666666');
        expect(claimed?.attempts).toBe(2);
        expect(claimed?.tenantId).toBeNull();
        expect(mockDb.customerProvisioningJob.findMany.mock.calls[1][0]).toMatchObject({ take: 100 });
        expect(mockDb.customerProvisioningJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ id: '22222222-3333-4444-8555-666666666666' }),
                data: expect.objectContaining({ status: 'running', attempts: { increment: 1 } }),
            }),
        );
    });

    it('fails expired leases at the configured attempt limit and clears the ciphertext', async () => {
        mockDb.customerProvisioningJob.findMany
            .mockResolvedValueOnce([{ id: 'job-expired', attempts: 3, max_attempts: 3 }])
            .mockResolvedValueOnce([]);
        mockDb.customerProvisioningJob.updateMany.mockResolvedValue({ count: 1 });

        await expect(claimCustomerProvisioningJob({ now: NOW })).resolves.toBeNull();
        expect(mockDb.customerProvisioningJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'job-expired', status: 'running', lease_until: { lt: NOW } },
                data: expect.objectContaining({
                    status: 'failed',
                    password_ciphertext: '',
                    last_error_code: 'lease_expired',
                }),
            }),
        );
    });

    it('fails an expired lease after PAT creation entered its ambiguous window', async () => {
        mockDb.customerProvisioningJob.findMany
            .mockResolvedValueOnce([
                {
                    id: 'job-pat-in-flight',
                    attempts: 1,
                    max_attempts: 8,
                    last_error_code: 'pat_creation_started',
                },
            ])
            .mockResolvedValueOnce([]);
        mockDb.customerProvisioningJob.updateMany.mockResolvedValue({ count: 1 });

        await expect(claimCustomerProvisioningJob({ now: NOW })).resolves.toBeNull();

        expect(mockDb.customerProvisioningJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'job-pat-in-flight', status: 'running', lease_until: { lt: NOW } },
                data: expect.objectContaining({ status: 'failed', last_error_code: 'pat_outcome_unknown' }),
            }),
        );
        expect(mockDb.customerProvisioningJob.updateMany.mock.calls[0][0].data).not.toHaveProperty(
            'password_ciphertext',
        );
    });

    it('schedules retry using new-api Retry-After and keeps the encrypted password', async () => {
        mockDb.customerProvisioningJob.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([candidate()]);
        mockDb.customerProvisioningJob.updateMany.mockResolvedValue({ count: 1 });
        mockProvisionNewCustomerResumable.mockRejectedValue(
            new NewApiError(429, 'POST /api/user', null, 'rate limited', 5_000),
        );

        await expect(processNextCustomerProvisioningJob({ now: NOW, leaseMs: 30_000 })).resolves.toBe('processed');

        const failureCall = mockDb.customerProvisioningJob.updateMany.mock.calls.at(-1)?.[0];
        expect(failureCall.where.lease_until).toEqual({ gt: expect.any(Date) });
        expect(failureCall.data).toMatchObject({
            status: 'retry_wait',
            last_error_code: 'newapi_429',
            last_error_message: 'new-api 请求失败（HTTP 429）。',
        });
        expect(failureCall.data.next_attempt_at.getTime()).toBeGreaterThanOrEqual(Date.now() + 4_000);
    });

    it('clears the encrypted password when a non-retryable identity error permanently fails', async () => {
        mockDb.customerProvisioningJob.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([candidate()]);
        mockDb.customerProvisioningJob.updateMany.mockResolvedValue({ count: 1 });
        mockProvisionNewCustomerResumable.mockRejectedValue(
            new NewApiError(409, 'GET /api/user/search', null, 'identity mismatch'),
        );

        await expect(processNextCustomerProvisioningJob({ now: NOW, leaseMs: 30_000 })).resolves.toBe('processed');

        const failureCall = mockDb.customerProvisioningJob.updateMany.mock.calls.at(-1)?.[0];
        expect(failureCall.data).toMatchObject({ status: 'failed', password_ciphertext: '' });
    });

    it('destroys the pool connection when the session mutex cannot be unlocked', async () => {
        mockDb.customerProvisioningJob.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([candidate()]);
        mockDb.customerProvisioningJob.updateMany.mockResolvedValue({ count: 1 });
        mockProvisionNewCustomerResumable.mockRejectedValue(
            new NewApiError(409, 'GET /api/user/search', null, 'identity mismatch'),
        );
        mockPoolClients[0].query.mockImplementation(async (query: string) =>
            query.includes('pg_advisory_unlock') ? { rows: [{ unlocked: false }] } : { rows: [{ locked: true }] },
        );

        await expect(processNextCustomerProvisioningJob({ now: NOW, leaseMs: 30_000 })).resolves.toBe('processed');

        expect(mockPoolClients[0].release).toHaveBeenCalledTimes(1);
        expect(mockPoolClients[0].release).toHaveBeenCalledWith(expect.any(Error));
    });

    it('does not retry a PAT creation whose response is ambiguous', async () => {
        mockDb.customerProvisioningJob.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([candidate()]);
        mockDb.customerProvisioningJob.updateMany.mockResolvedValue({ count: 1 });
        mockProvisionNewCustomerResumable.mockRejectedValue(
            new NewApiError(504, 'POST /api/user/access_tokens', null, 'timeout', undefined, true),
        );

        await expect(processNextCustomerProvisioningJob({ now: NOW, leaseMs: 30_000 })).resolves.toBe('processed');

        const failureCall = mockDb.customerProvisioningJob.updateMany.mock.calls.at(-1)?.[0];
        expect(failureCall.data).toMatchObject({
            status: 'failed',
            last_error_code: 'pat_outcome_unknown',
        });
        expect(failureCall.data).not.toHaveProperty('password_ciphertext');
        expect(failureCall.data.status).not.toBe('retry_wait');
    });

    it('does not retry after PAT creation started even if a later provisioning step fails', async () => {
        mockDb.customerProvisioningJob.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([candidate()]);
        mockDb.customerProvisioningJob.updateMany.mockResolvedValue({ count: 1 });
        mockProvisionNewCustomerResumable.mockImplementation(async ({ onPatCreationStarted }) => {
            await onPatCreationStarted();
            throw new NewApiError(503, 'GET /api/token/', null, 'temporary failure');
        });

        await expect(processNextCustomerProvisioningJob({ now: NOW, leaseMs: 30_000 })).resolves.toBe('processed');

        const failureCall = mockDb.customerProvisioningJob.updateMany.mock.calls.at(-1)?.[0];
        expect(failureCall.data).toMatchObject({
            status: 'failed',
            last_error_code: 'pat_outcome_unknown',
        });
        expect(failureCall.data).not.toHaveProperty('password_ciphertext');
    });

    it('persists the new-api account and default token before marking the job complete', async () => {
        mockDb.customerProvisioningJob.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([candidate()]);
        mockDb.customerProvisioningJob.updateMany.mockResolvedValue({ count: 1 });
        mockDb.customerProvisioningJob.findUnique.mockImplementation(async () => ({
            ...candidate(),
            status: 'running',
            runner_token: mockDb.customerProvisioningJob.updateMany.mock.calls[0][0].data.runner_token,
        }));
        mockDb.user.findUnique.mockResolvedValue({
            newapi_user_id: null,
            newapi_username: null,
            newapi_access_token: null,
        });
        mockDb.newApiToken.findUnique.mockResolvedValue(null);
        let activeTransactions = 0;
        let activeTransactionsDuringRemoteProvisioning = -1;
        mockDb.$transaction.mockImplementation(async (callback: (tx: typeof mockDb) => unknown) => {
            activeTransactions += 1;
            try {
                return await callback(mockDb);
            } finally {
                activeTransactions -= 1;
            }
        });
        mockProvisionNewCustomerResumable.mockImplementation(async () => {
            activeTransactionsDuringRemoteProvisioning = activeTransactions;
            return {
                newapi_user_id: 77,
                newapi_username: 'c-aaaaaaaa',
                newapi_access_token: 'opaque-access-token',
                newapi_token_id: 88,
                newapi_token_value: 'sk-provisioned',
            };
        });

        await expect(processNextCustomerProvisioningJob({ now: NOW, leaseMs: 30_000 })).resolves.toBe('processed');

        expect(mockDb.newApiToken.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                user_id: USER_ID,
                newapi_token_id: 88,
                newapi_token_value: 'sk-provisioned',
                key_alias: 'default-aaaaaaaa',
                tier: 'standard',
            }),
        });
        expect(mockDb.user.update).toHaveBeenCalledWith({
            where: { id: USER_ID },
            data: {
                newapi_user_id: 77,
                newapi_username: 'c-aaaaaaaa',
                newapi_access_token: 'opaque-access-token',
            },
        });
        const completion = mockDb.customerProvisioningJob.updateMany.mock.calls.at(-1)?.[0];
        expect(completion.data).toMatchObject({ status: 'completed', password_ciphertext: '' });
        expect(activeTransactionsDuringRemoteProvisioning).toBe(0);
        expect(mockDb.$transaction).toHaveBeenCalledTimes(2);
        expect(mockPool.connect).toHaveBeenCalledTimes(1);
        expect(mockPoolClients[0].query).toHaveBeenCalledWith(expect.stringContaining('pg_try_advisory_lock'), [
            `customer-provisioning:${USER_ID}`,
        ]);
        expect(mockPoolClients[0].query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_unlock'), [
            `customer-provisioning:${USER_ID}`,
        ]);
        expect(mockPoolClients[0].release).toHaveBeenCalledTimes(1);
    });

    it('serializes remote provisioning for the same Portal user across workers', async () => {
        let releaseFirstProvisioning!: () => void;
        const firstProvisioningGate = new Promise<void>((resolve) => {
            releaseFirstProvisioning = resolve;
        });
        let lockOwner = false;
        let lockAcquisitions = 0;
        for (const client of mockPoolClients) {
            let ownsLock = false;
            client.query.mockImplementation(async (query: string) => {
                if (query.includes('pg_try_advisory_lock')) {
                    lockAcquisitions += 1;
                    if (lockOwner) return { rows: [{ locked: false }] };
                    lockOwner = true;
                    ownsLock = true;
                    return { rows: [{ locked: true }] };
                }
                if (query.includes('pg_advisory_unlock')) {
                    if (ownsLock) lockOwner = false;
                    ownsLock = false;
                    return { rows: [{ unlocked: true }] };
                }
                return { rows: [] };
            });
        }
        mockDb.customerProvisioningJob.findMany.mockImplementation(
            async ({ where }: { where: { status?: unknown } }) => (where.status === 'running' ? [] : [candidate()]),
        );
        mockDb.customerProvisioningJob.updateMany.mockResolvedValue({ count: 1 });
        let activeProvisioners = 0;
        let maxActiveProvisioners = 0;
        mockProvisionNewCustomerResumable.mockImplementation(async () => {
            activeProvisioners += 1;
            maxActiveProvisioners = Math.max(maxActiveProvisioners, activeProvisioners);
            if (activeProvisioners === 1) await firstProvisioningGate;
            activeProvisioners -= 1;
            throw new NewApiError(409, 'GET /api/user/search', null, 'identity mismatch');
        });

        const first = processNextCustomerProvisioningJob({ leaseMs: 30_000 });
        await vi.waitFor(() => expect(mockProvisionNewCustomerResumable).toHaveBeenCalledTimes(1));
        const second = processNextCustomerProvisioningJob({ leaseMs: 30_000 });
        await vi.waitFor(() => expect(lockAcquisitions).toBeGreaterThan(1));
        expect(mockProvisionNewCustomerResumable).toHaveBeenCalledTimes(1);

        releaseFirstProvisioning();
        await Promise.all([first, second]);
        expect(mockProvisionNewCustomerResumable).toHaveBeenCalledTimes(2);
        expect(maxActiveProvisioners).toBe(1);
        expect(mockPool.connect).toHaveBeenCalledTimes(2);
        expect(mockDb.$transaction).toHaveBeenCalledTimes(2);
    });

    it('does not call new-api when the runner lease was lost before taking the mutex', async () => {
        mockDb.customerProvisioningJob.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([candidate()]);
        mockDb.customerProvisioningJob.updateMany
            .mockResolvedValueOnce({ count: 1 }) // claim
            .mockResolvedValueOnce({ count: 0 }) // lock-held lease fence
            .mockResolvedValue({ count: 0 }); // best-effort failure update

        await expect(processNextCustomerProvisioningJob({ leaseMs: 30_000 })).resolves.toBe('processed');

        expect(mockProvisionNewCustomerResumable).not.toHaveBeenCalled();
        expect(mockDb.customerProvisioningJob.updateMany.mock.calls[1][0]).toMatchObject({
            where: expect.objectContaining({
                status: 'running',
                runner_token: expect.any(String),
                lease_until: { gt: expect.any(Date) },
            }),
        });
    });

    it('does not call new-api when the queued default tier was retired or replaced', async () => {
        mockDb.customerProvisioningJob.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([candidate()]);
        mockDb.customerProvisioningJob.updateMany.mockResolvedValue({ count: 1 });
        mockLoadChannelGroupTopology.mockResolvedValue({
            defaultGroup: { key: 'replacement', newapi_group: 'replacement-group' },
        });

        await expect(processNextCustomerProvisioningJob({ leaseMs: 30_000 })).resolves.toBe('processed');

        expect(mockProvisionNewCustomerResumable).not.toHaveBeenCalled();
        expect(mockDb.channelGroupRetirementJob.findFirst).not.toHaveBeenCalled();
        const failureCall = mockDb.customerProvisioningJob.updateMany.mock.calls.at(-1)?.[0];
        expect(failureCall.data).toMatchObject({ status: 'failed', last_error_code: 'newapi_409' });
    });

    it('does not start new-api work while the queued tier has an active retirement job', async () => {
        mockDb.customerProvisioningJob.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([candidate()]);
        mockDb.customerProvisioningJob.updateMany.mockResolvedValue({ count: 1 });
        mockDb.channelGroupRetirementJob.findFirst.mockResolvedValue({ id: 'retirement-1' });

        await expect(processNextCustomerProvisioningJob({ leaseMs: 30_000 })).resolves.toBe('processed');

        expect(mockProvisionNewCustomerResumable).not.toHaveBeenCalled();
        expect(mockDb.channelGroupRetirementJob.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ tier_key: 'standard' }) }),
        );
    });
});
