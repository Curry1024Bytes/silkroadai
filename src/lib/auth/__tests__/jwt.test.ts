import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signSession as signSessionRaw, verifySession } from '../jwt';

const PORTAL_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('jwt session token (with token version)', () => {
    it('sign + verify round-trips userId AND tokenVersion', async () => {
        const token = await signSessionRaw(PORTAL_USER_ID, 7);
        const payload = await verifySession(token);
        expect(payload).toEqual({ userId: PORTAL_USER_ID, tokenVersion: 7 });
    });

    it('returns null on invalid signature', async () => {
        const token = await signSessionRaw(PORTAL_USER_ID, 1);
        // tamper with signature
        const tampered = token.slice(0, -3) + 'AAA';
        expect(await verifySession(tampered)).toBeNull();
    });

    it('returns null on missing tv field', async () => {
        // Sign by hand without tv
        const { SignJWT } = await import('jose');
        const SECRET = new TextEncoder().encode(process.env.PORTAL_JWT_SECRET);
        const token = await new SignJWT({ sub: PORTAL_USER_ID })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuer('silkroadai-portal')
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(SECRET);
        expect(await verifySession(token)).toBeNull();
    });

    it('returns null on bogus token', async () => {
        expect(await verifySession('not.a.jwt')).toBeNull();
        expect(await verifySession('')).toBeNull();
    });

    it('returns null when token has wrong issuer', async () => {
        const { SignJWT } = await import('jose');
        const SECRET = new TextEncoder().encode(process.env.PORTAL_JWT_SECRET);
        const token = await new SignJWT({ sub: PORTAL_USER_ID, tv: 1 })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuer('some-other-app')
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(SECRET);
        expect(await verifySession(token)).toBeNull();
    });

    it('caller can compare tokenVersion against live DB value to detect stale sessions', async () => {
        // simulating: user resets pw → server bumps user.session_token_version 1 → 2.
        // a JWT signed at version 1 is still valid signature-wise but caller (getCurrentUser)
        // is expected to compare and reject.
        const token = await signSessionRaw(PORTAL_USER_ID, 1);
        const payload = await verifySession(token);
        expect(payload).not.toBeNull();
        expect(payload!.tokenVersion).toBe(1);
        // session.ts:getCurrentUser will fetch user.session_token_version=2 from DB and reject.
        // Here we just assert verifySession exposes the version cleanly so that comparison is possible.
    });
});

describe.skip('placeholder for live DB cross-check (covered in session.ts integration)', () => {
    beforeEach(() => vi.clearAllMocks());
    it('placeholder', () => {});
});
