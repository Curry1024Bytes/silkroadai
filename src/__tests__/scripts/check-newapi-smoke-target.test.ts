import { describe, expect, it, vi } from 'vitest';
import { checkNewapiSmokeTarget } from '../../../scripts/check-newapi-smoke-target';

const target = 'http://127.0.0.1:18082';

describe('new-api smoke target preflight', () => {
    it('rejects a 200 HTML application instead of treating it as new-api health', async () => {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
            new Response('<html>another app</html>', {
                headers: { 'content-type': 'text/html' },
            }),
        );
        expect((await checkNewapiSmokeTarget(target, { fetchImpl })).ok).toBe(false);
    });

    it('checks status without sending administrative credentials', async () => {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
            new Response(
                JSON.stringify({
                    success: true,
                    data: { version: 'v1.0.0-rc.23', start_time: 100 },
                }),
                { headers: { 'content-type': 'application/json' } },
            ),
        );
        expect((await checkNewapiSmokeTarget(target, { fetchImpl })).ok).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0];
        expect(String(url)).toBe(`${target}/api/status`);
        expect(init).toMatchObject({ method: 'GET', redirect: 'manual' });
        expect(init?.headers).toBeUndefined();
        expect(init?.body).toBeUndefined();
    });

    it.each([
        { success: false, data: { version: 'x' } },
        { success: true, data: [] },
        { success: true, data: null },
        { success: true, data: { version: '' } },
    ])('rejects an invalid status envelope: %j', async (body) => {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
            new Response(JSON.stringify(body), {
                headers: { 'content-type': 'application/json' },
            }),
        );
        expect((await checkNewapiSmokeTarget(target, { fetchImpl })).ok).toBe(false);
    });

    it('rejects redirects without following them', async () => {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
            new Response(null, {
                status: 302,
                headers: { location: 'https://other.example' },
            }),
        );
        expect((await checkNewapiSmokeTarget(target, { fetchImpl })).ok).toBe(false);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it.each(['not-a-url', 'file:///tmp/config', 'http://user:password@localhost:3000', `${target}/v1`])(
        'rejects unsafe or ambiguous base URL %s before any request',
        async (url) => {
            const fetchImpl = vi.fn<typeof fetch>();
            const result = await checkNewapiSmokeTarget(url, { fetchImpl });
            expect(result.ok).toBe(false);
            expect(JSON.stringify(result)).not.toContain('password');
            expect(fetchImpl).not.toHaveBeenCalled();
        },
    );

    it('rejects oversized responses', async () => {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
            new Response('x'.repeat(64 * 1024 + 1), {
                headers: { 'content-type': 'application/json' },
            }),
        );
        const result = await checkNewapiSmokeTarget(target, { fetchImpl });
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('过大');
    });

    it('reports connection failure without echoing credential-bearing error text', async () => {
        const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('secret upstream diagnostic'));
        const result = await checkNewapiSmokeTarget(target, { fetchImpl });
        expect(result.ok).toBe(false);
        expect(JSON.stringify(result)).not.toContain('secret');
    });
});
