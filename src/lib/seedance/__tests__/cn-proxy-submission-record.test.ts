import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const { db, charge, getCustomerBalance, getPricingSnapshot, estimateFromSnapshot } = vi.hoisted(() => ({
    db: {
        newApiToken: { findUnique: vi.fn() },
        user: { findUnique: vi.fn() },
        seedanceVideoTask: { create: vi.fn() },
    },
    charge: vi.fn(),
    getCustomerBalance: vi.fn(async () => ({ balanceCny: 100 })),
    getPricingSnapshot: vi.fn(),
    estimateFromSnapshot: vi.fn(() => 1),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/billing/customer-balance', () => ({ getCustomerBalance }));
vi.mock('../cn-billing', () => ({
    chargeSeedanceVideoTask: charge,
    getSeedancePricingSnapshot: getPricingSnapshot,
    estimateCostCnyFromSnapshot: estimateFromSnapshot,
}));
import { handleSeedanceVideoSubmit } from '../cn-proxy';
beforeEach(() => {
    vi.clearAllMocks();
    getPricingSnapshot.mockResolvedValue({
        rate: 75,
        discount: 1,
        source: 'model',
        timezone: 'Asia/Shanghai',
        rule: { basis: { rate: 75 }, evaluatedAt: '2026-11-13T00:00:00.000Z' },
    });
    db.newApiToken.findUnique.mockResolvedValue({
        user_id: 'u1',
        tier: process.env.SEEDANCE_CN_TIER || 'seedance-cn-enterprise',
        status: 'active',
    });
    db.user.findUnique.mockResolvedValue({ tenant_id: null, billing_mode: 'portal', newapi_user_id: 42 });
    db.seedanceVideoTask.create.mockRejectedValue(new Error('database unavailable after acceptance'));
});
afterEach(() => vi.unstubAllGlobals());
it('fails closed before balance lookup or adapter submission when live pricing is unavailable', async () => {
    getPricingSnapshot.mockRejectedValueOnce(new Error('pricing rule unavailable'));
    const send = vi.fn();
    vi.stubGlobal('fetch', send);
    const response = await handleSeedanceVideoSubmit(
        new NextRequest('http://portal.test/v1/videos', {
            method: 'POST',
            headers: { authorization: 'Bearer sk-fixture' },
        }),
        { model: 'seedance2.5-720p', prompt: 'fixture' },
    );

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('pricing_unavailable');
    expect(getCustomerBalance).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(db.seedanceVideoTask.create).not.toHaveBeenCalled();
});

it('uses and persists the same live pricing snapshot for the balance gate and task settlement', async () => {
    db.seedanceVideoTask.create.mockResolvedValueOnce({});
    const send = vi.fn(async () => new Response(JSON.stringify({ id: 'cgt-priced', status: 'queued' })));
    vi.stubGlobal('fetch', send);
    const response = await handleSeedanceVideoSubmit(
        new NextRequest('http://portal.test/v1/videos', {
            method: 'POST',
            headers: { authorization: 'Bearer sk-fixture' },
        }),
        { model: 'seedance2.5-720p', prompt: 'fixture' },
    );

    expect(response.status).toBe(200);
    expect(estimateFromSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ rate: 75, discount: 1 }),
        '720p',
        5,
        false,
    );
    const createArg = db.seedanceVideoTask.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArg.data).toMatchObject({
        id: 'cgt-priced',
        pricing_discount: 1,
        pricing_source: 'model',
        pricing_timezone: 'Asia/Shanghai',
        pricing_rule: { basis: { rate: 75 } },
    });
});

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
