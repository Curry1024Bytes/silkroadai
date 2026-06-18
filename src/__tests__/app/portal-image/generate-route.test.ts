/**
 * PR-T1 Phase 3a — POST /api/portal/image/generate handler tests.
 *
 * Mocks: prisma, getCurrentUser, system-token, R2 client, fetch (for
 * the upstream new-api call). Asserts on each branch the route owns.
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

// Re-import the mocked class for typed throw in tests below.
const { PortalSystemTokenError: _PortalSystemTokenError } = await import('@/lib/newapi/system-token');

const mockUploadImage = vi.fn();
const mockGetPublicUrl = vi.fn((key: string) => `https://r2-stub/${key}`);
const mockImageKey = vi.fn((u: string, g: string, i: number) => `image-gen/${u}/${g}/${i}.png`);
vi.mock('@/lib/r2/client', () => ({
    uploadImage: (...args: unknown[]) => mockUploadImage(...args),
    getPublicUrl: (key: string) => mockGetPublicUrl(key),
    imageKey: (u: string, g: string, i: number) => mockImageKey(u, g, i),
    deleteImages: vi.fn(),
}));

const mockImgGenCreate = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        imageGeneration: {
            create: (...args: unknown[]) => mockImgGenCreate(...args),
        },
    },
}));

vi.mock('@sentry/nextjs', () => ({
    captureException: vi.fn(),
}));

import { POST } from '@/app/api/portal/image/generate/route';

const USER = {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    newapi_user_id: 99,
    newapi_access_token: 'access-stub',
};

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    vi.restoreAllMocks();
});

function makeReq(body: unknown): NextRequest {
    return new NextRequest('http://internal/api/portal/image/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

const VALID_BODY = {
    prompt: 'a cat sitting on a chair',
    model: 'gpt-image-2',
    count: 1,
    size: '1024x1024',
};

/** Spy on globalThis.fetch with a URL-aware handler. afterEach's
 *  restoreAllMocks also cleans up so a failed assertion before an explicit
 *  mockRestore won't leak the spy into the next test. */
function spyFetch(handler: (url: string, init: { body?: string }) => Response | Promise<Response>) {
    return (vi.spyOn as unknown as (...args: unknown[]) => ReturnType<typeof vi.fn>)(
        globalThis,
        'fetch',
    ).mockImplementation(async (url: unknown, init: unknown) =>
        handler(String(url), (init ?? {}) as { body?: string }),
    );
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The /v1/chat/completions wrong-endpoint signal that makes the dispatch
 *  fall back to /v1/images/generations (W8 D7 smart fallback). Non-Gemini
 *  image SKUs (gpt-image-2, Imagen) take this fallback in production —
 *  these mocks must replay it or the chat-first dispatch returns an empty
 *  body and the route 400s before reaching images/generations. */
function wrongEndpointChat(): Response {
    return jsonResponse(
        {
            error: {
                code: 'convert_request_failed',
                message: 'not supported model for image generation, only imagen models are supported',
            },
        },
        400,
    );
}

describe('POST /api/portal/image/generate — auth', () => {
    it('401 when no session', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(null);
        const res = await POST(makeReq(VALID_BODY));
        expect(res.status).toBe(401);
    });
});

describe('POST /api/portal/image/generate — input validation', () => {
    it('400 on empty prompt', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        const res = await POST(makeReq({ ...VALID_BODY, prompt: '' }));
        expect(res.status).toBe(400);
    });

    it('400 on prompt > 1000 chars', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        const res = await POST(makeReq({ ...VALID_BODY, prompt: 'x'.repeat(1001) }));
        expect(res.status).toBe(400);
    });

    it('400 on unknown model', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        const res = await POST(makeReq({ ...VALID_BODY, model: 'not-a-model' }));
        expect(res.status).toBe(400);
    });

    it('400 on count > 4', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        const res = await POST(makeReq({ ...VALID_BODY, count: 5 }));
        expect(res.status).toBe(400);
    });

    it('400 on invalid size', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        const res = await POST(makeReq({ ...VALID_BODY, size: '512x512' }));
        expect(res.status).toBe(400);
    });
});

describe('POST /api/portal/image/generate — system token failure', () => {
    it('503 on transient newapi failures', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockGetOrCreateSystemToken.mockRejectedValueOnce(
            new _PortalSystemTokenError('newapi 502', 'newapi_create_failed'),
        );
        const res = await POST(makeReq(VALID_BODY));
        expect(res.status).toBe(503);
    });

    it('500 on user_not_provisioned (account never finished onboarding)', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockGetOrCreateSystemToken.mockRejectedValueOnce(
            new _PortalSystemTokenError('no linkage', 'user_not_provisioned'),
        );
        const res = await POST(makeReq(VALID_BODY));
        expect(res.status).toBe(500);
    });
});

