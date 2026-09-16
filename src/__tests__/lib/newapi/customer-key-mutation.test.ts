import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ $transaction: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: db }));

import { customerKeyMutationTimeout, withCustomerKeyMutation } from '@/lib/newapi/customer-key-mutation';
import { assertPricingCatalogWritable } from '@/lib/admin/pricing-publish-lock';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import type { Prisma } from '@prisma/client';

let retiredTier: string | null;
let tierAvailable: boolean;
let transactionLive: boolean;
const tx = {
    pricingPublishCoordinator: {
        upsert: vi.fn(async () => {
            if (!transactionLive) throw new Error('transaction ended');
            return { active_job_id: null };
        }),
    },
    channelGroupRetirementJob: {
        findFirst: vi.fn(async ({ where }: { where: { tier_key?: string; id?: { not: string } } }) =>
            retiredTier && (!where.tier_key || where.tier_key === retiredTier) && where.id?.not !== 'job-a'
                ? { id: 'job-a' }
                : null,
        ),
    },
    channelGroup: { findFirst: vi.fn(async () => (tierAvailable ? { id: 'tier-a' } : null)) },
};
const scope = { tenantId: null, tierKey: 'a', newapiGroup: 'upstream-a' };

beforeEach(() => {
    retiredTier = null;
    tierAvailable = true;
    transactionLive = true;
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (work) => work(tx));
});
afterEach(() => vi.restoreAllMocks());

describe('customer key lifecycle retirement barrier', () => {
    it('blocks a retiring tier before credential creation, including a historical null platform tenant', async () => {
        retiredTier = 'a';
        const create = vi.fn();
        await expect(withCustomerKeyMutation(scope, create)).rejects.toMatchObject({ code: 'tier_retiring' });
        expect(create).not.toHaveBeenCalled();
        expect(tx.channelGroupRetirementJob.findFirst).toHaveBeenCalledWith({
            where: {
                OR: [{ tenant_id: PLATFORM_TENANT_ID }, { tenant_id: null }],
                tier_key: 'a',
                status: { notIn: ['succeeded', 'cancelled'] },
            },
            select: { id: true },
        });
    });

    it('keeps a different tier available while A awaits revocation recovery', async () => {
        retiredTier = 'a';
        const create = vi.fn(async () => 'created-b');
        await expect(
            withCustomerKeyMutation({ ...scope, tierKey: 'b', newapiGroup: 'upstream-b' }, create),
        ).resolves.toBe('created-b');
        expect(create).toHaveBeenCalledWith(tx);
    });

    it('rejects a stale default or deleted group after taking the shared mutex', async () => {
        tierAvailable = false;
        const create = vi.fn();
        await expect(withCustomerKeyMutation({ ...scope, requireDefault: true }, create)).rejects.toMatchObject({
            code: 'tier_unavailable',
        });
        expect(create).not.toHaveBeenCalled();
        expect(tx.channelGroup.findFirst).toHaveBeenCalledWith({
            where: {
                tenant_id: PLATFORM_TENANT_ID,
                key: 'a',
                newapi_group: 'upstream-a',
                enabled: true,
                is_default: true,
            },
            select: { id: true },
        });
    });

    it('retains the mutex through remote creation and local persistence; a later retirement sees the key', async () => {
        const events: string[] = [];
        let finishRemote!: () => void;
        const remote = new Promise<void>((resolve) => (finishRemote = resolve));
        let tail: Promise<unknown> = Promise.resolve();
        db.$transaction.mockImplementation((work) => {
            const running = tail.then(() => work(tx));
            tail = running.catch(() => undefined);
            return running;
        });
        const created = withCustomerKeyMutation(scope, async () => {
            events.push('remote started');
            await remote;
            await customerKeyMutationTimeout();
            events.push('key persisted');
        });
        await vi.waitFor(() => expect(events).toEqual(['remote started']));
        const retire = db.$transaction(async () => {
            retiredTier = 'a';
            events.push('retirement snapshot');
        });
        await vi.waitFor(() => expect(events).toEqual(['remote started']));
        finishRemote();
        await Promise.all([created, retire]);
        expect(events).toEqual(['remote started', 'key persisted', 'retirement snapshot']);
    });

    it('does not allow a delayed remote call or local persistence after transaction loss', async () => {
        await expect(
            withCustomerKeyMutation(scope, async () => {
                transactionLive = false;
                await customerKeyMutationTimeout();
            }),
        ).rejects.toThrow('transaction ended');
    });

    it('caps individual calls and rejects a lifecycle that has exceeded its write deadline', async () => {
        const time = vi.spyOn(Date, 'now').mockReturnValue(1_000);
        await withCustomerKeyMutation(scope, async () => {
            expect(await customerKeyMutationTimeout()).toBe(10_000);
            time.mockReturnValue(91_001);
            await expect(customerKeyMutationTimeout()).rejects.toMatchObject({ code: 'key_mutation_expired' });
        });
        expect(await customerKeyMutationTimeout()).toBeUndefined();
    });

    it('blocks catalog writes during unfinished revocation, while permitting that job to finalize', async () => {
        retiredTier = 'a';
        await expect(assertPricingCatalogWritable(tx as unknown as Prisma.TransactionClient)).rejects.toMatchObject({
            code: 'channel_group_retirement_busy',
        });
        await expect(
            assertPricingCatalogWritable(tx as unknown as Prisma.TransactionClient, { retirementJobId: 'job-a' }),
        ).resolves.toBeUndefined();
    });
});
