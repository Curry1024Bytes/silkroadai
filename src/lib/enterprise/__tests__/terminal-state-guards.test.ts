import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { db, pollVolcVideo, charge, auth } = vi.hoisted(() => ({
    db: {
        seedanceVideoTask: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
        enterpriseRequestLog: { create: vi.fn() },
    },
    pollVolcVideo: vi.fn(),
    charge: vi.fn(),
    auth: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('../keys', () => ({
    resolveEnterpriseAuth: auth,
    getUpstreamKeyForUser: vi.fn(async () => 'kz-fixture'),
    callerHasVolc: vi.fn(async () => true),
}));
vi.mock('../billing', async (original) => ({
    ...(await original<typeof import('../billing')>()),
    chargeEnterpriseVideoTask: charge,
}));
vi.mock('@/lib/seedance/kuaizi-adapter', async (original) => ({
    ...(await original<typeof import('@/lib/seedance/kuaizi-adapter')>()),
    pollVolcVideo,
}));
vi.mock('@/lib/seedance/customer-oss-video', () => ({ maybeStoreVideoToCustomerOss: vi.fn(async () => null) }));

import { handleEnterpriseArkV3, handleEnterpriseV1 } from '../proxy';
import { reconcileStaleTasks } from '../reconcile';
import { __resetPollCache } from '../poll-cache';

type Task = {
    id: string;
    user_id: string;
    tier: string;
    model: string;
    status: string;
    billed: boolean;
    fail_reason: string | null;
    tokens: bigint | null;
    created_at: Date;
};
let task: Task;
const taskId = 'cgt-terminal-guard';
type Entry = 'customer' | 'reconcile';

function customerPoll(format: 'v1' | 'ark' = 'v1') {
    const path = format === 'ark' ? `/contents/generations/tasks/${taskId}` : `/video/generations/${taskId}`;
    const handle = format === 'ark' ? handleEnterpriseArkV3 : handleEnterpriseV1;
    return handle(
        new NextRequest(`http://portal.test/v1${path}`, {
            headers: { authorization: `Bearer sk-ent-${'a'.repeat(48)}` },
        }),
        path,
    );
}

const run = (entry: Entry) => (entry === 'customer' ? customerPoll() : reconcileStaleTasks('u1'));
const failed = () => NextResponse.json({ id: taskId, status: 'failed', fail_reason: 'late failure' });
const terminalError = () =>
    NextResponse.json(
        { error: { category: 'task_type_constraint', message: 'late parameter failure' } },
        { status: 400 },
    );
const completed = () => NextResponse.json({ id: taskId, status: 'completed', usage: { completion_tokens: 12345 } });

function deferredPoll() {
    let release!: (response: NextResponse) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });
    pollVolcVideo.mockImplementationOnce(() => {
        entered();
        return new Promise<NextResponse>((resolve) => {
            release = resolve;
        });
    });
    return { started, release: (response: NextResponse) => release(response) };
}

beforeEach(() => {
    vi.resetAllMocks();
    __resetPollCache();
    // Any accidentally introduced network call fails locally; no provider request is permitted.
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
            throw new Error('network disabled in terminal-state tests');
        }),
    );
    task = {
        id: taskId,
        user_id: 'u1',
        tier: 'enterprise-portal',
        model: 'doubao-seedance-2.5',
        status: 'queued',
        billed: false,
        fail_reason: null,
        tokens: null,
        created_at: new Date(Date.now() - 600_000),
    };
    auth.mockResolvedValue({
        ok: true,
        customer: {
            userId: 'u1',
            tenantId: null,
            keyId: 'k1',
            region: 'volc',
            upstreamKey: 'kz-fixture',
        },
    });
    db.seedanceVideoTask.findUnique.mockImplementation(async () => ({ ...task }));
    db.seedanceVideoTask.findMany.mockImplementation(async () =>
        ['queued', 'in_progress'].includes(task.status) ? [{ ...task }] : [],
    );
    db.seedanceVideoTask.update.mockImplementation(async ({ data }: { data: Partial<Task> }) => {
        Object.assign(task, data);
        return { ...task };
    });
    // Interpret each SQL predicate against current state, including mutations made while
    // upstream I/O was suspended. A mock that always returns count=1 cannot detect this race.
    db.seedanceVideoTask.updateMany.mockImplementation(
        async ({
            where,
            data,
        }: {
            where: { id: string; status?: { in: string[] }; billed?: boolean; tokens?: null };
            data: Partial<Task>;
        }) => {
            if (
                where.id !== task.id ||
                (where.status && !where.status.in.includes(task.status)) ||
                (where.billed !== undefined && where.billed !== task.billed) ||
                (where.tokens === null && task.tokens !== null)
            )
                return { count: 0 };
            Object.assign(task, data);
            return { count: 1 };
        },
    );
    charge.mockImplementation(async () => {
        task.billed = true;
        return { outcome: 'charged', costCny: 1 };
    });
    db.enterpriseRequestLog.create.mockResolvedValue({});
});
afterEach(() => vi.unstubAllGlobals());

