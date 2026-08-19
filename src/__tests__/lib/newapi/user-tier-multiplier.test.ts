import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetOption = vi.fn();
const mockPutOption = vi.fn();
const mockGetUser = vi.fn();
const mockUpdateUser = vi.fn();
const mockListTokens = vi.fn();
const mockGetToken = vi.fn();
const mockUpdateToken = vi.fn();
const mockChannelGroupFindFirst = vi.fn();
const mockOverrideFindUnique = vi.fn();
const mockOverrideFindFirst = vi.fn();
const mockOverrideFindMany = vi.fn();
const mockOverrideUpsert = vi.fn();
const mockOverrideUpdate = vi.fn();
const mockNewApiTokenFindMany = vi.fn();
const mockNewApiTokenUpdateMany = vi.fn();
const mockTransaction = vi.fn();

vi.mock('@/lib/newapi/client', () => ({
    getOption: (...args: unknown[]) => mockGetOption(...args),
    putOption: (...args: unknown[]) => mockPutOption(...args),
    getUser: (...args: unknown[]) => mockGetUser(...args),
    updateUser: (...args: unknown[]) => mockUpdateUser(...args),
    listTokensForCustomer: (...args: unknown[]) => mockListTokens(...args),
    getTokenForCustomer: (...args: unknown[]) => mockGetToken(...args),
    updateTokenForCustomer: (...args: unknown[]) => mockUpdateToken(...args),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        channelGroup: { findFirst: (...args: unknown[]) => mockChannelGroupFindFirst(...args) },
        userTierMultiplier: {
            findUnique: (...args: unknown[]) => mockOverrideFindUnique(...args),
            findFirst: (...args: unknown[]) => mockOverrideFindFirst(...args),
            findMany: (...args: unknown[]) => mockOverrideFindMany(...args),
            upsert: (...args: unknown[]) => mockOverrideUpsert(...args),
            update: (...args: unknown[]) => mockOverrideUpdate(...args),
        },
        newApiToken: {
            findMany: (...args: unknown[]) => mockNewApiTokenFindMany(...args),
            updateMany: (...args: unknown[]) => mockNewApiTokenUpdateMany(...args),
        },
        $transaction: (...args: unknown[]) => mockTransaction(...args),
    },
}));

import {
    disableUserTierMultiplier,
    GROUP_GROUP_RATIO_OPTION,
    internalNewApiUserGroup,
    migrateUserKeysToTier,
    parseGroupGroupRatio,
    saveUserTierMultiplier,
} from '@/lib/newapi/user-tier-multiplier';

const portalUser = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', tenant_id: 'tenant-1', newapi_user_id: 12 };
const internalGroup = internalNewApiUserGroup(portalUser.id);
let options: Record<string, string>;
let liveUser: Record<string, unknown>;
let liveTokens: Array<Record<string, unknown>>;

function row(overrides: Record<string, unknown> = {}) {
    return {
        id: 'override-1',
        tier_key: 'gpt-pro20x',
        newapi_billing_group: 'GPT-Pro20x(企业级)',
        newapi_user_group: internalGroup,
        original_newapi_user_group: 'default',
        multiplier: 0.18,
        enabled: true,
        synced_at: new Date('2026-08-19T00:00:00.000Z'),
        created_at: new Date('2026-08-19T00:00:00.000Z'),
        updated_at: new Date('2026-08-19T00:00:00.000Z'),
        ...overrides,
    };
}

