import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { db, charge, auth } = vi.hoisted(() => ({
    db: {
        seedanceVideoTask: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
        enterpriseRequestLog: { create: vi.fn(async () => ({})) },
    },
    charge: vi.fn(),
    auth: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('../keys', () => ({
    resolveEnterpriseAuth: auth,
    getUpstreamKeyForUser: vi.fn(async () => 'kz-fixture'),
    callerHasVolc: vi.fn(async () => true),
}));
vi.mock('../billing', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../billing')>()),
    chargeEnterpriseVideoTask: charge,
}));
vi.mock('../volc-id-map', () => ({
    toUpstreamId: vi.fn(async () => 'kz-cgt-fixture'),
    rememberVolcId: vi.fn(),
}));

import { handleEnterpriseV1 } from '../proxy';
import { reconcileStaleTasks } from '../reconcile';
import { __resetPollCache } from '../poll-cache';

const taskId = 'cgt-20260914000000-abcde';
let task: {
    id: string;
    user_id: string;
    tier: string;
    model: string;
    status: string;
    billed: boolean;
    fail_reason: string | null;
    created_at: Date;
    tokens: null;
};

function poll() {
    const path = `/video/generations/${taskId}`;
    return handleEnterpriseV1(
        new NextRequest(`http://portal.test/v1${path}`, {
            headers: { authorization: `Bearer sk-ent-${'a'.repeat(48)}` },
        }),
        path,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    __resetPollCache();
    vi.stubEnv('ENTERPRISE_KUAIZI_BASE_URL', 'http://upstream.test');
    task = {
        id: taskId,
        user_id: 'u1',
        tier: 'enterprise-portal',
        model: 'doubao-seedance-2.5',
        status: 'queued',
        billed: false,
        fail_reason: null,
        created_at: new Date(Date.now() - 600_000),
        tokens: null,
    };
    auth.mockResolvedValue({
        ok: true,
        customer: { userId: 'u1', tenantId: null, keyId: 'k1', region: 'volc', upstreamKey: 'kz-fixture' },
    });
    db.seedanceVideoTask.findUnique.mockImplementation(async () => ({ ...task }));
    db.seedanceVideoTask.findMany.mockImplementation(async () => (task.status === 'queued' ? [{ ...task }] : []));
    db.seedanceVideoTask.update.mockImplementation(async ({ data }) => Object.assign(task, data));
    db.seedanceVideoTask.updateMany.mockImplementation(async ({ where, data }) => {
        if (
            where.id !== task.id ||
            (where.status && !where.status.in.includes(task.status)) ||
            (where.billed !== undefined && where.billed !== task.billed)
        )
            return { count: 0 };
        Object.assign(task, data);
        return { count: 1 };
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('non-2xx failed tasks through the real adapter', () => {
    it.each(['customer poll', 'reconciliation'] as const)(
        '%s persists a delayed failure without charging and later polling uses the saved failure',
        async (entry) => {
            let respond!: (response: Response) => void;
            let started!: () => void;
            const requestStarted = new Promise<void>((resolve) => {
                started = resolve;
            });
            const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
                expect(init?.method).not.toBe('POST');
                started();
                return new Promise<Response>((resolve) => {
                    respond = resolve;
                });
            });
            vi.stubGlobal('fetch', fetchMock);
            const pending = entry === 'customer poll' ? poll() : reconcileStaleTasks('u1');
            await requestStarted;
            expect(task.status).toBe('queued');
            expect(charge).not.toHaveBeenCalled();
            respond(
                Response.json(
                    {
                        status: 'failed',
                        error: { code: 'InternalServiceError', message: 'generation failed' },
                        vendor_task_id: 'cgt-private-vendor',
                        usage: { completion_tokens: 12345 },
                    },
                    { status: 400 },
                ),
            );
            const response = await pending;
            if (response) {
                expect(response.status).toBe(200);
                const body = await response.json();
                expect(body.status).toBe('failed');
                expect(body.id).toBe(taskId);
                expect(body).not.toHaveProperty('usage');
                expect(body).not.toHaveProperty('vendor_task_id');
            }
            expect(task.status).toBe('failed');
            expect(task.fail_reason).toBeTruthy();
            expect(task.tokens).toBeNull();
            const later = await poll();
            expect(await later.json()).toMatchObject({ id: taskId, status: 'failed', fail_reason: task.fail_reason });
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(charge).not.toHaveBeenCalled();
        },
    );
});
