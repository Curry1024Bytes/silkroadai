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
