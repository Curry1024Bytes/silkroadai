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

import {
    AssetError,
    assertSafeExternalUrl,
    newAssetId,
    storeAsset,
    deleteAsset,
    resolveAssetRefs,
    validateAssetMedia,
    readImageDims,
} from '../assets';

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

/** 造一张合规的最小 PNG(仅签名 + IHDR,宽高可控 —— 媒体校验只读头)。 */
function pngOf(w: number, h: number): Buffer {
    const b = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12, 'latin1');
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
}
const OK_PNG = pngOf(1024, 768);

/** 造一段最小 WAV(fmt byteRate + data 长度决定时长)。 */
function wavOf(byteRate: number, dataLen: number): Buffer {
    const b = Buffer.alloc(44 + dataLen); // data 实长 = 声明长度(截断文件按不可判处理)
    b.write('RIFF', 0, 'latin1');
    b.write('WAVE', 8, 'latin1');
    b.write('fmt ', 12, 'latin1');
    b.writeUInt32LE(16, 16); // fmt chunk size
    b.writeUInt32LE(byteRate, 28); // offset 12+16 = 28
    b.write('data', 36, 'latin1');
    b.writeUInt32LE(dataLen, 40);
    return b;
}

describe('validateAssetMedia(火山官方媒体规则全量对齐,2026-08-06)', () => {
    it('合规图放行;宽高越界 → 400 带实际尺寸(官方开区间 300-6000)', () => {
        expect(() => validateAssetMedia('image', OK_PNG, 'image/png')).not.toThrow();
        expect(() => validateAssetMedia('image', pngOf(200, 200), 'image/png')).toThrow(/300-6000/);
        expect(() => validateAssetMedia('image', pngOf(7000, 1000), 'image/png')).toThrow(/300-6000/);
        // 开区间:恰好 300 / 6000 也拒
        expect(() => validateAssetMedia('image', pngOf(300, 400), 'image/png')).toThrow(/300-6000/);
    });

    it('宽高比越界 → 400 带实际比例;边界内放行(官方开区间 0.4-2.5)', () => {
        expect(() => validateAssetMedia('image', pngOf(3000, 400), 'image/png')).toThrow(/宽高比/);
        expect(() => validateAssetMedia('image', pngOf(400, 3000), 'image/png')).toThrow(/宽高比/);
        expect(() => validateAssetMedia('image', pngOf(2500, 1000), 'image/png')).toThrow(/宽高比/); // 恰好 2.5
        expect(() => validateAssetMedia('image', pngOf(2400, 1000), 'image/png')).not.toThrow(); // 2.4 放行
    });

    it('图片格式白名单含 BMP/TIFF(官方);非白名单 → 400', () => {
        expect(() => validateAssetMedia('image', pngOf(1024, 768), 'image/bmp')).not.toThrow();
        expect(() => validateAssetMedia('image', pngOf(1024, 768), 'image/tiff')).not.toThrow();
        expect(() => validateAssetMedia('image', pngOf(1024, 768), 'image/svg+xml')).toThrow(/BMP\/TIFF/);
    });

    it('多条错误按官方语义用 \\n 逐条列出', () => {
        try {
            validateAssetMedia('image', pngOf(100, 8000), 'image/svg+xml');
            throw new Error('should have thrown');
        } catch (e) {
            const msg = (e as Error).message;
            expect(msg.split('\n').length).toBeGreaterThanOrEqual(3); // 格式 + 宽高 + 比例
            expect(msg).toMatch(/宽高/);
            expect(msg).toMatch(/宽高比/);
        }
    });

    it('解析不出尺寸(非图/截断)→ 400,不静默放行', () => {
        expect(() => validateAssetMedia('image', Buffer.from('not-an-image'), 'image/png')).toThrow(/无法解析图片尺寸/);
    });

    it('视频:格式白名单 + 大小;认不出的维度跳过不误杀', () => {
        expect(() => validateAssetMedia('video', Buffer.alloc(1000), 'video/webm')).toThrow(/MP4\/MOV/);
        // 零字节 MP4:时长/维度/帧率都解析不出 → 只过格式与大小,不误杀
        expect(() => validateAssetMedia('video', Buffer.alloc(1000), 'video/mp4')).not.toThrow();
        expect(() => validateAssetMedia('video', Buffer.alloc(60 * 1024 * 1024), 'video/mp4')).toThrow(/50MB/);
    });

    it('音频:格式白名单 + 大小;WAV 时长可校验,MP3 跳过', () => {
        expect(() => validateAssetMedia('audio', Buffer.alloc(1000), 'audio/mpeg')).not.toThrow();
        expect(() => validateAssetMedia('audio', Buffer.alloc(1000), 'audio/ogg')).toThrow(/MP3\/WAV/);
        // 1 秒 WAV(byteRate 44100,data 44100)→ 短于官方 2 秒下限
        expect(() => validateAssetMedia('audio', wavOf(44100, 44100), 'audio/wav')).toThrow(/时长/);
        // 5 秒放行
        expect(() => validateAssetMedia('audio', wavOf(44100, 44100 * 5), 'audio/wav')).not.toThrow();
    });

    it('readImageDims 认 PNG / GIF / BMP / TIFF', () => {
        expect(readImageDims(pngOf(800, 600))).toEqual({ w: 800, h: 600 });
        const gif = Buffer.alloc(10);
        gif.write('GIF89a', 0, 'latin1');
        gif.writeUInt16LE(640, 6);
        gif.writeUInt16LE(480, 8);
        expect(readImageDims(gif)).toEqual({ w: 640, h: 480 });
        const bmp = Buffer.alloc(26);
        bmp.write('BM', 0, 'latin1');
        bmp.writeInt32LE(1920, 18);
        bmp.writeInt32LE(-1080, 22); // 负高 = 自顶向下
        expect(readImageDims(bmp)).toEqual({ w: 1920, h: 1080 });
        const tif = Buffer.alloc(40);
        tif.write('II*\u0000', 0, 'latin1');
        tif.writeUInt32LE(8, 4);
        tif.writeUInt16LE(2, 8); // 2 entries
        tif.writeUInt16LE(256, 10);
        tif.writeUInt16LE(4, 12);
        tif.writeUInt32LE(1200, 18);
        tif.writeUInt16LE(257, 22);
        tif.writeUInt16LE(4, 24);
        tif.writeUInt32LE(900, 30);
        expect(readImageDims(tif)).toEqual({ w: 1200, h: 900 });
        expect(readImageDims(Buffer.from('xx'))).toBeNull();
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
            bytes: OK_PNG,
            mime: 'image/png',
        })) as unknown as Record<string, unknown>;
        expect(String(row.id)).toMatch(/^asset-/);
        expect(String(row.r2_key)).toMatch(/^enterprise-assets\/u1\/asset-.*\.png$/);
        expect(uploadImage).toHaveBeenCalledWith(expect.stringMatching(/\.png$/), expect.any(Buffer), 'image/png');
    });

    it('素材数达上限 → QuotaExceeded', async () => {
        db.enterpriseAsset.count.mockResolvedValue(5000);
        await expect(
            storeAsset({ userId: 'u1', assetType: 'image', name: 'x', bytes: OK_PNG, mime: 'image/png' }),
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
                bytes: OK_PNG,
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

    describe('lenient 模式(volc 混合解析,2026-08-06)', () => {
        it('asset:// 前缀形的平台素材 → 换 R2 直链;认不出的(provider 5 位尾缀)原样保留', async () => {
            db.enterpriseAsset.findMany.mockResolvedValue([{ id: A1, public_url: 'https://r2/a1.png' }]);
            const out = await resolveAssetRefs(
                {
                    model: 'doubao-seedance-2.0',
                    content: [
                        { type: 'image_url', image_url: { url: `asset://${A1}` } },
                        { type: 'image_url', image_url: { url: 'asset://asset-20260731141456-79gk9' } },
                    ],
                },
                'u1',
                { lenient: true },
            );
            const c = out.content as Array<{ image_url: { url: string } }>;
            expect(c[0].image_url.url).toBe('https://r2/a1.png');
            expect(c[1].image_url.url).toBe('asset://asset-20260731141456-79gk9');
        });

        it('lenient:平台格式但查不到的 id 不抛,原样保留(交上游报错)', async () => {
            db.enterpriseAsset.findMany.mockResolvedValue([]);
            const out = await resolveAssetRefs({ model: 'm', images: [`asset://${A1}`] }, 'u1', { lenient: true });
            expect((out.images as string[])[0]).toBe(`asset://${A1}`);
        });

        it('lenient:平台 group 引用照常展开;未知 group 原样保留不抛', async () => {
            db.enterpriseAsset.findMany.mockResolvedValue([
                { group_id: G1, public_url: 'https://r2/g1-1.png' },
                { group_id: G1, public_url: 'https://r2/g1-2.png' },
            ]);
            db.enterpriseAssetGroup.findMany.mockResolvedValue([{ id: G1 }]);
            const out = await resolveAssetRefs(
                { model: 'm', images: [G1, 'asset://group-20260806171100-74vfz'] },
                'u1',
                { lenient: true },
            );
            expect(out.images).toEqual([
                'https://r2/g1-1.png',
                'https://r2/g1-2.png',
                'asset://group-20260806171100-74vfz',
            ]);
        });

        it('严格模式(缺省)对 asset:// 前缀形同样解析(cn/global/promax 客户也可带前缀)', async () => {
            db.enterpriseAsset.findMany.mockResolvedValue([{ id: A1, public_url: 'https://r2/a1.png' }]);
            const out = await resolveAssetRefs({ model: 'm', images: [`asset://${A1}`] }, 'u1');
            expect((out.images as string[])[0]).toBe('https://r2/a1.png');
        });
    });
});
