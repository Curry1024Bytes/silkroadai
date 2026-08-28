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
        seedanceVideoTask: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
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
// callerHasVolc:鉴权前的「调用方是不是 volc 客户」探测(决定火山原生模型名按哪个渠道解释)。
// 缺省 false = 按 cn 解释,与既有用例的期望一致;需要 volc 语义的用例自行 mockResolvedValue(true)。
const { callerHasVolc } = vi.hoisted(() => ({ callerHasVolc: vi.fn(async () => false) }));
vi.mock('../keys', () => ({ resolveEnterpriseAuth, getUpstreamKeyForUser, callerHasVolc }));
const { toUpstreamId } = vi.hoisted(() => ({ toUpstreamId: vi.fn(async (id: string) => id) }));
vi.mock('../volc-id-map', () => ({ toUpstreamId }));
const { uploadImage } = vi.hoisted(() => ({
    uploadImage: vi.fn(async (key: string) => `https://images.silkroadai.io/${key}.jpg`),
}));
vi.mock('@/lib/r2/client', () => ({ uploadImage }));
vi.mock('@/lib/seedance/cn-adapter', async (importOriginal) => {
    const mod = await importOriginal<typeof import('@/lib/seedance/cn-adapter')>();
    return { ...mod, submitVideoWithKey, pollVideoWithKey };
});
vi.mock('@/lib/seedance/kuaizi-adapter', async (importOriginal) => {
    const mod = await importOriginal<typeof import('@/lib/seedance/kuaizi-adapter')>();
    return { ...mod, submitVolcVideo, pollVolcVideo };
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
import { AssetError } from '../assets';

import { handleEnterpriseArkV3, handleEnterpriseV1, isEnterpriseFlavor } from '../proxy';
import { __resetPollCache } from '../poll-cache';

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
        expect(submitVolcVideo).toHaveBeenCalledWith(expect.objectContaining({ prompt: '一只猫' }), {
            clientModel: 'doubao-seedance-2.0',
            resolution: '1080p',
            duration: 5,
        });
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
        expect(submitVolcVideo).toHaveBeenCalledWith(expect.objectContaining({ content }), {
            clientModel: 'doubao-seedance-2.0',
            resolution: '720p',
            duration: 5,
        });
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
        expect(submitVolcVideo).toHaveBeenCalledWith(expect.objectContaining({ prompt: '一只猫' }), {
            clientModel: 'doubao-seedance-2.0',
            resolution: '480p',
            duration: 5,
        });
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
        expect(submitVolcVideo).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ resolution: '720p', duration: 7 }),
        );
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
            expect(submitVolcVideo).toHaveBeenLastCalledWith(
                expect.anything(),
                expect.objectContaining({ resolution: '720p', duration: ok }),
            );
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
        expect(submitVolcVideo).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({ resolution: '720p', duration: 5 }),
        );
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