describe('failure writes preserve completed and billed tasks', () => {
    it.each([
        ['customer', 'normalized', failed],
        ['customer', 'classified', terminalError],
        ['reconcile', 'normalized', failed],
        ['reconcile', 'classified', terminalError],
    ] as const)(
        '%s ignores a delayed %s failure after another path completes and bills',
        async (entry, _kind, failure) => {
            const upstream = deferredPoll();
            const pending = run(entry);
            await upstream.started;
            pollVolcVideo.mockResolvedValueOnce(completed());
            await run(entry === 'customer' ? 'reconcile' : 'customer');
            expect(task).toMatchObject({ status: 'completed', billed: true, tokens: BigInt(12345) });
            upstream.release(failure());
            const response = await pending;
            expect(task).toMatchObject({ status: 'completed', billed: true, tokens: BigInt(12345), fail_reason: null });
            expect(charge).toHaveBeenCalledTimes(1);
            if (response) {
                expect(response.status).toBe(503);
                expect(response.headers.get('Retry-After')).toBe('5');
                expect(await response.json()).toMatchObject({ error: { code: 'task_status_changed' } });
            }
            const reconcileOutcomes = db.enterpriseRequestLog.create.mock.calls.map(([arg]) => arg.data.outcome);
            expect(reconcileOutcomes).not.toContain('marked_failed');
            expect(reconcileOutcomes).not.toContain('terminalized');
        },
    );

    it.each([
        ['completed', false],
        ['completed', true],
        ['queued', true],
    ] as const)('a %s task billed=%s cannot be replaced by a later failed response', async (status, billed) => {
        Object.assign(task, { status, billed });
        pollVolcVideo.mockResolvedValueOnce(failed());
        const response = await customerPoll();
        expect(response.status).toBe(503);
        expect(await response.json()).not.toHaveProperty('status');
        expect(task).toMatchObject({ status, billed, fail_reason: null });
        expect(charge).not.toHaveBeenCalled();
    });

    it.each(['v1', 'ark'] as const)('%s returns the saved reason for a competing persisted failure', async (format) => {
        const upstream = deferredPoll();
        const pending = customerPoll(format);
        await upstream.started;
        task.status = 'failed';
        task.fail_reason = 'already saved failure';
        upstream.release(failed());
        const response = await pending;
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject(
            format === 'ark'
                ? { status: 'failed', error: { message: 'already saved failure' } }
                : { status: 'failed', fail_reason: 'already saved failure' },
        );
        expect(task.fail_reason).toBe('already saved failure');
    });

    it('Ark returns a retryable error when a completed task later receives a failed response', async () => {
        task.status = 'completed';
        task.billed = true;
        pollVolcVideo.mockResolvedValueOnce(failed());
        const response = await customerPoll('ark');
        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBe('5');
        expect(await response.json()).toMatchObject({ error: { code: 'task_status_changed' } });
        expect(task.status).toBe('completed');
    });

    it.each([failed, terminalError])(
        'does not claim a terminal state when the failure write throws',
        async (failure) => {
            db.seedanceVideoTask.updateMany.mockRejectedValueOnce(new Error('fixture write unavailable'));
            pollVolcVideo.mockResolvedValueOnce(failure());
            const response = await customerPoll();
            expect(response.status).toBe(503);
            expect(response.headers.get('Retry-After')).toBe('5');
            expect(await response.json()).toMatchObject({ error: { code: 'task_status_unavailable' } });
            expect(task).toMatchObject({ status: 'queued', billed: false, fail_reason: null });
            expect(charge).not.toHaveBeenCalled();
        },
    );

    it('does not claim failure when the conditional update loses and the latest-state read throws', async () => {
        db.seedanceVideoTask.updateMany.mockResolvedValueOnce({ count: 0 });
        db.seedanceVideoTask.findUnique
            .mockResolvedValueOnce({ ...task })
            .mockRejectedValueOnce(new Error('read unavailable'));
        pollVolcVideo.mockResolvedValueOnce(failed());
        const response = await customerPoll();
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: { code: 'task_status_unavailable' } });
        expect(task.status).toBe('queued');
    });
});

describe('reconciliation expires only still-pending, unbilled rows', () => {
    it.each(['completed', 'billed'] as const)('a delayed expiry preserves a task that became %s', async (changed) => {
        task.created_at = new Date(Date.now() - 50 * 60 * 60 * 1000);
        const upstream = deferredPoll();
        const pending = reconcileStaleTasks('u1');
        await upstream.started;
        if (changed === 'completed') task.status = 'completed';
        else task.billed = true;
        upstream.release(NextResponse.json({ status: 'in_progress' }));
        await pending;
        expect(task.status).toBe(changed === 'completed' ? 'completed' : 'queued');
        expect(task.billed).toBe(changed === 'billed');
        expect(task.fail_reason).toBeNull();
        expect(db.enterpriseRequestLog.create).not.toHaveBeenCalled();
    });

    it('an unpersisted failure is not logged as a successful terminal transition', async () => {
        db.seedanceVideoTask.updateMany.mockRejectedValueOnce(new Error('fixture write unavailable'));
        pollVolcVideo.mockResolvedValueOnce(failed());
        await reconcileStaleTasks('u1');
        expect(task.status).toBe('queued');
        expect(db.enterpriseRequestLog.create).not.toHaveBeenCalled();
        expect(charge).not.toHaveBeenCalled();
    });
});
