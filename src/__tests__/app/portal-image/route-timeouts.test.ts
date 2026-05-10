/**
 * PR-T2 504 fix — pin the upstream + image-fetch + maxDuration
 * timeouts via source grep.
 *
 * These constants need to stay in sync with Caddy's `read_timeout` on
 * the portal upstream block. If anyone bumps the portal timeouts down
 * again without bumping Caddy in lockstep, customers re-experience
 * the 504 from the original PR-T2 launch smoke. This test exists to
 * make a regression loud.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROUTE_PATH = path.join(process.cwd(), 'src/app/api/portal/image/generate/route.ts');

describe('image/generate route timeouts (PR-T2 504 fix sentinel)', () => {
    const src = fs.readFileSync(ROUTE_PATH, 'utf-8');

    it('upstream fetch AbortSignal is at least 180s (matches Caddy 300s headroom)', () => {
        // Match `AbortSignal.timeout(180_000)` or `(180000)` etc.
        const matches = [...src.matchAll(/AbortSignal\.timeout\(\s*(\d[\d_]*)\s*\)/g)];
        expect(matches.length).toBeGreaterThanOrEqual(2);
        const ms = matches.map((m) => Number(m[1].replace(/_/g, '')));
        // Upstream call (longest) — at least 180s
        const longest = Math.max(...ms);
        expect(longest).toBeGreaterThanOrEqual(180_000);
        // R2/image-fetch (shorter) — at least 60s
        const shortest = Math.min(...ms);
        expect(shortest).toBeGreaterThanOrEqual(60_000);
    });

    it('maxDuration export is at least 180s (Vercel-only, harmless on VPS)', () => {
        const m = src.match(/export const maxDuration\s*=\s*(\d+)/);
        expect(m).not.toBeNull();
        expect(Number(m![1])).toBeGreaterThanOrEqual(180);
    });
});
