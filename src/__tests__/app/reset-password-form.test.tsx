/**
 * W4-2 D7 Sweep 2 — <ResetPasswordForm /> render smoke + fired-guard
 * structural assertion.
 *
 * The repo doesn't have jsdom + RTL set up, so we can't simulate two rapid
 * user clicks and assert fetch was called once. Instead we verify:
 *   1. The form renders the expected inputs + submit button.
 *   2. The implementation contains the firedRef guard pattern (a static
 *      source-grep — equivalent to what /verify-email's firedRef test would
 *      look like if it had to live without RTL).
 * Behavioral correctness is exercised via the W3 D4 e2e suite + manual smoke.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ResetPasswordForm } from '@/app/reset-password/reset-password-form';

describe('<ResetPasswordForm /> render smoke', () => {
    it('renders password + confirm inputs + submit button', () => {
        const html = renderToString(<ResetPasswordForm token={'a'.repeat(64)} />);
        expect(html).toMatch(/<input[^>]*type="password"/);
        // Submit button text — exact wording matched in the source
        expect(html).toContain('提交');
        // No error / success state on initial render
        expect(html).not.toContain('已重置');
        expect(html).not.toContain('请稍后重试');
    });
});

describe('<ResetPasswordForm /> fired-guard pattern (W4-2 D7 sweep)', () => {
    // Static source assertion — without jsdom we can't simulate two clicks,
    // so we verify the guard is at least structurally present in the file.
    // If a future refactor removes it, this test fails loudly.
    it('source contains useRef + fired guard before async work', () => {
        const path = join(process.cwd(), 'src/app/reset-password/reset-password-form.tsx');
        const source = readFileSync(path, 'utf-8');
        // Imports useRef
        expect(source).toMatch(/import\s*{[^}]*\buseRef\b/);
        // A `fired` ref exists, initialized to false. TypeScript may
        // infer the boolean type from the literal, so the explicit
        // <boolean> annotation is optional.
        expect(source).toMatch(/const\s+fired\s*=\s*useRef(<[^>]+>)?\s*\(\s*false\s*\)/);
        // onSubmit short-circuits when fired.current is truthy
        expect(source).toMatch(/if\s*\(\s*fired\.current\s*\)\s*return/);
        // Guard is set BEFORE the await fetch (so a second invocation is
        // blocked even before the network promise settles)
        const lines = source.split('\n');
        const setIdx = lines.findIndex((l) => /fired\.current\s*=\s*true/.test(l));
        const fetchIdx = lines.findIndex((l) => /await\s+fetch\(/.test(l));
        expect(setIdx).toBeGreaterThan(-1);
        expect(fetchIdx).toBeGreaterThan(-1);
        expect(setIdx).toBeLessThan(fetchIdx);
    });
});
