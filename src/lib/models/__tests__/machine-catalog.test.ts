/**
 * 机器可读模型目录单测(machine-catalog.ts)。
 * 契约:只加不减 / 精确档次命中才给价 / 同版本60s缓存 / 形状不符抛给调用方回退。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockFindManyCatalog = vi.fn();
const mockFindUniqueToken = vi.fn();
const mockFindRevision = vi.fn();
const mockFindGroup = vi.fn();
const mockMultipliers = vi.fn();
const mockGetOption = vi.fn();
vi.mock('@/lib/newapi/client', () => ({ getOption: (...args: unknown[]) => mockGetOption(...args) }));
vi.mock('@/lib/newapi/user-tier-multiplier', () => ({
    listUserTierMultipliers: (...args: unknown[]) => mockMultipliers(...args),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        catalogModel: { findMany: (...a: unknown[]) => mockFindManyCatalog(...a) },
        newApiToken: { findUnique: (...a: unknown[]) => mockFindUniqueToken(...a) },
        pricingPublishCoordinator: { findUnique: (...a: unknown[]) => mockFindRevision(...a) },
        channelGroup: { findFirst: (...a: unknown[]) => mockFindGroup(...a) },
    },
}));

import {
    loadCatalogMeta,
    resolveTierFromAuthHeader,
    resolveCatalogPricingContextFromAuthHeader,
    enrichModelList,
    resetCatalogMetaCacheForTests,
    type CatalogMetaEntry,
} from '../machine-catalog';

beforeEach(() => {
    vi.clearAllMocks();
    mockFindRevision.mockReset().mockResolvedValue({ revision: 1 });
    mockFindGroup.mockReset().mockResolvedValue({ newapi_group: 'Enterprise' });
    mockMultipliers.mockReset().mockResolvedValue([]);
    mockGetOption.mockReset().mockResolvedValue(JSON.stringify({ Enterprise: 0.16 }));
    resetCatalogMetaCacheForTests();
});

const dynamicDetails = {
    version: 1 as const,
    mode: 'tiered_token' as const,
    unit: 'cny_per_million_tokens' as const,
    semantics: 'whole_request' as const,
    tiers: [
        {
            name: 'base',
            min_input_tokens: null,
            max_input_tokens: 272000,
            min_inclusive: false,
            max_inclusive: false,
            rates: { input: 0.8, output: 4.8, cache_read: 0.08, cache_write: null, cache_write_1h: null },
        },
        {
            name: 'long',
            min_input_tokens: 272000,
            max_input_tokens: null,
            min_inclusive: true,
            max_inclusive: false,
            rates: { input: 1.6, output: 7.2, cache_read: 0.16, cache_write: null, cache_write_1h: null },
        },
    ],
};

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
    it('includes verified full tier/cache prices and rejects corrupt latest metadata without falling back to history', async () => {
        const row = catalogRow('gpt-5.5', [{ tier: 'enterprise', in: 0.8, out: 4.8 }]);
        Object.assign(row.prices[0], { billing_details: dynamicDetails });
        mockFindManyCatalog.mockResolvedValue([row]);
        expect((await loadCatalogMeta()).get('gpt-5.5')!.pricesByTier.get('enterprise')!.billing_details).toEqual(
            dynamicDetails,
        );
        resetCatalogMetaCacheForTests();
        Object.assign(row.prices[0], { billing_details: { mode: 'tiered_token' } });
        row.prices.push({ ...row.prices[0], ...{ input_cny_per_1m: 1 } });
        await expect(loadCatalogMeta()).rejects.toThrow('Invalid tiered pricing details');
    });
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
        // 同版本二次调用复用同一个缓存，不重读模型与价格；仍核对共享版本。
        expect(await loadCatalogMeta()).toBe(meta);
        expect(mockFindManyCatalog).toHaveBeenCalledTimes(1);
        expect(mockFindRevision).toHaveBeenCalledTimes(2);
    });

    it('refreshes warm cached prices immediately when another process commits a new publication revision', async () => {
        let revision = 4;
        mockFindRevision.mockImplementation(async () => ({ revision }));
        mockFindManyCatalog.mockResolvedValueOnce([catalogRow('gpt-5.4', [{ tier: 'sale', in: 1, out: 5 }])]);
        const before = await loadCatalogMeta();
        expect(before.get('gpt-5.4')!.pricesByTier.get('sale')!.input_cny_per_1m).toBe(1);
        // Models/prices and the coordinator revision change in one committed
        // publication transaction. No local cache reset and no TTL advance.
        revision = 5;
        mockFindManyCatalog.mockResolvedValueOnce([catalogRow('gpt-5.4', [{ tier: 'sale', in: 2, out: 10 }])]);
        const after = await loadCatalogMeta();
        expect(after).not.toBe(before);
        expect(after.get('gpt-5.4')!.pricesByTier.get('sale')!.input_cny_per_1m).toBe(2);
        expect(await loadCatalogMeta()).toBe(after);
        expect(mockFindManyCatalog).toHaveBeenCalledTimes(2);
    });

    it('still expires the cache after 60 seconds when the shared revision has not changed', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
        mockFindManyCatalog.mockResolvedValue([]);
        try {
            const first = await loadCatalogMeta();
            now.mockReturnValue(60_999);
            expect(await loadCatalogMeta()).toBe(first);
            now.mockReturnValue(61_000);
            expect(await loadCatalogMeta()).not.toBe(first);
            expect(mockFindManyCatalog).toHaveBeenCalledTimes(2);
        } finally {
            now.mockRestore();
        }
    });

    it('uses revision zero before the first coordinator exists and refreshes when it is created', async () => {
        mockFindRevision.mockResolvedValue(null);
        mockFindManyCatalog.mockResolvedValue([]);
        const initial = await loadCatalogMeta();
        expect(await loadCatalogMeta()).toBe(initial);
        mockFindRevision.mockResolvedValue({ revision: 1 });
        expect(await loadCatalogMeta()).not.toBe(initial);
        expect(mockFindManyCatalog).toHaveBeenCalledTimes(2);
    });

    it('does not serve a warm stale cache when the publication revision cannot be read', async () => {
        mockFindManyCatalog.mockResolvedValue([catalogRow('gpt-5.4', [{ tier: 'sale', in: 1, out: 5 }])]);
        await loadCatalogMeta();
        mockFindRevision.mockRejectedValue(new Error('revision database unavailable'));
        await expect(loadCatalogMeta()).rejects.toThrow('revision database unavailable');
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

describe('customer-specific catalog pricing', () => {
    it('resolves only an active exact Portal tier and uses a dedicated/public ratio, not their product', async () => {
        mockFindUniqueToken.mockResolvedValue({ tier: 'enterprise', user_id: 'customer-a', status: 'active' });
        mockMultipliers.mockResolvedValue([
            { tier_key: 'enterprise', newapi_billing_group: 'Enterprise', multiplier: 0.18 },
        ]);
        await expect(resolveCatalogPricingContextFromAuthHeader('Bearer sk-customer')).resolves.toEqual({
            tier: 'enterprise',
            multiplierScale: 1.125,
        });
        expect(mockMultipliers).toHaveBeenCalledWith('customer-a');
        expect(mockFindGroup).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { key: 'enterprise', enabled: true, tenant_id: '00000000-0000-0000-0000-000000000001' },
            }),
        );
    });
    it('does not query upstream multiplier options for customers with no dedicated price', async () => {
        mockFindUniqueToken.mockResolvedValue({ tier: 'enterprise', user_id: 'customer-b', status: 'active' });
        await expect(resolveCatalogPricingContextFromAuthHeader('Bearer customer')).resolves.toEqual({
            tier: 'enterprise',
            multiplierScale: 1,
        });
        expect(mockGetOption).not.toHaveBeenCalled();
    });
    it.each([null, '{}', '{"Enterprise":0}', '{"Enterprise":-1}', 'invalid'])(
        'fails closed for unverifiable public multiplier %s',
        async (raw) => {
            mockFindUniqueToken.mockResolvedValue({ tier: 'enterprise', user_id: 'customer-a', status: 'active' });
            mockMultipliers.mockResolvedValue([
                { tier_key: 'enterprise', newapi_billing_group: 'Enterprise', multiplier: 0.18 },
            ]);
            mockGetOption.mockResolvedValue(raw);
            await expect(resolveCatalogPricingContextFromAuthHeader('Bearer customer')).rejects.toThrow();
        },
    );
    it('fails closed for inactive tokens and unavailable tiers', async () => {
        mockFindUniqueToken.mockResolvedValue({ tier: 'enterprise', user_id: 'customer-a', status: 'revoked' });
        await expect(resolveCatalogPricingContextFromAuthHeader('Bearer customer')).rejects.toThrow('active Portal');
        mockFindUniqueToken.mockResolvedValue({ tier: 'enterprise', user_id: 'customer-a', status: 'active' });
        mockFindGroup.mockResolvedValue(null);
        await expect(resolveCatalogPricingContextFromAuthHeader('Bearer customer')).rejects.toThrow('unavailable');
    });
    it('scales every published tier/cache rate without mutating the shared public cache or thresholds', () => {
        const price = {
            input_cny_per_1m: 0.8,
            output_cny_per_1m: 4.8,
            per_image_cny: null,
            billing_details: dynamicDetails,
        };
        const map = new Map<string, CatalogMetaEntry>([
            [
                'gpt-5.5',
                { display_name: 'GPT 5.5', context_window: null, pricesByTier: new Map([['enterprise', price]]) },
            ],
        ]);
        const result = enrichModelList(
            { data: [{ id: 'gpt-5.5', extra: 'preserved' }] },
            { tier: 'enterprise', multiplierScale: 1.125 },
            map,
        ) as { data: { silkroadai: { pricing: typeof price }; extra: string }[] };
        expect(result.data[0].extra).toBe('preserved');
        const actual = result.data[0].silkroadai.pricing;
        expect(actual.input_cny_per_1m).toBe(0.9);
        expect(actual.output_cny_per_1m).toBe(5.4);
        expect(actual.billing_details.tiers[1].rates).toEqual({
            input: 1.8,
            output: 8.1,
            cache_read: 0.18,
            cache_write: null,
            cache_write_1h: null,
        });
        expect(actual.billing_details.tiers[0].max_input_tokens).toBe(272000);
        expect(actual.billing_details.semantics).toBe('whole_request');
        expect(price.input_cny_per_1m).toBe(0.8);
        expect(price.billing_details.tiers[1].rates.input).toBe(1.6);
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
