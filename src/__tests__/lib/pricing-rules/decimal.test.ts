import { describe, expect, it } from 'vitest';
import {
    ceilToScale,
    compare,
    divide,
    floorToScale,
    multiply,
    parseDecimal,
    plainNumber,
    toDecimalString,
    toNumber,
} from '@/lib/pricing-rules/decimal';

describe('pricing-rules decimal', () => {
    it('parses decimal strings and numbers through their shortest form', () => {
        expect(toDecimalString(parseDecimal('1.200000000000'))).toBe('1.2');
        expect(toDecimalString(parseDecimal(0.1))).toBe('0.1');
        expect(toDecimalString(parseDecimal(3))).toBe('3');
        expect(plainNumber(1e-7)).toBe('0.0000001');
        expect(plainNumber(2.5e21)).toBe('2500000000000000000000');
        expect(() => parseDecimal('1e3')).toThrow();
        expect(() => parseDecimal('abc')).toThrow();
    });

    it('rounds up and down at a decimal scale', () => {
        expect(toDecimalString(ceilToScale(parseDecimal('0.96000001'), 6))).toBe('0.960001');
        expect(toDecimalString(ceilToScale(parseDecimal('0.96'), 6))).toBe('0.96');
        expect(toDecimalString(floorToScale(parseDecimal('0.8333339'), 6))).toBe('0.833333');
    });

    it('keeps a converted legacy multiplier exact after recompiling', () => {
        const unified = parseDecimal('3.4');
        const legacy = parseDecimal('1.5');
        const discount = floorToScale(divide(legacy, unified), 10);
        expect(compare(discount, parseDecimal('0.05'))).toBeGreaterThan(0);
        expect(toNumber(ceilToScale(multiply(unified, discount), 6))).toBe(1.5);
    });

    it('rounds non-decimal fractions half up when printing', () => {
        expect(toDecimalString(divide(parseDecimal('1'), parseDecimal('3')), 4)).toBe('0.3333');
        expect(toDecimalString(divide(parseDecimal('2'), parseDecimal('3')), 4)).toBe('0.6667');
    });
});
