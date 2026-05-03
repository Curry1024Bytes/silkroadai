/**
 * GitHub OAuth (OAuth2, NOT OIDC) helpers.
 *
 * Differences from `./google.ts`:
 *   - No id_token / no JWKS. After code↔token exchange we hit the GitHub REST
 *     API to learn who the user is.
 *   - No PKCE. GitHub's web flow doesn't support S256, so state CSRF cookie
 *     is the only forgery defense.
 *   - Email isn't on the user payload by default. /user.email may be null
 *     (privacy setting). We must call /user/emails and pick a row with
 *     primary=true AND verified=true; otherwise reject — we won't create
 *     accounts on unverified emails (same bar as Google).
 */

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_USER_URL = 'https://api.github.com/user';
export const GITHUB_USER_EMAILS_URL = 'https://api.github.com/user/emails';

import { randomBytes } from 'crypto';

/* ────────────── state ────────────── */

export function generateState(): string {
    return randomBytes(32).toString('hex');
}

/* ────────────── authorize URL ────────────── */

export function buildGitHubAuthorizeUrl(args: {
    clientId: string;
    redirectUri: string;
    state: string;
}): string {
    const u = new URL(GITHUB_AUTHORIZE_URL);
    u.searchParams.set('client_id', args.clientId);
    u.searchParams.set('redirect_uri', args.redirectUri);
    // read:user → /user payload; user:email → /user/emails endpoint access.
    u.searchParams.set('scope', 'read:user user:email');
    u.searchParams.set('state', args.state);
    u.searchParams.set('allow_signup', 'true');
    return u.toString();
}

/* ────────────── token exchange ────────────── */

export interface GitHubTokenResponse {
    access_token: string;
    token_type: string;
    scope: string;
}

export async function exchangeCodeForToken(args: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
}): Promise<GitHubTokenResponse> {
    // GitHub returns text/plain (form-urlencoded) by default; passing
    // Accept: application/json forces a clean JSON body.
    const res = await fetch(GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'silkroadai-portal',
        },
        body: JSON.stringify({
            client_id: args.clientId,
            client_secret: args.clientSecret,
            code: args.code,
            redirect_uri: args.redirectUri,
        }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new GitHubOAuthError(
            'token_exchange_failed',
            `GitHub token endpoint ${res.status}: ${text.slice(0, 300)}`,
        );
    }
    const json = (await res.json()) as Partial<GitHubTokenResponse> & { error?: string; error_description?: string };
    if (json.error || !json.access_token) {
        throw new GitHubOAuthError(
            'token_exchange_failed',
            `GitHub token endpoint error: ${json.error ?? 'no_access_token'} ${json.error_description ?? ''}`.trim(),
        );
    }
    return {
        access_token: json.access_token,
        token_type: json.token_type ?? 'bearer',
        scope: json.scope ?? '',
    };
}

/* ────────────── user identity fetch ────────────── */

export interface GitHubUserPayload {
    id: number;          // stable per-user identifier
    login: string;       // username
    name: string | null;
    avatar_url: string | null;
}

export interface GitHubEmailEntry {
    email: string;
    primary: boolean;
    verified: boolean;
    visibility: string | null;
}

const GITHUB_API_HEADERS = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'silkroadai-portal',
};

export async function fetchGitHubUser(accessToken: string): Promise<GitHubUserPayload> {
    const res = await fetch(GITHUB_USER_URL, {
        headers: { ...GITHUB_API_HEADERS, Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new GitHubOAuthError(
            'user_fetch_failed',
            `GitHub /user ${res.status}: ${text.slice(0, 300)}`,
        );
    }
    const json = (await res.json()) as Partial<GitHubUserPayload>;
    if (typeof json.id !== 'number' || typeof json.login !== 'string') {
        throw new GitHubOAuthError(
            'user_fetch_failed',
            `GitHub /user returned unexpected shape (id=${typeof json.id}, login=${typeof json.login})`,
        );
    }
    return {
        id: json.id,
        login: json.login,
        name: typeof json.name === 'string' ? json.name : null,
        avatar_url: typeof json.avatar_url === 'string' ? json.avatar_url : null,
    };
}

/**
 * Pick the user's primary verified email from /user/emails. Throws
 * `email_not_verified` when no row qualifies — matches our Google policy of
 * refusing to seat a portal user on an unverified email.
 */
export async function fetchGitHubVerifiedPrimaryEmail(accessToken: string): Promise<string> {
    const res = await fetch(GITHUB_USER_EMAILS_URL, {
        headers: { ...GITHUB_API_HEADERS, Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new GitHubOAuthError(
            'email_fetch_failed',
            `GitHub /user/emails ${res.status}: ${text.slice(0, 300)}`,
        );
    }
    const rows = (await res.json()) as GitHubEmailEntry[];
    if (!Array.isArray(rows)) {
        throw new GitHubOAuthError(
            'email_fetch_failed',
            'GitHub /user/emails returned non-array',
        );
    }
    const chosen = rows.find((e) => e?.primary === true && e?.verified === true);
    if (!chosen || typeof chosen.email !== 'string') {
        throw new GitHubOAuthError(
            'email_not_verified',
            'No primary+verified email on this GitHub account',
        );
    }
    return chosen.email.trim().toLowerCase();
}

/* ────────────── error class ────────────── */

export type GitHubOAuthErrorCode =
    | 'token_exchange_failed'
    | 'user_fetch_failed'
    | 'email_fetch_failed'
    | 'email_not_verified';

export class GitHubOAuthError extends Error {
    constructor(
        public code: GitHubOAuthErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'GitHubOAuthError';
    }
}
