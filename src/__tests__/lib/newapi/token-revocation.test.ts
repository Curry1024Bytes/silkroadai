import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteTokenForCustomerStrict, getTokenRevocationMetadataForCustomer } from '@/lib/newapi/client';
import {
    confirmAbsentStoredCustomerToken,
    confirmPreviouslyAbsentCustomerToken,
    inspectCustomerTokenForRevocation,
    inspectStoredCustomerToken,
    probeCustomerTokenCredential,
    revokeVerifiedCustomerToken,
    TokenRevocationError,
    type TokenRevocationMetadata,
} from '@/lib/newapi/token-revocation';

const fetchMock = vi.fn();
const auth = { accessToken: 'fixture-owner-pat-secret', userId: 23 };
const target = { tokenId: 71, ownerId: 23, group: 'CCMax（支持外接）' };
const metadata: TokenRevocationMetadata = { id: 71, user_id: 23, group: target.group, status: 1 };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const success = (data: unknown) => reply({ success: true, message: '', data });
const identity = () => success({ id: 23, status: 1, access_token: 'fixture-hidden-secret' });
const present = (patch = {}) => success({ ...metadata, key: 'fixture-api-key-secret', name: 'private', ...patch });
const missing = () => reply({ success: false, message: 'record not found' });
const methods = () => fetchMock.mock.calls.map(([, init]) => (init as RequestInit).method);
function enqueueInspect(token = present()) {
    fetchMock.mockResolvedValueOnce(identity()).mockResolvedValueOnce(token);
}

beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('read-only discovery does not infer an original group or grant DELETE authority', () => {
    const storedTarget = { tokenId: 71, ownerId: 23 };

    it.each([1, 2, 3, 4])('reports current group and present status %s using only safe metadata', async (status) => {
        enqueueInspect(present({ group: 'moved-to-B', status }));
        const result = await inspectStoredCustomerToken(auth, storedTarget);
        expect(result).toEqual({ state: 'present', token: { ...metadata, group: 'moved-to-B', status } });
        expect(JSON.stringify(result)).not.toContain('secret');
        expect(methods()).toEqual(['GET', 'GET']);
    });

    it.each([
        [{ user_id: 24 }, 'owner_mismatch'],
        [{ id: 72 }, 'token_mismatch'],
        [{ status: 0 }, 'remote_unavailable'],
        [{ group: null }, 'remote_unavailable'],
    ])('rejects untrusted discovery metadata %#', async (patch, code) => {
        enqueueInspect(present(patch));
        await expect(inspectStoredCustomerToken(auth, storedTarget)).rejects.toMatchObject({ code });
        expect(methods()).toEqual(['GET', 'GET']);
    });

    it.each([
        ['wrong self', () => success({ id: 24, status: 1 }), 'owner_mismatch'],
        ['disabled owner', () => success({ id: 23, status: 2 }), 'authentication_failed'],
        ['missing self', missing, 'unknown_response'],
        [
            'expired authentication',
            () => reply({ success: false, message: auth.accessToken }, 401),
            'authentication_failed',
        ],
    ])('stops discovery on %s before reading a token', async (_name, response, code) => {
        fetchMock.mockResolvedValueOnce(response());
        const error = await inspectStoredCustomerToken(auth, storedTarget).catch((error: unknown) => error);
        expect(error).toMatchObject({ code, stage: 'identity' });
        expect(JSON.stringify(error)).not.toContain('secret');
        expect(methods()).toEqual(['GET']);
    });

    it.each([{ tokenId: 0 }, { tokenId: 1.5 }, { ownerId: 24 }])(
        'rejects invalid stored identity %# without network traffic',
        async (patch) => {
            await expect(inspectStoredCustomerToken(auth, { ...storedTarget, ...patch })).rejects.toBeInstanceOf(
                TokenRevocationError,
            );
            expect(fetchMock).not.toHaveBeenCalled();
        },
    );

    it('recognizes only the exact authenticated rc.23 missing contract', async () => {
        enqueueInspect(missing());
        await expect(inspectStoredCustomerToken(auth, storedTarget)).resolves.toEqual({
            state: 'missing',
            scope: 'authenticated_owner',
        });
        expect(methods()).toEqual(['GET', 'GET']);
    });

    it.each([
        ['HTTP 404', () => reply({ success: false, message: 'record not found' }, 404)],
        ['HTTP 503', () => reply({ success: false, message: 'record not found' }, 503)],
        ['auth failure', () => reply({ success: false, message: 'record not found' }, 401)],
        ['unknown API code', () => reply({ success: false, message: 'record not found', code: 'UNKNOWN' })],
        [
            'contradictory data',
            () => reply({ success: false, message: 'record not found', data: { key: 'fixture-key-secret' } }),
        ],
        ['HTML', () => new Response('<html>fixture-key-secret</html>')],
    ])('keeps discovery %s unknown and strips unsafe payloads', async (_name, response) => {
        enqueueInspect(response());
        const error = await inspectStoredCustomerToken(auth, storedTarget).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(TokenRevocationError);
        expect(JSON.stringify(error)).not.toContain('secret');
        expect(String(error)).not.toContain('secret');
        expect(methods()).toEqual(['GET', 'GET']);
    });

    it('keeps network failure unknown without exposing error text', async () => {
        fetchMock.mockResolvedValueOnce(identity()).mockRejectedValueOnce(new Error('fixture-key-secret'));
        const error = await inspectStoredCustomerToken(auth, storedTarget).catch((error: unknown) => error);
        expect(error).toMatchObject({ code: 'remote_unavailable', retryable: true });
        expect(JSON.stringify(error)).not.toContain('secret');
        expect(methods()).toEqual(['GET', 'GET']);
    });

    it('retains the nonempty group requirement in all ordinary grouped operations', async () => {
        const emptyGroup = { ...target, group: '' };
        const storedLink = { ...storedTarget, kind: 'portal_stored_link' as const, apiKey: 'fixture-key-secret' };
        await expect(inspectCustomerTokenForRevocation(auth, emptyGroup)).rejects.toMatchObject({
            code: 'invalid_target',
        });
        await expect(revokeVerifiedCustomerToken(auth, emptyGroup, metadata, storedLink.apiKey)).rejects.toMatchObject({
            code: 'invalid_target',
        });
        await expect(confirmPreviouslyAbsentCustomerToken(auth, emptyGroup, storedLink)).rejects.toMatchObject({
            code: 'invalid_target',
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('archive-only confirmation requires genuine absence without a group name', () => {
    const storedTarget = { tokenId: 71, ownerId: 23 };
    const storedLink = { ...storedTarget, kind: 'portal_stored_link' as const, apiKey: 'fixture-key-secret' };

    it('confirms a previously absent record without inventing a group or sending DELETE', async () => {
        enqueueInspect(missing());
        fetchMock.mockResolvedValueOnce(reply({ success: false, message: 'Invalid token' }, 401));
        const result = await confirmAbsentStoredCustomerToken(auth, storedTarget, storedLink);
        expect(result).toEqual({
            state: 'already_absent',
            ownershipEvidence: 'portal_stored_link',
            credential: 'rejected_unclassified',
            deleteAcknowledged: false,
        });
        expect(JSON.stringify(result)).not.toContain('secret');
        expect(methods()).toEqual(['GET', 'GET', 'GET']);
    });

    it.each([1, 2, 3, 4])('blocks a present record in group B even at remote status %s', async (status) => {
        enqueueInspect(present({ group: 'moved-to-B', status }));
        await expect(confirmAbsentStoredCustomerToken(auth, storedTarget, storedLink)).rejects.toMatchObject({
            code: 'token_still_present',
            retryable: false,
        });
        expect(methods()).toEqual(['GET', 'GET']);
    });

    it.each([{ tokenId: 72 }, { ownerId: 24 }, { apiKey: '' }, { apiKey: 'sk-secret\r\nsecret' }])(
        'rejects untrusted stored binding %# before any request',
        async (patch) => {
            await expect(
                confirmAbsentStoredCustomerToken(auth, storedTarget, { ...storedLink, ...patch }),
            ).rejects.toMatchObject({
                code: 'invalid_target',
            });
            expect(fetchMock).not.toHaveBeenCalled();
        },
    );

    it('blocks while cache still accepts a credential despite exact record absence', async () => {
        enqueueInspect(missing());
        fetchMock.mockResolvedValueOnce(reply({ code: true, data: { object: 'token_usage' } }));
        await expect(confirmAbsentStoredCustomerToken(auth, storedTarget, storedLink)).rejects.toMatchObject({
            code: 'credential_still_accepted',
            retryable: true,
        });
        expect(methods()).toEqual(['GET', 'GET', 'GET']);
    });

    it.each([403, 404, 429, 500, 503])('does not equate credential HTTP %s with confirmed absence', async (status) => {
        enqueueInspect(missing());
        fetchMock.mockResolvedValueOnce(reply({ success: false, message: 'fixture-key-secret' }, status));
        const error = await confirmAbsentStoredCustomerToken(auth, storedTarget, storedLink).catch(
            (error: unknown) => error,
        );
        expect(error).toMatchObject({ code: 'credential_check_unconfirmed', retryable: true });
        expect(JSON.stringify(error)).not.toContain('secret');
        expect(methods()).toEqual(['GET', 'GET', 'GET']);
    });

    it('rechecks real management absence and blocks a record that appears on retry', async () => {
        enqueueInspect(missing());
        fetchMock.mockResolvedValueOnce(reply({ success: false, message: 'Invalid token' }, 401));
        await expect(confirmAbsentStoredCustomerToken(auth, storedTarget, storedLink)).resolves.toMatchObject({
            state: 'already_absent',
        });
        enqueueInspect(present({ group: 'newly-moved-B' }));
        await expect(confirmAbsentStoredCustomerToken(auth, storedTarget, storedLink)).rejects.toMatchObject({
            code: 'token_still_present',
        });
        expect(methods()).toEqual(['GET', 'GET', 'GET', 'GET', 'GET']);
    });

    it('does not probe credentials after an unconfirmed management response', async () => {
        enqueueInspect(reply({ success: false, message: 'record not found' }, 404));
        await expect(confirmAbsentStoredCustomerToken(auth, storedTarget, storedLink)).rejects.toBeInstanceOf(
            TokenRevocationError,
        );
        expect(methods()).toEqual(['GET', 'GET']);
    });
});
describe('strict rc.23 management reads and acknowledgement', () => {
    it('returns only safe token metadata from the real nested token envelope', async () => {
        fetchMock.mockResolvedValueOnce(present());
        await expect(getTokenRevocationMetadataForCustomer(auth, 71)).resolves.toEqual(metadata);
        const request = fetchMock.mock.calls[0][1] as RequestInit;
        expect(request).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error' });
        expect(request.headers).toMatchObject({ Authorization: auth.accessToken, 'New-Api-User': '23' });
        expect(request.signal).toBeInstanceOf(AbortSignal);
        expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/token\/71$/);
    });

    it.each([
        ['HTML', '<html>login</html>'],
        ['empty envelope', '{}'],
        ['nonboolean acknowledgement', '{"success":"yes"}'],
        ['application rejection', '{"success":false,"message":"record not found"}'],
    ])('never treats DELETE %s as success', async (_name, body) => {
        fetchMock.mockResolvedValueOnce(new Response(body));
        await expect(deleteTokenForCustomerStrict(auth, 71)).rejects.toThrow();
        expect(methods()).toEqual(['DELETE']);
    });

    it('rejects bare HTTP 204 and accepts explicit success only', async () => {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
        await expect(deleteTokenForCustomerStrict(auth, 71)).rejects.toThrow();
        fetchMock.mockResolvedValueOnce(reply({ success: true, message: '' }));
        await expect(deleteTokenForCustomerStrict(auth, 71)).resolves.toBeUndefined();
    });

    it.each([null, {}, { ...metadata, user_id: '23' }, { ...metadata, status: 0 }, { ...metadata, group: null }])(
        'rejects unconfirmed token data %#',
        async (data) => {
            fetchMock.mockResolvedValueOnce(success(data));
            await expect(getTokenRevocationMetadataForCustomer(auth, 71)).rejects.toThrow();
        },
    );
});

describe('authenticated owner and group evidence', () => {
    it('validates real owner identity and strips secret fields', async () => {
        enqueueInspect();
        const result = await inspectCustomerTokenForRevocation(auth, target);
        expect(result).toEqual({ state: 'present', token: metadata });
        expect(JSON.stringify(result)).not.toContain('secret');
        expect(methods()).toEqual(['GET', 'GET']);
        expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/user\/self$/);
    });

    it('recognizes exact rc.23 HTTP 200 record-not-found only as owner-scoped absence', async () => {
        enqueueInspect(missing());
        await expect(inspectCustomerTokenForRevocation(auth, target)).resolves.toEqual({
            state: 'missing',
            scope: 'authenticated_owner',
        });
    });

    it.each([
        ['plain HTTP 404', () => new Response('record not found', { status: 404 })],
        ['404 JSON', () => reply({ success: false, message: 'record not found' }, 404)],
        ['HTTP 500', () => reply({ success: false, message: 'record not found' }, 500)],
        ['unrelated message', () => reply({ success: false, message: 'token not found' })],
        ['auth failure', () => reply({ success: false, message: 'record not found' }, 401)],
        ['contradictory auth code', () => reply({ success: false, message: 'record not found', code: 'AUTH_INVALID' })],
        ['contradictory data', () => reply({ success: false, message: 'record not found', data: metadata })],
        ['malformed success', () => reply({ success: true, data: null })],
    ])('does not classify %s as missing', async (_name, response) => {
        enqueueInspect(response());
        await expect(inspectCustomerTokenForRevocation(auth, target)).rejects.toBeInstanceOf(TokenRevocationError);
    });

    it.each([401, 403])('reports authentication failure %s without exposing upstream body', async (status) => {
        fetchMock.mockResolvedValueOnce(reply({ success: false, message: auth.accessToken }, status));
        const error = await inspectCustomerTokenForRevocation(auth, target).catch((error: unknown) => error);
        expect(error).toMatchObject({ code: 'authentication_failed', stage: 'identity', httpStatus: status });
        expect(JSON.stringify(error)).not.toContain(auth.accessToken);
        expect(String(error)).not.toContain(auth.accessToken);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not let a missing self identity masquerade as a missing token', async () => {
        fetchMock.mockResolvedValueOnce(missing());
        await expect(inspectCustomerTokenForRevocation(auth, target)).rejects.toMatchObject({
            code: 'unknown_response',
            stage: 'identity',
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['wrong self', { id: 24, status: 1 }, 'owner_mismatch'],
        ['disabled owner', { id: 23, status: 2 }, 'authentication_failed'],
    ])('stops on %s before requesting the token', async (_name, self, code) => {
        fetchMock.mockResolvedValueOnce(success(self));
        await expect(inspectCustomerTokenForRevocation(auth, target)).rejects.toMatchObject({ code });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
        [{ user_id: 24 }, 'owner_mismatch'],
        [{ id: 72 }, 'token_mismatch'],
        [{ group: 'another-group' }, 'group_mismatch'],
    ])('stops on mismatched token metadata %#', async (patch, code) => {
        enqueueInspect(present(patch));
        await expect(inspectCustomerTokenForRevocation(auth, target)).rejects.toMatchObject({ code, retryable: false });
        expect(methods()).not.toContain('DELETE');
    });

    it('rejects a mismatched supplied owner without any network request', async () => {
        await expect(inspectCustomerTokenForRevocation({ ...auth, userId: 24 }, target)).rejects.toMatchObject({
            code: 'owner_mismatch',
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('verified record removal and uncertain responses', () => {
    it.each([1, 2, 3, 4])(
        'removes remote status %s rather than treating disabled/expired as deleted',
        async (status) => {
            enqueueInspect(present({ status }));
            fetchMock.mockResolvedValueOnce(reply({ success: true }));
            enqueueInspect(missing());
            fetchMock.mockResolvedValueOnce(reply({ success: false, message: 'Invalid token' }, 401));
            await expect(revokeVerifiedCustomerToken(auth, target, metadata, 'fixture-key-secret')).resolves.toEqual({
                state: 'revoked',
                confirmation: 'deleted',
                deleteAcknowledged: true,
            });
            expect(methods()).toEqual(['GET', 'GET', 'DELETE', 'GET', 'GET', 'GET']);
        },
    );

    it('requires prior remote metadata even when the local caller would call the key disabled', async () => {
        await expect(
            revokeVerifiedCustomerToken(
                auth,
                target,
                undefined as unknown as TokenRevocationMetadata,
                'fixture-key-secret',
            ),
        ).rejects.toMatchObject({ code: 'token_mismatch' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('resolves retry-time scoped absence only with the persisted owner/group evidence', async () => {
        enqueueInspect(missing());
        fetchMock.mockResolvedValueOnce(reply({ success: false, message: 'Invalid token' }, 401));
        await expect(revokeVerifiedCustomerToken(auth, target, metadata, 'fixture-key-secret')).resolves.toEqual({
            state: 'revoked',
            confirmation: 'already_missing',
            deleteAcknowledged: false,
        });
        expect(methods()).toEqual(['GET', 'GET', 'GET']);
    });

    it('checks fresh group before sending DELETE even when prior evidence matched', async () => {
        enqueueInspect(present({ group: 'moved-elsewhere' }));
        await expect(revokeVerifiedCustomerToken(auth, target, metadata, 'fixture-key-secret')).rejects.toMatchObject({
            code: 'group_mismatch',
        });
        expect(methods()).not.toContain('DELETE');
    });

    it('reconciles a DELETE timeout by read-back without retrying the write', async () => {
        enqueueInspect();
        fetchMock.mockRejectedValueOnce(new DOMException('fixture-secret', 'TimeoutError'));
        enqueueInspect(missing());
        fetchMock.mockResolvedValueOnce(reply({ success: false, message: 'Invalid token' }, 401));
        await expect(revokeVerifiedCustomerToken(auth, target, metadata, 'fixture-key-secret')).resolves.toMatchObject({
            state: 'revoked',
            deleteAcknowledged: false,
        });
        expect(methods().filter((method) => method === 'DELETE')).toHaveLength(1);
    });

    it('does not complete an acknowledged DELETE while the record remains', async () => {
        enqueueInspect();
        fetchMock.mockResolvedValueOnce(reply({ success: true }));
        enqueueInspect(present({ status: 2 }));
        await expect(revokeVerifiedCustomerToken(auth, target, metadata, 'fixture-key-secret')).rejects.toMatchObject({
            code: 'delete_not_confirmed',
            stage: 'verify',
        });
    });

    it('does not complete an acknowledged DELETE when verification is HTTP 404', async () => {
        enqueueInspect();
        fetchMock.mockResolvedValueOnce(reply({ success: true }));
        enqueueInspect(reply({ success: false, message: 'record not found' }, 404));
        await expect(revokeVerifiedCustomerToken(auth, target, metadata, 'fixture-key-secret')).rejects.toMatchObject({
            stage: 'verify',
        });
    });

    it('preserves unknown outcome when DELETE and read-back both fail', async () => {
        enqueueInspect();
        fetchMock.mockRejectedValueOnce(new TypeError('fixture-key-secret'));
        fetchMock.mockRejectedValueOnce(new TypeError('fixture-owner-secret'));
        const error = await revokeVerifiedCustomerToken(auth, target, metadata, 'fixture-key-secret').catch(
            (error: unknown) => error,
        );
        expect(error).toMatchObject({ code: 'remote_unavailable', stage: 'verify', retryable: true });
        expect(JSON.stringify(error)).not.toContain('secret');
    });

    it.each([
        ['accepted cache', () => reply({ code: true, data: { object: 'token_usage' } }), 'credential_still_accepted'],
        [
            'unknown server failure',
            () => reply({ success: false, message: 'fixture-key-secret' }, 503),
            'credential_check_unconfirmed',
        ],
    ])('does not finish after DELETE and DB absence with %s', async (_name, credential, code) => {
        enqueueInspect();
        fetchMock.mockResolvedValueOnce(reply({ success: true }));
        enqueueInspect(missing());
        fetchMock.mockResolvedValueOnce(credential());
        const error = await revokeVerifiedCustomerToken(auth, target, metadata, 'fixture-key-secret').catch(
            (error: unknown) => error,
        );
        expect(error).toMatchObject({ code, stage: 'verify', retryable: true });
        expect(JSON.stringify(error)).not.toContain('secret');
        expect(methods().filter((method) => method === 'DELETE')).toHaveLength(1);
    });
});

describe('non-billable credential probe has no deletion/owner authority', () => {
    it('reports continued cache acceptance without reading balances as revocation evidence', async () => {
        fetchMock.mockResolvedValueOnce(
            reply({ code: true, data: { object: 'token_usage', expires_at: 1, total_available: 0 } }),
        );
        await expect(probeCustomerTokenCredential('fixture-key-secret')).resolves.toEqual({ state: 'accepted' });
        expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/usage\/token\/$/);
        expect(fetchMock.mock.calls[0][1]).toMatchObject({
            method: 'GET',
            redirect: 'error',
            cache: 'no-store',
            headers: { Authorization: 'Bearer sk-fixture-key-secret' },
        });
    });

    it.each(['Invalid token', 'Token status unavailable', 'Token expired', 'Quota exceeded'])(
        'never translates rc.23 unstructured 401 %s into deleted',
        async (message) => {
            fetchMock.mockResolvedValueOnce(reply({ success: false, message }, 401));
            await expect(probeCustomerTokenCredential('sk-existing')).resolves.toEqual({
                state: 'rejected_unclassified',
                httpStatus: 401,
            });
        },
    );

    it.each([403, 404, 429, 500, 503])('keeps status %s unknown', async (status) => {
        fetchMock.mockResolvedValueOnce(reply({ success: false, message: 'Invalid token' }, status));
        await expect(probeCustomerTokenCredential('sk-existing')).resolves.toEqual({
            state: 'unknown',
            httpStatus: status,
        });
    });

    it('does not guess from proxy HTML, a malformed success or a network exception', async () => {
        fetchMock.mockResolvedValueOnce(new Response('<html>denied</html>', { status: 401 }));
        await expect(probeCustomerTokenCredential('sk-existing')).resolves.toEqual({ state: 'unknown' });
        fetchMock.mockResolvedValueOnce(reply({ code: 'true', data: { object: 'token_usage' } }));
        await expect(probeCustomerTokenCredential('sk-existing')).resolves.toEqual({
            state: 'unknown',
            httpStatus: 200,
        });
        fetchMock.mockRejectedValueOnce(new Error('sk-existing'));
        await expect(probeCustomerTokenCredential('sk-existing')).resolves.toEqual({ state: 'unknown' });
    });

    it('never sends an absent or malformed stored key', async () => {
        await expect(probeCustomerTokenCredential('')).resolves.toEqual({ state: 'unknown' });
        await expect(probeCustomerTokenCredential('sk-invalid\r\nsecret')).resolves.toEqual({ state: 'unknown' });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('historical Portal binding resolves genuinely already-absent keys separately', () => {
    const storedLink = { kind: 'portal_stored_link' as const, tokenId: 71, ownerId: 23, apiKey: 'fixture-key-secret' };

    it('requires the persisted binding, authenticated scoped absence and credential rejection', async () => {
        enqueueInspect(missing());
        fetchMock.mockResolvedValueOnce(reply({ success: false, message: 'Invalid token' }, 401));
        const result = await confirmPreviouslyAbsentCustomerToken(auth, target, storedLink);
        expect(result).toEqual({
            state: 'already_absent',
            ownershipEvidence: 'portal_stored_link',
            credential: 'rejected_unclassified',
            deleteAcknowledged: false,
        });
        expect(JSON.stringify(result)).not.toContain('secret');
        expect(methods()).toEqual(['GET', 'GET', 'GET']);
    });

    it.each([{ tokenId: 72 }, { ownerId: 24 }, { apiKey: '' }])(
        'rejects a mismatched stored link %#',
        async (patch) => {
            await expect(
                confirmPreviouslyAbsentCustomerToken(auth, target, { ...storedLink, ...patch }),
            ).rejects.toMatchObject({
                code: 'invalid_target',
            });
            expect(fetchMock).not.toHaveBeenCalled();
        },
    );

    it('cannot archive a locally disabled key when its management record still exists', async () => {
        enqueueInspect(present({ status: 2 }));
        await expect(confirmPreviouslyAbsentCustomerToken(auth, target, storedLink)).rejects.toMatchObject({
            code: 'token_still_present',
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('cannot archive a missing management record while Redis still accepts the credential', async () => {
        enqueueInspect(missing());
        fetchMock.mockResolvedValueOnce(reply({ code: true, data: { object: 'token_usage' } }));
        await expect(confirmPreviouslyAbsentCustomerToken(auth, target, storedLink)).rejects.toMatchObject({
            code: 'credential_still_accepted',
            retryable: true,
        });
    });

    it.each([403, 404, 429, 500, 503])('does not equate credential status %s with already absent', async (status) => {
        enqueueInspect(missing());
        fetchMock.mockResolvedValueOnce(reply({ success: false, message: 'Invalid token' }, status));
        await expect(confirmPreviouslyAbsentCustomerToken(auth, target, storedLink)).rejects.toMatchObject({
            code: 'credential_check_unconfirmed',
        });
    });

    it('keeps an authenticated-scope 404 unknown regardless of the stored binding', async () => {
        enqueueInspect(reply({ success: false, message: 'record not found' }, 404));
        await expect(confirmPreviouslyAbsentCustomerToken(auth, target, storedLink)).rejects.toBeInstanceOf(
            TokenRevocationError,
        );
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe('durable worker checks immediately before a remote DELETE', () => {
    it('does not send DELETE or reinterpret a rejected lease guard as remote acknowledgement', async () => {
        enqueueInspect();
        const expired = new Error('worker lease expired');
        const guard = vi.fn().mockRejectedValue(expired);
        await expect(revokeVerifiedCustomerToken(auth, target, metadata, 'fixture-key-secret', guard)).rejects.toBe(
            expired,
        );
        expect(guard).toHaveBeenCalledTimes(1);
        expect(methods()).toEqual(['GET', 'GET']);
    });

    it('does not record new DELETE intent when a previously verified token is already absent', async () => {
        enqueueInspect(missing());
        fetchMock.mockResolvedValueOnce(reply({ success: false, message: 'Invalid token' }, 401));
        const guard = vi.fn();
        await expect(
            revokeVerifiedCustomerToken(auth, target, metadata, 'fixture-key-secret', guard),
        ).resolves.toMatchObject({ confirmation: 'already_missing' });
        expect(guard).not.toHaveBeenCalled();
        expect(methods()).toEqual(['GET', 'GET', 'GET']);
    });
});
