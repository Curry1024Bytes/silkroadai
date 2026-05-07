/**
 * Invite-code helper unit tests (W7 D4).
 *
 * Brief calls out three contracts the helper must honor:
 *   1. case-insensitive comparison
 *   2. operator-typed whitespace tolerance
 *   3. empty / unset env var → no codes valid (helper treats absence as
 *      "operator hasn't issued any" rather than as a wildcard)
 *
 * Plus the standard null/undefined/empty-string input handling.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getValidInviteCodes, isValidInviteCode } from '../code';

const ORIGINAL = process.env.INVITE_CODES;

beforeEach(() => {
    delete process.env.INVITE_CODES;
});

afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.INVITE_CODES;
    else process.env.INVITE_CODES = ORIGINAL;
});

describe('getValidInviteCodes', () => {
    it('returns an empty Set when INVITE_CODES is unset', () => {
        expect(getValidInviteCodes()).toEqual(new Set());
    });

    it('returns an empty Set when INVITE_CODES is the empty string', () => {
        process.env.INVITE_CODES = '';
        expect(getValidInviteCodes()).toEqual(new Set());
    });

    it('returns an empty Set when INVITE_CODES is whitespace-only', () => {
        process.env.INVITE_CODES = '   \t\n  ';
        expect(getValidInviteCodes()).toEqual(new Set());
    });

    it('parses comma-separated codes (lowercased + trimmed)', () => {
        process.env.INVITE_CODES = 'LAUNCH-A, FRIEND2026,OPS';
        const codes = getValidInviteCodes();
        expect(codes).toEqual(new Set(['launch-a', 'friend2026', 'ops']));
    });

    it('parses whitespace-separated codes too', () => {
        process.env.INVITE_CODES = 'CODE1 CODE2\nCODE3\tCODE4';
        const codes = getValidInviteCodes();
        expect(codes).toEqual(new Set(['code1', 'code2', 'code3', 'code4']));
    });

    it('drops empty entries (trailing comma / consecutive separators)', () => {
        process.env.INVITE_CODES = 'A,,B,, ,C';
        const codes = getValidInviteCodes();
        expect(codes).toEqual(new Set(['a', 'b', 'c']));
    });
});

describe('isValidInviteCode — null / empty input', () => {
    it('returns false for null', () => {
        expect(isValidInviteCode(null)).toBe(false);
    });

    it('returns false for undefined', () => {
        expect(isValidInviteCode(undefined)).toBe(false);
    });

    it('returns false for empty string (no env defined)', () => {
        expect(isValidInviteCode('')).toBe(false);
    });

    it('returns false for whitespace-only input even with codes set', () => {
        process.env.INVITE_CODES = 'LAUNCH-A';
        expect(isValidInviteCode('   ')).toBe(false);
    });
});

describe('isValidInviteCode — env-driven validity', () => {
    it('returns false when INVITE_CODES env is unset (no codes valid)', () => {
        expect(isValidInviteCode('LAUNCH-A')).toBe(false);
    });

    it('returns true for a code matching the env list', () => {
        process.env.INVITE_CODES = 'LAUNCH-A, FRIEND2026';
        expect(isValidInviteCode('LAUNCH-A')).toBe(true);
        expect(isValidInviteCode('FRIEND2026')).toBe(true);
    });

    it('returns false for a code NOT in the env list', () => {
        process.env.INVITE_CODES = 'LAUNCH-A';
        expect(isValidInviteCode('OTHER-CODE')).toBe(false);
    });

    it('compares case-insensitively (uppercase env, lowercase input)', () => {
        process.env.INVITE_CODES = 'LAUNCH-A';
        expect(isValidInviteCode('launch-a')).toBe(true);
    });

    it('compares case-insensitively (lowercase env, uppercase input)', () => {
        process.env.INVITE_CODES = 'launch-a';
        expect(isValidInviteCode('LAUNCH-A')).toBe(true);
    });

    it('compares case-insensitively (mixed case both sides)', () => {
        process.env.INVITE_CODES = 'LaUnCh-A';
        expect(isValidInviteCode('lAuNcH-a')).toBe(true);
    });

    it('tolerates whitespace around the input code', () => {
        process.env.INVITE_CODES = 'LAUNCH-A';
        expect(isValidInviteCode('  LAUNCH-A  ')).toBe(true);
    });

    it('does NOT match partial / substring inputs', () => {
        process.env.INVITE_CODES = 'LAUNCH-A';
        expect(isValidInviteCode('LAUNCH')).toBe(false);
        expect(isValidInviteCode('LAUNCH-AAA')).toBe(false);
    });
});

describe('isValidInviteCode — soft-revoke behavior', () => {
    it('flips false the moment a code is removed from INVITE_CODES (no caching)', () => {
        process.env.INVITE_CODES = 'LAUNCH-A, OPS';
        expect(isValidInviteCode('OPS')).toBe(true);
        // Operator removes the code from env mid-process (no DB migration
        // needed). Next call sees the new state immediately.
        process.env.INVITE_CODES = 'LAUNCH-A';
        expect(isValidInviteCode('OPS')).toBe(false);
    });

    it('handles env reload back to empty (all soft-revoked)', () => {
        process.env.INVITE_CODES = 'LAUNCH-A';
        expect(isValidInviteCode('LAUNCH-A')).toBe(true);
        process.env.INVITE_CODES = '';
        expect(isValidInviteCode('LAUNCH-A')).toBe(false);
    });
});
