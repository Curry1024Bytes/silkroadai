import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCatalogSyncOptions, listChannelsForCatalogSync } from '@/lib/newapi/client';
import { readNewApiSyncSource } from '@/lib/admin/newapi-sync-source';

const fetchMock = vi.fn();
const channel = (id: number) => ({
    id,
    name: `channel-${id}`,
    status: 1,
    group: 'public',
    models: 'gpt-test',
    key: 'SECRET-CHANNEL-KEY',
});
const envelope = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    vi.stubEnv('NEWAPI_ADMIN_TOKEN', 'test-only');
    vi.stubEnv('NEWAPI_ADMIN_USER_ID', '1');
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('catalog sync full source', () => {
    it('reads every page and never interprets the first 100 as the complete inventory', async () => {
        fetchMock
            .mockResolvedValueOnce(
                envelope({ items: Array.from({ length: 100 }, (_, index) => channel(index + 1)), total: 101 }),
            )
            .mockResolvedValueOnce(envelope({ items: [channel(101)], total: 101 }));
        const rows = await listChannelsForCatalogSync();
        expect(rows).toHaveLength(101);
        expect(rows[100].id).toBe(101);
        expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('p')).toBe('2');
        expect(fetchMock.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
    });
    it.each([
        [{ items: [channel(1)], total: 5 }],
        [{ items: [channel(1), channel(1)], total: 2 }],
        [null],
        [{ items: [], total: '0' }],
    ])('rejects incomplete or invalid inventory %j', async (data) => {
        fetchMock.mockResolvedValueOnce(envelope(data));
        await expect(listChannelsForCatalogSync()).rejects.toThrow();
    });
    it('rejects repeated pages or a changed total during pagination', async () => {
        const first = Array.from({ length: 100 }, (_, index) => channel(index + 1));
        fetchMock
            .mockResolvedValueOnce(envelope({ items: first, total: 101 }))
            .mockResolvedValueOnce(envelope({ items: [channel(101)], total: 102 }));
        await expect(listChannelsForCatalogSync()).rejects.toThrow('changed');
        fetchMock.mockResolvedValueOnce(envelope(first)).mockResolvedValueOnce(envelope(first));
        await expect(listChannelsForCatalogSync()).rejects.toThrow('repeated');
    });
    it('reads an array inventory until the final short page', async () => {
        fetchMock
            .mockResolvedValueOnce(envelope(Array.from({ length: 100 }, (_, index) => channel(index + 1))))
            .mockResolvedValueOnce(envelope([]));
        expect(await listChannelsForCatalogSync()).toHaveLength(100);
    });
    it('only exposes the five allowlisted options from an object or array', async () => {
        for (const payload of [
            { ModelRatio: '{}', SMTPToken: 'SECRET-OPTION' },
            [
                { key: 'ModelRatio', value: '{}' },
                { key: 'SMTPToken', value: 'SECRET-OPTION' },
            ],
        ]) {
            fetchMock.mockResolvedValueOnce(envelope(payload));
            const values = await getCatalogSyncOptions();
            expect(Object.keys(values)).toEqual([
                'UserUsableGroups',
                'GroupRatio',
                'ModelRatio',
                'CompletionRatio',
                'ModelPrice',
            ]);
            expect(values.ModelRatio).toBe('{}');
            expect(values.ModelPrice).toBeNull();
            expect(JSON.stringify(values)).not.toContain('SECRET');
        }
    });
    it('strips credentials and hidden groups before planning', async () => {
        fetchMock.mockImplementation((url) =>
            Promise.resolve(
                new URL(url).pathname === '/api/channel/'
                    ? envelope({ items: [channel(13)], total: 1 })
                    : envelope({
                          UserUsableGroups: '{"public":"客户档","internal":"@内部档"}',
                          ModelRatio: '{}',
                          CompletionRatio: '{}',
                          ModelPrice: '{}',
                          GroupRatio: '{"public":1}',
                          Secret: 'SECRET-OPTION',
                      }),
            ),
        );
        const source = await readNewApiSyncSource();
        expect(source.groups).toEqual({ public: '客户档' });
        expect(source.channels[0]).toEqual({
            id: 13,
            name: 'channel-13',
            status: 1,
            groups: ['public'],
            models: ['gpt-test'],
        });
        expect(JSON.stringify(source)).not.toContain('SECRET');
    });
    it('rejects missing group metadata rather than producing deletion proposals', async () => {
        fetchMock.mockImplementation((url) =>
            Promise.resolve(
                new URL(url).pathname === '/api/channel/'
                    ? envelope({ items: [channel(13)], total: 1 })
                    : envelope({ UserUsableGroups: null }),
            ),
        );
        await expect(readNewApiSyncSource()).rejects.toThrow('Missing usable groups');
    });
    it('rejects incomplete channel metadata rather than treating it as empty models', async () => {
        fetchMock.mockImplementation((url) =>
            Promise.resolve(
                new URL(url).pathname === '/api/channel/'
                    ? envelope({ items: [{ id: 13 }], total: 1 })
                    : envelope({ UserUsableGroups: '{"public":"客户档"}' }),
            ),
        );
        await expect(readNewApiSyncSource()).rejects.toThrow('Incomplete channel');
    });
});
