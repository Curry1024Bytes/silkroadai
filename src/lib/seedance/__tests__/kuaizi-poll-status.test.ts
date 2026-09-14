import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('@/lib/enterprise/volc-id-map', () => ({
    rememberVolcId: vi.fn(),
    toUpstreamId: vi.fn(async (id: string) => id),
}));

import { pollVolcVideo } from '../kuaizi-adapter';
import { isTerminalTaskFailure, type UpstreamErrorCategory } from '../upstream-error';

const CLIENT_ID = 'cgt-status-fixture';
const TASK_URL = 'https://provider.test/ai-open-platform-api/api/v3/contents/generations/tasks/kz-cgt-status-fixture';

beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('ENTERPRISE_KUAIZI_BASE_URL', 'https://provider.test');
    vi.stubEnv('ENTERPRISE_KUAIZI_KEY', 'fixture-only');
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('非 2xx 火山轮询只接受已知任务状态', () => {
    it.each([
        ['completed', 'completed'],
        ['success', 'completed'],
        ['succeeded', 'completed'],
        ['failed', 'failed'],
        ['error', 'failed'],
        ['cancelled', 'failed'],
        ['canceled', 'failed'],
        ['expired', 'failed'],
        ['queued', 'queued'],
        ['pending', 'queued'],
        ['running', 'in_progress'],
        ['in_progress', 'in_progress'],
        ['FAILED', 'failed'],
    ])('HTTP 400 的已知状态 %s 保留为 %s', async (upstreamStatus, expected) => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: upstreamStatus }), { status: 400 }));
        const res = await pollVolcVideo(CLIENT_ID);
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ id: CLIENT_ID, task_id: CLIENT_ID, status: expected });
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock.mock.calls[0][0]).toBe(TASK_URL);
        expect(fetchMock.mock.calls[0][1].method ?? 'GET').toBe('GET');
    });

    it.each([
        [400, 'unknown', 'unknown'],
        [400, 'constructor', 'unknown'],
        [400, 1, 'unknown'],
        [429, 'throttled', 'rate_limited'],
        [503, 'unavailable', 'upstream_unavailable'],
    ])('HTTP %i 未知状态 %s 保留错误并允许后续重试', async (httpStatus, status, category) => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status }), { status: httpStatus }));
        const res = await pollVolcVideo(CLIENT_ID);
        const body = await res.json();
        expect(res.status).toBe(httpStatus);
        expect(body.error.category).toBe(category);
        expect(body).not.toHaveProperty('status');
        expect(body).not.toHaveProperty('usage');
        expect(isTerminalTaskFailure(body.error.category as UpstreamErrorCategory, res.status)).toBe(false);
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it.each([429, 503])('HTTP %i 无任务状态的纯错误体不能冒充任务', async (httpStatus) => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), { status: httpStatus }),
        );
        const res = await pollVolcVideo(CLIENT_ID);
        expect(res.status).toBe(httpStatus);
        expect((await res.json()).error.category).toBe(httpStatus === 429 ? 'rate_limited' : 'upstream_unavailable');
    });

    it.each([200, 400, 429, 503])('HTTP %i 非 JSON 响应仍为可重试错误', async (httpStatus) => {
        fetchMock.mockResolvedValueOnce(new Response('<html>nginx/1.25 unavailable</html>', { status: httpStatus }));
        const res = await pollVolcVideo(CLIENT_ID);
        const body = await res.json();
        expect(res.status).toBe(httpStatus === 200 ? 502 : httpStatus);
        expect(body.error).toBeDefined();
        expect(body).not.toHaveProperty('status');
        expect(body).not.toHaveProperty('usage');
        expect(JSON.stringify(body)).not.toMatch(/nginx|<html>/i);
        expect(isTerminalTaskFailure(body.error.category as UpstreamErrorCategory, res.status)).toBe(false);
    });

    it('非 2xx failed 只给客户失败原因和平台号，隐藏供应商身份且不带计费 usage', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    id: 'kz-cgt-provider-task',
                    status: 'failed',
                    vendor_task_id: 'tsk-provider-private',
                    error: {
                        code: 'InternalServiceError',
                        message:
                            'internal error from kuaizi https://api.kuaizi.com/v3 kz-cgt-provider-task request_id: opaque-fixture',
                    },
                    usage: { completion_tokens: 999, total_tokens: 999 },
                }),
                { status: 503 },
            ),
        );
        const res = await pollVolcVideo(CLIENT_ID);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body).toMatchObject({ id: CLIENT_ID, task_id: CLIENT_ID, status: 'failed', progress: 100 });
        expect(body.fail_reason).toContain('internal error');
        expect(body.fail_reason).toContain('request_id: opaque-fixture');
        expect(body).not.toHaveProperty('usage');
        expect(body).not.toHaveProperty('vendor_task_id');
        expect(JSON.stringify(body)).not.toMatch(/kuaizi|https?:|kz-|tsk-/i);
    });

    it('2xx 未知任务状态保留既有进行中回退', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'future-progress-state' })));
        const res = await pollVolcVideo(CLIENT_ID);
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ status: 'in_progress' });
    });
});
