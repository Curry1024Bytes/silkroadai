import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

// ── mocks ──
const mockQueryLogs = vi.fn();
const mockCursorUpsert = vi.fn();
const mockCursorUpdate = vi.fn();
const mockUserFindUnique = vi.fn();
const mockUserFindMany = vi.fn();
const mockTokenFindUnique = vi.fn();
const mockModelFindFirst = vi.fn();
const mockUsageCreateMany = vi.fn();
const mockUsageFindMany = vi.fn();
const mockApplyLedgerEntry = vi.fn();
const mockSyncNewapiGate = vi.fn();

// Only `queryLogs` is exposed — if the meter ever reaches for a new-api WRITE
// (addQuota / token / user) the call would be undefined and throw, which is
// exactly the P4a read-only guarantee we want enforced.
vi.mock('@/lib/newapi/client', () => ({ queryLogs: (...a: unknown[]) => mockQueryLogs(...a) }));
vi.mock('@/lib/db', () => ({
    prisma: {
        usageMeterCursor: {
            upsert: (...a: unknown[]) => mockCursorUpsert(...a),
            update: (...a: unknown[]) => mockCursorUpdate(...a),
        },
        user: {
            findUnique: (...a: unknown[]) => mockUserFindUnique(...a),
            findMany: (...a: unknown[]) => mockUserFindMany(...a),
        },
        newApiToken: { findUnique: (...a: unknown[]) => mockTokenFindUnique(...a) },
        catalogModel: { findFirst: (...a: unknown[]) => mockModelFindFirst(...a) },
        usageRecord: {
            createMany: (...a: unknown[]) => mockUsageCreateMany(...a),
            findMany: (...a: unknown[]) => mockUsageFindMany(...a),
        },
    },
}));
// P4c-2: the meter debits via applyLedgerEntry; mock it to assert the call shape
// (its atomicity / optimistic lock / idempotency is covered by ledger.test.ts).
vi.mock('@/lib/billing/ledger', () => ({ applyLedgerEntry: (...a: unknown[]) => mockApplyLedgerEntry(...a) }));
// P4c-3: after charging a portal user, the meter re-syncs the new-api dumb gate.
vi.mock('@/lib/billing/newapi-gate', () => ({ syncNewapiGate: (...a: unknown[]) => mockSyncNewapiGate(...a) }));

import { runShadowMeter, reconcileAllPortalGates } from '@/lib/billing/meter';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

const LOG_TS = Math.floor(Date.parse('2026-06-06T00:00:00Z') / 1000); // unix seconds

function consumeLog(over: Partial<Record<string, unknown>> = {}) {
    return {
        id: 10,
        user_id: 42,
        model_name: 'gpt-5.4',
        quota: 900_000,
        prompt_tokens: 1_000_000,
        completion_tokens: 1_000_000,
        token_id: 7,
        created_at: LOG_TS,
        type: 2,
        ...over,
    };
}

const poolPrice = {
    id: 'pr-pool',
    tier: 'pool',
    effective_from: new Date('2026-06-01T00:00:00Z'),
    input_cny_per_1m: 2.5,
    output_cny_per_1m: 10,
};
const officialPrice = {
    id: 'pr-official',
    tier: 'official',
    effective_from: new Date('2026-06-01T00:00:00Z'),
    input_cny_per_1m: 5,
    output_cny_per_1m: 20,
};

