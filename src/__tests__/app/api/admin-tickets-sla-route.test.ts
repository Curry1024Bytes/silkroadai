import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolveAdmin = vi.fn();
vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...a: unknown[]) => mockResolveAdmin(...a) }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: '未授权' }, { status: 401 }),
}));
const sla = vi.hoisted(() => ({ stats: vi.fn(), set: vi.fn() }));
vi.mock('@/lib/tickets/sla', async () => {
    const actual = await vi.importActual<typeof import('@/lib/tickets/sla')>('@/lib/tickets/sla');
    return {
        ...actual,
        getTicketSlaStats: (...a: unknown[]) => sla.stats(...a),
        setTicketSla: (...a: unknown[]) => sla.set(...a),
    };
});

import { GET, PUT } from '@/app/api/admin/tickets/sla/route';

const ADMIN = { role: 'admin', tenant_id: 't', user: null, viaBreakGlass: false };
const SUPER = { role: 'superadmin', tenant_id: null, user: null, viaBreakGlass: false };
const req = (method: string, body?: unknown) =>
    new NextRequest('https://x/api/admin/tickets/sla', {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });

beforeEach(() => {
    vi.clearAllMocks();
    sla.stats.mockResolvedValue({ firstReplyHours: 4, resolveHours: 24, open: 1 });
});

describe('/api/admin/tickets/sla', () => {
    it('GET: admin ok, unauth 401', async () => {
        mockResolveAdmin.mockResolvedValue(ADMIN);
        expect((await (await GET(req('GET'))).json()).sla.open).toBe(1);
        mockResolveAdmin.mockResolvedValue(null);
        expect((await GET(req('GET'))).status).toBe(401);
    });
    it('PUT: superadmin only; validates range', async () => {
        mockResolveAdmin.mockImplementation(async (_r: unknown, min: string) => (min === 'superadmin' ? null : ADMIN));
        expect((await PUT(req('PUT', { firstReplyHours: 2, resolveHours: 48 }))).status).toBe(401);
        mockResolveAdmin.mockResolvedValue(SUPER);
        expect((await PUT(req('PUT', { firstReplyHours: 0, resolveHours: 48 }))).status).toBe(400);
        const ok = await PUT(req('PUT', { firstReplyHours: 2, resolveHours: 48 }));
        expect(ok.status).toBe(200);
        expect(sla.set).toHaveBeenCalledWith({ firstReplyHours: 2, resolveHours: 48 });
    });
});
