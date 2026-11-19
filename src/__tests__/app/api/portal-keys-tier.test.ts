import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a) }));

const mockTokenCount = vi.fn();
const mockTokenCreate = vi.fn();
const mockPricingBinding = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        $transaction: async (work: (tx: unknown) => Promise<unknown>) => work((await import('@/lib/db')).prisma),
        pricingPublishCoordinator: { upsert: async () => ({ active_job_id: null }) },
        channelGroupRetirementJob: { findFirst: async () => null },
        channelGroup: { findFirst: async () => ({ id: 'available-tier' }) },
        customerPricingBinding: { findUnique: (...args: unknown[]) => mockPricingBinding(...args) },
        newApiToken: {
            count: (...a: unknown[]) => mockTokenCount(...a),
            create: (...a: unknown[]) => mockTokenCreate(...a),
        },
    },
}));

const mockCreateTokenForCustomer = vi.fn();
const mockListTokensForCustomer = vi.fn();
const mockGetTokenKey = vi.fn();
const mockNewapiDeleteToken = vi.fn();
const mockGetTokenForCustomer = vi.fn();
vi.mock('@/lib/newapi/client', () => ({
    createTokenForCustomer: (...a: unknown[]) => mockCreateTokenForCustomer(...a),
    listTokensForCustomer: (...a: unknown[]) => mockListTokensForCustomer(...a),
    getTokenKey: (...a: unknown[]) => mockGetTokenKey(...a),
    deleteToken: (...a: unknown[]) => mockNewapiDeleteToken(...a),
    getTokenForCustomer: (...a: unknown[]) => mockGetTokenForCustomer(...a),
}));

const mockListEnabledChannelGroups = vi.fn();
// Keep the REAL restrictGroupsForUser (pure) — mock only the DB-touching list.
vi.mock('@/lib/channel-group', async () => {
    const actual = await vi.importActual<typeof import('@/lib/channel-group')>('@/lib/channel-group');
    return {
        ...actual,
        listEnabledChannelGroups: (...a: unknown[]) => mockListEnabledChannelGroups(...a),
    };
});

import { POST } from '@/app/api/portal/keys/route';

const SESSION_USER = {
    id: 'u1',
    email: 'a@b.c',
    newapi_user_id: 7,
    newapi_access_token: 'at',
    tenant_id: null,
    allowed_tier_keys: [] as string[],
};
const GROUPS = [
    { key: 'pool', newapi_group: 'default', is_default: true },
    { key: 'official', newapi_group: 'official', is_default: false },
];

function req(body: object) {
    return new NextRequest('http://localhost/api/portal/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mockPricingBinding.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue(SESSION_USER);
    mockTokenCount.mockResolvedValue(0);
    mockListEnabledChannelGroups.mockResolvedValue(GROUPS);
    mockCreateTokenForCustomer.mockResolvedValue(undefined);
    mockNewapiDeleteToken.mockResolvedValue(undefined);
    mockListTokensForCustomer.mockResolvedValue({ items: [{ id: 99, name: 'k' }], total: 1 });
    mockGetTokenKey.mockResolvedValue('rawkey');
    mockTokenCreate.mockImplementation(({ data }: { data: { key_alias: string; tier: string } }) =>
        Promise.resolve({
            id: 'tok',
            key_alias: data.key_alias,
            tier: data.tier,
            created_at: new Date('2026-06-07T00:00:00Z'),
        }),
    );
});

