/**
 * W7 D4 PR-J Bug 1 — `getAppUrl()` env precedence.
 *
 * Background: Next.js inlines `NEXT_PUBLIC_*` env reads at build time as
 * string literals (server-side too, in standalone builds). Compose supplies
 * the correct production value during the build, while `APP_URL` remains the
 * runtime override. The helper reads APP_URL first, with NEXT_PUBLIC_APP_URL
 * as a build-time fallback and a hardcoded dev default last. These tests pin
 * that precedence even when an image was built for a different origin.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEV_FALLBACK_APP_URL, getAppUrl } from '../app-url';

describe('getAppUrl — precedence', () => {
    const ORIGINAL_APP_URL = process.env.APP_URL;
    const ORIGINAL_NEXT_PUBLIC = process.env.NEXT_PUBLIC_APP_URL;

    beforeEach(() => {
        delete process.env.APP_URL;
        delete process.env.NEXT_PUBLIC_APP_URL;
    });

    afterEach(() => {
        if (ORIGINAL_APP_URL === undefined) delete process.env.APP_URL;
        else process.env.APP_URL = ORIGINAL_APP_URL;
        if (ORIGINAL_NEXT_PUBLIC === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
        else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_NEXT_PUBLIC;
    });

    it('exports the dev fallback as a constant', () => {
        expect(DEV_FALLBACK_APP_URL).toBe('http://localhost:3002');
    });

    it('APP_URL alone → wins', () => {
        process.env.APP_URL = 'https://llmroute.club';
        expect(getAppUrl()).toBe('https://llmroute.club');
    });

    it('NEXT_PUBLIC_APP_URL alone → used (build-time fallback)', () => {
        process.env.NEXT_PUBLIC_APP_URL = 'https://llmroute.club';
        expect(getAppUrl()).toBe('https://llmroute.club');
    });

    it('both set → APP_URL wins (this is the prod case post-fix)', () => {
        // APP_URL is the runtime escape hatch when an image was built for a
        // different public origin.
        process.env.APP_URL = 'https://llmroute.club';
        process.env.NEXT_PUBLIC_APP_URL = 'https://build-origin.example.com';
        expect(getAppUrl()).toBe('https://llmroute.club');
    });

    it('neither set → dev fallback (so e2e debug logs stay readable)', () => {
        expect(getAppUrl()).toBe('http://localhost:3002');
    });

    it('empty-string APP_URL falls through to NEXT_PUBLIC_APP_URL', () => {
        // `||` semantics — empty string is falsy. Defensive behaviour
        // for `APP_URL=` (declared but not assigned) lines in .env.
        process.env.APP_URL = '';
        process.env.NEXT_PUBLIC_APP_URL = 'https://llmroute.club';
        expect(getAppUrl()).toBe('https://llmroute.club');
    });

    it('empty-string both → dev fallback', () => {
        process.env.APP_URL = '';
        process.env.NEXT_PUBLIC_APP_URL = '';
        expect(getAppUrl()).toBe('http://localhost:3002');
    });
});
