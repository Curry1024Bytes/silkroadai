import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHash } from 'crypto';

// ── mocks ──

const mockTokenFindUnique = vi.fn();
const mockTransaction = vi.fn();
const mockUserUpdate = vi.fn();
const mockTokenUpdate = vi.fn();

vi.mock('@/lib/db', () => ({
    prisma: {
        passwordResetToken: {
            findUnique: (...args: unknown[]) => mockTokenFindUnique(...args),
            update: (...args: unknown[]) => mockTokenUpdate(...args),
        },
        user: {
            update: (...args: unknown[]) => mockUserUpdate(...args),
        },
        $transaction: (...args: unknown[]) => mockTransaction(...args),
    },
}));

const mockHash = vi.fn();
vi.mock('bcryptjs', () => ({
    hash: (...args: unknown[]) => mockHash(...args),
}));

// Throttle + attempt log live in their own module (unit-tested in
// src/lib/auth/__tests__/attempts.test.ts); here we only assert the route
// calls them correctly. tooManyAttemptsResponse stays real.
const mockCheckAuthRateLimit = vi.fn();
const mockRecordAuthAttempt = vi.fn();
const mockResolveAuthAttempt = vi.fn();
vi.mock('@/lib/auth/attempts', async () => {
    const actual = await vi.importActual<typeof import('@/lib/auth/attempts')>('@/lib/auth/attempts');
    return {
        ...actual,
        checkAuthRateLimit: (...args: unknown[]) => mockCheckAuthRateLimit(...args),
        recordAuthAttempt: (...args: unknown[]) => mockRecordAuthAttempt(...args),
        resolveAuthAttempt: (...args: unknown[]) => mockResolveAuthAttempt(...args),
    };
});

import { POST } from '../route';

function makeReq(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

const VALID_TOKEN = 'a'.repeat(64);
const VALID_TOKEN_HASH = createHash('sha256').update(VALID_TOKEN).digest('hex');
const PORTAL_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

beforeEach(() => {
    vi.clearAllMocks();
    mockCheckAuthRateLimit.mockResolvedValue({ limited: false });
    mockRecordAuthAttempt.mockResolvedValue('attempt-1');
    mockResolveAuthAttempt.mockResolvedValue(undefined);
    mockHash.mockResolvedValue('$2a$10$newbcrypthash');
    // $transaction([...]) just runs the ops; no real tx semantics needed in unit test
    mockTransaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
});

describe('POST /api/auth/reset-password', () => {
    it('200 when token valid: rehash, bump session_token_version, mark used', async () => {
        mockTokenFindUnique.mockResolvedValue({
            id: 'tok-1',
            user_id: PORTAL_USER_ID,
            used_at: null,
            expires_at: new Date(Date.now() + 30 * 60 * 1000),
        });

        const res = await POST(makeReq({ token: VALID_TOKEN, newPassword: 'newgoodpass123' }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ ok: true });
        // looked up by sha256(token) not raw
        expect(mockTokenFindUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { token_hash: VALID_TOKEN_HASH } }),
        );
        expect(mockHash).toHaveBeenCalledWith('newgoodpass123', 10);
        // transaction ran: User update + Token update
        expect(mockTransaction).toHaveBeenCalledTimes(1);
        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: PORTAL_USER_ID },
                data: expect.objectContaining({
                    password_hash: '$2a$10$newbcrypthash',
                    session_token_version: { increment: 1 },
                }),
            }),
        );
        expect(mockTokenUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'tok-1' },
                data: expect.objectContaining({ used_at: expect.any(Date) }),
            }),
        );
    });

    it('logs a reset_password success row keyed on the account email (restarts the login failure counter)', async () => {
        mockTokenFindUnique.mockResolvedValue({
            id: 'tok-1',
            user_id: PORTAL_USER_ID,
            used_at: null,
            expires_at: new Date(Date.now() + 30 * 60 * 1000),
        });
        mockUserUpdate.mockResolvedValue({ email: 'locked-out@silkroadai.io' });

        const res = await POST(makeReq({ token: VALID_TOKEN, newPassword: 'newgoodpass123' }));

        expect(res.status).toBe(200);
        expect(mockRecordAuthAttempt).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'reset_password',
                outcome: 'success',
                email: 'locked-out@silkroadai.io',
                userId: PORTAL_USER_ID,
            }),
        );
        expect(JSON.stringify(mockRecordAuthAttempt.mock.calls)).not.toContain('newgoodpass123');
    });

    it('400 when token does not exist', async () => {
        mockTokenFindUnique.mockResolvedValue(null);

        const res = await POST(makeReq({ token: VALID_TOKEN, newPassword: 'newgoodpass123' }));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toBe('invalid_or_expired_token');
        expect(mockHash).not.toHaveBeenCalled();
        expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('400 when token expired', async () => {
        mockTokenFindUnique.mockResolvedValue({
            id: 'tok-1',
            user_id: PORTAL_USER_ID,
            used_at: null,
            expires_at: new Date(Date.now() - 60 * 1000), // expired 1min ago
        });

        const res = await POST(makeReq({ token: VALID_TOKEN, newPassword: 'newgoodpass123' }));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toBe('invalid_or_expired_token');
        expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('400 when token already used', async () => {
        mockTokenFindUnique.mockResolvedValue({
            id: 'tok-1',
            user_id: PORTAL_USER_ID,
            used_at: new Date(Date.now() - 60 * 1000),
            expires_at: new Date(Date.now() + 30 * 60 * 1000),
        });

        const res = await POST(makeReq({ token: VALID_TOKEN, newPassword: 'newgoodpass123' }));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toBe('invalid_or_expired_token');
        expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('400 when newPassword too short', async () => {
        const res = await POST(makeReq({ token: VALID_TOKEN, newPassword: 'tiny' }));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toBe('invalid_input');
        expect(body.issues.newPassword).toBeDefined();
        expect(mockTokenFindUnique).not.toHaveBeenCalled();
    });

    it('400 when token format wrong (non-hex / wrong length)', async () => {
        const res = await POST(
            makeReq({
                token: 'not-hex-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                newPassword: 'goodpass123',
            }),
        );
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toBe('invalid_input');
        expect(body.issues.token).toBeDefined();
    });

    it('400 when body is non-JSON', async () => {
        const res = await POST(makeReq('not json'));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toBe('invalid_input');
    });
});
