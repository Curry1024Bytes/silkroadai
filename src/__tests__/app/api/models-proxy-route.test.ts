/**
 * /api/portal/models/[...path] — 模型广场公开数据代理(2026-10-22)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const fetchMock = vi.fn();

async function call(sub: string, search = '') {
    const { GET } = await import('@/app/api/portal/models/[...path]/route');
    const req = new NextRequest(`http://portal.test/api/portal/models/${sub}${search}`);
    return GET(req, { params: Promise.resolve({ path: sub.split('/') }) });
}

beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('models proxy route', () => {
    it('404s anything outside the whitelist and never touches new-api', async () => {
        const res = await call('user/self');
        expect(res.status).toBe(404);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('forwards /pricing to new-api and returns the body', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true, data: [1] }), { status: 200 }));
        const res = await call('pricing');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, data: [1] });
        const url = String(fetchMock.mock.calls[0][0]);
        expect(url).toMatch(/\/api\/pricing$/);
        expect(res.headers.get('x-silkroadai-cache')).toBe('miss');
    });

    it('forwards the query string (repeated recent_model) for perf-metrics/summary', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }));
        await call('perf-metrics/summary', '?hours=24&recent_model=a&recent_model=b');
        const url = String(fetchMock.mock.calls[0][0]);
        expect(url).toContain('/api/perf-metrics/summary?hours=24&recent_model=a&recent_model=b');
    });

    it('serves a 60s cache hit without re-fetching, keyed by full query', async () => {
        fetchMock.mockImplementation(
            async () => new Response(JSON.stringify({ success: true, data: 'x' }), { status: 200 }),
        );
        const first = await call('perf-metrics', '?model=gpt-5.4&hours=24');
        expect(first.headers.get('x-silkroadai-cache')).toBe('miss');
        const second = await call('perf-metrics', '?model=gpt-5.4&hours=24');
        expect(second.headers.get('x-silkroadai-cache')).toBe('hit');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await call('perf-metrics', '?model=claude-opus-4-8&hours=24');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('falls back to stale cache when new-api is unreachable, 502 when nothing cached', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ success: true, data: 'cached' }), { status: 200 }),
        );
        await call('pricing');
        // expire freshness but stay within stale window
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + 120_000);
        fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        const stale = await call('pricing');
        expect(stale.status).toBe(200);
        expect(stale.headers.get('x-silkroadai-cache')).toBe('stale');
        expect(await stale.json()).toEqual({ success: true, data: 'cached' });
        vi.useRealTimers();

        vi.resetModules();
        fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        const dead = await call('perf-metrics', '?model=never-seen');
        expect(dead.status).toBe(502);
    });
});
