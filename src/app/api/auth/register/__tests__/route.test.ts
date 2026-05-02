import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ── mocks ──

const mockUserFindUnique = vi.fn();
const mockUserCreate = vi.fn();
const mockUserUpdate = vi.fn();
const mockUserDelete = vi.fn();
const mockKeyCreate = vi.fn();
const mockTransaction = vi.fn();

vi.mock('@/lib/db', () => ({
    prisma: {
        user: {
            findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
            create: (...args: unknown[]) => mockUserCreate(...args),
            update: (...args: unknown[]) => mockUserUpdate(...args),
            delete: (...args: unknown[]) => mockUserDelete(...args),
        },
        liteLLMKey: {
            create: (...args: unknown[]) => mockKeyCreate(...args),
        },
        $transaction: (...args: unknown[]) => mockTransaction(...args),
    },
}));

const mockProvision = vi.fn();
vi.mock('@/lib/litellm/client', () => ({
    provisionNewCustomer: (...args: unknown[]) => mockProvision(...args),
}));

// session.ts is the only piece that touches PORTAL_JWT_SECRET; .env loaded by
// vitest setup makes the real signSession work, so we don't need to mock it.

import { POST } from '../route';

function makeReq(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

const PORTAL_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

beforeEach(() => {
    vi.clearAllMocks();
    mockTransaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
});

describe('POST /api/auth/register', () => {
    it('happy path: creates user, provisions LiteLLM, returns token', async () => {
        mockUserFindUnique.mockResolvedValue(null);
        mockUserCreate.mockResolvedValue({
            id: PORTAL_USER_ID,
            email: 'happy@silkroadai.io',
            nickname: 'Happy',
            email_verified: false,
            locale: 'zh-CN',
            status: 'active',
            created_at: new Date('2026-05-02T00:00:00Z'),
        });
        mockProvision.mockResolvedValue({
            litellm_user_id: 'litellm-user-1',
            litellm_key: 'sk-test-abc123def456',
            key_alias: 'default-aaaaaaaa',
        });

        const res = await POST(makeReq({ email: 'Happy@SilkRoadAI.io', password: 'goodpass123', nickname: 'Happy' }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.user_id).toBe(PORTAL_USER_ID);
        expect(body.token).toMatch(/^eyJ/);
        expect(body.portal_user.email).toBe('happy@silkroadai.io');

        // email lowercased on store
        expect(mockUserCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ email: 'happy@silkroadai.io' }),
            }),
        );
        // never returns password_hash
        expect(JSON.stringify(body)).not.toMatch(/password/);

        // session cookie set
        const setCookie = res.headers.get('set-cookie');
        expect(setCookie).toContain('silkroad_session=');

        // linkage persisted via $transaction
        expect(mockTransaction).toHaveBeenCalledTimes(1);
    });

    it('returns 409 when email already registered', async () => {
        mockUserFindUnique.mockResolvedValue({ id: 'existing' });

        const res = await POST(makeReq({ email: 'taken@silkroadai.io', password: 'goodpass123' }));
        const body = await res.json();

        expect(res.status).toBe(409);
        expect(body.error).toBe('email_already_registered');
        expect(mockUserCreate).not.toHaveBeenCalled();
        expect(mockProvision).not.toHaveBeenCalled();
    });

    it('returns 400 when password is too short', async () => {
        const res = await POST(makeReq({ email: 'short@silkroadai.io', password: 'tiny' }));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toBe('validation_failed');
        expect(body.issues.password).toBeDefined();
        expect(mockUserFindUnique).not.toHaveBeenCalled();
    });

    it('returns 400 for malformed email', async () => {
        const res = await POST(makeReq({ email: 'not-an-email', password: 'goodpass123' }));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.issues.email).toBeDefined();
    });

    it('returns 400 for non-JSON body', async () => {
        const res = await POST(makeReq('not json'));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toBe('Invalid JSON body');
    });

    it('rolls back portal user when LiteLLM provision fails', async () => {
        mockUserFindUnique.mockResolvedValue(null);
        mockUserCreate.mockResolvedValue({
            id: PORTAL_USER_ID,
            email: 'rollback@silkroadai.io',
            nickname: null,
            email_verified: false,
            locale: 'zh-CN',
            status: 'active',
            created_at: new Date(),
        });
        mockProvision.mockRejectedValue(new Error('LiteLLM 502 — upstream timeout'));
        mockUserDelete.mockResolvedValue({ id: PORTAL_USER_ID });

        // suppress expected error log
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const res = await POST(makeReq({ email: 'rollback@silkroadai.io', password: 'goodpass123' }));
        const body = await res.json();

        expect(res.status).toBe(502);
        expect(body.error).toBe('provisioning_failed');
        expect(mockUserDelete).toHaveBeenCalledWith({ where: { id: PORTAL_USER_ID } });
        expect(mockTransaction).not.toHaveBeenCalled();

        errSpy.mockRestore();
    });
});
