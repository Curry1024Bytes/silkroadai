import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ── mocks ──

const mockUserFindUnique = vi.fn();
const mockUserCreate = vi.fn();
const mockUserUpdate = vi.fn();
const mockUserDelete = vi.fn();
const mockTokenCreate = vi.fn();
const mockTransaction = vi.fn();

vi.mock('@/lib/db', () => ({
    prisma: {
        user: {
            findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
            create: (...args: unknown[]) => mockUserCreate(...args),
            update: (...args: unknown[]) => mockUserUpdate(...args),
            delete: (...args: unknown[]) => mockUserDelete(...args),
        },
        newApiToken: {
            create: (...args: unknown[]) => mockTokenCreate(...args),
        },
        $transaction: (...args: unknown[]) => mockTransaction(...args),
    },
}));

const mockProvision = vi.fn();
const mockDeleteNewApiUser = vi.fn();
const mockSearchNewApiUser = vi.fn();
vi.mock('@/lib/newapi/client', () => ({
    provisionNewCustomer: (...args: unknown[]) => mockProvision(...args),
    deleteUser: (...args: unknown[]) => mockDeleteNewApiUser(...args),
    searchUser: (...args: unknown[]) => mockSearchNewApiUser(...args),
}));

// session.ts uses real signSession; .env from vitest setup provides
// PORTAL_JWT_SECRET so no need to mock.

import { POST } from '../route';