beforeEach(() => {
    vi.clearAllMocks();
    mockCursorUpsert.mockResolvedValue({ id: 1, last_log_id: 0 });
    mockCursorUpdate.mockResolvedValue({});
    mockUserFindUnique.mockResolvedValue({ id: 'u1', tenant_id: PLATFORM_TENANT_ID });
    mockTokenFindUnique.mockResolvedValue({ id: 't1', tier: 'pool' });
    mockModelFindFirst.mockResolvedValue({ prices: [poolPrice, officialPrice] });
    mockUsageCreateMany.mockImplementation(({ data }: { data: unknown[] }) => Promise.resolve({ count: data.length }));
    // single page, fewer than PAGE_SIZE → stops after page 1
    mockQueryLogs.mockResolvedValue({ items: [consumeLog()], total: 1 });
    // P4c-2 defaults: debit phase off (BILLING_SOURCE unset) + empty query-backs.
    mockUsageFindMany.mockResolvedValue([]);
    mockUserFindMany.mockResolvedValue([]);
    mockApplyLedgerEntry.mockResolvedValue({ deduped: false });
    mockSyncNewapiGate.mockResolvedValue(undefined); // P4c-3
});

afterEach(() => {
    vi.unstubAllEnvs(); // clear any BILLING_SOURCE stub between tests
});

describe('runShadowMeter — happy path (matched cost, read-only, cursor advance)', () => {
    it('computes ¥ cost from CatalogPrice, writes one UsageRecord, advances cursor', async () => {
        const r = await runShadowMeter();

        // only GET logs from new-api; never any write surface (mock would throw if reached)
        expect(mockQueryLogs).toHaveBeenCalledWith(expect.objectContaining({ type: 2, page: 1 }));

        // one record, matched, ¥12.5 (1M in × 2.5 + 1M out × 10)
        expect(mockUsageCreateMany).toHaveBeenCalledTimes(1);
        const args = mockUsageCreateMany.mock.calls[0][0];
        expect(args.skipDuplicates).toBe(true); // idempotency
        expect(args.data).toHaveLength(1);
        expect(args.data[0]).toMatchObject({
            newapi_log_id: 10,
            newapi_user_id: 42,
            user_id: 'u1',
            token_id: 't1',
            model_slug: 'gpt-5.4',
            tier: 'pool',
            cost_cny: 12.5,
            price_id: 'pr-pool',
            matched: true,
            newapi_quota: 900_000,
        });

        // cursor advanced to the batch max log id
        expect(mockCursorUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 1 }, data: expect.objectContaining({ last_log_id: 10 }) }),
        );
        expect(r).toMatchObject({ cursorBefore: 0, cursorAfter: 10, recorded: 1, matched: 1, unmatched: 0 });
    });

    it('looks up the model under the user tenant + slug', async () => {
        await runShadowMeter();
        expect(mockModelFindFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { tenant_id: PLATFORM_TENANT_ID, slug: 'gpt-5.4' } }),
        );
    });
});

describe('runShadowMeter — tier resolution', () => {
    it('token tier=official → official price', async () => {
        mockTokenFindUnique.mockResolvedValue({ id: 't9', tier: 'official' });
        await runShadowMeter();
        expect(mockUsageCreateMany.mock.calls[0][0].data[0]).toMatchObject({
            tier: 'official',
            price_id: 'pr-official',
            cost_cny: 5 + 20, // 1M in × 5 + 1M out × 20 = 25
            matched: true,
        });
    });

    it('no token found → tier defaults to pool', async () => {
        mockTokenFindUnique.mockResolvedValue(null);
        await runShadowMeter();
        expect(mockUsageCreateMany.mock.calls[0][0].data[0]).toMatchObject({ tier: 'pool', token_id: null });
    });
});

describe('runShadowMeter — unmatched + skip', () => {
    it('no CatalogModel/price → matched=false, cost 0, still recorded (no throw)', async () => {
        mockModelFindFirst.mockResolvedValue(null);
        const r = await runShadowMeter();
        expect(mockUsageCreateMany.mock.calls[0][0].data[0]).toMatchObject({
            matched: false,
            cost_cny: 0,
            price_id: null,
        });
        expect(r).toMatchObject({ matched: 0, unmatched: 1, recorded: 1 });
    });

    it('log with no portal user → skipped, not recorded, cursor still advances past it', async () => {
        mockUserFindUnique.mockResolvedValue(null);
        const r = await runShadowMeter();
        expect(mockUsageCreateMany).not.toHaveBeenCalled();
        expect(r).toMatchObject({ skippedNoUser: 1, recorded: 0, cursorAfter: 10 });
        expect(mockCursorUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ last_log_id: 10 }) }),
        );
    });
});

