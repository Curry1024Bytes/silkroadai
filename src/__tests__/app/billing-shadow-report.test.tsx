/**
 * P4b — <ShadowReport /> reconciliation report SSR smoke.
 *
 * Same shallow renderToString pattern as models-page / balance-alert-form tests.
 * ShadowReport is a pure (hook-free) presentational component, so we feed it
 * deterministic sample data and assert the report surfaces: interpretation copy,
 * the 4 summary cards (portal ¥ / new-api ¥ / diff / coverage), per-row matched%
 * + diff, the big-diff red highlight, unmatched chips with new-api cost, and the
 * by-tenant table (only when >1 tenant).
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';

import { ShadowReport, getTexts, type ShadowData } from '@/app/admin/(console)/billing-shadow/page';

const TWO_TENANTS: ShadowData = {
    period: '30d',
    rangeStart: '2026-05-09T00:00:00.000Z',
    bigDiffThreshold: 0.1,
    summary: {
        records: 3,
        matched: 2,
        unmatched: 1,
        coverage: 2 / 3,
        costCny: 12.5,
        newapiQuota: 950_000,
        newapiCny: 13.68,
        unmatchedNewapiCny: 0.72,
        diffCny: -1.18,
        diffRate: -1.18 / 13.68,
    },
    byModel: [
        {
            model_slug: 'gpt-5.4',
            tier: 'pool',
            records: 2,
            matchedRecords: 2,
            matchedRate: 1,
            costCny: 12.5,
            newapiQuota: 900_000,
            newapiCny: 12.96,
            diffCny: -0.46,
            diffRate: -0.46 / 12.96,
        },
        {
            model_slug: 'claude-x',
            tier: 'pool',
            records: 1,
            matchedRecords: 0,
            matchedRate: 0,
            costCny: 0,
            newapiQuota: 50_000,
            newapiCny: 0.72,
            diffCny: -0.72,
            diffRate: -1, // |−100%| > 10% → big → red
        },
    ],
    byCustomer: [
        {
            user_id: 'u1',
            email: 'a@b.com',
            records: 3,
            costCny: 12.5,
            newapiQuota: 950_000,
            newapiCny: 13.68,
            diffCny: -1.18,
            diffRate: -1.18 / 13.68,
        },
    ],
    byTenant: [
        {
            tenant_id: 'tenant-1',
            slug: 'silkroadai',
            name: 'Silk Road AI',
            records: 2,
            costCny: 12.5,
            newapiQuota: 900_000,
            newapiCny: 12.96,
            diffCny: -0.46,
            diffRate: -0.46 / 12.96,
        },
        {
            tenant_id: 'tenant-2',
            slug: 'partner',
            name: 'Partner Co',
            records: 1,
            costCny: 0,
            newapiQuota: 50_000,
            newapiCny: 0.72,
            diffCny: -0.72,
            diffRate: -1,
        },
    ],
    unmatched: [{ model_slug: 'claude-x', tier: 'pool', records: 1, newapiQuota: 50_000, newapiCny: 0.72 }],
};

const ONE_TENANT: ShadowData = { ...TWO_TENANTS, byTenant: [TWO_TENANTS.byTenant[0]] };

function render(data: ShadowData, locale: 'zh' | 'en' = 'zh') {
    return renderToString(<ShadowReport data={data} t={getTexts(locale)} isDark={false} />);
}

describe('<ShadowReport /> SSR (P4b)', () => {
    it('renders the how-to-read interpretation (shadow + readiness guidance)', () => {
        const html = render(TWO_TENANTS);
        expect(html).toContain('怎么读这份报表');
        expect(html).toContain('未生效、不影响客户');
        expect(html).toContain('计量管道可信'); // readiness-ready guidance
        expect(html).toContain('先给未定价模型配价'); // readiness-not-ready guidance
    });

    it('renders the 4 summary cards incl. coverage % and unmatched share', () => {
        const html = render(TWO_TENANTS);
        expect(html).toContain('portal 计量');
        expect(html).toContain('new-api 实扣');
        expect(html).toContain('覆盖率');
        expect(html).toContain('66.7%'); // coverage 2/3
        expect(html).toContain('-¥1.18'); // signed diff ¥
        expect(html).toContain('其中未配价占实扣'); // unmatched-share line (unmatchedNewapiCny > 0)
    });

    it('byModel rows carry matched% and trigger the big-diff red highlight', () => {
        const html = render(TWO_TENANTS);
        expect(html).toContain('gpt-5.4');
        expect(html).toContain('claude-x');
        expect(html).toContain('100.0%'); // gpt-5.4 fully matched
        expect(html).toContain('0.0%'); // claude-x 0% matched
        // claude-x diffRate −100% exceeds the 10% threshold → red class present
        expect(html).toContain('text-red-500');
        // partial/zero match flagged amber
        expect(html).toContain('text-amber-500');
    });

    it('unmatched chips show the new-api ¥ each unpriced model costs', () => {
        const html = render(TWO_TENANTS);
        expect(html).toContain('未配价');
        expect(html).toContain('claude-x');
        expect(html).toContain('¥0.72');
    });

    it('renders the by-tenant table when there is more than one tenant', () => {
        const html = render(TWO_TENANTS);
        expect(html).toContain('按租户');
        expect(html).toContain('Silk Road AI');
        expect(html).toContain('Partner Co');
    });

    it('omits the by-tenant table when there is only one tenant', () => {
        const html = render(ONE_TENANT);
        expect(html).not.toContain('按租户');
    });

    it('renders the by-customer table', () => {
        const html = render(TWO_TENANTS);
        expect(html).toContain('按客户');
        expect(html).toContain('a@b.com');
    });

    it('renders English copy under locale=en', () => {
        const html = render(TWO_TENANTS, 'en');
        expect(html).toContain('How to read this');
        expect(html).toContain('Coverage');
        expect(html).toContain('By tenant');
    });
});
