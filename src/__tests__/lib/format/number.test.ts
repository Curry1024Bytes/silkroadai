import { describe, it, expect } from 'vitest';
import { formatCny, formatUsd, formatCount, formatTokens } from '@/lib/format/number';

describe('formatCny', () => {
    it('keeps small amounts exact with thousands separators', () => {
        expect(formatCny(7.2)).toEqual({ display: '7.20', unit: '', exact: '¥7.20', compact: false });
        expect(formatCny(1284.5)).toEqual({ display: '1,284.50', unit: '', exact: '¥1,284.50', compact: false });
        expect(formatCny(99_999.99)).toEqual({
            display: '99,999.99',
            unit: '',
            exact: '¥99,999.99',
            compact: false,
        });
    });

    it('switches to 万 at 100,000 and keeps the exact value', () => {
        expect(formatCny(100_000)).toEqual({ display: '10.00', unit: '万', exact: '¥100,000.00', compact: true });
        expect(formatCny(290_262.82)).toEqual({
            display: '29.03',
            unit: '万',
            exact: '¥290,262.82',
            compact: true,
        });
        expect(formatCny(1_215_773.1)).toEqual({
            display: '121.58',
            unit: '万',
            exact: '¥1,215,773.10',
            compact: true,
        });
    });

    it('handles zero, negative and non-finite input', () => {
        expect(formatCny(0).display).toBe('0.00');
        expect(formatCny(-150_000)).toEqual({ display: '-15.00', unit: '万', exact: '¥-150,000.00', compact: true });
        expect(formatCny(Number.NaN).display).toBe('0.00');
    });
});

describe('formatUsd', () => {
    it('adds thousands separators and 2 decimals, never compacts', () => {
        expect(formatUsd(1)).toBe('$1.00');
        expect(formatUsd(40_314.2805)).toBe('$40,314.28');
        expect(formatUsd(Number.NaN)).toBe('$0.00');
    });
});

describe('formatCount', () => {
    it('keeps counts under 10,000 as plain integers', () => {
        expect(formatCount(0)).toEqual({ display: '0', unit: '', exact: '0', compact: false });
        expect(formatCount(250)).toEqual({ display: '250', unit: '', exact: '250', compact: false });
        expect(formatCount(9_999)).toEqual({ display: '9,999', unit: '', exact: '9,999', compact: false });
    });

    it('switches to 万 with one decimal at 10,000', () => {
        expect(formatCount(10_000)).toEqual({ display: '1.0', unit: '万', exact: '10,000', compact: true });
        expect(formatCount(2_184_903)).toEqual({ display: '218.5', unit: '万', exact: '2,184,903', compact: true });
    });

    it('rounds fractional input to an integer', () => {
        expect(formatCount(12.6).display).toBe('13');
    });
});

describe('formatTokens', () => {
    it('keeps token counts under 10,000 as plain integers', () => {
        expect(formatTokens(0)).toEqual({ display: '0', unit: '', exact: '0', compact: false });
        expect(formatTokens(9_999)).toEqual({ display: '9,999', unit: '', exact: '9,999', compact: false });
    });

    it('uses K / M / B with three significant digits', () => {
        expect(formatTokens(10_000)).toEqual({ display: '10.0', unit: 'K', exact: '10,000', compact: true });
        expect(formatTokens(20_000)).toEqual({ display: '20.0', unit: 'K', exact: '20,000', compact: true });
        expect(formatTokens(123_456)).toEqual({ display: '123', unit: 'K', exact: '123,456', compact: true });
        expect(formatTokens(42_601_118)).toEqual({ display: '42.6', unit: 'M', exact: '42,601,118', compact: true });
        expect(formatTokens(1_000_719_906)).toEqual({
            display: '1.00',
            unit: 'B',
            exact: '1,000,719,906',
            compact: true,
        });
    });

    it('promotes to the next unit when rounding would show 1,000', () => {
        expect(formatTokens(999_950)).toEqual({ display: '1.00', unit: 'M', exact: '999,950', compact: true });
        expect(formatTokens(999_500_000)).toEqual({ display: '1.00', unit: 'B', exact: '999,500,000', compact: true });
    });

    it('never exceeds three integer digits in the display', () => {
        for (const n of [10_000, 99_999, 999_499, 1_000_000, 999_499_999, 12_345_678_901]) {
            const intPart = formatTokens(n).display.split('.')[0].replace(/,/g, '').replace('-', '');
            expect(intPart.length, `n=${n}`).toBeLessThanOrEqual(3);
        }
    });
});

describe('English locale (K / M / B instead of 万)', () => {
    it('formatCny keeps the same threshold but compacts with K / M', () => {
        expect(formatCny(99_999.99, 'en').compact).toBe(false);
        expect(formatCny(290_262.82, 'en')).toEqual({
            display: '290.26',
            unit: 'K',
            exact: '¥290,262.82',
            compact: true,
        });
        expect(formatCny(1_215_773.1, 'en')).toEqual({
            display: '1.22',
            unit: 'M',
            exact: '¥1,215,773.10',
            compact: true,
        });
    });

    it('formatCount compacts with one decimal', () => {
        expect(formatCount(9_999, 'en')).toEqual({ display: '9,999', unit: '', exact: '9,999', compact: false });
        expect(formatCount(2_184_903, 'en')).toEqual({ display: '2.2', unit: 'M', exact: '2,184,903', compact: true });
        expect(formatCount(12_345, 'en')).toEqual({ display: '12.3', unit: 'K', exact: '12,345', compact: true });
    });

    it('zh output is unchanged when the locale is passed explicitly', () => {
        expect(formatCny(290_262.82, 'zh')).toEqual(formatCny(290_262.82));
        expect(formatCount(2_184_903, 'zh')).toEqual(formatCount(2_184_903));
    });
});
