import { beforeEach, describe, expect, it, vi } from 'vitest';
const { groups, option } = vi.hoisted(() => ({ groups: vi.fn(), option: vi.fn() }));
vi.mock('../client', () => ({ getPricingGroupRatiosForCustomer: groups, getOption: option }));
vi.mock('@/lib/channel-group', () => ({ getGroupRatios: vi.fn() }));
import { getVerifiedEffectiveGroupRatios } from '../effective-group-ratios';
const user = { newapi_user_id: 81, newapi_access_token: 'private-test-credential' };
beforeEach(() => {
    vi.clearAllMocks();
    option.mockResolvedValue(JSON.stringify({ sale: 1, hidden: 2 }));
    groups.mockResolvedValue({ sale: 0.5 });
});
describe('verified customer group ratios', () => {
    it('reads as the customer and never adds a globally visible group absent from their response', async () => {
        const value = await getVerifiedEffectiveGroupRatios(user);
        expect(groups).toHaveBeenCalledWith({ userId: 81, accessToken: user.newapi_access_token });
        expect(value.ratios).toEqual({ sale: 0.5 });
        expect([...value.special]).toEqual(['sale']);
    });
    it('does not reuse a successful quote after a customer read fails', async () => {
        await getVerifiedEffectiveGroupRatios(user);
        groups.mockRejectedValueOnce(new Error('403'));
        await expect(getVerifiedEffectiveGroupRatios(user)).rejects.toThrow('403');
        expect(groups).toHaveBeenCalledTimes(2);
    });
    it('refuses missing identity without attempting a global fallback', async () => {
        await expect(getVerifiedEffectiveGroupRatios({ ...user, newapi_access_token: null })).rejects.toThrow(
            'identity',
        );
        expect(groups).not.toHaveBeenCalled();
        expect(option).not.toHaveBeenCalled();
    });
    it.each([null, '{}', '{"sale":-1}', '{"sale":"1"}'])('refuses missing or invalid baseline %s', async (raw) => {
        option.mockResolvedValue(raw);
        await expect(getVerifiedEffectiveGroupRatios(user)).rejects.toThrow();
    });
    it('preserves a real zero override and does not cache across users or credentials', async () => {
        groups.mockResolvedValue({ sale: 0 });
        expect((await getVerifiedEffectiveGroupRatios(user)).ratios.sale).toBe(0);
        await getVerifiedEffectiveGroupRatios({ ...user, newapi_access_token: 'rotated-credential' });
        await getVerifiedEffectiveGroupRatios({ ...user, newapi_user_id: 82 });
        expect(groups).toHaveBeenCalledTimes(3);
    });
});
