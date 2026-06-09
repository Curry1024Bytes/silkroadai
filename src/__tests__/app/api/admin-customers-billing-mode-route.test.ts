import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolveAdmin = vi.fn();
const mockUserFindFirst = vi.fn();
const mockAnalyticsCreate = vi.fn();
const mockMigrateToPortal = vi.fn();
const mockRollbackToNewapi = vi.fn();

vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a) }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        user: { findFirst: (...a: unknown[]) => mockUserFindFirst(...a) },
        analyticsEvent: { create: (...a: unknown[]) => mockAnalyticsCreate(...a) },
    },
}));
vi.mock('@/lib/billing/billing-migration', () => ({
    migrateUserToPortal: (...a: unknown[]) => mockMigrateToPortal(...a),
    rollbackUserToNewapi: (...a: unknown[]) => mockRollbackToNewapi(...a),
}));

import { POST } from '@/app/api/admin/customers/[id]/billing-mode/route';

const SUPERADMIN = { role: 'superadmin', tenant_id: null, user: { id: 'admin-1' }, viaBreakGlass: false };

function req(body: unknown, id = 'u-1') {
    return new NextRequest(`https://x/api/admin/customers/${id}/billing-mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}
const params = (id = 'u-1') => Promise.resolve({ id });

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAdmin.mockResolvedValue(SUPERADMIN);
    mockUserFindFirst.mockResolvedValue({ id: 'u-1' });
    mockAnalyticsCreate.mockResolvedValue({});
    mockMigrateToPortal.mockResolvedValue({
        action: 'to_portal',
        flipped: true,
        amountCny: 7.2,
        backupQuota: 500_000,
        newBillingMode: 'portal',
    });
    mockRollbackToNewapi.mockResolvedValue({
        action: 'to_newapi',
        flipped: true,
        amountCny: 5,
        backupQuota: 347_222,
        newBillingMode: 'newapi',
    });
});

describe('POST /api/admin/customers/[id]/billing-mode', () => {
    it('gate is SUPERADMIN (resolveAdmin called with superadmin), and 401 when it returns null', async () => {
        mockResolveAdmin.mockResolvedValue(null); // resolveAdmin(_, 'superadmin') → null for an admin-but-not-superadmin
        const res = await POST(req({ action: 'to_portal' }), { params: params() });
        expect(res.status).toBe(401);
        expect(mockResolveAdmin).toHaveBeenCalledWith(expect.anything(), 'superadmin');
        expect(mockMigrateToPortal).not.toHaveBeenCalled();
    });

    it('400 on invalid action', async () => {
        const res = await POST(req({ action: 'nope' }), { params: params() });
        expect(res.status).toBe(400);
        expect(mockMigrateToPortal).not.toHaveBeenCalled();
        expect(mockRollbackToNewapi).not.toHaveBeenCalled();
    });

    it('404 (IDOR-safe) when the customer is not found in scope; never flips', async () => {
        mockUserFindFirst.mockResolvedValue(null);
        const res = await POST(req({ action: 'to_portal' }), { params: params() });
        expect(res.status).toBe(404);
        expect(mockMigrateToPortal).not.toHaveBeenCalled();
    });

    it('to_portal → migrateUserToPortal(userId, adminId) + audit event; returns the result', async () => {
        const res = await POST(req({ action: 'to_portal' }), { params: params() });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({
            ok: true,
            action: 'to_portal',
            flipped: true,
            newBillingMode: 'portal',
            backupQuota: 500_000,
        });
        expect(mockMigrateToPortal).toHaveBeenCalledWith('u-1', 'admin-1');
        expect(mockRollbackToNewapi).not.toHaveBeenCalled();
        expect(mockAnalyticsCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ event_type: 'admin_billing_mode_changed', user_id: 'u-1' }),
            }),
        );
    });

    it('to_newapi → rollbackUserToNewapi(userId, adminId)', async () => {
        const res = await POST(req({ action: 'to_newapi' }), { params: params() });
        expect(res.status).toBe(200);
        expect(mockRollbackToNewapi).toHaveBeenCalledWith('u-1', 'admin-1');
        expect(mockMigrateToPortal).not.toHaveBeenCalled();
        expect(await res.json()).toMatchObject({ ok: true, action: 'to_newapi', newBillingMode: 'newapi' });
    });

    it('audit-event failure does NOT fail the flip (best-effort)', async () => {
        mockAnalyticsCreate.mockRejectedValue(new Error('analytics down'));
        const res = await POST(req({ action: 'to_portal' }), { params: params() });
        expect(res.status).toBe(200); // flip already done via migrateUserToPortal
    });
});
