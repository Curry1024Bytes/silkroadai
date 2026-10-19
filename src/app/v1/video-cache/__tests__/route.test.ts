import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, HEAD, OPTIONS } from '../[filename]/route';

const TASK_ID = `task_${'A'.repeat(32)}`;
const FILENAME = `${TASK_ID}.mp4`;
const NEWAPI_BASE = (process.env.NEWAPI_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const mockFetch = vi.fn();

function request(method: 'GET' | 'HEAD', filename = FILENAME, headers?: HeadersInit) {
    return new NextRequest(`https://api.llmroute.club/v1/video-cache/${filename}`, { method, headers });
}

function context(filename = FILENAME) {
    return { params: Promise.resolve({ filename }) };
}

beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => vi.unstubAllGlobals());

describe('public video-cache delivery', () => {
    it('streams the existing video through a fixed new-api path without forwarding customer headers', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response(Buffer.from('mp4-bytes'), {
                status: 200,
                headers: { 'content-type': 'video/mp4', 'content-length': '9', 'accept-ranges': 'bytes' },
            }),
        );
        const response = await GET(request('GET', FILENAME, { authorization: 'Bearer secret' }), context());
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('mp4-bytes');
        expect(response.headers.get('content-type')).toBe('video/mp4');
        expect(response.headers.get('content-length')).toBe('9');
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(mockFetch).toHaveBeenCalledWith(`${NEWAPI_BASE}/video-cache/${FILENAME}`, {
            method: 'GET',
            headers: new Headers(),
            redirect: 'manual',
        });
    });

    it('passes byte ranges and HEAD through for seeking and availability checks', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response(Buffer.from('mp4'), {
                status: 206,
                headers: {
                    'content-type': 'video/mp4',
                    'content-range': 'bytes 0-2/100',
                    'content-length': '3',
                    'accept-ranges': 'bytes',
                },
            }),
        );
        const range = await GET(request('GET', FILENAME, { range: 'bytes=0-2' }), context());
        expect(range.status).toBe(206);
        expect(range.headers.get('content-range')).toBe('bytes 0-2/100');
        expect(await range.text()).toBe('mp4');
        const init = mockFetch.mock.calls[0][1] as RequestInit;
        expect(new Headers(init.headers).get('range')).toBe('bytes=0-2');

        mockFetch.mockResolvedValueOnce(
            new Response(null, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '100' } }),
        );
        const head = await HEAD(request('HEAD'), context());
        expect(head.status).toBe(200);
        expect(head.headers.get('content-length')).toBe('100');
        expect(head.body).toBeNull();
        expect((mockFetch.mock.calls[1][1] as RequestInit).method).toBe('HEAD');
    });

    it('rejects malformed task IDs before fetching and hides missing or expired cache details', async () => {
        const invalid = await GET(request('GET', 'task_../../secret.mp4'), context('task_../../secret.mp4'));
        expect(invalid.status).toBe(404);
        expect(mockFetch).not.toHaveBeenCalled();

        mockFetch.mockResolvedValueOnce(new Response(null, { status: 410 }));
        const expired = await GET(request('GET'), context());
        expect(expired.status).toBe(404);
        expect(expired.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('does not expose a non-video upstream response or redirect', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response('<html>error</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
        );
        expect((await GET(request('GET'), context())).status).toBe(502);
        mockFetch.mockResolvedValueOnce(
            new Response(null, { status: 302, headers: { location: 'https://upstream.example/video' } }),
        );
        const redirected = await GET(request('GET'), context());
        expect(redirected.status).toBe(502);
        expect(redirected.headers.get('location')).toBeNull();
    });

    it('allows browser preflight for range requests', async () => {
        const response = await OPTIONS();
        expect(response.status).toBe(204);
        expect(response.headers.get('access-control-allow-methods')).toContain('HEAD');
        expect(response.headers.get('access-control-allow-headers')).toContain('range');
    });
});
