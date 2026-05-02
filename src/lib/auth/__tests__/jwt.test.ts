import { describe, it, expect } from 'vitest';
import { signSession, verifySession } from '../jwt';

describe('JWT session tokens', () => {
    it('round-trips a userId through sign + verify', async () => {
        const userId = 'a8b3e9d2-1234-4567-89ab-cdef01234567';
        const token = await signSession(userId);
        expect(token).toMatch(/^eyJ/);
        expect(token.split('.')).toHaveLength(3);

        const recovered = await verifySession(token);
        expect(recovered).toBe(userId);
    });

    it('returns null for a bogus token', async () => {
        expect(await verifySession('not.a.jwt')).toBeNull();
        expect(await verifySession('')).toBeNull();
    });

    it('returns null for a token signed with a different secret', async () => {
        const { SignJWT } = await import('jose');
        const otherSecret = new TextEncoder().encode('definitely-not-the-portal-secret-1234567');
        const token = await new SignJWT({ sub: 'whoever' })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuer('silkroadai-portal')
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(otherSecret);

        expect(await verifySession(token)).toBeNull();
    });

    it('returns null for a token with a different issuer', async () => {
        const { SignJWT } = await import('jose');
        const SECRET = new TextEncoder().encode(process.env.PORTAL_JWT_SECRET!);
        const token = await new SignJWT({ sub: 'whoever' })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuer('some-other-app')
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(SECRET);

        expect(await verifySession(token)).toBeNull();
    });
});
