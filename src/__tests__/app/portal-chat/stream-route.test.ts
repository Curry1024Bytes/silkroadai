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

// v2 web-search layer — mocked so we control whether injection happens.
const mockRunWebSearch = vi.fn();
vi.mock('@/lib/chat/web-search', () => ({
    runWebSearch: (...args: unknown[]) => mockRunWebSearch(...args),
}));

// Server-authoritative model→group resolver — mocked to control routing group.
const mockResolveModelGroup = vi.fn();
vi.mock('@/lib/chat/model-groups', () => ({
    resolveModelGroup: (...args: unknown[]) => mockResolveModelGroup(...args),
}));

import { POST } from '@/app/api/portal/chat/stream/route';

const USER = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };

beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue(USER);
    mockGetOrCreateSystemToken.mockResolvedValue('sk-test-123');
    mockRunWebSearch.mockResolvedValue(null); // default: web search off / unconfigured
    mockResolveModelGroup.mockResolvedValue('default'); // default: route via the primary group
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

    it('upstream stream dies mid-response → finish_reason:"error" tail + [DONE] (clean close, not a reset)', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const enc = new TextEncoder();
        spyFetch(() => {
            return new Response(
                new ReadableStream({
                    start(c) {
                        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"par"}}]}\n\n'));
                        c.error(new Error('ECONNRESET'));
                    },
                }),
                { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
            );
        });
        const res = await POST(makeReq(VALID_BODY));
        expect(res.status).toBe(200);
        const text = await res.text(); // 不 throw = guard 干净收流
        expect(text).toContain('par');
        expect(text).toContain('"finish_reason":"error"');
        expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
        warnSpy.mockRestore();
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

    // ── v2: multimodal content + web search ──────────────────────────────

    it('forwards multimodal content (text + image_url) verbatim to upstream', async () => {
        let sentBodyStr = '';
        spyFetch((_url, init) => {
            sentBodyStr = init.body || '';
            return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'a cat' } }] })]);
        });
        const body = {
            model: 'gpt-4o',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: '图里是什么' },
                        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAABBBB' } },
                    ],
                },
            ],
        };
        const res = await POST(makeReq(body));
        expect(res.status).toBe(200);
        const sent = JSON.parse(sentBodyStr);
        expect(Array.isArray(sent.messages[0].content)).toBe(true);
        expect(sent.messages[0].content[0]).toEqual({ type: 'text', text: '图里是什么' });
        expect(sent.messages[0].content[1].type).toBe('image_url');
        expect(sent.messages[0].content[1].image_url.url).toContain('data:image/png;base64');
    });

    it('web_search:true prepends a system message with the search context', async () => {
        mockRunWebSearch.mockResolvedValue('搜索结果:\n[1] 今日要闻\nURL: https://news.example');
        let sentBodyStr = '';
        spyFetch((_url, init) => {
            sentBodyStr = init.body || '';
            return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'x' } }] })]);
        });
        const res = await POST(
            makeReq({ model: 'gpt-5.5', messages: [{ role: 'user', content: '今天有什么新闻' }], web_search: true }),
        );
        expect(res.status).toBe(200);
        // extracted the latest user text as the query
        expect(mockRunWebSearch).toHaveBeenCalledWith('今天有什么新闻');
        const sent = JSON.parse(sentBodyStr);
        expect(sent.messages[0].role).toBe('system');
        expect(sent.messages[0].content).toContain('搜索结果');
        // original user message preserved after the injected context
        expect(sent.messages[1].role).toBe('user');
        expect(sent.messages[1].content).toBe('今天有什么新闻');
    });

    it('web_search:true is a no-op when the provider is unconfigured (returns null)', async () => {
        mockRunWebSearch.mockResolvedValue(null);
        let sentBodyStr = '';
        spyFetch((_url, init) => {
            sentBodyStr = init.body || '';
            return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'x' } }] })]);
        });
        const res = await POST(
            makeReq({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }], web_search: true }),
        );
        expect(res.status).toBe(200);
        const sent = JSON.parse(sentBodyStr);
        expect(sent.messages).toHaveLength(1);
        expect(sent.messages[0].role).toBe('user');
    });

    // ── per-group routing (Path B) ───────────────────────────────────────

    it('routes the model through its SERVER-resolved group token (official)', async () => {
        mockResolveModelGroup.mockResolvedValue('official');
        spyFetch(() => sseResponse([JSON.stringify({ choices: [{ delta: { content: 'x' } }] })]));
        const res = await POST(makeReq({ model: 'claude-fable-5', messages: [{ role: 'user', content: 'hi' }] }));
        expect(res.status).toBe(200);
        // group resolved from the model name (server-side, not client-supplied)
        expect(mockResolveModelGroup).toHaveBeenCalledWith('claude-fable-5');
        // …and the system token is requested for THAT group
        expect(mockGetOrCreateSystemToken).toHaveBeenCalledWith(USER.id, 'official');
    });

    it('default-group models resolve the primary token', async () => {
        mockResolveModelGroup.mockResolvedValue('default');
        spyFetch(() => sseResponse([JSON.stringify({ choices: [{ delta: { content: 'x' } }] })]));
        await POST(makeReq(VALID_BODY));
        expect(mockGetOrCreateSystemToken).toHaveBeenCalledWith(USER.id, 'default');
    });
});
