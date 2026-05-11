/**
 * PR-U1 — reseller API endpoint smoke tests.
 *
 * Covers the critical auth + IDOR + business-logic surface across:
 *   - /join (idempotent, default code)
 *   - /profile (404 when not joined)
 *   - /codes POST (env-collision, cap)
 *   - /codes DELETE (IDOR via reseller scope)
 *   - /settlement/request (settle info required, pending block)
 *
 * Endpoints not deeply covered here (customers / commissions / dashboard)
 * are covered by their underlying lib helpers (mask + groupBy queries
 * are pure Prisma + format work).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ── shared mocks ──
const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
}));

const mockResellerFindUnique = vi.fn();
const mockResellerCreate = vi.fn();
const mockCodeFindMany = vi.fn();
const mockCodeCreate = vi.fn();
const mockCodeCount = vi.fn();
const mockCodeUpdateMany = vi.fn();
const mockUserFindUnique = vi.fn();
const mockUserGroupBy = vi.fn();
const mockSettlementFindUnique = vi.fn();
const mockSettlementUpdate = vi.fn();
const mockSettlementCreate = vi.fn();
const mockCommissionCount = vi.fn();
const mockCommissionAggregate = vi.fn();
// mockTransaction's implementation invokes the route's callback with a
// minimal stubbed `tx` surface (just the prisma delegates the /join
// happy path touches inside the tx). Typed loosely (...args: unknown[])
// so the spread-into-mock at the $transaction mock site type-checks.
const mockTransaction = vi.fn();
mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({
        reseller: { create: mockResellerCreate },
        resellerInviteCode: {
            create: mockCodeCreate,
        },
    }),
);

vi.mock('@/lib/db', () => ({
    prisma: {
        reseller: {
            findUnique: (...args: unknown[]) => mockResellerFindUnique(...args),
            create: (...args: unknown[]) => mockResellerCreate(...args),
        },
        resellerInviteCode: {
            findMany: (...args: unknown[]) => mockCodeFindMany(...args),
            create: (...args: unknown[]) => mockCodeCreate(...args),
            count: (...args: unknown[]) => mockCodeCount(...args),
            updateMany: (...args: unknown[]) => mockCodeUpdateMany(...args),
        },
        user: {
            findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
            groupBy: (...args: unknown[]) => mockUserGroupBy(...args),
        },
        resellerSettlement: {
            findUnique: (...args: unknown[]) => mockSettlementFindUnique(...args),
            update: (...args: unknown[]) => mockSettlementUpdate(...args),
            create: (...args: unknown[]) => mockSettlementCreate(...args),
        },
        resellerCommission: {
            count: (...args: unknown[]) => mockCommissionCount(...args),
            aggregate: (...args: unknown[]) => mockCommissionAggregate(...args),
        },
        $transaction: (...args: unknown[]) => mockTransaction(...args),
    },
}));

const USER = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
const RESELLER = {
    id: 'reseller-uuid',
    user_id: USER.id,
    tier: 'bronze',
    status: 'active',
    cumulative_gmv: '0',
    settle_method: null,
    settle_account: null,
    settle_name: null,
    joined_at: new Date('2026-05-01T00:00:00Z'),
};

beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue(USER);
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────
// /join
// ─────────────────────────────────────────────────────────────────────────
describe('POST /api/portal/reseller/join', () => {
    it('401 when no session', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(null);
        const { POST } = await import('@/app/api/portal/reseller/join/route');
        const r = await POST(new NextRequest('http://x/join', { method: 'POST' }));
        expect(r.status).toBe(401);
    });

    it('200 + created=false when already a reseller', async () => {
        mockResellerFindUnique.mockResolvedValueOnce(RESELLER);
        const { POST } = await import('@/app/api/portal/reseller/join/route');
        const r = await POST(new NextRequest('http://x/join', { method: 'POST' }));
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.created).toBe(false);
        expect(body.reseller.id).toBe('reseller-uuid');
    });

    it('201 + creates Reseller + default code on first call', async () => {
        mockResellerFindUnique.mockResolvedValueOnce(null);
        mockUserFindUnique.mockResolvedValueOnce({ email: 'frank@example.com' });
        mockResellerCreate.mockResolvedValueOnce({ id: 'reseller-uuid' });
        mockCodeCreate.mockResolvedValueOnce({
            id: 'code-uuid',
            code: 'FRANK-DEFAULT',
        });

        const { POST } = await import('@/app/api/portal/reseller/join/route');
        const r = await POST(new NextRequest('http://x/join', { method: 'POST' }));
        expect(r.status).toBe(201);
        const body = await r.json();
        expect(body.created).toBe(true);
        expect(body.default_code.code).toBe('FRANK-DEFAULT');
    });
});

// ─────────────────────────────────────────────────────────────────────────
// /profile
// ─────────────────────────────────────────────────────────────────────────
describe('GET /api/portal/reseller/profile', () => {
    it('404 when user not a reseller', async () => {
        mockResellerFindUnique.mockResolvedValueOnce(null);
        const { GET } = await import('@/app/api/portal/reseller/profile/route');
        const r = await GET(new NextRequest('http://x/profile'));
        expect(r.status).toBe(404);
    });

    it('200 + reseller summary when joined', async () => {
        mockResellerFindUnique.mockResolvedValueOnce(RESELLER);
        const { GET } = await import('@/app/api/portal/reseller/profile/route');
        const r = await GET(new NextRequest('http://x/profile'));
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.tier).toBe('bronze');
        expect(body.reseller_id).toBe('reseller-uuid');
    });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /codes
// ─────────────────────────────────────────────────────────────────────────
describe('POST /api/portal/reseller/codes', () => {
    const originalEnv = process.env.INVITE_CODES;
    afterEach(() => {
        if (originalEnv === undefined) delete process.env.INVITE_CODES;
        else process.env.INVITE_CODES = originalEnv;
    });

    function makeReq(body: unknown): NextRequest {
        return new NextRequest('http://x/codes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    it('400 on env-collision (calibration #3)', async () => {
        mockResellerFindUnique.mockResolvedValueOnce(RESELLER);
        process.env.INVITE_CODES = 'launch-a, beta-1';
        const { POST } = await import('@/app/api/portal/reseller/codes/route');
        const r = await POST(makeReq({ code: 'launch-A' }));
        expect(r.status).toBe(400);
        const body = await r.json();
        expect(body.error).toBe('env_collision');
    });

    it('400 on per-reseller cap (10)', async () => {
        mockResellerFindUnique.mockResolvedValueOnce(RESELLER);
        delete process.env.INVITE_CODES;
        mockCodeCount.mockResolvedValueOnce(10);
        const { POST } = await import('@/app/api/portal/reseller/codes/route');
        const r = await POST(makeReq({ code: 'NEW-CODE-001' }));
        expect(r.status).toBe(400);
        const body = await r.json();
        expect(body.error).toBe('max_codes_reached');
    });

    it('201 on valid input', async () => {
        mockResellerFindUnique.mockResolvedValueOnce(RESELLER);
        delete process.env.INVITE_CODES;
        mockCodeCount.mockResolvedValueOnce(0);
        mockCodeCreate.mockResolvedValueOnce({
            id: 'code-uuid',
            code: 'NEW-CODE-001',
            label: '朋友圈',
            is_active: true,
            created_at: new Date(),
        });
        const { POST } = await import('@/app/api/portal/reseller/codes/route');
        const r = await POST(makeReq({ code: 'new-code-001', label: '朋友圈' }));
        expect(r.status).toBe(201);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /codes/[id]
// ─────────────────────────────────────────────────────────────────────────
describe('DELETE /api/portal/reseller/codes/[id]', () => {
    it('IDOR-safe: 404 when code does not belong to current reseller', async () => {
        mockResellerFindUnique.mockResolvedValueOnce(RESELLER);
        mockCodeUpdateMany.mockResolvedValueOnce({ count: 0 });
        const { DELETE } = await import('@/app/api/portal/reseller/codes/[id]/route');
        const r = await DELETE(new NextRequest('http://x/codes/foreign-uuid', { method: 'DELETE' }), {
            params: Promise.resolve({ id: 'foreign-uuid' }),
        });
        expect(r.status).toBe(404);
    });

    it('200 on successful soft-delete', async () => {
        mockResellerFindUnique.mockResolvedValueOnce(RESELLER);
        mockCodeUpdateMany.mockResolvedValueOnce({ count: 1 });
        const { DELETE } = await import('@/app/api/portal/reseller/codes/[id]/route');
        const r = await DELETE(new NextRequest('http://x/codes/code-uuid', { method: 'DELETE' }), {
            params: Promise.resolve({ id: 'code-uuid' }),
        });
        expect(r.status).toBe(200);
        const call = mockCodeUpdateMany.mock.calls[0][0];
        expect(call.where.reseller_id).toBe(RESELLER.id);
        expect(call.data.is_active).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /settlement/request
// ─────────────────────────────────────────────────────────────────────────
describe('POST /api/portal/reseller/settlement/request', () => {
    function makeReq(body: unknown): NextRequest {
        return new NextRequest('http://x/settlement/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    it('400 when settle info missing', async () => {
        mockResellerFindUnique.mockResolvedValueOnce(RESELLER);
        const { POST } = await import('@/app/api/portal/reseller/settlement/request/route');
        const r = await POST(makeReq({ month: '2026-04' }));
        expect(r.status).toBe(400);
        const body = await r.json();
        expect(body.error).toBe('settle_info_missing');
    });

    it('400 when there are pending commissions in month', async () => {
        mockResellerFindUnique.mockResolvedValueOnce({
            ...RESELLER,
            settle_method: 'alipay',
            settle_account: 'frank@alipay.com',
            settle_name: 'Frank',
        });
        mockCommissionCount.mockResolvedValueOnce(3); // 3 still pending

        const { POST } = await import('@/app/api/portal/reseller/settlement/request/route');
        const r = await POST(makeReq({ month: '2026-04' }));
        expect(r.status).toBe(400);
        const body = await r.json();
        expect(body.error).toBe('has_pending_commissions');
    });

    it('upserts pending → requested (state flip)', async () => {
        mockResellerFindUnique.mockResolvedValueOnce({
            ...RESELLER,
            settle_method: 'alipay',
            settle_account: 'frank@alipay.com',
            settle_name: 'Frank',
        });
        mockCommissionCount.mockResolvedValueOnce(0); // no pending
        mockCommissionAggregate.mockResolvedValueOnce({
            _sum: { commission_amount: '500.00' },
            _count: { _all: 5 },
        });
        mockSettlementFindUnique.mockResolvedValueOnce({
            id: 'settlement-uuid',
            status: 'pending',
        });
        mockSettlementUpdate.mockResolvedValueOnce({
            id: 'settlement-uuid',
            status: 'requested',
        });

        const { POST } = await import('@/app/api/portal/reseller/settlement/request/route');
        const r = await POST(makeReq({ month: '2026-04' }));
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.requested).toBe(true);
        const updateArg = mockSettlementUpdate.mock.calls[0][0];
        expect(updateArg.data.status).toBe('requested');
    });

    it('400 already_paid when settlement already paid', async () => {
        mockResellerFindUnique.mockResolvedValueOnce({
            ...RESELLER,
            settle_method: 'alipay',
            settle_account: 'frank@alipay.com',
            settle_name: 'Frank',
        });
        mockCommissionCount.mockResolvedValueOnce(0);
        mockCommissionAggregate.mockResolvedValueOnce({
            _sum: { commission_amount: '500.00' },
            _count: { _all: 5 },
        });
        mockSettlementFindUnique.mockResolvedValueOnce({
            id: 'settlement-uuid',
            status: 'paid',
        });

        const { POST } = await import('@/app/api/portal/reseller/settlement/request/route');
        const r = await POST(makeReq({ month: '2026-04' }));
        expect(r.status).toBe(400);
        const body = await r.json();
        expect(body.error).toBe('already_paid');
    });
});
