/**
 * 2026-09-12 intentional contract replacement: old tests accepted an effective
 * CatalogPrice even when the following new-api write failed. That unsafe contract
 * is retired. Routes now require a reviewed durable task; verified activation and
 * recovery are covered by publisher tests. Pure pricing-sync regressions stay intact.
 * The real input schema/error mapper are used; service, DB, API and persisted reads
 * are sealed mocks. No HTTP, credentials or production writes are permitted here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocked = vi.hoisted(() => ({
    auth: vi.fn(),
    models: vi.fn(),
    groups: vi.fn(),
    createPrice: vi.fn(),
    legacySync: vi.fn(),
    getOption: vi.fn(),
    remoteRead: vi.fn(),
    remoteWrite: vi.fn(),
    persistedRead: vi.fn(),
    preview: vi.fn(),
    enqueue: vi.fn(),
    jobs: vi.fn(),
    changeJob: vi.fn(),
    network: vi.fn(),
}));
vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: mocked.auth }));
vi.mock('@/lib/admin-auth', () => ({
    unauthorizedResponse: () => NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        catalogModel: { findMany: mocked.models },
        channelGroup: { findMany: mocked.groups },
        catalogPrice: { create: mocked.createPrice },
    },
}));
vi.mock('@/lib/newapi/client', () => ({
    getOption: mocked.getOption,
    putOption: mocked.remoteWrite,
    getPricingPublishOptions: mocked.remoteRead,
    listChannelsForCatalogSync: mocked.remoteRead,
    putPricingPublishOption: mocked.remoteWrite,
}));
vi.mock('@/lib/newapi/persisted-pricing', () => ({ readPersistedPricingOptions: mocked.persistedRead }));
vi.mock('@/lib/newapi/pricing-sync', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/newapi/pricing-sync')>()),
    syncModelPriceToNewApi: mocked.legacySync,
}));
vi.mock('@/lib/admin/pricing-publish', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/admin/pricing-publish')>()),
    previewPricingPublish: mocked.preview,
    enqueuePricingPublish: mocked.enqueue,
    listPricingJobs: mocked.jobs,
    changePricingJob: mocked.changeJob,
}));

import { GET, POST } from '@/app/api/admin/pricing/route';
import { POST as RESYNC } from '@/app/api/admin/pricing/[modelId]/resync/route';
import { POST as JOB } from '@/app/api/admin/pricing/publish/[id]/route';
import { PricingPublishError } from '@/lib/admin/pricing-publish-lock';

const MODEL_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN = { role: 'superadmin', tenant_id: null, user: { id: 'admin-1' }, viaBreakGlass: false };
const INPUT = {
    model_id: MODEL_ID,
    tier: 'sale',
    input_cny_per_1m: 2.5,
    output_cny_per_1m: 10,
    per_image_cny: null,
    cost_cny_per_1m: null,
};
const TOKEN = '1789196400000.' + 'a'.repeat(64);
const PREVIEW = {
    preview_token: TOKEN,
    expires_at: '2026-09-12T08:10:00Z',
    upstream_model: 'gpt-test',
    basis: 'token',
    rows: [],
    warnings: [],
};
const SAVED_JOB = {
    id: JOB_ID,
    status: 'queued',
    message: '等待核验，目录价格未更新。',
    attempts: 0,
    created_at: '2026-09-12T08:00:00Z',
    updated_at: '2026-09-12T08:00:00Z',
    next_attempt_at: null,
    upstream_model: 'gpt-test',
};
const params = (id = JOB_ID) => ({ params: Promise.resolve({ id }) });
function req(method = 'GET', body?: unknown, path = '/api/admin/pricing') {
    return new NextRequest(`https://portal.test${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mocked.auth.mockResolvedValue(ADMIN);
    mocked.models.mockResolvedValue([{ id: MODEL_ID, prices: [{ id: 'historical-price' }] }]);
    mocked.groups.mockResolvedValue([{ key: 'sale', newapi_group: 'Sale' }]);
    mocked.getOption.mockResolvedValue('{"Sale":1}');
    mocked.preview.mockResolvedValue(PREVIEW);
    mocked.enqueue.mockResolvedValue(SAVED_JOB);
    mocked.jobs.mockResolvedValue([SAVED_JOB]);
    mocked.changeJob.mockResolvedValue(SAVED_JOB);
    mocked.network.mockRejectedValue(new Error('Network is sealed in pricing route tests'));
    vi.stubGlobal('fetch', mocked.network);
});
afterEach(() => {
    for (const operation of [
        mocked.network,
        mocked.remoteRead,
        mocked.remoteWrite,
        mocked.persistedRead,
        mocked.createPrice,
        mocked.legacySync,
    ])
        expect(operation).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
});

describe('pricing routes require superadmin before any work', () => {
    it.each(['get', 'preview', 'publish', 'resync', 'job'] as const)('rejects unauthorized %s', async (entry) => {
        mocked.auth.mockResolvedValue(null);
        const request = req(
            entry === 'get' ? 'GET' : 'POST',
            entry === 'get'
                ? undefined
                : { action: entry === 'preview' ? 'preview' : 'publish', ...INPUT, preview_token: TOKEN },
        );
        const response =
            entry === 'get'
                ? await GET(request)
                : entry === 'resync'
                  ? await RESYNC(request)
                  : entry === 'job'
                    ? await JOB(request, params())
                    : await POST(request);
        expect(response.status).toBe(401);
        expect(mocked.auth).toHaveBeenCalledWith(request, 'superadmin');
        for (const operation of [
            mocked.models,
            mocked.groups,
            mocked.getOption,
            mocked.preview,
            mocked.enqueue,
            mocked.jobs,
            mocked.changeJob,
        ])
            expect(operation).not.toHaveBeenCalled();
    });
});

describe('GET /api/admin/pricing', () => {
    it('returns catalog history and persisted jobs for the authenticated administrator', async () => {
        const request = req();
        const response = await GET(request);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.models[0].prices).toEqual([{ id: 'historical-price' }]);
        expect(body.publish_jobs).toEqual([SAVED_JOB]);
        expect(body.pricing_context.group_ratio_by_tier).toEqual({ sale: 1 });
        expect(mocked.models).toHaveBeenCalledWith(
            expect.objectContaining({ include: { prices: { orderBy: { effective_from: 'desc' } } } }),
        );
        expect(mocked.jobs).toHaveBeenCalledWith(ADMIN);
        expect(mocked.auth).toHaveBeenCalledWith(request, 'superadmin');
    });
    it('keeps history and tasks visible when optional live context is unavailable', async () => {
        mocked.getOption.mockRejectedValue(new Error('offline'));
        const body = await (await GET(req())).json();
        expect(body.pricing_context).toBeNull();
        expect(body.publish_jobs).toEqual([SAVED_JOB]);
        expect(body.models).toHaveLength(1);
    });
});

describe('POST /api/admin/pricing publication contract', () => {
    it('refuses the old direct-save body instead of inserting an effective price', async () => {
        const response = await POST(req('POST', INPUT));
        expect(response.status).toBe(409);
        expect((await response.json()).error).toBe('pricing_preview_required');
        expect(mocked.preview).not.toHaveBeenCalled();
        expect(mocked.enqueue).not.toHaveBeenCalled();
    });
    it('preview invokes only the read-only service with parsed amounts', async () => {
        const request = req('POST', { action: 'preview', ...INPUT });
        const response = await POST(request);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ preview: PREVIEW });
        expect(mocked.preview).toHaveBeenCalledWith(INPUT, ADMIN);
        expect(mocked.enqueue).not.toHaveBeenCalled();
        expect(mocked.auth).toHaveBeenCalledWith(request, 'superadmin');
    });
    it('publish requires the reviewed token and returns 202 with a pending job', async () => {
        const response = await POST(req('POST', { action: 'publish', preview_token: TOKEN, ...INPUT }));
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ job: SAVED_JOB });
        expect(mocked.enqueue).toHaveBeenCalledWith(INPUT, TOKEN, ADMIN);
        expect(mocked.preview).not.toHaveBeenCalled();
    });
    it.each([undefined, ''])('cannot enqueue without a preview token: %j', async (preview_token) => {
        const response = await POST(req('POST', { action: 'publish', preview_token, ...INPUT }));
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe('pricing_preview_required');
        expect(mocked.enqueue).not.toHaveBeenCalled();
    });
    it.each([
        { model_id: 'bad-id' },
        { tier: ' ' },
        { input_cny_per_1m: 0 },
        { input_cny_per_1m: -1 },
        { output_cny_per_1m: null },
        { input_cny_per_1m: null },
        { input_cny_per_1m: '2.5' },
        { input_cny_per_1m: 1.12345 },
        { output_cny_per_1m: 100_000_000 },
        { cost_cny_per_1m: -1 },
        { cost_cny_per_1m: 0.12345 },
        { per_image_cny: 1.5 },
        { input_cny_per_1m: null, output_cny_per_1m: null, per_image_cny: null },
    ])('rejects incomplete, mixed or unsupported precision inputs: %j', async (change) => {
        const response = await POST(req('POST', { action: 'preview', ...INPUT, ...change }));
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe('invalid_input');
        expect(mocked.preview).not.toHaveBeenCalled();
        expect(mocked.enqueue).not.toHaveBeenCalled();
    });
    it('accepts four decimal places and a free output rate without coercing numbers', async () => {
        const change = { ...INPUT, input_cny_per_1m: 0.1234, output_cny_per_1m: 0, cost_cny_per_1m: 0 };
        expect((await POST(req('POST', { action: 'preview', ...change }))).status).toBe(200);
        expect(mocked.preview).toHaveBeenCalledWith(change, ADMIN);
    });
    it.each([0, 1.2345])('accepts standalone request price %s with token fields null', async (per_image_cny) => {
        const change = { ...INPUT, input_cny_per_1m: null, output_cny_per_1m: null, per_image_cny };
        expect((await POST(req('POST', { action: 'preview', ...change }))).status).toBe(200);
        expect(mocked.preview).toHaveBeenCalledWith(change, ADMIN);
    });
    it('returns a controlled response for invalid JSON', async () => {
        const response = await POST(
            new NextRequest('https://portal.test/api/admin/pricing', { method: 'POST', body: '{bad' }),
        );
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe('invalid_input');
    });
    it('preserves stale-preview errors without returning a queued job', async () => {
        mocked.enqueue.mockRejectedValue(new PricingPublishError('pricing_preview_stale', '价格已变化，请重新预览。'));
        const response = await POST(req('POST', { action: 'publish', preview_token: TOKEN, ...INPUT }));
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: 'pricing_preview_stale', message: '价格已变化，请重新预览。' });
    });
    it('redacts unknown upstream/database failures', async () => {
        mocked.preview.mockRejectedValue(new Error('mysql://admin:private-password@internal-host/api sk-private-key'));
        const response = await POST(req('POST', { action: 'preview', ...INPUT }));
        expect(response.status).toBe(503);
        const body = await response.text();
        expect(body).toContain('pricing_publish_unavailable');
        expect(body).not.toMatch(/private-password|internal-host|sk-private-key/);
    });
    it('makes missing persisted verification unavailable rather than allowing publication', async () => {
        mocked.preview.mockRejectedValue({
            code: 'persisted_pricing_not_configured',
            message: 'private connection string',
        });
        const response = await POST(req('POST', { action: 'preview', ...INPUT }));
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
            error: 'persisted_pricing_not_configured',
            message: expect.not.stringContaining('private connection string'),
        });
    });
});

describe('retired resync endpoint', () => {
    it('requires an explicit tier preview and never repeats an unreviewed shared-price write', async () => {
        const request = req('POST', undefined, `/api/admin/pricing/${MODEL_ID}/resync`);
        const response = await RESYNC(request);
        expect(response.status).toBe(409);
        expect((await response.json()).error).toBe('pricing_preview_required');
        expect(mocked.enqueue).not.toHaveBeenCalled();
        expect(mocked.preview).not.toHaveBeenCalled();
        expect(mocked.auth).toHaveBeenCalledWith(request, 'superadmin');
    });
});

describe('POST /api/admin/pricing/publish/[id]', () => {
    it.each(['retry', 'cancel'] as const)('passes %s and a validated ID to the scoped service', async (action) => {
        const response = await JOB(req('POST', { action }), params());
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ job: SAVED_JOB });
        expect(mocked.changeJob).toHaveBeenCalledWith(JOB_ID, action, ADMIN);
    });
    it('rejects invalid IDs before reading or changing tasks', async () => {
        const response = await JOB(req('POST', { action: 'retry' }), params('not-a-uuid'));
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe('invalid_id');
        expect(mocked.changeJob).not.toHaveBeenCalled();
    });
    it.each([{}, { action: 'publish' }, { action: false }])('rejects invalid task actions: %j', async (body) => {
        const response = await JOB(req('POST', body), params());
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe('invalid_input');
        expect(mocked.changeJob).not.toHaveBeenCalled();
    });
    it.each([
        ['pricing_job_not_found', '任务不存在。', 404],
        ['pricing_cancel_unsafe', '部分价格已写入，不能取消，请继续核验。', 409],
    ] as const)('maps %s without claiming cancellation or success', async (code, message, status) => {
        mocked.changeJob.mockRejectedValue(new PricingPublishError(code, message, status));
        const response = await JOB(req('POST', { action: 'cancel' }), params());
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual({ error: code, message });
    });
});