describe('POST /api/portal/image/generate — happy path', () => {
    it('writes ImageGeneration row + returns image_urls + cost', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockGetOrCreateSystemToken.mockResolvedValueOnce('sk-system-token');

        // gpt-image-2 (imagesApiOnly, 2026-06-15): straight to images/generations
        // (URL payload) → fetch the image binary. No chat probe.
        const fetchSpy = spyFetch((url) => {
            if (url.includes('/v1/images/generations'))
                return jsonResponse({ data: [{ url: 'https://upstream/img1.png' }] });
            return new Response(Buffer.from('fake-png-bytes'), {
                status: 200,
                headers: { 'Content-Type': 'image/png' },
            });
        });

        mockUploadImage.mockResolvedValue('uploaded');
        mockImgGenCreate.mockResolvedValueOnce({
            id: 'gen-id',
            created_at: new Date('2026-05-09T12:00:00Z'),
            expires_at: new Date('2026-06-08T12:00:00Z'),
        });

        const res = await POST(makeReq(VALID_BODY));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.id).toBe('gen-id');
        expect(body.image_urls).toHaveLength(1);
        expect(body.cost_usd).toBeCloseTo(0.00714, 6); // gpt-image-2 ModelPrice ¥0.05 (2026-06-15 ch36)
        // gpt-image-2 pins the image2 routing group (→ ch36)
        expect(mockGetOrCreateSystemToken).toHaveBeenCalledWith(USER.id, 'image2');
        expect(mockImgGenCreate).toHaveBeenCalledTimes(1);
        const createArgs = mockImgGenCreate.mock.calls[0][0];
        expect(createArgs.data.user_id).toBe(USER.id);
        expect(createArgs.data.is_favorite).toBe(false);
        expect(createArgs.data.is_deleted).toBe(false);
        // r2_keys field is the array of R2 keys (not URLs)
        expect(createArgs.data.r2_keys).toHaveLength(1);

        fetchSpy.mockRestore();
    });

    it('handles b64_json (gpt-image-2 path) without an image fetch', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockGetOrCreateSystemToken.mockResolvedValueOnce('sk-system-token');

        // imagesApiOnly → images/generations returns b64_json inline (no chat
        // probe, no second binary fetch needed).
        const fetchSpy = spyFetch((url) => {
            if (url.includes('/v1/chat/completions')) return wrongEndpointChat();
            return jsonResponse({ data: [{ b64_json: Buffer.from('fake-png').toString('base64') }] });
        });

        mockUploadImage.mockResolvedValueOnce('uploaded');
        mockImgGenCreate.mockResolvedValueOnce({
            id: 'gen-id-2',
            created_at: new Date(),
            expires_at: new Date(),
        });

        const res = await POST(makeReq(VALID_BODY));
        expect(res.status).toBe(200);
        // gpt-image-2 skips chat → exactly ONE upstream call (images/generations,
        // b64 inline), and NO binary fetch.
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(mockUploadImage).toHaveBeenCalledTimes(1);

        fetchSpy.mockRestore();
    });
});

