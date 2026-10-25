import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
const { db, poll, auth, ledger, notify } = vi.hoisted(() => ({
    db: {
        seedanceVideoTask: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
        enterpriseModelDiscount: { findUnique: vi.fn() },
        enterpriseGlobalDiscount: { findUnique: vi.fn() },
        enterpriseUpstreamKey: { findUnique: vi.fn() },
        enterpriseRequestLog: { create: vi.fn() },
    },
    poll: vi.fn(),
    auth: vi.fn(),
    ledger: vi.fn(),
    notify: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/billing/ledger', () => ({ applyLedgerEntry: ledger }));
vi.mock('../keys', () => ({
    resolveEnterpriseAuth: auth,
    getUpstreamKeyForUser: vi.fn(async () => 'fixture'),
    callerHasVolc: vi.fn(async () => true),
}));
vi.mock('@/lib/seedance/volc-adapter', async (original) => ({
    ...(await original<typeof import('@/lib/seedance/volc-adapter')>()),
    pollVolcVideo: poll,
}));
vi.mock('@/lib/seedance/customer-oss-video', () => ({ maybeStoreVideoToCustomerOss: vi.fn(async () => null) }));
vi.mock('../callback', async (original) => ({
    ...(await original<typeof import('../callback')>()),
    fireTaskCallback: notify,
}));
import { handleEnterpriseV1 } from '../proxy';
import { reconcileStaleTasks } from '../reconcile';
import { __resetPollCache } from '../poll-cache';

type Row = {
    id: string;
    user_id: string;
    tenant_id: null;
    tier: string;
    model: string;
    status: string;
    tokens: bigint | null;
    billed: boolean;
    created_at: Date;
    resolution: string;
    duration: number;
    ratio: string;
    has_video: boolean;
    callback_url: string;
    callback_status: string;
    callback_format: string;
    fail_reason?: string | null;
};
let row: Row;
beforeEach(() => {
    vi.resetAllMocks();
    __resetPollCache();
    vi.stubEnv('PORTAL_ENTERPRISE_CALLBACK_ENABLED', 'true');
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
            throw new Error('external network is disabled');
        }),
    );
    row = {
        id: 'cgt-ready',
        user_id: 'u1',
        tenant_id: null,
        tier: 'enterprise-portal',
        model: 'doubao-seedance-2.5',
        status: 'queued',
        tokens: null,
        billed: false,
        created_at: new Date(Date.now() - 600000),
        resolution: '720p',
        duration: 5,
        ratio: '16:9',
        has_video: false,
        callback_url: 'https://callback.example.com/task',
        callback_status: 'pending',
        callback_format: 'v1',
    };
    db.seedanceVideoTask.findUnique.mockImplementation(async () => ({ ...row }));
    db.seedanceVideoTask.findMany.mockImplementation(async () =>
        ['queued', 'in_progress'].includes(row.status) || (row.status === 'completed' && !row.billed)
            ? [{ ...row }]
            : [],
    );
    db.seedanceVideoTask.updateMany.mockImplementation(async ({ where, data }) => {
        const matchesStatus =
            !where.status ||
            (typeof where.status === 'string' ? where.status === row.status : where.status.in.includes(row.status));
        if (
            where.id !== row.id ||
            !matchesStatus ||
            (where.billed !== undefined && where.billed !== row.billed) ||
            (where.tokens === null && row.tokens !== null)
        )
            return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
    });
    db.seedanceVideoTask.update.mockImplementation(async ({ data }) => Object.assign(row, data));
    db.enterpriseModelDiscount.findUnique.mockResolvedValue(null);
    db.enterpriseGlobalDiscount.findUnique.mockResolvedValue(null);
    db.enterpriseUpstreamKey.findUnique.mockResolvedValue({ discount: '1' });
    db.enterpriseRequestLog.create.mockResolvedValue({});
    ledger.mockResolvedValue({});
    notify.mockImplementation(() => {
        row.callback_status = 'sent';
    });
    auth.mockResolvedValue({
        ok: true,
        customer: { userId: 'u1', tenantId: null, keyId: 'key', region: 'volc', upstreamKey: 'fixture' },
    });
});
afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});
function customerPoll() {
    __resetPollCache();
    return handleEnterpriseV1(
        new NextRequest('http://portal.test/v1/video/generations/cgt-ready', {
            headers: { authorization: 'Bearer fixture' },
        }),
        '/video/generations/cgt-ready',
    );
}
const run = (entry: 'poll' | 'reconcile') => (entry === 'poll' ? customerPoll() : reconcileStaleTasks('u1'));
const completed = (usage?: Record<string, unknown>, url = 'https://video.example.com/result.mp4') =>
    NextResponse.json({ id: row.id, status: 'completed', video_url: url, ...(usage === undefined ? {} : { usage }) });

describe('generation completion is independent from usage settlement', () => {
    it.each([
        ['poll', 'poll', undefined],
        ['poll', 'reconcile', undefined],
        ['reconcile', 'poll', undefined],
        ['reconcile', 'reconcile', undefined],
        ['poll', 'poll', { completion_tokens: 0 }],
        ['reconcile', 'reconcile', { completion_tokens: 0 }],
    ] as const)('%s records completion before usage and %s later settles once (%j)', async (first, later, usage) => {
        poll.mockImplementation(async () => completed(usage));
        await run(first);
        expect(row).toMatchObject({ status: 'completed', tokens: null, billed: false });
        expect(ledger).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith(
            row.id,
            expect.objectContaining({ status: 'completed', video_url: 'https://video.example.com/result.mp4' }),
        );
        poll.mockImplementation(async () => completed({ completion_tokens: 100000 }));
        await run(later);
        expect(row).toMatchObject({ status: 'completed', tokens: 100000n, billed: true });
        expect(ledger).toHaveBeenCalledTimes(1);
        await Promise.all([customerPoll(), reconcileStaleTasks('u1')]);
        expect(ledger).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(
            db.seedanceVideoTask.findMany.mock.calls.some(([arg]) =>
                arg.where.OR?.some(
                    (clause: { status?: unknown; billed?: boolean }) =>
                        clause.status === 'completed' && clause.billed === false,
                ),
            ),
        ).toBe(true);
    });
    it.each(['poll', 'reconcile'] as const)(
        '%s does not fabricate completion or usage from an invalid output URL',
        async (entry) => {
            poll.mockImplementation(async () => completed({ completion_tokens: 0 }, 'not-a-video-url'));
            await run(entry);
            expect(row).toMatchObject({ status: 'queued', tokens: null, billed: false });
            expect(ledger).not.toHaveBeenCalled();
            expect(notify).not.toHaveBeenCalled();
        },
    );
    it('a completed unbilled task is never turned failed or expired by a later response', async () => {
        poll.mockImplementation(async () => completed());
        await customerPoll();
        row.created_at = new Date(Date.now() - 50 * 60 * 60 * 1000);
        poll.mockImplementation(async () => NextResponse.json({ status: 'failed', fail_reason: 'late failure' }));
        await reconcileStaleTasks('u1');
        expect((await customerPoll()).status).toBe(503);
        expect(row).toMatchObject({ status: 'completed', tokens: null, billed: false });
        expect(ledger).not.toHaveBeenCalled();
        poll.mockImplementation(async () =>
            NextResponse.json({ error: { message: 'temporary outage' } }, { status: 503 }),
        );
        const response = await customerPoll();
        expect(response.status).toBe(503);
        expect(await response.json()).not.toHaveProperty('status', 'queued');
        expect(row.status).toBe('completed');
    });
});
