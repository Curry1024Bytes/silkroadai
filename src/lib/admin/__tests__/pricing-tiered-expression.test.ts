import { describe, expect, it } from 'vitest';
import {
    parseTieredPricingExpression,
    scaleTieredPricingExpression,
    TieredPricingExpressionError,
    type ParsedTieredPricingExpression,
} from '../pricing-tiered-expression';

const GPT_EXPRESSION =
    'len < 272000 ? tier("base", p * 5 + c * 30 + cr * 0.5) : tier("tier_2", p * 10 + c * 45 + cr * 1)';

// Inputs are already normalized categories. This fixture checks the parsed whole
// request schedule, without interpreting arbitrary source expressions or assuming
// an OpenAI/Anthropic usage normalization policy in the Portal.
function fixtureCharge(
    parsed: ParsedTieredPricingExpression,
    usage: { len: number; p: number; c: number; cr?: number; cc?: number; cc1h?: number },
): number {
    const tier = parsed.tiers.find(
        (candidate) =>
            (candidate.min_input_tokens === null ||
                (candidate.min_inclusive
                    ? usage.len >= candidate.min_input_tokens
                    : usage.len > candidate.min_input_tokens)) &&
            (candidate.max_input_tokens === null ||
                (candidate.max_inclusive
                    ? usage.len <= candidate.max_input_tokens
                    : usage.len < candidate.max_input_tokens)),
    );
    if (!tier) throw new Error('No fixture tier');
    return (
        (usage.p * tier.rates.input +
            usage.c * tier.rates.output +
            (usage.cr ?? 0) * (tier.rates.cache_read ?? 0) +
            (usage.cc ?? 0) * (tier.rates.cache_write ?? 0) +
            (usage.cc1h ?? 0) * (tier.rates.cache_write_1h ?? 0)) /
        1_000_000
    );
}