describe('火山渠道(volc)模型档位 —— fast/mini 已下架(2026-08-19),仅 2.0 / 2.5 在售', () => {
    beforeEach(() => {
        submitVolcVideo.mockImplementation(() =>
            Promise.resolve(NextResponse.json({ id: 'cgt-m1', task_id: 'cgt-m1', status: 'queued' })),
        );
    });

    it.each([
        ['doubao-seedance-2.0', 'pro'],
        ['doubao-seedance-2.5', '2.5'],
    ])('%s 走 volc 适配器(不走 cn),按对客名落库', async (model) => {
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model, prompt: 'x', resolution: '720p' }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(submitVolcVideo).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ clientModel: model, resolution: '720p' }),
        );
        expect(submitVideoWithKey).not.toHaveBeenCalled();
        expect(db.seedanceVideoTask.create).toHaveBeenCalledWith({ data: expect.objectContaining({ model }) });
    });

    it('分辨率按档位门控:2.5 无 4k → 400 且不打上游', async () => {
        // ⚠️ 2.5 的 1080p 上游 2026-08-18(文档 v1.2)已放开,不再在此列 —— 见下一条用例
        for (const [model, res_] of [['doubao-seedance-2.5', '4k']] as const) {
            const res = await handleEnterpriseV1(
                req('POST', '/v1/video/generations', { model, prompt: 'x', resolution: res_ }),
                '/video/generations',
            );
            expect(res.status).toBe(400);
            expect((await res.json()).error.message).toContain('resolution 仅支持');
        }
        expect(submitVolcVideo).not.toHaveBeenCalled();
    });

    // 2026-08-19 实测:fast/mini 的 vendor_task_id 返 tsk-…(非方舟),pro/2.5 返 cgt-…(方舟)。
    // 本渠道卖的是原生火山 —— 这两档的片子不是火山出的,先下架。
    it.each(['doubao-seedance-2.0-fast', 'doubao-seedance-2.0-mini'])(
        '%s 已下架 → 400 model_unavailable,且【不打上游】(不白花钱)',
        async (model) => {
            const res = await handleEnterpriseV1(
                req('POST', '/v1/video/generations', { model, prompt: 'x', resolution: '720p' }),
                '/video/generations',
            );
            expect(res.status).toBe(400);
            const j = await res.json();
            expect(j.error.code).toBe('model_unavailable');
            expect(j.error.message).toContain('doubao-seedance-2.5');
            expect(submitVolcVideo).not.toHaveBeenCalled();
            expect(submitVideoWithKey).not.toHaveBeenCalled();
            expect(db.seedanceVideoTask.create).not.toHaveBeenCalled();
        },
    );

    it('下架对火山方舟形(ark)入口同样生效 —— 两个调用面共用同一道闸', async () => {
        const res = await handleEnterpriseArkV3(
            req('POST', '/api/v3/contents/generations/tasks', {
                model: 'doubao-seedance-2.0-mini',
                content: [{ type: 'text', text: 'x' }],
                resolution: '720p',
            }),
            '/contents/generations/tasks',
        );
        expect(res.status).toBe(400);
        expect(submitVolcVideo).not.toHaveBeenCalled();
    });

    it('2.5 @1080p 现在放行(上游 v1.2 放开,实测确认)', async () => {
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'doubao-seedance-2.5',
                prompt: 'x',
                resolution: '1080p',
                ratio: 'adaptive',
            }),
            '/video/generations',
        );
        expect(res.status).toBe(200);
        expect(submitVolcVideo).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ clientModel: 'doubao-seedance-2.5', resolution: '1080p' }),
        );
    });

    it('pro 保留 4k;2.5 时长上限 30(31 → 400 文案含 4-30)', async () => {
        const ok = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'doubao-seedance-2.0', prompt: 'x', resolution: '4k' }),
            '/video/generations',
        );
        expect(ok.status).toBe(200);

        const good = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'doubao-seedance-2.5', prompt: 'x', duration: 30 }),
            '/video/generations',
        );
        expect(good.status).toBe(200);
        expect(submitVolcVideo).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({ clientModel: 'doubao-seedance-2.5', duration: 30 }),
        );

        const bad = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'doubao-seedance-2.5', prompt: 'x', duration: 31 }),
            '/video/generations',
        );
        expect(bad.status).toBe(400);
        expect((await bad.json()).error.message).toContain('4-30');
    });

    it('参考素材数量按档位封顶:2.0 系 >9 图 400,2.5 放宽到 30 图', async () => {
        const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://cdn.test/${i}.jpg`);
        const over = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'doubao-seedance-2.0',
                prompt: 'x',
                images: urls(10),
            }),
            '/video/generations',
        );
        expect(over.status).toBe(400);
        expect((await over.json()).error.message).toContain('最多 9 张参考图');
        expect(submitVolcVideo).not.toHaveBeenCalled();

        const ok = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', { model: 'doubao-seedance-2.5', prompt: 'x', images: urls(10) }),
            '/video/generations',
        );
        expect(ok.status).toBe(200);
    });

    it('2.5 首帧/首尾帧任务非 adaptive → 400 前置拦截(上游创建时同步拒)', async () => {
        const bad = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'doubao-seedance-2.5',
                prompt: 'x',
                first_frame: 'https://cdn.test/a.jpg',
                ratio: '16:9',
            }),
            '/video/generations',
        );
        expect(bad.status).toBe(400);
        expect((await bad.json()).error.message).toContain('adaptive');
        expect(submitVolcVideo).not.toHaveBeenCalled();

        const ok = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'doubao-seedance-2.5',
                prompt: 'x',
                first_frame: 'https://cdn.test/a.jpg',
                ratio: 'adaptive',
            }),
            '/video/generations',
        );
        expect(ok.status).toBe(200);
    });
});

