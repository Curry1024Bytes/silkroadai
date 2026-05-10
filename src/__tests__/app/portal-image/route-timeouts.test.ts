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

    it('UPSTREAM_TIMEOUT_MS constant is at least 180s (matches Caddy 300s headroom)', () => {
        const m = src.match(/const\s+UPSTREAM_TIMEOUT_MS\s*=\s*(\d[\d_]*)\s*;/);
        expect(m).not.toBeNull();
        const ms = Number(m![1].replace(/_/g, ''));
        expect(ms).toBeGreaterThanOrEqual(180_000);
    });

    it('URL_FETCH_TIMEOUT_MS constant is at least 60s (R2-download phase)', () => {
        const m = src.match(/const\s+URL_FETCH_TIMEOUT_MS\s*=\s*(\d[\d_]*)\s*;/);
        expect(m).not.toBeNull();
        const ms = Number(m![1].replace(/_/g, ''));
        expect(ms).toBeGreaterThanOrEqual(60_000);
    });

    it('maxDuration export is at least 180s (Vercel-only, harmless on VPS)', () => {
        const m = src.match(/export const maxDuration\s*=\s*(\d+)/);
        expect(m).not.toBeNull();
        expect(Number(m![1])).toBeGreaterThanOrEqual(180);
    });
});
