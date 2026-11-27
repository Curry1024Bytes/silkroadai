import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolveAdmin = vi.fn();
const mockTenantFindUnique = vi.fn();
const mockUpsert = vi.fn();
const mockHistoryCreate = vi.fn();
const mockPriceUpdate = vi.fn();

interface Row {
    group_key: string;
    wholesale_ratio: number;
    retail_ratio: number | null;
}
let context: { current: Row[]; billingGroups: Map<string, string>; groupRatio: Record<string, number> };

vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a) }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
vi.mock('@/lib/db', () => {
    const tx = {
        partnerGroupPrice: { upsert: (...a: unknown[]) => mockUpsert(...a) },
        partnerWholesaleRatioHistory: { create: (...a: unknown[]) => mockHistoryCreate(...a) },
    };
    return {
        prisma: {
            tenant: { findUnique: (...a: unknown[]) => mockTenantFindUnique(...a) },
            partnerGroupPrice: {
                update: (...a: unknown[]) => mockPriceUpdate(...a),
                findMany: async () => [],
                delete: vi.fn(),
            },
            partnerRetailRatioHistory: { create: vi.fn() },
            channelGroup: { findMany: async () => [] },
            $transaction: async (work: unknown) =>
                Array.isArray(work) ? Promise.all(work) : (work as (client: unknown) => Promise<unknown>)(tx),
        },
    };
});
vi.mock('@/lib/newapi/client', () => ({ NewApiError: class NewApiError extends Error {} }));
vi.mock('@/lib/newapi/user-tier-multiplier', () => ({ UserTierMultiplierError: class UserTierMultiplierError extends Error {} }));
vi.mock('@/lib/partner/pricing-sync', () => ({
    // 真实实现在定价锁内先写 new-api 再落库；这里只验证路由的校验和落库内容。
    changePartnerPricing: async (args: {
        change: (ctx: typeof context) => Promise<{ persist: () => Promise<unknown> }>;
    }) => {
        const { persist } = await args.change(context);
        return persist();
    },
}));

import { POST as ADMIN_POST } from '@/app/api/admin/tenants/[id]/partner-prices/route';
import { PUT as PARTNER_PUT } from '@/app/api/partner/pricing/route';

const TENANT = '11111111-2222-3333-4444-555555555555';
const PLATFORM = '00000000-0000-0000-0000-000000000001';

function req(url: string, method: string, body: object) {
    return new NextRequest(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}
const adminPost = (body: object, id = TENANT) =>
    ADMIN_POST(req(`https://x/api/admin/tenants/${id}/partner-prices`, 'POST', body), {
        params: Promise.resolve({ id }),
    });
const partnerPut = (body: object) => PARTNER_PUT(req('https://x/api/partner/pricing', 'PUT', body));

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAdmin.mockResolvedValue({ role: 'superadmin', tenant_id: null, user: { id: 'admin-1' } });
    mockTenantFindUnique.mockResolvedValue({ id: TENANT });
    mockUpsert.mockImplementation(async ({ create }: { create: Row }) => ({ ...create, retail_ratio: null, updated_at: new Date() }));
    mockPriceUpdate.mockResolvedValue({});
    context = {
        current: [
            { group_key: 'sd-official', wholesale_ratio: 0.07, retail_ratio: 0.09 },
            { group_key: 'sd-cheap', wholesale_ratio: 0.06, retail_ratio: null },
        ],
        billingGroups: new Map([
            ['sd-official', 'SD官转'],
            ['sd-cheap', 'SD特惠'],
            ['claude', 'Claude'],
        ]),
        groupRatio: { SD官转: 0.1, SD特惠: 0.08, Claude: 0.12 },
    };
});

