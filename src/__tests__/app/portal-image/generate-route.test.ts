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

vi.mock('@/lib/image-gen/rate-limit', () => ({
    rateLimitCheck: vi.fn(),
    _resetRateLimitForTest: vi.fn(),
}));

import { rateLimitCheck } from '@/lib/image-gen/rate-limit';
import { POST } from '@/app/api/portal/image/generate/route';

const USER = {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    newapi_user_id: 99,
    newapi_access_token: 'access-stub',
};

beforeEach(() => {
    vi.clearAllMocks();
    (rateLimitCheck as ReturnType<typeof vi.fn>).mockReturnValue({ allowed: true, remaining: 9, retryAfterMs: 0 });
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

describe('POST /api/portal/image/generate — auth', () => {
    it('401 when no session', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(null);
        const res = await POST(makeReq(VALID_BODY));
        expect(res.status).toBe(401);
    });
});

describe('POST /api/portal/image/generate — rate limit', () => {
    it('429 with Retry-After header when bucket full', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        (rateLimitCheck as ReturnType<typeof vi.fn>).mockReturnValueOnce({
            allowed: false,
            remaining: 0,
            retryAfterMs: 30000,
        });
        const res = await POST(makeReq(VALID_BODY));
        expect(res.status).toBe(429);
        expect(res.headers.get('Retry-After')).toBe('30');
        const body = await res.json();
        expect(body.error).toBe('rate_limit_exceeded');
        expect(body.retry_after_ms).toBe(30000);
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
    function makeOkResponse(body: unknown, status = 200) {
        return new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    it('writes ImageGeneration row + returns image_urls + cost', async () => {
        mockGetCurrentUser.mockResolvedValueOnce(USER);
        mockGetOrCreateSystemToken.mockResolvedValueOnce('sk-system-token');

        // First fetch = upstream new-api response with 1 image URL
        const upstream = makeOkResponse({
            data: [{ url: 'https://upstream/img1.png' }],
        });
        // Second fetch = the upstream image binary
        const imgFetch = new Response(Buffer.from('fake-png-bytes'), {
            status: 200,
            headers: { 'Content-Type': 'image/png' },
        });

        const fetchSpy = (vi.spyOn as unknown as (...args: unknown[]) => ReturnType<typeof vi.fn>)(
            globalThis,
            'fetch',
        ).mockImplementation(async (url: unknown) => {
            const u = String(url);
            if (u.includes('/v1/images/generations')) return upstream;
            return imgFetch;
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
        expect(body.cost_usd).toBeCloseTo(0.04, 6); // gpt-image-2 ModelPrice (PR #55: 0% markup)
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

        const upstream = makeOkResponse({
            data: [{ b64_json: Buffer.from('fake-png').toString('base64') }],
        });

        const fetchSpy = (vi.spyOn as unknown as (...args: unknown[]) => ReturnType<typeof vi.fn>)(
            globalThis,
            'fetch',
        ).mockResolvedValue(upstream);

        mockUploadImage.mockResolvedValueOnce('uploaded');
        mockImgGenCreate.mockResolvedValueOnce({
            id: 'gen-id-2',
            created_at: new Date(),
            expires_at: new Date(),
        });

        const res = await POST(makeReq(VALID_BODY));
        expect(res.status).toBe(200);
        // Only the upstream call — no second fetch for image binary
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

        const upstream = makeOkResponse({
            data: [{ b64_json: 'YWFh' }],
        });
        const fetchSpy = (vi.spyOn as unknown as (...args: unknown[]) => ReturnType<typeof vi.fn>)(
            globalThis,
            'fetch',
        ).mockResolvedValue(upstream);

        mockUploadImage.mockRejectedValueOnce(new Error('R2 down'));

        const res = await POST(makeReq(VALID_BODY));
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toBe('r2_upload_failed');
        expect(mockImgGenCreate).not.toHaveBeenCalled();

        fetchSpy.mockRestore();
    });
});
