import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolveAdmin = vi.fn();
const mockModelFindMany = vi.fn();
const mockChannelGroupFindMany = vi.fn();
const mockTransaction = vi.fn();
const mockModelCreate = vi.fn();
const mockModelUpdate = vi.fn();
const mockPriceCreate = vi.fn();
const mockGetChannel = vi.fn();
const mockListChannels = vi.fn();

// tx proxy reuses the same per-table spies so prisma.* and tx.* hit one place.
const txProxy = {
    catalogModel: {
        create: (...a: unknown[]) => mockModelCreate(...a),
        update: (...a: unknown[]) => mockModelUpdate(...a),
    },
    catalogPrice: { create: (...a: unknown[]) => mockPriceCreate(...a) },
};

vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a) }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
// Real tenant-scope so the where-wiring is exercised end-to-end.
vi.mock('@/lib/db', () => ({
    prisma: {
        catalogModel: { findMany: (...a: unknown[]) => mockModelFindMany(...a) },
        channelGroup: { findMany: (...a: unknown[]) => mockChannelGroupFindMany(...a) },
        $transaction: (...a: unknown[]) => mockTransaction(...a),
    },
}));
// Mock only the new-api HTTP surface; buildImportCandidates + retailFromRatios run for real.
vi.mock('@/lib/newapi/client', () => ({
    getChannel: (...a: unknown[]) => mockGetChannel(...a),
    listChannels: (...a: unknown[]) => mockListChannels(...a),
}));

import { POST, DEFAULT_FLAGSHIP_CHANNEL_IDS } from '@/app/api/admin/models/import/route';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

const SUPERADMIN = { role: 'superadmin', tenant_id: null, user: null, viaBreakGlass: true };
const PARTNER = { role: 'admin', tenant_id: 'tenant-7', user: { id: 'admin-1' }, viaBreakGlass: false };
const REAL = 'https://x/api/admin/models/import?dryRun=false';

function req(method = 'POST', body?: object, url = 'https://x/api/admin/models/import') {
    return new NextRequest(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
}

// 2 = Claude (2 priced), 3 = OpenAI (1 priced + 1 image), 17 = nexaxis (1 image).
function channelFixture(id: number) {
    if (id === 2)
        return {
            id: 2,
            name: 'sub2api',
            models: 'claude-opus-4-7,claude-sonnet-4-6',
            model_ratio: JSON.stringify({ 'claude-opus-4-7': 3.214286, 'claude-sonnet-4-6': 0.642857 }),
            completion_ratio: JSON.stringify({ 'claude-opus-4-7': 5, 'claude-sonnet-4-6': 5 }),
        };
    if (id === 3)
        return {
            id: 3,
            name: 'sub2api-openai',
            models: 'gpt-5.4,gpt-image-2',
            model_ratio: JSON.stringify({ 'gpt-5.4': 0.357143 }),
            completion_ratio: JSON.stringify({ 'gpt-5.4': 4 }),
        };
    if (id === 17)
        return { id: 17, name: 'nexaxis', models: 'gemini-3-pro-image', model_ratio: '{}', completion_ratio: '{}' };
    throw new Error('channel not found');
}

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAdmin.mockResolvedValue(SUPERADMIN);
    mockModelFindMany.mockResolvedValue([]); // no existing catalog models by default
    // default: no group registers any channel → everything falls to the default tier (pool).
    // Fixtures return groups already in DB orderBy order (tier_level asc, key asc); the route's
    // orderBy is on the query (ignored by the mock), so we pre-sort here to mirror it.
    mockChannelGroupFindMany.mockResolvedValue([
        { key: 'pool', newapi_channel_ids: [], is_default: true, tier_level: 0 },
        { key: 'official', newapi_channel_ids: [], is_default: false, tier_level: 1 },
    ]);
    mockGetChannel.mockImplementation((id: number) => Promise.resolve(channelFixture(id)));
    mockListChannels.mockResolvedValue([
        { id: 2, name: 'sub2api', type: 14, models: 'claude-opus-4-7,claude-sonnet-4-6' },
        { id: 3, name: 'sub2api-openai', type: 1, models: 'gpt-5.4,gpt-image-2' },
        { id: 4, name: 'Gemini', type: 24, models: 'gemini-3-pro,gemini-3-flash' },
        { id: 17, name: 'nexaxis', type: 24, models: 'gemini-3-pro-image' },
    ]);
    mockTransaction.mockImplementation(async (arg: unknown) => {
        if (typeof arg === 'function') return await (arg as (tx: typeof txProxy) => Promise<unknown>)(txProxy);
        return Promise.all(arg as unknown[]);
    });
    mockModelCreate.mockImplementation(({ data }: { data: { slug: string } }) =>
        Promise.resolve({ id: `m-${data.slug}`, ...data }),
    );
    mockModelUpdate.mockResolvedValue({});
    mockPriceCreate.mockResolvedValue({});
});

