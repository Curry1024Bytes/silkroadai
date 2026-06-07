import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── mocks ──
const mockQueryLogs = vi.fn();
const mockCursorUpsert = vi.fn();
const mockCursorUpdate = vi.fn();
const mockUserFindUnique = vi.fn();
const mockTokenFindUnique = vi.fn();
const mockModelFindFirst = vi.fn();
const mockUsageCreateMany = vi.fn();

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
        user: { findUnique: (...a: unknown[]) => mockUserFindUnique(...a) },
        newApiToken: { findUnique: (...a: unknown[]) => mockTokenFindUnique(...a) },
        catalogModel: { findFirst: (...a: unknown[]) => mockModelFindFirst(...a) },
        usageRecord: { createMany: (...a: unknown[]) => mockUsageCreateMany(...a) },
    },
}));

import { runShadowMeter } from '@/lib/billing/meter';
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
