/**
 * Unit tests for the W7 D4 PR-H Tier A display formatter.
 *
 * Single contract: stored value (typically 48-char raw id) →
 * customer-facing display value (`sk-` + raw id), with idempotent
 * handling of already-prefixed input.
 */
import { describe, expect, it } from 'vitest';
import { TOKEN_DISPLAY_PREFIX, formatTokenForDisplay } from '../token-format';

describe('formatTokenForDisplay — idempotent sk- prefix', () => {
    it('exports the literal "sk-" prefix as a constant', () => {
        expect(TOKEN_DISPLAY_PREFIX).toBe('sk-');
    });

    it('prepends sk- to a bare 48-char id (the prod-stored shape)', () => {
        const stored = 'Bc4UOPZdTYBS56MMFE1XrOXf5ILtXXXDPsWgqqgecvS5dezb';
        expect(stored.length).toBe(48);
        expect(formatTokenForDisplay(stored)).toBe(`sk-${stored}`);
    });

    it('returns already-prefixed input unchanged (idempotent)', () => {
        const prefixed = 'sk-Bc4UOPZdTYBS56MMFE1XrOXf5ILtXXXDPsWgqqgecvS5dezb';
        expect(formatTokenForDisplay(prefixed)).toBe(prefixed);
    });

    it('does NOT double-prefix when called twice (idempotent under composition)', () => {
        const stored = 'rawvalue';
        const once = formatTokenForDisplay(stored);
        const twice = formatTokenForDisplay(once);
        expect(once).toBe('sk-rawvalue');
        expect(twice).toBe('sk-rawvalue');
    });

    it('treats short / empty inputs without crashing', () => {
        expect(formatTokenForDisplay('')).toBe('sk-');
        expect(formatTokenForDisplay('a')).toBe('sk-a');
    });

    it('does NOT match non-canonical capitalizations of the prefix', () => {
        // Defensive: we're matching the literal `sk-` only. An input
        // that starts with `Sk-` or `SK-` is treated as "raw" and the
        // canonical prefix is added. That's a clear / predictable bug
        // signal for the operator (e.g. if new-api ever returned an
        // unexpected case) — better than silently honoring it.
        expect(formatTokenForDisplay('Sk-foo')).toBe('sk-Sk-foo');
        expect(formatTokenForDisplay('SK-foo')).toBe('sk-SK-foo');
    });

    it('does NOT match values that contain "sk-" mid-string', () => {
        // Only a leading prefix is recognized — ensures the helper isn't
        // tricked into treating internal `sk-` substrings as "already
        // prefixed".
        expect(formatTokenForDisplay('xsk-foo')).toBe('sk-xsk-foo');
    });
});