describe('POST /api/admin/models/import — auth', () => {
    it('401 when not an admin; never touches new-api or DB', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        const res = await POST(req('POST', {}));
        expect(res.status).toBe(401);
        expect(mockGetChannel).not.toHaveBeenCalled();
        expect(mockModelFindMany).not.toHaveBeenCalled();
        expect(mockChannelGroupFindMany).not.toHaveBeenCalled();
    });

    it('400 on invalid channel_ids', async () => {
        const res = await POST(req('POST', { channel_ids: ['nope'] }));
        expect(res.status).toBe(400);
    });
});

describe('POST /api/admin/models/import — dry run (official not registered → all pool)', () => {
    it('previews default channels as pool, writes nothing, flags missing official config', async () => {
        const res = await POST(req('POST', {}));
        expect(res.status).toBe(200);
        const body = await res.json();

        expect(body.dryRun).toBe(true);
        expect(body.officialRegistered).toBe(false);
        expect(body.selectedChannelIds).toEqual(DEFAULT_FLAGSHIP_CHANNEL_IDS);
        expect(body.summary).toEqual({ created: 3, skipped: 0, flagged: 2 });

        // every imported (model,tier) lands in pool when no official channels are registered.
        expect(body.created.every((r: { tier: string }) => r.tier === 'pool')).toBe(true);
        expect(body.flagged.every((r: { tier: string }) => r.tier === 'pool')).toBe(true);

        expect(mockTransaction).not.toHaveBeenCalled();
        expect(mockModelCreate).not.toHaveBeenCalled();
        expect(mockPriceCreate).not.toHaveBeenCalled();
    });

    it('surfaces reverse-derived retail prices + flags image models (with tier)', async () => {
        const body = await (await POST(req('POST', {}))).json();
        const opus = body.created.find((r: { slug: string }) => r.slug === 'claude-opus-4-7');
        expect(opus).toMatchObject({ tier: 'pool', input_cny_per_1m: 22.5, output_cny_per_1m: 112.5 });
        const img = body.flagged.find((r: { slug: string }) => r.slug === 'gpt-image-2');
        expect(img).toMatchObject({ tier: 'pool', modality: 'image', reason: 'image_model_manual_price' });
    });

    it('returns the channel menu with per-channel tier (all pool here)', async () => {
        const body = await (await POST(req('POST', {}))).json();
        expect(body.channels.find((c: { id: number }) => c.id === 2)).toMatchObject({ selected: true, tier: 'pool' });
        expect(body.channels.find((c: { id: number }) => c.id === 4)).toMatchObject({ selected: false, tier: 'pool' });
    });

    it('listChannels failure → empty menu; channel-group read + import preview still work', async () => {
        mockListChannels.mockRejectedValue(new Error('list boom'));
        const body = await (await POST(req('POST', {}))).json();
        expect(body.channels).toEqual([]);
        expect(body.officialRegistered).toBe(false);
        expect(body.summary.created).toBe(3);
    });

    it('records per-channel load failures without aborting the others', async () => {
        const body = await (await POST(req('POST', { channel_ids: [3, 88] }))).json();
        expect(body.channelErrors).toEqual([{ channel_id: 88, error: 'channel not found' }]);
        expect(body.summary.created).toBe(1); // channel 3 gpt-5.4 still imported
    });
});

