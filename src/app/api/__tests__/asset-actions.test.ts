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
    it('happy:抓 URL → storeAsset → Result {Id, Status, URL}', async () => {
        fetchAssetFromUrl.mockResolvedValue({ bytes: Buffer.from('img'), mime: 'image/png' });
        storeAsset.mockResolvedValue({ id: 'asset-20260719120000-abcdef', public_url: 'https://r2/a.png' });
        const res = await POST(
            req('CreateAsset', { AssetType: 'image', URL: 'https://example.com/a.png', Name: '主角图' }),
        );
        expect(res.status).toBe(200);
        const j = (await res.json()) as { Result: { Id: string; Status: string; URL: string } };
        expect(j.Result.Id).toMatch(/^asset-/);
        expect(j.Result.Status).toBe('active');
        expect(storeAsset).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'u1', assetType: 'image', sourceUrl: 'https://example.com/a.png' }),
        );
    });

    it('AssetType 非法 / 缺 Name → 400 InvalidParameter,不抓 URL', async () => {
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

describe('volc 客户素材库路由(2026-08-06 v2:按素材内容归属,与鉴权方式无关)', () => {
    const VOLC_ON = { id: 'up-volc' };

    it('volc 客户 + AIGC 建组(缺省 GroupType,AK/SK 也一样)→ 平台库', async () => {
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue(VOLC_ON);
        db.enterpriseAssetGroup.count.mockResolvedValue(0);
        db.enterpriseAssetGroup.create.mockResolvedValue({
            id: 'group-r2-1',
            name: 'g',
            description: null,
            created_at: new Date(),
        });
        const res = await POST(req('CreateAssetGroup', { Name: 'g' }));
        expect(res.status).toBe(200);
        expect(db.enterpriseAssetGroup.create).toHaveBeenCalled();
        expect(handleVolcAssetAction).not.toHaveBeenCalled();
    });

    it('volc 客户 + GroupType=LivenessFace 建组(真人)→ provider', async () => {
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue(VOLC_ON);
        handleVolcAssetAction.mockResolvedValue({ Id: 'group-provider-1' });
        const res = await POST(req('CreateAssetGroup', { Name: 'g', GroupType: 'LivenessFace' }));
        expect(res.status).toBe(200);
        expect(handleVolcAssetAction).toHaveBeenCalledWith(
            'CreateAssetGroup',
            expect.objectContaining({ GroupType: 'LivenessFace' }),
        );
        expect(db.enterpriseAssetGroup.create).not.toHaveBeenCalled();
    });

    it('volc 客户 + CreateAsset 进平台组 → R2;进非平台组(真人/provider)→ provider', async () => {
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue(VOLC_ON);
        // 平台组命中
        db.enterpriseAssetGroup.findFirst.mockResolvedValueOnce({ id: 'group-ours' });
        fetchAssetFromUrl.mockResolvedValue({ bytes: 100, mime: 'image/png' });
        storeAsset.mockResolvedValue({ id: 'asset-r2-2', public_url: 'https://r2/b.png' });
        let res = await POST(
            req('CreateAsset', { GroupId: 'group-ours', URL: 'https://x/b.png', AssetType: 'Image', Name: 'b.png' }),
        );
        expect(res.status).toBe(200);
        expect(storeAsset).toHaveBeenCalled();
        expect(handleVolcAssetAction).not.toHaveBeenCalled();
        // 非平台组
        db.enterpriseAssetGroup.findFirst.mockResolvedValueOnce(null);
        handleVolcAssetAction.mockResolvedValue({ Id: 'asset-provider-1' });
        res = await POST(
            req('CreateAsset', {
                GroupId: 'group-20260806171100-74vfz',
                URL: 'https://x/c.png',
                AssetType: 'Image',
                Name: 'c.png',
            }),
        );
        expect(res.status).toBe(200);
        expect(handleVolcAssetAction).toHaveBeenCalledWith('CreateAsset', expect.anything());
    });

    it('volc 客户 + GetAsset:id 在平台库 → R2;不在 → provider', async () => {
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue(VOLC_ON);
        // 平台命中(gate findFirst + R2 路径 findFirst 各一次)
        db.enterpriseAsset.findFirst.mockResolvedValue({
            id: 'asset-ours',
            user_id: 'u1',
            asset_type: 'image',
            name: 'a',
            description: null,
            group_id: null,
            public_url: 'https://r2/a.png',
            bytes: 1,
            mime: 'image/png',
            created_at: new Date(),
        });
        let res = await POST(req('GetAsset', { Id: 'asset-ours' }));
        expect(res.status).toBe(200);
        expect(handleVolcAssetAction).not.toHaveBeenCalled();
        // 非平台 id → provider
        db.enterpriseAsset.findFirst.mockResolvedValue(null);
        handleVolcAssetAction.mockResolvedValue({ Id: 'asset-20260731141456-79gk9' });
        res = await POST(req('GetAsset', { Id: 'asset-20260731141456-79gk9' }));
        expect(res.status).toBe(200);
        expect(handleVolcAssetAction).toHaveBeenCalledWith('GetAsset', expect.anything());
    });

    it('volc 客户 + ListAssets Filter.GroupType=LivenessFace → provider;缺省 → 平台库', async () => {
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue(VOLC_ON);
        handleVolcAssetAction.mockResolvedValue({ Items: [], Total: 0 });
        let res = await POST(req('ListAssets', { Filter: { GroupType: 'LivenessFace' } }));
        expect(res.status).toBe(200);
        expect(handleVolcAssetAction).toHaveBeenCalledWith('ListAssets', expect.anything());
        vi.clearAllMocks();
        resolveEnterpriseAuth.mockResolvedValue(CUSTOMER);
        db.enterpriseUpstreamKey.findUnique.mockResolvedValue(VOLC_ON);
        db.enterpriseAsset.findMany.mockResolvedValue([]);
        db.enterpriseAsset.count.mockResolvedValue(0);
        res = await POST(req('ListAssets', {}));
        expect(res.status).toBe(200);
        expect(handleVolcAssetAction).not.toHaveBeenCalled();
    });

    it('非 volc 客户 → CreateAsset 仍走 R2(storeAsset),gate 不打 DB', async () => {
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
