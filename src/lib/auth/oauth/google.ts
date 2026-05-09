/**
 * Google OAuth (OIDC) helpers — DIY with `jose`, no openid-client.
 *
 * Uses Google's standard OIDC discovery endpoints:
 *   - authorize:  https://accounts.google.com/o/oauth2/v2/auth
 *   - token:      https://oauth2.googleapis.com/token
 *   - jwks:       https://www.googleapis.com/oauth2/v3/certs
 *
 * jose's `createRemoteJWKSet` handles JWKS fetch + cache + key rotation.
 * The cached set is module-scoped (one fetch per process per ~10min), so
 * heavy auth load doesn't pound Google.
 */
import { createHash, randomBytes } from 'crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ALLOWED_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

/** Module-scoped JWKS — created lazily so tests can stub fetch first. */
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJWKS() {
    if (!_jwks) _jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
    return _jwks;
}
/** Test-only: drop the cached JWKS so a stubbed fetch is consulted afresh. */
export function _resetJWKSForTests(): void {
    _jwks = null;
}

/* ────────────── PKCE / state ────────────── */

export function generateState(): string {
    return randomBytes(32).toString('hex');
}
export function generatePkceVerifier(): string {
    return randomBytes(32).toString('base64url');
}
export function pkceChallengeFromVerifier(verifier: string): string {
    return createHash('sha256').update(verifier).digest('base64url');
}

/* ────────────── authorize URL ────────────── */

export function buildGoogleAuthorizeUrl(args: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
}): string {
    const u = new URL(GOOGLE_AUTHORIZE_URL);
    u.searchParams.set('client_id', args.clientId);
    u.searchParams.set('redirect_uri', args.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'openid email profile');
    u.searchParams.set('access_type', 'online');
    u.searchParams.set('prompt', 'select_account');
    u.searchParams.set('state', args.state);
    u.searchParams.set('code_challenge', args.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return u.toString();
}

/* ────────────── token exchange ────────────── */

export interface GoogleTokenResponse {
    access_token: string;
    expires_in: number;
    id_token: string;
    scope: string;
    token_type: string;
    refresh_token?: string;
}

export async function exchangeCodeForTokens(args: {
    code: string;
    codeVerifier: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
}): Promise<GoogleTokenResponse> {
    const body = new URLSearchParams({
        code: args.code,
        client_id: args.clientId,
        client_secret: args.clientSecret,
        redirect_uri: args.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: args.codeVerifier,
    });
    const res = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new GoogleOAuthError(
            'token_exchange_failed',
            `Google token endpoint ${res.status}: ${text.slice(0, 300)}`,
        );
    }
    return (await res.json()) as GoogleTokenResponse;
}

/* ────────────── id_token verification ────────────── */

export interface GoogleIdTokenClaims {
    sub: string; // stable per-user identifier
    email: string;
    email_verified: boolean;
    iss: string;
    aud: string;
    exp: number;
    iat: number;
    name?: string;
    picture?: string;
}

/**
 * Verify a Google id_token signature + claims. Audience MUST match our
 * client_id; issuer MUST be one of Google's published issuers; expiry must
 * be in the future. Returns typed claims on success, throws GoogleOAuthError
 * with a `code` callers can pattern-match on.
 */
export async function verifyGoogleIdToken(args: { idToken: string; clientId: string }): Promise<GoogleIdTokenClaims> {
    let payload: Record<string, unknown>;
    try {
        const verified = await jwtVerify(args.idToken, getJWKS(), {
            audience: args.clientId,
            // jose accepts a string OR a function; passing a Set lets us cover both
            // valid Google issuer spellings.
            issuer: Array.from(ALLOWED_ISSUERS),
        });
        payload = verified.payload as Record<string, unknown>;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Subdivide common cases so the route can map to user-facing errors.
        if (msg.includes('expired') || msg.includes('"exp"')) {
            throw new GoogleOAuthError('id_token_expired', msg);
        }
        if (msg.includes('audience') || msg.includes('"aud"')) {
            throw new GoogleOAuthError('id_token_bad_audience', msg);
        }
        if (msg.includes('issuer') || msg.includes('"iss"')) {
            throw new GoogleOAuthError('id_token_bad_issuer', msg);
        }
        throw new GoogleOAuthError('id_token_invalid', msg);
    }

    if (typeof payload.sub !== 'string' || !payload.sub) {
        throw new GoogleOAuthError('id_token_missing_sub', 'id_token has no sub');
    }
    if (typeof payload.email !== 'string' || !payload.email) {
        throw new GoogleOAuthError('id_token_missing_email', 'id_token has no email');
    }
    if (payload.email_verified !== true) {
        throw new GoogleOAuthError('email_not_verified', 'Google says this email is not verified');
    }

    return {
        sub: payload.sub,
        email: (payload.email as string).trim().toLowerCase(),
        email_verified: true,
        iss: String(payload.iss ?? ''),
        aud: String(payload.aud ?? ''),
        exp: Number(payload.exp ?? 0),
        iat: Number(payload.iat ?? 0),
        name: typeof payload.name === 'string' ? payload.name : undefined,
        picture: typeof payload.picture === 'string' ? payload.picture : undefined,
    };
}

/* ────────────── error class ────────────── */

export type GoogleOAuthErrorCode =
    | 'token_exchange_failed'
    | 'id_token_invalid'
    | 'id_token_expired'
    | 'id_token_bad_audience'
    | 'id_token_bad_issuer'
    | 'id_token_missing_sub'
    | 'id_token_missing_email'
    | 'email_not_verified';

export class GoogleOAuthError extends Error {
    constructor(
        public code: GoogleOAuthErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'GoogleOAuthError';
    }
}
