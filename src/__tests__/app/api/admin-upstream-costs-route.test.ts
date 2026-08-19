import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { db, resolveAdmin } = vi.hoisted(() => ({
    db: {
        upstreamCostEntry: { findMany: vi.fn(), count: vi.fn(), create: vi.fn(), createMany: vi.fn() },
        upstreamCostImport: { findUnique: vi.fn(), create: vi.fn() },
        $transaction: vi.fn(),
    },
    resolveAdmin: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/admin/auth', () => ({ resolveAdmin }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/admin/tenant-scope', () => ({
    tenantForInsert: () => 'tenant-1',
    tenantScope: () => ({ tenant_id: 'tenant-1' }),
}));

import { GET, POST } from '@/app/api/admin/upstream-costs/route';
import { POST as POST_IMPORT } from '@/app/api/admin/upstream-costs/import/route';

const admin = { role: 'superadmin', tenant_id: 'tenant-1', user: { id: 'admin-1' }, viaBreakGlass: false };
const entry = {
    id: 'e1',
    status: 'verified',
    source: 'manual',
    upstream_route: 'route',
    cost_cny: '0.1',
    created_at: new Date(),
};
const valid = {
    upstream_route: 'route',
    upstream_amount: '0.04',
    currency: 'USD',
    cny_per_unit: '2.5',
    cost_multiplier: '1',
    status: 'verified',
    upstream_request_id: 'up-1',
};

function jsonReq(url: string, body: unknown, method = 'POST') {
    return new NextRequest(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    resolveAdmin.mockResolvedValue(admin);
    db.upstreamCostEntry.create.mockResolvedValue(entry);
    db.upstreamCostEntry.findMany.mockResolvedValue([]);
    db.upstreamCostEntry.count.mockResolvedValue(0);
});

describe('upstream cost ledger routes', () => {
    it('requires superadmin for list and manual entry', async () => {
        resolveAdmin.mockResolvedValue(null);
        expect((await GET(new NextRequest('http://x/api/admin/upstream-costs'))).status).toBe(401);
        expect((await POST(jsonReq('http://x/api/admin/upstream-costs', valid))).status).toBe(401);
        expect(db.upstreamCostEntry.create).not.toHaveBeenCalled();
    });

    it('returns 400 for invalid status instead of throwing', async () => {
        const res = await GET(new NextRequest('http://x/api/admin/upstream-costs?status=wat'));
        expect(res.status).toBe(400);
        expect(db.upstreamCostEntry.findMany).not.toHaveBeenCalled();
    });

    it('creates manual entries with fixed source and tenant scope', async () => {
        const res = await POST(jsonReq('http://x/api/admin/upstream-costs', valid));
        expect(res.status).toBe(201);
        expect(db.upstreamCostEntry.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ source: 'manual', tenant_id: 'tenant-1', created_by: 'admin-1' }),
            }),
        );
    });

    it('imports a CSV once and returns the existing batch for duplicate upload', async () => {
        const csv =
            'newapi_log_id,newapi_request_id,upstream_request_id,upstream_provider,upstream_route,upstream_model,upstream_amount,currency,cny_per_unit,cost_multiplier,status,evidence_hash,evidence_summary\n1,req,up,Acme,route,gpt,0.04,USD,2.5,1,verified,,checked\n';
        const file = new File([csv], 'costs.csv', { type: 'text/csv' });
        db.upstreamCostImport.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 'batch-1', row_count: 1 });
        db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) => callback(db));
        db.upstreamCostImport.create.mockResolvedValue({ id: 'batch-1', row_count: 1 });
        const req = () => {
            const body = new FormData();
            body.set('file', file);
            return new NextRequest('http://x/api/admin/upstream-costs/import', { method: 'POST', body });
        };
        expect((await POST_IMPORT(req())).status).toBe(201);
        expect(db.upstreamCostEntry.createMany).toHaveBeenCalledTimes(1);
        expect((await POST_IMPORT(req())).status).toBe(200);
        expect(db.$transaction).toHaveBeenCalledTimes(1);
    });

    it('rolls back the whole import when the transaction fails', async () => {
        const csv =
            'newapi_log_id,newapi_request_id,upstream_request_id,upstream_provider,upstream_route,upstream_model,upstream_amount,currency,cny_per_unit,cost_multiplier,status,evidence_hash,evidence_summary\n1,req,up,Acme,route,gpt,0.04,USD,2.5,1,verified,,checked\n';
        const body = new FormData();
        body.set('file', new File([csv], 'costs.csv', { type: 'text/csv' }));
        db.upstreamCostImport.findUnique.mockResolvedValue(null);
        db.$transaction.mockRejectedValue(new Error('db down'));
        const res = await POST_IMPORT(
            new NextRequest('http://x/api/admin/upstream-costs/import', { method: 'POST', body }),
        );
        expect(res.status).toBe(500);
        expect((await res.json()).message).toContain('未写入任何');
    });
});
