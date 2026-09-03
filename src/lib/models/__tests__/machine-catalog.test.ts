/**
 * 机器可读模型目录单测(machine-catalog.ts)。
 * 契约:只加不减 / 精确档次命中才给价 / 60s 缓存 / 形状不符抛给调用方回退。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockFindManyCatalog = vi.fn();
const mockFindUniqueToken = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        catalogModel: { findMany: (...a: unknown[]) => mockFindManyCatalog(...a) },
        newApiToken: { findUnique: (...a: unknown[]) => mockFindUniqueToken(...a) },
    },
}));

import {
    loadCatalogMeta,
    resolveTierFromAuthHeader,
    enrichModelList,
    resetCatalogMetaCacheForTests,
    type CatalogMetaEntry,
} from '../machine-catalog';

beforeEach(() => {
    vi.clearAllMocks();
    resetCatalogMetaCacheForTests();
});

const catalogRow = (
    slug: string,
    prices: Array<{ tier: string; in?: number | null; out?: number | null; img?: number | null }>,
    extra: { display_name?: string; context_window?: number | null; upstreamTiers?: string[] } = {},
) => ({
    slug,
    display_name: extra.display_name ?? slug,
    context_window: extra.context_window ?? null,
    upstream_map: Object.fromEntries(
        (extra.upstreamTiers ?? [...new Set(prices.map((price) => price.tier))]).map((tier) => [
            tier,
            { channel_id: 1, upstream_model: slug },
        ]),
    ),
    prices: prices.map((p) => ({
        tier: p.tier,
        input_cny_per_1m: p.in ?? null,
        output_cny_per_1m: p.out ?? null,
        per_image_cny: p.img ?? null,
    })),
});

describe('loadCatalogMeta', () => {
    it('prices 降序首条 = 现行价(旧版本价不覆盖)+ 60s 模块缓存', async () => {
        mockFindManyCatalog.mockResolvedValue([
            // effective_from 降序:第一条是现行价 ¥22.5,第二条是历史价 ¥45
            catalogRow('claude-opus-4-8', [
                { tier: 'pool', in: 22.5, out: 112.5 },
                { tier: 'pool', in: 45, out: 225 },
                { tier: 'official', in: 34, out: 170 },
            ]),
        ]);
        const meta = await loadCatalogMeta();
        expect(meta.get('claude-opus-4-8')!.pricesByTier.get('pool')).toEqual({
            input_cny_per_1m: 22.5,
            output_cny_per_1m: 112.5,
            per_image_cny: null,
        });
        expect(meta.get('claude-opus-4-8')!.pricesByTier.get('official')!.input_cny_per_1m).toBe(34);
        // 二次调用走缓存,不再打 DB
        await loadCatalogMeta();
        expect(mockFindManyCatalog).toHaveBeenCalledTimes(1);
    });

    it('查询锁平台主体 + 只取已生效价(与计费侧 pickEffectivePrice 对齐)', async () => {
        mockFindManyCatalog.mockResolvedValue([]);
        await loadCatalogMeta();
        const arg = mockFindManyCatalog.mock.calls[0][0] as {
            where: { enabled: boolean; tenant_id: string };
            include: { prices: { where: { effective_from: { lte: Date } }; orderBy: { effective_from: string } } };
        };
        // tenant 锁死平台:slug 仅 tenant 内唯一,白标 tenant 自定价上线后不过滤会串价
        expect(arg.where.tenant_id).toBe('00000000-0000-0000-0000-000000000001');
        expect(arg.where.enabled).toBe(true);
        // 排期价(effective_from 在未来)不得提前登目录:目录说 A 价、账单扣 B 价 = 事故
        expect(arg.include.prices.where.effective_from.lte).toBeInstanceOf(Date);
        expect(arg.include.prices.orderBy).toEqual({ effective_from: 'desc' });
    });

    it('Decimal 形(字符串/对象)统一转 number', async () => {
        mockFindManyCatalog.mockResolvedValue([
            catalogRow('gpt-image-2', [{ tier: 'image2', img: '0.35' as unknown as number }]),
        ]);
        const meta = await loadCatalogMeta();
        expect(meta.get('gpt-image-2')!.pricesByTier.get('image2')!.per_image_cny).toBe(0.35);
    });

    it('keeps historical price rows out when the current model route no longer has that tier', async () => {
        mockFindManyCatalog.mockResolvedValue([
            catalogRow(
                'gpt-5.4',
                [
                    { tier: 'sale', in: 1, out: 5 },
                    { tier: 'retired', in: 0.5, out: 2.5 },
                ],
                { upstreamTiers: ['sale'] },
            ),
        ]);
        const meta = await loadCatalogMeta();
        expect([...meta.get('gpt-5.4')!.pricesByTier.keys()]).toEqual(['sale']);
    });
});

describe('resolveTierFromAuthHeader', () => {
    it('sk- 前缀剥离后反查 NewApiToken.tier', async () => {
        mockFindUniqueToken.mockResolvedValue({ tier: 'official' });
        expect(await resolveTierFromAuthHeader('Bearer sk-abc123')).toBe('official');
        expect(mockFindUniqueToken).toHaveBeenCalledWith({
            where: { newapi_token_value: 'abc123' },
            select: { tier: true },
        });
    });

    it('查不到(system token / 未知 key)或无头 → fail closed,不虚构 pool', async () => {
        mockFindUniqueToken.mockResolvedValue(null);
        await expect(resolveTierFromAuthHeader('Bearer sk-unknown')).rejects.toThrow('not a Portal customer token');
        await expect(resolveTierFromAuthHeader(null)).rejects.toThrow('without a bearer token');
        await expect(resolveTierFromAuthHeader('Basic xyz')).rejects.toThrow('without a bearer token');
    });

    it('DB 错误向上抛(由调用方整体回退透传)', async () => {
        mockFindUniqueToken.mockRejectedValue(new Error('db down'));
        await expect(resolveTierFromAuthHeader('Bearer sk-x')).rejects.toThrow('db down');
    });
});

describe('enrichModelList(纯函数)', () => {
    const meta = new Map<string, CatalogMetaEntry>([
        [
            'claude-opus-4-8',
            {
                display_name: 'Claude Opus 4.8',
                context_window: 200_000,
                pricesByTier: new Map([
                    ['pool', { input_cny_per_1m: 22.5, output_cny_per_1m: 112.5, per_image_cny: null }],
                ]),
            },
        ],
    ]);
    const upstream = {
        object: 'list',
        data: [
            { id: 'claude-opus-4-8', object: 'model', created: 1700000000, owned_by: 'anthropic', extra_field: 'kept' },
            { id: 'some-unknown-model-xyz', object: 'model', created: 1, owned_by: 'custom' },
        ],
    };

    it('上游字段全保留 + 追加 silkroadai 命名空间(目录命中给全量元数据)', () => {
        const out = enrichModelList(upstream, 'pool', meta) as typeof upstream & {
            data: Array<Record<string, unknown>>;
        };
        expect(out.object).toBe('list');
        const first = out.data[0];
        expect(first.id).toBe('claude-opus-4-8');
        expect(first.owned_by).toBe('anthropic');
        expect(first.extra_field).toBe('kept'); // 未知上游字段不丢
        const sr = first.silkroadai as Record<string, unknown>;
        expect(sr.display_name).toBe('Claude Opus 4.8');
        expect(sr.vendor).toBe('Anthropic');
        expect(sr.vision).toBe(true); // opus 在 vision bucket
        expect(sr.context_window).toBe(200_000);
        expect(sr.tier).toBe('pool');
        expect(sr.pricing).toEqual({ input_cny_per_1m: 22.5, output_cny_per_1m: 112.5, per_image_cny: null });
    });

    it('目录未收录的模型:仍给分类(vendor/type),pricing=null', () => {
        const out = enrichModelList(upstream, 'pool', meta) as { data: Array<Record<string, unknown>> };
        const sr = out.data[1].silkroadai as Record<string, unknown>;
        expect(sr.vendor).toBeDefined();
        expect(sr.type).toBeDefined();
        expect(sr.pricing).toBeNull();
        expect(sr.display_name).toBeUndefined();
    });

    it('档次不命中 → pricing=null,【不】回退别档(错价比没价危害大)', () => {
        const out = enrichModelList(upstream, 'official', meta) as { data: Array<Record<string, unknown>> };
        const sr = out.data[0].silkroadai as Record<string, unknown>;
        expect(sr.tier).toBe('official');
        expect(sr.pricing).toBeNull(); // meta 里 opus 只有 pool 价
    });

    it('条目集合与顺序原样(只加不减,不排序不过滤)', () => {
        const out = enrichModelList(upstream, 'pool', meta) as { data: Array<Record<string, unknown>> };
        expect(out.data.map((d) => d.id)).toEqual(['claude-opus-4-8', 'some-unknown-model-xyz']);
    });

    it('形状怪的条目(无 id)原样保留不炸', () => {
        const weird = { object: 'list', data: [{ notid: 1 }, 'a-string'] };
        const out = enrichModelList(weird as Record<string, unknown>, 'pool', meta) as {
            data: unknown[];
        };
        expect(out.data).toEqual([{ notid: 1 }, 'a-string']);
    });

    it('data 非数组 → 抛(调用方回退透传)', () => {
        expect(() => enrichModelList({ object: 'list' }, 'pool', meta)).toThrow();
    });
});