describe('POST /api/admin/models/import — tier classification', () => {
    it('channels in the official group import as official; others as pool', async () => {
        mockChannelGroupFindMany.mockResolvedValue([
            { key: 'pool', newapi_channel_ids: [], is_default: true, tier_level: 0 },
            { key: 'official', newapi_channel_ids: [2], is_default: false, tier_level: 1 }, // Claude = official
        ]);
        const body = await (await POST(req('POST', {}))).json();

        expect(body.officialRegistered).toBe(true);
        expect(body.created.find((r: { slug: string }) => r.slug === 'claude-opus-4-7').tier).toBe('official');
        expect(body.created.find((r: { slug: string }) => r.slug === 'gpt-5.4').tier).toBe('pool');
        expect(body.channels.find((c: { id: number }) => c.id === 2).tier).toBe('official');
        expect(body.channels.find((c: { id: number }) => c.id === 3).tier).toBe('pool');
        // only enabled groups are read for tier judgment, ordered deterministically.
        expect(mockChannelGroupFindMany.mock.calls[0][0].where.enabled).toBe(true);
        expect(mockChannelGroupFindMany.mock.calls[0][0].orderBy).toEqual([{ tier_level: 'asc' }, { key: 'asc' }]);
    });
});

describe('POST /api/admin/models/import — P2.8 arbitrary tiers (cc-kiro) + conflicts', () => {
    function ccKiroChannel(id: number) {
        if (id === 20)
            return {
                id: 20,
                name: 'cc-kiro-openai',
                models: 'gpt-5.4',
                model_ratio: JSON.stringify({ 'gpt-5.4': 0.357143 }),
                completion_ratio: JSON.stringify({ 'gpt-5.4': 4 }),
            };
        return channelFixture(id);
    }

    it('a channel registered to a custom group imports under that group key (not pool)', async () => {
        mockChannelGroupFindMany.mockResolvedValue([
            { key: 'pool', newapi_channel_ids: [], is_default: true, tier_level: 0 },
            { key: 'official', newapi_channel_ids: [2], is_default: false, tier_level: 1 },
            { key: 'cc-kiro', newapi_channel_ids: [20], is_default: false, tier_level: 2 },
        ]);
        mockGetChannel.mockImplementation((id: number) => Promise.resolve(ccKiroChannel(id)));
        mockListChannels.mockResolvedValue([
            { id: 2, name: 'sub2api', type: 14, models: 'claude-opus-4-7,claude-sonnet-4-6' },
            { id: 20, name: 'cc-kiro-openai', type: 1, models: 'gpt-5.4' },
        ]);

        const body = await (await POST(req('POST', { channel_ids: [2, 20] }))).json();
        expect(body.defaultTier).toBe('pool');
        expect(body.tierConflicts).toEqual([]);
        // channel 20 (registered to cc-kiro) → cc-kiro, NOT pool (the P2.6 bug).
        const gpt = body.created.find((r: { slug: string }) => r.slug === 'gpt-5.4');
        expect(gpt).toMatchObject({ tier: 'cc-kiro', channel_id: 20 });
        // channel 2 → official; menu reflects each channel's real tier.
        expect(body.created.find((r: { slug: string }) => r.slug === 'claude-opus-4-7').tier).toBe('official');
        expect(body.channels.find((c: { id: number }) => c.id === 20).tier).toBe('cc-kiro');
        expect(body.channels.find((c: { id: number }) => c.id === 2).tier).toBe('official');
    });

    it('uses the is_default group key as catch-all (not hardcoded "pool")', async () => {
        mockChannelGroupFindMany.mockResolvedValue([
            { key: 'house', newapi_channel_ids: [], is_default: true, tier_level: 0 },
            { key: 'official', newapi_channel_ids: [2], is_default: false, tier_level: 1 },
        ]);
        const body = await (await POST(req('POST', {}))).json();
        expect(body.defaultTier).toBe('house');
        // unregistered channel 3 → 'house' (the default tier), NOT 'pool'.
        expect(body.created.find((r: { slug: string }) => r.slug === 'gpt-5.4').tier).toBe('house');
        expect(body.channels.find((c: { id: number }) => c.id === 3).tier).toBe('house');
    });

    it('flags a channel registered to ≥2 enabled groups; first (lowest tier_level) wins', async () => {
        mockChannelGroupFindMany.mockResolvedValue([
            { key: 'pool', newapi_channel_ids: [3], is_default: true, tier_level: 0 },
            { key: 'official', newapi_channel_ids: [3], is_default: false, tier_level: 1 },
        ]);
        const body = await (await POST(req('POST', { channel_ids: [3] }))).json();
        // pool is iterated first (tier_level 0) → wins; the conflict is surfaced for the preview.
        expect(body.tierConflicts).toEqual([{ channel_id: 3, tiers: ['pool', 'official'], assigned: 'pool' }]);
        expect(body.channels.find((c: { id: number }) => c.id === 3).tier).toBe('pool');
        expect(body.created.find((r: { slug: string }) => r.slug === 'gpt-5.4').tier).toBe('pool');
    });
});

