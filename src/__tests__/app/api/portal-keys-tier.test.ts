import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a) }));

const mockTokenCount = vi.fn();
const mockTokenCreate = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
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
vi.mock('@/lib/newapi/client', () => ({
    createTokenForCustomer: (...a: unknown[]) => mockCreateTokenForCustomer(...a),
    listTokensForCustomer: (...a: unknown[]) => mockListTokensForCustomer(...a),
    getTokenKey: (...a: unknown[]) => mockGetTokenKey(...a),
    deleteToken: (...a: unknown[]) => mockNewapiDeleteToken(...a),
}));

const mockListEnabledChannelGroups = vi.fn();
vi.mock('@/lib/channel-group', () => ({
    listEnabledChannelGroups: (...a: unknown[]) => mockListEnabledChannelGroups(...a),
}));

import { POST } from '@/app/api/portal/keys/route';

const SESSION_USER = { id: 'u1', email: 'a@b.c', newapi_user_id: 7, newapi_access_token: 'at', tenant_id: null };
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
    mockGetCurrentUser.mockResolvedValue(SESSION_USER);
    mockTokenCount.mockResolvedValue(0);
    mockListEnabledChannelGroups.mockResolvedValue(GROUPS);
    mockCreateTokenForCustomer.mockResolvedValue(undefined);
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

    it('zero ChannelGroups + no tier → safe fallback pool/default (does not break key creation)', async () => {
        mockListEnabledChannelGroups.mockResolvedValue([]);
        const res = await POST(req({ alias: 'k' }));
        expect(res.status).toBe(200);
        expect(mockCreateTokenForCustomer.mock.calls[0][1].group).toBe('default');
        expect(mockTokenCreate.mock.calls[0][0].data.tier).toBe('pool');
    });
});
