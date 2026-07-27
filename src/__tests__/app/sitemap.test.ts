/**
 * sitemap.ts + robots.ts host-source regression test.
 *
 * Both routes pull the public origin from `APP_URL` (preferred, runtime-
 * overridable) → `NEXT_PUBLIC_APP_URL` (build-inlined fallback) → a
 * hardcoded `https://llmroute.club` default.
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
        process.env.APP_URL = 'https://llmroute.club';
        process.env.NEXT_PUBLIC_APP_URL = 'https://localhost'; // Dockerfile build dummy
        const sitemap = await loadSitemap();
        const entries = sitemap();
        expect(entries.length).toBeGreaterThan(0);
        for (const e of entries) {
            expect(e.url, `entry ${JSON.stringify(e)} must use APP_URL host`).toMatch(
                /^https:\/\/llmroute\.club(\/|$)/,
            );
            expect(e.url).not.toContain('localhost');
        }
    });

    it('falls back to NEXT_PUBLIC_APP_URL when APP_URL is unset', async () => {
        delete process.env.APP_URL;
        process.env.NEXT_PUBLIC_APP_URL = 'https://staging.llmroute.club';
        const sitemap = await loadSitemap();
        const entries = sitemap();
        for (const e of entries) {
            expect(e.url).toMatch(/^https:\/\/staging\.llmroute\.club(\/|$)/);
        }
    });

    it('falls back to https://llmroute.club default when both env vars are unset', async () => {
        delete process.env.APP_URL;
        delete process.env.NEXT_PUBLIC_APP_URL;
        const sitemap = await loadSitemap();
        const entries = sitemap();
        for (const e of entries) {
            expect(e.url).toMatch(/^https:\/\/llmroute\.club(\/|$)/);
        }
    });

    it('strips trailing slash on the base URL (no double-slash in entries)', async () => {
        process.env.APP_URL = 'https://llmroute.club/';
        const sitemap = await loadSitemap();
        const entries = sitemap();
        for (const e of entries) {
            // Entry URL is `${base}/path` — base must not carry the slash
            // through, so the URL pattern is exactly `https://host/path`,
            // never `https://host//path`.
            expect(new URL(e.url).pathname).not.toContain('//');
            expect(e.url).toMatch(/^https:\/\/llmroute\.club(\/|$)/);
        }
    });
});

describe('sitemap.ts — public-route inclusion', () => {
    it('includes the public routes (W7 D4: /portal/register + /docs)', async () => {
        process.env.APP_URL = 'https://llmroute.club';
        const sitemap = await loadSitemap();
        const urls = sitemap().map((e) => e.url);

        // Required entries — these pages exist in src/app and are public.
        expect(urls).toContain('https://llmroute.club/');
        expect(urls).toContain('https://llmroute.club/models');
        expect(urls).toContain('https://llmroute.club/login');
        expect(urls).toContain('https://llmroute.club/terms');
        expect(urls).toContain('https://llmroute.club/privacy');
        expect(urls).toContain('https://llmroute.club/refund');

        // W7 D4: /portal/register added now that the real signup page
        // ships. PR #28 had this excluded as the page didn't exist yet.
        expect(urls).toContain('https://llmroute.club/portal/register');

        // W7 D4 PR-G: public integration docs page.
        expect(urls).toContain('https://llmroute.club/docs');

        // W7 PR-P: GPU rental landing — H100 / H200 / B300.
        expect(urls).toContain('https://llmroute.club/gpu');
    });

    it('declares /gpu at priority 0.7 (W7 PR-P public marketing tier)', async () => {
        process.env.APP_URL = 'https://llmroute.club';
        const sitemap = await loadSitemap();
        const gpu = sitemap().find((e) => e.url === 'https://llmroute.club/gpu');
        expect(gpu, 'sitemap must include /gpu').toBeDefined();
        expect(gpu!.priority).toBe(0.7);
        expect(gpu!.changeFrequency).toBe('weekly');
    });

    it('declares / (apex) at priority 1.0 — the canonical landing surface', async () => {
        process.env.APP_URL = 'https://llmroute.club';
        const sitemap = await loadSitemap();
        const root = sitemap().find((e) => e.url === 'https://llmroute.club/');
        expect(root, 'sitemap must include the apex /').toBeDefined();
        expect(root!.priority).toBe(1.0);
    });
});

describe('robots.ts — host source precedence', () => {
    it('uses APP_URL for the Sitemap reference', async () => {
        process.env.APP_URL = 'https://llmroute.club';
        process.env.NEXT_PUBLIC_APP_URL = 'https://localhost';
        const robots = await loadRobots();
        const r = robots();
        expect(r.sitemap).toBe('https://llmroute.club/sitemap.xml');
    });

    it('falls back to NEXT_PUBLIC_APP_URL when APP_URL is unset', async () => {
        delete process.env.APP_URL;
        process.env.NEXT_PUBLIC_APP_URL = 'https://staging.llmroute.club';
        const robots = await loadRobots();
        const r = robots();
        expect(r.sitemap).toBe('https://staging.llmroute.club/sitemap.xml');
    });

    it('disallows the customer dashboard + admin + api surfaces', async () => {
        process.env.APP_URL = 'https://llmroute.club';
        const robots = await loadRobots();
        const rules = robots().rules;
        const rulesArray = Array.isArray(rules) ? rules : [rules];
        const disallow = rulesArray.flatMap((r) =>
            Array.isArray(r.disallow) ? r.disallow : r.disallow ? [r.disallow] : [],
        );
        for (const path of ['/admin', '/api/', '/dashboard', '/keys', '/balance', '/usage', '/pay', '/portal/']) {
            expect(disallow, `robots.txt must disallow ${path}`).toContain(path);
        }
    });

    it('allows the public marketing routes including /gpu (W7 PR-P)', async () => {
        process.env.APP_URL = 'https://llmroute.club';
        const robots = await loadRobots();
        const rules = robots().rules;
        const rulesArray = Array.isArray(rules) ? rules : [rules];
        const allow = rulesArray.flatMap((r) => (Array.isArray(r.allow) ? r.allow : r.allow ? [r.allow] : []));
        for (const path of ['/', '/pricing', '/models', '/docs', '/gpu', '/terms', '/privacy', '/refund']) {
            expect(allow, `robots.txt must allow ${path}`).toContain(path);
        }
    });
});