describe('POST /api/portal/image/generate — upstream failure modes', () => {
    function makeOkResponse(body: unknown, status = 200) {
        return new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    it('passes through 402 insufficient_user_quota with friendly message', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockGetOrCreateSystemToken.mockResolvedValueOnce('sk-token');

        const upstream = makeOkResponse({ error: { code: 'insufficient_user_quota', message: 'low' } }, 403);
        const fetchSpy = (vi.spyOn as unknown as (...args: unknown[]) => ReturnType<typeof vi.fn>)(
            globalThis,
            'fetch',
        ).mockResolvedValue(upstream);

        const res = await POST(makeReq(VALID_BODY));
        expect(res.status).toBe(402);
        const body = await res.json();
        expect(body.error).toBe('insufficient_user_quota');

        fetchSpy.mockRestore();
    });

    it('502 on upstream non-2xx with no quota error code (5xx tier)', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockGetOrCreateSystemToken.mockResolvedValueOnce('sk-token');

        const upstream = makeOkResponse({ error: { message: 'upstream 500' } }, 500);
        const fetchSpy = (vi.spyOn as unknown as (...args: unknown[]) => ReturnType<typeof vi.fn>)(
            globalThis,
            'fetch',
        ).mockResolvedValue(upstream);

        const res = await POST(makeReq(VALID_BODY));
        expect(res.status).toBe(502);

        fetchSpy.mockRestore();
    });

    it('400 content_filter when upstream returns empty data array (PR-T3 — was 502 pre-T3)', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockGetOrCreateSystemToken.mockResolvedValueOnce('sk-token');

        const upstream = makeOkResponse({ data: [] });
        const fetchSpy = (vi.spyOn as unknown as (...args: unknown[]) => ReturnType<typeof vi.fn>)(
            globalThis,
            'fetch',
        ).mockResolvedValue(upstream);

        const res = await POST(makeReq(VALID_BODY));
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe('content_filter');
        expect(body.quota_charged).toBe(false);

        fetchSpy.mockRestore();
    });

    it('400 content_filter when upstream code is content_policy_violation (PR-T3)', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockGetOrCreateSystemToken.mockResolvedValueOnce('sk-token');

        const upstream = makeOkResponse(
            { error: { code: 'content_policy_violation', message: 'NSFW prompt rejected' } },
            400,
        );
        const fetchSpy = (vi.spyOn as unknown as (...args: unknown[]) => ReturnType<typeof vi.fn>)(
            globalThis,
            'fetch',
        ).mockResolvedValue(upstream);

        const res = await POST(makeReq(VALID_BODY));
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe('content_filter');

        fetchSpy.mockRestore();
    });

    it('400 content_filter when upstream message contains NSFW/safety keyword (PR-T3 message regex)', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockGetOrCreateSystemToken.mockResolvedValueOnce('sk-token');

        // No matching code, but message has the safety keyword → still detected.
        const upstream = makeOkResponse(
            { error: { code: 'unknown_filter', message: 'Generation blocked by safety filter' } },
            400,
        );
        const fetchSpy = (vi.spyOn as unknown as (...args: unknown[]) => ReturnType<typeof vi.fn>)(
            globalThis,
            'fetch',
        ).mockResolvedValue(upstream);

        const res = await POST(makeReq(VALID_BODY));
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe('content_filter');

        fetchSpy.mockRestore();
    });

    it('500 on R2 upload failure (DB row NOT written)', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockGetOrCreateSystemToken.mockResolvedValueOnce('sk-token');

        const fetchSpy = spyFetch((url) => {
            if (url.includes('/v1/chat/completions')) return wrongEndpointChat();
            return jsonResponse({ data: [{ b64_json: 'YWFh' }] });
        });

        mockUploadImage.mockRejectedValueOnce(new Error('R2 down'));

        const res = await POST(makeReq(VALID_BODY));
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toBe('r2_upload_failed');
        expect(mockImgGenCreate).not.toHaveBeenCalled();

        fetchSpy.mockRestore();
    });
});

