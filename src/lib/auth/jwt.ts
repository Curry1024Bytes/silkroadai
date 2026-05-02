import { SignJWT, jwtVerify } from 'jose';

const SECRET_RAW = process.env.PORTAL_JWT_SECRET;
if (!SECRET_RAW) {
    throw new Error('Missing required env var: PORTAL_JWT_SECRET');
}
const SECRET = new TextEncoder().encode(SECRET_RAW);

const EXPIRES = process.env.PORTAL_JWT_EXPIRES || '7d';
const ISSUER = 'silkroadai-portal';

export async function signSession(userId: string): Promise<string> {
    return await new SignJWT({ sub: userId })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime(EXPIRES)
        .sign(SECRET);
}

export async function verifySession(token: string): Promise<string | null> {
    try {
        const { payload } = await jwtVerify(token, SECRET, { issuer: ISSUER });
        return typeof payload.sub === 'string' ? payload.sub : null;
    } catch {
        return null;
    }
}
