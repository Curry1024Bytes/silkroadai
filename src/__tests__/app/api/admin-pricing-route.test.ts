import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolveAdmin = vi.fn();
const mockModelFindFirst = vi.fn();
const mockModelFindMany = vi.fn();
const mockPriceCreate = vi.fn();
const mockSync = vi.fn();

vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a) }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        catalogModel: {
            findFirst: (...a: unknown[]) => mockModelFindFirst(...a),
            findMany: (...a: unknown[]) => mockModelFindMany(...a),
        },
        catalogPrice: {
            create: (...a: unknown[]) => mockPriceCreate(...a),
        },
    },
}));
vi.mock('@/lib/newapi/pricing-sync', () => ({ syncModelPriceToNewApi: (...a: unknown[]) => mockSync(...a) }));

import { GET, POST } from '@/app/api/admin/pricing/route';
import { POST as RESYNC } from '@/app/api/admin/pricing/[modelId]/resync/route';

const SUPERADMIN = { role: 'superadmin', tenant_id: null, user: null, viaBreakGlass: true };
const PARTNER = { role: 'admin', tenant_id: 'tenant-7', user: { id: 'admin-1' }, viaBreakGlass: false };
const UPSTREAM = { default: { channel_id: 3, upstream_model: 'gpt-5.4' } };

function req(method = 'GET', body?: object, url = 'https://x/api/admin/pricing') {
    return new NextRequest(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAdmin.mockResolvedValue(SUPERADMIN);
    mockModelFindMany.mockResolvedValue([]);
    mockModelFindFirst.mockResolvedValue({ id: 'm1', upstream_map: UPSTREAM, prices: [] });
    mockPriceCreate.mockImplementation(({ data }: { data: object }) => Promise.resolve({ id: 'p1', ...data }));
    mockSync.mockResolvedValue({
        ok: true,
        channel_id: 3,
        upstream_model: 'gpt-5.4',
        ratios: { model_ratio: 0.357143, completion_ratio: 4 },
    });
});

describe('GET /api/admin/pricing', () => {
    it('401 when not an admin', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        expect((await GET(req())).status).toBe(401);
    });
    it('returns tenant-scoped models with prices', async () => {
        const res = await GET(req());
        expect(res.status).toBe(200);
        expect(mockModelFindMany.mock.calls[0][0].include.prices).toBeTruthy();
    });
});

describe('POST /api/admin/pricing (change price)', () => {
    const CHANGE = {
        model_id: '11111111-1111-4111-8111-111111111111',
        tier: 'default',
        input_cny_per_1m: 2.5,
        output_cny_per_1m: 10,
    };

    it('401 when not an admin', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        expect((await POST(req('POST', CHANGE))).status).toBe(401);
    });

    it('400 when neither in+out nor per_image provided', async () => {
        const res = await POST(req('POST', { model_id: CHANGE.model_id, tier: 'default' }));
        expect(res.status).toBe(400);
    });

    it('404 when the model is not in the tenant', async () => {
        mockModelFindFirst.mockResolvedValue(null);
        expect((await POST(req('POST', CHANGE))).status).toBe(404);
        expect(mockPriceCreate).not.toHaveBeenCalled();
    });

    it('inserts a NEW price version row (does not update) + triggers sync', async () => {
        const res = await POST(req('POST', CHANGE));
        expect(res.status).toBe(201);
        const data = await res.json();
        // version row created with the new price + tier
        expect(mockPriceCreate.mock.calls[0][0].data).toMatchObject({
            model_id: 'm1',
            tier: 'default',
            input_cny_per_1m: 2.5,
            output_cny_per_1m: 10,
        });
        // sync called with the model's upstream_map + the new price
        expect(mockSync).toHaveBeenCalledWith(
            UPSTREAM,
            expect.objectContaining({ tier: 'default', input_cny_per_1m: 2.5 }),
        );
        expect(data.sync.ok).toBe(true);
    });

    it('tier defaults to pool when omitted (P2.7 — never writes a "default" row)', async () => {
        const res = await POST(
            req('POST', {
                model_id: CHANGE.model_id,
                input_cny_per_1m: 2.5,
                output_cny_per_1m: 10,
            }),
        );
        expect(res.status).toBe(201);
        expect(mockPriceCreate.mock.calls[0][0].data.tier).toBe('pool');
    });

    it('records created_by = the admin user id', async () => {
        mockResolveAdmin.mockResolvedValue(PARTNER);
        await POST(req('POST', CHANGE));
        expect(mockPriceCreate.mock.calls[0][0].data.created_by).toBe('admin-1');
    });

    it('break-glass admin → created_by null', async () => {
        await POST(req('POST', CHANGE)); // SUPERADMIN with user:null
        expect(mockPriceCreate.mock.calls[0][0].data.created_by).toBeNull();
    });

    it('sync failure still saves the price (price is source of truth) + returns sync error', async () => {
        mockSync.mockResolvedValue({
            ok: false,
            error: '502 upstream',
            ratios: { model_ratio: 0.357143, completion_ratio: 4 },
        });
        const res = await POST(req('POST', CHANGE));
        expect(res.status).toBe(201);
        const data = await res.json();
        expect(mockPriceCreate).toHaveBeenCalled(); // price still persisted
        expect(data.sync.ok).toBe(false);
        expect(data.sync.error).toContain('502');
    });
});

describe('POST /api/admin/pricing/[modelId]/resync', () => {
    const rurl = 'https://x/api/admin/pricing/m1/resync';
    const rparams = () => Promise.resolve({ modelId: 'm1' });

    it('404 when model not in tenant', async () => {
        mockModelFindFirst.mockResolvedValue(null);
        expect((await RESYNC(req('POST', undefined, rurl), { params: rparams() })).status).toBe(404);
    });

    it('400 when the model has no prices', async () => {
        mockModelFindFirst.mockResolvedValue({ id: 'm1', upstream_map: UPSTREAM, prices: [] });
        expect((await RESYNC(req('POST', undefined, rurl), { params: rparams() })).status).toBe(400);
    });

    it('re-syncs current price per tier', async () => {
        mockModelFindFirst.mockResolvedValue({
            id: 'm1',
            upstream_map: UPSTREAM,
            prices: [
                {
                    tier: 'default',
                    input_cny_per_1m: '2.5',
                    output_cny_per_1m: '10',
                    per_image_cny: null,
                    effective_from: '2026-06-06T00:00:00Z',
                },
                {
                    tier: 'default',
                    input_cny_per_1m: '3',
                    output_cny_per_1m: '12',
                    per_image_cny: null,
                    effective_from: '2026-06-01T00:00:00Z',
                },
            ],
        });
        const res = await RESYNC(req('POST', undefined, rurl), { params: rparams() });
        expect(res.status).toBe(200);
        const data = await res.json();
        // only the CURRENT (first/newest) price per tier is synced → 1 call
        expect(mockSync).toHaveBeenCalledTimes(1);
        expect(mockSync).toHaveBeenCalledWith(
            UPSTREAM,
            expect.objectContaining({ tier: 'default', input_cny_per_1m: 2.5 }),
        );
        expect(data.results[0].tier).toBe('default');
    });
});
