/**
 * PR-T2 v2 — extractB64Images unit tests.
 *
 * Gemini chat-completions responses embed image data as
 * `data:image/<mime>;base64,<payload>` inline in the markdown content.
 * We need to robustly pull every payload out, regardless of:
 *   - markdown wrapping (`![alt](data:...)` vs raw `data:...`)
 *   - multiple images in one response
 *   - mime variants (png / jpeg / webp)
 *   - leading text before the data URI
 */
import { describe, expect, it } from 'vitest';
import { extractB64Images } from '@/lib/image-gen/extract-b64';

// A short but valid 1×1 PNG as base64 (real bytes for buffer-decode sanity).
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';

describe('extractB64Images', () => {
    it('extracts a single PNG inside a markdown image link', () => {
        const content = `Here is a tiny cat:\n![image](data:image/png;base64,${TINY_PNG_B64})`;
        const out = extractB64Images(content);
        expect(out).toHaveLength(1);
        expect(out[0].mime).toBe('image/png');
        expect(out[0].buffer.length).toBeGreaterThan(0);
        // Verify the buffer round-trips back to the same base64.
        expect(out[0].buffer.toString('base64')).toBe(TINY_PNG_B64);
    });

    it('extracts a raw data URI with no surrounding markdown', () => {
        const content = `data:image/png;base64,${TINY_PNG_B64}`;
        const out = extractB64Images(content);
        expect(out).toHaveLength(1);
    });

    it('extracts multiple images when the response embeds N', () => {
        const content =
            `One: ![](data:image/png;base64,${TINY_PNG_B64})\n` +
            `Two: ![](data:image/jpeg;base64,${TINY_PNG_B64})\n` +
            `Three (in HTML): <img src="data:image/webp;base64,${TINY_PNG_B64}">`;
        const out = extractB64Images(content);
        expect(out).toHaveLength(3);
        const mimes = out.map((d) => d.mime).sort();
        expect(mimes).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    });

    it('returns [] on empty / null / non-string input', () => {
        expect(extractB64Images('')).toEqual([]);
        // Force-cast for the runtime guard test.
        expect(extractB64Images(undefined as unknown as string)).toEqual([]);
        expect(extractB64Images(null as unknown as string)).toEqual([]);
    });

    it('returns [] when content has prose but no data URI (safety-filter case)', () => {
        const out = extractB64Images(
            'I cannot generate that image due to safety guidelines. Please try a different prompt.',
        );
        expect(out).toEqual([]);
    });

    it('skips obviously-malformed/short payloads (< 16 chars)', () => {
        // Length-15 base64 — not a valid image, treat as garbage.
        const content = 'data:image/png;base64,abc';
        const out = extractB64Images(content);
        expect(out).toEqual([]);
    });

    it('handles weird-mime variants (image/png-bytes etc.)', () => {
        // A made-up but conformant mime suffix; the regex allows
        // [a-zA-Z0-9.+-] so e.g. "image/png-x" should still match.
        const content = `![](data:image/png-x;base64,${TINY_PNG_B64})`;
        const out = extractB64Images(content);
        expect(out).toHaveLength(1);
        expect(out[0].mime).toBe('image/png-x');
    });
});
