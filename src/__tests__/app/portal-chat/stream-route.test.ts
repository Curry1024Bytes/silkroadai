/**
 * Chat UI v1 — POST /api/portal/chat/stream handler tests.
 *
 * Mocks: getCurrentUser, system-token, rate-limit, fetch (upstream
 * /v1/chat/completions). Asserts each branch the route owns: auth,
 * rate limit, validation, system-token failure, upstream error, and the
 * happy-path SSE passthrough.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
}));

const mockGetOrCreateSystemToken = vi.fn();
vi.mock('@/lib/newapi/system-token', () => {
    class PortalSystemTokenErrorMock extends Error {
        code: string;
        constructor(message: string, code: string) {
            super(message);
            this.code = code;
            this.name = 'PortalSystemTokenError';
        }
    }
    return {
        getOrCreateSystemToken: (...args: unknown[]) => mockGetOrCreateSystemToken(...args),
        PortalSystemTokenError: PortalSystemTokenErrorMock,
        PORTAL_INTERNAL_TOKEN_NAME: 'portal-internal',
    };
});

const { PortalSystemTokenError } = await import('@/lib/newapi/system-token');

vi.mock('@/lib/image-gen/rate-limit', () => ({
    rateLimitCheck: vi.fn(),
}));

import { rateLimitCheck } from '@/lib/image-gen/rate-limit';
import { POST } from '@/app/api/portal/chat/stream/route';

const USER = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };

beforeEach(() => {
    vi.clearAllMocks();
    (rateLimitCheck as ReturnType<typeof vi.fn>).mockReturnValue({ allowed: true, remaining: 19, retryAfterMs: 0 });
    mockGetCurrentUser.mockResolvedValue(USER);
    mockGetOrCreateSystemToken.mockResolvedValue('sk-test-123');
});

afterEach(() => vi.restoreAllMocks());

function makeReq(body: unknown): NextRequest {
    return new NextRequest('http://internal/api/portal/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

const VALID_BODY = { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] };

function spyFetch(handler: (url: string, init: { body?: string }) => Response | Promise<Response>) {
    return (vi.spyOn as unknown as (...args: unknown[]) => ReturnType<typeof vi.fn>)(
        globalThis,
        'fetch',
    ).mockImplementation(async (url: unknown, init: unknown) =>
        handler(String(url), (init ?? {}) as { body?: string }),
    );
}

/** Build a streaming SSE Response like new-api emits. */
function sseResponse(events: string[], status = 200): Response {
    const body = events.map((e) => `data: ${e}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(body, {
        status,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    });
}

describe('POST /api/portal/chat/stream', () => {
    it('401 when unauthenticated', async () => {
        mockGetCurrentUser.mockResolvedValue(null);
        const res = await POST(makeReq(VALID_BODY));
        expect(res.status).toBe(401);
    });

    it('429 when rate limited', async () => {
        (rateLimitCheck as ReturnType<typeof vi.fn>).mockReturnValue({
            allowed: false,
            remaining: 0,
            retryAfterMs: 3000,
        });
        const res = await POST(makeReq(VALID_BODY));
        expect(res.status).toBe(429);
        expect(res.headers.get('Retry-After')).toBe('3');
    });

    it('400 on invalid body (missing model)', async () => {
        const res = await POST(makeReq({ messages: [{ role: 'user', content: 'hi' }] }));
        expect(res.status).toBe(400);
    });

    it('400 on empty messages array', async () => {
        const res = await POST(makeReq({ model: 'gpt-5.5', messages: [] }));
        expect(res.status).toBe(400);
    });

    it('400 on non-JSON body', async () => {
        const res = await POST(makeReq('not-json{'));
        expect(res.status).toBe(400);
    });

    it('503 when system token transiently unavailable', async () => {
        mockGetOrCreateSystemToken.mockRejectedValue(new PortalSystemTokenError('boom', 'newapi_create_failed'));
        const res = await POST(makeReq(VALID_BODY));
        expect(res.status).toBe(503);
    });

    it('500 when user not provisioned', async () => {
        mockGetOrCreateSystemToken.mockRejectedValue(new PortalSystemTokenError('no linkage', 'user_not_provisioned'));
        const res = await POST(makeReq(VALID_BODY));
        expect(res.status).toBe(500);
    });

    it('passes through the streamed SSE body on success', async () => {
        spyFetch((url, init) => {
            expect(url).toContain('/v1/chat/completions');
            const sent = JSON.parse(init.body || '{}');
            expect(sent.stream).toBe(true);
            expect(sent.model).toBe('gpt-5.5');
            return sseResponse([
                JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
                JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
            ]);
        });
        const res = await POST(makeReq(VALID_BODY));
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toContain('text/event-stream');
        const text = await res.text();
        expect(text).toContain('Hel');
        expect(text).toContain('[DONE]');
    });

    it('forwards the system token as a Bearer header', async () => {
        let seenAuth: string | undefined;
        spyFetch((_url, init) => {
            seenAuth = ((init as unknown as { headers?: Record<string, string> }).headers || {})['Authorization'];
            return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'x' } }] })]);
        });
        await POST(makeReq(VALID_BODY));
        expect(seenAuth).toBe('Bearer sk-test-123');
    });

    it('502 on upstream 5xx', async () => {
        spyFetch(() => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 }));
        const res = await POST(makeReq(VALID_BODY));
        expect(res.status).toBe(502);
    });

    it('passes through upstream 4xx status (e.g. 402 quota)', async () => {
        spyFetch(
            () =>
                new Response(JSON.stringify({ error: { message: 'insufficient_user_quota' } }), {
                    status: 402,
                    headers: { 'Content-Type': 'application/json' },
                }),
        );
        const res = await POST(makeReq(VALID_BODY));
        expect(res.status).toBe(402);
    });

    it('502 when fetch throws (transport error)', async () => {
        spyFetch(() => {
            throw new Error('ECONNREFUSED');
        });
        const res = await POST(makeReq(VALID_BODY));
        expect(res.status).toBe(502);
    });
});
