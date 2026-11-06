import { describe, expect, it } from 'vitest';
import { readSyncPrice, syncPricesFromOptions } from '@/lib/newapi/catalog-sync-prices';
import { CHAT_FX, IMAGE_FX } from '@/lib/newapi/pricing-sync';
import {
    catalogDetailLines,
    parseCatalogBillingDetails,
    scaleCatalogBillingDetails,
} from '@/lib/models/catalog-pricing-details';
import { syncModelModality } from '@/lib/newapi/catalog-sync-advanced';

const expr =
    'len < 272000 ? tier("base", p * 5 + c * 30 + cr * 0.5 + cc * 6.25) : tier("long", p * 10 + c * 45 + cr * 1 + cc * 12.5)';
const options = (extra: Record<string, unknown> = {}) => ({
    ModelRatio: {},
    CompletionRatio: {},
    ModelPrice: {},
    GroupRatio: { sale: 0.12 },
    ...extra,
});
const read = (extra: Record<string, unknown>, model = 'test') =>
    readSyncPrice(syncPricesFromOptions(options(extra)), model, 'sale');
const amount = (n: number) => Number((n * 0.12 * IMAGE_FX).toFixed(12));
describe('catalog synchronization of new-api billing rules', () => {
    it('preserves explicit legacy cache prices, including zero, and refuses malformed values', () => {
        const source = {
            ModelRatio: { test: 2.5 },
            CompletionRatio: { test: 5 },
            CacheRatio: { test: 0 },
            CreateCacheRatio: { test: 1.25 },
        };
        expect(read(source).price?.billing_details).toMatchObject({
            mode: 'tiered_token',
            tiers: [{ name: 'uniform', rates: { cache_read: 0, cache_write: amount(6.25) } }],
        });
        expect(read({ ...source, CacheRatio: { test: -1 } }).price).toBeNull();
        expect(read({ ...source, CreateCacheRatio: null }).price).toBeNull();
    });
    it('imports every token tier and cache rate without changing the input boundary', () => {
        const result = read({
            'billing_setting.billing_mode': { test: 'tiered_expr' },
            'billing_setting.billing_expr': { test: expr },
            ModelRatio: { test: 99 },
            ModelPrice: { test: 99 },
        });
        expect(result.reason).toBeNull();
        const details = result.price!.billing_details!;
        expect(details.mode).toBe('tiered_token');
        if (details.mode !== 'tiered_token') throw Error('wrong mode');
        expect(details.tiers[0]).toMatchObject({
            max_input_tokens: 272000,
            max_inclusive: false,
            rates: { input: amount(5), output: amount(30), cache_read: amount(0.5), cache_write: amount(6.25) },
        });
        expect(details.tiers[1]).toMatchObject({
            min_input_tokens: 272000,
            min_inclusive: true,
            rates: { input: amount(10), output: amount(45) },
        });
        expect(result.price!.input_cny_per_1m).toBe(Number(amount(5).toFixed(4)));
    });
    it('preserves inclusive boundaries used by the current GPT expression presets', () => {
        const result = read({
            'billing_setting.billing_mode': { test: 'tiered_expr' },
            'billing_setting.billing_expr': {
                test: '((len <= 272000)) ? (tier("Short", p * 2 + c * 10 + cr * 0.2)) : (tier("Long", p * 4 + c * 15 + cr * 0.4))',
            },
        });
        expect(result.price?.billing_details).toMatchObject({
            tiers: [{ max_inclusive: true }, { min_inclusive: false }],
        });
    });
    it('imports all image resolutions without pretending the lowest price applies to every size', () => {
        const raw = syncPricesFromOptions(
            options({ ImageResolutionPrice: { banana: { '1K': 0.5, '2K': 0.8, '4K': 1 } } }),
        );
        const result = readSyncPrice(raw, 'banana', 'sale');
        expect(syncModelModality(raw, 'banana', 'chat')).toBe('image');
        expect(result.price).toEqual({
            input_cny_per_1m: null,
            output_cny_per_1m: null,
            per_image_cny: null,
            billing_details: {
                version: 1,
                mode: 'media',
                unit: 'cny_per_image',
                default_price: null,
                resolution_prices: { '1K': amount(0.5), '2K': amount(0.8), '4K': amount(1) },
            },
        });
    });
    it('imports the Seedance resolution × reference-video matrix and tags it as video', () => {
        // Verbatim from prod new-api 2026-11-06: doubao-seedance-2-0-mini-260615.
        const seedance =
            'u("resolution") == "480p" && u("video_input") == "none" ? tier("480p·none", u("tokens") * 3.07 / 1000000) : u("resolution") == "480p" && u("video_input") == "video" ? tier("480p·video", u("tokens") * 1.87 / 1000000) : u("resolution") == "720p" && u("video_input") == "none" ? tier("720p·none", u("tokens") * 3.07 / 1000000) : u("resolution") == "720p" && u("video_input") == "video" ? tier("720p·video", u("tokens") * 1.87 / 1000000) : u("resolution") == "1080p" && u("video_input") == "none" ? tier("1080p·none", u("tokens") * 3.4 / 1000000) : u("resolution") == "1080p" && u("video_input") == "video" ? tier("1080p·video", u("tokens") * 2.07 / 1000000) : u("resolution") == "4k" && u("video_input") == "none" ? tier("4k·none", u("tokens") * 3.4 / 1000000) : tier("4k·video", u("tokens") * 2.07 / 1000000)';
        const extra = {
            'billing_setting.billing_mode': { test: 'tiered_expr' },
            'billing_setting.billing_expr': { test: seedance },
        };
        const raw = syncPricesFromOptions(options(extra));
        expect(syncModelModality(raw, 'test', 'chat')).toBe('video');
        const result = read(extra);
        expect(result.reason).toBeNull();
        const details = result.price!.billing_details!;
        if (details.mode !== 'video_token') throw Error('wrong mode');
        expect(details.cells).toHaveLength(8);
        expect(details.cells[0]).toEqual({ resolution: '480p', video_input: 'none', price: amount(3.07) });
        expect(details.cells[7]).toEqual({ resolution: '4k', video_input: 'video', price: amount(2.07) });
        expect(catalogDetailLines(details).join(' ')).toContain('480p');
    });
    it('still refuses a time-conditioned token expression', () => {
        // Verbatim shape from prod new-api 2026-11-06: deepseek-v4.1-flash (aipg peak/off-peak).
        const result = read({
            'billing_setting.billing_mode': { test: 'tiered_expr' },
            'billing_setting.billing_expr': {
                test: 'weekday("Asia/Shanghai") >= 1 && hour("Asia/Shanghai") < 12 ? tier("peak", p * 2 + cr * 0.04 + c * 8) : tier("off_peak", p * 1 + cr * 0.02 + c * 4)',
            },
        });
        expect(result.price).toBeNull();
        expect(result.reason).toMatch(/计费规则无法同步/);
    });
    it('refuses a task expression that is not the accepted matrix instead of guessing', () => {
        const result = read({
            'billing_setting.billing_mode': { test: 'tiered_expr' },
            'billing_setting.billing_expr': {
                test: 'u("duration") == "5s" ? tier("short", u("tokens") * 3 / 1000000) : tier("long", u("tokens") * 6 / 1000000)',
            },
        });
        expect(result.price).toBeNull();
        expect(result.reason).toMatch(/计费规则无法同步/);
    });
    it('preserves seconds, resolution prices, and the cross-midnight Beijing discount window', () => {
        const result = read({
            'billing_setting.billing_mode': { test: 'per-second' },
            'billing_setting.task_billing_pricing': {
                test: { mode: 'per-second', resolution_prices: { '768p': 1, '1080p': 1.5 } },
            },
            'billing_setting.scheduled_discount': {
                test: { enabled: true, start: '22:00', end: '08:00', discount: 0.5 },
            },
        });
        expect(result.basis).toBe('second');
        expect(result.price!.per_image_cny).toBeNull();
        expect(result.price!.billing_details).toMatchObject({
            unit: 'cny_per_second',
            default_price: null,
            resolution_prices: { '768p': amount(1), '1080p': amount(1.5) },
            scheduled_discount: { timezone: 'Asia/Shanghai', multiplier: 0.5 },
        });
        const scaled = scaleCatalogBillingDetails(result.price!.billing_details!, 2);
        expect(scaled).toMatchObject({
            resolution_prices: { '1080p': amount(3) },
            scheduled_discount: { multiplier: 0.5 },
        });
        if (scaled.mode !== 'media') throw Error('wrong mode');
        expect(catalogDetailLines(scaled).join(' ')).toContain('/ 秒');
        expect(catalogDetailLines(scaled).join(' ')).toContain('22:00–08:00');
    });
    it('imports multi-window discounts for token prices without changing the base rates', () => {
        const result = read({
            ModelRatio: { test: 5 },
            CompletionRatio: { test: 10 },
            'billing_setting.scheduled_discount': {
                test: {
                    enabled: true,
                    windows: [
                        { start: '00:00', end: '06:00', discount: 0.36, weekdays: [1, 2, 3, 4, 5], priority: 1 },
                        { start: '22:00', end: '02:00', discount: 0.3, weekdays: [6, 7], priority: 2 },
                    ],
                },
            },
        });
        expect(result.price?.billing_details).toMatchObject({
            mode: 'tiered_token',
            tiers: [
                {
                    rates: {
                        input: Number((5 * CHAT_FX * 0.12).toFixed(4)),
                        output: Number((5 * CHAT_FX * 10 * 0.12).toFixed(4)),
                    },
                },
            ],
            scheduled_discount: {
                windows: [
                    {
                        start: '00:00',
                        end: '06:00',
                        timezone: 'Asia/Shanghai',
                        multiplier: 0.36,
                        weekdays: [1, 2, 3, 4, 5],
                        priority: 1,
                    },
                    {
                        start: '22:00',
                        end: '02:00',
                        timezone: 'Asia/Shanghai',
                        multiplier: 0.3,
                        weekdays: [6, 7],
                        priority: 2,
                    },
                ],
            },
        });
    });
    it('imports task per-request prices even when the legacy mode is ratio', () => {
        const result = read({
            'billing_setting.billing_mode': { test: 'ratio' },
            'billing_setting.task_billing_pricing': {
                test: { mode: 'per-request', resolution_prices: { '720p': 45 } },
            },
        });
        expect(result.price!.billing_details).toMatchObject({
            unit: 'cny_per_request',
            resolution_prices: { '720p': amount(45) },
        });
        const fixed = read({ 'billing_setting.billing_mode': { test: 'per-request' }, ModelPrice: { test: 30 } });
        expect(fixed.price!.billing_details).toMatchObject({ default_price: amount(30), unit: 'cny_per_request' });
        expect(fixed.price!.per_image_cny).toBeNull();
    });
    it('preserves text, image and cached-image token prices in the Image 2/2.5 expression', () => {
        const result = read({
            'billing_setting.billing_mode': { test: 'tiered_expr' },
            'billing_setting.billing_expr': {
                test: 'tier("standard", p * 5 + cr * 1.25 + img * 8 + img_cr * 2 + c * 30)',
            },
        });
        expect(result.price!.billing_details).toEqual({
            version: 1,
            mode: 'component_token',
            unit: 'cny_per_million_tokens',
            rates: {
                input: amount(5),
                output: amount(30),
                cache_read: amount(1.25),
                image_input: amount(8),
                image_cache_read: amount(2),
            },
        });
        expect(result.price!.per_image_cny).toBeNull();
    });
    it.each([
        {
            'billing_setting.billing_mode': { test: 'tiered_expr' },
            'billing_setting.billing_expr': { test: 'tier("x", p * 1 + c * 2) + fixed(1)' },
        },
        {
            'billing_setting.billing_mode': { test: 'tiered_expr' },
            'billing_setting.billing_expr': { test: 'tier("x", p * 1 + img * 2 + c * 3 + u("seconds") * 4)' },
        },
        {
            'billing_setting.billing_mode': { test: 'tiered_expr' },
            'billing_setting.billing_expr': {
                test: 'tier("x", p * 1 + img * 2 + c * 3 + img_cr * 0.100000000000000001)',
            },
        },
        {
            'billing_setting.billing_mode': { test: 'tiered_expr' },
            'billing_setting.billing_expr': { test: 'tier("x", p * 1 + img * 2 + c * 3 + cc * 4)' },
        },
        { ImageResolutionPrice: { test: { '1K': 1, '2K': 2 } } },
        { ImageResolutionPrice: { test: { '1K': 1, '2K': 2, '4K': -3 } } },
        { 'billing_setting.task_billing_pricing': { test: { mode: 'per-second', resolution_prices: {} } } },
        { 'billing_setting.task_billing_pricing': { test: { mode: 'per-second', default_price: '1' } } },
        {
            'billing_setting.billing_mode': { test: 'per-request' },
            'billing_setting.task_billing_pricing': { test: { mode: 'per-second', default_price: 1 } },
        },
        { 'billing_setting.billing_mode': null },
        { 'billing_setting.plugin_billing_expr': { 'provider::test': 'tier("x", p * 2 + c * 3)' } },
    ])('refuses unsupported/malformed rules instead of using stale scalar prices: %j', (extra) => {
        expect(
            read({ ...extra, ModelRatio: { test: 1 }, CompletionRatio: { test: 2 }, ModelPrice: { test: 5 } }).price,
        ).toBeNull();
    });
    it('imports the Seedance resolution × reference-video matrix and prices it as video', () => {
        const combos = ['480p', '720p', '1080p', '4k'].flatMap((resolution) =>
            ['none', 'video'].map((input) => ({ resolution, input })),
        );
        const prices = [9.34, 5.6, 9.34, 5.6, 10.27, 6.14, 10.27, 6.14];
        const expression = combos
            .map(({ resolution, input }, index) => {
                const call = `tier("${resolution}·${input}", u("tokens") * ${prices[index]} / 1000000)`;
                return index === combos.length - 1
                    ? call
                    : `u("resolution") == "${resolution}" && u("video_input") == "${input}" ? ${call}`;
            })
            .join(' : ');
        const extra = {
            'billing_setting.billing_mode': { test: 'tiered_expr' },
            'billing_setting.billing_expr': { test: expression },
        };
        expect(syncModelModality(syncPricesFromOptions(options(extra)), 'test', 'chat')).toBe('video');
        const result = read(extra);
        expect(result.reason).toBeNull();
        // Scalar columns stay empty: no single ¥/1M describes an eight-cell matrix.
        expect(result.price).toMatchObject({ input_cny_per_1m: null, output_cny_per_1m: null, per_image_cny: null });
        const details = result.price!.billing_details!;
        if (details.mode !== 'video_token') throw Error('wrong mode');
        expect(details.cells).toHaveLength(8);
        expect(details.cells[0]).toEqual({ resolution: '480p', video_input: 'none', price: amount(9.34) });
        expect(details.cells.at(-1)).toEqual({ resolution: '4k', video_input: 'video', price: amount(6.14) });
        const scaled = scaleCatalogBillingDetails(details, 2);
        if (scaled.mode !== 'video_token') throw Error('wrong mode');
        expect(scaled.cells[0].price).toBe(amount(9.34) * 2);
        expect(catalogDetailLines(scaled).join(' ')).toContain('480p · 无参考视频');
        expect(catalogDetailLines(scaled, true).join(' ')).toContain('no reference video');
    });
    it.each([
        'u("resolution") == "480p" && u("video_input") == "none" ? tier("480p·none", u("tokens") * 1 / 1000000) : tier("rest", u("tokens") * 2 / 1000000)',
        'tier("base", u("tokens") * 9.8 / 1000000)',
        'u("mode") == "pro" ? tier("pro", u("tokens") * 70 / 1000000) : tier("std", u("tokens") * 42 / 1000000)',
    ])('refuses task formulas outside the supported matrix: %s', (expression) => {
        const extra = {
            'billing_setting.billing_mode': { test: 'tiered_expr' },
            'billing_setting.billing_expr': { test: expression },
        };
        expect(read(extra).price).toBeNull();
        expect(read(extra).reason).toContain('计费规则无法同步');
        // An unreadable formula must not be reported as video either.
        expect(syncModelModality(syncPricesFromOptions(options(extra)), 'test', 'chat')).toBe('chat');
    });
    it('validates persisted units and never treats unknown metadata as a scalar quote', () => {
        expect(() =>
            parseCatalogBillingDetails({
                version: 1,
                mode: 'media',
                unit: 'USD',
                default_price: 1,
                resolution_prices: {},
            }),
        ).toThrow();
        expect(() =>
            parseCatalogBillingDetails({
                version: 1,
                mode: 'media',
                unit: 'cny_per_second',
                default_price: null,
                resolution_prices: {},
            }),
        ).toThrow();
    });
});
