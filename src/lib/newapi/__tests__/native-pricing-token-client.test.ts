import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    copyChannelStrict,
    createTokenForCustomer,
    deleteChannelStrict,
    setChannelStatusStrict,
    getChannelPluginCredentialMetadataStrict,
} from '../client';

const fetchMock = vi.fn();
const auth = { accessToken: 'customer-token', userId: 17 };
beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('NEWAPI_ADMIN_TOKEN', 'admin-token');
    vi.stubEnv('NEWAPI_ADMIN_USER_ID', '1');
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: true, data: { id: 81 } })));
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('native pricing token contract', () => {
    it('passes the complete explicit auto list to the official customer token endpoint', async () => {
        await createTokenForCustomer(auth, {
            name: 'customer-key',
            group: 'auto',
            auto_groups: ['model-a', 'model-b'],
            cross_group_retry: false,
            unlimited_quota: true,
        });
        const [url, init] = fetchMock.mock.calls[0];
        expect(new URL(url).pathname).toBe('/api/token/');
        expect(new Headers(init.headers).get('new-api-user')).toBe('17');
        expect(JSON.parse(init.body)).toMatchObject({
            group: 'auto',
            auto_groups: ['model-a', 'model-b'],
            cross_group_retry: false,
            unlimited_quota: true,
        });
    });

    it.each([undefined, null, [], ['a', 'a'], ['auto'], [' a'], ['a,b']])(
        'refuses an unsafe auto group list %j before any request',
        async (groups) => {
            await expect(
                createTokenForCustomer(auth, { name: 'k', group: 'auto', auto_groups: groups }),
            ).rejects.toThrow('non-empty');
            expect(fetchMock).not.toHaveBeenCalled();
        },
    );

    it('does not silently discard auto settings for a concrete group', async () => {
        await expect(
            createTokenForCustomer(auth, { name: 'k', group: 'SD官转', auto_groups: ['private-a'] }),
        ).rejects.toThrow('Concrete-group');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('strict native replica lifecycle', () => {
    it('reads only official non-secret plugin metadata and strips any unexpected response fields', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    success: true,
                    data: {
                        items: [
                            {
                                index: 0,
                                label: '',
                                account_id: '',
                                expires_at: 0,
                                needs_login: false,
                                credential: 'DO_NOT_RETURN',
                            },
                        ],
                    },
                }),
            ),
        );
        const metadata = await getChannelPluginCredentialMetadataStrict(13);
        expect(metadata).toEqual([{ index: 0, label: '', account_id: '', expires_at: 0, needs_login: false }]);
        expect(new URL(fetchMock.mock.calls[0][0]).pathname).toBe('/api/channel/13/plugin_credentials');
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error' });
    });
    it('sanitizes malformed plugin metadata instead of embedding supplier response data into an error', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({ success: true, data: { items: [{ index: 'invalid', credential: 'SECRET' }] } }),
            ),
        );
        const error = await getChannelPluginCredentialMetadataStrict(13).catch((error: unknown) => error);
        expect(error).toMatchObject({ payload: null });
        expect(String(error)).not.toContain('SECRET');
    });
    it('pauses a replica through the status-only endpoint and verifies the result without rewriting settings', async () => {
        let current = 1;
        fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
            if (init.method === 'POST') {
                expect(new URL(url).pathname).toBe('/api/channel/81/status');
                expect(JSON.parse(String(init.body))).toEqual({ status: 2 });
                current = 2;
                return new Response(JSON.stringify({ success: true, data: true }));
            }
            return new Response(
                JSON.stringify({
                    success: true,
                    data: { id: 81, status: current, models: 'model-a', group: 'private-a', key: '' },
                }),
            );
        });
        await setChannelStatusStrict(81, 2);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(fetchMock.mock.calls.every(([, init]) => init.method !== 'PUT')).toBe(true);
    });

    it('does not accept a successful status response when the persisted status differs', async () => {
        fetchMock.mockImplementation(
            async (_url: string, init: RequestInit) =>
                new Response(
                    JSON.stringify({
                        success: true,
                        data: init.method === 'GET' ? { id: 81, status: 1 } : true,
                    }),
                ),
        );
        await expect(setChannelStatusStrict(81, 2)).rejects.toThrow('readback mismatch');
    });
    it('uses the native copy endpoint without passing a secret, and returns the verified new ID', async () => {
        await expect(copyChannelStrict(13, '_customer-model')).resolves.toBe(81);
        const [url, init] = fetchMock.mock.calls[0];
        expect(new URL(url).pathname).toBe('/api/channel/copy/13');
        expect(new URL(url).searchParams.get('suffix')).toBe('_customer-model');
        expect(new URL(url).searchParams.get('reset_balance')).toBe('true');
        expect(init).toMatchObject({ method: 'POST', cache: 'no-store', redirect: 'error' });
        expect(init.body).toBeUndefined();
    });

    it.each([{ success: false }, {}, { success: true }, { success: true, data: { id: 13 } }])(
        'refuses unconfirmed copy results %j',
        async (body) => {
            fetchMock.mockImplementation(async () => new Response(JSON.stringify(body)));
            await expect(copyChannelStrict(13, '_copy')).rejects.toThrow();
        },
    );

    it('requires successful deletion of the exact replica', async () => {
        await deleteChannelStrict(81);
        const [url, init] = fetchMock.mock.calls[0];
        expect(new URL(url).pathname).toBe('/api/channel/81');
        expect(init).toMatchObject({ method: 'DELETE', cache: 'no-store', redirect: 'error' });
        fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: false })));
        await expect(deleteChannelStrict(81)).rejects.toThrow();
    });
});
