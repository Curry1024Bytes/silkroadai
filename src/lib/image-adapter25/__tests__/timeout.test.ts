import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { handleAdapter25Image } from '../adapter';

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('Image 2.5 upstream timeout', () => {
    it('aborts the pending POST at 600s and returns no usage without reposting', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn(
            (_url: string, init: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
                }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const pending = handleAdapter25Image(
            new NextRequest('http://portal.test/image-adapter25/wetokenasia25/v1/images/generations', {
                method: 'POST',
                headers: { authorization: 'Bearer test-provider-key', 'content-type': 'application/json' },
                body: JSON.stringify({ model: 'gpt-image-2.5-flare', prompt: 'a square', size: '1024x1024' }),
            }),
            'generations',
            'wetokenasia25',
        );
        await vi.advanceTimersByTimeAsync(599_999);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const signal = fetchMock.mock.calls[0][1].signal;
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        const response = await pending;
        expect(signal?.aborted).toBe(true);
        expect(response.status).toBe(503);
        const body = await response.json();
        expect(body.error.code).toBe('upstream_unavailable');
        expect(body).not.toHaveProperty('usage');
        expect(body).not.toHaveProperty('data');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
