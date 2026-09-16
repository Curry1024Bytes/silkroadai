import 'server-only';
import {
    deleteTokenForCustomerStrict,
    getTokenRevocationCustomerIdentity,
    getTokenRevocationMetadataForCustomer,
    NewApiError,
    type TokenRevocationMetadata,
} from './client';

export type { TokenRevocationMetadata } from './client';
export interface TokenRevocationTarget {
    tokenId: number;
    ownerId: number;
    group: string;
}
export interface TokenRevocationAuth {
    accessToken: string;
    userId: number;
}
export type TokenRevocationStage = 'identity' | 'inspect' | 'delete' | 'verify';
export type TokenRevocationErrorCode =
    | 'invalid_target'
    | 'authentication_failed'
    | 'owner_mismatch'
    | 'token_mismatch'
    | 'group_mismatch'
    | 'unknown_response'
    | 'remote_unavailable'
    | 'delete_not_confirmed'
    | 'token_still_present'
    | 'credential_still_accepted'
    | 'credential_check_unconfirmed';

/** Safe to persist in a job: no upstream body, key, auth token or Error.cause. */
export class TokenRevocationError extends Error {
    constructor(
        public readonly code: TokenRevocationErrorCode,
        public readonly stage: TokenRevocationStage,
        public readonly retryable: boolean,
        public readonly httpStatus?: number,
    ) {
        super(code);
        this.name = 'TokenRevocationError';
    }
}

export type TokenRevocationInspection =
    | { state: 'present'; token: TokenRevocationMetadata }
    // id+user_id query: absence in this authenticated scope is not global absence.
    | { state: 'missing'; scope: 'authenticated_owner' };

function positiveId(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0;
}

function validateTarget(auth: TokenRevocationAuth, target: TokenRevocationTarget): void {
    if (
        !auth ||
        !target ||
        !positiveId(auth.userId) ||
        !positiveId(target.tokenId) ||
        !positiveId(target.ownerId) ||
        typeof auth.accessToken !== 'string' ||
        !auth.accessToken.trim() ||
        typeof target.group !== 'string' ||
        !target.group.trim()
    ) {
        throw new TokenRevocationError('invalid_target', 'identity', false);
    }
    if (auth.userId !== target.ownerId) {
        throw new TokenRevocationError('owner_mismatch', 'identity', false);
    }
}

function assertIdentity(
    token: TokenRevocationMetadata,
    target: TokenRevocationTarget,
    stage: TokenRevocationStage,
): void {
    if (!token || token.id !== target.tokenId) throw new TokenRevocationError('token_mismatch', stage, false);
    if (token.user_id !== target.ownerId) throw new TokenRevocationError('owner_mismatch', stage, false);
    if (token.group !== target.group) throw new TokenRevocationError('group_mismatch', stage, false);
    if (![1, 2, 3, 4].includes(token.status)) throw new TokenRevocationError('invalid_target', stage, false);
}

/** Exact controller/token.go -> common.ApiError -> gorm.ErrRecordNotFound contract. */
function isScopedRecordMissing(error: unknown, tokenId: number): boolean {
    if (!(error instanceof NewApiError) || error.status !== 200 || error.endpoint !== `GET /api/token/${tokenId}`) {
        return false;
    }
    const envelope = error.payload;
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return false;
    const value = envelope as Record<string, unknown>;
    return (
        value.success === false &&
        value.message === 'record not found' &&
        value.data == null &&
        !Object.hasOwn(value, 'code')
    );
}

function safeError(error: unknown, stage: TokenRevocationStage): TokenRevocationError {
    if (error instanceof TokenRevocationError) return error;
    if (error instanceof NewApiError) {
        if (error.status === 401 || error.status === 403) {
            return new TokenRevocationError('authentication_failed', stage, false, error.status);
        }
        if (error.status === 429 || error.status >= 500) {
            return new TokenRevocationError('remote_unavailable', stage, true, error.status);
        }
        return new TokenRevocationError('unknown_response', stage, true, error.status);
    }
    return new TokenRevocationError('remote_unavailable', stage, true);
}