describe('POST /api/admin/models/import — same slug across tiers (real import)', () => {
    it('pool + official channel with the same slug → 1 model (2-tier upstream_map) + 2 prices', async () => {
        mockChannelGroupFindMany.mockResolvedValue([{ key: 'official', newapi_channel_ids: [99] }]);
        mockGetChannel.mockImplementation((id: number) => {
            if (id === 3)
                return Promise.resolve({
                    id: 3,
                    name: 'pool-openai',
                    models: 'gpt-5.4',
                    model_ratio: JSON.stringify({ 'gpt-5.4': 0.357143 }),
                    completion_ratio: JSON.stringify({ 'gpt-5.4': 4 }),
                });
            if (id === 99)
                return Promise.resolve({
                    id: 99,
                    name: 'official-openai',
                    models: 'gpt-5.4',
                    model_ratio: JSON.stringify({ 'gpt-5.4': 0.5 }),
                    completion_ratio: JSON.stringify({ 'gpt-5.4': 4 }),
                });
            throw new Error('nf');
        });

        const body = await (await POST(req('POST', { channel_ids: [3, 99] }, REAL))).json();
        expect(body.summary).toEqual({ created: 2, skipped: 0, flagged: 0 });

        // exactly one model created, carrying both tiers in upstream_map.
        expect(mockModelCreate).toHaveBeenCalledTimes(1);
        expect(mockModelCreate.mock.calls[0][0].data).toMatchObject({
            slug: 'gpt-5.4',
            upstream_map: {
                pool: { channel_id: 3, upstream_model: 'gpt-5.4' },
                official: { channel_id: 99, upstream_model: 'gpt-5.4' },
            },
        });

        // two prices, one per tier, both pointing at the created model.
        expect(mockPriceCreate).toHaveBeenCalledTimes(2);
        const poolPrice = mockPriceCreate.mock.calls.find((c) => c[0].data.tier === 'pool')![0].data;
        expect(poolPrice).toMatchObject({ model_id: 'm-gpt-5.4', input_cny_per_1m: 2.5, output_cny_per_1m: 10 });
        const offPrice = mockPriceCreate.mock.calls.find((c) => c[0].data.tier === 'official')![0].data;
        expect(offPrice).toMatchObject({ model_id: 'm-gpt-5.4', input_cny_per_1m: 3.5, output_cny_per_1m: 14 });
    });
});

