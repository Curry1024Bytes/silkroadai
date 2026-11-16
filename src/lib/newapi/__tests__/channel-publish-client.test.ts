import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewApiError, getChannelStrict, updateChannelStrict, type NewApiChannel } from '../client';

const requests: { url: string; init?: RequestInit; body: unknown }[] = [];

function response(envelope: unknown, status = 200) {
    return new Response(JSON.stringify(envelope), { status });
}

beforeEach(() => {
    requests.length = 0;
    vi.stubEnv('NEWAPI_ADMIN_TOKEN', 'admin-secret');
    vi.stubEnv('NEWAPI_ADMIN_USER_ID', '7');
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const rawBody = init?.body;
            requests.push({
                url: String(input),
                init,
                body: typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody,
            });
            return response({ success: true, data: { id: 12, name: 'channel', models: 'other-model' } });
        }),
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('strict channel publication client', () => {
    it('reads a fresh complete channel without following redirects and requires success envelope', async () => {
        const channel = await getChannelStrict(12);
        expect(channel).toEqual({ id: 12, name: 'channel', models: 'other-model' });
        expect(requests).toHaveLength(1);
        expect(requests[0].url).toMatch(/\/api\/channel\/12$/);
        expect(requests[0].init).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error' });
        expect(new Headers(requests[0].init?.headers).get('authorization')).toBe('admin-secret');
        expect(new Headers(requests[0].init?.headers).get('new-api-user')).toBe('7');
    });

    it.each([{ success: false, data: { id: 12 } }, { data: { id: 12 } }, { success: true }])(
        'rejects a non-confirmed or incomplete channel read: %j',
        async (envelope) => {
            vi.stubGlobal(
                'fetch',
                vi.fn(async () => response(envelope)),
            );
            await expect(getChannelStrict(12)).rejects.toBeInstanceOf(NewApiError);
        },
    );

    it('writes the full channel object and requires an explicit success envelope', async () => {
        const channel: NewApiChannel = {
            id: 12,
            name: 'channel',
            models: 'other-model,gpt-test',
            model_mapping: '{"gpt-test":"upstream-gpt"}',
            key: 'retained-sensitive-value',
        };
        await updateChannelStrict(channel);
        expect(requests).toHaveLength(1);
        expect(requests[0].url).toMatch(/\/api\/channel\/$/);
        expect(requests[0].init).toMatchObject({ method: 'PUT', redirect: 'error' });
        expect(requests[0].body).toEqual(channel);
    });

    it('strips the read-only status field while preserving the complete channel payload', async () => {
        const channel: NewApiChannel = {
            id: 12,
            name: 'channel',
            status: 1,
            group: 'cheap-group',
            priority: 10,
            weight: 8,
            models: 'gpt-test',
            model_mapping: null,
            key: '',
        };
        await updateChannelStrict(channel);
        expect(requests[0].body).toEqual({
            id: 12,
            name: 'channel',
            group: 'cheap-group',
            priority: 10,
            weight: 8,
            models: 'gpt-test',
            model_mapping: null,
            key: '',
        });
        expect(requests[0].body).not.toHaveProperty('status');
    });

    it.each([{ success: false, message: 'rejected' }, { data: { updated: true } }])(
        'rejects a PUT without an explicit successful envelope: %j',
        async (envelope) => {
            vi.stubGlobal(
                'fetch',
                vi.fn(async () => response(envelope)),
            );
            await expect(updateChannelStrict({ id: 12, models: 'gpt-test' })).rejects.toBeInstanceOf(NewApiError);
        },
    );

    it('does not treat an HTTP error response as a confirmed write', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => response({ success: true }, 500)),
        );
        await expect(updateChannelStrict({ id: 12, models: 'gpt-test' })).rejects.toMatchObject({ status: 500 });
    });
});
