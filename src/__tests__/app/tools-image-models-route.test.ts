import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/tools/image/models/route';

const mockFetch = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch as typeof fetch;
});

function req(withKey = true): NextRequest {
    return new NextRequest('https://llmroute.club/api/tools/image/models', {
        headers: withKey ? { authorization: 'Bearer sk-test' } : {},
    });
}

describe('GET /api/tools/image/models', () => {
    it('requires an API key', async () => {
        expect((await GET(req(false))).status).toBe(401);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('temporarily hides canonical and fixed-price GPT image SKUs from the size-editable tool', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    data: [
                        { id: 'gpt-image-2' },
                        { id: 'gpt-image-2-1k' },
                        { id: 'gpt-image-2-2k' },
                        { id: 'gpt-image-2-4k' },
                        { id: 'gemini-3-pro-image-preview' },
                        { id: 'gpt-5.4' },
                    ],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        );

        const res = await GET(req());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ models: ['gemini-3-pro-image-preview'] });
    });

    it('preserves an upstream authentication error', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ error: { message: 'invalid key' } }), {
                status: 401,
                headers: { 'content-type': 'application/json' },
            }),
        );
        const res = await GET(req());
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: { message: 'invalid key' } });
    });
});