/** Caller must persist a successful identity read before sending any DELETE. */
export async function inspectCustomerTokenForRevocation(
    auth: TokenRevocationAuth,
    target: TokenRevocationTarget,
): Promise<TokenRevocationInspection> {
    validateTarget(auth, target);
    try {
        const identity = await getTokenRevocationCustomerIdentity(auth);
        if (identity.id !== target.ownerId) throw new TokenRevocationError('owner_mismatch', 'identity', false);
        if (identity.status !== 1) throw new TokenRevocationError('authentication_failed', 'identity', false);
    } catch (error) {
        throw safeError(error, 'identity');
    }
    try {
        const token = await getTokenRevocationMetadataForCustomer(auth, target.tokenId);
        assertIdentity(token, target, 'inspect');
        return { state: 'present', token };
    } catch (error) {
        if (isScopedRecordMissing(error, target.tokenId)) return { state: 'missing', scope: 'authenticated_owner' };
        throw safeError(error, 'inspect');
    }
}

export interface VerifiedTokenRevocation {
    state: 'revoked';
    confirmation: 'deleted' | 'already_missing';
    deleteAcknowledged: boolean;
}

/**
 * `verified` must come from the durable job's successful remote metadata read,
 * never from local status/tier. A scoped missing response cannot establish that
 * evidence. After uncertain DELETE, read back instead of automatically retrying.
 *
 * This requires the management record to be removed and the stored credential
 * to be rejected by the read-only usage endpoint. new-api invalidates Redis
 * asynchronously: continued acceptance or an unknown probe remains retryable.
 * Existing in-flight inference is outside this management endpoint's contract.
 */
export async function revokeVerifiedCustomerToken(
    auth: TokenRevocationAuth,
    target: TokenRevocationTarget,
    verified: TokenRevocationMetadata,
    apiKey: string,
    beforeDelete?: () => Promise<void>,
): Promise<VerifiedTokenRevocation> {
    validateTarget(auth, target);
    assertIdentity(verified, target, 'inspect');
    if (!validApiKey(apiKey)) throw new TokenRevocationError('invalid_target', 'inspect', false);
    const before = await inspectCustomerTokenForRevocation(auth, target);
    if (before.state === 'missing') {
        await requireCredentialRejection(apiKey);
        return { state: 'revoked', confirmation: 'already_missing', deleteAcknowledged: false };
    }
    // The durable runner must still own its lease immediately before a remote write.
    // A guard rejection is not an uncertain DELETE and must not be swallowed.
    await beforeDelete?.();
    let deleteAcknowledged = false;
    let deletionError: TokenRevocationError | undefined;
    try {
        await deleteTokenForCustomerStrict(auth, target.tokenId);
        deleteAcknowledged = true;
    } catch (error) {
        deletionError = safeError(error, 'delete');
    }
    let after: TokenRevocationInspection;
    try {
        after = await inspectCustomerTokenForRevocation(auth, target);
    } catch (error) {
        const safe = safeError(error, 'verify');
        throw new TokenRevocationError(safe.code, 'verify', safe.retryable, safe.httpStatus);
    }
    if (after.state === 'missing') {
        await requireCredentialRejection(apiKey);
        return { state: 'revoked', confirmation: 'deleted', deleteAcknowledged };
    }
    throw deletionError ?? new TokenRevocationError('delete_not_confirmed', 'verify', true);
}

export type TokenCredentialProbe =
    | { state: 'accepted' }
    | { state: 'rejected_unclassified'; httpStatus: 401 }
    | { state: 'unknown'; httpStatus?: number };

function validApiKey(value: string): boolean {
    return typeof value === 'string' && Boolean(value.trim()) && value === value.trim() && !/\s/.test(value);
}

async function requireCredentialRejection(apiKey: string): Promise<void> {
    const credential = await probeCustomerTokenCredential(apiKey);
    if (credential.state === 'accepted') {
        throw new TokenRevocationError('credential_still_accepted', 'verify', true);
    }
    if (credential.state !== 'rejected_unclassified') {
        throw new TokenRevocationError('credential_check_unconfirmed', 'verify', true, credential.httpStatus);
    }
}

