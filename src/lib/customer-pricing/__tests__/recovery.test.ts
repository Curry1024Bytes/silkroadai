import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    transaction: vi.fn(),
    lock: vi.fn(),
    changes: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    binding: { deleteMany: vi.fn(), upsert: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    registry: { findMany: vi.fn(), updateMany: vi.fn() },
    user: vi.fn(),
    audit: vi.fn(),
    rebase: vi.fn(),
    systemCache: vi.fn(),
    ratioCache: vi.fn(),
    api: {
        getChannelStrict: vi.fn(),
        listChannelsForCatalogSync: vi.fn(),
        setChannelStatusStrict: vi.fn(),
        getOption: vi.fn(),
        putOption: vi.fn(),
        getUser: vi.fn(),
        updateUser: vi.fn(),
        getTokenForCustomer: vi.fn(),
        updateTokenForCustomer: vi.fn(),
    },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: { $transaction: m.transaction, customerPricingChange: m.changes } }));
vi.mock('@/lib/admin/pricing-publish-lock', () => ({ assertPricingCatalogWritable: m.lock }));
vi.mock('@/lib/newapi/client', () => m.api);
vi.mock('@/lib/newapi/system-token', () => ({ invalidateSystemTokenCache: m.systemCache }));
vi.mock('@/lib/newapi/effective-group-ratios', () => ({ invalidateEffectiveRatioCache: m.ratioCache }));
vi.mock('../rebase', () => ({ recoverCustomerPricingRebase: m.rebase }));

import { recoverCustomerOfficialPricing } from '../recovery';

const args = { userId: 'alice', changeId: 'change-1', actorId: 'admin' };
const tx = {
    customerPricingChange: m.changes,
    customerPricingBinding: m.binding,
    customerModelBillingGroup: m.registry,
    user: { findUnique: m.user },
    adminAuditLog: { create: m.audit },
};
const plain = { group: 'public', auto_groups: null, cross_group_retry: false };
const special = { group: 'auto', auto_groups: ['private'], cross_group_retry: false };
let change: Record<string, unknown>;
let token: Record<string, unknown>;
let options: Record<string, string>;
let nativeGroup: string;
const progress = () => ({
    version: 1,
    operation: 'publish',
    phase: 'token_7_intent',
    options: [
        { key: 'GroupGroupRatio', before: '{}', after: '{"alice":{"private":0.2}}', attempted: true, verified: true },
    ],
    tokens: [{ before: { id: 7, user_id: 42, status: 1, ...plain }, after: special, attempted: true, verified: false }],
    user: { id: 42, before_group: 'default', after_group: 'internal', attempted: true, verified: true },
    created_channels: [],
    pending_copy: null,
});

beforeEach(() => {
    vi.clearAllMocks();
    token = { id: 7, user_id: 42, status: 1, ...special };
    options = { GroupGroupRatio: '{"alice":{"private":0.2}}' };
    nativeGroup = 'internal';
    change = {
        id: 'change-1',
        user_id: 'alice',
        tier_key: 'tier',
        status: 'applying',
        before: { binding: null, rules: [] },
        after: {},
        progress: progress(),
    };
    m.transaction.mockImplementation(async (callback) => callback(tx));
    m.changes.findFirst.mockImplementation(async () => change);
    m.changes.findMany.mockResolvedValue([change]);
    m.changes.update.mockResolvedValue({});
    m.changes.updateMany.mockResolvedValue({ count: 1 });
    m.registry.findMany.mockResolvedValue([]);
    m.binding.findMany.mockResolvedValue([]);
    m.user.mockResolvedValue({ newapi_user_id: 42, newapi_access_token: 'PRIVATE_ADMIN_TOKEN' });
    m.api.getTokenForCustomer.mockImplementation(async () => ({ ...token }));
    m.api.updateTokenForCustomer.mockImplementation(async (_auth, next) => {
        token = { ...next };
    });
    m.api.getUser.mockImplementation(async () => ({ id: 42, group: nativeGroup }));
    m.api.updateUser.mockImplementation(async (next) => {
        nativeGroup = next.group;
    });
    m.api.getOption.mockImplementation(async (key) => options[key] ?? null);
    m.api.putOption.mockImplementation(async (key, value) => {
        options[key] = value;
    });
});

