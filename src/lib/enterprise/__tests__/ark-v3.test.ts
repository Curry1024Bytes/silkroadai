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
    resolveEnterpriseCustomer,
    submitVideoWithKey,
    pollVideoWithKey,
    estimateEnterpriseCostCny,
    chargeEnterpriseVideoTask,
} = vi.hoisted(() => ({
    db: {
        seedanceVideoTask: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
        account: { findUnique: vi.fn() },
    },
    resolveEnterpriseCustomer: vi.fn(),
    submitVideoWithKey: vi.fn(),
    pollVideoWithKey: vi.fn(),
    estimateEnterpriseCostCny: vi.fn(),
    chargeEnterpriseVideoTask: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('../keys', () => ({ resolveEnterpriseCustomer }));
vi.mock('@/lib/seedance/cn-adapter', async (importOriginal) => {
    const mod = await importOriginal<typeof import('@/lib/seedance/cn-adapter')>();
    return { ...mod, submitVideoWithKey, pollVideoWithKey };
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

import { handleEnterpriseArkV3 } from '../proxy';

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
    resolveEnterpriseCustomer.mockResolvedValue({ ok: true, customer: CUSTOMER });
    db.account.findUnique.mockResolvedValue({ balance_cny: '100' });
    estimateEnterpriseCostCny.mockResolvedValue(4.26);
    db.seedanceVideoTask.create.mockResolvedValue({});
    db.seedanceVideoTask.update.mockResolvedValue({});
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
        expect(j.error).toBeNull();
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
});