function token(id: number, group = 'default'): Record<string, unknown> {
    return {
        id,
        user_id: 12,
        key: `sk-${id}`,
        status: 1,
        name: `key-${id}`,
        created_time: 0,
        accessed_time: 0,
        expired_time: -1,
        remain_quota: 0,
        unlimited_quota: true,
        model_limits_enabled: false,
        model_limits: '',
        used_quota: 0,
        group,
        allow_ips: null,
        cross_group_retry: false,
        auto_groups: null,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    options = {
        [GROUP_GROUP_RATIO_OPTION]: JSON.stringify({ 'another-customer': { 'GPT-Pro20x(企业级)': 0.17 } }),
        UserUsableGroups: JSON.stringify({ 'GPT-Pro20x(企业级)': 'GPT-Pro20x（企业级）' }),
        GroupRatio: JSON.stringify({ 'GPT-Pro20x(企业级)': 0.2 }),
    };
    liveUser = {
        id: 12,
        username: 'customer-a',
        display_name: 'customer-a',
        role: 1,
        status: 1,
        email: 'a@example.com',
        group: 'default',
        quota: 0,
        used_quota: 0,
        request_count: 0,
        aff_code: '',
        inviter_id: 0,
        access_token: null,
        created_at: 0,
    };
    mockGetOption.mockImplementation(async (key: string) => options[key] ?? null);
    mockPutOption.mockImplementation(async (key: string, value: string) => {
        options[key] = value;
    });
    mockGetUser.mockImplementation(async () => ({ ...liveUser }));
    mockUpdateUser.mockImplementation(async (next: Record<string, unknown>) => {
        liveUser = { ...next };
    });
    liveTokens = [];
    mockListTokens.mockImplementation(async () => ({
        items: liveTokens.map((item) => ({ ...item })),
        total: liveTokens.length,
    }));
    mockGetToken.mockImplementation(async (_auth: unknown, tokenId: number) => {
        const found = liveTokens.find((item) => item.id === tokenId);
        if (!found) throw new Error(`token ${tokenId} missing`);
        return { ...found };
    });
    mockUpdateToken.mockImplementation(async (_auth: unknown, next: Record<string, unknown>) => {
        const index = liveTokens.findIndex((item) => item.id === next.id);
        if (index < 0) throw new Error(`token ${String(next.id)} missing`);
        liveTokens[index] = { ...liveTokens[index], ...next };
    });
    mockChannelGroupFindFirst.mockResolvedValue({
        key: 'gpt-pro20x',
        newapi_group: 'GPT-Pro20x(企业级)',
        display_name: 'GPT-Pro20x（企业级）',
    });
    mockOverrideFindUnique.mockResolvedValue(null);
    mockOverrideFindFirst.mockResolvedValue(null);
    mockOverrideFindMany.mockResolvedValue([]);
    mockOverrideUpsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => row(create));
    mockOverrideUpdate.mockResolvedValue({ id: 'override-1' });
    mockNewApiTokenFindMany.mockResolvedValue([]);
    mockNewApiTokenUpdateMany.mockResolvedValue({ count: 0 });
    mockTransaction.mockImplementation(async (work: (tx: unknown) => unknown) =>
        work({ newApiToken: { updateMany: (...args: unknown[]) => mockNewApiTokenUpdateMany(...args) } }),
    );
});