describe('轮询遇上游 4xx —— 终态化 vs 瞬时(2026-08-18,8925 次轮询事故)', () => {
    const task = {
        id: 'cgt-ttc1',
        tier: 'enterprise-portal',
        user_id: 'u1',
        model: 'seedance-2-5',
        resolution: '720p',
        has_video: false,
        status: 'queued',
        tokens: null,
        created_at: new Date('2026-08-17T08:19:22Z'),
        duration: 4,
        ratio: '16:9',
        seed: null,
        generate_audio: true,
        fail_reason: null,
    };
    /** 适配器对上游 4xx 的归一错误体(带 category)。 */
    const adapterErr = (category: string, message: string, status: number) =>
        new NextResponse(JSON.stringify({ error: { code: 'upstream_error', message, category } }), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });

    beforeEach(() => {
        db.seedanceVideoTask.findUnique.mockResolvedValue(task);
        db.seedanceVideoTask.updateMany.mockResolvedValue({ count: 1 });
    });

    it('TaskTypeConstraint(4xx 终态)→ 落库 failed + 返回 status:failed,客户据此停止轮询', async () => {
        pollVideoWithKey.mockResolvedValue(
            adapterErr(
                'task_type_constraint',
                '模型按提示词判定本次为「视频编辑 / 视频延长」任务 —— ratio 必须为 adaptive',
                400,
            ),
        );
        const res = await handleEnterpriseV1(
            req('GET', '/v1/video/generations/cgt-ttc1'),
            '/video/generations/cgt-ttc1',
        );

        // 关键:HTTP 200 + status=failed(不是把 400 抛给客户 —— 那会被脚本当异常然后无限重试)
        expect(res.status).toBe(200);
        const j = (await res.json()) as { status: string; fail_reason: string };
        expect(j.status).toBe('failed');
        expect(j.fail_reason).toContain('adaptive');
        // 且已终态化落库,下次轮询走短路、根本不再打上游
        expect(db.seedanceVideoTask.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'cgt-ttc1' },
                data: expect.objectContaining({ status: 'failed' }),
            }),
        );
    });

    it('内容审核(4xx 终态)同样终态化', async () => {
        pollVideoWithKey.mockResolvedValue(adapterErr('content_safety', '提示词未通过内容安全审核', 400));
        const res = await handleEnterpriseV1(
            req('GET', '/v1/video/generations/cgt-ttc1'),
            '/video/generations/cgt-ttc1',
        );
        expect(res.status).toBe(200);
        expect(((await res.json()) as { status: string }).status).toBe('failed');
        expect(db.seedanceVideoTask.updateMany).toHaveBeenCalled();
    });

    it('502(瞬时)→ 降级返库内状态,【不】落库 failed(任务还在跑,不能误杀)', async () => {
        pollVideoWithKey.mockResolvedValue(adapterErr('upstream_unavailable', '上游暂时不可用,请稍后重试', 502));
        const res = await handleEnterpriseV1(
            req('GET', '/v1/video/generations/cgt-ttc1'),
            '/video/generations/cgt-ttc1',
        );
        // 轮询失败 ≠ 任务失败:给 200 + 库内状态,客户脚本照常轮询而不是当异常中断整条流水线
        expect(res.status).toBe(200);
        expect(res.headers.get('X-Silkroadai-Poll-Degraded')).toBe('1');
        expect(((await res.json()) as { status: string }).status).toBe('queued');
        expect(db.seedanceVideoTask.updateMany).not.toHaveBeenCalled();
    });

    it('429(限流)→ 同样降级,不误杀', async () => {
        pollVideoWithKey.mockResolvedValue(adapterErr('rate_limited', '请求过于频繁,请稍后重试', 429));
        const res = await handleEnterpriseV1(
            req('GET', '/v1/video/generations/cgt-ttc1'),
            '/video/generations/cgt-ttc1',
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('X-Silkroadai-Poll-Degraded')).toBe('1');
        expect(db.seedanceVideoTask.updateMany).not.toHaveBeenCalled();
    });

    it('降级回显库里的真实进度:in_progress 不会被说成 queued', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({ ...task, status: 'in_progress' });
        pollVideoWithKey.mockResolvedValue(adapterErr('upstream_unavailable', '上游暂时不可用', 503));
        const res = await handleEnterpriseV1(
            req('GET', '/v1/video/generations/cgt-ttc1'),
            '/video/generations/cgt-ttc1',
        );
        const j = (await res.json()) as { status: string; progress: number };
        expect(j.status).toBe('in_progress');
        expect(j.progress).toBe(50);
    });

    it('火山形(ark)降级走官方 status 词表(running),不吐我们的内部词', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({
            ...task,
            status: 'in_progress',
            model: 'doubao-seedance-2.5',
        });
        pollVolcVideo.mockResolvedValue(adapterErr('rate_limited', '请求过于频繁', 429));
        const res = await handleEnterpriseArkV3(
            req('GET', '/api/v3/contents/generations/tasks/cgt-ttc1'),
            '/contents/generations/tasks/cgt-ttc1',
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('X-Silkroadai-Poll-Degraded')).toBe('1');
        expect(((await res.json()) as { status: string }).status).toBe('running');
    });

    it('4xx 的 unknown 仍原样透传 —— 对它降级会造出新的无限轮询', async () => {
        pollVideoWithKey.mockResolvedValue(adapterErr('unknown', '上游拒绝了本次请求 —— 未知原因', 400));
        const res = await handleEnterpriseV1(
            req('GET', '/v1/video/generations/cgt-ttc1'),
            '/video/generations/cgt-ttc1',
        );
        expect(res.status).toBe(400);
        expect(res.headers.get('X-Silkroadai-Poll-Degraded')).toBeNull();
        expect(db.seedanceVideoTask.updateMany).not.toHaveBeenCalled();
    });

    it('已 failed 的任务短路,压根不打上游(终态化后的稳态)', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({
            ...task,
            status: 'failed',
            fail_reason: 'ratio 必须 adaptive',
        });
        const res = await handleEnterpriseV1(
            req('GET', '/v1/video/generations/cgt-ttc1'),
            '/video/generations/cgt-ttc1',
        );
        expect(res.status).toBe(200);
        const j = (await res.json()) as { status: string; fail_reason: string };
        expect(j.status).toBe('failed');
        expect(j.fail_reason).toBe('ratio 必须 adaptive');
        expect(pollVideoWithKey).not.toHaveBeenCalled();
    });
});

