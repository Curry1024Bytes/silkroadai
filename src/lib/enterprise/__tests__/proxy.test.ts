/**
 * 独立门户 /v1 处理器单测:分发白名单 / 鉴权 / 余额门 / 任务落库(fail closed)/ 轮询 IDOR + 扣费。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const {
    db,
    resolveEnterpriseAuth,
    getUpstreamKeyForUser,
    submitVideoWithKey,
    pollVideoWithKey,
    submitVolcVideo,
    pollVolcVideo,
    estimateEnterpriseCostCny,
    chargeEnterpriseVideoTask,
} = vi.hoisted(() => ({
    db: {
        seedanceVideoTask: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
        account: { findUnique: vi.fn() },
    },
    resolveEnterpriseAuth: vi.fn(),
    getUpstreamKeyForUser: vi.fn(),
    submitVideoWithKey: vi.fn(),
    pollVideoWithKey: vi.fn(),
    submitVolcVideo: vi.fn(),
    pollVolcVideo: vi.fn(),
    estimateEnterpriseCostCny: vi.fn(),
    chargeEnterpriseVideoTask: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('../keys', () => ({ resolveEnterpriseAuth, getUpstreamKeyForUser }));
vi.mock('@/lib/seedance/cn-adapter', async (importOriginal) => {
    const mod = await importOriginal<typeof import('@/lib/seedance/cn-adapter')>();
    return { ...mod, submitVideoWithKey, pollVideoWithKey };
});
vi.mock('@/lib/seedance/volc-adapter', () => ({ submitVolcVideo, pollVolcVideo }));
vi.mock('../billing', async (importOriginal) => {
    const mod = await importOriginal<typeof import('../billing')>();
    return { ...mod, estimateEnterpriseCostCny, chargeEnterpriseVideoTask };
});
const { resolveAssetRefs } = vi.hoisted(() => ({ resolveAssetRefs: vi.fn() }));
vi.mock('../assets', async (importOriginal) => {
    const mod = await importOriginal<typeof import('../assets')>();
    return { ...mod, resolveAssetRefs };
});
import { AssetError } from '../assets';

import { handleEnterpriseV1, isEnterpriseFlavor } from '../proxy';

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
    resolveEnterpriseAuth.mockResolvedValue({ ok: true, customer: CUSTOMER });
    db.account.findUnique.mockResolvedValue({ balance_cny: '100' });
    estimateEnterpriseCostCny.mockResolvedValue(4.26);
    db.seedanceVideoTask.create.mockResolvedValue({});
    db.seedanceVideoTask.update.mockResolvedValue({});
    resolveAssetRefs.mockImplementation((body: Record<string, unknown>) => Promise.resolve(body));
    getUpstreamKeyForUser.mockResolvedValue('sk-upstream-by-region');
});

describe('火山渠道(volc)路由', () => {
    it('model doubao-seedance-2.0 → 走 volc 适配器(不走 cn),任务落库 resolution 参数化', async () => {
        submitVolcVideo.mockResolvedValue(NextResponse.json({ id: 'task_v1', task_id: 'task_v1', status: 'queued' }));
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'doubao-seedance-2.0',
                prompt: '一只猫',
                resolution: '1080p',
            }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(submitVolcVideo).toHaveBeenCalledWith(expect.objectContaining({ prompt: '一只猫' }), '1080p', 5);
        expect(submitVideoWithKey).not.toHaveBeenCalled();
        expect(db.seedanceVideoTask.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                id: 'task_v1',
                model: 'doubao-seedance-2.0',
                tier: 'enterprise-portal',
                resolution: '1080p',
            }),
        });
    });

    it('volc 提交:content 里的 asset:// 前缀不剥(上游契约整串 asset://<id>,剥了必 400)', async () => {
        submitVolcVideo.mockResolvedValue(NextResponse.json({ id: 'cgt-a1', task_id: 'cgt-a1', status: 'queued' }));
        const content = [
            { type: 'text', text: '让画面动起来' },
            { type: 'image_url', image_url: { url: 'asset://asset-20260803095838-5n989' }, role: 'first_frame' },
        ];
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'doubao-seedance-2.0', content, resolution: '720p' }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(submitVolcVideo).toHaveBeenCalledWith(expect.objectContaining({ content }), '720p', 5);
        // volc 走【混合解析】(lenient):平台素材换直链,认不出的 asset:// 原样透传(mock 原样返回)
        expect(resolveAssetRefs).toHaveBeenCalledWith(expect.anything(), 'u1', { lenient: true });
    });

    it('volc 支持 480p(2026-08-03 开放):透传适配器 + 任务落库 480p', async () => {
        submitVolcVideo.mockResolvedValue(NextResponse.json({ id: 'task_v2', task_id: 'task_v2', status: 'queued' }));
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'doubao-seedance-2.0',
                prompt: '一只猫',
                resolution: '480p',
            }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(submitVolcVideo).toHaveBeenCalledWith(expect.objectContaining({ prompt: '一只猫' }), '480p', 5);
        expect(db.seedanceVideoTask.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ model: 'doubao-seedance-2.0', resolution: '480p' }),
        });
    });

    it('volc 支持 4-15 任意整数秒(2026-08-03 开放):7 秒透传适配器 + 落库', async () => {
        submitVolcVideo.mockResolvedValue(NextResponse.json({ id: 'task_d7', task_id: 'task_d7', status: 'queued' }));
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'doubao-seedance-2.0', prompt: 'x', duration: 7 }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(submitVolcVideo).toHaveBeenCalledWith(expect.anything(), '720p', 7);
        expect(db.seedanceVideoTask.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ duration: 7 }),
        });
    });

    it('volc duration 边界:4 和 15 接受,3 / 16 / 7.5 → 400;缺省 = 5', async () => {
        submitVolcVideo.mockImplementation(() =>
            Promise.resolve(NextResponse.json({ id: 'task_db', task_id: 'task_db', status: 'queued' })),
        );
        for (const ok of [4, 15]) {
            const res = await handleEnterpriseV1(
                req('POST', '/v1/video/generations', { model: 'doubao-seedance-2.0', prompt: 'x', duration: ok }),
                '/video/generations',
            );
            expect(res.status).toBe(200);
            expect(submitVolcVideo).toHaveBeenLastCalledWith(expect.anything(), '720p', ok);
        }
        for (const bad of [3, 16, 7.5]) {
            const res = await handleEnterpriseV1(
                req('POST', '/v1/video/generations', { model: 'doubao-seedance-2.0', prompt: 'x', duration: bad }),
                '/video/generations',
            );
            expect(res.status).toBe(400);
            const body = await res.json();
            expect(body.error.message).toContain('4-15');
        }
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'doubao-seedance-2.0', prompt: 'x' }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(submitVolcVideo).toHaveBeenLastCalledWith(expect.anything(), '720p', 5);
    });

    it('cn/global 渠道也开 4-15(2026-08-03 探测):7 秒落库 7;3 秒 → 400', async () => {
        submitVideoWithKey.mockImplementation(() =>
            Promise.resolve(NextResponse.json({ id: 'cgt-d1', task_id: 'cgt-d1', status: 'queued' })),
        );
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance-2-0', prompt: 'x', duration: 7 }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(db.seedanceVideoTask.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ duration: 7 }),
        });
        const bad = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance-2-0-global', prompt: 'x', duration: 3 }),
            '/video/generations',
        );
        expect(bad.status).toBe(400);
        const body = await bad.json();
        expect(body.error.message).toContain('4-15');
    });

    it('seedance 2.5 系 duration 上限 30(4-30):16/30 接受落库,31 → 400 文案含 4-30', async () => {
        submitVideoWithKey.mockImplementation(() =>
            Promise.resolve(NextResponse.json({ id: 'cgt-25', task_id: 'cgt-25', status: 'queued' })),
        );
        for (const ok of [16, 30]) {
            const res = await handleEnterpriseV1(
                req('POST', '/v1/video/generations', {
                    model: 'seedance-2-5',
                    prompt: 'x',
                    resolution: '720p',
                    duration: ok,
                }),
                '/video/generations',
            );
            expect(res.status).toBe(200);
            expect(db.seedanceVideoTask.create).toHaveBeenLastCalledWith({
                data: expect.objectContaining({ duration: ok }),
            });
        }
        const bad = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'seedance-2-5',
                prompt: 'x',
                resolution: '720p',
                duration: 31,
            }),
            '/video/generations',
        );
        expect(bad.status).toBe(400);
        const body = await bad.json();
        expect(body.error.message).toContain('4-30');
    });

    it('duration=-1(智能时长)接受并落库 -1(余额门按上限估价,不 400)', async () => {
        submitVideoWithKey.mockImplementation(() =>
            Promise.resolve(NextResponse.json({ id: 'cgt-neg1', task_id: 'cgt-neg1', status: 'queued' })),
        );
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'seedance-2-5',
                prompt: 'x',
                resolution: '720p',
                duration: -1,
            }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(db.seedanceVideoTask.create).toHaveBeenLastCalledWith({
            data: expect.objectContaining({ duration: -1 }),
        });
    });

    it('volc 非法 resolution(360p)→ 400,错误文案含 480p 白名单', async () => {
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'doubao-seedance-2.0',
                prompt: 'x',
                resolution: '360p',
            }),
            '/video/generations',
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.message).toContain('480p');
        expect(submitVolcVideo).not.toHaveBeenCalled();
    });

    it('480p 全线开放(2026-08-03):cn 短名 seedance-2-0 传 480p → 长名 seedance2.0-pro-480p', async () => {
        submitVideoWithKey.mockResolvedValue(
            NextResponse.json({ id: 'cgt-p480', task_id: 'cgt-p480', status: 'queued' }),
        );
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance-2-0', prompt: 'x', resolution: '480p' }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(submitVideoWithKey).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'seedance2.0-pro-480p' }),
            expect.any(String),
        );
        expect(db.seedanceVideoTask.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ model: 'seedance-2-0', resolution: '480p' }),
        });
    });

    it('promax-fast 仅 720p(上游 artsdance intl,2026-08-08):720p 放行长名 seedance2.0-promax-fast-720p;480p/1080p → 400', async () => {
        submitVideoWithKey.mockResolvedValue(
            NextResponse.json({ id: 'cgt-pm720', task_id: 'cgt-pm720', status: 'queued' }),
        );
        const ok = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'seedance-2-0-promax-fast',
                prompt: 'x',
                resolution: '720p',
            }),
            '/video/generations',
        );
        expect(ok.status).toBe(200);
        expect(submitVideoWithKey).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'seedance2.0-promax-fast-720p' }),
            expect.any(String),
        );
        for (const resolution of ['480p', '1080p']) {
            const bad = await handleEnterpriseV1(
                req('POST', '/v1/video/generations', { model: 'seedance-2-0-promax-fast', prompt: 'x', resolution }),
                '/video/generations',
            );
            expect(bad.status).toBe(400);
        }
    });

    it('seedance-2-5(国内版新代):720p → 长名 seedance2.5-720p,任务行存短名', async () => {
        submitVideoWithKey.mockResolvedValue(
            NextResponse.json({ id: 'cgt-25a', task_id: 'cgt-25a', status: 'queued' }),
        );
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance-2-5', prompt: 'x', resolution: '720p' }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(submitVideoWithKey).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'seedance2.5-720p' }),
            expect.any(String),
        );
        expect(db.seedanceVideoTask.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ model: 'seedance-2-5', resolution: '720p' }),
        });
    });

    it('seedance-2-5 带参考图 + 1080p → -ref 长名(seedance2.5-1080p-ref)', async () => {
        submitVideoWithKey.mockResolvedValue(
            NextResponse.json({ id: 'cgt-25b', task_id: 'cgt-25b', status: 'queued' }),
        );
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'seedance-2-5',
                prompt: 'x',
                resolution: '1080p',
                image: 'https://example.com/a.jpg',
            }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(submitVideoWithKey).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'seedance2.5-1080p-ref' }),
            expect.any(String),
        );
    });

    it('seedance-2-5 无 480p/4k(上游 artsdance-2-5-pro 不支持):传 480p → 400,不打上游', async () => {
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance-2-5', prompt: 'x', resolution: '480p' }),
            '/video/generations',
        );
        expect(res.status).toBe(400);
        expect(submitVideoWithKey).not.toHaveBeenCalled();
    });

    it('global 无 480p(intl 上游实测拒,2026-08-06):三变体 480p 均 400 带指引,不打上游', async () => {
        for (const model of ['seedance-2-0-global', 'seedance-2-0-global-fast', 'seedance-2-0-global-mini']) {
            const res = await handleEnterpriseV1(
                req('POST', '/v1/video/generations', { model, prompt: 'x', resolution: '480p' }),
                '/video/generations',
            );
            expect(res.status).toBe(400);
            const body = (await res.json()) as { error: { message: string } };
            expect(body.error.message).toContain('国内版'); // proMax 2026-08-08 起也无 480p,指引改为国内版
        }
        expect(submitVideoWithKey).not.toHaveBeenCalled();
    });

    it('非 volc 提交仍剥 asset:// 前缀(resolveAssetRefs 收到裸 id)', async () => {
        submitVideoWithKey.mockResolvedValue(NextResponse.json({ id: 'cgt-c1', task_id: 'cgt-c1', status: 'queued' }));
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'seedance-2-0',
                content: [
                    { type: 'text', text: 'x' },
                    { type: 'image_url', image_url: { url: 'asset://asset-1' }, role: 'first_frame' },
                ],
                resolution: '720p',
            }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        const passed = resolveAssetRefs.mock.calls[0][0] as {
            content: Array<{ image_url?: { url: string } }>;
        };
        expect(passed.content[1].image_url?.url).toBe('asset-1');
    });
});

describe('isEnterpriseFlavor', () => {
    it('只在 PORTAL_FLAVOR=seedance-enterprise 时为 true', () => {
        delete process.env.PORTAL_FLAVOR;
        expect(isEnterpriseFlavor()).toBe(false);
        process.env.PORTAL_FLAVOR = 'seedance-enterprise';
        expect(isEnterpriseFlavor()).toBe(true);
        delete process.env.PORTAL_FLAVOR;
    });
});

describe('分发白名单', () => {
    it('GET /models → 11 个归一短名(国内 3 + 2.5 + global 3 + promax 3 + promax 2.5)', async () => {
        const res = await handleEnterpriseV1(req('GET', '/v1/models'), '/models');
        const j = (await res.json()) as { data: Array<{ id: string }> };
        expect(res.status).toBe(200);
        expect(j.data.map((m) => m.id)).toEqual([
            'seedance-2-0',
            'seedance-2-0-fast',
            'seedance-2-0-mini',
            'seedance-2-5',
            'seedance-2-0-global',
            'seedance-2-0-global-fast',
            'seedance-2-0-global-mini',
            'seedance-2-0-promax',
            'seedance-2-0-promax-fast',
            'seedance-2-0-promax-mini',
            'seedance-2-5-promax',
        ]);
    });

    it('白名单外路径(/chat/completions 等)→ 404', async () => {
        for (const [method, path] of [
            ['POST', '/chat/completions'],
            ['POST', '/images/generations'],
            ['GET', '/balance'],
        ] as const) {
            const res = await handleEnterpriseV1(req(method, `/v1${path}`, method === 'GET' ? undefined : {}), path);
            expect(res.status).toBe(404);
        }
    });
});

describe('提交', () => {
    const goodBody = { model: 'seedance2.0-pro-720p', prompt: '一只猫' };

    it('key 无效 → 401 透传 resolve 结果', async () => {
        resolveEnterpriseAuth.mockResolvedValue({
            ok: false,
            status: 401,
            code: 'invalid_api_key',
            message: 'invalid or inactive API key',
        });
        const res = await handleEnterpriseV1(req('POST', '/v1/video/generations', goodBody), '/video/generations');
        expect(res.status).toBe(401);
        expect(submitVideoWithKey).not.toHaveBeenCalled();
    });

    it('未知模型 → 400,不打上游', async () => {
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'gpt-5.5', prompt: 'x' }),
            '/video/generations',
        );
        expect(res.status).toBe(400);
        expect(submitVideoWithKey).not.toHaveBeenCalled();
    });

    it('余额不足 → 402,不打上游', async () => {
        db.account.findUnique.mockResolvedValue({ balance_cny: '1.00' });
        estimateEnterpriseCostCny.mockResolvedValue(4.26);
        const res = await handleEnterpriseV1(req('POST', '/v1/video/generations', goodBody), '/video/generations');
        expect(res.status).toBe(402);
        expect(submitVideoWithKey).not.toHaveBeenCalled();
    });

    it('无 Account 行 = 余额 0 → 402', async () => {
        db.account.findUnique.mockResolvedValue(null);
        const res = await handleEnterpriseV1(req('POST', '/v1/video/generations', goodBody), '/video/generations');
        expect(res.status).toBe(402);
    });

    it('happy:用【客户独立上游 key】直调核心,任务落库 tier=enterprise-portal', async () => {
        submitVideoWithKey.mockResolvedValue(NextResponse.json({ id: 'cgt-e1', task_id: 'cgt-e1', status: 'queued' }));
        const res = await handleEnterpriseV1(req('POST', '/v1/video/generations', goodBody), '/video/generations');
        expect(res.status).toBe(200);
        expect(submitVideoWithKey).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'seedance2.0-pro-720p' }),
            'Bearer sk-upstream-u1',
        );
        expect(db.seedanceVideoTask.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                id: 'cgt-e1',
                user_id: 'u1',
                newapi_user_id: null,
                tier: 'enterprise-portal',
                resolution: '720p',
                has_video: false,
            }),
        });
    });

    it('上游失败 → 状态/体透传,不落任务', async () => {
        submitVideoWithKey.mockResolvedValue(
            NextResponse.json({ error: { message: '账户余额不足5元' } }, { status: 403 }),
        );
        const res = await handleEnterpriseV1(req('POST', '/v1/video/generations', goodBody), '/video/generations');
        expect(res.status).toBe(403);
        expect(db.seedanceVideoTask.create).not.toHaveBeenCalled();
    });

    it('任务落库失败 → 503 fail closed(防生成了收不到钱)', async () => {
        submitVideoWithKey.mockResolvedValue(NextResponse.json({ id: 'cgt-e2', status: 'queued' }));
        db.seedanceVideoTask.create.mockRejectedValue(new Error('db down'));
        const res = await handleEnterpriseV1(req('POST', '/v1/video/generations', goodBody), '/video/generations');
        expect(res.status).toBe(503);
    });

    it('P3 素材引用:resolveAssetRefs 替换后的 body 才发上游', async () => {
        const substituted = {
            model: 'seedance2.0-pro-720p-ref',
            prompt: '一只猫',
            images: ['https://r2/asset-1.png'],
        };
        resolveAssetRefs.mockResolvedValue(substituted);
        submitVideoWithKey.mockResolvedValue(NextResponse.json({ id: 'cgt-e3', status: 'queued' }));
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'seedance2.0-pro-720p-ref',
                prompt: '一只猫',
                images: ['asset-20260719120000-aaaaaa'],
            }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(resolveAssetRefs).toHaveBeenCalledWith(
            expect.objectContaining({ images: ['asset-20260719120000-aaaaaa'] }),
            'u1',
            undefined, // 非 volc:严格模式
        );
        expect(submitVideoWithKey).toHaveBeenCalledWith(substituted, 'Bearer sk-upstream-u1');
    });

    it('P3 素材引用非本人/不存在 → 400,不打上游', async () => {
        resolveAssetRefs.mockRejectedValue(new AssetError('AssetNotFound', '素材不存在: asset-x', 400));
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance2.0-pro-720p-ref', prompt: 'x', images: ['x'] }),
            '/video/generations',
        );
        expect(res.status).toBe(400);
        expect(submitVideoWithKey).not.toHaveBeenCalled();
    });
});

describe('归一短名(2026-07-20)', () => {
    beforeEach(() => {
        submitVideoWithKey.mockResolvedValue(NextResponse.json({ id: 'cgt-u1', task_id: 'cgt-u1', status: 'queued' }));
    });

    it('seedance-2-0 默认 720p 文生:适配器收长名,任务行与响应回显短名', async () => {
        submitVideoWithKey.mockResolvedValue(
            NextResponse.json({ id: 'cgt-u1', task_id: 'cgt-u1', model: 'seedance2.0-pro-720p', status: 'queued' }),
        );
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance-2-0', prompt: '一只猫' }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(submitVideoWithKey).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'seedance2.0-pro-720p' }),
            'Bearer sk-upstream-u1',
        );
        expect(db.seedanceVideoTask.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ model: 'seedance-2-0', resolution: '720p' }),
        });
        expect(((await res.json()) as { model: string }).model).toBe('seedance-2-0');
    });

    it('global 短名(2026-07-23):鉴权带 region=global,适配器收 global 长名,回显短名', async () => {
        resolveEnterpriseAuth.mockResolvedValue({ ok: true, customer: { ...CUSTOMER, region: 'global' } });
        submitVideoWithKey.mockResolvedValue(
            NextResponse.json({
                id: 'cgt-g1',
                task_id: 'cgt-g1',
                model: 'seedance2.0-global-mini-720p',
                status: 'queued',
            }),
        );
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance-2-0-global-mini', prompt: '一只猫' }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(resolveEnterpriseAuth).toHaveBeenCalledWith(expect.anything(), 'global');
        expect(submitVideoWithKey).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'seedance2.0-global-mini-720p' }),
            'Bearer sk-upstream-u1',
        );
        expect(db.seedanceVideoTask.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ model: 'seedance-2-0-global-mini', resolution: '720p' }),
        });
        expect(((await res.json()) as { model: string }).model).toBe('seedance-2-0-global-mini');
    });

    it('global 任务轮询:cn key → 403 region_mismatch;global key → pollVideoWithKey 带 global', async () => {
        const gTask = {
            id: 'cgt-g1',
            user_id: 'u1',
            tier: 'enterprise-portal',
            model: 'seedance-2-0-global',
            tokens: null,
            status: 'queued',
        };
        db.seedanceVideoTask.findUnique.mockResolvedValue(gTask);
        // cn key(默认 CUSTOMER)→ 403
        let res = await handleEnterpriseV1(req('GET', '/v1/video/generations/cgt-g1'), '/video/generations/cgt-g1');
        expect(res.status).toBe(403);
        expect(pollVideoWithKey).not.toHaveBeenCalled();
        // global key → 透传轮询,base 走海外
        resolveEnterpriseAuth.mockResolvedValue({ ok: true, customer: { ...CUSTOMER, region: 'global' } });
        pollVideoWithKey.mockResolvedValue(NextResponse.json({ id: 'cgt-g1', status: 'in_progress', progress: 50 }));
        res = await handleEnterpriseV1(req('GET', '/v1/video/generations/cgt-g1'), '/video/generations/cgt-g1');
        expect(res.status).toBe(200);
        expect(pollVideoWithKey).toHaveBeenCalledWith('cgt-g1', 'Bearer sk-upstream-u1', 'global');
    });

    it('volc 任务轮询:AK/SK 默认 region=cn 也不误判 region_mismatch,走 pollVolcVideo', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({
            id: 'task_v9',
            user_id: 'u1',
            tier: 'enterprise-portal',
            model: 'doubao-seedance-2.0',
            tokens: null,
            status: 'queued',
        });
        pollVolcVideo.mockResolvedValue(NextResponse.json({ id: 'task_v9', status: 'in_progress', progress: 50 }));
        // CUSTOMER.region = 'cn'(AK/SK 账号级默认),但 volc 任务不应 403
        const res = await handleEnterpriseV1(req('GET', '/v1/video/generations/task_v9'), '/video/generations/task_v9');
        expect(res.status).toBe(200);
        expect(pollVolcVideo).toHaveBeenCalledWith('task_v9');
        expect(pollVideoWithKey).not.toHaveBeenCalled();
    });

    it('AK/SK 账号级轮询非 volc 任务:无版本门 + 按【任务 region】补加载上游 key(修 #294 回归)', async () => {
        // AK/SK 账号级:accountLevel=true,region 名义 'cn',upstreamKey='' (/api 未装载)
        resolveEnterpriseAuth.mockResolvedValue({
            ok: true,
            customer: { ...CUSTOMER, region: 'cn', upstreamKey: '', accountLevel: true },
        });
        db.seedanceVideoTask.findUnique.mockResolvedValue({
            id: 'cgt-g9',
            user_id: 'u1',
            tier: 'enterprise-portal',
            model: 'seedance-2-0-global', // global 任务
            tokens: null,
            status: 'queued',
        });
        pollVideoWithKey.mockResolvedValue(NextResponse.json({ id: 'cgt-g9', status: 'in_progress', progress: 50 }));
        const res = await handleEnterpriseV1(req('GET', '/v1/video/generations/cgt-g9'), '/video/generations/cgt-g9');
        expect(res.status).toBe(200); // 不因 region 名义 cn ≠ global 而 403
        // 按任务 region 'global' 补加载上游 key,而不是用空的 cust.upstreamKey
        expect(getUpstreamKeyForUser).toHaveBeenCalledWith('u1', 'global');
        expect(pollVideoWithKey).toHaveBeenCalledWith('cgt-g9', 'Bearer sk-upstream-by-region', 'global');
    });

    it('promax 短名:鉴权 region=promax,长名 seedance2.0-promax-mini-720p;1080p → 400(仅 720p)', async () => {
        resolveEnterpriseAuth.mockResolvedValue({ ok: true, customer: { ...CUSTOMER, region: 'promax' } });
        submitVideoWithKey.mockImplementation(() =>
            Promise.resolve(NextResponse.json({ id: 'cgt-pm1', task_id: 'cgt-pm1', status: 'queued' })),
        );
        let res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance-2-0-promax-mini', prompt: '一只猫' }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(resolveEnterpriseAuth).toHaveBeenCalledWith(expect.anything(), 'promax');
        expect(submitVideoWithKey).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'seedance2.0-promax-mini-720p' }),
            'Bearer sk-upstream-u1',
        );
        // fast/mini 仅 720p:1080p → 400
        res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'seedance-2-0-promax-mini',
                prompt: 'x',
                resolution: '1080p',
            }),
            '/video/generations',
        );
        expect(res.status).toBe(400);
        // promax(pro)4k 放行
        submitVideoWithKey.mockClear();
        res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance-2-0-promax', prompt: 'x', resolution: '4k' }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(submitVideoWithKey).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'seedance2.0-promax-4k' }),
            'Bearer sk-upstream-u1',
        );
        // promax(pro)480p → 400(上游 artsdance intl 不支持,2026-08-08),不打上游
        submitVideoWithKey.mockClear();
        res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance-2-0-promax', prompt: 'x', resolution: '480p' }),
            '/video/generations',
        );
        expect(res.status).toBe(400);
        expect(submitVideoWithKey).not.toHaveBeenCalled();
    });

    it('proMax 2.5(2026-08-08):720p/1080p → seedance2.5-promax-{res};480p/4k → 400', async () => {
        resolveEnterpriseAuth.mockResolvedValue({ ok: true, customer: { ...CUSTOMER, region: 'promax' } });
        submitVideoWithKey.mockImplementation(() =>
            Promise.resolve(NextResponse.json({ id: 'cgt-p25', task_id: 'cgt-p25', status: 'queued' })),
        );
        // 720p → seedance2.5-promax-720p
        let res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance-2-5-promax', prompt: 'x', resolution: '720p' }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(submitVideoWithKey).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'seedance2.5-promax-720p' }),
            'Bearer sk-upstream-u1',
        );
        // 1080p → seedance2.5-promax-1080p
        submitVideoWithKey.mockClear();
        res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance-2-5-promax', prompt: 'x', resolution: '1080p' }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(submitVideoWithKey).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'seedance2.5-promax-1080p' }),
            'Bearer sk-upstream-u1',
        );
        // 480p / 4k → 400,不打上游
        submitVideoWithKey.mockClear();
        for (const resolution of ['480p', '4k']) {
            const bad = await handleEnterpriseV1(
                req('POST', '/v1/video/generations', { model: 'seedance-2-5-promax', prompt: 'x', resolution }),
                '/video/generations',
            );
            expect(bad.status).toBe(400);
        }
        expect(submitVideoWithKey).not.toHaveBeenCalled();
    });

    it('resolution 参数选档 + 带参考图自动加 -ref:mini@1080p+images → seedance2.0-mini-1080p-ref', async () => {
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'seedance-2-0-mini',
                resolution: '1080p',
                prompt: 'x',
                images: ['https://cdn/x.png'],
            }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(submitVideoWithKey).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'seedance2.0-mini-1080p-ref' }),
            'Bearer sk-upstream-u1',
        );
        expect(db.seedanceVideoTask.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ model: 'seedance-2-0-mini', resolution: '1080p' }),
        });
    });

    it('大小写不敏感(Seedance-2-0-Fast)+ first_frame 也触发 ref', async () => {
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'Seedance-2-0-Fast',
                prompt: 'x',
                first_frame: 'https://cdn/f.png',
            }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(submitVideoWithKey).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'seedance2.0-fast-720p-ref' }),
            'Bearer sk-upstream-u1',
        );
    });

    it('4k 仅 pro:seedance-2-0@4k 通过,fast/mini@4k → 400 不打上游', async () => {
        let res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance-2-0', resolution: '4k', prompt: 'x' }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(submitVideoWithKey).toHaveBeenLastCalledWith(
            expect.objectContaining({ model: 'seedance2.0-pro-4k' }),
            'Bearer sk-upstream-u1',
        );
        submitVideoWithKey.mockClear();
        res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance-2-0-fast', resolution: '4k', prompt: 'x' }),
            '/video/generations',
        );
        expect(res.status).toBe(400);
        expect(submitVideoWithKey).not.toHaveBeenCalled();
    });

    it('非法 resolution → 400;旧长名仍兼容', async () => {
        const bad = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance-2-0', resolution: '2k', prompt: 'x' }),
            '/video/generations',
        );
        expect(bad.status).toBe(400);
        const legacy = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'seedance2.0-fast-1080p', prompt: 'x' }),
            '/video/generations',
        );
        expect(legacy.status).toBe(200);
        expect(submitVideoWithKey).toHaveBeenLastCalledWith(
            expect.objectContaining({ model: 'seedance2.0-fast-1080p' }),
            'Bearer sk-upstream-u1',
        );
    });

    it('素材引用(asset→URL)也触发 ref 识别(替换在识别之前)', async () => {
        resolveAssetRefs.mockResolvedValue({
            model: 'seedance-2-0',
            prompt: 'x',
            images: ['https://r2/asset-1.png'],
        });
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'seedance-2-0',
                prompt: 'x',
                images: ['asset-20260719120000-aaaaaa'],
            }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(submitVideoWithKey).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'seedance2.0-pro-720p-ref' }),
            'Bearer sk-upstream-u1',
        );
    });
});

describe('轮询', () => {
    const task = {
        id: 'cgt-e1',
        user_id: 'u1',
        tier: 'enterprise-portal',
        model: 'seedance-2-0',
        tokens: null,
        status: 'queued',
    };

    it('任务不存在 / 非本人 / 非 enterprise tier → 404(IDOR + 与 seedance-cn 渠道任务隔离)', async () => {
        for (const t of [null, { ...task, user_id: 'other' }, { ...task, tier: 'seedance-cn-enterprise' }]) {
            db.seedanceVideoTask.findUnique.mockResolvedValue(t);
            const res = await handleEnterpriseV1(
                req('GET', '/v1/video/generations/cgt-e1'),
                '/video/generations/cgt-e1',
            );
            expect(res.status).toBe(404);
        }
        expect(pollVideoWithKey).not.toHaveBeenCalled();
    });

    it('完成 → 写 tokens + 幂等扣费,响应透传', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue(task);
        pollVideoWithKey.mockResolvedValue(
            NextResponse.json({
                id: 'cgt-e1',
                status: 'completed',
                video_url: 'https://volcvideo.com/x.mp4',
                usage: { completion_tokens: 108872 },
            }),
        );
        chargeEnterpriseVideoTask.mockResolvedValue({ outcome: 'charged', costCny: 4.26 });
        const res = await handleEnterpriseV1(req('GET', '/v1/video/generations/cgt-e1'), '/video/generations/cgt-e1');
        expect(res.status).toBe(200);
        expect(pollVideoWithKey).toHaveBeenCalledWith('cgt-e1', 'Bearer sk-upstream-u1', 'cn');
        expect(db.seedanceVideoTask.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { tokens: BigInt(108872), status: 'completed' } }),
        );
        expect(chargeEnterpriseVideoTask).toHaveBeenCalledWith('cgt-e1');
        const j = (await res.json()) as { video_url?: string };
        expect(j.video_url).toContain('volcvideo');
    });

    it('未完成 → 不写 tokens 不扣费', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue(task);
        pollVideoWithKey.mockResolvedValue(NextResponse.json({ id: 'cgt-e1', status: 'in_progress' }));
        const res = await handleEnterpriseV1(req('GET', '/v1/video/generations/cgt-e1'), '/video/generations/cgt-e1');
        expect(res.status).toBe(200);
        expect(chargeEnterpriseVideoTask).not.toHaveBeenCalled();
    });

    it('失败 → 标 failed 不计费', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue(task);
        pollVideoWithKey.mockResolvedValue(
            NextResponse.json({ id: 'cgt-e1', status: 'failed', fail_reason: 'sensitive content' }),
        );
        await handleEnterpriseV1(req('GET', '/v1/video/generations/cgt-e1'), '/video/generations/cgt-e1');
        expect(db.seedanceVideoTask.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { status: 'failed', fail_reason: 'sensitive content' } }),
        );
        expect(chargeEnterpriseVideoTask).not.toHaveBeenCalled();
    });
});
