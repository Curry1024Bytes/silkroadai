import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolveAdmin = vi.fn();
const mockUserFindFirst = vi.fn();
const mockGetState = vi.fn();
const mockSet = vi.fn();
const { CustomerRatioError } = vi.hoisted(() => ({
    CustomerRatioError: class CustomerRatioError extends Error {
        constructor(
            public readonly code: string,
            message: string,
        ) {
            super(message);
        }
    },
}));
vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a) }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
vi.mock('@/lib/db', () => ({ prisma: { user: { findFirst: (...a: unknown[]) => mockUserFindFirst(...a) } } }));
vi.mock('@/lib/newapi/customer-ratio', () => ({
    getCustomerRatioState: (...a: unknown[]) => mockGetState(...a),
    setCustomerRatios: (...a: unknown[]) => mockSet(...a),
    CustomerRatioError,
}));

import { GET, PUT } from '@/app/api/admin/customers/[id]/special-ratios/route';

const SUPERADMIN = { role: 'superadmin', tenant_id: null, user: { id: 'admin-1' }, viaBreakGlass: false };
const params = Promise.resolve({ id: 'u-1' });
const put = (body: unknown) =>
    new NextRequest('https://x/api/admin/customers/u-1/special-ratios', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
const get = () => new NextRequest('https://x/api/admin/customers/u-1/special-ratios');

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAdmin.mockResolvedValue(SUPERADMIN);
    mockUserFindFirst.mockResolvedValue({ id: 'u-1' });
    mockGetState.mockResolvedValue({ overrides: [], drift: false });
    mockSet.mockResolvedValue({
        userGroup: 'vip-c-x',
        previousGroup: 'default',
        matrixRow: {},
        verified: {},
        verifiedOk: true,
    });
});

describe('/api/admin/customers/[id]/special-ratios', () => {
    it('superadmin gate: 401 when resolveAdmin returns null (GET + PUT)', async () => {
        mockResolveAdmin.mockResolvedValue(null);
        expect((await GET(get(), { params })).status).toBe(401);
        expect((await PUT(put({ overrides: [] }), { params })).status).toBe(401);
        expect(mockResolveAdmin).toHaveBeenCalledWith(expect.anything(), 'superadmin');
        expect(mockSet).not.toHaveBeenCalled();
    });

    it('404 when the customer is outside the admin tenant scope', async () => {
        mockUserFindFirst.mockResolvedValue(null);
        expect((await GET(get(), { params })).status).toBe(404);
        expect((await PUT(put({ overrides: [] }), { params })).status).toBe(404);
    });

    it('GET returns the state', async () => {
        const res = await GET(get(), { params });
        expect(res.status).toBe(200);
        expect(mockGetState).toHaveBeenCalledWith('u-1');
    });

    it('PUT validates body: ratio must be positive ≤ 100, group non-empty', async () => {
        for (const body of [
            {},
            { overrides: [{ newapi_group: '', ratio: 1 }] },
            { overrides: [{ newapi_group: 'g', ratio: 0 }] },
            { overrides: [{ newapi_group: 'g', ratio: 101 }] },
        ]) {
            const res = await PUT(put(body), { params });
            expect(res.status, JSON.stringify(body)).toBe(400);
        }
        expect(mockSet).not.toHaveBeenCalled();
    });

    it('PUT happy: calls setCustomerRatios with admin id, returns result + fresh state', async () => {
        const res = await PUT(put({ overrides: [{ newapi_group: 'oai image 2', ratio: 1.7, note: 'x' }] }), { params });
        expect(res.status).toBe(200);
        expect(mockSet).toHaveBeenCalledWith(
            'u-1',
            [{ newapi_group: 'oai image 2', ratio: 1.7, note: 'x' }],
            'admin-1',
        );
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.result.userGroup).toBe('vip-c-x');
        expect(mockGetState).toHaveBeenCalledTimes(1);
    });

    it('PUT via break-glass records updated_by="break-glass"', async () => {
        mockResolveAdmin.mockResolvedValue({ ...SUPERADMIN, user: null, viaBreakGlass: true });
        await PUT(put({ overrides: [] }), { params });
        expect(mockSet).toHaveBeenCalledWith('u-1', [], 'break-glass');
    });

    it('maps CustomerRatioError codes: unknown_group→400, account_not_provisioned→409, newapi_user_unreadable→502; other errors→502', async () => {
        mockSet.mockRejectedValueOnce(new CustomerRatioError('unknown_group', 'x'));
        expect((await PUT(put({ overrides: [] }), { params })).status).toBe(400);
        mockSet.mockRejectedValueOnce(new CustomerRatioError('account_not_provisioned', 'x'));
        expect((await PUT(put({ overrides: [] }), { params })).status).toBe(409);
        mockSet.mockRejectedValueOnce(new CustomerRatioError('newapi_user_unreadable', 'x'));
        expect((await PUT(put({ overrides: [] }), { params })).status).toBe(502);
        mockSet.mockRejectedValueOnce(new CustomerRatioError('token_pin_failed', 'x'));
        expect((await PUT(put({ overrides: [] }), { params })).status).toBe(502);
        mockSet.mockRejectedValueOnce(new Error('boom'));
        expect((await PUT(put({ overrides: [] }), { params })).status).toBe(502);
    });
});
