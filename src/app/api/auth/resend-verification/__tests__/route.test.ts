import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockUserFindUnique = vi.fn();
const mockTokenFindFirst = vi.fn();
const mockTokenCreate = vi.fn();

vi.mock('@/lib/db', () => ({
    prisma: {
        user: {
            findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
        },
        emailVerificationToken: {
            findFirst: (...args: unknown[]) => mockTokenFindFirst(...args),
            create: (...args: unknown[]) => mockTokenCreate(...args),
        },
    },
}));

const mockSendVerificationEmail = vi.fn();
vi.mock('@/lib/email/send', () => ({
    sendVerificationEmail: (...args: unknown[]) => mockSendVerificationEmail(...args),
}));

import { POST } from '../route';

function makeReq(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

const PORTAL_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

beforeEach(() => {
    vi.clearAllMocks();
    mockTokenCreate.mockResolvedValue({ id: 'tok-1' });
    mockSendVerificationEmail.mockResolvedValue({
        messageId: '<test@example>',
        accepted: ['ok'],
        rejected: [],
    });
});

describe('POST /api/auth/resend-verification', () => {
    it('200 when unverified email exists: creates token + sends email', async () => {
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            email: 'unverified@llmroute.club',
            email_verified_at: null,
            status: 'active',
        });
        mockTokenFindFirst.mockResolvedValue(null);

        const res = await POST(makeReq({ email: 'Unverified@LLmRoute.club' }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ ok: true });
        expect(mockUserFindUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { email: 'unverified@llmroute.club' } }),
        );
        expect(mockTokenCreate).toHaveBeenCalledTimes(1);
        const createArgs = mockTokenCreate.mock.calls[0][0] as {
            data: { user_id: string; token_hash: string; expires_at: Date };
        };
        expect(createArgs.data.user_id).toBe(PORTAL_USER_ID);
        expect(createArgs.data.token_hash).toMatch(/^[a-f0-9]{64}$/);
        // 24h TTL — at least 23h in the future
        expect(createArgs.data.expires_at.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
        expect(mockSendVerificationEmail).toHaveBeenCalledTimes(1);
        const mailArgs = mockSendVerificationEmail.mock.calls[0][0] as {
            to: string;
            verifyUrl: string;
            expiresInHours: number;
        };
        expect(mailArgs.to).toBe('unverified@llmroute.club');
        expect(mailArgs.verifyUrl).toMatch(/\/verify-email\?token=[a-f0-9]{64}$/);
        expect(mailArgs.expiresInHours).toBe(24);
    });

    it('200 when already verified: NO token, NO email (silent noop)', async () => {
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            email: 'verified@llmroute.club',
            email_verified_at: new Date('2026-01-01T00:00:00Z'),
            status: 'active',
        });

        const res = await POST(makeReq({ email: 'verified@llmroute.club' }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ ok: true });
        expect(mockTokenCreate).not.toHaveBeenCalled();
        expect(mockSendVerificationEmail).not.toHaveBeenCalled();
    });

    it("200 when email doesn't exist: NO token, NO email", async () => {
        mockUserFindUnique.mockResolvedValue(null);

        const res = await POST(makeReq({ email: 'ghost@llmroute.club' }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ ok: true });
        expect(mockTokenFindFirst).not.toHaveBeenCalled();
        expect(mockTokenCreate).not.toHaveBeenCalled();
        expect(mockSendVerificationEmail).not.toHaveBeenCalled();
    });

    it('200 when banned: NO token, NO email', async () => {
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            email: 'banned@llmroute.club',
            email_verified_at: null,
            status: 'banned',
        });

        const res = await POST(makeReq({ email: 'banned@llmroute.club' }));

        expect(res.status).toBe(200);
        expect(mockTokenCreate).not.toHaveBeenCalled();
        expect(mockSendVerificationEmail).not.toHaveBeenCalled();
    });

    it('throttle: 2 calls in 5min window → 1 token, 1 email', async () => {
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            email: 'busy@llmroute.club',
            email_verified_at: null,
            status: 'active',
        });
        mockTokenFindFirst.mockResolvedValueOnce(null);
        mockTokenFindFirst.mockResolvedValueOnce({ id: 'tok-existing' });

        const res1 = await POST(makeReq({ email: 'busy@llmroute.club' }));
        const res2 = await POST(makeReq({ email: 'busy@llmroute.club' }));

        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);
        expect(mockTokenCreate).toHaveBeenCalledTimes(1);
        expect(mockSendVerificationEmail).toHaveBeenCalledTimes(1);
    });

    it('200 when SMTP fails: token row stays for retry, response still 200', async () => {
        mockUserFindUnique.mockResolvedValue({
            id: PORTAL_USER_ID,
            email: 'smtpdown@llmroute.club',
            email_verified_at: null,
            status: 'active',
        });
        mockTokenFindFirst.mockResolvedValue(null);
        mockSendVerificationEmail.mockRejectedValue(new Error('SMTP unavailable'));
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
    });

    it('400 when body is non-JSON', async () => {
        const res = await POST(makeReq('not json'));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toBe('invalid_input');
    });
});
