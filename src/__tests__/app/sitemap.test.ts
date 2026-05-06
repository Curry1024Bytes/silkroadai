/**
 * sitemap.ts + robots.ts host-source regression test.
 *
 * Both routes pull the public origin from `APP_URL` (preferred, runtime-
 * overridable) → `NEXT_PUBLIC_APP_URL` (build-inlined fallback) → a
 * hardcoded `https://silkroadai.io` default.
 *
 * Background: Phase 6a's first prod deploy of the landing page baked
 * `https://localhost` into `sitemap.xml` because the Dockerfile only
 * passed a `NEXT_PUBLIC_APP_URL` build dummy and Next prerenders
 * sitemap.xml at build time. The fix wires a real `APP_URL` build-arg
 * through the Dockerfile; this test guards the precedence so the regression
 * can't sneak back via either env var being clobbered.
 *
 * The test re-imports the module under a fresh env so each precedence
 * path can be exercised — a single import would cache whichever value
 * was set when the file first loaded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_APP_URL = process.env.APP_URL;
const ORIGINAL_PUBLIC = process.env.NEXT_PUBLIC_APP_URL;

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    if (ORIGINAL_APP_URL === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = ORIGINAL_APP_URL;
    if (ORIGINAL_PUBLIC === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_PUBLIC;
});

async function loadSitemap() {
    const mod = await import('@/app/sitemap');
    return mod.default;
}

async function loadRobots() {
    const mod = await import('@/app/robots');
    return mod.default;
}

describe('sitemap.ts — host source precedence', () => {
    it('uses APP_URL when set (the prod path)', async () => {
        process.env.APP_URL = 'https://silkroadai.io';
        process.env.NEXT_PUBLIC_APP_URL = 'https://localhost'; // Dockerfile build dummy
        const sitemap = await loadSitemap();
        const entries = sitemap();
        expect(entries.length).toBeGreaterThan(0);
        for (const e of entries) {
            expect(e.url, `entry ${JSON.stringify(e)} must use APP_URL host`)
                .toMatch(/^https:\/\/silkroadai\.io(\/|$)/);
            expect(e.url).not.toContain('localhost');
        }
    });

    it('falls back to NEXT_PUBLIC_APP_URL when APP_URL is unset', async () => {
        delete process.env.APP_URL;
        process.env.NEXT_PUBLIC_APP_URL = 'https://staging.silkroadai.io';
        const sitemap = await loadSitemap();
        const entries = sitemap();
        for (const e of entries) {
            expect(e.url).toMatch(/^https:\/\/staging\.silkroadai\.io(\/|$)/);
        }
    });

    it('falls back to https://silkroadai.io default when both env vars are unset', async () => {
        delete process.env.APP_URL;
        delete process.env.NEXT_PUBLIC_APP_URL;
        const sitemap = await loadSitemap();
        const entries = sitemap();
        for (const e of entries) {
            expect(e.url).toMatch(/^https:\/\/silkroadai\.io(\/|$)/);
        }
    });

    it('strips trailing slash on the base URL (no double-slash in entries)', async () => {
        process.env.APP_URL = 'https://silkroadai.io/';
        const sitemap = await loadSitemap();
        const entries = sitemap();
        for (const e of entries) {
            // Entry URL is `${base}/path` — base must not carry the slash
            // through, so the URL pattern is exactly `https://host/path`,
            // never `https://host//path`.
            expect(e.url).not.toMatch(/\/\/(?!silkroadai)/);
            expect(e.url).toMatch(/^https:\/\/silkroadai\.io(\/|$)/);
        }
    });
});

describe('sitemap.ts — public-route inclusion', () => {
    it('includes the routes that exist + excludes /portal/register (W7 D3 fix)', async () => {
        process.env.APP_URL = 'https://silkroadai.io';
        const sitemap = await loadSitemap();
        const urls = sitemap().map((e) => e.url);

        // Required entries — these pages exist in src/app and are public.
        expect(urls).toContain('https://silkroadai.io/');
        expect(urls).toContain('https://silkroadai.io/models');
        expect(urls).toContain('https://silkroadai.io/login');
        expect(urls).toContain('https://silkroadai.io/terms');
        expect(urls).toContain('https://silkroadai.io/privacy');
        expect(urls).toContain('https://silkroadai.io/refund');

        // /portal/register is intentionally absent: the route doesn't exist
        // in src/app yet (W7 D4 follow-up). Listing it in sitemap.xml would
        // ship 404s to search engines.
        expect(urls).not.toContain('https://silkroadai.io/portal/register');
    });

    it('declares / (apex) at priority 1.0 — the canonical landing surface', async () => {
        process.env.APP_URL = 'https://silkroadai.io';
        const sitemap = await loadSitemap();
        const root = sitemap().find((e) => e.url === 'https://silkroadai.io/');
        expect(root, 'sitemap must include the apex /').toBeDefined();
        expect(root!.priority).toBe(1.0);
    });
});

describe('robots.ts — host source precedence', () => {
    it('uses APP_URL for the Sitemap reference', async () => {
        process.env.APP_URL = 'https://silkroadai.io';
        process.env.NEXT_PUBLIC_APP_URL = 'https://localhost';
        const robots = await loadRobots();
        const r = robots();
        expect(r.sitemap).toBe('https://silkroadai.io/sitemap.xml');
    });

    it('falls back to NEXT_PUBLIC_APP_URL when APP_URL is unset', async () => {
        delete process.env.APP_URL;
        process.env.NEXT_PUBLIC_APP_URL = 'https://staging.silkroadai.io';
        const robots = await loadRobots();
        const r = robots();
        expect(r.sitemap).toBe('https://staging.silkroadai.io/sitemap.xml');
    });

    it('disallows the customer dashboard + admin + api surfaces', async () => {
        process.env.APP_URL = 'https://silkroadai.io';
        const robots = await loadRobots();
        const rules = robots().rules;
        const rulesArray = Array.isArray(rules) ? rules : [rules];
        const disallow = rulesArray.flatMap((r) =>
            Array.isArray(r.disallow) ? r.disallow : r.disallow ? [r.disallow] : [],
        );
        for (const path of [
            '/admin',
            '/api/',
            '/dashboard',
            '/keys',
            '/balance',
            '/usage',
            '/pay',
            '/portal/',
        ]) {
            expect(disallow, `robots.txt must disallow ${path}`).toContain(path);
        }
    });
});