describe('POST /api/admin/models/import — per (slug,tier) idempotency (real import)', () => {
    const existingGpt = {
        id: 'mod-1',
        slug: 'gpt-5.4',
        sort_order: 1,
        upstream_map: { pool: { channel_id: 3, upstream_model: 'gpt-5.4' } },
        prices: [{ tier: 'pool' }],
    };

    it('existing pool model, importing official → merge upstream_map + add official price (pool untouched)', async () => {
        mockChannelGroupFindMany.mockResolvedValue([{ key: 'official', newapi_channel_ids: [99] }]);
        mockModelFindMany.mockResolvedValue([existingGpt]);
        mockGetChannel.mockImplementation((id: number) =>
            id === 99
                ? Promise.resolve({
                      id: 99,
                      name: 'off',
                      models: 'gpt-5.4',
                      model_ratio: JSON.stringify({ 'gpt-5.4': 0.5 }),
                      completion_ratio: JSON.stringify({ 'gpt-5.4': 4 }),
                  })
                : Promise.reject(new Error('nf')),
        );

        const body = await (await POST(req('POST', { channel_ids: [99] }, REAL))).json();
        expect(body.summary).toEqual({ created: 1, skipped: 0, flagged: 0 });
        expect(body.created[0]).toMatchObject({ slug: 'gpt-5.4', tier: 'official' });

        // model merged (updated), NOT created.
        expect(mockModelCreate).not.toHaveBeenCalled();
        expect(mockModelUpdate).toHaveBeenCalledTimes(1);
        expect(mockModelUpdate.mock.calls[0][0]).toMatchObject({
            where: { id: 'mod-1' },
            data: {
                upstream_map: {
                    pool: { channel_id: 3, upstream_model: 'gpt-5.4' },
                    official: { channel_id: 99, upstream_model: 'gpt-5.4' },
                },
            },
        });
        // only the official price is created; the existing pool price is never overwritten.
        expect(mockPriceCreate).toHaveBeenCalledTimes(1);
        expect(mockPriceCreate.mock.calls[0][0].data).toMatchObject({ model_id: 'mod-1', tier: 'official' });
    });

    it('re-importing an existing (slug,tier) price → skipped, no overwrite, no model update', async () => {
        // official NOT registered → channel 3 = pool, same as the existing pool price.
        mockModelFindMany.mockResolvedValue([existingGpt]);
        mockGetChannel.mockImplementation((id: number) =>
            id === 3 ? Promise.resolve(channelFixture(3)) : Promise.reject(new Error('nf')),
        );

        const body = await (await POST(req('POST', { channel_ids: [3] }, REAL))).json();
        // gpt-5.4 pool price exists → skipped; gpt-image-2 is a NEW image model → flagged.
        expect(body.skipped).toContainEqual({ slug: 'gpt-5.4', tier: 'pool', reason: 'price_exists' });
        expect(body.summary).toEqual({ created: 0, skipped: 1, flagged: 1 });

        // gpt-5.4 upstream_map.pool already correct → not updated; gpt-image-2 created.
        const gptUpdate = mockModelUpdate.mock.calls.find((c) => c[0].where?.id === 'mod-1');
        expect(gptUpdate).toBeUndefined();
        expect(mockModelCreate).toHaveBeenCalledTimes(1);
        expect(mockModelCreate.mock.calls[0][0].data.slug).toBe('gpt-image-2');
        expect(mockPriceCreate).not.toHaveBeenCalled(); // pool skip + image has no price
    });

    it('nothing new to import (all priced + mapped) → no transaction', async () => {
        mockModelFindMany.mockResolvedValue([
            existingGpt,
            {
                id: 'mod-2',
                slug: 'gpt-image-2',
                sort_order: 2,
                upstream_map: { pool: { channel_id: 3, upstream_model: 'gpt-image-2' } },
                prices: [{ tier: 'pool' }],
            },
        ]);
        mockGetChannel.mockImplementation((id: number) =>
            id === 3 ? Promise.resolve(channelFixture(3)) : Promise.reject(new Error('nf')),
        );
        const body = await (await POST(req('POST', { channel_ids: [3] }, REAL))).json();
        expect(body.summary).toEqual({ created: 0, skipped: 2, flagged: 0 });
        expect(mockTransaction).not.toHaveBeenCalled();
    });
});

describe('POST /api/admin/models/import — real import writes + tenant scope', () => {
    it('default channels (all pool): creates models + pool prices in one transaction; image gets no price', async () => {
        const body = await (await POST(req('POST', {}, REAL))).json();
        expect(body.dryRun).toBe(false);
        expect(mockTransaction).toHaveBeenCalledTimes(1);

        // 5 distinct slugs → 5 models; 3 priced → 3 prices (all pool).
        expect(mockModelCreate).toHaveBeenCalledTimes(5);
        expect(mockPriceCreate).toHaveBeenCalledTimes(3);
        expect(mockPriceCreate.mock.calls.every((c) => c[0].data.tier === 'pool')).toBe(true);

        const imgCreate = mockModelCreate.mock.calls.find((c) => c[0].data.slug === 'gpt-image-2')!;
        expect(imgCreate[0].data).toMatchObject({
            modality: 'image',
            tenant_id: PLATFORM_TENANT_ID,
            upstream_map: { pool: { channel_id: 3, upstream_model: 'gpt-image-2' } },
        });
        expect(mockPriceCreate.mock.calls.some((c) => c[0].data.model_id === 'm-gpt-image-2')).toBe(false);
    });

    it('stamps the partner admin tenant_id + created_by; tenant-scopes both reads', async () => {
        mockResolveAdmin.mockResolvedValue(PARTNER);
        await POST(req('POST', { channel_ids: [3] }, REAL));
        expect(mockChannelGroupFindMany.mock.calls[0][0].where.tenant_id).toBe('tenant-7');
        expect(mockModelFindMany.mock.calls[0][0].where.tenant_id).toBe('tenant-7');
        const gptCreate = mockModelCreate.mock.calls.find((c) => c[0].data.slug === 'gpt-5.4')!;
        expect(gptCreate[0].data.tenant_id).toBe('tenant-7');
        expect(mockPriceCreate.mock.calls[0][0].data.created_by).toBe('admin-1');
    });
});
