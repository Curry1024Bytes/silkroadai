import { SignJWT, jwtVerify } from 'jose';

const SECRET_RAW = process.env.PORTAL_JWT_SECRET;
if (!SECRET_RAW) {
    throw new Error('Missing required env var: PORTAL_JWT_SECRET');
}
const SECRET = new TextEncoder().encode(SECRET_RAW);

const EXPIRES = process.env.PORTAL_JWT_EXPIRES || '7d';
const ISSUER = 'silkroadai-portal';

/**
 * Sign a session JWT.
 *
 * `tokenVersion` is the caller's current `User.session_token_version` snapshot.
 * It's embedded as `tv` in the JWT payload; `verifySession` re-checks it
 * against the live DB value, so bumping `User.session_token_version` (e.g. on
 * password reset) invalidates every existing session for that user without us
 * having to maintain a server-side blacklist.
 */
export async function signSession(userId: string, tokenVersion: number): Promise<string> {
    return await new SignJWT({ sub: userId, tv: tokenVersion })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime(EXPIRES)
        .sign(SECRET);
}

export interface SessionPayload {
    userId: string;
    tokenVersion: number;
}

/**
 * Verify a session JWT — signature, issuer, expiry. Returns the embedded
 * userId + tokenVersion so the caller (typically `getCurrentUser`) can
 * compare `tv` against the live `User.session_token_version` column. Returns
 * null on any verification failure (don't throw — callers branch on null).
 */
export async function verifySession(token: string): Promise<SessionPayload | null> {
    try {
        const { payload } = await jwtVerify(token, SECRET, { issuer: ISSUER });
        if (typeof payload.sub !== 'string') return null;
        if (typeof payload.tv !== 'number') return null;
        return { userId: payload.sub, tokenVersion: payload.tv };
    } catch {
        return null;
    }
}