describe('durable customer pricing recovery', () => {
    it('recovers a process crash after a remote token write using the durable intent journal', async () => {
        const result = await recoverCustomerOfficialPricing(args);
        expect(result).toEqual({ unchanged: false, change_id: 'change-1' });
        expect(m.lock).toHaveBeenCalledWith(tx);
        expect(token).toMatchObject(plain);
        expect(nativeGroup).toBe('default');
        expect(JSON.parse(options.GroupGroupRatio)).toEqual({});
        expect(m.binding.deleteMany).toHaveBeenCalledWith({ where: { user_id: 'alice', tier_key: 'tier' } });
        expect(m.changes.update).toHaveBeenLastCalledWith({
            where: { id: 'change-1' },
            data: { status: 'compensated', error: null },
        });
        expect(JSON.stringify(m.changes.update.mock.calls)).not.toContain('PRIVATE_ADMIN_TOKEN');
    });

    it('can retry recovery when the previous attempt already restored remote state', async () => {
        await recoverCustomerOfficialPricing(args);
        await recoverCustomerOfficialPricing(args);
        expect(token).toMatchObject(plain);
        expect(nativeGroup).toBe('default');
    });

    it.each(['applied', 'compensated'])('does not reverse a %s commit marker', async (status) => {
        change.status = status;
        expect(await recoverCustomerOfficialPricing(args)).toMatchObject({ unchanged: true });
        expect(m.api.getOption).not.toHaveBeenCalled();
        expect(m.api.updateTokenForCustomer).not.toHaveBeenCalled();
        expect(m.binding.deleteMany).not.toHaveBeenCalled();
    });

    it('does not overwrite a subsequent native operator edit or mark recovery successful', async () => {
        token = { ...token, group: 'operator-edited', auto_groups: null };
        await expect(recoverCustomerOfficialPricing(args)).rejects.toMatchObject({ code: 'native_rollback_conflict' });
        expect(m.api.updateTokenForCustomer).not.toHaveBeenCalled();
        expect(m.changes.update).not.toHaveBeenCalledWith(
            expect.objectContaining({ data: { status: 'compensated', error: null } }),
        );
    });

    it('restores the exact previous active binding rather than replacing it with the public group', async () => {
        const binding = {
            user_id: 'alice',
            tier_key: 'tier',
            public_group: 'public',
            model_groups: ['old-private'],
            token_snapshots: [{ id: 7, ...plain }],
            original_user_group: 'default',
            original_auto_permissions: { auto: { present: false } },
            status: 'active',
            revision: 3,
        };
        change.before = { binding, rules: [] };
        await recoverCustomerOfficialPricing(args);
        expect(m.binding.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { user_id_tier_key: { user_id: 'alice', tier_key: 'tier' } },
                update: expect.objectContaining({ model_groups: ['old-private'], revision: 3, status: 'active' }),
            }),
        );
    });

    it('finds an unacknowledged copy by its unique suffix even after the source was renamed, disables it and clears unpublished registry', async () => {
        change.progress = {
            ...progress(),
            operation: 'prepare',
            tokens: [],
            options: [],
            user: null,
            created_channels: [{ id: 101, group: 'private', source_id: 10, model: 'model', configured: true }],
            pending_copy: { source_id: 10, suffix: '_portal_test', group: 'private', model: 'model' },
        };
        m.api.getChannelStrict.mockResolvedValue({ id: 10, name: 'Renamed source' });
        m.api.listChannelsForCatalogSync.mockResolvedValue([
            { id: 102, name: 'Source_portal_test' },
            { id: 103, name: 'unrelated' },
        ]);
        await recoverCustomerOfficialPricing(args);
        expect(m.api.setChannelStatusStrict.mock.calls).toEqual([
            [101, 2],
            [102, 2],
        ]);
        expect(m.registry.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: { replica_channel_ids: [], source_fingerprint: '', status: 'preparing' } }),
        );
    });

    it('refuses ambiguous unacknowledged copy names', async () => {
        change.progress = {
            ...progress(),
            operation: 'prepare',
            pending_copy: { source_id: 10, suffix: '_copy', group: 'private', model: 'model' },
        };
        m.api.getChannelStrict.mockResolvedValue({ id: 10, name: 'Source' });
        m.api.listChannelsForCatalogSync.mockResolvedValue([
            { id: 102, name: 'Source_copy' },
            { id: 103, name: 'Source_copy' },
        ]);
        await expect(recoverCustomerOfficialPricing(args)).rejects.toMatchObject({ code: 'recovery_ambiguous_copy' });
        expect(m.api.setChannelStatusStrict).not.toHaveBeenCalled();
    });

    it('reactivates verified reused registries after a preparation crash without clearing shared replicas', async () => {
        change.progress = {
            ...progress(),
            operation: 'prepare',
            created_channels: [],
            tokens: [],
            options: [],
            user: null,
        };
        change.before = {
            binding: {
                user_id: 'alice',
                tier_key: 'tier',
                public_group: 'public',
                model_groups: ['existing'],
                token_snapshots: [],
                original_user_group: 'default',
                original_auto_permissions: {},
                status: 'active',
                revision: 3,
            },
            rules: [],
        };
        m.binding.findMany.mockResolvedValue([{ model_groups: ['existing'] }, { model_groups: ['shared-other'] }]);
        m.registry.findMany.mockResolvedValue([
            { internal_group: 'existing', model_name: 'a', replica_channel_ids: [101], status: 'ready' },
            { internal_group: 'shared-other', model_name: 'b', replica_channel_ids: [102], status: 'active' },
        ]);
        m.api.getChannelStrict.mockImplementation(async (id) => ({
            group: id === 101 ? 'existing' : 'shared-other',
            models: id === 101 ? 'a' : 'b',
            status: 1,
        }));
        await recoverCustomerOfficialPricing(args);
        expect(m.registry.updateMany).toHaveBeenLastCalledWith({
            where: { internal_group: { in: ['existing', 'shared-other'] } },
            data: { status: 'active' },
        });
        expect(m.registry.updateMany).not.toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ internal_group: { in: expect.arrayContaining(['existing']) } }),
                data: expect.objectContaining({ replica_channel_ids: [] }),
            }),
        );
        expect(m.api.setChannelStatusStrict).toHaveBeenCalledWith(101, 1);
        expect(m.api.setChannelStatusStrict).toHaveBeenCalledWith(102, 1);
    });

    it('rejects damaged journals and mismatched native ownership before any remote mutation', async () => {
        change.progress = {
            ...progress(),
            tokens: [
                {
                    before: { id: 7, user_id: 99, status: 1, ...plain },
                    after: special,
                    attempted: true,
                    verified: false,
                },
            ],
        };
        await expect(recoverCustomerOfficialPricing(args)).rejects.toMatchObject({ code: 'recovery_invalid' });
        expect(m.api.updateUser).not.toHaveBeenCalled();
        expect(m.api.updateTokenForCustomer).not.toHaveBeenCalled();
        expect(m.api.putOption).not.toHaveBeenCalled();
        change.progress = { ...progress(), options: [{ key: 'arbitrary_option' }] };
        await expect(recoverCustomerOfficialPricing(args)).rejects.toMatchObject({ code: 'recovery_invalid' });
        expect(m.api.putOption).not.toHaveBeenCalled();
    });

    it('scopes recovery to the selected customer before remote writes', async () => {
        m.changes.findFirst.mockResolvedValue(null);
        await expect(recoverCustomerOfficialPricing(args)).rejects.toMatchObject({ code: 'change_missing' });
        expect(m.changes.findFirst).toHaveBeenCalledWith({ where: { id: 'change-1', user_id: 'alice' } });
        expect(m.user).not.toHaveBeenCalled();
    });

    it('recovers all customers covered by a shared public-price rebase operation', async () => {
        change.before = { operation: 'public_price_rebase', operation_id: 'op' };
        change.after = { operation: 'public_price_rebase', operation_id: 'op' };
        m.changes.findMany.mockResolvedValue([
            change,
            { id: 'change-2', user_id: 'bob', tier_key: 'tier', status: 'failed' },
        ]);
        await recoverCustomerOfficialPricing(args);
        expect(m.rebase).toHaveBeenCalledWith(change.before, change.after);
        expect(m.binding.updateMany).toHaveBeenCalledWith({
            where: {
                OR: [
                    { user_id: 'alice', tier_key: 'tier' },
                    { user_id: 'bob', tier_key: 'tier' },
                ],
            },
            data: { status: 'active' },
        });
        expect(m.changes.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: { in: ['change-1', 'change-2'] } } }),
        );
    });

    it('does not roll back a shared rebase with a successful sibling commit marker', async () => {
        change.before = { operation: 'public_price_rebase', operation_id: 'op' };
        m.changes.findMany.mockResolvedValue([{ ...change, status: 'applied' }]);
        await expect(recoverCustomerOfficialPricing(args)).rejects.toMatchObject({ code: 'recovery_conflict' });
        expect(m.rebase).not.toHaveBeenCalled();
    });
});
