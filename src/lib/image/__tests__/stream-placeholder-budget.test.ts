import { describe, expect, it, vi } from 'vitest';
import {
    createPlaceholderCache,
    getStreamPlaceholderB64,
    PLACEHOLDER_LIMITS,
    type PlaceholderSpec,
} from '../stream-placeholder';
const spec = (w: number): PlaceholderSpec => ({ w, h: 1024, format: 'png', transparent: false });

describe('placeholder resource admission', () => {
    it('coalesces one running spec and rejects a burst of different misses without building a queue', async () => {
        let finish!: (image: string) => void;
        const renderer = vi.fn(
            () =>
                new Promise<string>((resolve) => {
                    finish = resolve;
                }),
        );
        const cache = createPlaceholderCache(renderer);
        const first = cache.get(spec(1024));
        expect(cache.get(spec(1024))).toBe(first);
        const skipped = Array.from({ length: 100 }, (_, i) => cache.get(spec(1040 + i * 16)));
        expect(await Promise.all(skipped)).toEqual(Array(100).fill(null));
        expect(renderer).toHaveBeenCalledTimes(1);
        expect(cache.stats().active).toBe(PLACEHOLDER_LIMITS.maxConcurrent);
        finish('aGVsbG8=');
        await first;
        expect(cache.stats()).toMatchObject({ active: 0, entries: 1 });
        expect(renderer).toHaveBeenCalledTimes(1);
    });

    it('bounds cached UTF-16 bytes and entries and evicts the least recently used ready result', async () => {
        const renderer = vi.fn(async () => 'AAAA');
        const cache = createPlaceholderCache(renderer, {
            maxConcurrent: 1,
            maxEntries: 2,
            maxCacheBytes: 16,
            maxEntryBytes: 10,
        });
        const first = cache.get(spec(1024));
        await first;
        await cache.get(spec(1040));
        expect(cache.get(spec(1024))).toBe(first);
        await cache.get(spec(1056));
        expect(cache.stats()).toEqual({ active: 0, entries: 2, bytes: 16 });
        expect(cache.get(spec(1024))).toBe(first);
        await cache.get(spec(1040));
        expect(renderer).toHaveBeenCalledTimes(4);
        expect(cache.stats().bytes).toBeLessThanOrEqual(16);
    });

    it('skips oversized encoded output and releases failed render slots for later requests', async () => {
        const renderer = vi
            .fn()
            .mockRejectedValueOnce(new Error('native failure'))
            .mockResolvedValueOnce('A'.repeat(6))
            .mockResolvedValueOnce('AAAA');
        const cache = createPlaceholderCache(renderer, {
            maxConcurrent: 1,
            maxEntries: 2,
            maxCacheBytes: 16,
            maxEntryBytes: 10,
        });
        expect(await cache.get(spec(1024))).toBeNull();
        expect(await cache.get(spec(1024))).toBeNull();
        expect(cache.stats()).toEqual({ active: 0, entries: 0, bytes: 0 });
        expect(await cache.get(spec(1024))).toBe('AAAA');
        expect(cache.stats()).toEqual({ active: 0, entries: 1, bytes: 8 });
    });

    it('clearing the cache cannot admit a second render while the old native work is running', async () => {
        let finish!: (value: string) => void;
        const renderer = vi.fn(
            () =>
                new Promise<string>((resolve) => {
                    finish = resolve;
                }),
        );
        const cache = createPlaceholderCache(renderer);
        const first = cache.get(spec(1024));
        await Promise.resolve();
        cache.clear();
        expect(await cache.get(spec(1040))).toBeNull();
        expect(cache.stats().active).toBe(1);
        finish('AAAA');
        expect(await first).toBe('AAAA');
        expect(cache.stats()).toEqual({ active: 0, entries: 0, bytes: 0 });
    });

    it('rejects invalid or oversized canvases before any native rendering', async () => {
        for (const value of [spec(0), spec(Infinity), spec(3841), { ...spec(3840), h: 3840 }]) {
            expect(await getStreamPlaceholderB64(value)).toBeNull();
        }
    });
});