describe('runShadowMeter — idempotency / cursor', () => {
    it('logs at or below the cursor are skipped (no re-processing)', async () => {
        mockCursorUpsert.mockResolvedValue({ id: 1, last_log_id: 10 }); // already processed up to 10
        mockQueryLogs.mockResolvedValue({ items: [consumeLog({ id: 10 })], total: 1 }); // id 10 ≤ cursor
        const r = await runShadowMeter();
        expect(mockUsageCreateMany).not.toHaveBeenCalled();
        expect(r).toMatchObject({ fetched: 0, recorded: 0, cursorAfter: 10 });
        // cursor not advanced past 10, only last_run_at touched
        expect(mockCursorUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.not.objectContaining({ last_log_id: expect.anything() }) }),
        );
    });

    it('createMany skipDuplicates count drives `recorded` (dupes do not double-count)', async () => {
        mockUsageCreateMany.mockResolvedValue({ count: 0 }); // all were duplicates
        const r = await runShadowMeter();
        expect(r.recorded).toBe(0);
        expect(r.cursorAfter).toBe(10); // cursor still advances
    });
});

describe('runShadowMeter — P4c-2 ledger debit (two gates, idempotent, never blocks)', () => {
    // The real UsageRecord the meter reads back after createMany (has the real id used as the ref).
    const usageRow = (over: Record<string, unknown> = {}) => ({
        id: 'ur1',
        user_id: 'u1',
        cost_cny: new Prisma.Decimal('12.5'),
        model_slug: 'gpt-5.4',
        tier: 'pool',
        ...over,
    });

    it('global gate OFF (BILLING_SOURCE unset → newapi): no debit phase at all, even if user is portal', async () => {
        // newapi customers behave exactly as P4a — kill-switch closed → query-back never even runs.
        mockUserFindMany.mockResolvedValue([{ id: 'u1' }]);
        mockUsageFindMany.mockResolvedValue([usageRow()]);
        const r = await runShadowMeter();
        expect(mockUsageFindMany).not.toHaveBeenCalled();
        expect(mockApplyLedgerEntry).not.toHaveBeenCalled();
        expect(r.charged).toBe(0);
    });

    it('both gates open (BILLING_SOURCE=portal + user billing_mode=portal) + matched → debits −cost_cny, ref=id', async () => {
        vi.stubEnv('BILLING_SOURCE', 'portal');
        mockUsageFindMany.mockResolvedValue([usageRow()]);
        mockUserFindMany.mockResolvedValue([{ id: 'u1' }]); // u1 is portal
        const r = await runShadowMeter();

        // query-back fetches ONLY matched records, keyed by the fresh log ids (before cursor advance)
        expect(mockUsageFindMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ matched: true, newapi_log_id: { in: [10] } }) }),
        );
        // per-customer gate via a single batch fetch (no N+1), scoped to portal
        expect(mockUserFindMany).toHaveBeenCalledTimes(1);
        expect(mockUserFindMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ billing_mode: 'portal' }) }),
        );
        // charge: negated retail, ref = UsageRecord.id (the idempotency key), descriptive note
        expect(mockApplyLedgerEntry).toHaveBeenCalledTimes(1);
        const [userId, arg] = mockApplyLedgerEntry.mock.calls[0];
        expect(userId).toBe('u1');
        expect(arg.kind).toBe('charge');
        expect(arg.ref).toBe('ur1');
        expect(arg.note).toBe('gpt-5.4/pool');
        expect(arg.amount_cny.toString()).toBe('-12.5');
        expect(r.charged).toBe(1);
    });

    it('per-customer gate (user billing_mode=newapi) → not debited even when BILLING_SOURCE=portal', async () => {
        vi.stubEnv('BILLING_SOURCE', 'portal');
        mockUsageFindMany.mockResolvedValue([usageRow()]);
        mockUserFindMany.mockResolvedValue([]); // no portal users in this batch
        const r = await runShadowMeter();
        expect(mockApplyLedgerEntry).not.toHaveBeenCalled();
        expect(r.charged).toBe(0);
    });

    it('matched-only: no matched records → skips the billing_mode lookup + charge entirely', async () => {
        vi.stubEnv('BILLING_SOURCE', 'portal');
        mockUsageFindMany.mockResolvedValue([]); // matched:true filter yielded nothing to debit
        mockUserFindMany.mockResolvedValue([{ id: 'u1' }]);
        await runShadowMeter();
        expect(mockUserFindMany).not.toHaveBeenCalled();
        expect(mockApplyLedgerEntry).not.toHaveBeenCalled();
    });

    it('zero-cost matched record → no ledger entry (no-op, no noise)', async () => {
        vi.stubEnv('BILLING_SOURCE', 'portal');
        mockUsageFindMany.mockResolvedValue([usageRow({ cost_cny: new Prisma.Decimal(0) })]);
        mockUserFindMany.mockResolvedValue([{ id: 'u1' }]);
        const r = await runShadowMeter();
        expect(mockApplyLedgerEntry).not.toHaveBeenCalled();
        expect(r.charged).toBe(0);
    });

    it('never blocks: a failed charge is swallowed; meter does not throw + cursor still advances', async () => {
        vi.stubEnv('BILLING_SOURCE', 'portal');
        mockUsageFindMany.mockResolvedValue([usageRow()]);
        mockUserFindMany.mockResolvedValue([{ id: 'u1' }]);
        mockApplyLedgerEntry.mockRejectedValue(new Error('ledger down'));
        const r = await runShadowMeter(); // must resolve, not reject
        expect(r.charged).toBe(0);
        expect(mockCursorUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ last_log_id: 10 }) }),
        );
    });

    it('passes ref = UsageRecord.id so (charge, ref) makes a re-run idempotent (no double-debit)', async () => {
        vi.stubEnv('BILLING_SOURCE', 'portal');
        mockUsageFindMany.mockResolvedValue([usageRow({ id: 'ur-stable' })]);
        mockUserFindMany.mockResolvedValue([{ id: 'u1' }]);
        await runShadowMeter();
        // the meter keys idempotency on the stable record id; dedup itself is ledger.test.ts's job
        expect(mockApplyLedgerEntry.mock.calls[0][1].ref).toBe('ur-stable');
    });
});

