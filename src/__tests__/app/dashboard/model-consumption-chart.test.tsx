/**
 * 客户控制台三合一 — ModelConsumptionChart SSR safety.
 *
 * The chart is a client component, but Next server-renders client components
 * on first load — so it MUST not throw during renderToString (a throw would
 * 500 the whole /dashboard server render). recharts' ResponsiveContainer
 * renders an empty container under SSR (no width to measure) and hydrates on
 * the client; this test pins that it doesn't blow up with real stack data.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ModelConsumptionChart } from '@/app/(authenticated)/dashboard/model-consumption-chart';

describe('<ModelConsumptionChart /> SSR', () => {
    it('empty data → empty-state text (no recharts)', () => {
        const html = renderToString(<ModelConsumptionChart byDay={[]} models={[]} cnyPerQuota={7 / 1_000_000} />);
        expect(html).toContain('暂无消耗数据');
    });

    it('with stacked data (incl 其他) → renders without throwing', () => {
        const byDay: Array<{ date: string; values: Record<string, number> }> = [
            { date: '2026-06-01', values: { 'gpt-5.4': 400_000, 其他: 50_000 } },
            { date: '2026-06-02', values: { 'gpt-5.4': 100_000 } },
        ];
        expect(() =>
            renderToString(
                <ModelConsumptionChart byDay={byDay} models={['gpt-5.4', '其他']} cnyPerQuota={7 / 1_000_000} />,
            ),
        ).not.toThrow();
    });
});