describe('POST /api/portal/keys — P3 档次 → new-api group (decoupled)', () => {
    it('keeps the public tier while issuing its customer-scoped auto token and verifying the full group list', async () => {
        mockPricingBinding.mockResolvedValue({
            public_group: 'official',
            model_groups: ['model-a', 'model-b'],
            status: 'active',
        });
        mockGetTokenForCustomer.mockResolvedValue({
            id: 99,
            user_id: 7,
            group: 'auto',
            auto_groups: ['model-a', 'model-b'],
            cross_group_retry: false,
        });
        const res = await POST(req({ alias: 'k', tier: 'official', auto_groups: ['attacker-group'] }));
        expect(res.status).toBe(200);
        expect(mockCreateTokenForCustomer).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                group: 'auto',
                auto_groups: ['model-a', 'model-b'],
                cross_group_retry: false,
            }),
        );
        expect((await res.json()).tier).toBe('official');
        expect(mockTokenCreate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ tier: 'official' }) }),
        );
    });

    it('does not issue a fallback public key while the binding is incomplete', async () => {
        mockPricingBinding.mockResolvedValue({ public_group: 'official', model_groups: ['model-a'], status: 'failed' });
        const res = await POST(req({ alias: 'k', tier: 'official' }));
        expect(res.status).toBe(503);
        expect(mockCreateTokenForCustomer).not.toHaveBeenCalled();
        expect(mockTokenCreate).not.toHaveBeenCalled();
    });

    it('does not reveal or persist a key whose native auto list differs from its authorized binding', async () => {
        mockPricingBinding.mockResolvedValue({ public_group: 'official', model_groups: ['model-a'], status: 'active' });
        mockGetTokenForCustomer.mockResolvedValue({
            id: 99,
            user_id: 7,
            group: 'auto',
            auto_groups: ['model-a', 'another-tier'],
            cross_group_retry: false,
        });
        const res = await POST(req({ alias: 'k', tier: 'official' }));
        expect(res.status).toBe(503);
        expect(mockGetTokenKey).not.toHaveBeenCalled();
        expect(mockTokenCreate).not.toHaveBeenCalled();
        expect(mockNewapiDeleteToken).toHaveBeenCalledWith(expect.anything(), 99);
    });
    it('tier=official → new-api group="official", stores tier="official", response carries tier', async () => {
        const res = await POST(req({ alias: 'k', tier: 'official' }));
        expect(res.status).toBe(200);
        expect(mockCreateTokenForCustomer).toHaveBeenCalledWith(
            expect.objectContaining({ accessToken: 'at', userId: 7 }),
            expect.objectContaining({ group: 'official', unlimited_quota: true }),
        );
        expect(mockTokenCreate.mock.calls[0][0].data.tier).toBe('official');
        expect((await res.json()).tier).toBe('official');
    });

    it('tier=pool → new-api group="default" (pool decoupled to existing group), tier="pool"', async () => {
        await POST(req({ alias: 'k', tier: 'pool' }));
        expect(mockCreateTokenForCustomer.mock.calls[0][1].group).toBe('default');
        expect(mockTokenCreate.mock.calls[0][0].data.tier).toBe('pool');
    });

    it('no tier → default tier (is_default = pool) → group="default"', async () => {
        await POST(req({ alias: 'k' }));
        expect(mockCreateTokenForCustomer.mock.calls[0][1].group).toBe('default');
        expect(mockTokenCreate.mock.calls[0][0].data.tier).toBe('pool');
    });

    it('invalid tier → 400 invalid_tier, never touches new-api', async () => {
        const res = await POST(req({ alias: 'k', tier: 'enterprise' }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('invalid_tier');
        expect(mockCreateTokenForCustomer).not.toHaveBeenCalled();
        expect(mockTokenCreate).not.toHaveBeenCalled();
    });

    it('token stays unlimited_quota=true regardless of tier (gotcha #12)', async () => {
        await POST(req({ alias: 'k', tier: 'official' }));
        expect(mockCreateTokenForCustomer.mock.calls[0][1].unlimited_quota).toBe(true);
    });

    it('zero ChannelGroups + no tier → 503 without creating an unusable pool/default key', async () => {
        mockListEnabledChannelGroups.mockResolvedValue([]);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = await POST(req({ alias: 'k' }));
        expect(res.status).toBe(503);
        expect((await res.json()).error).toBe('tier_unavailable');
        expect(mockCreateTokenForCustomer).not.toHaveBeenCalled();
        expect(mockTokenCreate).not.toHaveBeenCalled();
        errSpy.mockRestore();
    });
});

describe('POST /api/portal/keys — per-customer 档次白名单 (allowed_tier_keys)', () => {
    const restrictTo = (keys: string[]) =>
        mockGetCurrentUser.mockResolvedValue({ ...SESSION_USER, allowed_tier_keys: keys });

    it('restricted to [official] + no tier → defaults to the only allowed tier (official)', async () => {
        restrictTo(['official']);
        const res = await POST(req({ alias: 'k' }));
        expect(res.status).toBe(200);
        expect(mockCreateTokenForCustomer.mock.calls[0][1].group).toBe('official');
        expect(mockTokenCreate.mock.calls[0][0].data.tier).toBe('official');
    });

    it('restricted to [official] + asks pool (not allowed) → 400, never touches new-api', async () => {
        restrictTo(['official']);
        const res = await POST(req({ alias: 'k', tier: 'pool' }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('invalid_tier');
        expect(mockCreateTokenForCustomer).not.toHaveBeenCalled();
    });

    it('restricted to image2 (enabled) → key created in group=image2', async () => {
        mockListEnabledChannelGroups.mockResolvedValue([
            { key: 'pool', newapi_group: 'default', is_default: true },
            { key: 'image2', newapi_group: 'image2', is_default: false },
        ]);
        restrictTo(['image2']);
        const res = await POST(req({ alias: 'k' }));
        expect(res.status).toBe(200);
        expect(mockCreateTokenForCustomer.mock.calls[0][1].group).toBe('image2');
        expect(mockTokenCreate.mock.calls[0][0].data.tier).toBe('image2');
    });

    it('whitelist resolves to nothing (image2 not enabled) → 400, no silent default fallback', async () => {
        // enabled = pool/official only; user restricted to image2 → empty intersection.
        restrictTo(['image2']);
        const res = await POST(req({ alias: 'k' }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('invalid_tier');
        expect(mockCreateTokenForCustomer).not.toHaveBeenCalled();
    });

    it('empty allowed_tier_keys = unrestricted (existing behavior unchanged)', async () => {
        restrictTo([]);
        const res = await POST(req({ alias: 'k', tier: 'official' }));
        expect(res.status).toBe(200);
        expect(mockCreateTokenForCustomer.mock.calls[0][1].group).toBe('official');
    });
});