describe('new-api dedicated group multiplier sync', () => {
    it('confirms the GroupGroupRatio nested object contract and rejects malformed input', () => {
        expect(parseGroupGroupRatio('{"portal-user-a":{"GPT-Pro20x(企业级)":0.18}}')).toEqual({
            'portal-user-a': { 'GPT-Pro20x(企业级)': 0.18 },
        });
        expect(() => parseGroupGroupRatio('{bad')).toThrow('refusing to overwrite');
        expect(() => parseGroupGroupRatio('{"a":0.18}')).toThrow('invalid user-group rule');
    });

    it('merges one customer rule without overwriting other customers, then verifies before persisting Portal state', async () => {
        await saveUserTierMultiplier({
            user: portalUser,
            tierKey: 'gpt-pro20x',
            multiplier: 0.18,
            createdBy: 'admin-1',
        });

        expect(liveUser.group).toBe(internalGroup);
        expect(JSON.parse(options[GROUP_GROUP_RATIO_OPTION])).toEqual({
            'another-customer': { 'GPT-Pro20x(企业级)': 0.17 },
            [internalGroup]: { 'GPT-Pro20x(企业级)': 0.18 },
        });
        expect(mockOverrideUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    newapi_user_group: internalGroup,
                    original_newapi_user_group: 'default',
                    newapi_billing_group: 'GPT-Pro20x(企业级)',
                    multiplier: 0.18,
                }),
            }),
        );
        expect(mockPutOption).toHaveBeenCalledWith(GROUP_GROUP_RATIO_OPTION, expect.any(String));
    });

    it('does not make the generated user group publicly selectable', async () => {
        options.UserUsableGroups = JSON.stringify({
            'GPT-Pro20x(企业级)': 'GPT-Pro20x（企业级）',
            [internalGroup]: 'should never be public',
        });

        await expect(
            saveUserTierMultiplier({ user: portalUser, tierKey: 'gpt-pro20x', multiplier: 0.18, createdBy: 'admin-1' }),
        ).rejects.toThrow('UserUsableGroups');
        expect(mockUpdateUser).not.toHaveBeenCalled();
        expect(mockPutOption).not.toHaveBeenCalled();
    });

    it('does not persist a Portal row when new-api user update fails', async () => {
        mockUpdateUser.mockRejectedValueOnce(new Error('new-api down'));

        await expect(
            saveUserTierMultiplier({ user: portalUser, tierKey: 'gpt-pro20x', multiplier: 0.18, createdBy: 'admin-1' }),
        ).rejects.toThrow('new-api down');
        expect(mockPutOption).not.toHaveBeenCalled();
        expect(mockOverrideUpsert).not.toHaveBeenCalled();
    });

    it('continues when new-api committed the user-group write before its response failed', async () => {
        mockUpdateUser.mockImplementationOnce(async (next: Record<string, unknown>) => {
            liveUser = { ...next };
            throw new Error('connection reset after user write');
        });

        await saveUserTierMultiplier({
            user: portalUser,
            tierKey: 'gpt-pro20x',
            multiplier: 0.18,
            createdBy: 'admin-1',
        });

        expect(liveUser.group).toBe(internalGroup);
        expect(mockOverrideUpsert).toHaveBeenCalledTimes(1);
    });

    it('attempts compensation when an uncertain user-group write cannot be read back', async () => {
        mockUpdateUser.mockRejectedValueOnce(new Error('connection reset after user write'));
        mockGetUser
            .mockImplementationOnce(async () => ({ ...liveUser }))
            .mockRejectedValueOnce(new Error('new-api unavailable during readback'));

        await expect(
            saveUserTierMultiplier({ user: portalUser, tierKey: 'gpt-pro20x', multiplier: 0.18, createdBy: 'admin-1' }),
        ).rejects.toThrow('connection reset after user write');

        expect(mockUpdateUser).toHaveBeenCalledTimes(2);
        expect(mockPutOption).not.toHaveBeenCalled();
        expect(mockOverrideUpsert).not.toHaveBeenCalled();
    });

    it('continues when new-api committed the GroupGroupRatio write before its response failed', async () => {
        mockPutOption.mockImplementationOnce(async (key: string, value: string) => {
            options[key] = value;
            throw new Error('connection reset after option write');
        });

        await saveUserTierMultiplier({
            user: portalUser,
            tierKey: 'gpt-pro20x',
            multiplier: 0.18,
            createdBy: 'admin-1',
        });

        expect(JSON.parse(options[GROUP_GROUP_RATIO_OPTION])[internalGroup]['GPT-Pro20x(企业级)']).toBe(0.18);
        expect(mockOverrideUpsert).toHaveBeenCalledTimes(1);
    });

    it('attempts compensation when an uncertain GroupGroupRatio write cannot be read back', async () => {
        let specialRatioReads = 0;
        mockGetOption.mockImplementation(async (key: string) => {
            if (key === GROUP_GROUP_RATIO_OPTION && ++specialRatioReads === 2) {
                throw new Error('new-api unavailable during option readback');
            }
            return options[key] ?? null;
        });
        mockPutOption.mockRejectedValueOnce(new Error('connection reset after option write'));

        await expect(
            saveUserTierMultiplier({ user: portalUser, tierKey: 'gpt-pro20x', multiplier: 0.18, createdBy: 'admin-1' }),
        ).rejects.toThrow('connection reset after option write');

        expect(mockPutOption).toHaveBeenCalledTimes(2);
        expect(liveUser.group).toBe('default');
        expect(mockOverrideUpsert).not.toHaveBeenCalled();
    });

    it('rolls back the new-api user group when the option update fails', async () => {
        mockPutOption.mockRejectedValueOnce(new Error('option write failed'));

        await expect(
            saveUserTierMultiplier({ user: portalUser, tierKey: 'gpt-pro20x', multiplier: 0.18, createdBy: 'admin-1' }),
        ).rejects.toThrow('option write failed');
        expect(mockUpdateUser).toHaveBeenCalledTimes(2);
        expect(liveUser.group).toBe('default');
        expect(mockOverrideUpsert).not.toHaveBeenCalled();
    });

    it('logs a CRITICAL signal if a compensating rollback also fails', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        mockPutOption.mockRejectedValueOnce(new Error('option write failed'));
        mockUpdateUser.mockImplementationOnce(async (next: Record<string, unknown>) => {
            liveUser = { ...next };
        });
        mockUpdateUser.mockRejectedValueOnce(new Error('rollback user write failed'));

        await expect(
            saveUserTierMultiplier({ user: portalUser, tierKey: 'gpt-pro20x', multiplier: 0.18, createdBy: 'admin-1' }),
        ).rejects.toThrow('option write failed');
        expect(log).toHaveBeenCalledWith(
            '[user-tier-multiplier] CRITICAL new-api rollback failed',
            expect.objectContaining({ operation: 'save' }),
        );
        log.mockRestore();
    });

    it('removes only the selected special rule and restores the original user group after the last override', async () => {
        liveUser.group = internalGroup;
        options[GROUP_GROUP_RATIO_OPTION] = JSON.stringify({
            'another-customer': { 'GPT-Pro20x(企业级)': 0.17 },
            [internalGroup]: { 'GPT-Pro20x(企业级)': 0.18, retained: 0.12 },
        });
        mockOverrideFindFirst.mockResolvedValue(row());
        mockOverrideFindMany.mockResolvedValue([]);

        await disableUserTierMultiplier({ user: portalUser, overrideId: 'override-1' });

        expect(liveUser.group).toBe('default');
        expect(JSON.parse(options[GROUP_GROUP_RATIO_OPTION])).toEqual({
            'another-customer': { 'GPT-Pro20x(企业级)': 0.17 },
            [internalGroup]: { retained: 0.12 },
        });
        expect(mockOverrideUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'override-1' }, data: expect.objectContaining({ enabled: false }) }),
        );
    });

    it('preserves a pre-existing rule on the original user group when removing the final override', async () => {
        liveUser.group = internalGroup;
        options[GROUP_GROUP_RATIO_OPTION] = JSON.stringify({
            default: { 'GPT-Pro20x(企业级)': 0.15 },
            [internalGroup]: { 'GPT-Pro20x(企业级)': 0.18 },
        });
        mockOverrideFindFirst.mockResolvedValue(row());
        mockOverrideFindMany.mockResolvedValue([]);

        await disableUserTierMultiplier({ user: portalUser, overrideId: 'override-1' });

        expect(liveUser.group).toBe('default');
        expect(JSON.parse(options[GROUP_GROUP_RATIO_OPTION])).toEqual({
            default: { 'GPT-Pro20x(企业级)': 0.15 },
        });
        expect(mockOverrideUpdate).toHaveBeenCalledTimes(1);
    });

    describe('existing key migration', () => {
        const migrationUser = {
            ...portalUser,
            newapi_access_token: 'persistent-customer-token',
        };

        function configureMigration(portalKeys: Array<{ id: string; newapi_token_id: number; tier: string }>) {
            liveUser.group = internalGroup;
            options[GROUP_GROUP_RATIO_OPTION] = JSON.stringify({
                'another-customer': { 'GPT-Pro20x(企业级)': 0.17 },
                [internalGroup]: { 'GPT-Pro20x(企业级)': 0.18 },
            });
            liveTokens = portalKeys.map(({ newapi_token_id, tier }) =>
                token(newapi_token_id, tier === 'gpt-pro20x' ? 'GPT-Pro20x(企业级)' : 'default'),
            );
            mockOverrideFindFirst.mockResolvedValue(row());
            mockNewApiTokenFindMany.mockResolvedValue(portalKeys);
            mockNewApiTokenUpdateMany.mockResolvedValue({ count: portalKeys.length });
        }

        it('rejects a customer without a persistent new-api access token', async () => {
            await expect(
                migrateUserKeysToTier({
                    user: { ...portalUser, newapi_access_token: null },
                    tierKey: 'gpt-pro20x',
                }),
            ).rejects.toThrow('linked new-api account');
            expect(mockNewApiTokenFindMany).not.toHaveBeenCalled();
        });

        it('returns a no-op result without calling new-api when the customer has no active Portal keys', async () => {
            mockOverrideFindFirst.mockResolvedValue(row());
            mockNewApiTokenFindMany.mockResolvedValue([]);

            await expect(migrateUserKeysToTier({ user: migrationUser, tierKey: 'gpt-pro20x' })).resolves.toMatchObject({
                migrated_count: 0,
                already_target_count: 0,
                total_active_keys: 0,
            });
            expect(mockListTokens).not.toHaveBeenCalled();
            expect(mockUpdateToken).not.toHaveBeenCalled();
        });

        it('moves legacy active tokens to the dedicated tier without changing their key material', async () => {
            configureMigration([
                { id: 'portal-key-1', newapi_token_id: 101, tier: 'pool' },
                { id: 'portal-key-2', newapi_token_id: 102, tier: 'pool' },
            ]);
            const originalKeys = liveTokens.map(({ key }) => key);

            const result = await migrateUserKeysToTier({ user: migrationUser, tierKey: 'gpt-pro20x' });

            expect(result).toMatchObject({
                tier_key: 'gpt-pro20x',
                migrated_count: 2,
                already_target_count: 0,
                total_active_keys: 2,
            });
            expect(liveTokens.map(({ group }) => group)).toEqual(['GPT-Pro20x(企业级)', 'GPT-Pro20x(企业级)']);
            expect(liveTokens.map(({ key }) => key)).toEqual(originalKeys);
            expect(mockNewApiTokenUpdateMany).toHaveBeenCalledWith({
                where: { id: { in: ['portal-key-1', 'portal-key-2'] }, status: 'active' },
                data: { tier: 'gpt-pro20x' },
            });
        });

        it('treats keys already on the selected upstream group as a verified no-write', async () => {
            configureMigration([
                { id: 'portal-key-1', newapi_token_id: 101, tier: 'gpt-pro20x' },
                { id: 'portal-key-2', newapi_token_id: 102, tier: 'pool' },
            ]);

            const result = await migrateUserKeysToTier({ user: migrationUser, tierKey: 'gpt-pro20x' });

            expect(result).toMatchObject({ migrated_count: 1, already_target_count: 1, total_active_keys: 2 });
            expect(mockUpdateToken).toHaveBeenCalledTimes(1);
        });

        it('refuses to begin when an active Portal key is missing or inactive in new-api', async () => {
            configureMigration([{ id: 'portal-key-1', newapi_token_id: 101, tier: 'pool' }]);
            liveTokens = [];

            await expect(migrateUserKeysToTier({ user: migrationUser, tierKey: 'gpt-pro20x' })).rejects.toThrow(
                'missing or inactive',
            );
            expect(mockUpdateToken).not.toHaveBeenCalled();
            expect(mockNewApiTokenUpdateMany).not.toHaveBeenCalled();
        });

        it('refuses migration when the upstream special rule no longer matches Portal state', async () => {
            configureMigration([{ id: 'portal-key-1', newapi_token_id: 101, tier: 'pool' }]);
            options[GROUP_GROUP_RATIO_OPTION] = JSON.stringify({ [internalGroup]: { 'GPT-Pro20x(企业级)': 0.2 } });

            await expect(migrateUserKeysToTier({ user: migrationUser, tierKey: 'gpt-pro20x' })).rejects.toThrow(
                'out of sync',
            );
            expect(mockUpdateToken).not.toHaveBeenCalled();
        });

        it('restores every changed upstream token when a later token update fails', async () => {
            configureMigration([
                { id: 'portal-key-1', newapi_token_id: 101, tier: 'pool' },
                { id: 'portal-key-2', newapi_token_id: 102, tier: 'pool' },
            ]);
            mockUpdateToken.mockImplementation(async (_auth: unknown, next: Record<string, unknown>) => {
                if (next.id === 102 && next.group === 'GPT-Pro20x(企业级)')
                    throw new Error('second token update failed');
                const index = liveTokens.findIndex((item) => item.id === next.id);
                liveTokens[index] = { ...liveTokens[index], ...next };
            });

            await expect(migrateUserKeysToTier({ user: migrationUser, tierKey: 'gpt-pro20x' })).rejects.toThrow(
                'second token update failed',
            );

            expect(liveTokens.map(({ group }) => group)).toEqual(['default', 'default']);
            expect(mockNewApiTokenUpdateMany).not.toHaveBeenCalled();
        });

        it('continues when new-api committed a token group write before its response failed', async () => {
            configureMigration([{ id: 'portal-key-1', newapi_token_id: 101, tier: 'pool' }]);
            mockUpdateToken.mockImplementationOnce(async (_auth: unknown, next: Record<string, unknown>) => {
                liveTokens[0] = { ...liveTokens[0], ...next };
                throw new Error('connection reset after token write');
            });

            await expect(migrateUserKeysToTier({ user: migrationUser, tierKey: 'gpt-pro20x' })).resolves.toMatchObject({
                migrated_count: 1,
            });
            expect(liveTokens[0].group).toBe('GPT-Pro20x(企业级)');
        });

        it('restores upstream groups when Portal persistence fails and logs a critical rollback failure', async () => {
            configureMigration([{ id: 'portal-key-1', newapi_token_id: 101, tier: 'pool' }]);
            const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            mockTransaction.mockRejectedValueOnce(new Error('database unavailable'));
            mockUpdateToken.mockImplementation(async (_auth: unknown, next: Record<string, unknown>) => {
                if (next.group === 'default') throw new Error('rollback token write failed');
                liveTokens[0] = { ...liveTokens[0], ...next };
            });

            await expect(migrateUserKeysToTier({ user: migrationUser, tierKey: 'gpt-pro20x' })).rejects.toThrow(
                'Portal persistence failed',
            );
            expect(log).toHaveBeenCalledWith(
                '[user-tier-multiplier] CRITICAL token migration rollback failed',
                expect.objectContaining({ operation: 'persist' }),
            );
            log.mockRestore();
        });

        it('restores upstream groups when Portal persistence fails', async () => {
            configureMigration([{ id: 'portal-key-1', newapi_token_id: 101, tier: 'pool' }]);
            mockTransaction.mockRejectedValueOnce(new Error('database unavailable'));

            await expect(migrateUserKeysToTier({ user: migrationUser, tierKey: 'gpt-pro20x' })).rejects.toThrow(
                'Portal persistence failed',
            );
            expect(liveTokens[0].group).toBe('default');
        });
    });
});
