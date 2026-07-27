/**
 * P3 素材库核心单测:id 格式 / SSRF 守门 / 配额 / 存储 / 生成引用解析。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, uploadImage, deleteImage } = vi.hoisted(() => ({
    db: {
        enterpriseAsset: {
            count: vi.fn(),
            aggregate: vi.fn(),
            create: vi.fn(),
            findFirst: vi.fn(),
            findMany: vi.fn(),
            delete: vi.fn(),
        },
        enterpriseAssetGroup: { findFirst: vi.fn(), findMany: vi.fn() },
    },
    uploadImage: vi.fn(),
    deleteImage: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/r2/client', () => ({ uploadImage, deleteImage }));

import { AssetError, assertSafeExternalUrl, newAssetId, storeAsset, deleteAsset, resolveAssetRefs } from '../assets';

beforeEach(() => {
    vi.clearAllMocks();
    db.enterpriseAsset.count.mockResolvedValue(0);
    db.enterpriseAsset.aggregate.mockResolvedValue({ _sum: { bytes: 0 } });
    uploadImage.mockResolvedValue('https://images.llmroute.club/enterprise-assets/u1/x.png');
});

describe('newAssetId', () => {
    it('火山风格:asset-YYYYMMDDHHMMSS-xxxxxx / group- 前缀', () => {
        expect(newAssetId('asset')).toMatch(/^asset-\d{14}-[0-9a-f]{6}$/);
        expect(newAssetId('group')).toMatch(/^group-\d{14}-[0-9a-f]{6}$/);
    });
});

describe('assertSafeExternalUrl(SSRF 守门)', () => {
    it('放行公网 http(s)', () => {
        expect(() => assertSafeExternalUrl('https://example.com/a.png')).not.toThrow();
        expect(() => assertSafeExternalUrl('http://cdn.foo.cn/v.mp4')).not.toThrow();
    });
    it.each([
        'ftp://example.com/a',
        'file:///etc/passwd',
        'http://localhost/x',
        'http://127.0.0.1/x',
        'http://10.0.0.5/x',
        'http://192.168.1.1/x',
        'http://172.16.0.1/x',
        'http://169.254.169.254/meta',
        'http://[::1]/x',
        'not a url',
    ])('拒绝 %s', (u) => {
        expect(() => assertSafeExternalUrl(u)).toThrow(AssetError);
    });
});

describe('storeAsset', () => {
    it('happy:R2 key 按约定,create 落库带公网 URL', async () => {
        db.enterpriseAsset.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve(data),
        );
        const row = (await storeAsset({
            userId: 'u1',
            assetType: 'image',
            name: '猫',
            bytes: Buffer.from('png-bytes'),
            mime: 'image/png',
        })) as unknown as Record<string, unknown>;
        expect(String(row.id)).toMatch(/^asset-/);
        expect(String(row.r2_key)).toMatch(/^enterprise-assets\/u1\/asset-.*\.png$/);
        expect(uploadImage).toHaveBeenCalledWith(expect.stringMatching(/\.png$/), expect.any(Buffer), 'image/png');
    });

    it('素材数达上限 → QuotaExceeded', async () => {
        db.enterpriseAsset.count.mockResolvedValue(5000);
        await expect(
            storeAsset({ userId: 'u1', assetType: 'image', name: 'x', bytes: Buffer.from('a'), mime: 'image/png' }),
        ).rejects.toMatchObject({ code: 'QuotaExceeded' });
    });

    it('groupId 非本人 → GroupNotFound,不上传', async () => {
        db.enterpriseAssetGroup.findFirst.mockResolvedValue(null);
        await expect(
            storeAsset({
                userId: 'u1',
                assetType: 'image',
                name: 'x',
                groupId: 'group-20260719000000-abcdef',
                bytes: Buffer.from('a'),
                mime: 'image/png',
            }),
        ).rejects.toMatchObject({ code: 'GroupNotFound' });
        expect(uploadImage).not.toHaveBeenCalled();
    });
});

describe('deleteAsset', () => {
    it('本人素材:删行 + R2 best-effort', async () => {
        db.enterpriseAsset.findFirst.mockResolvedValue({ id: 'asset-1', r2_key: 'enterprise-assets/u1/a.png' });
        db.enterpriseAsset.delete.mockResolvedValue({});
        deleteImage.mockResolvedValue(undefined);
        expect(await deleteAsset('u1', 'asset-1')).toBe(true);
        expect(deleteImage).toHaveBeenCalledWith('enterprise-assets/u1/a.png');
    });
    it('别人的/不存在 → false 不删', async () => {
        db.enterpriseAsset.findFirst.mockResolvedValue(null);
        expect(await deleteAsset('u1', 'asset-x')).toBe(false);
        expect(db.enterpriseAsset.delete).not.toHaveBeenCalled();
    });
});

describe('resolveAssetRefs(生成引用)', () => {
    const A1 = 'asset-20260719120000-aaaaaa';
    const A2 = 'asset-20260719120001-bbbbbb';
    const G1 = 'group-20260719120002-cccccc';

    it('无引用 → 原样返回,不打 DB', async () => {
        const body = { model: 'seedance2.0-pro-720p', prompt: '一只猫', images: ['https://x.com/a.png'] };
        expect(await resolveAssetRefs(body, 'u1')).toBe(body);
        expect(db.enterpriseAsset.findMany).not.toHaveBeenCalled();
    });

    it('asset id(标量 + 数组 + {url:})→ 替换成 R2 URL', async () => {
        db.enterpriseAsset.findMany.mockResolvedValue([
            { id: A1, public_url: 'https://r2/a1.png' },
            { id: A2, public_url: 'https://r2/a2.png' },
        ]);
        const out = await resolveAssetRefs({ model: 'm', prompt: 'p', first_frame: A1, images: [{ url: A2 }] }, 'u1');
        expect(out.first_frame).toBe('https://r2/a1.png');
        expect((out.images as Array<{ url: string }>)[0].url).toBe('https://r2/a2.png');
    });

    it('group id 在数组里 → 按序展开成员 URL', async () => {
        db.enterpriseAsset.findMany
            .mockResolvedValueOnce([]) // assets 查询(无 asset 引用时不会调,这里给 groups 腿)
            .mockResolvedValueOnce([
                { group_id: G1, public_url: 'https://r2/g1-1.png' },
                { group_id: G1, public_url: 'https://r2/g1-2.png' },
            ]);
        // 注意 mock 顺序:实现里 assets/groups 两条 findMany 并行;无 asset 引用时只发 groups 一条
        db.enterpriseAsset.findMany.mockReset();
        db.enterpriseAsset.findMany.mockResolvedValue([
            { group_id: G1, public_url: 'https://r2/g1-1.png' },
            { group_id: G1, public_url: 'https://r2/g1-2.png' },
        ]);
        db.enterpriseAssetGroup.findMany.mockResolvedValue([{ id: G1 }]);
        const out = await resolveAssetRefs({ model: 'm', images: [G1, 'https://x.com/c.png'] }, 'u1');
        expect(out.images).toEqual(['https://r2/g1-1.png', 'https://r2/g1-2.png', 'https://x.com/c.png']);
    });

    it('group id 在标量字段 → InvalidParameter', async () => {
        db.enterpriseAsset.findMany.mockResolvedValue([{ group_id: G1, public_url: 'https://r2/x.png' }]);
        db.enterpriseAssetGroup.findMany.mockResolvedValue([{ id: G1 }]);
        await expect(resolveAssetRefs({ model: 'm', first_frame: G1 }, 'u1')).rejects.toMatchObject({
            code: 'InvalidParameter',
        });
    });

    it('非本人 asset → AssetNotFound(IDOR)', async () => {
        db.enterpriseAsset.findMany.mockResolvedValue([]); // 查不到 = 不是本人的
        await expect(resolveAssetRefs({ model: 'm', images: [A1] }, 'u1')).rejects.toMatchObject({
            code: 'AssetNotFound',
        });
    });

    it('空素材组 → InvalidParameter(明确报错优于静默 0 图)', async () => {
        db.enterpriseAsset.findMany.mockResolvedValue([]);
        db.enterpriseAssetGroup.findMany.mockResolvedValue([{ id: G1 }]);
        await expect(resolveAssetRefs({ model: 'm', images: [G1] }, 'u1')).rejects.toMatchObject({
            code: 'InvalidParameter',
        });
    });

    it('prompt 字段里长得像 id 的字符串不动(SKIP_KEYS)', async () => {
        db.enterpriseAsset.findMany.mockResolvedValue([{ id: A1, public_url: 'https://r2/a1.png' }]);
        const out = await resolveAssetRefs({ model: 'm', prompt: A1, images: [A1] }, 'u1');
        expect(out.prompt).toBe(A1);
        expect((out.images as string[])[0]).toBe('https://r2/a1.png');
    });
});