describe('vendor_task_id 出口(2026-08-19)', () => {
    const t = {
        id: 'cgt-v1',
        tier: 'enterprise-portal',
        user_id: 'u1',
        model: 'doubao-seedance-2.5',
        resolution: '720p',
        has_video: false,
        status: 'in_progress',
        tokens: null,
        created_at: new Date('2026-08-19T02:00:00Z'),
        duration: 4,
        ratio: 'adaptive',
        seed: null,
        generate_audio: true,
        fail_reason: null,
    };
    const running = (vendor?: string) =>
        NextResponse.json({
            id: 'cgt-v1',
            task_id: 'cgt-v1',
            object: 'video',
            status: 'in_progress',
            progress: 50,
            ...(vendor ? { vendor_task_id: vendor } : {}),
        });

    beforeEach(() => db.seedanceVideoTask.findUnique.mockResolvedValue(t));

    // 2026-08-19 原生化:客户拿到的 `id` 本身就是火山官方任务号(提交时压着等来的),
    // 既不再单出「渠道侧原始 id」响应头,body 也不加键 —— 火山官方两者都没有。
    it.each([
        ['v1 形', handleEnterpriseV1, '/video/generations/cgt-v1'],
        ['火山形(ark)', handleEnterpriseArkV3, '/contents/generations/tasks/cgt-v1'],
    ] as const)('%s:不再有 X-Silkroadai-Vendor-Task-Id 头', async (_label, handler, sub) => {
        pollVolcVideo.mockResolvedValue(running('cgt-20260817125256-tfv79'));
        const res = await handler(req('GET', `/api/v3${sub}`), sub);
        expect(res.status).toBe(200);
        expect(res.headers.get('X-Silkroadai-Vendor-Task-Id')).toBeNull();
    });

    // 2026-08-26 客户报障:提交 duration=-1(智能时长),响应一直回显 -1。
    // 库里存的就是提交参数,而上游在完成时会给出模型真正选的秒数 —— 该以上游为准。
    it('ark 回显优先用上游【已推导】的 duration / ratio,而不是库里的提交参数', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({ ...t, duration: -1, ratio: '16:9' });
        pollVolcVideo.mockResolvedValue(
            NextResponse.json({
                id: 'cgt-v1',
                task_id: 'cgt-v1',
                object: 'video',
                status: 'completed',
                progress: 100,
                video_url: 'https://v/1.mp4',
                usage: { completion_tokens: 100, total_tokens: 100 },
                duration: 5,
                ratio: 'adaptive',
            }),
        );
        const res = await handleEnterpriseArkV3(
            req('GET', '/api/v3/contents/generations/tasks/cgt-v1'),
            '/contents/generations/tasks/cgt-v1',
        );
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.duration).toBe(5);
        expect(body.ratio).toBe('adaptive');
    });

    it('上游没给(running 期 / 其它渠道适配器)→ 回落库里的值,行为不变', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({ ...t, duration: 8, ratio: '9:16' });
        pollVolcVideo.mockResolvedValue(
            NextResponse.json({ id: 'cgt-v1', task_id: 'cgt-v1', object: 'video', status: 'in_progress' }),
        );
        const res = await handleEnterpriseArkV3(
            req('GET', '/api/v3/contents/generations/tasks/cgt-v1'),
            '/contents/generations/tasks/cgt-v1',
        );
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.duration).toBe(8);
        expect(body.ratio).toBe('9:16');
    });

    // 2026-08-27 客户契约测试报障:volc 的 ark 响应缺 5 个火山官方字段。
    // 基准(客户给的):framespersecond=24 / generate_audio=true / draft=false /
    //                service_tier='default' / execution_expires_after=172800
    it('volc:火山官方字段集要出齐,值取【上游真值】', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({ ...t, duration: 4, ratio: '16:9' });
        pollVolcVideo.mockResolvedValue(
            NextResponse.json({
                id: 'cgt-v1',
                task_id: 'cgt-v1',
                object: 'video',
                status: 'completed',
                video_url: 'https://v/1.mp4',
                usage: { completion_tokens: 40594, total_tokens: 40594 },
                duration: 4,
                ratio: '16:9',
                resolution: '480p',
                framespersecond: 24,
                generate_audio: true,
                execution_expires_after: 172800,
                seed: 26206,
                tools: [],
            }),
        );
        const res = await handleEnterpriseArkV3(
            req('GET', '/api/v3/contents/generations/tasks/cgt-v1'),
            '/contents/generations/tasks/cgt-v1',
        );
        const b = (await res.json()) as Record<string, unknown>;
        expect(b.framespersecond).toBe(24);
        expect(b.generate_audio).toBe(true);
        expect(b.execution_expires_after).toBe(172800);
        expect(b.draft).toBe(false);
        expect(b.service_tier).toBe('default');
        expect(b.seed).toBe(26206);
        expect(b.tools).toEqual([]);
        // 客户基准里已匹配的三项不能回归
        expect(b.resolution).toBe('480p');
        expect(b.ratio).toBe('16:9');
        expect(b.duration).toBe(4);
    });

    // 2026-08-27 客户契约脚本:从查询响应读 upstream_id,用 ^cgt-\d{14}-[A-Za-z0-9]+$ 校验,
    // 缺了就判整轮失败。值 = 我们的对客 id(#398 起它本身就是火山官方任务号)。
    // 2026-08-28 客户契约脚本 04 暴露的 #398 回归:对客素材号换成火山形后,
    // 生成请求里的 asset:// 引用没跟着翻回上游号 → 上游 failed「asset … is not found」。
    // A/B 实测:火山号 failed、上游号 succeeded。
    it('volc:asset:// 引用翻回上游素材号再发上游(深走 content 与顶层别名)', async () => {
        vi.mocked(toUpstreamId).mockImplementation(async (id: string) =>
            id === 'asset-20260828014656-n7mc9' ? '193477566093328454' : id,
        );
        submitVolcVideo.mockImplementation(() =>
            Promise.resolve(NextResponse.json({ id: 'cgt-x', task_id: 'cgt-x', status: 'queued' })),
        );
        await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'doubao-seedance-2.5',
                resolution: '720p',
                content: [
                    { type: 'text', text: 'x' },
                    {
                        type: 'image_url',
                        image_url: { url: 'asset://asset-20260828014656-n7mc9' },
                        role: 'reference_image',
                    },
                ],
            }),
            '/video/generations',
        );
        const sent = submitVolcVideo.mock.calls[0][0] as { content: Array<Record<string, never>> };
        expect(JSON.stringify(sent)).toContain('asset://193477566093328454');
        expect(JSON.stringify(sent)).not.toContain('asset-20260828014656-n7mc9');
    });

    // 2026-08-28 客户列为「明确不兼容项」:上游对 content[].*_url.url 有 4000 字符硬上限
    // (实测原文 `is too long (6118 chars, max 4000)`),真实图片的 base64 根本进不去。
    // cn 渠道早就替客户把 data URL 转存 R2,volc 之前没做 —— 同平台两条渠道能力不一致。
    it('volc:内联 base64 转存 R2 后再发上游(上游 url 有 4000 字符硬上限)', async () => {
        vi.mocked(toUpstreamId).mockImplementation(async (id: string) => id);
        submitVolcVideo.mockImplementation(() =>
            Promise.resolve(NextResponse.json({ id: 'cgt-x', task_id: 'cgt-x', status: 'queued' })),
        );
        const big = 'data:image/png;base64,' + 'A'.repeat(8000);
        await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'doubao-seedance-2.5',
                resolution: '720p',
                content: [
                    { type: 'text', text: 'x' },
                    { type: 'image_url', image_url: { url: big }, role: 'reference_image' },
                ],
            }),
            '/video/generations',
        );
        const sent = JSON.stringify(submitVolcVideo.mock.calls[0][0]);
        expect(sent).not.toContain('data:image/png;base64');
        expect(sent).toContain('https://images.silkroadai.io/seedance-volc-ref/');
        expect(uploadImage).toHaveBeenCalled();
    });

    it('volc:内联 base64 超 20MB → 400,给可操作提示(不静默塞给上游)', async () => {
        vi.mocked(toUpstreamId).mockImplementation(async (id: string) => id);
        const huge = 'data:image/png;base64,' + 'A'.repeat(30 * 1024 * 1024);
        const res = await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'doubao-seedance-2.5',
                resolution: '720p',
                content: [
                    { type: 'text', text: 'x' },
                    { type: 'image_url', image_url: { url: huge }, role: 'reference_image' },
                ],
            }),
            '/video/generations',
        );
        expect(res.status).toBe(400);
        expect((await res.json()).error.message).toContain('20MB');
    });

    it('volc:映射查不到的引用原样透传(存量客户手里的上游号继续能用)', async () => {
        vi.mocked(toUpstreamId).mockImplementation(async (id: string) => id);
        submitVolcVideo.mockImplementation(() =>
            Promise.resolve(NextResponse.json({ id: 'cgt-x', task_id: 'cgt-x', status: 'queued' })),
        );
        await handleEnterpriseV1(
            req('POST', '/v1/video/generations', {
                model: 'doubao-seedance-2.5',
                resolution: '720p',
                content: [
                    { type: 'text', text: 'x' },
                    { type: 'video_url', video_url: { url: 'asset://193477566093328454' }, role: 'reference_video' },
                ],
            }),
            '/video/generations',
        );
        expect(JSON.stringify(submitVolcVideo.mock.calls[0][0])).toContain('asset://193477566093328454');
    });

    it('volc:查询响应带 upstream_id,且等于对客 id(客户脚本正则要求)', async () => {
        pollVolcVideo.mockResolvedValue(
            NextResponse.json({ id: 'cgt-v1', task_id: 'cgt-v1', object: 'video', status: 'in_progress' }),
        );
        const res = await handleEnterpriseArkV3(
            req('GET', '/api/v3/contents/generations/tasks/cgt-v1'),
            '/contents/generations/tasks/cgt-v1',
        );
        const b = (await res.json()) as Record<string, unknown>;
        expect(b.upstream_id).toBe(b.id);
        expect(b.upstream_id).toBe('cgt-v1');
    });

    it('volc:upstream_id 绝不是上游的 vendor_task_id(落非方舟时那是 tsk-,会泄露中间层)', async () => {
        pollVolcVideo.mockResolvedValue(
            NextResponse.json({
                id: 'cgt-v1',
                task_id: 'cgt-v1',
                object: 'video',
                status: 'in_progress',
                vendor_task_id: 'tsk-ghuya22ne4tyq74q',
            }),
        );
        const res = await handleEnterpriseArkV3(
            req('GET', '/api/v3/contents/generations/tasks/cgt-v1'),
            '/contents/generations/tasks/cgt-v1',
        );
        const body = await res.text();
        expect(JSON.parse(body).upstream_id).toBe('cgt-v1');
        expect(body).not.toContain('tsk-ghuya22ne4tyq74q');
    });

    it('volc:时间戳以上游为准(updated_at 不再是每查一次就变的 Date.now())', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({ ...t, created_at: new Date(1700000000000) });
        pollVolcVideo.mockResolvedValue(
            NextResponse.json({
                id: 'cgt-v1',
                task_id: 'cgt-v1',
                object: 'video',
                status: 'completed',
                video_url: 'https://v/1.mp4',
                usage: { completion_tokens: 1, total_tokens: 1 },
                upstream_created_at: 1787763028,
                upstream_updated_at: 1787763201,
                last_frame_url: '',
            }),
        );
        const res = await handleEnterpriseArkV3(
            req('GET', '/api/v3/contents/generations/tasks/cgt-v1'),
            '/contents/generations/tasks/cgt-v1',
        );
        const b = (await res.json()) as Record<string, unknown>;
        expect(b.created_at).toBe(1787763028);
        expect(b.updated_at).toBe(1787763201);
        // 无尾帧时键要在、值为空串
        expect((b.content as Record<string, unknown>).last_frame_url).toBe('');
    });

    it('volc:上游未受理(时间戳为 0)→ 回落我们的库值,不给客户 0', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({ ...t, created_at: new Date(1700000000000) });
        pollVolcVideo.mockResolvedValue(
            NextResponse.json({
                id: 'cgt-v1',
                task_id: 'cgt-v1',
                object: 'video',
                status: 'in_progress',
                upstream_created_at: 0,
                upstream_updated_at: 0,
            }),
        );
        const res = await handleEnterpriseArkV3(
            req('GET', '/api/v3/contents/generations/tasks/cgt-v1'),
            '/contents/generations/tasks/cgt-v1',
        );
        const b = (await res.json()) as Record<string, unknown>;
        expect(b.created_at).toBe(1700000000);
        expect(b.updated_at).not.toBe(0);
    });

    it('volc:上游还没给(running / 降级)→ 字段仍恒在,走火山官方默认值', async () => {
        db.seedanceVideoTask.findUnique.mockResolvedValue({ ...t, status: 'in_progress' });
        pollVolcVideo.mockResolvedValue(
            NextResponse.json({ id: 'cgt-v1', task_id: 'cgt-v1', object: 'video', status: 'in_progress' }),
        );
        const res = await handleEnterpriseArkV3(
            req('GET', '/api/v3/contents/generations/tasks/cgt-v1'),
            '/contents/generations/tasks/cgt-v1',
        );
        const b = (await res.json()) as Record<string, unknown>;
        expect(b.framespersecond).toBe(24);
        expect(b.execution_expires_after).toBe(172800);
        expect(b.service_tier).toBe('default');
        expect(b.draft).toBe(false);
    });

    it('火山形(ark)body 仍是官方字段集(#326 严格白名单)', async () => {
        pollVolcVideo.mockResolvedValue(running('cgt-20260817125256-tfv79'));
        const res = await handleEnterpriseArkV3(
            req('GET', '/api/v3/contents/generations/tasks/cgt-v1'),
            '/contents/generations/tasks/cgt-v1',
        );
        const body = (await res.json()) as Record<string, unknown>;
        expect(body).not.toHaveProperty('vendor_task_id');
        expect(body.status).toBe('running');
    });
});
