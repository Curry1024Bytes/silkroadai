/**
 * kling /v1 代理单测 —— 鉴权 / 定价门 / 余额门 / 上游转发 / 任务归属(IDOR)/ 轮询扣费触发。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { db, getCustomerBalance, resolveCustomer, chargeKlingVideoTask } = vi.hoisted(() => ({
    db: { klingVideoTask: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() } },
    getCustomerBalance: vi.fn(),
    resolveCustomer: vi.fn(),
    chargeKlingVideoTask: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/billing/customer-balance', () => ({ getCustomerBalance }));
vi.mock('@/lib/seedance/cn-proxy', () => ({ resolveCustomer }));
vi.mock('../billing', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../billing')>();
    return { ...actual, chargeKlingVideoTask };
});

process.env.KLING_UPSTREAM_BASE_URL = 'https://kling.upstream.test';
process.env.KLING_UPSTREAM_KEY = 'sk-upstream-secret';

const { handleKlingVideoSubmit, handleKlingVideoPoll, isKlingVideoTask } = await import('../proxy');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const CUST = { userId: 'u1', tenantId: null, billingMode: 'newapi', newapiUserId: 42, tier: 'pool', active: true };

const req = (auth = 'Bearer sk-abc') =>
    new NextRequest('http://localhost/v1/video/generations', { headers: auth ? { authorization: auth } : {} });

const upstreamOk = (body: unknown, status = 200) =>
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
    vi.clearAllMocks();
    resolveCustomer.mockResolvedValue({ ...CUST });
    getCustomerBalance.mockResolvedValue({ balanceCny: 100 });
    db.klingVideoTask.create.mockResolvedValue({});
    db.klingVideoTask.update.mockResolvedValue({});
    chargeKlingVideoTask.mockResolvedValue({ outcome: 'charged', costCny: 3 });
});

describe('handleKlingVideoSubmit', () => {
    const body = { model: 'kling-v3', prompt: '测试', resolution: '720p', duration: 5 };

    it('happy path:上游 200 → 记任务(归属+定价 ¥3)→ 响应原样返回', async () => {
        upstreamOk({ id: 'task-1', status: 'pending' });
        const res = await handleKlingVideoSubmit(req(), { ...body });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ id: 'task-1', status: 'pending' });
        // 上游调用:documented path + 上游 key + body 原样
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://kling.upstream.test/v1/video/generations');
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-upstream-secret');
        expect(JSON.parse(init.body as string)).toEqual(body);
        expect(db.klingVideoTask.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                id: 'task-1',
                user_id: 'u1',
                model: 'kling-v3',
                resolution: '720p',
                generate_audio: false,
                has_video: false,
                duration: 5,
                cost_cny: 3, // ¥0.6/秒 × 5s
            }),
        });
    });

    it('无效 key → 401 不打上游;key inactive 同', async () => {
        resolveCustomer.mockResolvedValue(null);
        expect((await handleKlingVideoSubmit(req('Bearer sk-bad'), { ...body })).status).toBe(401);
        resolveCustomer.mockResolvedValue({ ...CUST, active: false });
        expect((await handleKlingVideoSubmit(req(), { ...body })).status).toBe(401);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('余额不足 → 402 不打上游', async () => {
        getCustomerBalance.mockResolvedValue({ balanceCny: 1 });
        const res = await handleKlingVideoSubmit(req(), { ...body });
        expect(res.status).toBe(402);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('无挂牌价组合(kling-v3 2k)→ 400;未知 resolution → 400', async () => {
        expect((await handleKlingVideoSubmit(req(), { ...body, resolution: '2k' })).status).toBe(400);
        expect((await handleKlingVideoSubmit(req(), { ...body, resolution: '540p' })).status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('v3-omni 含参考视频 + 有声 → 含视频有声档价(2k 10s = ¥18)', async () => {
        upstreamOk({ id: 'task-2', status: 'pending' });
        await handleKlingVideoSubmit(req(), {
            model: 'kling-v3-omni',
            prompt: 'x',
            resolution: '2k',
            duration: 10,
            generate_audio: true,
            videos: ['https://example.com/ref.mp4'],
        });
        expect(db.klingVideoTask.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ generate_audio: true, has_video: true, cost_cny: 18 }),
        });
    });

    it('上游非 200 → 原样透传状态+body,不记任务', async () => {
        upstreamOk({ error: { message: 'boom' } }, 429);
        const res = await handleKlingVideoSubmit(req(), { ...body });
        expect(res.status).toBe(429);
        expect(db.klingVideoTask.create).not.toHaveBeenCalled();
    });

    it('上游 200 但无 id → 502;任务落库失败 → 503(fail closed)', async () => {
        upstreamOk({ status: 'pending' });
        expect((await handleKlingVideoSubmit(req(), { ...body })).status).toBe(502);
        upstreamOk({ id: 'task-3', status: 'pending' });
        db.klingVideoTask.create.mockRejectedValue(new Error('db down'));
        expect((await handleKlingVideoSubmit(req(), { ...body })).status).toBe(503);
    });

    it('duration 非法回落 5 计费(¥0.6×5=3)', async () => {
        upstreamOk({ id: 'task-4', status: 'pending' });
        await handleKlingVideoSubmit(req(), { ...body, duration: 'abc' });
        expect(db.klingVideoTask.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ duration: 5, cost_cny: 3 }),
        });
    });
});

describe('handleKlingVideoPoll + isKlingVideoTask', () => {
    const task = { id: 'task-1', user_id: 'u1', status: 'queued', billed: false };

    it('isKlingVideoTask:记录过 → true,否则 false', async () => {
        db.klingVideoTask.findUnique.mockResolvedValue({ id: 'task-1' });
        expect(await isKlingVideoTask('task-1')).toBe(true);
        db.klingVideoTask.findUnique.mockResolvedValue(null);
        expect(await isKlingVideoTask('nope')).toBe(false);
    });

    it('IDOR:非归属客户轮询 → 404 不打上游', async () => {
        db.klingVideoTask.findUnique.mockResolvedValue({ ...task });
        resolveCustomer.mockResolvedValue({ ...CUST, userId: 'u2' });
        const res = await handleKlingVideoPoll(req(), 'task-1');
        expect(res.status).toBe(404);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('in_progress → 原样透传,不扣费', async () => {
        db.klingVideoTask.findUnique.mockResolvedValue({ ...task });
        upstreamOk({ id: 'task-1', status: 'in_progress' });
        const res = await handleKlingVideoPoll(req(), 'task-1');
        expect(res.status).toBe(200);
        expect(chargeKlingVideoTask).not.toHaveBeenCalled();
    });

    it('completed → 触发幂等扣费 + 状态落库 + 成片响应原样返回', async () => {
        db.klingVideoTask.findUnique.mockResolvedValue({ ...task });
        upstreamOk({ id: 'task-1', status: 'completed', data: [{ url: 'https://cdn/video.mp4' }] });
        const res = await handleKlingVideoPoll(req(), 'task-1');
        expect(res.status).toBe(200);
        expect((await res.json()).data[0].url).toBe('https://cdn/video.mp4');
        expect(chargeKlingVideoTask).toHaveBeenCalledWith('task-1');
        expect(db.klingVideoTask.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { status: 'completed' } }),
        );
    });

    it('failed → 标记失败、不扣费', async () => {
        db.klingVideoTask.findUnique.mockResolvedValue({ ...task });
        upstreamOk({ id: 'task-1', status: 'failed' });
        await handleKlingVideoPoll(req(), 'task-1');
        expect(chargeKlingVideoTask).not.toHaveBeenCalled();
        expect(db.klingVideoTask.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'failed' } }));
    });

    it('上游轮询挂 → 502;扣费 throw 不影响响应(错误只记日志)', async () => {
        db.klingVideoTask.findUnique.mockResolvedValue({ ...task });
        fetchMock.mockRejectedValue(new Error('timeout'));
        expect((await handleKlingVideoPoll(req(), 'task-1')).status).toBe(502);

        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ id: 'task-1', status: 'completed' }), { status: 200 }),
        );
        chargeKlingVideoTask.mockRejectedValue(new Error('charge boom'));
        expect((await handleKlingVideoPoll(req(), 'task-1')).status).toBe(200);
    });
});
