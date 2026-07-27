import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ── mocks ──

const mockUserFindUnique = vi.fn();
const mockTokenFindFirst = vi.fn();
const mockTokenCreate = vi.fn();

vi.mock('@/lib/db', () => ({
    prisma: {
        user: {
            findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
        },
        passwordResetToken: {
            findFirst: (...args: unknown[]) => mockTokenFindFirst(...args),
            create: (...args: unknown[]) => mockTokenCreate(...args),
        },
    },
}));

const mockSendPasswordResetEmail = vi.fn();
vi.mock('@/lib/email/send', () => ({
    sendPasswordResetEmail: (...args: unknown[]) => mockSendPasswordResetEmail(...args),
}));

import { POST } from '../route';

function makeReq(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

const PORTAL_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

beforeEach(() => {
    vi.clearAllMocks();
    mockTokenCreate.mockResolvedValue({ id: 'tok-1' });
    mockSendPasswordResetEmail.mockResolvedValue({
        messageId: '<test@example>',
        accepted: ['ok'],
        rejected: [],
    });
});

describe('POST /api/auth/forgot-password', () => {
    it('200 when email exists: creates token + sends email', async () => {
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            email: 'real@llmroute.club',
            status: 'active',
        });
        mockTokenFindFirst.mockResolvedValue(null); // no recent token

        const res = await POST(makeReq({ email: 'Real@LLmRoute.club' }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ ok: true });
        // email lowercased before lookup
        expect(mockUserFindUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { email: 'real@llmroute.club' } }),
        );
        // token created
        expect(mockTokenCreate).toHaveBeenCalledTimes(1);
        const createArgs = mockTokenCreate.mock.calls[0][0] as {
            data: { user_id: string; token_hash: string; expires_at: Date };
        };
        expect(createArgs.data.user_id).toBe(PORTAL_USER_ID);
        expect(createArgs.data.token_hash).toMatch(/^[a-f0-9]{64}$/);
        expect(createArgs.data.expires_at.getTime()).toBeGreaterThan(Date.now() + 55 * 60 * 1000);
        // email sent with reset URL containing a 64-char hex token
        expect(mockSendPasswordResetEmail).toHaveBeenCalledTimes(1);
        const mailArgs = mockSendPasswordResetEmail.mock.calls[0][0] as {
            to: string;
            resetUrl: string;
            expiresInMinutes: number;
        };
        expect(mailArgs.to).toBe('real@llmroute.club');
        expect(mailArgs.resetUrl).toMatch(/\/reset-password\?token=[a-f0-9]{64}$/);
        expect(mailArgs.expiresInMinutes).toBe(60);
    });

    it("200 when email doesn't exist: NO token, NO email", async () => {
        mockUserFindUnique.mockResolvedValue(null);

        const res = await POST(makeReq({ email: 'ghost@llmroute.club' }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ ok: true });
        expect(mockTokenFindFirst).not.toHaveBeenCalled();
        expect(mockTokenCreate).not.toHaveBeenCalled();
        expect(mockSendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('200 when account banned: NO token, NO email (no recovery bypass)', async () => {
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            email: 'banned@llmroute.club',
            status: 'banned',
        });

        const res = await POST(makeReq({ email: 'banned@llmroute.club' }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ ok: true });
        expect(mockTokenCreate).not.toHaveBeenCalled();
        expect(mockSendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('throttle: 2 calls in 5min window → 1 token created, 1 email sent', async () => {
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            email: 'busy@llmroute.club',
            status: 'active',
        });
        // 1st call: no recent token
        mockTokenFindFirst.mockResolvedValueOnce(null);
        // 2nd call: existing recent token (throttled)
        mockTokenFindFirst.mockResolvedValueOnce({ id: 'tok-existing' });

        const res1 = await POST(makeReq({ email: 'busy@llmroute.club' }));
        const res2 = await POST(makeReq({ email: 'busy@llmroute.club' }));

        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);
        expect(mockTokenCreate).toHaveBeenCalledTimes(1);
        expect(mockSendPasswordResetEmail).toHaveBeenCalledTimes(1);
    });

    it('200 when email send fails: token row stays for retry, response still 200', async () => {
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            email: 'smtpdown@llmroute.club',
            status: 'active',
        });
        mockTokenFindFirst.mockResolvedValue(null);
        mockSendPasswordResetEmail.mockRejectedValue(new Error('SMTP unavailable'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const res = await POST(makeReq({ email: 'smtpdown@llmroute.club' }));

        expect(res.status).toBe(200);
        expect(mockTokenCreate).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('400 when email malformed', async () => {
        const res = await POST(makeReq({ email: 'not-an-email' }));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toBe('invalid_input');
        expect(mockUserFindUnique).not.toHaveBeenCalled();
        expect(mockSendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('400 when body is non-JSON', async () => {
        const res = await POST(makeReq('not json'));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toBe('invalid_input');
    });
});
