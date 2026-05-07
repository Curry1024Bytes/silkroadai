/**
 * brandCookieDomain() — env-driven cookie domain helper.
 *
 * Background: W7 D3 collapsed OAuth from portal.silkroadai.io to apex
 * silkroadai.io. The state/pkce/session cookies were host-scoped (no
 * Domain= attribute), so apex-issued state cookies were invisible at the
 * subdomain callback → state_mismatch. This helper centralizes the
 * Domain attribute so setSessionCookie + the four OAuth handlers
 * (google/start, google/callback, github/start, github/callback) stay
 * in lock-step. If they disagree the browser stores both versions and
 * Next's cookie parser picks one non-deterministically.
 *
 * Contract:
 *   - BRAND_COOKIE_DOMAIN unset → undefined (host-scoped fallback)
 *   - BRAND_COOKIE_DOMAIN="" → undefined (explicit opt-out)
 *   - BRAND_COOKIE_DOMAIN=".silkroadai.io" → ".silkroadai.io"
 *   - Any non-empty string → returned verbatim (no parsing/validation)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brandCookieDomain } from '../session';

const ORIGINAL = process.env.BRAND_COOKIE_DOMAIN;

beforeEach(() => {
    delete process.env.BRAND_COOKIE_DOMAIN;
});

afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.BRAND_COOKIE_DOMAIN;
    else process.env.BRAND_COOKIE_DOMAIN = ORIGINAL;
});

describe('brandCookieDomain', () => {
    it('returns undefined when BRAND_COOKIE_DOMAIN is unset', () => {
        expect(brandCookieDomain()).toBeUndefined();
    });

    it('returns undefined when BRAND_COOKIE_DOMAIN is the empty string', () => {
        // Explicit opt-out so an operator can clear the env var without
        // having to delete the line in .env.
        process.env.BRAND_COOKIE_DOMAIN = '';
        expect(brandCookieDomain()).toBeUndefined();
    });

    it('returns ".silkroadai.io" when set to that exact value (prod default)', () => {
        process.env.BRAND_COOKIE_DOMAIN = '.silkroadai.io';
        expect(brandCookieDomain()).toBe('.silkroadai.io');
    });

    it('returns the staging eTLD+1 verbatim when set to a staging domain', () => {
        process.env.BRAND_COOKIE_DOMAIN = '.staging.silkroadai.io';
        expect(brandCookieDomain()).toBe('.staging.silkroadai.io');
    });

    it('does NOT validate or normalize the input — value passes through as-is', () => {
        // We intentionally avoid hostname parsing; if an operator sets a
        // bad value it surfaces immediately at runtime (browser refuses
        // the Set-Cookie) rather than getting silently rewritten.
        process.env.BRAND_COOKIE_DOMAIN = 'silkroadai.io'; // no leading dot
        expect(brandCookieDomain()).toBe('silkroadai.io');
    });

    it('treats whitespace as a real value (callers responsible for trimming)', () => {
        process.env.BRAND_COOKIE_DOMAIN = ' .silkroadai.io ';
        expect(brandCookieDomain()).toBe(' .silkroadai.io ');
    });
});
