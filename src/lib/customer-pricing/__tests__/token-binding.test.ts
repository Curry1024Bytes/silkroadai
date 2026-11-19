import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ findUnique: vi.fn(), findMany: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { customerPricingBinding: db } }));
import {
    nativeTokenBindingMatches,
    resolveCustomerTokenBinding,
    resolveCustomerTokenBindingForGroup,
    validateNativeTokenBinding,
} from '../token-binding';

const automatic = { group: 'auto', auto_groups: ['internal-a', 'internal-b'], cross_group_retry: false };

beforeEach(() => {
    vi.clearAllMocks();
    db.findUnique.mockResolvedValue(null);
    db.findMany.mockResolvedValue([]);
});

describe('scoped native token assignment', () => {
    it('retains the caller-resolved concrete group when no customer binding exists', async () => {
        await expect(resolveCustomerTokenBinding('user-1', 'sd-tier', 'SD官转')).resolves.toEqual({
            group: 'SD官转',
            auto_groups: null,
            cross_group_retry: false,
        });
        expect(db.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { user_id_tier_key: { user_id: 'user-1', tier_key: 'sd-tier' } },
            }),
        );
    });

    it('uses an exact non-empty model-group list for an active binding', async () => {
        db.findUnique.mockResolvedValue({
            public_group: 'SD官转',
            model_groups: automatic.auto_groups,
            status: 'active',
        });
        const binding = await resolveCustomerTokenBinding('user-1', 'sd-tier', 'SD官转');
        expect(binding).toEqual(automatic);
        expect(binding.auto_groups).not.toBe(automatic.auto_groups);
    });

    it.each(['applying', 'failed', 'unknown'])('never falls back to public prices for %s state', async (status) => {
        db.findUnique.mockResolvedValue({ public_group: 'SD官转', model_groups: ['internal-a'], status });
        await expect(resolveCustomerTokenBinding('user-1', 'sd-tier', 'SD官转')).rejects.toMatchObject({ status: 503 });
    });

    it.each([null, [], ['a', 'a'], ['auto'], [' a'], ['a,b'], [null], {}])(
        'rejects unsafe model-group JSON %j',
        async (groups) => {
            db.findUnique.mockResolvedValue({ public_group: 'SD官转', model_groups: groups, status: 'active' });
            await expect(resolveCustomerTokenBinding('user-1', 'sd-tier', 'SD官转')).rejects.toThrow();
        },
    );

    it('rejects an out-of-date public-group association', async () => {
        db.findUnique.mockResolvedValue({
            public_group: 'another-group',
            model_groups: ['internal-a'],
            status: 'active',
        });
        await expect(resolveCustomerTokenBinding('user-1', 'sd-tier', 'SD官转')).rejects.toThrow();
    });

    it('checks publication limits and current permissions before assigning auto groups', () => {
        expect(() => validateNativeTokenBinding(automatic, { maxAutoGroups: 1 })).toThrow('上限');
        expect(() => validateNativeTokenBinding(automatic, { allowedGroups: ['internal-a'] })).toThrow('授权');
        expect(
            validateNativeTokenBinding(automatic, { maxAutoGroups: 2, allowedGroups: automatic.auto_groups }),
        ).toEqual(automatic);
    });

    it('rejects cross-group retry so a scoped pricing assignment cannot fall through to another price', () => {
        expect(() => validateNativeTokenBinding({ ...automatic, cross_group_retry: true })).toThrow();
    });

    it('resolves service-token assignment by the exact owner and public group', async () => {
        db.findMany.mockResolvedValue([{ public_group: 'SD官转', model_groups: ['internal-a'], status: 'active' }]);
        await expect(resolveCustomerTokenBindingForGroup('user-1', 'SD官转')).resolves.toEqual({
            ...automatic,
            auto_groups: ['internal-a'],
        });
        expect(db.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { user_id: 'user-1', public_group: 'SD官转' } }),
        );
    });

    it('refuses ambiguous internal assignments and storage errors', async () => {
        const row = { public_group: 'SD官转', model_groups: ['internal-a'], status: 'active' };
        db.findMany.mockResolvedValue([row, row]);
        await expect(resolveCustomerTokenBindingForGroup('user-1', 'SD官转')).rejects.toThrow('重复');
        db.findMany.mockRejectedValue(new Error('storage unavailable'));
        await expect(resolveCustomerTokenBindingForGroup('user-1', 'SD官转')).rejects.toThrow('storage unavailable');
    });

    it('verifies the complete readback, including group order and forbidden public fallback', () => {
        expect(nativeTokenBindingMatches(automatic, automatic)).toBe(true);
        expect(nativeTokenBindingMatches({ ...automatic, auto_groups: ['internal-b', 'internal-a'] }, automatic)).toBe(
            false,
        );
        expect(nativeTokenBindingMatches({ ...automatic, auto_groups: [] }, automatic)).toBe(false);
        expect(nativeTokenBindingMatches({ ...automatic, group: 'SD官转' }, automatic)).toBe(false);
        expect(nativeTokenBindingMatches({ ...automatic, cross_group_retry: true }, automatic)).toBe(false);
    });
});
