/**
 * /pricing page SSR smoke — same shallow renderToString pattern as the
 * models-page test. Mocks prisma at the boundary (catalogModel + channelGroup)
 * so the page is deterministic without a DB.
 *
 * 契约:目录同源(effective_from 降序首条 = 现行价)/ HIDDEN_MODELS 不上表 /
 * 停用档次不挂公开价 / 无价模型不渲染 / DB 抖动渲染错误横幅不炸页。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

const mockFindManyCatalog = vi.fn();
const mockFindManyGroups = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        catalogModel: { findMany: (...a: unknown[]) => mockFindManyCatalog(...a) },
        channelGroup: { findMany: (...a: unknown[]) => mockFindManyGroups(...a) },
    },
}));

import PricingPage from '@/app/pricing/page';

const price = (tier: string, opts: { in?: number | null; out?: number | null; img?: number | null } = {}) => ({
    tier,
    input_cny_per_1m: opts.in ?? null,
    output_cny_per_1m: opts.out ?? null,
    per_image_cny: opts.img ?? null,
});

const model = (slug: string, display_name: string, prices: ReturnType<typeof price>[]) => ({
    slug,
    display_name,
    upstream_map: Object.fromEntries(
        [...new Set(prices.map((row) => row.tier))].map((tier) => [tier, { channel_id: 1, upstream_model: slug }]),
    ),
    prices,
});

const GROUPS = [
    { key: 'pool', display_name: '默认(号池为主)', tier_level: 0 },
    { key: 'geminit3', display_name: 'geminit3', tier_level: 0 },
    { key: 'official', display_name: 'Claude官方稳定', tier_level: 1 },
];

beforeEach(() => {
    vi.clearAllMocks();
    mockFindManyGroups.mockResolvedValue(GROUPS);
});

describe('<PricingPage /> SSR', () => {
    it('renders vendor sections with per-tier prices (¥ trimmed, tier display names)', async () => {
        mockFindManyCatalog.mockResolvedValue([
            model('claude-opus-4-8', 'Claude Opus 4 8', [
                // 降序首条 = 现行价 ¥6;第二条是被取代的历史版本 ¥13.3714,不得渲染
                price('pool', { in: 6, out: 30 }),
                price('pool', { in: 13.3714, out: 66.8571 }),
                price('official', { in: 17, out: 85 }),
            ]),
            model('gemini-3.1-flash-image-preview', 'Gemini 3.1 Flash Image Preview', [
                price('geminit3', { img: 0.1 }),
            ]),
        ]);
        const html = renderToString(await PricingPage());

        expect(html).toContain('模型价格');
        // 厂商分组:Anthropic + Google 各一节
        expect(html).toContain('Anthropic');
        expect(html).toContain('Google');
        // 现行价渲染 + 历史价不渲染
        expect(html).toContain('¥6');
        expect(html).toContain('¥30');
        expect(html).toContain('¥17');
        expect(html).not.toContain('13.3714');
        // 档次用 ChannelGroup.display_name
        expect(html).toContain('默认(号池为主)');
        expect(html).toContain('Claude官方稳定');
        // 生图按张:¥0.1
        expect(html).toContain('¥0.1');
        expect(html).toContain('gemini-3.1-flash-image-preview');
    });

    it('skips HIDDEN_MODELS, disabled tiers, and models with no displayable price', async () => {
        mockFindManyCatalog.mockResolvedValue([
            // HIDDEN_MODELS(下架中,目录价还是错的)→ 不上表
            model('gpt-5.3-codex-spark', 'Gpt 5.3 Codex Spark', [price('official-gpt', { in: 1.04, out: 6.24 })]),
            // 只有停用档(不在 enabled ChannelGroup 里)有价 → 整个模型不上表
            model('gpt-image-2-4k', 'Gpt Image 2 4k', [price('official-image2-4k', { img: 0.5 })]),
            // 全无价 → 不上表
            model('gpt-5.2', 'Gpt 5.2', []),
            // 正常行,证明页面不是整个空的
            model('gpt-5.5', 'Gpt 5.5', [price('pool', { in: 1, out: 6 })]),
        ]);
        const html = renderToString(await PricingPage());

        expect(html).toContain('gpt-5.5');
        expect(html).not.toContain('codex-spark');
        expect(html).not.toContain('1.04');
        expect(html).not.toContain('gpt-image-2-4k');
        expect(html).not.toContain('gpt-5.2');
        // 已标价模型计数只数上表的(JSX 文本节点间有 <!-- --> 注释,用正则)
        expect(html).toMatch(/共 (<!-- -->)?1(<!-- -->)? 个已标价模型/);
    });

    it('does not publish a historical tier price after that tier is removed from upstream_map', async () => {
        mockFindManyCatalog.mockResolvedValue([
            {
                ...model('gpt-5.5', 'Gpt 5.5', [price('pool', { in: 1, out: 6 })]),
                upstream_map: {},
            },
        ]);
        const html = renderToString(await PricingPage());
        expect(html).not.toContain('gpt-5.5');
        expect(html).toMatch(/共 (<!-- -->)?0(<!-- -->)? 个已标价模型/);
    });

    it('renders error banner (not a crash) when the DB read throws', async () => {
        mockFindManyCatalog.mockRejectedValue(new Error('db down'));
        const html = renderToString(await PricingPage());
        expect(html).toContain('当前无法获取价格表');
        expect(html).toContain('模型价格'); // chrome 仍在
    });
});
