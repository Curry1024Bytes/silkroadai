/**
 * PR-U1 — privacy mask unit tests.
 */
import { describe, expect, it } from 'vitest';
import { maskEmail, customerSeqNo } from '@/lib/reseller/mask';

describe('maskEmail', () => {
    it.each([
        ['alice@gmail.com', 'ali***@gmail.com'],
        ['BOB@example.com', 'bob***@example.com'], // lowercased
        ['  charlie@example.com  ', 'cha***@example.com'], // trimmed
        ['me@x.io', 'm***@x.io'], // 2-char local part → 1 char + ***
        ['x@x.io', 'x***@x.io'], // 1-char local part
        ['longerlocalpart@gmail.com', 'lon***@gmail.com'], // only first 3
    ])('%s → %s', (input, expected) => {
        expect(maskEmail(input)).toBe(expected);
    });

    it.each([
        [null, '—'],
        [undefined, '—'],
        ['', '—'],
        ['   ', '—'],
    ])('blank input → placeholder (%s)', (input, expected) => {
        expect(maskEmail(input as string | null | undefined)).toBe(expected);
    });

    it('malformed inputs return *** (no leak)', () => {
        expect(maskEmail('no-at-sign')).toBe('***');
        expect(maskEmail('@no-local')).toBe('***');
        expect(maskEmail('no-domain@')).toBe('***');
    });
});

describe('customerSeqNo', () => {
    it.each([
        [0, '#001'],
        [1, '#002'],
        [9, '#010'],
        [99, '#100'],
        [999, '#1000'], // beyond 999 → widen, no truncation
    ])('index %s → %s', (i, expected) => {
        expect(customerSeqNo(i)).toBe(expected);
    });

    it('defensive: negative / non-integer returns #000', () => {
        expect(customerSeqNo(-1)).toBe('#000');
        expect(customerSeqNo(1.5)).toBe('#000');
        expect(customerSeqNo(NaN)).toBe('#000');
    });
});
