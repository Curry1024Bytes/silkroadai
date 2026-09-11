import { afterEach, describe, expect, it, vi } from 'vitest';

const forbiddenIo = vi.hoisted(() => ({ getOption: vi.fn(), putOption: vi.fn(), findFirst: vi.fn() }));
vi.mock('@/lib/newapi/client', () => ({ getOption: forbiddenIo.getOption, putOption: forbiddenIo.putOption }));
vi.mock('@/lib/db', () => ({ prisma: { channelGroup: { findFirst: forbiddenIo.findFirst } } }));

import { readSyncPrice, type RawSyncPrices } from '@/lib/newapi/catalog-sync-prices';
import { CHAT_FX, IMAGE_FX } from '@/lib/newapi/pricing-sync';

function fixture(overrides: Partial<RawSyncPrices> = {}): RawSyncPrices {
    return {
        modelRatio: JSON.stringify({ 'gpt-5.4': 0.5, 'gpt-image-2': 2.5 }),
        completionRatio: JSON.stringify({ 'gpt-5.4': 4, 'gpt-image-2': 6 }),
        modelPrice: '{}',
        groupRatio: JSON.stringify({ 'GPT-特惠反代': 0.2, 企业级: 1.5 }),
        ...overrides,
    };
}

const rounded = (n: number) => Number(n.toFixed(4));

afterEach(() => {
    expect(forbiddenIo.getOption).not.toHaveBeenCalled();
    expect(forbiddenIo.putOption).not.toHaveBeenCalled();
    expect(forbiddenIo.findFirst).not.toHaveBeenCalled();
});

