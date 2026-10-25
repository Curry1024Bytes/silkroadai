/** service-inference.ai 提交路径的 5xx 单次退避重试(2026-10-09 svcinf 网关三分钟 503 事故后加)。
 *  只验 submitSvcinfTask 本身:哪些状态重试、哪些不重试、重试后成功/仍失败的对客响应、env 关闭。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { submitSvcinfTask, submitRetryDelayMs, type SvcinfConfig } from '../svcinf-client';

const cfg: SvcinfConfig = { base: 'http://svcinf.test', key: 'sk-inf-v1-test', api: 'v2' };
const tag = { log: 'retry-test', errType: 'seedance_volc_adapter_error', model: 'doubao-seedance-2.5' };
const body = { model: 'doubao-seedance-2-5-260628-max', content: [{ type: 'text', text: 'x' }], resolution: '480p' };

const ok = () => new Response(JSON.stringify({ task: { id: 'mvt-ok', status: 'pending' } }), { status: 200 });
const gateway503 = () =>
    new Response(
        JSON.stringify({
            error: { message: 'Service temporarily unavailable, please retry', type: 'proxy_error' },
            request_id: '01a11fe0-8060-74c5-935f-3bd9ab9abb18',
        }),
        { status: 503 },
    );
const withStatus = (status: number) =>
    new Response(JSON.stringify({ error: { message: `upstream said ${status}`, type: 'proxy_error' } }), { status });

beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv('SEEDANCE_SVCINF_SUBMIT_RETRY_MS', '1'); // 单测不等 1.5s
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());

describe('submitRetryDelayMs', () => {
    it('LLmRoute 缺省0关闭;非法值回落关闭;正值显式启用', () => {
        vi.stubEnv('SEEDANCE_SVCINF_SUBMIT_RETRY_MS', '');
        expect(submitRetryDelayMs()).toBe(0);
        vi.stubEnv('SEEDANCE_SVCINF_SUBMIT_RETRY_MS', 'abc');
        expect(submitRetryDelayMs()).toBe(0);
        vi.stubEnv('SEEDANCE_SVCINF_SUBMIT_RETRY_MS', '-5');
        expect(submitRetryDelayMs()).toBe(0);
        vi.stubEnv('SEEDANCE_SVCINF_SUBMIT_RETRY_MS', '0');
        expect(submitRetryDelayMs()).toBe(0);
        vi.stubEnv('SEEDANCE_SVCINF_SUBMIT_RETRY_MS', '2500');
        expect(submitRetryDelayMs()).toBe(2500);
    });
});

describe('submitSvcinfTask 5xx 退避重试', () => {
    it('503 → 退避后重发一次,第二次 200 即成功;两次 body 完全相同', async () => {
        const fetchMock = vi
            .spyOn(global, 'fetch')
            .mockImplementationOnce(async () => gateway503())
            .mockImplementationOnce(async () => ok());
        const r = await submitSvcinfTask(cfg, body, tag);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.taskId).toBe('mvt-ok');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const [u1, i1] = fetchMock.mock.calls[0];
        const [u2, i2] = fetchMock.mock.calls[1];
        expect(String(u1)).toBe('http://svcinf.test/v2/video/generate');
        expect(String(u2)).toBe(String(u1));
        expect((i2 as RequestInit).body).toBe((i1 as RequestInit).body);
        expect(console.warn).toHaveBeenCalledWith(
            '[retry-test] submit 503, retrying once',
            expect.objectContaining({ delay_ms: 1, upstream_model: body.model }),
        );
    });

    it.each([500, 502])('%s 同样重试一次', async (status) => {
        const fetchMock = vi
            .spyOn(global, 'fetch')
            .mockImplementationOnce(async () => withStatus(status))
            .mockImplementationOnce(async () => ok());
        const r = await submitSvcinfTask(cfg, body, tag);
        expect(r.ok).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('两次都 503 → 只发两次,对客 503 upstream_error + 上游原文透传 + category upstream_unavailable', async () => {
        const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async () => gateway503());
        const r = await submitSvcinfTask(cfg, body, tag);
        expect(r.ok).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        if (!r.ok) {
            expect(r.res.status).toBe(503);
            const j = await r.res.json();
            expect(j.error.code).toBe('upstream_error');
            expect(j.error.type).toBe('seedance_volc_adapter_error');
            expect(j.error.category).toBe('upstream_unavailable');
            expect(j.error.message).toContain('Service temporarily unavailable');
        }
        expect(console.warn).toHaveBeenCalledWith(
            '[retry-test] submit failed',
            expect.objectContaining({ status: 503, attempts: 2 }),
        );
    });

    it('504 网关超时【不重试】(请求可能已被方舟受理,重发会建第二条付费任务)', async () => {
        const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async () => withStatus(504));
        const r = await submitSvcinfTask(cfg, body, tag);
        expect(r.ok).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        if (!r.ok) expect(r.res.status).toBe(504);
    });

    it('4xx 不重试(参数错重发也不会变对)', async () => {
        const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async () => withStatus(400));
        const r = await submitSvcinfTask(cfg, body, tag);
        expect(r.ok).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        if (!r.ok) expect(r.res.status).toBe(400);
    });

    it('fetch 抛错(连接层 / 超时)不重试 → 502 upstream_unreachable', async () => {
        const fetchMock = vi.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
        const r = await submitSvcinfTask(cfg, body, tag);
        expect(r.ok).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        if (!r.ok) {
            expect(r.res.status).toBe(502);
            expect((await r.res.json()).error.code).toBe('upstream_unreachable');
        }
    });

    it('SEEDANCE_SVCINF_SUBMIT_RETRY_MS=0 → 关闭重试,503 单发即返', async () => {
        vi.stubEnv('SEEDANCE_SVCINF_SUBMIT_RETRY_MS', '0');
        const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async () => gateway503());
        const r = await submitSvcinfTask(cfg, body, tag);
        expect(r.ok).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(console.warn).toHaveBeenCalledWith(
            '[retry-test] submit failed',
            expect.objectContaining({ status: 503, attempts: 1 }),
        );
    });

    it('200 直接成功,只发一次', async () => {
        const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async () => ok());
        const r = await submitSvcinfTask(cfg, body, tag);
        expect(r.ok).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('LLmRoute uncertain submission protection', () => {
    it.each([500, 502, 503])('defaults to one POST for ambiguous HTTP %s', async (status) => {
        vi.stubEnv('SEEDANCE_SVCINF_SUBMIT_RETRY_MS', '');
        const send = vi.spyOn(global, 'fetch').mockImplementation(async () => withStatus(status));
        expect((await submitSvcinfTask(cfg, body, tag)).ok).toBe(false);
        expect(send).toHaveBeenCalledTimes(1);
    });
    it('does not replay a 503 that already includes an accepted task ID even when retry is opted in', async () => {
        const send = vi
            .spyOn(global, 'fetch')
            .mockResolvedValue(new Response(JSON.stringify({ task: { id: 'mvt-accepted' } }), { status: 503 }));
        await submitSvcinfTask(cfg, body, tag);
        expect(send).toHaveBeenCalledTimes(1);
    });
    it('a body read failure after headers never triggers another paid POST', async () => {
        const response = new Response(null, { status: 503 });
        vi.spyOn(response, 'text').mockRejectedValue(new Error('connection closed after headers'));
        const send = vi.spyOn(global, 'fetch').mockResolvedValue(response);
        const result = await submitSvcinfTask(cfg, body, tag);
        expect(result.ok).toBe(false);
        expect(send).toHaveBeenCalledTimes(1);
    });
});

describe('accepted task handles survive HTTP error envelopes', () => {
    it.each([200, 400, 403, 429, 500, 502, 503, 504])(
        'preserves a genuine task envelope on HTTP %s without another POST',
        async (status) => {
            const send = vi
                .spyOn(global, 'fetch')
                .mockResolvedValue(
                    new Response(JSON.stringify({ task: { id: 'mvt-accepted', status: 'pending' } }), { status }),
                );
            expect(await submitSvcinfTask(cfg, body, tag)).toEqual({ ok: true, taskId: 'mvt-accepted', api: 'v2' });
            expect(send).toHaveBeenCalledTimes(1);
        },
    );
    it.each([
        { id: 'request-id', error: { message: 'service unavailable' } },
        { id: 'mvt-request-id', status: 'pending', error: { message: 'rejected' } },
        { task: { id: 'mvt-accepted' } },
        { task: { id: 'mvt-', status: 'pending' } },
        { task: { id: 'request-id', status: 'pending' } },
        { task: { id: 'mvt-accepted', status: 'unknown' } },
        { error: { id: 'mvt-error-id', status: 'pending' } },
    ])('does not mistake an error/request identifier for a task: %j', async (payload) => {
        vi.stubEnv('SEEDANCE_SVCINF_SUBMIT_RETRY_MS', '');
        for (const status of [200, 400, 503]) {
            const send = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(payload), { status }));
            expect((await submitSvcinfTask(cfg, body, tag)).ok).toBe(false);
            expect(send).toHaveBeenCalledTimes(1);
            send.mockRestore();
        }
    });
});
