/** #558/#566 proxy failure scenarios with LLmRoute catalog and quote semantics. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const fetchMock = vi.fn();
const mockGetCurrentUser = vi.fn();
const mockLoadPlazaData = vi.fn();
const mockLoadCatalog = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args) }));
vi.mock('@/lib/models/plaza-data', () => ({ loadPlazaData: (...args: unknown[]) => mockLoadPlazaData(...args) }));
vi.mock('@/lib/models/catalog-browser', () => ({ loadBrowserCatalog: () => mockLoadCatalog() }));
vi.mock('@/lib/db', () => ({
    prisma: { channelGroup: { findMany: async () => [{ key: 'retail', newapi_group: 'internal-group' }] } },
}));
const names = ['gpt-5.4', 'claude-opus-4-8', 'never-seen', 'a', 'b'];
const catalog = {
    tiers: [{ key: 'retail', label: '标准档', isDefault: true }],
    models: names.map((slug) => ({ slug, pricesByTier: { retail: null } })),
};
const measured = { avg_latency_ms: 500, avg_tps: 30, success_rate: 99 };
function detail(model = 'gpt-5.4') {
    return {
        success: true,
        data: {
            model_name: model,
            summary: measured,
            groups: [{ group: 'internal-group', ...measured, avg_ttft_ms: 100, series: [] }],
        },
    };
}
function response(data: unknown) {
    return new Response(JSON.stringify(data), { status: 200 });
}
async function call(sub: string, search = '') {
    const { GET } = await import('@/app/api/portal/models/[...path]/route');
    return GET(new NextRequest(`http://portal.test/api/portal/models/${sub}${search}`), {
        params: Promise.resolve({ path: sub.split('/') }),
    });
}
beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    mockGetCurrentUser.mockReset();
    mockLoadPlazaData.mockReset();
    mockLoadCatalog.mockReset();
    mockGetCurrentUser.mockResolvedValue(null);
    mockLoadCatalog.mockResolvedValue(catalog);
    mockLoadPlazaData.mockResolvedValue({ success: true, data: [{ model_name: 'gpt-5.4' }] });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('models proxy route', () => {
    it('404s anything outside the whitelist and never touches new-api', async () => {
        expect((await call('user/self')).status).toBe(404);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(mockLoadPlazaData).not.toHaveBeenCalled();
    });
    it('serves /pricing from the validated Portal catalog instead of raw upstream prices', async () => {
        const res = await call('pricing');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, data: [{ model_name: 'gpt-5.4' }] });
        expect(mockLoadPlazaData).toHaveBeenCalledWith(null);
        expect(res.headers.get('cache-control')).toBe('private, no-store');
    });
    it('forwards the query string (repeated recent_model) for perf-metrics/summary', async () => {
        fetchMock.mockResolvedValueOnce(response({ success: true, data: { models: [], recent_success_series: {} } }));
        await call('perf-metrics/summary', '?hours=24&recent_model=a&recent_model=b');
        expect(String(fetchMock.mock.calls[0][0])).toContain(
            '/api/perf-metrics/summary?hours=24&recent_model=a&recent_model=b',
        );
    });
    it('serves a 60s cache hit without re-fetching, keyed by full query', async () => {
        fetchMock.mockImplementation(async (url: URL) => response(detail(url.searchParams.get('model')!)));
        expect((await call('perf-metrics', '?model=gpt-5.4&hours=24')).headers.get('x-silkroadai-cache')).toBe('miss');
        expect((await call('perf-metrics', '?model=gpt-5.4&hours=24')).headers.get('x-silkroadai-cache')).toBe('hit');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await call('perf-metrics', '?model=claude-opus-4-8&hours=24');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it('falls back to stale performance cache when new-api is unreachable, 502 when nothing cached', async () => {
        fetchMock.mockResolvedValueOnce(response(detail()));
        await call('perf-metrics', '?model=gpt-5.4');
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + 120_000);
        fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        const stale = await call('perf-metrics', '?model=gpt-5.4');
        expect(stale.status).toBe(200);
        expect(stale.headers.get('x-silkroadai-cache')).toBe('stale');
        expect((await stale.json()).data.groups[0].group).toBe('标准档');
        fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        expect((await call('perf-metrics', '?model=never-seen')).status).toBe(502);
    });
    it('never serves stale quotes after a price read failure or after a price publication', async () => {
        await call('pricing');
        mockLoadPlazaData.mockRejectedValueOnce(new Error('dedicated ratio unavailable'));
        expect((await call('pricing')).status).toBe(503);
        mockLoadPlazaData.mockResolvedValueOnce({ success: true, data: ['new price'] });
        expect((await (await call('pricing')).json()).data).toEqual(['new price']);
        expect(mockLoadPlazaData).toHaveBeenCalledTimes(3);
    });
    it('does not proxy unknown models or arbitrary query parameters', async () => {
        expect((await call('perf-metrics', '?model=hidden')).status).toBe(404);
        expect(fetchMock).not.toHaveBeenCalled();
        fetchMock.mockResolvedValueOnce(response(detail()));
        await call('perf-metrics', '?model=gpt-5.4&group=hidden&admin=true');
        const url = fetchMock.mock.calls[0][0] as URL;
        expect(url.searchParams.has('group')).toBe(false);
        expect(url.searchParams.has('admin')).toBe(false);
    });
});

describe('models proxy route — dedicated customer quotes', () => {
    const CUSTOMER = { id: 'customer-a', newapi_user_id: 816, newapi_access_token: 'cust-token' };
    it('anonymous pricing carries no customer identity', async () => {
        await call('pricing');
        expect(mockLoadPlazaData).toHaveBeenCalledWith(null);
    });
    it('passes each logged-in identity separately and never reuses customer prices for guests', async () => {
        mockGetCurrentUser
            .mockResolvedValueOnce(CUSTOMER)
            .mockResolvedValueOnce({ ...CUSTOMER, id: 'customer-b', newapi_user_id: 817 })
            .mockResolvedValueOnce(null);
        await call('pricing');
        await call('pricing');
        await call('pricing');
        expect(mockLoadPlazaData.mock.calls.map(([viewer]) => viewer?.id ?? null)).toEqual([
            'customer-a',
            'customer-b',
            null,
        ]);
    });
    it('perf-metrics never carries identity even when logged in', async () => {
        fetchMock.mockResolvedValueOnce(response({ success: true, data: { models: [] } }));
        mockGetCurrentUser.mockResolvedValue(CUSTOMER);
        await call('perf-metrics/summary', '?hours=24');
        expect(mockGetCurrentUser).not.toHaveBeenCalled();
        const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
        expect(headers.Authorization).toBeUndefined();
    });
    it('session lookup failure refuses pricing instead of substituting an anonymous quote', async () => {
        mockGetCurrentUser.mockRejectedValue(new Error('db down'));
        expect((await call('pricing')).status).toBe(503);
        expect(mockLoadPlazaData).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
