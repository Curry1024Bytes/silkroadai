/**
 * PR-U1 — reseller code validation unit tests.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { validateAndNormalizeCode, normalizeForLookup, MAX_CODE_LENGTH } from '@/lib/reseller/code';

describe('validateAndNormalizeCode', () => {
    const originalEnv = process.env.INVITE_CODES;
    afterEach(() => {
        if (originalEnv === undefined) delete process.env.INVITE_CODES;
        else process.env.INVITE_CODES = originalEnv;
    });

    it('uppercases + accepts a valid code', () => {
        const r = validateAndNormalizeCode('frank-wx-2026');
        expect(r.ok).toBe(true);
        expect(r.code).toBe('FRANK-WX-2026');
    });

    it('preserves an already-uppercase code', () => {
        const r = validateAndNormalizeCode('ALPHA1');
        expect(r.ok).toBe(true);
        expect(r.code).toBe('ALPHA1');
    });

    it.each([
        ['AB', 'length'],
        ['A'.repeat(MAX_CODE_LENGTH + 1), 'length'],
    ])('rejects out-of-range length (%s)', (code, errType) => {
        const r = validateAndNormalizeCode(code);
        expect(r.ok).toBe(false);
        expect(r.error).toBe(errType);
    });

    it.each([['HAS SPACE'], ['has_underscore'], ['unicode-喵'], ['!@#$%^']])('rejects bad characters (%s)', (code) => {
        const r = validateAndNormalizeCode(code);
        expect(r.ok).toBe(false);
        expect(r.error).toBe('format');
    });

    it('rejects when code collides with env INVITE_CODES allow-list (calibration #3)', () => {
        process.env.INVITE_CODES = 'launch-a, beta-1';
        const r = validateAndNormalizeCode('launch-A');
        expect(r.ok).toBe(false);
        expect(r.error).toBe('env_collision');
    });

    it('non-string input rejected gracefully', () => {
        // @ts-expect-error testing runtime defense
        expect(validateAndNormalizeCode(123).ok).toBe(false);
    });
});

describe('normalizeForLookup', () => {
    it.each([
        ['  frank-wx  ', 'FRANK-WX'],
        ['ALPHA1', 'ALPHA1'],
        ['', null],
        ['   ', null],
        [null, null],
        [undefined, null],
    ])('%s → %s', (input, expected) => {
        expect(normalizeForLookup(input as string | null | undefined)).toBe(expected);
    });
});
