import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolveAdmin = vi.fn();
const mockFindMany = vi.fn();
const mockCreateMany = vi.fn();

vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a) }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        catalogModel: { findMany: (...a: unknown[]) => mockFindMany(...a) },
        catalogPrice: { createMany: (...a: unknown[]) => mockCreateMany(...a) },
    },
}));

import { POST } from '@/app/api/admin/pricing/batch-cost/route';

// session superadmin (has user.id → created_by passes through).
const SUPERADMIN = { role: 'superadmin', tenant_id: null, user: { id: 'admin-9' }, viaBreakGlass: false };
const PARTNER = { role: 'admin', tenant_id: 'tenant-7', user: { id: 'p1' }, viaBreakGlass: false };

function post(body: unknown) {
    return new NextRequest('https://x/api/admin/pricing/batch-cost', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
    });
}

// anthropic family: opus (single tier), sonnet (two tiers), image (per_image), haiku (unpriced).
function wireModels() {
    mockFindMany.mockResolvedValue([
        {
            id: 'm-opus',
            slug: 'claude-opus-4-8',
            display_name: 'Opus',
            modality: 'chat',
            upstream_map: { pool: {} },
            prices: [
                {
                    tier: 'pool',
                    input_cny_per_1m: 6.5,
                    output_cny_per_1m: 32.5,
                    per_image_cny: null,
                    cost_cny_per_1m: null,
                },
            ],
        },
        {
            id: 'm-sonnet',
            slug: 'claude-sonnet-4-8',
            display_name: 'Sonnet',
            modality: 'chat',
            upstream_map: { pool: {}, official: {} },
            prices: [
                { tier: 'pool', input_cny_per_1m: 13, output_cny_per_1m: 65, per_image_cny: null, cost_cny_per_1m: 1 },
                {
                    tier: 'official',
                    input_cny_per_1m: 26,
                    output_cny_per_1m: 130,
                    per_image_cny: null,
                    cost_cny_per_1m: null,
                },
            ],
        },
        {
            id: 'm-img',
            slug: 'gemini-image',
            display_name: 'Image',
            modality: 'image',
            upstream_map: { pool: {} },
            prices: [
                {
                    tier: 'pool',
                    input_cny_per_1m: null,
                    output_cny_per_1m: null,
                    per_image_cny: 0.3,
                    cost_cny_per_1m: null,
                },
            ],
        },
        {
            id: 'm-haiku',
            slug: 'claude-haiku-4-8',
            display_name: 'Haiku',
            modality: 'chat',
            upstream_map: { pool: {} },
            prices: [],
        },
    ]);
}

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAdmin.mockResolvedValue(SUPERADMIN);
    wireModels();
    mockCreateMany.mockImplementation(({ data }: { data: unknown[] }) => Promise.resolve({ count: data.length }));
});

describe('POST /api/admin/pricing/batch-cost', () => {
    it('401 when not an admin (no DB touched)', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        const res = await POST(post({ vendor: 'anthropic', cost_ratio: 0.15, retail_ratio: 1.3 }));
        expect(res.status).toBe(401);
        expect(mockFindMany).not.toHaveBeenCalled();
        expect(mockCreateMany).not.toHaveBeenCalled();
    });

    it('zod rejects non-positive ratios + missing vendor (400, no write)', async () => {
        expect((await POST(post({ vendor: 'anthropic', cost_ratio: 0, retail_ratio: 1.3 }))).status).toBe(400);
        expect((await POST(post({ vendor: 'anthropic', cost_ratio: 0.15, retail_ratio: -1 }))).status).toBe(400);
        expect((await POST(post({ cost_ratio: 0.15, retail_ratio: 1.3 }))).status).toBe(400);
        expect(mockCreateMany).not.toHaveBeenCalled();
    });

    it('dryRun: returns preview (affected/skipped + opus ¥0.75) without writing', async () => {
        const res = await POST(post({ vendor: 'anthropic', cost_ratio: 0.15, retail_ratio: 1.3, dryRun: true }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({ dryRun: true, vendor: 'anthropic', written: 0, affected: 4, skipped: 1 });
        const opus = body.rows.find((r: { model_id: string }) => r.model_id === 'm-opus');
        expect(opus.newCost).toBe(0.75);
        expect(mockCreateMany).not.toHaveBeenCalled();
    });

    it('apply: inserts a NEW version row per affected (model,tier) — copies retail + new cost, never updates', async () => {
        const res = await POST(post({ vendor: 'anthropic', cost_ratio: 0.15, retail_ratio: 1.3 }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({ dryRun: false, written: 4 });

        expect(mockCreateMany).toHaveBeenCalledTimes(1);
        const data = mockCreateMany.mock.calls[0][0].data as Record<string, unknown>[];
        expect(data).toHaveLength(4); // opus + sonnet×2 + image, NOT the unpriced haiku

        // opus row: copies current retail (6.5/32.5), sets new cost 0.75, created_by from session admin.
        const opus = data.find((d) => d.model_id === 'm-opus')!;
        expect(opus).toMatchObject({
            model_id: 'm-opus',
            tier: 'pool',
            input_cny_per_1m: 6.5,
            output_cny_per_1m: 32.5,
            per_image_cny: null,
            cost_cny_per_1m: 0.75,
            created_by: 'admin-9',
        });
        // version-append, not overwrite: no id / no effective_from override (default now() makes it newest).
        expect(opus).not.toHaveProperty('id');
        expect(opus).not.toHaveProperty('effective_from');

        // image row pins per_image as the cost base.
        const img = data.find((d) => d.model_id === 'm-img')!;
        expect(img).toMatchObject({ per_image_cny: 0.3, cost_cny_per_1m: 0.0346 });

        // unpriced haiku is absent from the write set.
        expect(data.some((d) => d.model_id === 'm-haiku')).toBe(false);
    });

    it('tier filter forwards to the computation (only that tier written)', async () => {
        const res = await POST(post({ vendor: 'anthropic', cost_ratio: 0.15, retail_ratio: 1.3, tier: 'official' }));
        const body = await res.json();
        const data = mockCreateMany.mock.calls[0][0].data as Record<string, unknown>[];
        // only sonnet/official has an 'official' price → exactly one write
        expect(data).toHaveLength(1);
        expect(data[0]).toMatchObject({ model_id: 'm-sonnet', tier: 'official', cost_cny_per_1m: 3 });
        expect(body.tier).toBe('official');
    });

    it('queries the vendor scoped to the tenant (superadmin → no tenant filter)', async () => {
        await POST(post({ vendor: 'anthropic', cost_ratio: 0.15, retail_ratio: 1.3, dryRun: true }));
        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.vendor).toBe('anthropic');
        expect(where).not.toHaveProperty('tenant_id');

        vi.clearAllMocks();
        wireModels();
        mockResolveAdmin.mockResolvedValue(PARTNER);
        await POST(post({ vendor: 'anthropic', cost_ratio: 0.15, retail_ratio: 1.3, dryRun: true }));
        expect(mockFindMany.mock.calls[0][0].where.tenant_id).toBe('tenant-7');
    });
});
