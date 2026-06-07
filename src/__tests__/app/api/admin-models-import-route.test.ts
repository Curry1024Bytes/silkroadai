import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolveAdmin = vi.fn();
const mockFindMany = vi.fn();
const mockTransaction = vi.fn();
const mockModelCreate = vi.fn();
const mockPriceCreate = vi.fn();
const mockGetChannel = vi.fn();
const mockListChannels = vi.fn();

// tx proxy reuses the same per-table spies so prisma.* and tx.* hit one place.
const txProxy = {
    catalogModel: { create: (...a: unknown[]) => mockModelCreate(...a) },
    catalogPrice: { create: (...a: unknown[]) => mockPriceCreate(...a) },
};

vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a) }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
// Real tenant-scope so the where-wiring is exercised end-to-end.
vi.mock('@/lib/db', () => ({
    prisma: {
        catalogModel: { findMany: (...a: unknown[]) => mockFindMany(...a) },
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
    mockFindMany.mockResolvedValue([]); // no existing catalog models by default
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
    mockPriceCreate.mockResolvedValue({});
});

describe('POST /api/admin/models/import — auth', () => {
    it('401 when not an admin; never touches new-api or DB', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        const res = await POST(req('POST', {}));
        expect(res.status).toBe(401);
        expect(mockGetChannel).not.toHaveBeenCalled();
        expect(mockFindMany).not.toHaveBeenCalled();
    });

    it('400 on invalid channel_ids', async () => {
        const res = await POST(req('POST', { channel_ids: ['nope'] }));
        expect(res.status).toBe(400);
    });
});

describe('POST /api/admin/models/import — dry run (default)', () => {
    it('previews the default flagship channels and writes nothing', async () => {
        const res = await POST(req('POST', {}));
        expect(res.status).toBe(200);
        const body = await res.json();

        expect(body.dryRun).toBe(true);
        expect(body.selectedChannelIds).toEqual(DEFAULT_FLAGSHIP_CHANNEL_IDS);
        expect(body.summary).toEqual({ created: 3, skipped: 0, flagged: 2 });

        // GET each selected channel (read-only); never writes.
        expect(mockGetChannel).toHaveBeenCalledWith(2);
        expect(mockGetChannel).toHaveBeenCalledWith(3);
        expect(mockGetChannel).toHaveBeenCalledWith(17);
        expect(mockTransaction).not.toHaveBeenCalled();
        expect(mockModelCreate).not.toHaveBeenCalled();
        expect(mockPriceCreate).not.toHaveBeenCalled();
    });

    it('surfaces reverse-derived retail prices + flags image models', async () => {
        const res = await POST(req('POST', {}));
        const body = await res.json();

        const opus = body.created.find((r: { slug: string }) => r.slug === 'claude-opus-4-7');
        expect(opus).toMatchObject({ vendor: 'anthropic', input_cny_per_1m: 22.5, output_cny_per_1m: 112.5 });
        const gpt = body.created.find((r: { slug: string }) => r.slug === 'gpt-5.4');
        expect(gpt).toMatchObject({ input_cny_per_1m: 2.5, output_cny_per_1m: 10 });

        expect(body.flagged.map((r: { slug: string }) => r.slug).sort()).toEqual(['gemini-3-pro-image', 'gpt-image-2']);
        expect(body.flagged.find((r: { slug: string }) => r.slug === 'gpt-image-2')).toMatchObject({
            modality: 'image',
            reason: 'image_model_manual_price',
        });
    });

    it('returns the channel menu with selected flags (incl. unselected Gemini text channel)', async () => {
        const res = await POST(req('POST', {}));
        const body = await res.json();
        expect(body.channels.find((c: { id: number }) => c.id === 2)).toMatchObject({ selected: true, model_count: 2 });
        expect(body.channels.find((c: { id: number }) => c.id === 4)).toMatchObject({
            selected: false,
            model_count: 2,
        });
    });

    it('listChannels failure → empty menu, import preview still works', async () => {
        mockListChannels.mockRejectedValue(new Error('list boom'));
        const res = await POST(req('POST', {}));
        const body = await res.json();
        expect(body.channels).toEqual([]);
        expect(body.summary.created).toBe(3);
    });

    it('skips slugs already in the catalog (idempotent, never overwrites)', async () => {
        mockFindMany.mockResolvedValue([{ slug: 'gpt-5.4', sort_order: 5 }]);
        const res = await POST(req('POST', {}));
        const body = await res.json();
        expect(body.skipped).toEqual([{ slug: 'gpt-5.4', reason: 'already_exists' }]);
        expect(body.created.find((r: { slug: string }) => r.slug === 'gpt-5.4')).toBeUndefined();
        expect(body.summary).toEqual({ created: 2, skipped: 1, flagged: 2 });
    });

    it('honors a custom channel_ids subset', async () => {
        const res = await POST(req('POST', { channel_ids: [3] }));
        const body = await res.json();
        expect(body.selectedChannelIds).toEqual([3]);
        expect(mockGetChannel).toHaveBeenCalledWith(3);
        expect(mockGetChannel).not.toHaveBeenCalledWith(2);
        expect(body.summary).toEqual({ created: 1, skipped: 0, flagged: 1 });
    });

    it('records per-channel load failures without aborting the others', async () => {
        const res = await POST(req('POST', { channel_ids: [3, 99] }));
        const body = await res.json();
        expect(body.channelErrors).toEqual([{ channel_id: 99, error: 'channel not found' }]);
        expect(body.summary.created).toBe(1); // channel 3 still imported
    });
});

describe('POST /api/admin/models/import — real import (dryRun=false)', () => {
    const realUrl = 'https://x/api/admin/models/import?dryRun=false';

    it('writes models + prices in one transaction; image models get no price row', async () => {
        const res = await POST(req('POST', {}, realUrl));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.dryRun).toBe(false);

        expect(mockTransaction).toHaveBeenCalledTimes(1);
        // 5 models (3 priced + 2 image), 3 prices (priced only)
        expect(mockModelCreate).toHaveBeenCalledTimes(5);
        expect(mockPriceCreate).toHaveBeenCalledTimes(3);

        // image model: modality image, platform tenant, correct upstream_map, NO price row
        const imageCreate = mockModelCreate.mock.calls.find((c) => c[0].data.slug === 'gpt-image-2');
        expect(imageCreate![0].data).toMatchObject({
            modality: 'image',
            tenant_id: PLATFORM_TENANT_ID,
            upstream_map: { default: { channel_id: 3, upstream_model: 'gpt-image-2' } },
        });
        expect(mockPriceCreate.mock.calls.some((c) => c[0].data.model_id === 'm-gpt-image-2')).toBe(false);

        // priced model: price row carries the reverse-derived retail price + tier default
        const gptPrice = mockPriceCreate.mock.calls.find((c) => c[0].data.model_id === 'm-gpt-5.4');
        expect(gptPrice![0].data).toMatchObject({
            tier: 'default',
            input_cny_per_1m: 2.5,
            output_cny_per_1m: 10,
            created_by: null, // break-glass superadmin
        });

        // sort_order assigned incrementally from the existing max (0) → first candidate = 1
        const opusCreate = mockModelCreate.mock.calls.find((c) => c[0].data.slug === 'claude-opus-4-7');
        expect(opusCreate![0].data.sort_order).toBe(1);
    });

    it('stamps the partner admin tenant_id + created_by, tenant-scopes the existing-slug query', async () => {
        mockResolveAdmin.mockResolvedValue(PARTNER);
        await POST(req('POST', { channel_ids: [3] }, realUrl));

        expect(mockFindMany.mock.calls[0][0].where.tenant_id).toBe('tenant-7');
        const gptCreate = mockModelCreate.mock.calls.find((c) => c[0].data.slug === 'gpt-5.4');
        expect(gptCreate![0].data.tenant_id).toBe('tenant-7');
        const price = mockPriceCreate.mock.calls[0][0];
        expect(price.data.created_by).toBe('admin-1');
    });

    it('does not write when nothing new to import (all skipped)', async () => {
        mockFindMany.mockResolvedValue([
            { slug: 'claude-opus-4-7', sort_order: 1 },
            { slug: 'claude-sonnet-4-6', sort_order: 2 },
            { slug: 'gpt-5.4', sort_order: 3 },
            { slug: 'gpt-image-2', sort_order: 4 },
            { slug: 'gemini-3-pro-image', sort_order: 5 },
        ]);
        const res = await POST(req('POST', {}, realUrl));
        const body = await res.json();
        expect(body.summary).toEqual({ created: 0, skipped: 5, flagged: 0 });
        expect(mockTransaction).not.toHaveBeenCalled();
    });
});