describe('strict new-api tiered token expression reader', () => {
    it('reads the deployed GPT schedule with full-input, whole-request boundaries and cache prices', () => {
        expect(parseTieredPricingExpression(GPT_EXPRESSION)).toEqual({
            version: 1,
            unit: 'usd_per_million_tokens',
            semantics: 'whole_request',
            input_length: 'full_input_tokens',
            cache_normalization: 'expression_wide',
            used_variables: ['p', 'c', 'cr'],
            tiers: [
                {
                    name: 'base',
                    min_input_tokens: null,
                    max_input_tokens: 272000,
                    min_inclusive: false,
                    max_inclusive: false,
                    rates: { input: 5, output: 30, cache_read: 0.5, cache_write: null, cache_write_1h: null },
                },
                {
                    name: 'tier_2',
                    min_input_tokens: 272000,
                    max_input_tokens: null,
                    min_inclusive: true,
                    max_inclusive: false,
                    rates: { input: 10, output: 45, cache_read: 1, cache_write: null, cache_write_1h: null },
                },
            ],
        });
    });

    it('preserves inclusive thresholds and distinguishes the two cache-write categories', () => {
        const result = parseTieredPricingExpression(
            'v1:len <= 200000 ? tier("normal", p * 3 + c * 15 + cr * 0.3 + cc * 3.75 + cc1h * 6) : ' +
                'len < 400000 ? tier("extended", p * 6 + c * 22.5 + cc1h * 12 + cc * 7.5 + cr * 0.6) : ' +
                'tier("long", p * 12 + c * 45 + cr * 1.2 + cc * 15 + cc1h * 24)',
        );
        expect(result.used_variables).toEqual(['p', 'c', 'cr', 'cc', 'cc1h']);
        expect(
            result.tiers.map(({ min_input_tokens, max_input_tokens, min_inclusive, max_inclusive }) => [
                min_input_tokens,
                max_input_tokens,
                min_inclusive,
                max_inclusive,
            ]),
        ).toEqual([
            [null, 200000, false, true],
            [200000, 400000, false, false],
            [400000, null, true, false],
        ]);
        expect(result.tiers[1].rates).toEqual({
            input: 6,
            output: 22.5,
            cache_read: 0.6,
            cache_write: 7.5,
            cache_write_1h: 12,
        });
    });

    it('uses full len for choosing a tier while applying it to all normalized tokens', () => {
        const parsed = parseTieredPricingExpression(GPT_EXPRESSION);
        expect(fixtureCharge(parsed, { len: 271999, p: 271999, c: 10 })).toBe(1.360295);
        expect(fixtureCharge(parsed, { len: 272000, p: 272000, c: 10 })).toBe(2.72045);
        // A nearly fully cached long request is still in the higher tier.
        expect(fixtureCharge(parsed, { len: 272000, p: 1, cr: 271999, c: 10 })).toBe(0.272459);
    });

    it('keeps explicit zero separate from an absent cache price and tracks variables across branches', () => {
        const parsed = parseTieredPricingExpression(
            'len < 100 ? tier("a", p * 1 + c * 0 + cr * 0) : tier("b", p * 2 + c * 3 + cc1h * 4)',
        );
        expect(parsed.used_variables).toEqual(['p', 'c', 'cr', 'cc1h']);
        expect(parsed.tiers[0].rates.cache_read).toBe(0);
        expect(parsed.tiers[1].rates.cache_read).toBeNull();
        expect(parsed.tiers[0].rates.cache_write_1h).toBeNull();
        expect(parsed.cache_normalization).toBe('expression_wide');
    });

    it('accepts a single explicit tier, harmless grouping, term order, line breaks and scientific literals', () => {
        const parsed = parseTieredPricingExpression('v1:(\n tier("single", cr * 5e-2 + c * 3E+1 + p * 0.5)\n)');
        expect(parsed.tiers).toHaveLength(1);
        expect(parsed.tiers[0]).toMatchObject({
            min_input_tokens: null,
            max_input_tokens: null,
            rates: { input: 0.5, output: 30, cache_read: 0.05 },
        });
        expect(
            parseTieredPricingExpression(
                '(len < 100 ? tier("a", p * 1 + c * 2) : (len <= 200 ? tier("b", p * 2 + c * 3) : tier("c", p * 3 + c * 4)))',
            ).tiers,
        ).toHaveLength(3);
    });

    it.each([
        '',
        'v2:' + GPT_EXPRESSION,
        ' v1:' + GPT_EXPRESSION,
        'p * 5 + c * 30',
        GPT_EXPRESSION + ' ||| header("x", "y")',
        GPT_EXPRESSION + ' + 1',
        'max(0, ' + GPT_EXPRESSION + ')',
        'tier("a", p * 5 + c * 30 + 1)',
        'tier("a", p * (5 + 1) + c * 30)',
        'tier("a", p * 5 * 1.3 + c * 30)',
        'tier("a", p * 5 - c * 30)',
        'tier("a", p * 5 + c * -30)',
        'tier("a", p * +5 + c * 30)',
        'tier("a", p * NaN + c * 30)',
        'tier("a", p * Infinity + c * 30)',
        'tier("a", p * 5 + c * 30 + img * 1)',
        'tier("a", p * 5 + c * 30 + img_o * 1)',
        'tier("a", p * 5 + c * 30 + ai * 1)',
        'tier("a", p * 5 + c * 30 + ao * 1)',
        'tier("a", p * 5 + c * 30 + unknown * 1)',
        'tier("a", c * 30)',
        'tier("a", p * 5)',
        'tier("a", p * 5 + c * 30 + cr * 1 + cr * 2)',
        'tier("a", p * 5 + c * 30 + p * 1)',
        'tier("a", p * 5 + c * 30, 7)',
        'tier("a", p * 5 + c * 30); process.exit()',
        'tier("a\\n", p * 5 + c * 30)',
        'tier("a", p * 05 + c * 30)',
        'tier("a", p * 5. + c * 30)',
        'tier("a", p * .5 + c * 30)',
        'tier("a", p * 0x10 + c * 30)',
        'tier("a", p * 5 /* extra */ + c * 30)',
        'p < 272000 ? tier("a", p * 5 + c * 30) : tier("b", p * 10 + c * 45)',
        'c < 272000 ? tier("a", p * 5 + c * 30) : tier("b", p * 10 + c * 45)',
        'len >= 272000 ? tier("a", p * 5 + c * 30) : tier("b", p * 10 + c * 45)',
        'len == 272000 ? tier("a", p * 5 + c * 30) : tier("b", p * 10 + c * 45)',
        'len < 272000 && p > 0 ? tier("a", p * 5 + c * 30) : tier("b", p * 10 + c * 45)',
        'len < 27.2 ? tier("a", p * 5 + c * 30) : tier("b", p * 10 + c * 45)',
        'len < 2e5 ? tier("a", p * 5 + c * 30) : tier("b", p * 10 + c * 45)',
        'len < 0 ? tier("a", p * 5 + c * 30) : tier("b", p * 10 + c * 45)',
        'len < 100 ? tier("a", p * 5 + c * 30) : tier("a", p * 10 + c * 45)',
        'len < 100 ? tier("a", p * 5 + c * 30) : len < 100 ? tier("b", p * 10 + c * 45) : tier("c", p * 10 + c * 45)',
        'len < 100 ? tier("a", p * 5 + c * 30) : len < 50 ? tier("b", p * 10 + c * 45) : tier("c", p * 10 + c * 45)',
        'len <= 100 ? tier("a", p * 5 + c * 30) : len < 101 ? tier("b", p * 10 + c * 45) : tier("c", p * 10 + c * 45)',
        'len < 100 ? tier("a", p * 5 + c * 30)',
        'len < 100 ? tier("a", p * 5 + c * 30) : p * 0 + c * 0',
        'len < 100 ? len < 50 ? tier("a", p * 5 + c * 30) : tier("b", p * 10 + c * 45) : tier("c", p * 10 + c * 45)',
    ])('rejects the complete unsupported/malformed expression: %s', (expression) => {
        expect(() => parseTieredPricingExpression(expression)).toThrow(TieredPricingExpressionError);
        expect(() => scaleTieredPricingExpression(expression, 1, 1)).toThrow(TieredPricingExpressionError);
    });

    it.each(['1e309', '1e-309', '1e-324', '9007199254740992', '0.1234567890123456789'])(
        'rejects coefficients outside the exact, finite display contract: %s',
        (price) => {
            expect(() => parseTieredPricingExpression(`tier("a", p * ${price} + c * 1)`)).toThrow(
                TieredPricingExpressionError,
            );
        },
    );

    it('limits size, nesting, token count, tier count and threshold integer size', () => {
        const single = 'tier("base", p * 5 + c * 30)';
        expect(() => parseTieredPricingExpression(single + ' '.repeat(16_385))).toThrow(TieredPricingExpressionError);
        expect(() => parseTieredPricingExpression('('.repeat(66) + single + ')'.repeat(66))).toThrow(
            TieredPricingExpressionError,
        );
        expect(() => parseTieredPricingExpression('('.repeat(1100) + single + ')'.repeat(1100))).toThrow(
            TieredPricingExpressionError,
        );
        const tooMany = Array.from({ length: 32 }, (_, i) => `len < ${i + 1} ? tier("t${i}", p * 1 + c * 1)`).join(
            ' : ',
        );
        expect(() => parseTieredPricingExpression(tooMany + ' : tier("last", p * 1 + c * 1)')).toThrow(
            TieredPricingExpressionError,
        );
        expect(() => parseTieredPricingExpression(GPT_EXPRESSION.replace('272000', '9007199254740992'))).toThrow(
            TieredPricingExpressionError,
        );
    });
});

