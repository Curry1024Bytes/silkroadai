import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({ identity: vi.fn(), bindings: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: { customerPricingBinding: { findMany: m.bindings } } }));
vi.mock('../identity', () => ({ resolveCustomerPricingTokenIdentity: m.identity }));

import { rejectUnsupportedCustomerPricingRequest } from '../request-guard';

const request = (path = '/v1/chat/completions', headers: Record<string, string> = {}) =>
    new NextRequest(`https://api.example.com${path}`, {
        method: 'POST',
        headers: { authorization: 'Bearer sk-test-key', ...headers },
    });

describe('customer pricing request verification', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        m.identity.mockResolvedValue({ tokenId: 1, userId: 'customer', tierKey: 'standard', source: 'customer_key' });
        m.bindings.mockResolvedValue([{ status: 'active' }]);
    });

    it.each(['applying', 'failed', 'restoring', 'unknown'])(
        'rejects ordinary consumption while the binding is %s',
        async (status) => {
            m.bindings.mockResolvedValue([{ status }]);
            const result = await rejectUnsupportedCustomerPricingRequest(request());
            expect(result?.status).toBe(503);
            expect(await result?.json()).toMatchObject({
                error: { code: 'customer_pricing_verification_unavailable' },
            });
            expect(m.bindings).toHaveBeenCalledWith({
                where: { user_id: 'customer', tier_key: 'standard' },
                select: { status: true },
                take: 2,
            });
        },
    );

    it('allows normal consumption for a verified binding', async () => {
        expect(await rejectUnsupportedCustomerPricingRequest(request())).toBeNull();
    });

    it('allows ordinary customers with no pricing binding', async () => {
        m.bindings.mockResolvedValue([]);
        expect(await rejectUnsupportedCustomerPricingRequest(request())).toBeNull();
    });

    it('does not read pricing bindings for unrecognized keys', async () => {
        m.identity.mockResolvedValue(null);
        expect(await rejectUnsupportedCustomerPricingRequest(request())).toBeNull();
        expect(m.bindings).not.toHaveBeenCalled();
    });

    it('rejects ambiguous bindings and verification failures for ordinary requests', async () => {
        m.bindings.mockResolvedValue([{ status: 'active' }, { status: 'active' }]);
        expect((await rejectUnsupportedCustomerPricingRequest(request()))?.status).toBe(503);
        m.identity.mockRejectedValue(new Error('database unavailable'));
        expect((await rejectUnsupportedCustomerPricingRequest(request()))?.status).toBe(503);
    });

    it.each([
        { path: '/v1/chat/completions', auth: 'Bearer sk-test.123-13', body: undefined },
        { path: '/v1/videos/task-1/remix', auth: 'Bearer sk-test', body: undefined },
        { path: '/v1/videos', auth: 'Bearer sk-test', body: { content: [{ type: 'draft_task', id: 'task-1' }] } },
    ])('still rejects native pinned operations for verified customers: $path', async ({ path, auth, body }) => {
        const result = await rejectUnsupportedCustomerPricingRequest(request(path, { authorization: auth }), body);
        expect(result?.status).toBe(400);
        expect(await result?.json()).toMatchObject({
            error: { code: 'customer_pricing_pinned_request_unsupported' },
        });
    });

    it('keeps task polling available while a publication is unverified', async () => {
        const result = await rejectUnsupportedCustomerPricingRequest(
            new NextRequest('https://api.example.com/v1/videos/task-1', {
                headers: { authorization: 'Bearer sk-test' },
            }),
        );
        expect(result).toBeNull();
        expect(m.identity).not.toHaveBeenCalled();
    });

    it('resolves the actual Anthropic and Gemini credentials before verification', async () => {
        await rejectUnsupportedCustomerPricingRequest(request('/v1/messages', { 'x-api-key': 'sk-anthropic' }));
        expect(m.identity).toHaveBeenLastCalledWith('anthropic');
        await rejectUnsupportedCustomerPricingRequest(request('/v1beta/models/gemini:generateContent?key=sk-google'));
        expect(m.identity).toHaveBeenLastCalledWith('google');
    });
});
