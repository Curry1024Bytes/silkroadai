import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import type { OptionWrite } from '@/lib/admin/pricing-simple-core';

const m = vi.hoisted(() => ({
    binding: { findMany: vi.fn(), updateMany: vi.fn() },
    registry: { findFirst: vi.fn() },
    changes: { create: vi.fn(), updateMany: vi.fn() },
    options: vi.fn(),
    channel: vi.fn(),
    status: vi.fn(),
    matrix: vi.fn(),
    context: vi.fn(),
    writer: vi.fn(),
    txBinding: vi.fn(),
    txChanges: vi.fn(),
    directOption: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        customerPricingBinding: m.binding,
        customerModelBillingGroup: m.registry,
        customerPricingChange: m.changes,
    },
}));
vi.mock('@/lib/newapi/client', () => ({
    getPricingPublishOptions: m.options,
    getChannelStrict: m.channel,
    setChannelStatusStrict: m.status,
    putSaleRuleOption: m.matrix,
    putOption: m.directOption,
}));
vi.mock('@/lib/newapi/user-tier-multiplier', () => ({ internalNewApiUserGroup: (user: string) => `user-${user}` }));
vi.mock('../context', () => ({ loadOfficialContext: m.context }));
import { withCustomerPricingRebase, assertLegacyPriceWriteAllowed, recoverCustomerPricingRebase } from '../rebase';

const tx = {
    customerPricingBinding: { findMany: m.binding.findMany, updateMany: m.txBinding },
    customerPricingChange: { updateMany: m.txChanges },
} as unknown as Prisma.TransactionClient;
const binding = {
    id: 'binding-1',
    user_id: 'alice',
    tier_key: 'tier-a',
    public_group: 'public',
    model_groups: ['private-a'],
    status: 'active',
};
let options: Record<string, unknown>;
let status: number;
let events: string[];
const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const decode = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : (v as Record<string, number>));

beforeEach(() => {
    vi.clearAllMocks();
    options = {
        ModelPrice: { 'model-a': 0.3, unrelated: 3 },
        GroupRatio: { public: 1 },
        GroupGroupRatio: { 'user-alice': { 'private-a': 0.666666666667, other: 0.9 }, untouched: { another: 0.5 } },
    };
    status = 1;
    events = [];
    m.binding.findMany.mockResolvedValue([binding]);
    m.binding.updateMany.mockResolvedValue({ count: 1 });
    m.changes.create.mockImplementation(async () => {
        events.push('journal');
        return { id: 'change-1' };
    });
    m.changes.updateMany.mockResolvedValue({ count: 1 });
    m.options.mockImplementation(async () => copy(options));
    m.channel.mockImplementation(async () => ({ id: 101, group: 'private-a', models: 'model-a', status }));
    m.status.mockImplementation(async (_id, next) => {
        events.push(`status:${next}`);
        status = next;
    });
    m.matrix.mockImplementation(async (key, value) => {
        events.push('matrix');
        options[key] = JSON.parse(value);
    });
    m.directOption.mockImplementation(async (key, value) => {
        options[key] = JSON.parse(value);
    });
    m.writer.mockImplementation(async (writes: OptionWrite[]) => {
        events.push('base');
        for (const write of writes) options[write.key] = copy(write.value);
        return copy(options);
    });
    m.context.mockImplementation(async (_user, _db, input) => {
        const price = Number(decode(input.pricingOptions.ModelPrice)['model-a']);
        const publicRatio = Number(decode(input.pricingOptions.GroupRatio).public);
        return {
            rules: [{ id: 'rule-tier', tier_key: 'tier-a', model_id: null, official_multiplier: 0.2, revision: 1 }],
            registry: [
                {
                    id: 'registry',
                    tier_key: 'tier-a',
                    model_id: 'model-id',
                    internal_group: 'private-a',
                    status: 'active',
                    replica_channel_ids: [101],
                },
            ],
            tiers: [
                {
                    key: 'tier-a',
                    public_group: 'public',
                    public_ratio: publicRatio,
                    legacy_multiplier: null,
                    models: [
                        {
                            model_id: 'model-id',
                            model_name: 'model-a',
                            reference_available: true,
                            cells: [
                                {
                                    key: 'call',
                                    label: 'call',
                                    unit: 'call',
                                    official_cny: 1,
                                    base_cny: price,
                                    public_cny: price * publicRatio,
                                    cost_cny: 0.1,
                                },
                            ],
                        },
                    ],
                },
            ],
        };
    });
});

const reprice = (value = 0.4): OptionWrite[] => [
    { key: 'ModelPrice', value: { 'model-a': value, unrelated: 3 }, entry: 'model-a', target: value },
];