describe('readSyncPrice from global new-api options', () => {
    it('reads global model prices and the exact new-api group without a channel object', () => {
        const price = readSyncPrice(fixture(), 'gpt-5.4', 'GPT-特惠反代');
        const input = rounded(0.5 * CHAT_FX * 0.2);
        expect(price).toEqual({
            basis: 'token',
            reason: null,
            price: { input_cny_per_1m: input, output_cny_per_1m: rounded(input * 4), per_image_cny: null },
        });
        const enterprise = readSyncPrice(fixture(), 'gpt-5.4', '企业级');
        expect(enterprise.price?.input_cny_per_1m).toBe(rounded(0.5 * CHAT_FX * 1.5));
    });

    it('does not silently replace a missing group with default or another group', () => {
        const result = readSyncPrice(fixture({ groupRatio: { default: 1 } }), 'gpt-5.4', '企业级');
        expect(result.price).toBeNull();
        expect(result.reason).toContain('GroupRatio 缺少「企业级」');
    });

    it('gives an explicit ModelPrice precedence even when token ratios also exist', () => {
        const result = readSyncPrice(fixture({ modelPrice: { 'gpt-5.4': 0.12 } }), 'gpt-5.4', '企业级');
        expect(result).toEqual({
            basis: 'request',
            reason: null,
            price: { input_cny_per_1m: null, output_cny_per_1m: null, per_image_cny: rounded(0.12 * IMAGE_FX * 1.5) },
        });
    });

    it('does not require token ratios for a valid fixed request price', () => {
        const result = readSyncPrice(
            fixture({ modelPrice: { 'gpt-image-2': 0.25 }, modelRatio: null, completionRatio: '{bad' }),
            'gpt-image-2',
            '企业级',
        );
        expect(result.basis).toBe('request');
        expect(result.price?.per_image_cny).toBe(rounded(0.25 * IMAGE_FX * 1.5));
    });

    it('retains token billing for an image model without a ModelPrice entry', () => {
        const result = readSyncPrice(fixture(), 'gpt-image-2', '企业级');
        expect(result.basis).toBe('token');
        expect(result.price?.input_cny_per_1m).toBe(rounded(2.5 * CHAT_FX * 1.5));
        expect(result.price?.per_image_cny).toBeNull();
    });

    it('does not invent a fixed image price when neither pricing mode is configured', () => {
        const result = readSyncPrice(fixture(), 'unknown-image-model', '企业级');
        expect(result.price).toBeNull();
        expect(result.reason).toContain('ModelRatio 缺少「unknown-image-model」');
    });

    it('does not default an omitted CompletionRatio to 1', () => {
        const result = readSyncPrice(fixture({ completionRatio: {} }), 'gpt-5.4', '企业级');
        expect(result).toMatchObject({ price: null, basis: 'token' });
        expect(result.reason).toContain('CompletionRatio 缺少');
    });

    it.each([
        ['modelPrice', { 'gpt-5.4': 0 }, 'request'],
        ['modelRatio', { 'gpt-5.4': 0 }, 'token'],
        ['groupRatio', { 企业级: 0 }, 'token'],
    ] as const)('honors explicit free %s instead of treating zero as missing', (field, value, basis) => {
        const result = readSyncPrice(fixture({ [field]: value }), 'gpt-5.4', '企业级');
        expect(result.reason).toBeNull();
        expect(result.basis).toBe(basis);
        expect(result.price).toEqual(
            basis === 'request'
                ? { input_cny_per_1m: null, output_cny_per_1m: null, per_image_cny: 0 }
                : { input_cny_per_1m: 0, output_cny_per_1m: 0, per_image_cny: null },
        );
    });

    it('keeps explicit zero output ratio without making input free', () => {
        const result = readSyncPrice(fixture({ completionRatio: { 'gpt-5.4': 0 } }), 'gpt-5.4', '企业级');
        expect(result.price?.input_cny_per_1m).toBeGreaterThan(0);
        expect(result.price?.output_cny_per_1m).toBe(0);
    });

    it.each([null, undefined, '', 'null', '[]', '{bad', '42', 4, [], new Date(0)])(
        'refuses unreadable or non-object ModelPrice %j instead of guessing token billing',
        (modelPrice) => {
            const result = readSyncPrice(fixture({ modelPrice }), 'gpt-5.4', '企业级');
            expect(result).toMatchObject({ price: null, basis: null });
            expect(result.reason).toContain('ModelPrice');
        },
    );

    it.each(['modelRatio', 'completionRatio', 'groupRatio'] as const)('reports an unreadable %s', (field) => {
        const result = readSyncPrice(fixture({ [field]: null }), 'gpt-5.4', '企业级');
        expect(result.price).toBeNull();
        expect(result.reason).toContain('未读取到');
    });

    it.each([-1, NaN, Infinity, -Infinity, null, true, '0.5', '', {}, []])(
        'rejects invalid entry %j in every relevant option',
        (value) => {
            for (const field of ['modelRatio', 'completionRatio', 'modelPrice', 'groupRatio'] as const) {
                const key = field === 'groupRatio' ? '企业级' : 'gpt-5.4';
                const result = readSyncPrice(fixture({ [field]: { [key]: value } }), 'gpt-5.4', '企业级');
                expect(result.price, field).toBeNull();
                expect(result.reason, field).toContain('必须是非负有限数字');
            }
        },
    );

    it('does not treat inherited names as configured prices', () => {
        const result = readSyncPrice(fixture(), 'toString', '企业级');
        expect(result.price).toBeNull();
        expect(result.reason).toContain('ModelRatio 缺少「toString」');
    });

    it('accepts own special-name keys in JSON without modifying prototypes', () => {
        const result = readSyncPrice(
            fixture({ modelRatio: '{"__proto__": 0.5}', completionRatio: '{"__proto__": 4}' }),
            '__proto__',
            '企业级',
        );
        expect(result.price?.input_cny_per_1m).toBe(rounded(0.5 * CHAT_FX * 1.5));
    });

    it.each(['', '   '])('rejects empty model or group %j', (value) => {
        expect(readSyncPrice(fixture(), value, '企业级').price).toBeNull();
        expect(readSyncPrice(fixture(), 'gpt-5.4', value).price).toBeNull();
    });

    it.each([1e308, 1e12, 1e-12])('rejects a token price outside catalog range or precision: %s', (value) => {
        const result = readSyncPrice(fixture({ modelRatio: { 'gpt-5.4': value } }), 'gpt-5.4', '企业级');
        expect(result.price).toBeNull();
        expect(result.reason).toContain('范围或精度');
    });

    it.each([1e308, 1e12, 1e-12])('rejects a request price outside catalog range or precision: %s', (value) => {
        const result = readSyncPrice(fixture({ modelPrice: { 'gpt-5.4': value } }), 'gpt-5.4', '企业级');
        expect(result.price).toBeNull();
        expect(result.reason).toContain('范围或精度');
    });

    it('does not mutate parsed option objects', () => {
        const raw = {
            modelRatio: Object.freeze({ 'gpt-5.4': 0.5 }),
            completionRatio: Object.freeze({ 'gpt-5.4': 4 }),
            modelPrice: Object.freeze({}),
            groupRatio: Object.freeze({ 企业级: 1.5 }),
        };
        expect(readSyncPrice(Object.freeze(raw), 'gpt-5.4', '企业级').reason).toBeNull();
        expect(raw.modelRatio).toEqual({ 'gpt-5.4': 0.5 });
    });
});
