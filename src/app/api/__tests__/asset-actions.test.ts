/**
 * P3 火山形 Action API 单测:envelope / 鉴权 / CRUD 全 Action / IDOR / 分页。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { db, resolveEnterpriseAuth, fetchAssetFromUrl, storeAsset, deleteAssetFn } = vi.hoisted(() => ({
    db: {
        enterpriseAsset: {
            findFirst: vi.fn(),
            findMany: vi.fn(),
            count: vi.fn(),
            updateMany: vi.fn(),
        },
        enterpriseAssetGroup: {
            create: vi.fn(),
            findFirst: vi.fn(),
            findMany: vi.fn(),
            count: vi.fn(),
            updateMany: vi.fn(),
            delete: vi.fn(),
        },
        enterpriseUpstreamKey: { findUnique: vi.fn() },
        $transaction: vi.fn(),
    },
    resolveEnterpriseAuth: vi.fn(),
    fetchAssetFromUrl: vi.fn(),
    storeAsset: vi.fn(),
    deleteAssetFn: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/enterprise/keys', () => ({ resolveEnterpriseAuth }));
vi.mock('@/lib/enterprise/assets', async (importOriginal) => {
    const mod = await importOriginal<typeof import('@/lib/enterprise/assets')>();
    return { ...mod, fetchAssetFromUrl, storeAsset, deleteAsset: deleteAssetFn };
});
const { handleVolcAssetAction } = vi.hoisted(() => ({ handleVolcAssetAction: vi.fn() }));
vi.mock('@/lib/enterprise/volc-assets', async (importOriginal) => {
    const mod = await importOriginal<typeof import('@/lib/enterprise/volc-assets')>();
    return { ...mod, handleVolcAssetAction };
});

import { POST } from '../route';

const CUSTOMER = { ok: true, customer: { userId: 'u1', tenantId: null, keyId: 'k1', upstreamKey: 'up' } };

function req(action: string, body?: unknown): NextRequest {
    return new NextRequest(`http://128.241.232.23/api?Action=${action}&Version=2024-01-01&ns=asset_manager`, {
        method: 'POST',
        headers: { authorization: 'Bearer sk-ent-' + 'a'.repeat(48), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    resolveEnterpriseAuth.mockResolvedValue(CUSTOMER);
    // 默认非 volc 客户(无 volc 上游 key 行)→ 走 R2 素材库路径
    db.enterpriseUpstreamKey.findUnique.mockResolvedValue(null);
});

describe('envelope + 守门', () => {
    it('无 Action → 400 MissingParameter', async () => {
        const res = await POST(
            new NextRequest('http://x/api', { method: 'POST', headers: { authorization: 'Bearer x' } }),
        );
        expect(res.status).toBe(400);
    });

    it('key 无效 → 401,火山 Error envelope', async () => {
        resolveEnterpriseAuth.mockResolvedValue({ ok: false, status: 401, code: 'x', message: 'bad key' });
        const res = await POST(req('ListAssets', {}));
        expect(res.status).toBe(401);
        const j = (await res.json()) as { ResponseMetadata: { Error: { Code: string } } };
        expect(j.ResponseMetadata.Error.Code).toBe('UnauthorizedOperation');
    });

    it('x-enterprise-orig-path(middleware rewrite)→ 验签 path 用原始值;非白名单值忽略', async () => {
        db.enterpriseAssetGroup.count.mockResolvedValue(0);
        db.enterpriseAssetGroup.findMany.mockResolvedValue([]);
        const mk = (orig?: string) =>
            new NextRequest('http://128.241.232.23/api?Action=ListAssetGroups&Version=2024-01-01', {
                method: 'POST',
                headers: {
                    authorization: 'Bearer sk-ent-' + 'a'.repeat(48),
                    'content-type': 'application/json',
                    ...(orig ? { 'x-enterprise-orig-path': orig } : {}),
                },
                body: '{}',
            });
        // 火山官方根路径形态:客户签的是 "/"
        await POST(mk('/'));
        expect(resolveEnterpriseAuth.mock.calls[0][0].path).toBe('/');
        // 尾斜杠形态:客户签的是 "/api/"
        await POST(mk('/api/'));
        expect(resolveEnterpriseAuth.mock.calls[1][0].path).toBe('/api/');
        // 外部伪造任意值 → 忽略,回落真实 pathname
        await POST(mk('/evil'));
        expect(resolveEnterpriseAuth.mock.calls[2][0].path).toBe('/api');
        // 无头 → 原行为
        await POST(mk());
        expect(resolveEnterpriseAuth.mock.calls[3][0].path).toBe('/api');
    });

    it('未知 Action → 400 InvalidAction;成功响应带完整 ResponseMetadata', async () => {
        const res = await POST(req('DoWeirdThing', {}));
        expect(res.status).toBe(400);
        db.enterpriseAssetGroup.count.mockResolvedValue(0);
        db.enterpriseAssetGroup.findMany.mockResolvedValue([]);
        const ok = await POST(req('ListAssetGroups', {}));
        const j = (await ok.json()) as { ResponseMetadata: Record<string, string>; Result: unknown };
        expect(j.ResponseMetadata.Action).toBe('ListAssetGroups');
        expect(j.ResponseMetadata.Version).toBe('2024-01-01');
        expect(j.ResponseMetadata.Service).toBe('ark');
        expect(j.ResponseMetadata.RequestId).toBeTruthy();
    });
});

describe('CreateAsset', () => {
    it('happy:抓 URL → storeAsset → Result 仅 {Id}(火山官方,URL/状态经 GetAsset 查)', async () => {
        fetchAssetFromUrl.mockResolvedValue({ bytes: Buffer.from('img'), mime: 'image/png' });
        storeAsset.mockResolvedValue({ id: 'asset-20260719120000-abcdef', public_url: 'https://r2/a.png' });
        const res = await POST(
            req('CreateAsset', { AssetType: 'image', URL: 'https://example.com/a.png', Name: '主角图' }),
        );
        expect(res.status).toBe(200);
        const j = (await res.json()) as { Result: Record<string, unknown> };
        expect(j.Result).toEqual({ Id: 'asset-20260719120000-abcdef' });
        expect(storeAsset).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'u1', assetType: 'image', sourceUrl: 'https://example.com/a.png' }),
        );
    });

    it('Name 可选(火山官方):缺省从 URL 文件名派生;zod 报错带字段路径', async () => {
        fetchAssetFromUrl.mockResolvedValue({ bytes: Buffer.from('img'), mime: 'image/png' });
        storeAsset.mockResolvedValue({ id: 'asset-20260806000000-abcdef', public_url: 'https://r2/b.png' });
        const res = await POST(req('CreateAsset', { AssetType: 'Image', URL: 'https://example.com/照片.png' }));
        expect(res.status).toBe(200);
        expect(storeAsset).toHaveBeenCalledWith(expect.objectContaining({ name: '照片.png' }));
        // 缺 URL → 400 且 message 带字段名(客户 Go 报错可定位)
        const bad = await POST(req('CreateAsset', { AssetType: 'Image', Name: 'x' }));
        expect(bad.status).toBe(400);
        const j = (await bad.json()) as { ResponseMetadata: { Error: { Message: string } } };
        expect(j.ResponseMetadata.Error.Message).toContain('URL');
    });

    it('AssetType 非法 → 400 InvalidParameter,不抓 URL', async () => {
        const res = await POST(req('CreateAsset', { AssetType: 'doc', URL: 'https://x.com/a', Name: 'x' }));
        expect(res.status).toBe(400);
        expect(fetchAssetFromUrl).not.toHaveBeenCalled();
    });
});

describe('GetAsset / UpdateAsset / DeleteAsset', () => {
    it('GetAsset 非本人 → 404 AssetNotFound(查询带 user_id)', async () => {
        db.enterpriseAsset.findFirst.mockResolvedValue(null);
        const res = await POST(req('GetAsset', { Id: 'asset-20260719120000-abcdef' }));
        expect(res.status).toBe(404);
        expect(db.enterpriseAsset.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ user_id: 'u1' }) }),
        );
    });

    it('UpdateAsset:updateMany 带 (id, user_id),0 行 → 404', async () => {
        db.enterpriseAsset.updateMany.mockResolvedValue({ count: 0 });
        const res = await POST(req('UpdateAsset', { Id: 'asset-x', Name: '新名' }));
        expect(res.status).toBe(404);
    });

    it('DeleteAsset happy → Result {}', async () => {
        deleteAssetFn.mockResolvedValue(true);
        const res = await POST(req('DeleteAsset', { Id: 'asset-x' }));
        expect(res.status).toBe(200);
        expect(deleteAssetFn).toHaveBeenCalledWith('u1', 'asset-x');
    });
});

describe('ListAssets 分页', () => {
    it('PageNumber/PageSize → skip/take;返回 Total', async () => {
        db.enterpriseAsset.count.mockResolvedValue(42);
        db.enterpriseAsset.findMany.mockResolvedValue([]);
        const res = await POST(req('ListAssets', { PageNumber: 3, PageSize: 10 }));
        const j = (await res.json()) as { Result: { Total: number } };
        expect(j.Result.Total).toBe(42);
        expect(db.enterpriseAsset.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 10 }));
    });

    it('PageSize > 100 → 400', async () => {
        expect((await POST(req('ListAssets', { PageSize: 500 }))).status).toBe(400);
    });
});

describe('素材组', () => {
    it('CreateAssetGroup → Result.Id group- 前缀', async () => {
        db.enterpriseAssetGroup.create.mockImplementation(({ data }: { data: { id: string } }) =>
            Promise.resolve({ id: data.id }),
        );
        const res = await POST(req('CreateAssetGroup', { Name: '主角参考' }));
        const j = (await res.json()) as { Result: { Id: string } };
        expect(j.Result.Id).toMatch(/^group-/);
    });

    it('DeleteAssetGroup:成员解除引用 + 删组(事务)', async () => {
        db.enterpriseAssetGroup.findFirst.mockResolvedValue({ id: 'group-x' });
        db.$transaction.mockResolvedValue([]);
        const res = await POST(req('DeleteAssetGroup', { Id: 'group-x' }));
        expect(res.status).toBe(200);
        expect(db.$transaction).toHaveBeenCalled();
    });

    it('GetAssetGroup 带 AssetCount', async () => {
        db.enterpriseAssetGroup.findFirst.mockResolvedValue({
            id: 'group-x',
            name: 'g',
            description: null,
            created_at: new Date(),
        });
        db.enterpriseAsset.count.mockResolvedValue(3);
        const res = await POST(req('GetAssetGroup', { Id: 'group-x' }));
        const j = (await res.json()) as { Result: { AssetCount: number } };
        expect(j.Result.AssetCount).toBe(3);
    });
});

describe('素材库统一平台托管(2026-08-06 v3:真人素材四渠道通用,provider 路由下线)', () => {
    it('volc 客户 + LivenessFace 建组 → 平台库存 group_type(不再走 provider)', async () => {
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue({ id: 'up-volc' });
        db.enterpriseAssetGroup.create.mockResolvedValue({
            id: 'group-r2-lf',
            name: '真人组',
            description: null,
            group_type: 'LivenessFace',
            created_at: new Date(),
        });
        const res = await POST(req('CreateAssetGroup', { Name: '真人组', GroupType: 'LivenessFace' }));
        expect(res.status).toBe(200);
        expect(db.enterpriseAssetGroup.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ group_type: 'LivenessFace' }),
        });
        expect(handleVolcAssetAction).not.toHaveBeenCalled();
    });

    it('建组缺省 GroupType=AIGC;非法值 400', async () => {
        db.enterpriseAssetGroup.create.mockResolvedValue({
            id: 'group-r2-a',
            name: 'g',
            description: null,
            group_type: 'AIGC',
            created_at: new Date(),
        });
        let res = await POST(req('CreateAssetGroup', { Name: 'g' }));
        expect(res.status).toBe(200);
        expect(db.enterpriseAssetGroup.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ group_type: 'AIGC' }),
        });
        res = await POST(req('CreateAssetGroup', { Name: 'g', GroupType: 'Weird' }));
        expect(res.status).toBe(400);
    });

    it('ListAssetGroups 官方语义:缺省只列 AIGC;显式 LivenessFace 列真人组;GroupType 回显', async () => {
        db.enterpriseAssetGroup.count.mockResolvedValue(1);
        db.enterpriseAssetGroup.findMany.mockResolvedValue([
            {
                id: 'group-lf-1',
                name: '真人组',
                description: null,
                group_type: 'LivenessFace',
                created_at: new Date(),
            },
        ]);
        const res = await POST(req('ListAssetGroups', { GroupType: 'LivenessFace' }));
        expect(res.status).toBe(200);
        const j = (await res.json()) as { Result: { Items: Array<{ GroupType: string }> } };
        expect(j.Result.Items[0].GroupType).toBe('LivenessFace');
        expect(db.enterpriseAssetGroup.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { user_id: 'u1', group_type: 'LivenessFace' } }),
        );
        // 缺省 AIGC
        await POST(req('ListAssetGroups', {}));
        expect(db.enterpriseAssetGroup.findMany).toHaveBeenLastCalledWith(
            expect.objectContaining({ where: { user_id: 'u1', group_type: 'AIGC' } }),
        );
    });

    it('ListAssets Filter.GroupType=LivenessFace → 限真人组内素材;缺省排除真人组', async () => {
        db.enterpriseAssetGroup.findMany.mockResolvedValue([{ id: 'group-lf-1' }]);
        db.enterpriseAsset.count.mockResolvedValue(0);
        db.enterpriseAsset.findMany.mockResolvedValue([]);
        let res = await POST(req('ListAssets', { Filter: { GroupType: 'LivenessFace' } }));
        expect(res.status).toBe(200);
        expect(db.enterpriseAsset.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ group_id: { in: ['group-lf-1'] } }),
            }),
        );
        res = await POST(req('ListAssets', {}));
        expect(res.status).toBe(200);
        expect(db.enterpriseAsset.findMany).toHaveBeenLastCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    OR: [{ group_id: null }, { group_id: { notIn: ['group-lf-1'] } }],
                }),
            }),
        );
        expect(handleVolcAssetAction).not.toHaveBeenCalled();
    });

    it('volc 客户 CreateAsset 也走平台库(provider 素材路由已下线)', async () => {
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue({ id: 'up-volc' });
        fetchAssetFromUrl.mockResolvedValue({ bytes: 100, mime: 'image/png' });
        storeAsset.mockResolvedValue({ id: 'asset-r2-2', public_url: 'https://r2/b.png' });
        const res = await POST(
            req('CreateAsset', { GroupId: 'group-1', URL: 'https://x/b.png', AssetType: 'Image', Name: 'b.png' }),
        );
        expect(res.status).toBe(200);
        expect(storeAsset).toHaveBeenCalled();
        expect(handleVolcAssetAction).not.toHaveBeenCalled();
    });

    it('非 volc 客户 → CreateAsset 走 R2(不变)', async () => {
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue(null);
        fetchAssetFromUrl.mockResolvedValue({ bytes: 100, mime: 'image/png' });
        storeAsset.mockResolvedValue({ id: 'asset-r2-1', public_url: 'https://r2/a.png' });
        const res = await POST(
            req('CreateAsset', { GroupId: 'group-1', URL: 'https://x/a.png', AssetType: 'image', Name: 'f.png' }),
        );
        expect(res.status).toBe(200);
        expect(storeAsset).toHaveBeenCalled();
        expect(handleVolcAssetAction).not.toHaveBeenCalled();
    });
});

describe('ListAssets / ListAssetGroups Filter(对齐火山官方 Name / Statuses / GroupIds)', () => {
    it('ListAssets Filter.Name → 名称模糊(不区分大小写)', async () => {
        db.enterpriseAssetGroup.findMany.mockResolvedValue([]); // 无真人组
        db.enterpriseAsset.count.mockResolvedValue(0);
        db.enterpriseAsset.findMany.mockResolvedValue([]);
        const res = await POST(req('ListAssets', { Filter: { Name: '测试' } }));
        expect(res.status).toBe(200);
        expect(db.enterpriseAsset.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ name: { contains: '测试', mode: 'insensitive' } }),
            }),
        );
    });

    it('ListAssets Filter.Statuses 不含 Active → 短路空集,不查库(平台素材恒 Active)', async () => {
        const res = await POST(req('ListAssets', { Filter: { Statuses: ['Processing', 'Failed'] } }));
        expect(res.status).toBe(200);
        const j = (await res.json()) as { Result: { Items: unknown[]; Total: number } };
        expect(j.Result.Items).toEqual([]);
        expect(j.Result.Total).toBe(0);
        expect(db.enterpriseAsset.findMany).not.toHaveBeenCalled();
        expect(db.enterpriseAsset.count).not.toHaveBeenCalled();
    });

    it('ListAssets Filter.Statuses 含 Active → 正常查库', async () => {
        db.enterpriseAssetGroup.findMany.mockResolvedValue([]);
        db.enterpriseAsset.count.mockResolvedValue(1);
        db.enterpriseAsset.findMany.mockResolvedValue([]);
        const res = await POST(req('ListAssets', { Filter: { Statuses: ['Active'] } }));
        expect(res.status).toBe(200);
        expect(db.enterpriseAsset.findMany).toHaveBeenCalled();
    });

    it('ListAssets Filter.GroupIds(数组)→ group_id in,跳过 GroupType 语义(不查真人组)', async () => {
        db.enterpriseAsset.count.mockResolvedValue(0);
        db.enterpriseAsset.findMany.mockResolvedValue([]);
        const res = await POST(req('ListAssets', { Filter: { GroupIds: ['group-a', 'group-b'] } }));
        expect(res.status).toBe(200);
        // 显式组 → 不做真人组排除查询
        expect(db.enterpriseAssetGroup.findMany).not.toHaveBeenCalled();
        expect(db.enterpriseAsset.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ group_id: { in: ['group-a', 'group-b'] } }),
            }),
        );
    });

    it('顶层 GroupId 优先于 Filter.GroupIds', async () => {
        db.enterpriseAsset.count.mockResolvedValue(0);
        db.enterpriseAsset.findMany.mockResolvedValue([]);
        const res = await POST(req('ListAssets', { GroupId: 'group-top', Filter: { GroupIds: ['group-a'] } }));
        expect(res.status).toBe(200);
        expect(db.enterpriseAsset.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ group_id: 'group-top' }) }),
        );
    });

    it('ListAssetGroups Filter.Name → 组名称模糊', async () => {
        db.enterpriseAssetGroup.count.mockResolvedValue(0);
        db.enterpriseAssetGroup.findMany.mockResolvedValue([]);
        const res = await POST(req('ListAssetGroups', { Filter: { Name: 'v-group' } }));
        expect(res.status).toBe(200);
        expect(db.enterpriseAssetGroup.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    group_type: 'AIGC',
                    name: { contains: 'v-group', mode: 'insensitive' },
                }),
            }),
        );
    });

    it('ListAssetGroups Filter.GroupIds(数组)→ id in', async () => {
        db.enterpriseAssetGroup.count.mockResolvedValue(0);
        db.enterpriseAssetGroup.findMany.mockResolvedValue([]);
        const res = await POST(req('ListAssetGroups', { Filter: { GroupIds: ['group-a', 'group-b'] } }));
        expect(res.status).toBe(200);
        expect(db.enterpriseAssetGroup.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    group_type: 'AIGC',
                    id: { in: ['group-a', 'group-b'] },
                }),
            }),
        );
    });
});

describe('AssetType 大写对齐火山官方', () => {
    it('CreateAsset 传大写 Image → 接受,归一小写存 R2', async () => {
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue(null); // 非 volc → R2
        fetchAssetFromUrl.mockResolvedValue({ bytes: Buffer.from('x'), mime: 'image/png' });
        storeAsset.mockResolvedValue({ id: 'asset-up-1', public_url: 'https://r2/a.png' });
        const res = await POST(req('CreateAsset', { AssetType: 'Image', URL: 'https://x/a.png', Name: '主角' }));
        expect(res.status).toBe(200);
        expect(storeAsset).toHaveBeenCalledWith(expect.objectContaining({ assetType: 'image' }));
    });

    it('GetAsset 输出 AssetType 回大写(对齐官方)', async () => {
        db.enterpriseAsset.findFirst.mockResolvedValue({
            id: 'asset-1',
            name: 'a',
            description: null,
            asset_type: 'video',
            group_id: null,
            public_url: 'https://r2/a.mp4',
            bytes: 1,
            mime: 'video/mp4',
            created_at: new Date(),
        });
        const res = await POST(req('GetAsset', { Id: 'asset-1' }));
        const j = (await res.json()) as { Result: { AssetType: string } };
        expect(j.Result.AssetType).toBe('Video');
    });
});
