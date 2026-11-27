import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

const mocks = vi.hoisted(() => ({
    summary: vi.fn(),
    props: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: async () => ({
        id: 'customer-a',
        tenant_id: 'tenant-a',
        newapi_user_id: 10,
        newapi_access_token: 'customer-auth',
        allowed_tier_keys: [],
    }),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        newApiToken: {
            findMany: async () => [
                {
                    id: 'token-a',
                    key_alias: 'SD Key',
                    newapi_token_value: 'secret-token-value-that-must-stay-masked',
                    newapi_token_id: 1,
                    tier: 'sd',
                    created_at: new Date('2026-11-19T03:00:00Z'),
                    cached_used_quota: 0,
                    cached_used_at: null,
                },
            ],
        },
    },
}));
vi.mock('@/lib/newapi/token-usage', () => ({
    getTokenUsageWithCache: async () => ({ used_quota: 0, last_used_at: null }),
}));
vi.mock('@/lib/newapi/quota-units', () => ({ quotaToCny: (quota: number) => quota / 500000 }));
vi.mock('@/lib/newapi/token-format', () => ({ formatTokenForDisplay: (key: string) => `sk-${key}` }));
vi.mock('@/lib/channel-group', () => ({
    listEnabledChannelGroups: async () => [
        { key: 'sd', display_name: 'SD官转', newapi_group: 'SD官转', description: null, is_default: true },
    ],
    restrictGroupsForUser: (groups: unknown) => groups,
}));
vi.mock('@/lib/partner/tiers', () => ({
    listCustomerTierGroups: async () => [
        { key: 'sd', display_name: 'SD官转', newapi_group: 'SD官转', description: null, is_default: true },
    ],
}));
vi.mock('@/lib/newapi/effective-group-ratios', () => ({
    getVerifiedEffectiveGroupRatios: async () => ({
        ratios: { SD官转: 0.277777777778 },
        listRatios: { SD官转: 1 },
        special: new Set(['SD官转']),
    }),
}));
vi.mock('@/lib/newapi/token-meta', () => ({
    getTokenMetaForCustomer: async () =>
        new Map([[1, { status: 1, unlimited_quota: true, remain_quota: 0, expired_time: -1 }]]),
    expiredTimeToIso: () => null,
}));
vi.mock('@/lib/keys/quota-policy', () => ({ keyQuotaLimitsEnabled: () => false }));
vi.mock('@/lib/auth/customer-provisioning-queue', () => ({ getCustomerProvisioningStatus: async () => null }));
vi.mock('@/lib/customer-pricing/presentation', () => ({ summarizeCustomerOfficialTiers: mocks.summary }));
vi.mock('@/lib/i18n/server', () => ({ getLocale: async () => 'zh' }));
vi.mock('@/app/(authenticated)/keys/keys-list', () => ({
    KeysList: (props: unknown) => {
        mocks.props(props);
        return <div>Keys</div>;
    },
}));
vi.mock('@/app/(authenticated)/keys/keys-snippets-panel', () => ({ KeysSnippetsPanel: () => null }));

import KeysPage from '@/app/(authenticated)/keys/page';

describe('keys page official-price presentation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.summary.mockResolvedValue(new Map([['sd', { multiplier: 0.2, model_overrides: 1 }]]));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it('attaches the authenticated customer’s official summary to the matching tier and key without presenting the internal ratio', async () => {
        renderToString(await KeysPage());
        expect(mocks.summary).toHaveBeenCalledWith('customer-a');
        const props = mocks.props.mock.calls[0][0];
        expect(props.initialRows[0]).toMatchObject({
            tier: 'sd',
            effective_ratio: null,
            official_pricing: { multiplier: 0.2, model_overrides: 1 },
        });
        expect(props.tiers[0]).toMatchObject({
            key: 'sd',
            ratio: null,
            official_pricing: { multiplier: 0.2, model_overrides: 1 },
        });
        expect(JSON.stringify(props)).not.toContain('secret-token-value-that-must-stay-masked');
    });

    it('preserves existing ratio badges when the customer has no official-price rules', async () => {
        mocks.summary.mockResolvedValue(new Map());
        renderToString(await KeysPage());
        const props = mocks.props.mock.calls[0][0];
        expect(props.initialRows[0].effective_ratio).toBe(0.277777777778);
        expect(props.initialRows[0].official_pricing).toBeUndefined();
        expect(props.tiers[0].ratio).toBe(0.277777777778);
    });

    it('shows a visible verification warning when dedicated pricing cannot be verified, while hiding unverified multipliers', async () => {
        mocks.summary.mockRejectedValue(new Error('unverified pricing'));
        renderToString(await KeysPage());
        const props = mocks.props.mock.calls[0][0];
        expect(props.officialPricingUnavailable).toBe(true);
        expect(props.initialRows[0].effective_ratio).toBeNull();
        expect(props.tiers[0].ratio).toBeNull();
        expect(props.initialRows[0].official_pricing).toBeUndefined();
    });
});
