/**
 * Hotfix 2026-05-05 — server-only-guards regression test.
 *
 * Why this test exists
 * --------------------
 * W6 D4 introduced a leak: a 'use client' file (`keys-list.tsx`) imported
 * `quotaToCny` from `@/lib/newapi/client`, which has a module-top-level
 * env check (`if (!NEWAPI_ADMIN_TOKEN) throw`). The bundler doesn't
 * tree-shake the throw away, so the entire module ran in the browser
 * and crashed `/keys` with `Missing required env: NEWAPI_ADMIN_TOKEN`.
 *
 * The hotfix did three things:
 *   1. Extracted the pure helpers (no env, no I/O) to
 *      `src/lib/newapi/quota-units.ts`.
 *   2. Added `import 'server-only'` to modules that legitimately read
 *      admin env / hit the network. With the marker in place, Next /
 *      Turbopack will FAIL `pnpm build` if a 'use client' component
 *      ever tries to import from a guarded module — the regression
 *      becomes a build-time error instead of a runtime crash in prod.
 *   3. Made the admin-env check lazy (inside a function, not at
 *      module top level) so even bundlers that drag the module in for
 *      tree-shake purposes don't evaluate the throw.
 *
 * This test is a static-grep guardrail to keep step 2 honest. If a new
 * server-only module (network calls, DB access via Prisma, secret env
 * reads) lands without `import 'server-only'`, this test fails and
 * forces the author to either:
 *   - add the marker, OR
 *   - move pure helpers out of the module (like quota-units.ts), OR
 *   - explicitly add the file to ALLOWLIST_NO_GUARD with a justification.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const NEWAPI_DIR = path.join(process.cwd(), 'src/lib/newapi');

/**
 * Files in `src/lib/newapi/` that must carry `import 'server-only'`.
 * Anything that calls `process.env.NEWAPI_ADMIN_*`, makes network calls
 * to new-api, or otherwise has server-only side effects belongs here.
 */
const REQUIRES_GUARD = [
    'client.ts',
    'token-usage.ts',
    'usage-aggregate.ts',
    'quota-cache.ts',
    'system-token.ts',
    'pricing-sync.ts',
    // P2.5: pure logic, but imports server-only pricing-sync → guarded too.
    'import-catalog.ts',
];

/**
 * Files in `src/lib/newapi/` that are intentionally client-safe (pure
 * helpers, no env / no I/O). Adding to this allowlist requires the file
 * to be genuinely free of server-only behavior — pure constants and
 * pure functions only.
 *
 * Roster:
 *   - quota-units.ts   pure CNY/USD/quota arithmetic constants + helpers
 *   - token-format.ts  pure idempotent `sk-` prefix formatter (W7 D4 PR-H Tier A)
 */
const ALLOWLIST_NO_GUARD = ['quota-units.ts', 'token-format.ts'];

function readFile(rel: string): string {
    return fs.readFileSync(path.join(NEWAPI_DIR, rel), 'utf-8');
}

describe('server-only guards on src/lib/newapi (hotfix 2026-05-05)', () => {
    it.each(REQUIRES_GUARD)("%s carries `import 'server-only'`", (filename) => {
        const src = readFile(filename);
        // Match either "import 'server-only'" or "import \"server-only\"".
        expect(src).toMatch(/^\s*import\s+['"]server-only['"]/m);
    });

    it.each(ALLOWLIST_NO_GUARD)(
        '%s is genuinely client-safe (no env reads, no server-only marker, no fetch)',
        (filename) => {
            const src = readFile(filename);
            // Must NOT carry the actual import directive at line start.
            // Regex requires the import to be at column 0 (after optional
            // whitespace) — JSDoc comments mentioning `import 'server-only'`
            // for documentation purposes are fine because they're prefixed
            // with ` * ` and won't match `^\s*import`.
            expect(src).not.toMatch(/^\s*import\s+['"]server-only['"]/m);
            // Must NOT actually READ admin secrets at runtime. The strings
            // can appear in JSDoc comments (explaining the boundary), but a
            // real `process.env.NEWAPI_ADMIN_TOKEN` access pattern is fatal.
            expect(src).not.toMatch(/process\.env\.NEWAPI_ADMIN_TOKEN/);
            expect(src).not.toMatch(/process\.env\.NEWAPI_ADMIN_USER_ID/);
            // Must NOT make network calls (heuristic — pure helpers only).
            expect(src).not.toMatch(/\bfetch\s*\(/);
        },
    );

    it('every .ts under src/lib/newapi/ is either guarded or allowlisted (no orphaned server modules)', () => {
        const files = fs
            .readdirSync(NEWAPI_DIR)
            .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
            // Skip __tests__ and types-only files; they're not import targets
            // for client bundles.
            .filter((f) => !f.startsWith('__') && f !== 'types.ts');

        const known = new Set([...REQUIRES_GUARD, ...ALLOWLIST_NO_GUARD]);
        const unknown = files.filter((f) => !known.has(f));
        expect(unknown).toEqual([]);
    });
});

describe('client-component leak prevention (hotfix 2026-05-05)', () => {
    it("'use client' files MUST NOT import from any server-only newapi module", () => {
        const violations: string[] = [];
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === 'node_modules' || entry.name === '.next') continue;
                    walk(fullPath);
                    continue;
                }
                if (!/\.(ts|tsx)$/.test(entry.name)) continue;
                const src = fs.readFileSync(fullPath, 'utf-8');
                // First non-empty, non-comment line check — `'use client'`
                // must be the very top directive in Next.js.
                const firstDirective = src.match(/^(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\n|\s*\n)*\s*(['"][^'"]*['"])/);
                const isClient = firstDirective?.[1]?.includes('use client');
                if (!isClient) continue;

                // Now check if this client file imports any guarded module.
                for (const guarded of REQUIRES_GUARD) {
                    const moduleName = guarded.replace(/\.ts$/, '');
                    // Match  `from '@/lib/newapi/<moduleName>'`  with either quote.
                    const re = new RegExp(`from\\s+['"]@\\/lib\\/newapi\\/${moduleName}['"]`);
                    if (re.test(src)) {
                        violations.push(
                            `${path.relative(process.cwd(), fullPath)} imports from @/lib/newapi/${moduleName} (server-only). ` +
                                `Move pure helpers to quota-units.ts or pass data as props from a server component.`,
                        );
                    }
                }
            }
        };
        walk(path.join(process.cwd(), 'src'));
        expect(violations).toEqual([]);
    });
});
