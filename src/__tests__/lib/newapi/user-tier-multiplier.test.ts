import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetOption = vi.fn();
const mockPutOption = vi.fn();
const mockGetUser = vi.fn();
const mockUpdateUser = vi.fn();
const mockChannelGroupFindFirst = vi.fn();
const mockOverrideFindUnique = vi.fn();
const mockOverrideFindFirst = vi.fn();
const mockOverrideFindMany = vi.fn();
const mockOverrideUpsert = vi.fn();
const mockOverrideUpdate = vi.fn();

vi.mock('@/lib/newapi/client', () => ({
    getOption: (...args: unknown[]) => mockGetOption(...args),
    putOption: (...args: unknown[]) => mockPutOption(...args),
    getUser: (...args: unknown[]) => mockGetUser(...args),
    updateUser: (...args: unknown[]) => mockUpdateUser(...args),
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
    },
}));

import {
    disableUserTierMultiplier,
    GROUP_GROUP_RATIO_OPTION,
    internalNewApiUserGroup,
    parseGroupGroupRatio,
    saveUserTierMultiplier,
} from '@/lib/newapi/user-tier-multiplier';

const portalUser = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', tenant_id: 'tenant-1', newapi_user_id: 12 };
const internalGroup = internalNewApiUserGroup(portalUser.id);
let options: Record<string, string>;
let liveUser: Record<string, unknown>;

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
});
