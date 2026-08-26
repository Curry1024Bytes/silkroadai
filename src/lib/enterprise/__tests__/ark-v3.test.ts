/**
 * 火山方舟形态 /api/v3 集成单测(2026-07-26):
 *  - 提交:doubao model id 归一 + asset:// 剥前缀 + 响应仅 {id}
 *  - 轮询:内部响应 → 火山形(content.video_url 嵌套 / status succeeded / usage / model 火山名回显)
 *  - models 列火山 id
 * 复用 proxy.test 的 mock 结构。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const {
    db,
    resolveEnterpriseAuth,
    getUpstreamKeyForUser,
    submitVideoWithKey,
    pollVideoWithKey,
    cancelVideoWithKey,
    cancelVolcVideo,
    estimateEnterpriseCostCny,
    chargeEnterpriseVideoTask,
} = vi.hoisted(() => ({
    db: {
        seedanceVideoTask: {
            create: vi.fn(),
            findUnique: vi.fn(),
            update: vi.fn(),
            delete: vi.fn(),
            count: vi.fn(),
            findMany: vi.fn(),
        },
        account: { findUnique: vi.fn() },
    },
    resolveEnterpriseAuth: vi.fn(),
    getUpstreamKeyForUser: vi.fn(),
    submitVideoWithKey: vi.fn(),
    pollVideoWithKey: vi.fn(),
    cancelVideoWithKey: vi.fn(),
    cancelVolcVideo: vi.fn(),
    estimateEnterpriseCostCny: vi.fn(),
    chargeEnterpriseVideoTask: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
// callerHasVolc:鉴权前的「调用方是不是 volc 客户」探测(决定火山原生模型名按哪个渠道解释)。
// 缺省 false = 按 cn 解释,与既有用例的期望一致;需要 volc 语义的用例自行 mockResolvedValue(true)。
const { callerHasVolc } = vi.hoisted(() => ({ callerHasVolc: vi.fn(async () => false) }));
vi.mock('../keys', () => ({ resolveEnterpriseAuth, getUpstreamKeyForUser, callerHasVolc }));
vi.mock('@/lib/seedance/cn-adapter', async (importOriginal) => {
    const mod = await importOriginal<typeof import('@/lib/seedance/cn-adapter')>();
    return { ...mod, submitVideoWithKey, pollVideoWithKey, cancelVideoWithKey };
});
vi.mock('@/lib/seedance/kuaizi-adapter', async (importOriginal) => {
    const mod = await importOriginal<typeof import('@/lib/seedance/kuaizi-adapter')>();
    return { ...mod, submitVolcVideo: vi.fn(), pollVolcVideo: vi.fn(), cancelVolcVideo };
});
vi.mock('../billing', async (importOriginal) => {
    const mod = await importOriginal<typeof import('../billing')>();
    return { ...mod, estimateEnterpriseCostCny, chargeEnterpriseVideoTask };
});
const { resolveAssetRefs } = vi.hoisted(() => ({ resolveAssetRefs: vi.fn() }));
vi.mock('../assets', async (importOriginal) => {
    const mod = await importOriginal<typeof import('../assets')>();
    return { ...mod, resolveAssetRefs };
});
const { maybeStoreVideoToCustomerOss } = vi.hoisted(() => ({ maybeStoreVideoToCustomerOss: vi.fn() }));
vi.mock('@/lib/seedance/customer-oss-video', () => ({ maybeStoreVideoToCustomerOss }));

import { handleEnterpriseArkV3, handleEnterpriseV1 } from '../proxy';
import { __resetPollCache } from '../poll-cache';

type ArkResp = {
    id: string;
    model: string;
    status: string;
    content: { video_url?: string; last_frame_url?: string };
    usage?: { completion_tokens?: number; total_tokens?: number };
    error: { code?: string } | null;
    resolution?: string;
    created_at: number;
};

const CUSTOMER = { userId: 'u1', tenantId: null, keyId: 'k1', region: 'cn', upstreamKey: 'sk-upstream-u1' };

function req(method: string, url: string, body?: unknown): NextRequest {
    return new NextRequest(`http://128.241.232.23${url}`, {
        method,
        headers: { authorization: 'Bearer sk-ent-' + 'a'.repeat(48), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    __resetPollCache();
    resolveEnterpriseAuth.mockResolvedValue({ ok: true, customer: CUSTOMER });
    db.account.findUnique.mockResolvedValue({ balance_cny: '100' });
    estimateEnterpriseCostCny.mockResolvedValue(4.26);
    db.seedanceVideoTask.create.mockResolvedValue({});
    db.seedanceVideoTask.update.mockResolvedValue({});
    db.seedanceVideoTask.delete.mockResolvedValue({});
    cancelVideoWithKey.mockResolvedValue(new Response(null, { status: 200 }));
    cancelVolcVideo.mockResolvedValue(new Response(null, { status: 200 }));
    getUpstreamKeyForUser.mockResolvedValue('sk-upstream-by-region');
    maybeStoreVideoToCustomerOss.mockResolvedValue(null); // 默认未配 OSS → 回退上游直链
    resolveAssetRefs.mockImplementation((b: Record<string, unknown>) => Promise.resolve(b));
});

describe('GET /api/v3/models', () => {
    it('列火山 doubao id + type=video_generation', async () => {
        const res = await handleEnterpriseArkV3(req('GET', '/api/v3/models'), '/models');
        expect(res.status).toBe(200);
        const j = (await res.json()) as { data: Array<{ id: string; type: string }> };
        expect(j.data.map((m) => m.id)).toEqual([
            'doubao-seedance-2-0-260128',
            'doubao-seedance-2-0-fast-260128',
            'doubao-seedance-2-0-mini-260615',
            'doubao-seedance-2-5-260628',
        ]);
        expect(j.data[0].type).toBe('video_generation');
    });
});

describe('POST /api/v3/contents/generations/tasks', () => {
    it('doubao model 归一 + asset:// 剥前缀 + 响应仅 {id}', async () => {
        submitVideoWithKey.mockResolvedValue(
            NextResponse.json({ id: 'cgt-ark1', task_id: 'cgt-ark1', status: 'queued' }),
        );
        const res = await handleEnterpriseArkV3(
            req('POST', '/api/v3/contents/generations/tasks', {
                model: 'doubao-seedance-2-0-260128',
                content: [
                    { type: 'text', text: '一只猫' },
                    {
                        type: 'image_url',
                        image_url: { url: 'asset://asset-20260101120000-abcdef' },
                        role: 'reference_image',
                    },
                ],
                resolution: '720p',
                duration: 5,
            }),
            '/contents/generations/tasks',
        );
        expect(res.status).toBe(200);
        // 响应严格火山形:仅 id
        expect(await res.json()).toEqual({ id: 'cgt-ark1' });
        // 归一后:model=内部短名,asset:// 已剥
        const passed = submitVideoWithKey.mock.calls[0][0] as Record<string, unknown>;
        expect(passed.model).toBe('seedance2.0-pro-720p-ref'); // 带参考图 → 自动 -ref 档(720p)
        const content = passed.content as Array<{ image_url?: { url: string } }>;
        expect(content[1].image_url!.url).toBe('asset-20260101120000-abcdef');
        // 任务落库存内部短名
        expect(db.seedanceVideoTask.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ model: 'seedance-2-0' }) }),
        );
    });

    it('未知 model → model_not_found', async () => {
        const res = await handleEnterpriseArkV3(
            req('POST', '/api/v3/contents/generations/tasks', {
                model: 'gpt-9',
                content: [{ type: 'text', text: 'x' }],
            }),
            '/contents/generations/tasks',
        );
        expect(res.status).toBe(400);
    });
});

describe('GET /api/v3/contents/generations/tasks/{id}', () => {
    const task = {
        id: 'cgt-ark1',
        user_id: 'u1',
        tier: 'enterprise-portal',
        model: 'seedance-2-0',
        resolution: '720p',
        duration: 5,
        tokens: null,
        status: 'queued',
        fail_reason: null,
        created_at: new Date('2026-07-24T02:00:00Z'),
    };

    it('completed → 火山形:content.video_url 嵌套 + status succeeded + model 火山名 + usage', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue(task);
        chargeEnterpriseVideoTask.mockResolvedValue({ outcome: 'charged', costCny: 4.26 });
        pollVideoWithKey.mockResolvedValue(
            NextResponse.json({
                id: 'cgt-ark1',
                status: 'completed',
                video_url: 'https://vod/x.mp4',
                usage: { completion_tokens: 108872, total_tokens: 108872 },
            }),
        );
        const res = await handleEnterpriseArkV3(
            req('GET', '/api/v3/contents/generations/tasks/cgt-ark1'),
            '/contents/generations/tasks/cgt-ark1',
        );
        expect(res.status).toBe(200);
        const j = (await res.json()) as ArkResp;
        expect(j.status).toBe('succeeded');
        expect(j.model).toBe('doubao-seedance-2-0-260128');
        expect(j.content.video_url).toBe('https://vod/x.mp4');
        expect(j.usage!.completion_tokens).toBe(108872);
        expect(j.error).toEqual({ code: '', message: '' });
        expect(j.resolution).toBe('720p');
        expect(typeof j.created_at).toBe('number');
    });

    it('failed → 火山形 error 对象(审核码),不计费', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue(task);
        pollVideoWithKey.mockResolvedValue(
            NextResponse.json({
                id: 'cgt-ark1',
                status: 'failed',
                fail_reason: 'output video may contain sensitive information',
            }),
        );
        const res = await handleEnterpriseArkV3(
            req('GET', '/api/v3/contents/generations/tasks/cgt-ark1'),
            '/contents/generations/tasks/cgt-ark1',
        );
        const j = (await res.json()) as ArkResp;
        expect(j.status).toBe('failed');
        expect(j.error!.code).toBe('SensitiveContentDetected');
        expect(chargeEnterpriseVideoTask).not.toHaveBeenCalled();
    });

    it('非本人任务 → 404', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({ ...task, user_id: 'other' });
        const res = await handleEnterpriseArkV3(
            req('GET', '/api/v3/contents/generations/tasks/cgt-ark1'),
            '/contents/generations/tasks/cgt-ark1',
        );
        expect(res.status).toBe(404);
    });

    it('已 failed 任务:直接返库里 fail_reason(不重打上游)+ 版权码', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({
            ...task,
            status: 'failed',
            fail_reason: 'The request failed because the output video may be related to copyright restrictions.',
        });
        const res = await handleEnterpriseArkV3(
            req('GET', '/api/v3/contents/generations/tasks/cgt-ark1'),
            '/contents/generations/tasks/cgt-ark1',
        );
        expect(res.status).toBe(200);
        const j = (await res.json()) as ArkResp & { error: { code: string; message: string } };
        expect(j.status).toBe('failed');
        expect(j.error.code).toBe('CopyrightViolationDetected');
        expect(j.error.message).toMatch(/copyright/i);
        // 关键:不重打上游
        expect(pollVideoWithKey).not.toHaveBeenCalled();
    });
});

describe('GET /api/v3/contents/generations/tasks(任务列表,火山官方契约)', () => {
    const rowOf = (id: string, status = 'completed') => ({
        id,
        model: 'seedance-2-0',
        status,
        resolution: '720p',
        duration: 5,
        ratio: '16:9',
        seed: null,
        generate_audio: true,
        tokens: BigInt(108872),
        fail_reason: null,
        created_at: new Date('2026-08-13T00:00:00Z'),
    });

    it('返回火山列表信封 {items,total,page_num,page_size} + 按 user_id 过滤', async () => {
        db.seedanceVideoTask.count.mockResolvedValue(2);
        db.seedanceVideoTask.findMany.mockResolvedValue([rowOf('cgt-a'), rowOf('cgt-b')]);
        const res = await handleEnterpriseArkV3(
            req('GET', '/api/v3/contents/generations/tasks?page_num=1&page_size=10'),
            '/contents/generations/tasks',
        );
        expect(res.status).toBe(200);
        const j = (await res.json()) as {
            items: Array<{ id: string; status: string }>;
            total: number;
            page_num: number;
            page_size: number;
        };
        expect(j.total).toBe(2);
        expect(j.page_num).toBe(1);
        expect(j.page_size).toBe(10);
        expect(j.items.map((i) => i.id)).toEqual(['cgt-a', 'cgt-b']);
        expect(j.items[0].status).toBe('succeeded'); // completed → 火山 succeeded
        // 查询按 user_id + 分页
        expect(db.seedanceVideoTask.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ user_id: 'u1' }),
                skip: 0,
                take: 10,
            }),
        );
    });

    it('status 过滤(火山 succeeded → 内部 completed);model 过滤归一 doubao 名', async () => {
        db.seedanceVideoTask.count.mockResolvedValue(0);
        db.seedanceVideoTask.findMany.mockResolvedValue([]);
        await handleEnterpriseArkV3(
            req('GET', '/api/v3/contents/generations/tasks?status=succeeded&model=doubao-seedance-2-0-260128'),
            '/contents/generations/tasks',
        );
        expect(db.seedanceVideoTask.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ status: 'completed', model: 'seedance-2-0' }),
            }),
        );
    });
});

describe('/api/v3 严格契约校验(仅 ark 面)', () => {
    it('非法 ratio(2:3)→ 400,不创建任务', async () => {
        const res = await handleEnterpriseArkV3(
            req('POST', '/api/v3/contents/generations/tasks', {
                model: 'doubao-seedance-2-5-260628',
                content: [{ type: 'text', text: '一只猫' }],
                duration: 5,
                ratio: '2:3',
            }),
            '/contents/generations/tasks',
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { message: string } }).error.message).toContain('ratio');
        expect(submitVideoWithKey).not.toHaveBeenCalled();
    });

    it('合法 ratio(adaptive)不被拦', async () => {
        submitVideoWithKey.mockResolvedValue(NextResponse.json({ id: 'cgt-ok', status: 'queued' }));
        const res = await handleEnterpriseArkV3(
            req('POST', '/api/v3/contents/generations/tasks', {
                model: 'doubao-seedance-2-5-260628',
                content: [{ type: 'text', text: 'x' }],
                duration: 5,
                ratio: 'adaptive',
            }),
            '/contents/generations/tasks',
        );
        expect(res.status).toBe(200);
    });

    it('未声明参数(frames)→ 400,不创建任务', async () => {
        const res = await handleEnterpriseArkV3(
            req('POST', '/api/v3/contents/generations/tasks', {
                model: 'doubao-seedance-2-5-260628',
                content: [{ type: 'text', text: '一只猫' }],
                frames: 30,
                ratio: '1:1',
            }),
            '/contents/generations/tasks',
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { message: string } }).error.message).toContain('frames');
        expect(submitVideoWithKey).not.toHaveBeenCalled();
    });
});

describe('DELETE /api/v3/contents/generations/tasks/{id}', () => {
    const baseTask = {
        id: 'cgt-del1',
        user_id: 'u1',
        tier: 'enterprise-portal',
        model: 'seedance-2-0',
        resolution: '720p',
        duration: 5,
        tokens: null,
        status: 'queued',
        fail_reason: null,
        created_at: new Date('2026-08-14T02:00:00Z'),
    };
    const del = () =>
        handleEnterpriseArkV3(
            req('DELETE', '/api/v3/contents/generations/tasks/cgt-del1'),
            '/contents/generations/tasks/cgt-del1',
        );

    it('排队中任务 → 取消上游 + 删库记录 + 204 无体', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({ ...baseTask, status: 'queued' });
        const res = await del();
        expect(res.status).toBe(204);
        expect(await res.text()).toBe('');
        expect(cancelVideoWithKey).toHaveBeenCalledWith('cgt-del1', 'Bearer sk-upstream-u1', 'cn');
        expect(db.seedanceVideoTask.delete).toHaveBeenCalledWith({ where: { id: 'cgt-del1' } });
    });

    it('已完成任务 → 仅删记录,不取消上游(无排队可取消),仍 204', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({ ...baseTask, status: 'completed' });
        const res = await del();
        expect(res.status).toBe(204);
        expect(cancelVideoWithKey).not.toHaveBeenCalled();
        expect(db.seedanceVideoTask.delete).toHaveBeenCalledWith({ where: { id: 'cgt-del1' } });
    });

    it('上游取消失败 → best-effort 不阻断,仍删记录 + 204', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({ ...baseTask, status: 'in_progress' });
        cancelVideoWithKey.mockRejectedValue(new Error('upstream boom'));
        const res = await del();
        expect(res.status).toBe(204);
        expect(db.seedanceVideoTask.delete).toHaveBeenCalledWith({ where: { id: 'cgt-del1' } });
    });

    it('非本人任务 → 404,不取消不删除', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({ ...baseTask, user_id: 'other' });
        const res = await del();
        expect(res.status).toBe(404);
        expect(cancelVideoWithKey).not.toHaveBeenCalled();
        expect(db.seedanceVideoTask.delete).not.toHaveBeenCalled();
    });

    it('任务不存在 → 404', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue(null);
        const res = await del();
        expect(res.status).toBe(404);
        expect(db.seedanceVideoTask.delete).not.toHaveBeenCalled();
    });

    it('本人任务但 sk-ent 版本不符(cn key 删 promax 任务)→ 403,不删除', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({
            ...baseTask,
            model: 'seedance2.0-promax-720p-ref',
            status: 'queued',
        });
        const res = await del();
        expect(res.status).toBe(403);
        expect(cancelVideoWithKey).not.toHaveBeenCalled();
        expect(db.seedanceVideoTask.delete).not.toHaveBeenCalled();
    });
});

describe('成片落客户自定义 OSS(轮询完成时转存)', () => {
    const task = {
        id: 'cgt-oss1',
        user_id: 'u1',
        tier: 'enterprise-portal',
        model: 'seedance-2-0',
        resolution: '720p',
        duration: 5,
        tokens: null,
        status: 'queued',
        fail_reason: null,
        created_at: new Date('2026-08-14T02:00:00Z'),
        ratio: null,
        seed: null,
        generate_audio: null,
    };

    it('ark 面:客户配了 OSS → content.video_url = 客户桶 URL(不透传上游直链)', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue(task);
        chargeEnterpriseVideoTask.mockResolvedValue({ outcome: 'charged', costCny: 4.26 });
        pollVideoWithKey.mockResolvedValue(
            NextResponse.json({
                id: 'cgt-oss1',
                status: 'completed',
                video_url: 'https://ark-signed.volces.com/out.mp4?sig=xyz',
                usage: { completion_tokens: 1000, total_tokens: 1000 },
            }),
        );
        maybeStoreVideoToCustomerOss.mockResolvedValue('https://cdn.customer.com/seedance/cgt-oss1.mp4');
        const res = await handleEnterpriseArkV3(
            req('GET', '/api/v3/contents/generations/tasks/cgt-oss1'),
            '/contents/generations/tasks/cgt-oss1',
        );
        const j = (await res.json()) as ArkResp;
        expect(j.content.video_url).toBe('https://cdn.customer.com/seedance/cgt-oss1.mp4');
        expect(maybeStoreVideoToCustomerOss).toHaveBeenCalledWith({
            userId: 'u1',
            taskId: 'cgt-oss1',
            upstreamUrl: 'https://ark-signed.volces.com/out.mp4?sig=xyz',
        });
    });

    it('ark 面:客户未配 OSS → content.video_url 保持上游直链', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue(task);
        chargeEnterpriseVideoTask.mockResolvedValue({ outcome: 'charged', costCny: 4.26 });
        pollVideoWithKey.mockResolvedValue(
            NextResponse.json({
                id: 'cgt-oss1',
                status: 'completed',
                video_url: 'https://ark-signed.volces.com/out.mp4?sig=xyz',
                usage: { completion_tokens: 1000, total_tokens: 1000 },
            }),
        );
        maybeStoreVideoToCustomerOss.mockResolvedValue(null);
        const res = await handleEnterpriseArkV3(
            req('GET', '/api/v3/contents/generations/tasks/cgt-oss1'),
            '/contents/generations/tasks/cgt-oss1',
        );
        const j = (await res.json()) as ArkResp;
        expect(j.content.video_url).toBe('https://ark-signed.volces.com/out.mp4?sig=xyz');
    });

    it('v1 面:客户配了 OSS → video_url + url 都换成客户桶 URL', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue(task);
        chargeEnterpriseVideoTask.mockResolvedValue({ outcome: 'charged', costCny: 4.26 });
        pollVideoWithKey.mockResolvedValue(
            NextResponse.json({
                id: 'cgt-oss1',
                task_id: 'cgt-oss1',
                object: 'video',
                status: 'completed',
                video_url: 'https://ark-signed.volces.com/out.mp4?sig=xyz',
                url: 'https://ark-signed.volces.com/out.mp4?sig=xyz',
            }),
        );
        maybeStoreVideoToCustomerOss.mockResolvedValue('https://cdn.customer.com/seedance/cgt-oss1.mp4');
        const res = await handleEnterpriseV1(
            req('GET', '/v1/video/generations/cgt-oss1'),
            '/video/generations/cgt-oss1',
        );
        const j = (await res.json()) as { video_url: string; url: string };
        expect(j.video_url).toBe('https://cdn.customer.com/seedance/cgt-oss1.mp4');
        expect(j.url).toBe('https://cdn.customer.com/seedance/cgt-oss1.mp4');
    });
});