describe('runShadowMeter — P4c-3 dumb-gate sync after charging portal users', () => {
    const usageRow = (over: Record<string, unknown> = {}) => ({
        id: 'ur1',
        user_id: 'u1',
        cost_cny: new Prisma.Decimal('12.5'),
        model_slug: 'gpt-5.4',
        tier: 'pool',
        ...over,
    });

    it('charged a portal user → syncNewapiGate(userId) called once (close/re-top the gate)', async () => {
        vi.stubEnv('BILLING_SOURCE', 'portal');
        mockUsageFindMany.mockResolvedValue([usageRow()]);
        mockUserFindMany.mockResolvedValue([{ id: 'u1' }]);
        await runShadowMeter();
        expect(mockSyncNewapiGate).toHaveBeenCalledTimes(1);
        expect(mockSyncNewapiGate).toHaveBeenCalledWith('u1');
    });

    it('once per DISTINCT charged user (two records same user → one gate sync)', async () => {
        vi.stubEnv('BILLING_SOURCE', 'portal');
        mockUsageFindMany.mockResolvedValue([usageRow({ id: 'ur1' }), usageRow({ id: 'ur2' })]);
        mockUserFindMany.mockResolvedValue([{ id: 'u1' }]);
        await runShadowMeter();
        expect(mockApplyLedgerEntry).toHaveBeenCalledTimes(2); // both records charged
        expect(mockSyncNewapiGate).toHaveBeenCalledTimes(1); // gate synced once for the user
    });

    it('global gate OFF (newapi) → no charge → no gate sync (newapi customers never touched)', async () => {
        // BILLING_SOURCE unset by default
        mockUsageFindMany.mockResolvedValue([usageRow()]);
        mockUserFindMany.mockResolvedValue([{ id: 'u1' }]);
        await runShadowMeter();
        expect(mockSyncNewapiGate).not.toHaveBeenCalled();
    });

    it('a failed charge → that user is NOT gate-synced (only successfully-charged users)', async () => {
        vi.stubEnv('BILLING_SOURCE', 'portal');
        mockUsageFindMany.mockResolvedValue([usageRow()]);
        mockUserFindMany.mockResolvedValue([{ id: 'u1' }]);
        mockApplyLedgerEntry.mockRejectedValue(new Error('ledger down'));
        await runShadowMeter();
        expect(mockSyncNewapiGate).not.toHaveBeenCalled();
    });

    it('never blocks: a failed gate sync is swallowed; meter resolves + cursor still advances', async () => {
        vi.stubEnv('BILLING_SOURCE', 'portal');
        mockUsageFindMany.mockResolvedValue([usageRow()]);
        mockUserFindMany.mockResolvedValue([{ id: 'u1' }]);
        mockSyncNewapiGate.mockRejectedValue(new Error('new-api 502'));
        const r = await runShadowMeter(); // must resolve, not reject
        expect(r.charged).toBe(1);
        expect(mockCursorUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ last_log_id: 10 }) }),
        );
    });
});

