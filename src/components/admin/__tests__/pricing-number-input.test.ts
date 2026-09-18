import { describe, expect, it } from 'vitest';
import { pricingNumberFromInput, pricingNumberInput } from '../pricing-number-input';

describe('imported pricing numbers', () => {
    it.each([
        [0.39999999999999997, '0.4'],
        [0.19999999999999998, '0.2'],
        [0.1 + 0.2, '0.3'],
        [0.6000000000000001, '0.6'],
    ])('cleans a floating-point tail in %s', (value, expected) => {
        expect(pricingNumberInput(value)).toBe(expected);
        expect(pricingNumberFromInput(expected, value)).toBe(value);
    });

    it.each([1e-18, Number.MIN_VALUE, 0.40000000000001, 1.2345678901234567, 0.12345678901234567])(
        'retains the meaningful precision of %s without fixed decimal places',
        (value) => expect(pricingNumberInput(value)).toBe(String(value)),
    );

    it('keeps missing, invalid and zero values distinct', () => {
        expect([null, undefined, NaN, Infinity].map(pricingNumberInput)).toEqual(['', '', '', '']);
        expect(pricingNumberInput(0)).toBe('0');
        expect(pricingNumberFromInput('')).toBeNull();
        expect(pricingNumberFromInput('0')).toBe(0);
    });

    it('does not normalize or truncate a newly entered price', () => {
        expect(pricingNumberFromInput('0.40000000000001', 0.39999999999999997)).toBe(0.40000000000001);
        expect(pricingNumberFromInput('1.2345678901234567')).toBe(1.2345678901234567);
        expect(pricingNumberFromInput('2e-18')).toBe(2e-18);
    });
});
