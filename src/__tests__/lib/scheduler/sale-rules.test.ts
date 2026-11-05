import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ count: vi.fn(), tick: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: { pricingBillingGroup: { count: mocks.count } } }));
vi.mock('@/lib/pricing-rules/publish', () => ({ runSaleRuleSchedulerTick: mocks.tick }));

async function load() {
    vi.resetModules();
    return import('@/lib/scheduler/sale-rules');
}

beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PORTAL_FLAVOR;
    delete process.env.PORTAL_SCHEDULERS;
    delete process.env.SALE_RULE_SCHEDULER;
    mocks.tick.mockResolvedValue({ outcome: 'noop', publicationId: null });
});

afterEach(() => {
    delete process.env.PORTAL_FLAVOR;
    delete process.env.PORTAL_SCHEDULERS;
    delete process.env.SALE_RULE_SCHEDULER;
});

describe('sale rule scheduler', () => {
    it('does nothing but count while no billing group is managed', async () => {
        mocks.count.mockResolvedValue(0);
        const { tickSaleRules } = await load();
        await tickSaleRules();
        expect(mocks.tick).not.toHaveBeenCalled();
    });

    it('verifies remotely on the first pass and every tenth after it', async () => {
        mocks.count.mockResolvedValue(1);
        const { tickSaleRules } = await load();
        for (let pass = 0; pass < 11; pass += 1) await tickSaleRules();
        expect(mocks.tick.mock.calls.map(([verify]) => verify)).toEqual([
            true,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            true,
        ]);
    });

    it('logs only the error code and never throws', async () => {
        mocks.count.mockResolvedValue(1);
        mocks.tick.mockRejectedValue(
            Object.assign(new Error('secret upstream body'), { code: 'sale_rules_unverified' }),
        );
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { tickSaleRules } = await load();
        await expect(tickSaleRules()).resolves.toBeUndefined();
        expect(JSON.stringify(warn.mock.calls)).toContain('sale_rules_unverified');
        expect(JSON.stringify(warn.mock.calls)).not.toContain('secret upstream body');
        warn.mockRestore();
    });

    it('follows the Portal scheduler switches', async () => {
        const { saleRuleSchedulerEnabled } = await load();
        expect(saleRuleSchedulerEnabled()).toBe(true);
        process.env.SALE_RULE_SCHEDULER = 'off';
        expect(saleRuleSchedulerEnabled()).toBe(false);
        delete process.env.SALE_RULE_SCHEDULER;
        process.env.PORTAL_SCHEDULERS = 'off';
        expect(saleRuleSchedulerEnabled()).toBe(false);
        delete process.env.PORTAL_SCHEDULERS;
        process.env.PORTAL_FLAVOR = 'seedance-enterprise';
        expect(saleRuleSchedulerEnabled()).toBe(false);
    });
});