describe('public price changes preserve customer official prices', () => {
    it('keeps the original raw writer and zero additional network calls when no bindings exist', async () => {
        m.binding.findMany.mockResolvedValue([]);
        const writes = reprice();
        await withCustomerPricingRebase(tx, writes, m.writer);
        expect(m.writer).toHaveBeenCalledExactlyOnceWith(writes);
        expect(m.options).not.toHaveBeenCalled();
        expect(m.context).not.toHaveBeenCalled();
        expect(m.changes.create).not.toHaveBeenCalled();
    });

    it('changes the public base .3 to .4 while the customer remains at official price × .2', async () => {
        await withCustomerPricingRebase(tx, reprice(), m.writer, { beforeOptions: copy(options) });
        const native = decode(options.GroupGroupRatio)['user-alice'] as unknown as Record<string, number>;
        expect(native['private-a']).toBe(0.5);
        expect(native['private-a'] * 0.4).toBe(0.2);
        expect(native.other).toBe(0.9);
        expect(decode(options.GroupGroupRatio).untouched).toEqual({ another: 0.5 });
        expect(events).toEqual(['journal', 'status:2', 'base', 'matrix', 'status:1']);
        expect(m.txChanges).toHaveBeenLastCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'applied' }) }),
        );
        expect(m.binding.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'applying' } }));
        expect(m.txBinding).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'active' } }));
        expect(m.changes.updateMany).not.toHaveBeenCalled();
    });

    it('selects the model rule before the customer tier rule', async () => {
        const context = m.context.getMockImplementation()!;
        m.context.mockImplementation(async (...args) => {
            const c = await context(...args);
            c.rules.push({
                id: 'rule-model',
                tier_key: 'tier-a',
                model_id: 'model-id',
                official_multiplier: 0.15,
                revision: 1,
            });
            return c;
        });
        await withCustomerPricingRebase(tx, reprice(), m.writer);
        expect(decode(options.GroupGroupRatio)['user-alice']).toMatchObject({ 'private-a': 0.375 });
    });

    it.each(['applying', 'failed'])('refuses public writes while any customer binding remains %s', async (state) => {
        m.binding.findMany.mockResolvedValue([{ ...binding, status: state }]);
        await expect(withCustomerPricingRebase(tx, reprice(), m.writer)).rejects.toMatchObject({
            code: 'pricing_rebase_pending',
        });
        expect(m.writer).not.toHaveBeenCalled();
        expect(m.status).not.toHaveBeenCalled();
    });

    it('leaves durable applying and pending journal when the caller aborts after remote success', async () => {
        let durableBinding = 'active';
        let durableChange = 'absent';
        const staged: unknown[] = [];
        m.binding.updateMany.mockImplementation(async ({ data }) => {
            durableBinding = data.status;
        });
        m.changes.create.mockImplementation(async () => {
            durableChange = 'applying';
            return { id: 'change-1' };
        });
        m.txBinding.mockImplementation(async (value) => {
            staged.push(value);
        });
        m.txChanges.mockImplementation(async (value) => {
            staged.push(value);
        });
        await expect(
            (async () => {
                await withCustomerPricingRebase(tx, reprice(), m.writer);
                // CatalogPrice/audit/COMMIT failure discards local staged changes.
                staged.length = 0;
                throw new Error('local catalog transaction aborted');
            })(),
        ).rejects.toThrow('local catalog transaction aborted');
        expect(durableBinding).toBe('applying');
        expect(durableChange).toBe('applying');
        expect(m.changes.updateMany).not.toHaveBeenCalled();
        expect(decode(options.ModelPrice)['model-a']).toBe(0.4);
        expect(status).toBe(1);
    });

    it('does not perform global compensation while failed local finalization may still hold locks', async () => {
        m.txChanges.mockRejectedValueOnce(new Error('local database error'));
        await expect(withCustomerPricingRebase(tx, reprice(), m.writer)).rejects.toThrow('local database error');
        expect(m.binding.updateMany).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ data: { status: 'applying' } }),
        );
        expect(m.changes.updateMany).not.toHaveBeenCalled();
    });

    it('keeps a legacy absolute group rate rather than multiplying it by the new public rate', async () => {
        const context = m.context.getMockImplementation()!;
        m.context.mockImplementation(async (...args) => {
            const c = await context(...args);
            c.rules = [];
            c.tiers[0].legacy_multiplier = 0.8;
            return c;
        });
        await withCustomerPricingRebase(
            tx,
            [{ key: 'GroupRatio', value: { public: 0.4 }, entry: 'public', target: 0.4 }],
            m.writer,
        );
        expect(decode(options.GroupGroupRatio)['user-alice']).toMatchObject({ 'private-a': 0.8 });
    });

    it('rejects non-proportional official rate cells before any channel or option write', async () => {
        const context = m.context.getMockImplementation()!;
        m.context.mockImplementation(async (...args) => {
            const c = await context(...args);
            c.tiers[0].models[0].cells.push({
                key: 'other',
                label: 'other',
                unit: 'call',
                official_cny: 2,
                base_cny: 0.9,
                public_cny: 0.9,
                cost_cny: null,
            });
            return c;
        });
        await expect(withCustomerPricingRebase(tx, reprice(), m.writer)).rejects.toMatchObject({
            code: 'nonproportional_reference',
        });
        expect(m.writer).not.toHaveBeenCalled();
        expect(m.status).not.toHaveBeenCalled();
        expect(m.changes.create).not.toHaveBeenCalled();
    });

    it('restores the original base and matrix after a partially committed base write fails', async () => {
        const writer = m.writer.getMockImplementation()!;
        let first = true;
        m.writer.mockImplementation(async (...args) => {
            const result = await writer(...args);
            if (first) {
                first = false;
                throw new Error('lost write response');
            }
            return result;
        });
        await expect(withCustomerPricingRebase(tx, reprice(), m.writer)).rejects.toMatchObject({
            code: 'pricing_rebase_failed',
        });
        expect(decode(options.ModelPrice)['model-a']).toBe(0.3);
        expect(decode(options.GroupGroupRatio)['user-alice']).toMatchObject({ 'private-a': 0.666666666667 });
        expect(status).toBe(1);
        expect(m.changes.updateMany).toHaveBeenLastCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'compensated' }) }),
        );
    });

    it('keeps affected replicas disabled if the rollback cannot be verified', async () => {
        m.matrix.mockRejectedValue(new Error('matrix write failed'));
        const writer = m.writer.getMockImplementation()!;
        let first = true;
        m.writer.mockImplementation(async (...args) => {
            if (!first) throw new Error('rollback write unavailable');
            first = false;
            return writer(...args);
        });
        await expect(withCustomerPricingRebase(tx, reprice(), m.writer)).rejects.toMatchObject({
            code: 'pricing_rebase_failed',
        });
        expect(status).toBe(2);
        expect(m.status).not.toHaveBeenCalledWith(101, 1);
        expect(m.binding.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'failed' } }));
        expect(m.changes.updateMany).toHaveBeenLastCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
        );
    });

    it('never pauses a source channel or an externally reassigned replica', async () => {
        m.channel.mockResolvedValue({ id: 101, group: 'public', models: 'model-a', status: 1 });
        await expect(withCustomerPricingRebase(tx, reprice(), m.writer)).rejects.toMatchObject({
            code: 'pricing_rebase_replica',
        });
        expect(m.status).not.toHaveBeenCalled();
    });

    it('refuses legacy direct model writes only when that model has an active managed binding', async () => {
        m.registry.findFirst.mockResolvedValue({ id: 'owned' });
        await expect(assertLegacyPriceWriteAllowed('model-a')).rejects.toMatchObject({
            code: 'pricing_official_managed',
        });
        m.registry.findFirst.mockResolvedValue(null);
        await expect(assertLegacyPriceWriteAllowed('unrelated-model')).resolves.toBeUndefined();
    });

    it('recovers durable public-price deltas and customer ratios while preserving unrelated new entries', async () => {
        const original = copy(options);
        await withCustomerPricingRebase(tx, reprice(), m.writer);
        const persisted = m.changes.create.mock.calls[0][0].data;
        options.ModelPrice = { ...decode(options.ModelPrice), later: 9 };
        const rows = decode(options.GroupGroupRatio);
        rows.later_customer = { later_group: 0.7 } as unknown as number;
        options.GroupGroupRatio = rows;
        await recoverCustomerPricingRebase(persisted.before, persisted.after);
        expect(decode(options.ModelPrice)).toEqual({ ...decode(original.ModelPrice), later: 9 });
        expect(decode(options.GroupGroupRatio)['user-alice']).toEqual(decode(original.GroupGroupRatio)['user-alice']);
        expect(decode(options.GroupGroupRatio).later_customer).toEqual({ later_group: 0.7 });
        expect(status).toBe(1);
        // A retry after a failed local recovery COMMIT is safe.
        await recoverCustomerPricingRebase(persisted.before, persisted.after);
        expect(status).toBe(1);
        expect(decode(options.ModelPrice)['model-a']).toBe(0.3);
    });

    it('does not overwrite a public price entry changed by another operation during recovery', async () => {
        await withCustomerPricingRebase(tx, reprice(), m.writer);
        const persisted = m.changes.create.mock.calls[0][0].data;
        options.ModelPrice = { ...decode(options.ModelPrice), 'model-a': 0.9 };
        await expect(recoverCustomerPricingRebase(persisted.before, persisted.after)).rejects.toMatchObject({
            code: 'pricing_rebase_stale',
        });
        expect(decode(options.ModelPrice)['model-a']).toBe(0.9);
        expect(status).toBe(2);
    });

    it('leaves replicas paused if recovery cannot verify the original customer ratios', async () => {
        await withCustomerPricingRebase(tx, reprice(), m.writer);
        const persisted = m.changes.create.mock.calls[0][0].data;
        m.matrix.mockResolvedValue(undefined);
        await expect(recoverCustomerPricingRebase(persisted.before, persisted.after)).rejects.toMatchObject({
            code: 'pricing_rebase_unverified',
        });
        expect(status).toBe(2);
    });
});
