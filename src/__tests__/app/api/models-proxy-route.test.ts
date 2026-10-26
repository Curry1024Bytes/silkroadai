/**
 * /api/portal/models/[...path] — 模型广场公开数据代理(2026-10-22)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const fetchMock = vi.fn();
const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a),
}));

async function call(sub: string, search = '') {
    const { GET } = await import('@/app/api/portal/models/[...path]/route');
    const req = new NextRequest(`http://portal.test/api/portal/models/${sub}${search}`);
    return GET(req, { params: Promise.resolve({ path: sub.split('/') }) });
}

beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockResolvedValue(null);
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

describe('models proxy route — 专属倍率(登录态以客户身份转发 pricing,2026-10-23)', () => {
    const CUSTOMER = { newapi_user_id: 816, newapi_access_token: 'cust-token' };

    it('anonymous pricing carries no identity headers', async () => {
        fetchMock.mockImplementation(
            async () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }),
        );
        await call('pricing');
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toBeUndefined();
        expect(headers['New-Api-User']).toBeUndefined();
    });

    it('logged-in pricing forwards Authorization + New-Api-User and is cached per user, separate from anonymous', async () => {
        fetchMock.mockImplementation(
            async () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }),
        );
        mockGetCurrentUser.mockResolvedValue(CUSTOMER);
        const first = await call('pricing');
        expect(first.headers.get('x-silkroadai-cache')).toBe('miss');
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toBe('cust-token');
        expect(headers['New-Api-User']).toBe('816');
        // 同用户再来 → 命中
        const second = await call('pricing');
        expect(second.headers.get('x-silkroadai-cache')).toBe('hit');
        // 匿名 → 另一份缓存 key,重新打上游且不带身份
        mockGetCurrentUser.mockResolvedValue(null);
        const anon = await call('pricing');
        expect(anon.headers.get('x-silkroadai-cache')).toBe('miss');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const anonHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
        expect(anonHeaders.Authorization).toBeUndefined();
    });

    it('perf-metrics never carries identity even when logged in', async () => {
        fetchMock.mockImplementation(
            async () => new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }),
        );
        mockGetCurrentUser.mockResolvedValue(CUSTOMER);
        await call('perf-metrics/summary', '?hours=24');
        expect(mockGetCurrentUser).not.toHaveBeenCalled();
        const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
        expect(headers.Authorization).toBeUndefined();
    });

    it('session lookup failure degrades to anonymous pricing', async () => {
        fetchMock.mockImplementation(
            async () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }),
        );
        mockGetCurrentUser.mockRejectedValue(new Error('db down'));
        const res = await call('pricing');
        expect(res.status).toBe(200);
        const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
        expect(headers.Authorization).toBeUndefined();
    });
});

describe('models proxy route — 隐藏客户自己的用户分组(2026-10-26)', () => {
    const CUSTOMER = { newapi_user_id: 1907, newapi_access_token: 'cust-token' };
    const UPSTREAM = {
        success: true,
        data: [],
        group_ratio: { default: 1.3, 'oai image 2': 1.7 },
        // new-api GetUserUsableGroups 把用户自己的分组补进来,描述 "User group"
        usable_group: {
            default: '默认分组',
            'oai image 2': 'oai image 2',
            auto: 'auto',
            'vip-c-db420d6d': 'User group',
        },
    };

    it('logged-in pricing drops usable_group entries that have no group_ratio (the auto-added vip-<username>), keeps auto', async () => {
        fetchMock.mockImplementation(async () => new Response(JSON.stringify(UPSTREAM), { status: 200 }));
        mockGetCurrentUser.mockResolvedValue(CUSTOMER);
        const res = await call('pricing');
        const body = (await res.json()) as typeof UPSTREAM;
        expect(Object.keys(body.usable_group).sort()).toEqual(['auto', 'default', 'oai image 2']);
        expect(body.group_ratio).toEqual(UPSTREAM.group_ratio);
        // 缓存里存的也是过滤后的
        const again = await call('pricing');
        expect(again.headers.get('x-silkroadai-cache')).toBe('hit');
        expect(Object.keys(((await again.json()) as typeof UPSTREAM).usable_group)).not.toContain('vip-c-db420d6d');
    });

    it('anonymous pricing is passed through untouched', async () => {
        fetchMock.mockImplementation(async () => new Response(JSON.stringify(UPSTREAM), { status: 200 }));
        const res = await call('pricing');
        expect(await res.json()).toEqual(UPSTREAM);
    });

    it('hideOwnUserGroup is a no-op on non-JSON / unexpected shapes', async () => {
        const { hideOwnUserGroup } = await import('@/app/api/portal/models/[...path]/route');
        expect(hideOwnUserGroup('not json')).toBe('not json');
        expect(hideOwnUserGroup('{"success":true}')).toBe('{"success":true}');
    });
});
