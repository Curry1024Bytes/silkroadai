import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolveAdmin = vi.fn();
const mockTenantFindUnique = vi.fn();
const mockTenantFindFirst = vi.fn();
const mockTenantUpdate = vi.fn();
const mockClaimFindUnique = vi.fn();
const mockClaimFindFirst = vi.fn();
const mockClaimUpsert = vi.fn();
const mockClaimDelete = vi.fn();
const mockTx = vi.fn();

vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a) }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
vi.mock('@/lib/db', () => {
    return {
        prisma: {
            tenant: {
                findUnique: (...a: unknown[]) => mockTenantFindUnique(...a),
                findFirst: (...a: unknown[]) => mockTenantFindFirst(...a),
                update: (...a: unknown[]) => mockTenantUpdate(...a),
            },
            partnerDomainClaim: {
                findUnique: (...a: unknown[]) => mockClaimFindUnique(...a),
                findFirst: (...a: unknown[]) => mockClaimFindFirst(...a),
                upsert: (...a: unknown[]) => mockClaimUpsert(...a),
                delete: (...a: unknown[]) => mockClaimDelete(...a),
            },
            $transaction: (...a: unknown[]) => mockTx(...a),
        },
    };
});
const mockResolveTxt = vi.fn();
const mockResolveCname = vi.fn();
vi.mock('dns/promises', () => ({
    default: {
        resolveTxt: (...a: unknown[]) => mockResolveTxt(...a),
        resolveCname: (...a: unknown[]) => mockResolveCname(...a),
    },
}));

import { GET, POST } from '@/app/api/partner/domain/route';

const TENANT = '11111111-2222-3333-4444-555555555555';
const PLATFORM = '00000000-0000-0000-0000-000000000001';

function req(method: string, body?: object) {
    return new NextRequest('https://x/api/partner/domain', {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAdmin.mockResolvedValue({ role: 'staff', tenant_id: TENANT, user: { id: 'u1' } });
    mockTenantFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
        where.id === PLATFORM
            ? { primary_domain: 'llmroute.club', domains: ['llmroute.club', 'www.llmroute.club'] }
            : { primary_domain: 'old.example.com', domains: ['old.example.com'] },
    );
    mockTenantFindFirst.mockResolvedValue(null);
    mockClaimFindUnique.mockResolvedValue(null);
    mockClaimFindFirst.mockResolvedValue(null);
    mockClaimUpsert.mockImplementation(async ({ create }: { create: { domain: string; token: string } }) => create);
    mockClaimDelete.mockResolvedValue({});
    mockTx.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) =>
        work({
            tenant: { findUnique: mockTenantFindUnique, update: mockTenantUpdate },
            partnerDomainClaim: { delete: mockClaimDelete },
        }),
    );
    mockTenantUpdate.mockImplementation(async ({ data }: { data: { primary_domain: string; domains: string[] } }) => data);
    mockResolveTxt.mockResolvedValue([['abc']]);
    mockResolveCname.mockResolvedValue(['custom.llmroute.club.']);
});

describe('POST /api/partner/domain', () => {
    it('creates a pending claim with TXT and CNAME instructions instead of binding immediately', async () => {
        const res = await POST(req('POST', { domain: 'New.Example.com' }));
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(mockTenantUpdate).not.toHaveBeenCalled();
        expect(mockClaimUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenant_id: TENANT },
                create: expect.objectContaining({ domain: 'new.example.com', token: expect.stringMatching(/^[0-9a-f]{32}$/) }),
            }),
        );
        expect(data.pending.txt).toMatchObject({ host: '_llmroute-verify.new.example.com', type: 'TXT' });
        expect(data.pending.cname).toMatchObject({ host: 'new.example.com', type: 'CNAME' });
    });

    it('rejects invalid, platform and already-used domains', async () => {
        expect((await POST(req('POST', { domain: 'not a domain' }))).status).toBe(400);
        expect((await POST(req('POST', { domain: 'llmroute.club' }))).status).toBe(409);
        mockTenantFindFirst.mockResolvedValue({ id: 'other' });
        expect((await POST(req('POST', { domain: 'taken.example.com' }))).status).toBe(409);
        expect(mockClaimUpsert).not.toHaveBeenCalled();
    });

    it('requires a partner tenant', async () => {
        mockResolveAdmin.mockResolvedValue({ role: 'staff', tenant_id: PLATFORM, user: { id: 'u1' } });
        expect((await POST(req('POST', { domain: 'x.example.com' }))).status).toBe(403);
    });
});

describe('POST /api/partner/domain — verify', () => {
    beforeEach(() => {
        mockClaimFindUnique.mockResolvedValue({ tenant_id: TENANT, domain: 'new.example.com', token: 'abc' });
    });

    it('fails when the TXT record does not match', async () => {
        mockResolveTxt.mockResolvedValue([['wrong']]);
        const data = await (await POST(req('POST', { action: 'verify' }))).json();
        expect(data).toMatchObject({ verified: false, txt_ok: false });
        expect(mockTenantUpdate).not.toHaveBeenCalled();
    });

    it('binds the domain only after TXT ownership is proven, and drops the old primary', async () => {
        const res = await POST(req('POST', { action: 'verify' }));
        const data = await res.json();
        expect(data).toMatchObject({ verified: true, txt_ok: true, cname_ok: true, primary_domain: 'new.example.com' });
        expect(mockTenantUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: TENANT },
                data: { primary_domain: 'new.example.com', domains: ['new.example.com'] },
            }),
        );
        expect(mockClaimDelete).toHaveBeenCalledWith({ where: { tenant_id: TENANT } });
    });

    it('keeps the CNAME advisory: a proxied domain without a resolvable CNAME still verifies', async () => {
        mockResolveCname.mockRejectedValue(new Error('ENODATA'));
        const data = await (await POST(req('POST', { action: 'verify' }))).json();
        expect(data).toMatchObject({ verified: true, cname_ok: false });
    });

    it('refuses a verified domain that another tenant already uses', async () => {
        mockTenantFindFirst.mockResolvedValue({ id: 'other' });
        expect((await POST(req('POST', { action: 'verify' }))).status).toBe(409);
        expect(mockTenantUpdate).not.toHaveBeenCalled();
    });

    it('returns 400 without a pending claim', async () => {
        mockClaimFindUnique.mockResolvedValue(null);
        expect((await POST(req('POST', { action: 'verify' }))).status).toBe(400);
    });
});

describe('GET /api/partner/domain', () => {
    it('returns the bound domain plus the pending claim instructions', async () => {
        mockClaimFindUnique.mockResolvedValue({ tenant_id: TENANT, domain: 'new.example.com', token: 'tok' });
        const data = await (await GET(req('GET'))).json();
        expect(data).toMatchObject({
            primary_domain: 'old.example.com',
            pending: { domain: 'new.example.com', txt: { value: 'tok' } },
        });
    });
});
