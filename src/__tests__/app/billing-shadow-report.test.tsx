/**
 * P4b-v2 — <ShadowReport /> margin report SSR smoke (零售/成本/毛利).
 *
 * Pure (hook-free) component fed deterministic sample data. Asserts: how-to copy
 * (new-api not involved + margin highlight + approximations), the 4 summary cards
 * (retail / cost / margin / coverage), per-row margin with loss=red / thin=amber,
 * cost-missing rows shown as "—" + listed, by-tenant (>1 only), and that the old
 * new-api quota / diff口径 is gone.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';

import { ShadowReport, getTexts, type ShadowData } from '@/app/admin/(console)/billing-shadow/page';

const TWO_TENANTS: ShadowData = {
    period: '30d',
    rangeStart: '2026-05-09T00:00:00.000Z',
    marginYellowThreshold: 0.2,
    summary: {
        records: 24,
        matchedRecords: 20,
        costCoveredRecords: 17,
        retailCny: 190,
        costCny: 120,
        marginCny: 70,
        marginRate: 70 / 190,
        costCoverage: 17 / 20,
    },
    byModel: [
        {
            model_slug: 'gpt',
            tier: 'pool',
            records: 14,
            matchedRecords: 10,
            costCoveredRecords: 10,
            retailCny: 100,
            costCny: 60,
            marginCny: 40,
            marginRate: 0.4,
            costCoverage: 1,
            hasCost: true,
        },
        {
            model_slug: 'claude',
            tier: 'pool',
            records: 5,
            matchedRecords: 5,
            costCoveredRecords: 5,
            retailCny: 50,
            costCny: 45,
            marginCny: 5,
            marginRate: 0.1,
            costCoverage: 1,
            hasCost: true,
        }, // thin → amber
        {
            model_slug: 'nocost',
            tier: 'pool',
            records: 3,
            matchedRecords: 3,
            costCoveredRecords: 0,
            retailCny: 30,
            costCny: 0,
            marginCny: 30,
            marginRate: 1,
            costCoverage: 0,
            hasCost: false,
        }, // → —
        {
            model_slug: 'loss',
            tier: 'pool',
            records: 2,
            matchedRecords: 2,
            costCoveredRecords: 2,
            retailCny: 10,
            costCny: 15,
            marginCny: -5,
            marginRate: -0.5,
            costCoverage: 1,
            hasCost: true,
        }, // loss → red
    ],
    byCustomer: [
        {
            user_id: 'u1',
            email: 'a@b.com',
            records: 19,
            matchedRecords: 15,
            costCoveredRecords: 15,
            retailCny: 150,
            costCny: 105,
            marginCny: 45,
            marginRate: 0.3,
            costCoverage: 1,
        },
    ],
    byTenant: [
        {
            tenant_id: 't1',
            slug: 'plat',
            name: 'Platform',
            records: 22,
            matchedRecords: 18,
            costCoveredRecords: 15,
            retailCny: 180,
            costCny: 105,
            marginCny: 75,
            marginRate: 75 / 180,
            costCoverage: 15 / 18,
        },
        {
            tenant_id: 't2',
            slug: 'partner',
            name: 'Partner',
            records: 2,
            matchedRecords: 2,
            costCoveredRecords: 2,
            retailCny: 10,
            costCny: 15,
            marginCny: -5,
            marginRate: -0.5,
            costCoverage: 1,
        },
    ],
    costMissing: [{ model_slug: 'nocost', tier: 'pool', retailCny: 30, records: 3 }],
};

const ONE_TENANT: ShadowData = { ...TWO_TENANTS, byTenant: [TWO_TENANTS.byTenant[0]] };

function render(data: ShadowData, locale: 'zh' | 'en' = 'zh') {
    return renderToString(<ShadowReport data={data} t={getTexts(locale)} isDark={false} />);
}

describe('<ShadowReport /> SSR (P4b-v2)', () => {
    it('how-to block explains retail/cost/margin, new-api not involved, approximations', () => {
        const html = render(TWO_TENANTS);
        expect(html).toContain('怎么读这份报表');
        expect(html).toContain('new-api 不参与');
        expect(html).toContain('重点盯红行'); // margin-highlight guidance
        expect(html).toContain('待补成本清单一起看'); // approximation note (avoid the HTML-escaped < )
    });

    it('summary cards: retail / cost / margin / coverage', () => {
        const html = render(TWO_TENANTS);
        expect(html).toContain('零售总额');
        expect(html).toContain('成本总额');
        expect(html).toContain('成本覆盖率');
        expect(html).toContain('¥190'); // retail
        expect(html).toContain('¥120'); // cost
        expect(html).toContain('¥70'); // margin
        expect(html).toContain('85.0%'); // coverage 17/20
    });

    it('byModel: loss row red, thin row amber, cost-missing shown as —', () => {
        const html = render(TWO_TENANTS);
        expect(html).toContain('gpt');
        expect(html).toContain('loss');
        expect(html).toContain('text-red-500'); // loss margin −50%
        expect(html).toContain('text-amber-500'); // claude 10% thin + coverage <100%
        expect(html).toContain('—'); // nocost cost/margin dashes
    });

    it('cost-missing list surfaces unpriced-cost models with their retail', () => {
        const html = render(TWO_TENANTS);
        expect(html).toContain('待补成本');
        expect(html).toContain('nocost');
        expect(html).toContain('¥30');
    });

    it('by-tenant table shows only with >1 tenant', () => {
        expect(render(TWO_TENANTS)).toContain('按租户');
        expect(render(TWO_TENANTS)).toContain('Platform');
        expect(render(ONE_TENANT)).not.toContain('按租户');
    });

    it('by-customer table renders email', () => {
        const html = render(TWO_TENANTS);
        expect(html).toContain('按客户');
        expect(html).toContain('a@b.com');
    });

    it('the old new-api quota / diff口径 is gone', () => {
        const html = render(TWO_TENANTS);
        expect(html).not.toContain('new-api 实扣'); // v1 card label
        expect(html).not.toContain('portal 计量'); // v1 card label
        expect(html).not.toContain('差异'); // v1 diff column/label
    });

    it('English copy under locale=en', () => {
        const html = render(TWO_TENANTS, 'en');
        expect(html).toContain('How to read this');
        expect(html).toContain('Retail total');
        expect(html).toContain('Cost coverage');
        expect(html).toContain('new-api is not involved');
    });
});