describe('POST /api/admin/tenants/[id]/partner-prices', () => {
    it('refuses a wholesale ratio above the partner retail ratio', async () => {
        const res = await adminPost({ group_key: 'sd-official', wholesale_ratio: 0.1 });
        expect(res.status).toBe(409);
        expect((await res.json()).message).toContain('零售率');
        expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('opens a new group and records the wholesale ratio in history', async () => {
        const res = await adminPost({ group_key: 'claude', wholesale_ratio: 0.08 });
        expect(res.status).toBe(200);
        expect(mockUpsert).toHaveBeenCalledWith(
            expect.objectContaining({ create: expect.objectContaining({ group_key: 'claude', wholesale_ratio: 0.08 }) }),
        );
        expect(mockHistoryCreate).toHaveBeenCalledWith({
            data: { tenant_id: TENANT, group_key: 'claude', wholesale_ratio: 0.08, created_by: 'admin-1' },
        });
    });

    it('adds no history row when the ratio is unchanged', async () => {
        expect((await adminPost({ group_key: 'sd-official', wholesale_ratio: 0.07 })).status).toBe(200);
        expect(mockHistoryCreate).not.toHaveBeenCalled();
    });

    it('rounds ratios to the stored precision', async () => {
        await adminPost({ group_key: 'claude', wholesale_ratio: 0.0800004 });
        expect(mockHistoryCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ wholesale_ratio: 0.08 }) });
    });

    it('refuses groups missing from new-api GroupRatio and disabled tiers', async () => {
        context.groupRatio = {};
        expect((await adminPost({ group_key: 'claude', wholesale_ratio: 0.08 })).status).toBe(409);
        expect((await adminPost({ group_key: 'retired', wholesale_ratio: 0.08 })).status).toBe(400);
        expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('rejects the platform tenant and non-superadmins', async () => {
        expect((await adminPost({ group_key: 'claude', wholesale_ratio: 0.08 }, PLATFORM)).status).toBe(400);
        mockResolveAdmin.mockResolvedValue(null);
        expect((await adminPost({ group_key: 'claude', wholesale_ratio: 0.08 })).status).toBe(401);
    });
});

describe('PUT /api/partner/pricing', () => {
    beforeEach(() => {
        mockResolveAdmin.mockResolvedValue({ role: 'staff', tenant_id: TENANT, user: { id: 'staff-1' } });
    });

    it('refuses a retail ratio below the wholesale ratio', async () => {
        const res = await partnerPut({ prices: [{ group_key: 'sd-official', retail_ratio: 0.06 }] });
        expect(res.status).toBe(400);
        expect((await res.json()).message).toContain('拿货价');
        expect(mockPriceUpdate).not.toHaveBeenCalled();
    });

    it('refuses groups the platform has not opened to the partner', async () => {
        expect((await partnerPut({ prices: [{ group_key: 'claude', retail_ratio: 0.2 }] })).status).toBe(400);
        expect(mockPriceUpdate).not.toHaveBeenCalled();
    });

    it('saves only changed rows, and null closes a group', async () => {
        const res = await partnerPut({
            prices: [
                { group_key: 'sd-official', retail_ratio: null },
                { group_key: 'sd-cheap', retail_ratio: 0.08 },
            ],
        });
        expect(res.status).toBe(200);
        expect(mockPriceUpdate).toHaveBeenCalledTimes(2);
        expect(mockPriceUpdate).toHaveBeenCalledWith({
            where: { tenant_id_group_key: { tenant_id: TENANT, group_key: 'sd-official' } },
            data: { retail_ratio: null },
        });
        expect(mockPriceUpdate).toHaveBeenCalledWith({
            where: { tenant_id_group_key: { tenant_id: TENANT, group_key: 'sd-cheap' } },
            data: { retail_ratio: 0.08 },
        });
    });

    it('rejects duplicate groups and platform staff', async () => {
        expect(
            (
                await partnerPut({
                    prices: [
                        { group_key: 'sd-cheap', retail_ratio: 0.08 },
                        { group_key: 'sd-cheap', retail_ratio: 0.09 },
                    ],
                })
            ).status,
        ).toBe(400);
        mockResolveAdmin.mockResolvedValue({ role: 'staff', tenant_id: PLATFORM, user: { id: 'staff-2' } });
        expect((await partnerPut({ prices: [{ group_key: 'sd-cheap', retail_ratio: 0.08 }] })).status).toBe(403);
    });
});