/**
 * A non-billable, read-only probe of the existing key. rc.23's usage endpoint
 * exposes neither token identity nor a stable machine code on 401, so rejection
 * cannot prove deletion, ownership, or permanent revocation. In particular it
 * must not promote an unverified owner-scoped missing record into `revoked`.
 */
export async function probeCustomerTokenCredential(apiKey: string): Promise<TokenCredentialProbe> {
    if (!validApiKey(apiKey)) {
        return { state: 'unknown' };
    }
    try {
        const base = new URL(process.env.NEWAPI_BASE_URL || 'http://localhost:3000');
        if (
            !['http:', 'https:'].includes(base.protocol) ||
            base.username ||
            base.password ||
            base.search ||
            base.hash
        ) {
            return { state: 'unknown' };
        }
        const response = await fetch(new URL('/api/usage/token/', base), {
            method: 'GET',
            headers: { Authorization: `Bearer ${apiKey.startsWith('sk-') ? apiKey : `sk-${apiKey}`}` },
            cache: 'no-store',
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
        });
        const body: unknown = await response.json();
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return { state: 'unknown', httpStatus: response.status };
        }
        const value = body as Record<string, unknown>;
        const data = value.data as Record<string, unknown> | undefined;
        if (
            response.status === 200 &&
            value.code === true &&
            (value.success === undefined || value.success === true) &&
            data &&
            typeof data === 'object' &&
            !Array.isArray(data) &&
            data.object === 'token_usage'
        ) {
            return { state: 'accepted' };
        }
        if (response.status === 401 && value.success === false && typeof value.message === 'string') {
            return { state: 'rejected_unclassified', httpStatus: 401 };
        }
        return { state: 'unknown', httpStatus: response.status };
    } catch {
        return { state: 'unknown' };
    }
}

export interface TokenRevocationStoredLink {
    kind: 'portal_stored_link';
    tokenId: number;
    ownerId: number;
    apiKey: string;
}

export interface PreviouslyAbsentCustomerToken {
    state: 'already_absent';
    ownershipEvidence: 'portal_stored_link';
    credential: 'rejected_unclassified';
    deleteAcknowledged: false;
}

/**
 * A trusted persisted NewApiToken -> User association is historical ownership
 * evidence: new-api creates with the authenticated owner and a fresh ID; its
 * update allowlist never changes ID/owner/key, and deletion is soft. This holds
 * for normal management APIs, not out-of-band SQL repairs or database restores.
 *
 * Caller must read this link and key from its tenant-scoped database relation;
 * a client-supplied link is not evidence. The local active/disabled status does
 * not establish absence. Require current owner authentication, exact scoped
 * management absence and a rejected credential as three independent checks.
 * This is an already-absent historical key, never a DELETE performed by this job.
 */
export async function confirmPreviouslyAbsentCustomerToken(
    auth: TokenRevocationAuth,
    target: TokenRevocationTarget,
    storedLink: TokenRevocationStoredLink,
): Promise<PreviouslyAbsentCustomerToken> {
    validateTarget(auth, target);
    if (
        !storedLink ||
        storedLink.kind !== 'portal_stored_link' ||
        storedLink.tokenId !== target.tokenId ||
        storedLink.ownerId !== target.ownerId ||
        !validApiKey(storedLink.apiKey)
    ) {
        throw new TokenRevocationError('invalid_target', 'inspect', false);
    }
    const inspection = await inspectCustomerTokenForRevocation(auth, target);
    if (inspection.state !== 'missing') {
        throw new TokenRevocationError('token_still_present', 'verify', false);
    }
    await requireCredentialRejection(storedLink.apiKey);
    return {
        state: 'already_absent',
        ownershipEvidence: 'portal_stored_link',
        credential: 'rejected_unclassified',
        deleteAcknowledged: false,
    };
}
