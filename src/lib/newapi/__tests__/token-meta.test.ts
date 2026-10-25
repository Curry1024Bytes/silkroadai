import { beforeEach, describe, expect, it, vi } from 'vitest';
const list = vi.hoisted(() => vi.fn());
vi.mock('../client', () => ({ listTokensForCustomer: list }));
import { getTokenMetaForCustomer, expiredTimeToIso, isoToExpiredTime } from '../token-meta';
const auth = { userId: 7, accessToken: 'test' };
const row = (id: number) => ({
    id,
    user_id: 7,
    status: 1,
    unlimited_quota: true,
    remain_quota: 0,
    expired_time: -1,
    used_quota: 0,
});
beforeEach(() => vi.resetAllMocks());
describe('customer token metadata', () => {
    it('loads all pages for customers with more than 100 keys', async () => {
        list.mockResolvedValueOnce({ total: 101, items: Array.from({ length: 100 }, (_, i) => row(i + 1)) });
        list.mockResolvedValueOnce({ total: 101, items: [row(101)] });
        const result = await getTokenMetaForCustomer(auth);
        expect(result?.size).toBe(101);
        expect(result?.get(101)?.unlimited_quota).toBe(true);
        expect(list).toHaveBeenLastCalledWith(auth, 2, 100);
    });
    it.each([
        { total: 2, items: [row(1)] },
        { total: 1, items: [{ ...row(1), user_id: 8 }] },
        { total: 2, items: [row(1), row(1)] },
        { total: 1, items: [{ ...row(1), expired_time: NaN }] },
    ])('hides incomplete or unverified metadata instead of claiming unlimited/never: %j', async (data) => {
        list.mockResolvedValue(data);
        expect(await getTokenMetaForCustomer(auth)).toBeNull();
    });
    it('returns no metadata on an authorization failure', async () => {
        list.mockRejectedValue(new Error('401'));
        expect(await getTokenMetaForCustomer(auth)).toBeNull();
    });
    it('round-trips expiry to seconds and keeps never-expiring sentinel', () => {
        expect(isoToExpiredTime(null)).toBe(-1);
        expect(expiredTimeToIso(-1)).toBeNull();
        expect(expiredTimeToIso(isoToExpiredTime('2030-01-01T00:00:00.123Z'))).toBe('2030-01-01T00:00:00.000Z');
    });

    it.each([1, 2, 3, 4])('retains authoritative upstream status %s for the page', async (status) => {
        list.mockResolvedValue({ total: 1, items: [{ ...row(1), status }] });
        expect((await getTokenMetaForCustomer(auth))?.get(1)?.status).toBe(status);
    });
});
