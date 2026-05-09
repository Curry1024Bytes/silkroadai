import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { getPlatformStyle, PlatformBadge, PlatformIcon } from '@/lib/platform-style';

describe('getPlatformStyle', () => {
    const knownPlatforms = ['claude', 'anthropic', 'openai', 'codex', 'gemini', 'google', 'sora', 'antigravity'];

    it.each(knownPlatforms)('should return correct label and non-empty icon for "%s"', (platform) => {
        const style = getPlatformStyle(platform);
        // label should be the capitalised form, not empty
        expect(style.label).toBeTruthy();
        expect(style.icon).toBeTruthy();
    });

    it('anthropic and claude should share the same badge style', () => {
        const claude = getPlatformStyle('claude');
        const anthropic = getPlatformStyle('anthropic');
        expect(claude.badge).toBe(anthropic.badge);
    });

    it('openai and codex should share the same badge style', () => {
        const openai = getPlatformStyle('openai');
        const codex = getPlatformStyle('codex');
        expect(openai.badge).toBe(codex.badge);
    });

    it('gemini and google should share the same badge style', () => {
        const gemini = getPlatformStyle('gemini');
        const google = getPlatformStyle('google');
        expect(gemini.badge).toBe(google.badge);
    });

    it('should be case-insensitive ("OpenAI" and "openai" return same result)', () => {
        const upper = getPlatformStyle('OpenAI');
        const lower = getPlatformStyle('openai');
        expect(upper).toEqual(lower);
    });

    it('should return fallback grey style for unknown platform', () => {
        const style = getPlatformStyle('unknownService');
        expect(style.badge).toContain('slate');
        expect(style.label).toBe('unknownService');
        expect(style.icon).toBe('');
    });
});

describe('PlatformBadge', () => {
    it('should render output containing the correct label text', () => {
        const html = renderToStaticMarkup(PlatformBadge({ platform: 'claude' }));
        expect(html).toContain('Claude');
    });

    it('should render fallback label for unknown platform', () => {
        const html = renderToStaticMarkup(PlatformBadge({ platform: 'myPlatform' }));
        expect(html).toContain('myPlatform');
    });
});

describe('PlatformIcon', () => {
    it('should return non-null for known platforms', () => {
        const icon = PlatformIcon({ platform: 'openai' });
        expect(icon).not.toBeNull();
    });

    it('should return null for unknown platform (empty icon)', () => {
        const icon = PlatformIcon({ platform: 'unknownPlatform' });
        expect(icon).toBeNull();
    });
});