function makeReq(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

const PORTAL_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NEWAPI_USER_ID = 42;

beforeEach(() => {
    vi.clearAllMocks();
    mockTransaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
});

describe('POST /api/auth/register (new-api)', () => {
    it('happy path: creates user, provisions new-api, returns token + sk-key', async () => {
        // findUnique gets called twice in this flow: once for "is email taken"
        // (where: { email }) → null, and once by session.ts:signSession for
        // session_token_version (where: { id }) → user shape.
        mockUserFindUnique.mockImplementation((args: { where: { email?: string; id?: string } }) => {
            if (args.where.email) return Promise.resolve(null);
            if (args.where.id === PORTAL_USER_ID) return Promise.resolve({ session_token_version: 1 });
            return Promise.resolve(null);
        });
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
            newapi_user_id: NEWAPI_USER_ID,
            newapi_username: 'c-aaaaaaaa',
            newapi_access_token: 'a'.repeat(32),
            newapi_token_id: 7,
            newapi_token_value: 'sk-test-abc123def456ghi',
        });

        const res = await POST(makeReq({ email: 'Happy@SilkRoadAI.io', password: 'goodpass123', nickname: 'Happy' }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.user_id).toBe(PORTAL_USER_ID);
        expect(body.token).toMatch(/^eyJ/);
        expect(body.newapi_user_id).toBe(NEWAPI_USER_ID);
        expect(body.newapi_token_value).toBe('sk-test-abc123def456ghi');
        expect(body.portal_user.email).toBe('happy@silkroadai.io');

        // email lowercased on store
        expect(mockUserCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ email: 'happy@silkroadai.io' }),
            }),
        );
        // never returns password_hash or access_token to client
        const bodyStr = JSON.stringify(body);
        expect(bodyStr).not.toMatch(/password/);
        expect(bodyStr).not.toMatch(/access_token/);

        // session cookie set
        expect(res.headers.get('set-cookie')).toContain('silkroad_session=');

        // linkage persisted via $transaction with all three new-api fields
        expect(mockTransaction).toHaveBeenCalledTimes(1);
        // no rollback paths invoked
        expect(mockUserDelete).not.toHaveBeenCalled();
        expect(mockDeleteNewApiUser).not.toHaveBeenCalled();
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

    it('rolls back portal user + cleans new-api orphan when provision fails mid-flow', async () => {
        // Step 2-6 failure scenario: provisionNewCustomer threw AFTER createUser
        // succeeded, so the new-api user exists with deterministic username
        // c-aaaaaaaa and we expect cleanupOrphanNewApiUser to find + delete it.
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
        mockProvision.mockRejectedValue(new Error('new-api 422 — token endpoint failed'));

        // searchUser returns the orphan that step 1 created
        mockSearchNewApiUser.mockResolvedValue({
            items: [
                { id: NEWAPI_USER_ID, username: 'c-aaaaaaaa', display_name: 'rollback@silkroadai.io' },
            ],
            total: 1,
        });
        mockDeleteNewApiUser.mockResolvedValue(undefined);
        mockUserDelete.mockResolvedValue({ id: PORTAL_USER_ID });

        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const res = await POST(makeReq({ email: 'rollback@silkroadai.io', password: 'goodpass123' }));
        const body = await res.json();

        expect(res.status).toBe(502);
        expect(body.error).toBe('provisioning_failed');
        // Both rollback paths fired in correct order
        expect(mockSearchNewApiUser).toHaveBeenCalledWith('c-aaaaaaaa', 1, 5);
        expect(mockDeleteNewApiUser).toHaveBeenCalledWith(NEWAPI_USER_ID);
        expect(mockUserDelete).toHaveBeenCalledWith({ where: { id: PORTAL_USER_ID } });
        // linkage transaction never reached
        expect(mockTransaction).not.toHaveBeenCalled();

        errSpy.mockRestore();
        warnSpy.mockRestore();
    });

    it('rolls back portal user only when provision fails at step 1 (no new-api orphan to clean)', async () => {
        // Step 1 failure: createUser threw, so no new-api user exists.
        // searchUser returns empty — cleanupOrphanNewApiUser should NOT call deleteUser.
        mockUserFindUnique.mockResolvedValue(null);
        mockUserCreate.mockResolvedValue({
            id: PORTAL_USER_ID,
            email: 'step1@silkroadai.io',
            nickname: null,
            email_verified: false,
            locale: 'zh-CN',
            status: 'active',
            created_at: new Date(),
        });
        mockProvision.mockRejectedValue(new Error('new-api 401 — admin auth failed'));
        mockSearchNewApiUser.mockResolvedValue({ items: [], total: 0 });
        mockUserDelete.mockResolvedValue({ id: PORTAL_USER_ID });

        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const res = await POST(makeReq({ email: 'step1@silkroadai.io', password: 'goodpass123' }));

        expect(res.status).toBe(502);
        expect(mockSearchNewApiUser).toHaveBeenCalled();
        // deleteUser NOT called because search found no orphan
        expect(mockDeleteNewApiUser).not.toHaveBeenCalled();
        // portal user still rolled back
        expect(mockUserDelete).toHaveBeenCalledWith({ where: { id: PORTAL_USER_ID } });

        errSpy.mockRestore();
    });

    it('cascades cleanup (new-api + portal) when DB linkage transaction fails', async () => {
        // Provision succeeds, but the prisma.$transaction persisting newapi_*
        // fields fails. We must delete BOTH the portal user AND the new-api
        // user/token to avoid orphans on either side.
        mockUserFindUnique.mockResolvedValue(null);
        mockUserCreate.mockResolvedValue({
            id: PORTAL_USER_ID,
            email: 'linkage@silkroadai.io',
            nickname: null,
            email_verified: false,
            locale: 'zh-CN',
            status: 'active',
            created_at: new Date(),
        });
        mockProvision.mockResolvedValue({
            newapi_user_id: NEWAPI_USER_ID,
            newapi_username: 'c-aaaaaaaa',
            newapi_access_token: 'b'.repeat(32),
            newapi_token_id: 99,
            newapi_token_value: 'sk-linkage-test-key',
        });
        mockTransaction.mockRejectedValue(new Error('connection lost'));
        mockDeleteNewApiUser.mockResolvedValue(undefined);
        mockUserDelete.mockResolvedValue({ id: PORTAL_USER_ID });

        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const res = await POST(makeReq({ email: 'linkage@silkroadai.io', password: 'goodpass123' }));
        const body = await res.json();

        expect(res.status).toBe(500);
        expect(body.error).toBe('persistence_failed');
        // BOTH cleanups fired
        expect(mockDeleteNewApiUser).toHaveBeenCalledWith(NEWAPI_USER_ID);
        expect(mockUserDelete).toHaveBeenCalledWith({ where: { id: PORTAL_USER_ID } });
        // search NOT called here (this is the post-provision failure path,
        // not the mid-provision path)
        expect(mockSearchNewApiUser).not.toHaveBeenCalled();

        errSpy.mockRestore();
    });
});
