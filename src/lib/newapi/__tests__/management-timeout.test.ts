import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getUser } from '../client';

const { mutationTimeout } = vi.hoisted(() => ({ mutationTimeout: vi.fn() }));
vi.mock('../customer-key-mutation', () => ({ customerKeyMutationTimeout: mutationTimeout }));

beforeEach(() => {
    mutationTimeout.mockReset().mockResolvedValue(undefined);
    vi.stubEnv('NEWAPI_ADMIN_TOKEN', 'fixture-admin-token');
    vi.stubEnv('NEWAPI_ADMIN_USER_ID', '1');
    vi.stubEnv('NEWAPI_CALL_TIMEOUT_MS', '30000');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: { id: 7 } }))));
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('management request deadlines', () => {
    it('uses the bounded base timeout when no customer mutation context exists', async () => {
        const timeout = vi.spyOn(AbortSignal, 'timeout');
        await expect(getUser(7)).resolves.toMatchObject({ id: 7 });
        expect(timeout).toHaveBeenCalledWith(30000);
        expect(fetch).toHaveBeenCalledOnce();
    });

    it('limits a mutation request to its remaining deadline', async () => {
        mutationTimeout.mockResolvedValue(1250);
        const timeout = vi.spyOn(AbortSignal, 'timeout');
        await getUser(7);
        expect(timeout).toHaveBeenCalledWith(1250);
    });

    it('does not log a malformed authentication response body or its parse error', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.mocked(fetch).mockResolvedValue(
            new Response('nap_fixture-sensitive-credential <invalid-json>', { status: 200 }),
        );
        await getUser(7);
        expect(warn).toHaveBeenCalledWith('[new-api] Invalid JSON response for GET /api/user/7');
        expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture-sensitive-credential');
    });

    it.each([NaN, Infinity, -Infinity, 0, -1])(
        'rejects an invalid actual guard before sending a request: %s',
        async (guard) => {
            mutationTimeout.mockResolvedValue(guard);
            await expect(getUser(7)).rejects.toThrow('Invalid guardMs');
            expect(fetch).not.toHaveBeenCalled();
        },
    );
});
