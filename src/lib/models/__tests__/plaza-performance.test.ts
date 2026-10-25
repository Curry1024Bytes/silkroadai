import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/db', () => ({ prisma: {} }));
import { filterPlazaPerformance, filterPlazaPerformanceSummary } from '../plaza-performance';
const measured = { avg_latency_ms: 500, avg_tps: 30, success_rate: 98 };
const model = { slug: 'gpt-5.5', pricesByTier: { retail: null } };
const groups = new Map([
    ['internal-retail', { key: 'retail', label: '标准档' }],
    ['internal-other', { key: 'other', label: '其他档' }],
]);
function group(name: string) {
    return {
        group: name,
        ...measured,
        avg_ttft_ms: 100,
        series: [{ ts: 1, avg_ttft_ms: 100, ...measured }],
        credential: 'secret',
    };
}
describe('plaza performance boundary', () => {
    it('maps and filters exact model memberships without exposing internal names or excluded-group aggregates', () => {
        const value = filterPlazaPerformance(
            {
                success: true,
                data: {
                    model_name: model.slug,
                    groups: [group('internal-retail'), group('internal-other'), group('hidden')],
                    summary: measured,
                    series: [],
                    window_start: 1,
                    window_end: 2,
                },
            },
            model,
            groups,
        );
        expect(value.data.groups).toHaveLength(1);
        expect(value.data.groups[0].group).toBe('标准档');
        expect(value.data).not.toHaveProperty('summary');
        expect(value.data).not.toHaveProperty('series');
        expect(JSON.stringify(value)).not.toContain('secret');
        expect(JSON.stringify(value)).not.toContain('internal');
    });
    it('preserves zero measurements and the upstream aggregate only when every returned group is visible', () => {
        const zero = { avg_latency_ms: 0, avg_tps: 0, success_rate: 0 };
        const value = filterPlazaPerformance(
            {
                success: true,
                data: {
                    model_name: model.slug,
                    groups: [{ group: 'internal-retail', ...zero, avg_ttft_ms: 0, series: [] }],
                    summary: zero,
                },
            },
            model,
            groups,
        );
        expect(value.data.summary).toEqual(zero);
        expect(value.data.groups[0].success_rate).toBe(0);
    });
    it('does not accept the wrong model or synthesize unavailable statistics', () => {
        expect(() =>
            filterPlazaPerformance({ success: true, data: { model_name: 'other', groups: [] } }, model, groups),
        ).toThrow();
        const value = filterPlazaPerformance(
            {
                success: true,
                data: { model_name: model.slug, groups: [{ group: 'internal-retail', success_rate: '100' }] },
            },
            model,
            groups,
        );
        expect(value.data.groups).toEqual([]);
        expect(value.data).not.toHaveProperty('summary');
    });
    it('filters model-wide summaries and recent series to requested public model names', () => {
        const value = filterPlazaPerformanceSummary(
            {
                success: true,
                data: {
                    summary: measured,
                    models: [
                        { model_name: model.slug, ...measured },
                        { model_name: 'hidden', ...measured },
                    ],
                    recent_success_series: {
                        [model.slug]: [{ ts: 1, success_rate: 100 }],
                        hidden: [{ ts: 1, success_rate: 90 }],
                    },
                },
            },
            new Set([model.slug]),
        );
        expect(value.data.models.map((row) => row.model_name)).toEqual([model.slug]);
        expect(Object.keys(value.data.recent_success_series)).toEqual([model.slug]);
        expect(value.data).not.toHaveProperty('summary');
    });
});
