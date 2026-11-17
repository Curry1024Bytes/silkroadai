import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getUser, listGroupUserRatios, updateUser } from '../client';

const fetchMock = vi.fn();
const managedUser = {
    id: 7,
    username: 'portal-customer',
    display_name: 'Customer',
    role: 1,
    status: 1,
    email: '',
    group: 'default',
    quota: 500000,
    used_quota: 100,
    request_count: 1,
    aff_code: '',
    inviter_id: 0,
    access_token: null,
    created_at: 1,
    // Official rc.51 includes the complete matrix even for an ordinary user.
    admin_permissions: { user: { read: false, write: false } },
    DeletedAt: null,
    original_password: '',
    verification_code: '',
};

function response(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), { status });
}

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('NEWAPI_ADMIN_TOKEN', 'test-admin-token');
    vi.stubEnv('NEWAPI_ADMIN_USER_ID', '1');
    vi.stubEnv('NEWAPI_DISTRIBUTION', undefined);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('official user update contract', () => {
    it('moves a fetched common user to another group without requesting a permission rewrite', async () => {
        fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
            if (init.method === 'GET') return response({ success: true, data: managedUser });
            const payload = JSON.parse(String(init.body));
            // Official UpdateUser requires proof whenever this map is non-null.
            if (payload.admin_permissions != null)
                return response({ success: false, message: 'SECURITY_PROOF_REQUIRED' }, 403);
            if (!payload.username) return response({ success: false, message: 'Invalid parameters' });
            return response({ success: true });
        });

        const existing = await getUser(7);
        await expect(updateUser({ ...existing, group: 'portal-customer-group' }, 15000)).resolves.toBeUndefined();

        const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
        expect(init.method).toBe('PUT');
        expect(JSON.parse(String(init.body))).toEqual({
            id: 7,
            username: 'portal-customer',
            display_name: 'Customer',
            role: 1,
            status: 1,
            email: '',
            group: 'portal-customer-group',
            quota: 500000,
            used_quota: 100,
            request_count: 1,
            aff_code: '',
            inviter_id: 0,
            access_token: null,
            created_at: 1,
        });
        expect(new Headers(init.headers).has('X-Security-Proof')).toBe(false);
        expect(existing).toMatchObject({ group: 'default', admin_permissions: managedUser.admin_permissions });
    });

    it('preserves explicitly supplied role and other editable fields', async () => {
        fetchMock.mockResolvedValue(response({ success: true }));
        await updateUser({ id: 7, username: 'portal-customer', role: 10, status: 2, group: 'target' });
        expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
            id: 7,
            username: 'portal-customer',
            role: 10,
            status: 2,
            group: 'target',
        });
    });
});

describe('distribution-specific user ratios', () => {
    it('skips the fork-only endpoint only when the official distribution is explicitly selected', async () => {
        vi.stubEnv('NEWAPI_DISTRIBUTION', 'official');
        await expect(listGroupUserRatios('customer/group')).resolves.toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([undefined, 'fork'])('retains the fork contract for distribution %s', async (distribution) => {
        vi.stubEnv('NEWAPI_DISTRIBUTION', distribution);
        fetchMock.mockResolvedValue(
            response({ success: true, data: [{ user_id: 7, ratio: 0.8, username: 'private-user' }] }),
        );
        await expect(listGroupUserRatios('customer/group')).resolves.toEqual([{ user_id: 7, ratio: 0.8 }]);
        expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/group\/customer%2Fgroup\/user-ratios$/);
    });

    it.each(['', 'oficial', 'legacy', 'true'])('rejects an invalid distribution before fetching: %s', async (value) => {
        vi.stubEnv('NEWAPI_DISTRIBUTION', value);
        await expect(listGroupUserRatios('default')).rejects.toThrow('Invalid NEWAPI_DISTRIBUTION');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([403, 404, 500])('does not interpret a fork HTTP %s as an empty override list', async (status) => {
        fetchMock.mockResolvedValue(response({ success: false, message: 'request failed' }, status));
        await expect(listGroupUserRatios('default')).rejects.toThrow();
    });

    it('does not interpret a rejected application response as an empty override list', async () => {
        fetchMock.mockResolvedValue(response({ success: false, message: 'request failed' }));
        await expect(listGroupUserRatios('default')).rejects.toThrow();
    });

    it('does not interpret a network failure as an empty override list', async () => {
        fetchMock.mockRejectedValue(new TypeError('network unavailable'));
        await expect(listGroupUserRatios('default')).rejects.toThrow();
    });
});
