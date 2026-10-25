import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const { db, charge } = vi.hoisted(() => ({
    db: {
        newApiToken: { findUnique: vi.fn() },
        user: { findUnique: vi.fn() },
        seedanceVideoTask: { create: vi.fn() },
    },
    charge: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/billing/customer-balance', () => ({ getCustomerBalance: vi.fn(async () => ({ balanceCny: 100 })) }));
vi.mock('../cn-billing', () => ({ estimateCostCny: vi.fn(() => 1), chargeSeedanceVideoTask: charge }));
import { handleSeedanceVideoSubmit } from '../cn-proxy';
beforeEach(() => {
    vi.clearAllMocks();
    db.newApiToken.findUnique.mockResolvedValue({
        user_id: 'u1',
        tier: process.env.SEEDANCE_CN_TIER || 'seedance-cn-enterprise',
        status: 'active',
    });
    db.user.findUnique.mockResolvedValue({ tenant_id: null, billing_mode: 'portal', newapi_user_id: 42 });
    db.seedanceVideoTask.create.mockRejectedValue(new Error('database unavailable after acceptance'));
});
afterEach(() => vi.unstubAllGlobals());
it('does not instruct the customer or SDK to resubmit an accepted task after its ownership row fails', async () => {
    const send = vi.fn(async () => new Response(JSON.stringify({ id: 'cgt-accepted', status: 'queued' })));
    vi.stubGlobal('fetch', send);
    const response = await handleSeedanceVideoSubmit(
        new NextRequest('http://portal.test/v1/videos', {
            method: 'POST',
            headers: { authorization: 'Bearer sk-fixture' },
        }),
        { model: 'seedance2.5-720p', prompt: 'fixture' },
    );
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toMatchObject({
        code: 'task_record_unconfirmed',
        accepted: true,
        retryable: false,
        task_id: 'cgt-accepted',
    });
    expect(body.error.message).toContain('Do not resubmit');
    expect(body.error.message).not.toMatch(/please retry/i);
    expect(response.headers.get('X-Should-Retry')).toBe('false');
    expect(response.headers.get('X-Request-Id')).toBe(body.error.request_id);
    expect(response.headers.has('Retry-After')).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(charge).not.toHaveBeenCalled();
});
