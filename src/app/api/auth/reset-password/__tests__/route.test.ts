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