describe('tiered expression price-only scaling', () => {
    it('scales every tier and cache price without changing threshold, labels or formatting', () => {
        const expression =
            'v1:len < 272000 ?\n  tier("base", p * 5 + c * 30 + cr * 0.5) :\n\ttier("tier_2", p * 10 + c * 45 + cr * 1)';
        expect(scaleTieredPricingExpression(expression, 1.6, 10)).toBe(
            'v1:len < 272000 ?\n  tier("base", p * 0.8 + c * 4.8 + cr * 0.08) :\n\ttier("tier_2", p * 1.6 + c * 7.2 + cr * 0.16)',
        );
        const parsed = parseTieredPricingExpression(scaleTieredPricingExpression(GPT_EXPRESSION, 1.6, 10));
        const original = parseTieredPricingExpression(GPT_EXPRESSION);
        for (const len of [0, 1, 271999, 272000, 272001, 1_000_000]) {
            const usage = { len, p: Math.floor(len / 2), cr: len - Math.floor(len / 2), c: 317 };
            expect(fixtureCharge(parsed, usage)).toBeCloseTo(fixtureCharge(original, usage) * 0.16, 12);
        }
    });

    it('computes 1.3-to-1.6 replacement exactly when the source already contains 1.3', () => {
        const alreadyMultiplied =
            'len < 272000 ? tier("base", p * 6.5 + c * 39 + cr * 0.65) : tier("tier_2", p * 13 + c * 58.5 + cr * 1.3)';
        expect(scaleTieredPricingExpression(alreadyMultiplied, 1.6, 1.3)).toBe(
            'len < 272000 ? tier("base", p * 8 + c * 48 + cr * 0.8) : tier("tier_2", p * 16 + c * 72 + cr * 1.6)',
        );
    });

    it('preserves explicit free terms and missing categories, including expression-wide normalization', () => {
        const expression =
            'len <= 100 ? tier("a", cc1h * 8 + p * 1 + c * 2 + cr * 0 + cc * 4) : tier("b", p * 3 + c * 0)';
        const scaled = scaleTieredPricingExpression(expression, 3, 2);
        expect(scaled).toBe(
            'len <= 100 ? tier("a", cc1h * 12 + p * 1.5 + c * 3 + cr * 0 + cc * 6) : tier("b", p * 4.5 + c * 0)',
        );
        expect(parseTieredPricingExpression(scaled).used_variables).toEqual(['p', 'c', 'cr', 'cc', 'cc1h']);
        expect(parseTieredPricingExpression(scaled).tiers[1].rates.cache_read).toBeNull();
    });

    it('uses exact decimal arithmetic at twelve-place half-up boundaries and for repeating fractions', () => {
        expect(scaleTieredPricingExpression('tier("a", p * 0.1 + c * 0.2)', 3, 1)).toBe('tier("a", p * 0.3 + c * 0.6)');
        expect(scaleTieredPricingExpression('tier("a", p * 1 + c * 2)', 1, 3)).toBe(
            'tier("a", p * 0.333333333333 + c * 0.666666666667)',
        );
        expect(scaleTieredPricingExpression('tier("a", p * 0.000000000001 + c * 1)', 1, 2)).toBe(
            'tier("a", p * 0.000000000001 + c * 0.5)',
        );
        expect(scaleTieredPricingExpression('tier("a", p * 0.000000000003 + c * 1)', 1, 2)).toBe(
            'tier("a", p * 0.000000000002 + c * 0.5)',
        );
    });

    it('keeps a no-op byte-for-byte and can scale scientific notation without floating artifacts', () => {
        const expression = 'v1:tier("one", p * 5e-3 + c * 3.00E+1 + cr * 0.0000)';
        expect(scaleTieredPricingExpression(expression, 1.3, 1.3)).toBe(expression);
        expect(scaleTieredPricingExpression(expression, 1.6, 10)).toBe('v1:tier("one", p * 0.0008 + c * 4.8 + cr * 0)');
    });

    it.each([0, -1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
        'rejects invalid scale factor %s',
        (factor) => {
            expect(() => scaleTieredPricingExpression(GPT_EXPRESSION, factor, 1)).toThrow(TieredPricingExpressionError);
            expect(() => scaleTieredPricingExpression(GPT_EXPRESSION, 1, factor)).toThrow(TieredPricingExpressionError);
        },
    );

    it('refuses nonzero charges rounding to free or overflowing representable prices', () => {
        expect(() => scaleTieredPricingExpression('tier("a", p * 1 + c * 2)', 1, 10_000_000_000_000)).toThrow(
            expect.objectContaining({ code: 'pricing_tiered_expression_precision' }),
        );
        expect(() => scaleTieredPricingExpression(GPT_EXPRESSION, Number.MAX_SAFE_INTEGER, 1)).toThrow(
            TieredPricingExpressionError,
        );
        expect(() => scaleTieredPricingExpression(GPT_EXPRESSION, 1, Number.MIN_VALUE)).toThrow(
            TieredPricingExpressionError,
        );
    });
});