describe('POST /api/portal/image/generate — native Gemini resolution path (W8 D8)', () => {
    function makeNativeResponse(
        parts: Array<{ inlineData?: { data?: string }; inline_data?: { data?: string } }>,
        status = 200,
    ) {
        return new Response(JSON.stringify({ candidates: [{ content: { parts } }] }), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    it('routes the 2K SKU to native /v1beta generateContent with imageConfig.imageSize=2K', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockGetOrCreateSystemToken.mockResolvedValueOnce('sk-system-token');

        let calledUrl = '';
        let sentBody: Record<string, unknown> = {};
        const fetchSpy = spyFetch((url, init) => {
            calledUrl = url;
            sentBody = JSON.parse(init.body ?? '{}');
            return makeNativeResponse([{ inlineData: { data: Buffer.from('fake-2k-png').toString('base64') } }]);
        });
        mockUploadImage.mockResolvedValueOnce('uploaded');
        mockImgGenCreate.mockResolvedValueOnce({ id: 'gen-2k', created_at: new Date(), expires_at: new Date() });

        const res = await POST(
            makeReq({ prompt: 'a calico cat', model: 'gemini-3.1-flash-image-preview', count: 1, size: '1024x1024' }),
        );

        expect(res.status).toBe(200);
        expect(calledUrl).toContain('/v1beta/models/gemini-3.1-flash-image-preview:generateContent');
        const gc = (sentBody.generationConfig ?? {}) as { imageConfig?: { imageSize?: string; aspectRatio?: string } };
        expect(gc.imageConfig?.imageSize).toBe('2K');
        expect(gc.imageConfig?.aspectRatio).toBe('1:1');
        // inlineData base64 is decoded directly → only the one upstream call, no binary fetch
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(mockUploadImage).toHaveBeenCalledTimes(1);

        fetchSpy.mockRestore();
    });

    it('routes the 4K SKU with imageSize=4K, maps landscape size, and reads snake_case inline_data', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockGetOrCreateSystemToken.mockResolvedValueOnce('sk-system-token');

        let calledUrl = '';
        let sentBody: Record<string, unknown> = {};
        const fetchSpy = spyFetch((url, init) => {
            calledUrl = url;
            sentBody = JSON.parse(init.body ?? '{}');
            // snake_case variant — defensive parser must still find it
            return makeNativeResponse([{ inline_data: { data: Buffer.from('fake-4k').toString('base64') } }]);
        });
        mockUploadImage.mockResolvedValueOnce('uploaded');
        mockImgGenCreate.mockResolvedValueOnce({ id: 'gen-4k', created_at: new Date(), expires_at: new Date() });

        const res = await POST(
            makeReq({ prompt: 'a landscape', model: 'gemini-3-pro-image-preview', count: 1, size: '1792x1024' }),
        );

        expect(res.status).toBe(200);
        expect(calledUrl).toContain('/v1beta/models/gemini-3-pro-image-preview:generateContent');
        const gc = (sentBody.generationConfig ?? {}) as { imageConfig?: { imageSize?: string; aspectRatio?: string } };
        expect(gc.imageConfig?.imageSize).toBe('4K');
        expect(gc.imageConfig?.aspectRatio).toBe('16:9');
        expect(mockUploadImage).toHaveBeenCalledTimes(1);

        fetchSpy.mockRestore();
    });

    it('gpt-image-2 goes straight to images/generations — no native endpoint, no chat probe (imagesApiOnly, 2026-06-15)', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockGetOrCreateSystemToken.mockResolvedValueOnce('sk-token');

        const urls: string[] = [];
        const fetchSpy = spyFetch((url) => {
            urls.push(url);
            if (url.includes('/v1/chat/completions')) return wrongEndpointChat();
            return jsonResponse({ data: [{ b64_json: Buffer.from('x').toString('base64') }] });
        });
        mockUploadImage.mockResolvedValueOnce('uploaded');
        mockImgGenCreate.mockResolvedValueOnce({ id: 'gen-gpt', created_at: new Date(), expires_at: new Date() });

        const res = await POST(makeReq({ ...VALID_BODY, model: 'gpt-image-2' }));

        expect(res.status).toBe(200);
        // gpt-image-2 has no geminiImageSize → never the native endpoint;
        // imagesApiOnly → never the chat probe (czeq 200s with polite text there).
        expect(urls.some((u) => u.includes(':generateContent'))).toBe(false);
        expect(urls.some((u) => u.includes('/v1/chat/completions'))).toBe(false);
        expect(urls.some((u) => u.includes('/v1/images/generations'))).toBe(true);

        fetchSpy.mockRestore();
    });

    it('non-imagesApiOnly SKU (imagen) keeps the chat→wrong-endpoint→images/generations fallback + default group', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockGetOrCreateSystemToken.mockResolvedValueOnce('sk-token');

        const urls: string[] = [];
        const fetchSpy = spyFetch((url) => {
            urls.push(url);
            if (url.includes('/v1/chat/completions')) return wrongEndpointChat();
            return jsonResponse({ data: [{ b64_json: Buffer.from('x').toString('base64') }] });
        });
        mockUploadImage.mockResolvedValueOnce('uploaded');
        mockImgGenCreate.mockResolvedValueOnce({ id: 'gen-imagen', created_at: new Date(), expires_at: new Date() });

        const res = await POST(makeReq({ ...VALID_BODY, model: 'imagen-4.0-ultra-generate-001' }));

        expect(res.status).toBe(200);
        // imagen declares neither imagesApiOnly nor a group → still probes chat
        // first, falls back on the wrong-endpoint signal, and uses the default
        // (undefined → primary) system token.
        expect(urls.some((u) => u.includes('/v1/chat/completions'))).toBe(true);
        expect(urls.some((u) => u.includes('/v1/images/generations'))).toBe(true);
        expect(mockGetOrCreateSystemToken).toHaveBeenCalledWith(USER.id, undefined);

        fetchSpy.mockRestore();
    });

    it('empty candidates (Gemini safety block, 200 + no inlineData) → 400 content_filter', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockGetOrCreateSystemToken.mockResolvedValueOnce('sk-token');

        const fetchSpy = spyFetch(() => makeNativeResponse([]));

        const res = await POST(
            makeReq({ prompt: 'blocked', model: 'gemini-3.1-flash-image-preview', count: 1, size: '1024x1024' }),
        );

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe('content_filter');
        expect(mockImgGenCreate).not.toHaveBeenCalled();

        fetchSpy.mockRestore();
    });

    it('native upstream 402-class quota error passes through as 402', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockGetOrCreateSystemToken.mockResolvedValueOnce('sk-token');

        const fetchSpy = spyFetch(
            () =>
                new Response(JSON.stringify({ error: { code: 'insufficient_user_quota', message: 'low' } }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json' },
                }),
        );

        const res = await POST(
            makeReq({ prompt: 'x', model: 'gemini-3-pro-image-preview', count: 1, size: '1024x1024' }),
        );

        expect(res.status).toBe(402);
        const body = await res.json();
        expect(body.error).toBe('insufficient_user_quota');

        fetchSpy.mockRestore();
    });
});
