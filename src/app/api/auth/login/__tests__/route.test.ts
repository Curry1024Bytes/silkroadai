import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ── mocks ──

const mockUserFindUnique = vi.fn();
const mockUserUpdate = vi.fn();

vi.mock('@/lib/db', () => ({
    prisma: {
        user: {
            findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
            update: (...args: unknown[]) => mockUserUpdate(...args),
        },
    },
}));

const mockCompare = vi.fn();
vi.mock('bcryptjs', () => ({
    compare: (...args: unknown[]) => mockCompare(...args),
}));

// session.ts uses real signSession; .env from vitest setup provides
// PORTAL_JWT_SECRET so no need to mock.

import { POST } from '../route';

function makeReq(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

const PORTAL_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

beforeEach(() => {
    vi.clearAllMocks();
    // last_login_at update is fire-and-forget; default to resolving so the
    // promise doesn't dangle as unhandled rejection across tests.
    mockUserUpdate.mockResolvedValue({});
});

describe('POST /api/auth/login', () => {
    it('200 + cookie + apiKey when credentials match', async () => {
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            email: 'happy@silkroadai.io',
            password_hash: '$2a$12$realhashstoredinDB',
            nickname: 'Happy',
            email_verified: true,
            locale: 'zh-CN',
            status: 'active',
            newapi_user_id: 8,
            newapi_username: 'c-aaaaaaaa',
            keys: [
                {
                    id: 'kkkkkkkk-1111-4222-8333-444444444444',
                    newapi_token_value: 'sk-test-real-token-abc123',
                    status: 'active',
                },
            ],
        });
        mockCompare.mockResolvedValue(true);

        const res = await POST(
            makeReq({ email: 'Happy@SilkRoadAI.io', password: 'goodpass123' }),
        );
        const body = await res.json();

        expect(res.status).toBe(200);
        // findUnique called with normalized (lowercased + trimmed) email
        expect(mockUserFindUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { email: 'happy@silkroadai.io' } }),
        );
        expect(mockCompare).toHaveBeenCalledTimes(1);
        expect(mockCompare).toHaveBeenCalledWith('goodpass123', '$2a$12$realhashstoredinDB');

        // shape: { user, apiKey }
        expect(body.user.id).toBe(PORTAL_USER_ID);
        expect(body.user.email).toBe('happy@silkroadai.io');
        expect(body.user.newapi_user_id).toBe(8);
        expect(body.apiKey).toBe('sk-test-real-token-abc123');

        // session cookie set
        expect(res.headers.get('set-cookie')).toContain('silkroad_session=');

        // never leaks password_hash or anything secret
        const bodyStr = JSON.stringify(body);
        expect(bodyStr).not.toMatch(/password/);
        expect(bodyStr).not.toMatch(/access_token/);

        // last_login_at touched
        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: PORTAL_USER_ID },
                data: expect.objectContaining({ last_login_at: expect.any(Date) }),
            }),
        );
    });

    it('401 when password wrong (no Set-Cookie, no last_login_at update)', async () => {
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            email: 'wrongpass@silkroadai.io',
            password_hash: '$2a$12$realhashstoredinDB',
            status: 'active',
            keys: [],
        });
        mockCompare.mockResolvedValue(false);

        const res = await POST(
            makeReq({ email: 'wrongpass@silkroadai.io', password: 'badguess' }),
        );
        const body = await res.json();

        expect(res.status).toBe(401);
        expect(body.error).toBe('invalid_credentials');
        expect(mockCompare).toHaveBeenCalledTimes(1);
        expect(res.headers.get('set-cookie')).toBeNull();
        expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it('401 when email does not exist; bcrypt.compare still ran once (timing defense)', async () => {
        mockUserFindUnique.mockResolvedValue(null);
        mockCompare.mockResolvedValue(false);

        const res = await POST(
            makeReq({ email: 'ghost@silkroadai.io', password: 'whatever' }),
        );
        const body = await res.json();

        expect(res.status).toBe(401);
        expect(body.error).toBe('invalid_credentials');
        // critical: compare still ran exactly once even though user is null,
        // so attackers can't time-distinguish "user exists" from "user doesn't".
        expect(mockCompare).toHaveBeenCalledTimes(1);
        expect(res.headers.get('set-cookie')).toBeNull();
        expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it('401 when account is disabled (no Set-Cookie even with right password)', async () => {
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            email: 'banned@silkroadai.io',
            password_hash: '$2a$12$realhashstoredinDB',
            status: 'banned',
            keys: [],
        });
        mockCompare.mockResolvedValue(true); // password is right but account is banned

        const res = await POST(
            makeReq({ email: 'banned@silkroadai.io', password: 'rightpass' }),
        );
        const body = await res.json();

        expect(res.status).toBe(401);
        expect(body.error).toBe('invalid_credentials');
        expect(res.headers.get('set-cookie')).toBeNull();
        expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it('400 when body has malformed email', async () => {
        const res = await POST(
            makeReq({ email: 'not-an-email', password: 'goodpass123' }),
        );
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toBe('invalid_input');
        expect(body.issues.email).toBeDefined();
        expect(mockUserFindUnique).not.toHaveBeenCalled();
        expect(mockCompare).not.toHaveBeenCalled();
    });

    it('400 when body is non-JSON', async () => {
        const res = await POST(makeReq('not json'));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toBe('invalid_input');
        expect(mockUserFindUnique).not.toHaveBeenCalled();
    });
});
