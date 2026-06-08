import { describe, expect, it } from 'vitest';
import { computeMarginReport, type MarginRow } from '@/lib/billing/margin-report';

const PLAT = '00000000-0000-0000-0000-000000000001';

// gpt: matched 100¥ retail, 2M tok @ ¥30/1M → cost 60, margin 40 (40%). + an unmatched cell
//      (records only, no retail/cost).
// claude: 50¥, 1M @ ¥45 → cost 45, margin 5 (10% → thin).
// loss: 10¥, 1M @ ¥15 → cost 15, margin −5 (−50% → loss).
// nocost: 30¥ retail but no cost price → cost-missing.
const ROWS: MarginRow[] = [
    {
        user_id: 'u1',
        tenant_id: 't1',
        model_slug: 'gpt',
        tier: 'pool',
        matched: true,
        records: 10,
        retailCny: 100,
        tokens: 2_000_000,
        costPricePer1m: 30,
    },
    {
        user_id: 'u1',
        tenant_id: 't1',
        model_slug: 'claude',
        tier: 'pool',
        matched: true,
        records: 5,
        retailCny: 50,
        tokens: 1_000_000,
        costPricePer1m: 45,
    },
    {
        user_id: 'u2',
        tenant_id: 't2',
        model_slug: 'loss',
        tier: 'pool',
        matched: true,
        records: 2,
        retailCny: 10,
        tokens: 1_000_000,
        costPricePer1m: 15,
    },
    {
        user_id: 'u2',
        tenant_id: 't1',
        model_slug: 'nocost',
        tier: 'pool',
        matched: true,
        records: 3,
        retailCny: 30,
        tokens: 500_000,
        costPricePer1m: null,
    },
    {
        user_id: 'u1',
        tenant_id: 't1',
        model_slug: 'gpt',
        tier: 'pool',
        matched: false,
        records: 4,
        retailCny: 0,
        tokens: 800_000,
        costPricePer1m: 30,
    },
];

describe('computeMarginReport', () => {
    const r = computeMarginReport(ROWS, PLAT);

    it('summary: retail (matched), cost (covered tokens×price), margin, rate, coverage', () => {
        expect(r.summary).toMatchObject({
            records: 24, // 10+5+2+3+4 (incl unmatched)
            matchedRecords: 20, // 10+5+2+3
            costCoveredRecords: 17, // gpt+claude+loss (nocost excluded)
            retailCny: 190, // 100+50+10+30
            costCny: 120, // 60+45+15 (nocost contributes 0)
            marginCny: 70,
        });
        expect(r.summary.marginRate).toBeCloseTo(70 / 190, 6);
        expect(r.summary.costCoverage).toBeCloseTo(17 / 20, 6); // 0.85
    });

    it('byModel: per-row margin; unmatched only bumps call count; sorted by retail desc', () => {
        expect(r.byModel.map((m) => m.model_slug)).toEqual(['gpt', 'claude', 'nocost', 'loss']);
        const gpt = r.byModel[0];
        // gpt: matched 10 + unmatched 4 = 14 calls, but retail/cost only from the matched cell
        expect(gpt).toMatchObject({ records: 14, matchedRecords: 10, costCny: 60, marginCny: 40, hasCost: true });
        expect(gpt.marginRate).toBeCloseTo(0.4, 6);
        const claude = r.byModel[1];
        expect(claude.marginRate).toBeCloseTo(0.1, 6); // thin
        const loss = r.byModel[3];
        expect(loss.marginCny).toBe(-5);
        expect(loss.marginRate).toBeCloseTo(-0.5, 6); // losing money
    });

    it('models with retail but no cost price → hasCost=false, cost 0, listed in costMissing', () => {
        const nocost = r.byModel.find((m) => m.model_slug === 'nocost')!;
        expect(nocost).toMatchObject({ hasCost: false, costCny: 0, retailCny: 30, costCoveredRecords: 0 });
        expect(nocost.costCoverage).toBe(0);
        expect(r.costMissing).toEqual([{ model_slug: 'nocost', tier: 'pool', retailCny: 30, records: 3 }]);
    });

    it('byCustomer: per-customer margin + coverage', () => {
        expect(r.byCustomer.map((c) => c.user_id)).toEqual(['u1', 'u2']);
        const u1 = r.byCustomer[0];
        expect(u1).toMatchObject({ retailCny: 150, costCny: 105, marginCny: 45 });
        expect(u1.marginRate).toBeCloseTo(0.3, 6);
        const u2 = r.byCustomer[1];
        expect(u2).toMatchObject({ retailCny: 40, costCny: 15, marginCny: 25 });
        expect(u2.costCoverage).toBeCloseTo(2 / 5, 6); // u2 has a no-cost model
    });

    it('byTenant: per-tenant margin, sorted by retail desc', () => {
        expect(r.byTenant.map((t) => t.tenant_id)).toEqual(['t1', 't2']);
        expect(r.byTenant[0]).toMatchObject({ tenant_id: 't1', retailCny: 180, costCny: 105, marginCny: 75 });
        expect(r.byTenant[1]).toMatchObject({ tenant_id: 't2', retailCny: 10, costCny: 15, marginCny: -5 });
    });

    it('null tenant_id is normalised to the platform tenant id', () => {
        const out = computeMarginReport(
            [
                {
                    user_id: 'u9',
                    tenant_id: null,
                    model_slug: 'x',
                    tier: 'pool',
                    matched: true,
                    records: 1,
                    retailCny: 5,
                    tokens: 0,
                    costPricePer1m: null,
                },
            ],
            PLAT,
        );
        expect(out.byTenant[0].tenant_id).toBe(PLAT);
    });

    it('empty input → zeroed summary, null rates', () => {
        const out = computeMarginReport([], PLAT);
        expect(out.summary).toMatchObject({ records: 0, retailCny: 0, costCny: 0, marginCny: 0 });
        expect(out.summary.marginRate).toBeNull();
        expect(out.summary.costCoverage).toBeNull();
        expect(out.byModel).toEqual([]);
        expect(out.costMissing).toEqual([]);
    });
});
