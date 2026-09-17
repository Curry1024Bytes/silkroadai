import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import CatalogTieredPriceDetails from '../CatalogTieredPriceDetails';

const details = {
    version: 1,
    mode: 'tiered_token',
    unit: 'cny_per_million_tokens',
    semantics: 'whole_request',
    tiers: [
        {
            name: 'base',
            min_input_tokens: null,
            max_input_tokens: 272000,
            min_inclusive: false,
            max_inclusive: false,
            rates: { input: 0.8, output: 4.8, cache_read: 0.08125, cache_write: null, cache_write_1h: null },
        },
        {
            name: 'long',
            min_input_tokens: 272000,
            max_input_tokens: null,
            min_inclusive: true,
            max_inclusive: false,
            rates: { input: 1.6, output: 7.2, cache_read: 0.1625, cache_write: null, cache_write_1h: null },
        },
    ],
};
describe('catalog and history tiered price disclosure', () => {
    it('shows the boundary, whole-request semantics and precise cache price in both tiers', () => {
        const html = renderToStaticMarkup(<CatalogTieredPriceDetails raw={details} en={false} />);
        for (const text of [
            '查看完整价格',
            '整次请求使用该档价格',
            '&lt; 272,000',
            '≥ 272,000',
            '¥0.08125',
            '¥0.1625',
            '¥7.2',
        ])
            expect(html).toContain(text);
        expect(html).not.toContain('缓存写入');
    });
    it('supports English and does not invent tiers for legacy scalar prices', () => {
        expect(renderToStaticMarkup(<CatalogTieredPriceDetails raw={null} en />)).toBe('');
        expect(renderToStaticMarkup(<CatalogTieredPriceDetails raw={details} en />)).toContain('whole request');
    });
    it('reports invalid metadata rather than presenting incomplete prices', () => {
        const html = renderToStaticMarkup(
            <CatalogTieredPriceDetails raw={{ ...details, tiers: [details.tiers[1]] }} en={false} />,
        );
        expect(html).toContain('价格待核对');
        expect(html).not.toContain('¥');
    });
    it('shows a single unbounded tariff as uniform pricing in current and historical catalogs', () => {
        const uniform = { ...details, tiers: [{ ...details.tiers[0], name: 'uniform', max_input_tokens: null }] };
        const html = renderToStaticMarkup(<CatalogTieredPriceDetails raw={uniform} en={false} />);
        expect(html).toContain('统一单价 · 查看价格');
        expect(html).toContain('所有输入长度均使用同一组单价');
        expect(html).toContain('¥0.08125');
        expect(html).not.toContain('阶梯');
        expect(html).not.toContain('272,000');
        expect(renderToStaticMarkup(<CatalogTieredPriceDetails raw={uniform} en />)).toContain('Uniform prices');
    });
});
