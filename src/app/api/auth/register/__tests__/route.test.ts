import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ── mocks ──

const mockUserFindUnique = vi.fn();
const mockUserCreate = vi.fn();
const mockUserUpdate = vi.fn();
const mockUserDelete = vi.fn();
const mockTokenCreate = vi.fn();
const mockEmailVerificationTokenCreate = vi.fn();
const mockTransaction = vi.fn();

// PR-U1: reseller resolve path needs resellerInviteCode.findUnique
// (returns null when env-only / empty input) + user.count for IP throttle
// + analyticsEvent.create for the attribution-assigned event.
const mockResellerCodeFindUnique = vi.fn();
const mockUserCount = vi.fn();
const mockAnalyticsEventCreate = vi.fn();

vi.mock('@/lib/db', () => ({
    prisma: {
        user: {
            findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
            create: (...args: unknown[]) => mockUserCreate(...args),
            update: (...args: unknown[]) => mockUserUpdate(...args),
            delete: (...args: unknown[]) => mockUserDelete(...args),
            count: (...args: unknown[]) => mockUserCount(...args),
        },
        newApiToken: {
            create: (...args: unknown[]) => mockTokenCreate(...args),
        },
        emailVerificationToken: {
            create: (...args: unknown[]) => mockEmailVerificationTokenCreate(...args),
        },
        resellerInviteCode: {
            findUnique: (...args: unknown[]) => mockResellerCodeFindUnique(...args),
        },
        analyticsEvent: {
            create: (...args: unknown[]) => mockAnalyticsEventCreate(...args),
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

const mockSendVerificationEmail = vi.fn();
vi.mock('@/lib/email/send', () => ({
    sendVerificationEmail: (...args: unknown[]) => mockSendVerificationEmail(...args),
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
    // Default: verification token + email succeed silently. Tests that care
    // override these.
    mockEmailVerificationTokenCreate.mockResolvedValue({ id: 'verif-tok-1' });
    mockSendVerificationEmail.mockResolvedValue({
        messageId: '<test@example>',
        accepted: ['ok'],
        rejected: [],
    });
    // PR-U1 defaults: no reseller code matches → polymorphic resolver
    // falls through to env-allow-list path (which is currently empty, so
    // resolved.kind === 'none' for blank invite_code in the existing tests).
    // user.count / analyticsEvent.create are no-ops by default.
    mockResellerCodeFindUnique.mockResolvedValue(null);
    mockUserCount.mockResolvedValue(0);
    mockAnalyticsEventCreate.mockResolvedValue({});
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
            email: 'happy@llmroute.club',
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

        const res = await POST(makeReq({ email: 'Happy@LLmRoute.club', password: 'goodpass123', nickname: 'Happy' }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.user_id).toBe(PORTAL_USER_ID);
        expect(body.token).toMatch(/^eyJ/);
        expect(body.newapi_user_id).toBe(NEWAPI_USER_ID);
        expect(body.newapi_token_value).toBe('sk-test-abc123def456ghi');
        expect(body.portal_user.email).toBe('happy@llmroute.club');

        // email lowercased on store
        expect(mockUserCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ email: 'happy@llmroute.club' }),
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

        // W3 D5: verification token created + verification email sent.
        // Response carries email_verified:false (Boolean default for new user).
        expect(body.portal_user.email_verified).toBe(false);
        expect(mockEmailVerificationTokenCreate).toHaveBeenCalledTimes(1);
        const tokenArgs = mockEmailVerificationTokenCreate.mock.calls[0][0] as {
            data: { user_id: string; token_hash: string; expires_at: Date };
        };
        expect(tokenArgs.data.user_id).toBe(PORTAL_USER_ID);
        expect(tokenArgs.data.token_hash).toMatch(/^[a-f0-9]{64}$/);
        // 24h TTL — at least 23h in the future
        expect(tokenArgs.data.expires_at.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
        expect(mockSendVerificationEmail).toHaveBeenCalledTimes(1);
        const mailArgs = mockSendVerificationEmail.mock.calls[0][0] as {
            to: string;
            verifyUrl: string;
            expiresInHours: number;
        };
        expect(mailArgs.to).toBe('happy@llmroute.club');
        expect(mailArgs.verifyUrl).toMatch(/\/verify-email\?token=[a-f0-9]{64}$/);
        expect(mailArgs.expiresInHours).toBe(24);
    });

    it('happy path even when verification email fails: registration still 200', async () => {
        // Simulates SMTP outage during register. The logical contract is the
        // user is registered + has a session — they can request resend later.
        mockUserFindUnique.mockImplementation((args: { where: { email?: string; id?: string } }) => {
            if (args.where.id === PORTAL_USER_ID) return Promise.resolve({ session_token_version: 1 });
            return Promise.resolve(null);
        });
        mockUserCreate.mockResolvedValue({
            id: PORTAL_USER_ID,
            email: 'smtpdown@llmroute.club',
            nickname: null,
            email_verified: false,
            locale: 'zh-CN',
            status: 'active',
            created_at: new Date(),
        });
        mockProvision.mockResolvedValue({
            newapi_user_id: 99,
            newapi_username: 'c-aaaaaaaa',
            newapi_access_token: 'a'.repeat(32),
            newapi_token_id: 7,
            newapi_token_value: 'sk-test-stmpdown-key',
        });
        mockSendVerificationEmail.mockRejectedValue(new Error('SMTP unavailable'));

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const res = await POST(makeReq({ email: 'smtpdown@llmroute.club', password: 'goodpass123' }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.user_id).toBe(PORTAL_USER_ID);
        expect(body.token).toMatch(/^eyJ/);
        // token row was still created (resend can use a fresh one later, but
        // the existing one stays valid until throttle expires)
        expect(mockEmailVerificationTokenCreate).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('returns 409 when email already registered', async () => {
        mockUserFindUnique.mockResolvedValue({ id: 'existing' });

        const res = await POST(makeReq({ email: 'taken@llmroute.club', password: 'goodpass123' }));
        const body = await res.json();

        expect(res.status).toBe(409);
        expect(body.error).toBe('email_already_registered');
        expect(mockUserCreate).not.toHaveBeenCalled();
        expect(mockProvision).not.toHaveBeenCalled();
    });

    it('returns 400 when password is too short', async () => {
        const res = await POST(makeReq({ email: 'short@llmroute.club', password: 'tiny' }));
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
            email: 'rollback@llmroute.club',
            nickname: null,
            email_verified: false,
            locale: 'zh-CN',
            status: 'active',
            created_at: new Date(),
        });
        mockProvision.mockRejectedValue(new Error('new-api 422 — token endpoint failed'));

        // searchUser returns the orphan that step 1 created
        mockSearchNewApiUser.mockResolvedValue({
            items: [{ id: NEWAPI_USER_ID, username: 'c-aaaaaaaa', display_name: 'rollback@llmroute.club' }],
            total: 1,
        });
        mockDeleteNewApiUser.mockResolvedValue(undefined);
        mockUserDelete.mockResolvedValue({ id: PORTAL_USER_ID });

        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const res = await POST(makeReq({ email: 'rollback@llmroute.club', password: 'goodpass123' }));
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
            email: 'step1@llmroute.club',
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

        const res = await POST(makeReq({ email: 'step1@llmroute.club', password: 'goodpass123' }));

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
            email: 'linkage@llmroute.club',
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

        const res = await POST(makeReq({ email: 'linkage@llmroute.club', password: 'goodpass123' }));
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

/* ──────────────────────────────────────────────────────────── */
/* W7 D4 — invite_code branches                                 */
/* ──────────────────────────────────────────────────────────── */

describe('POST /api/auth/register (W7 D4 invite_code)', () => {
    const ORIGINAL_INVITE = process.env.INVITE_CODES;

    beforeEach(() => {
        // Clean slate per test; individual tests opt-in to a specific
        // INVITE_CODES env value.
        delete process.env.INVITE_CODES;
    });

    // Restore at suite end so other test files don't see our env mutations.
    // (vitest doesn't auto-snapshot process.env across files.)
    afterAll(() => {
        if (ORIGINAL_INVITE === undefined) delete process.env.INVITE_CODES;
        else process.env.INVITE_CODES = ORIGINAL_INVITE;
    });

    it('valid invite_code: persists code on user.create + reaches new-api provision', async () => {
        process.env.INVITE_CODES = 'LAUNCH-A, FRIEND2026';
        mockUserFindUnique.mockImplementation((args: { where: { email?: string; id?: string } }) => {
            if (args.where.id === PORTAL_USER_ID) return Promise.resolve({ session_token_version: 1 });
            return Promise.resolve(null);
        });
        mockUserCreate.mockResolvedValue({
            id: PORTAL_USER_ID,
            email: 'invited@llmroute.club',
            nickname: null,
            email_verified: false,
            locale: 'zh-CN',
            status: 'active',
            created_at: new Date(),
        });
        mockProvision.mockResolvedValue({
            newapi_user_id: NEWAPI_USER_ID,
            newapi_username: 'c-aaaaaaaa',
            newapi_access_token: 'a'.repeat(32),
            newapi_token_id: 7,
            newapi_token_value: 'sk-test-invite',
        });

        const res = await POST(
            makeReq({
                email: 'invited@llmroute.club',
                password: 'goodpass123',
                invite_code: 'LAUNCH-A',
            }),
        );

        expect(res.status).toBe(200);
        // Invite code persisted on user.create — case preserved as-typed.
        // (isValidInviteCode is case-insensitive; storing the operator's
        // intended casing keeps analytics dashboards readable.)
        expect(mockUserCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ invite_code: 'LAUNCH-A' }),
            }),
        );
    });

    it('valid invite_code: case-insensitive match — user types lowercase, env has UPPER', async () => {
        process.env.INVITE_CODES = 'LAUNCH-A';
        mockUserFindUnique.mockImplementation((args: { where: { email?: string; id?: string } }) => {
            if (args.where.id === PORTAL_USER_ID) return Promise.resolve({ session_token_version: 1 });
            return Promise.resolve(null);
        });
        mockUserCreate.mockResolvedValue({
            id: PORTAL_USER_ID,
            email: 'lower@llmroute.club',
            nickname: null,
            email_verified: false,
            locale: 'zh-CN',
            status: 'active',
            created_at: new Date(),
        });
        mockProvision.mockResolvedValue({
            newapi_user_id: NEWAPI_USER_ID,
            newapi_username: 'c-aaaaaaaa',
            newapi_access_token: 'a'.repeat(32),
            newapi_token_id: 7,
            newapi_token_value: 'sk-test',
        });

        const res = await POST(
            makeReq({
                email: 'lower@llmroute.club',
                password: 'goodpass123',
                invite_code: 'launch-a',
            }),
        );

        expect(res.status).toBe(200);
        // Stored with the user's original casing; isValidInviteCode
        // re-validates case-insensitively at bonus time.
        expect(mockUserCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ invite_code: 'launch-a' }),
            }),
        );
    });

    it('invalid invite_code: 400 invalid_invite_code, no user creation, no provision', async () => {
        process.env.INVITE_CODES = 'LAUNCH-A';
        // No setup needed for findUnique — request rejected before DB.

        const res = await POST(
            makeReq({
                email: 'bad@llmroute.club',
                password: 'goodpass123',
                invite_code: 'NOT-IN-LIST',
            }),
        );
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toBe('invalid_invite_code');
        // The frontend uses `data.message` to render the inline hint —
        // assert it surfaces a non-empty Chinese string.
        expect(body.message).toContain('邀请码');

        // Nothing else should have been touched: not even findUnique.
        expect(mockUserFindUnique).not.toHaveBeenCalled();
        expect(mockUserCreate).not.toHaveBeenCalled();
        expect(mockProvision).not.toHaveBeenCalled();
        expect(mockEmailVerificationTokenCreate).not.toHaveBeenCalled();
        expect(mockSendVerificationEmail).not.toHaveBeenCalled();
    });

    it('absent invite_code: registers cleanly, persists invite_code: null', async () => {
        // Even with codes available, the user opts not to enter one.
        process.env.INVITE_CODES = 'LAUNCH-A';
        mockUserFindUnique.mockImplementation((args: { where: { email?: string; id?: string } }) => {
            if (args.where.id === PORTAL_USER_ID) return Promise.resolve({ session_token_version: 1 });
            return Promise.resolve(null);
        });
        mockUserCreate.mockResolvedValue({
            id: PORTAL_USER_ID,
            email: 'plain@llmroute.club',
            nickname: null,
            email_verified: false,
            locale: 'zh-CN',
            status: 'active',
            created_at: new Date(),
        });
        mockProvision.mockResolvedValue({
            newapi_user_id: NEWAPI_USER_ID,
            newapi_username: 'c-aaaaaaaa',
            newapi_access_token: 'a'.repeat(32),
            newapi_token_id: 7,
            newapi_token_value: 'sk-test-plain',
        });

        const res = await POST(makeReq({ email: 'plain@llmroute.club', password: 'goodpass123' }));

        expect(res.status).toBe(200);
        // invite_code should land as null (not undefined / not "" /
        // not the field omitted).
        expect(mockUserCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ invite_code: null }),
            }),
        );
    });

    it('whitespace-only invite_code: treated as absent (registers, persists null)', async () => {
        // The form might submit "  " if a user types and clears via
        // backspace without trimming. Backend should not reject this as
        // "invalid"; it should be normalized to absent.
        process.env.INVITE_CODES = 'LAUNCH-A';
        mockUserFindUnique.mockImplementation((args: { where: { email?: string; id?: string } }) => {
            if (args.where.id === PORTAL_USER_ID) return Promise.resolve({ session_token_version: 1 });
            return Promise.resolve(null);
        });
        mockUserCreate.mockResolvedValue({
            id: PORTAL_USER_ID,
            email: 'spaces@llmroute.club',
            nickname: null,
            email_verified: false,
            locale: 'zh-CN',
            status: 'active',
            created_at: new Date(),
        });
        mockProvision.mockResolvedValue({
            newapi_user_id: NEWAPI_USER_ID,
            newapi_username: 'c-aaaaaaaa',
            newapi_access_token: 'a'.repeat(32),
            newapi_token_id: 7,
            newapi_token_value: 'sk-test-spaces',
        });

        const res = await POST(
            makeReq({
                email: 'spaces@llmroute.club',
                password: 'goodpass123',
                invite_code: '   ',
            }),
        );

        expect(res.status).toBe(200);
        expect(mockUserCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ invite_code: null }),
            }),
        );
    });
});
