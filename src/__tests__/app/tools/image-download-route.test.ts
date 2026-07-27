import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/tools/image/download/route';

const reqFor = (qs: string) => new NextRequest(`http://localhost/api/tools/image/download${qs}`);
const q = (u: string) => `?url=${encodeURIComponent(u)}`;

describe('tools image download proxy', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('rejects missing url', async () => {
        expect((await GET(reqFor(''))).status).toBe(400);
    });

    it('blocks SSRF: localhost / private-IP / non-http', async () => {
        const bad = [
            'http://localhost/x.png',
            'http://127.0.0.1/a',
            'http://169.254.169.254/meta',
            'http://10.0.0.1/a',
            'http://172.16.0.1/a',
            'http://192.168.1.1/a',
            'http://foo.internal/a',
            'file:///etc/passwd',
            'ftp://x/a',
        ];
        for (const u of bad) {
            expect((await GET(reqFor(q(u)))).status, u).toBe(400);
        }
    });

    it('proxies a public image with attachment + filename', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async () =>
                    new Response(new Uint8Array([1, 2, 3]), {
                        status: 200,
                        headers: { 'content-type': 'image/png' },
                    }),
            ),
        );
        const r = await GET(reqFor(`${q('https://images.llmroute.club/gen/abc')}&name=pic`));
        expect(r.status).toBe(200);
        expect(r.headers.get('content-type')).toBe('image/png');
        const cd = r.headers.get('content-disposition') || '';
        expect(cd).toContain('attachment');
        expect(cd).toContain('pic.png');
    });

    it('rejects non-image content-type (no arbitrary-URL proxying)', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })),
        );
        expect((await GET(reqFor(q('https://evil.example.com/x')))).status).toBe(400);
    });

    it('surfaces upstream non-200 as 502', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('', { status: 404 })),
        );
        expect((await GET(reqFor(q('https://images.llmroute.club/gen/missing')))).status).toBe(502);
    });
});
