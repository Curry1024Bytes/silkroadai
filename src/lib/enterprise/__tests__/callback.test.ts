/** 企业任务回调投递(2026-10-19):URL 守门、CAS 只投一次、重试与落库、请求日志。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { db, writeRequestLog } = vi.hoisted(() => ({
    db: { seedanceVideoTask: { updateMany: vi.fn(), findUnique: vi.fn() } },
    writeRequestLog: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('../request-log', () => ({ writeRequestLog }));

import { deliverTaskCallback, shouldFireCallback, validateCallbackUrl } from '../callback';

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PORTAL_ENTERPRISE_CALLBACK_ENABLED', 'true');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    db.seedanceVideoTask.updateMany.mockResolvedValue({ count: 1 });
    db.seedanceVideoTask.findUnique.mockResolvedValue({
        callback_url: 'https://hooks.example.com/cb',
        user_id: 'u1',
        model: 'seedance-2-0-global',
        status: 'completed',
    });
});

afterEach(() => vi.unstubAllEnvs());

describe('validateCallbackUrl', () => {
    it('未传 / 空串 → null(= 不要回调)', () => {
        expect(validateCallbackUrl(undefined)).toBeNull();
        expect(validateCallbackUrl(null)).toBeNull();
        expect(validateCallbackUrl('')).toBeNull();
        expect(validateCallbackUrl('   ')).toBeNull();
    });
    it('公网 http(s) → ok 并归一', () => {
        expect(validateCallbackUrl('https://webhook.site/abc?x=1')).toEqual({
            ok: true,
            url: 'https://webhook.site/abc?x=1',
        });
        expect(validateCallbackUrl('http://cb.example.com/path')).toMatchObject({ ok: true });
    });
    it.each([
        ['ftp://x.com/a', '仅支持 http(s)'],
        ['not a url', '不是合法 URL'],
        ['http://localhost:3000/cb', '公网'],
        ['http://127.0.0.1/cb', '公网'],
        ['http://10.0.0.5/cb', '公网'],
        ['http://192.168.1.2/cb', '公网'],
        ['http://172.16.0.1/cb', '公网'],
        ['http://169.254.169.254/latest', '公网'],
        ['http://[::1]/cb', '公网'],
        ['http://svc.internal/cb', '公网'],
        [123, '字符串'],
    ])('拒绝 %s', (raw, frag) => {
        const r = validateCallbackUrl(raw);
        expect(r && !r.ok).toBe(true);
        expect((r as { message: string }).message).toContain(frag);
    });
});

describe('shouldFireCallback', () => {
    it('有 URL 且 pending 才投;sent / failed / sending / 无 URL 不投', () => {
        expect(shouldFireCallback({ id: 'a', callback_url: 'https://x', callback_status: 'pending' })).toBe(true);
        for (const st of ['sent', 'failed', 'sending', null, undefined])
            expect(shouldFireCallback({ id: 'a', callback_url: 'https://x', callback_status: st })).toBe(false);
        expect(shouldFireCallback({ id: 'a', callback_url: null, callback_status: 'pending' })).toBe(false);
        expect(shouldFireCallback(null)).toBe(false);
    });
});

describe('deliverTaskCallback', () => {
    const body = { id: 'cgt-1', status: 'succeeded' };
    it('2xx → sent:CAS 抢占 pending→sending,POST JSON 带 X-Task-Id,不跟随重定向,落 sent + 请求日志', async () => {
        const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
        const r = await deliverTaskCallback('cgt-1', body, { fetchImpl, delaysMs: [0] });
        expect(r).toBe('sent');
        expect(db.seedanceVideoTask.updateMany).toHaveBeenNthCalledWith(1, {
            where: { id: 'cgt-1', callback_status: 'pending', status: 'completed' },
            data: { callback_status: 'sending' },
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://hooks.example.com/cb');
        expect(init.method).toBe('POST');
        expect(init.redirect).toBe('manual');
        expect((init.headers as Record<string, string>)['X-Task-Id']).toBe('cgt-1');
        expect(JSON.parse(String(init.body))).toEqual(body);
        expect(db.seedanceVideoTask.updateMany).toHaveBeenLastCalledWith({
            where: { id: 'cgt-1', callback_status: 'sending' },
            data: expect.objectContaining({ callback_status: 'sent', callback_error: null }),
        });
        expect(writeRequestLog).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'callback', taskId: 'cgt-1', outcome: 'sent', upstreamStatus: 200 }),
        );
    });

    it('CAS 抢不到(已投 / 并发)→ skipped,不打任何请求', async () => {
        db.seedanceVideoTask.updateMany.mockResolvedValueOnce({ count: 0 });
        const fetchImpl = vi.fn();
        expect(await deliverTaskCallback('cgt-1', body, { fetchImpl })).toBe('skipped');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('非 2xx / 抛错按次数重试,最终 failed 并记最后原因;中途成功即停', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(new Response('x', { status: 500 }))
            .mockRejectedValueOnce(new Error('ECONNRESET'))
            .mockResolvedValueOnce(new Response('x', { status: 503 }));
        expect(await deliverTaskCallback('cgt-1', body, { fetchImpl, delaysMs: [0, 0, 0] })).toBe('failed');
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(db.seedanceVideoTask.updateMany).toHaveBeenLastCalledWith({
            where: { id: 'cgt-1', callback_status: 'sending' },
            data: expect.objectContaining({ callback_status: 'failed', callback_error: 'HTTP 503' }),
        });
        expect(writeRequestLog).toHaveBeenCalledWith(
            expect.objectContaining({ outcome: 'failed', upstreamStatus: 503 }),
        );

        vi.clearAllMocks();
        db.seedanceVideoTask.updateMany.mockResolvedValue({ count: 1 });
        db.seedanceVideoTask.findUnique.mockResolvedValue({
            callback_url: 'https://hooks.example.com/x',
            user_id: 'u1',
            model: 'm',
            status: 'completed',
        });
        const f2 = vi
            .fn()
            .mockResolvedValueOnce(new Response('x', { status: 502 }))
            .mockResolvedValueOnce(new Response(null, { status: 204 }));
        expect(await deliverTaskCallback('cgt-1', body, { fetchImpl: f2, delaysMs: [0, 0, 0] })).toBe('sent');
        expect(f2).toHaveBeenCalledTimes(2);
    });

    it('3xx 不算送达(不跟随)→ 重试后 failed', async () => {
        const fetchImpl = vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://x' } }));
        expect(await deliverTaskCallback('cgt-1', body, { fetchImpl, delaysMs: [0, 0] })).toBe('failed');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
});