describe('reconcileAllPortalGates — P4c-5 §1.5 self-heal (standalone, runs every scheduler tick)', () => {
    it('BILLING_SOURCE=portal: syncs EVERY portal customer gate (not just charged); returns the count', async () => {
        vi.stubEnv('BILLING_SOURCE', 'portal');
        mockUserFindMany.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]);

        const n = await reconcileAllPortalGates();

        expect(mockUserFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { billing_mode: 'portal' } }));
        expect(mockSyncNewapiGate).toHaveBeenCalledTimes(3);
        expect(mockSyncNewapiGate).toHaveBeenCalledWith('p1');
        expect(mockSyncNewapiGate).toHaveBeenCalledWith('p2');
        expect(mockSyncNewapiGate).toHaveBeenCalledWith('p3');
        expect(n).toBe(3);
    });

    it('BILLING_SOURCE unset (default newapi): no-op — no query, no sync (newapi customers untouched)', async () => {
        mockUserFindMany.mockResolvedValue([{ id: 'p1' }]);
        const n = await reconcileAllPortalGates();
        expect(mockUserFindMany).not.toHaveBeenCalled();
        expect(mockSyncNewapiGate).not.toHaveBeenCalled();
        expect(n).toBe(0);
    });

    it('one gate sync failing does not abort the rest or throw; counts only successes', async () => {
        vi.stubEnv('BILLING_SOURCE', 'portal');
        mockUserFindMany.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]);
        mockSyncNewapiGate.mockRejectedValueOnce(new Error('new-api blip')); // p1 fails, p2 still runs
        const n = await reconcileAllPortalGates();
        expect(mockSyncNewapiGate).toHaveBeenCalledTimes(2);
        expect(n).toBe(1);
    });

    it('no portal customers → zero syncs', async () => {
        vi.stubEnv('BILLING_SOURCE', 'portal');
        mockUserFindMany.mockResolvedValue([]);
        const n = await reconcileAllPortalGates();
        expect(mockSyncNewapiGate).not.toHaveBeenCalled();
        expect(n).toBe(0);
    });
});
