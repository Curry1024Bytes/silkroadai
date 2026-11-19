import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NewApiChannel, NewApiToken, NewApiUser } from '@/lib/newapi/client';
import { internalNewApiUserGroup } from '@/lib/newapi/user-tier-multiplier';
import {
    prepareNativeModelGroups,
    publishNativeCustomerPricing,
    restoreNativeCustomerPricing,
    rollbackNativeSnapshot,
    type NativeJournal,
    type NativePublishArgs,
} from '../native';
import type { NativeModelPrice } from '../types';

const api = vi.hoisted(() => ({
    copyChannelStrict: vi.fn(),
    deleteChannelStrict: vi.fn(),
    getChannelStrict: vi.fn(),
    getChannelPluginCredentialMetadataStrict: vi.fn(),
    getOption: vi.fn(),
    getTokenForCustomer: vi.fn(),
    getUser: vi.fn(),
    putOption: vi.fn(),
    setChannelStatusStrict: vi.fn(),
    updateChannelStrict: vi.fn(),
    updateTokenForCustomer: vi.fn(),
    updateUser: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/newapi/client', () => api);
vi.mock('@/lib/newapi/user-tier-multiplier', () => ({
    internalNewApiUserGroup: (id: string) => `portal-user-${id.replaceAll('-', '')}`,
}));
const customer = { accessToken: 'CUSTOMER_PAT_MUST_NOT_BE_PERSISTED', userId: 7 };
const portalId = '12345678-1234-1234-1234-123456789abc';
const internal = internalNewApiUserGroup(portalId);
const ga = `portal-price-${'a'.repeat(32)}`;
const gb = `portal-price-${'b'.repeat(32)}`;
const specialKey = 'group_ratio_setting.group_special_usable_group';
let options: Record<string, string>;
let channels: Map<number, NewApiChannel>;
let tokens: Map<number, NewApiToken>;
let user: NewApiUser;
let nextId: number;
let journals: NativeJournal[];
const record = async (j: NativeJournal) => {
    journals.push(structuredClone(j));
};
function makeToken(id: number, group: string): NewApiToken {
    return {
        id,
        user_id: 7,
        key: 'SECRET_TOKEN_' + id,
        status: 1,
        name: `token-${id}`,
        created_time: 1,
        accessed_time: 2,
        expired_time: -1,
        remain_quota: 123456,
        unlimited_quota: true,
        model_limits_enabled: true,
        model_limits: 'model-a,model-b',
        used_quota: 42,
        group,
        allow_ips: '127.0.0.1',
        cross_group_retry: false,
        auto_groups: null,
    };
}
function models(): NativeModelPrice[] {
    return [
        {
            model_id: 'model-a-id',
            model_name: 'model-a',
            group: ga,
            public_ratio: 1,
            customer_ratio: 2 / 3,
            source_channel_ids: [1],
            replica_channel_ids: [],
        },
        {
            model_id: 'model-b-id',
            model_name: 'model-b',
            group: gb,
            public_ratio: 1,
            customer_ratio: 0.5,
            source_channel_ids: [1],
            replica_channel_ids: [],
        },
    ];
}
function args(prepared: NativeModelPrice[]): NativePublishArgs {
    return {
        customerAuth: customer,
        portalUserId: portalId,
        publicGroup: 'public',
        models: prepared,
        portalTokenIds: [11],
    };
}
beforeEach(() => {
    vi.clearAllMocks();
    journals = [];
    nextId = 100;
    options = {
        GroupRatio: '{"public":1,"kiro":0.5}',
        GroupGroupRatio: '{"other":{"kiro":0.2}}',
        UserUsableGroups: '{"public":"Public","kiro":"Kiro"}',
        [specialKey]: '{"other":{"kiro":"Kiro"}}',
        MaxTokenAutoGroups: '5',
    };
    channels = new Map([
        [
            1,
            {
                id: 1,
                type: 1,
                key: 'PROVIDER_KEY_MUST_NOT_BE_PERSISTED',
                name: 'Source',
                status: 1,
                models: 'model-a,model-b',
                group: 'public',
                base_url: 'https://fixture.invalid',
                priority: 10,
                weight: 100,
                model_mapping: '{"model-a":"upstream-a","model-b":"upstream-b"}',
                setting: '{}',
                settings: '{}',
            },
        ],
    ]);
    tokens = new Map([
        [11, makeToken(11, 'public')],
        [12, makeToken(12, 'kiro')],
    ]);
    user = {
        id: 7,
        username: 'fixture',
        display_name: 'Fixture',
        role: 1,
        status: 1,
        email: '',
        group: 'default',
        quota: 1000000,
        used_quota: 0,
        request_count: 0,
        aff_code: '',
        inviter_id: 0,
        access_token: 'USER_SECRET',
        created_at: 1,
    };
    api.getChannelStrict.mockImplementation(async (id: number) => structuredClone(channels.get(id)!));
    api.getChannelPluginCredentialMetadataStrict.mockImplementation(async (id: number) => {
        const key = String(channels.get(id)?.key ?? '');
        if (!key) return [];
        const encoded = key.includes('plugin_credential') ? JSON.parse(key) : {};
        return [
            {
                index: 0,
                label: encoded.label ?? '',
                account_id: encoded.account_id ?? '',
                expires_at: encoded.expires_at ?? 0,
                needs_login: encoded.needs_login ?? false,
            },
        ];
    });
    api.copyChannelStrict.mockImplementation(async (id: number, suffix: string) => {
        const cloned = {
            ...structuredClone(channels.get(id)!),
            id: nextId++,
            name: String(channels.get(id)!.name) + suffix,
        };
        channels.set(cloned.id, cloned);
        return cloned.id;
    });
    api.setChannelStatusStrict.mockImplementation(async (id: number, status: number) => {
        channels.get(id)!.status = status;
    });
    api.updateChannelStrict.mockImplementation(async (ch: NewApiChannel) => {
        channels.set(ch.id, { ...channels.get(ch.id)!, ...structuredClone(ch) });
    });
    api.getOption.mockImplementation(async (key: string) => options[key] ?? null);
    api.putOption.mockImplementation(async (key: string, value: string) => {
        options[key] = value;
    });
    api.getUser.mockImplementation(async () => structuredClone(user));
    api.updateUser.mockImplementation(async (next: NewApiUser) => {
        user = { ...user, ...structuredClone(next) };
    });
    api.getTokenForCustomer.mockImplementation(async (_auth: unknown, id: number) => structuredClone(tokens.get(id)!));
    api.updateTokenForCustomer.mockImplementation(async (_auth: unknown, token: NewApiToken) => {
        tokens.set(token.id, structuredClone(token));
    });
});

describe('native customer pricing publisher', () => {
    it('prepares single-model replicas without changing a public source or persisting credentials', async () => {
        const source = structuredClone(channels.get(1));
        const result = await prepareNativeModelGroups(models(), record);
        expect(result.map((m) => m.replica_channel_ids)).toEqual([[100], [101]]);
        expect(channels.get(100)).toMatchObject({ models: 'model-a', group: ga, status: 1 });
        expect(channels.get(101)).toMatchObject({ models: 'model-b', group: gb, status: 1 });
        expect(channels.get(1)).toEqual(source);
        expect(JSON.stringify(journals)).not.toContain('PROVIDER_KEY_MUST_NOT_BE_PERSISTED');
        expect(api.updateChannelStrict.mock.calls.every(([payload]) => !Object.hasOwn(payload, 'key'))).toBe(true);
        expect(journals.some((j) => j.phase === 'copy_channel_intent' && j.pending_copy?.source_id === 1)).toBe(true);
    });
    it('rejects an unowned native group and an inactive source before copying', async () => {
        options.GroupRatio = JSON.stringify({ public: 1, [ga]: 1 });
        await expect(prepareNativeModelGroups(models(), record)).rejects.toMatchObject({
            code: 'native_group_collision',
        });
        expect(api.copyChannelStrict).not.toHaveBeenCalled();
        options.GroupRatio = '{"public":1}';
        channels.get(1)!.status = 2;
        await expect(prepareNativeModelGroups(models(), record)).rejects.toMatchObject({
            code: 'native_source_unsupported',
        });
    });
    it('supports official type61 task plugins with static API keys without reading or persisting secrets', async () => {
        channels.get(1)!.type = 61;
        channels.get(1)!.setting = JSON.stringify({ task_plugin_key: 'doubao', task_plugin_keys: ['doubao'] });
        const original = structuredClone(channels.get(1));
        const prepared = await prepareNativeModelGroups(models(), record);
        expect(prepared.map((model) => model.replica_channel_ids)).toEqual([[100], [101]]);
        expect(channels.get(100)).toMatchObject({
            type: 61,
            setting: original!.setting,
            key: 'PROVIDER_KEY_MUST_NOT_BE_PERSISTED',
            group: ga,
            models: 'model-a',
            status: 1,
        });
        expect(channels.get(1)).toEqual(original);
        expect(api.getChannelPluginCredentialMetadataStrict).toHaveBeenCalledWith(1);
        expect(api.getChannelPluginCredentialMetadataStrict).toHaveBeenCalledWith(100);
        expect(JSON.stringify(journals)).not.toContain('PROVIDER_KEY_MUST_NOT_BE_PERSISTED');
        expect(api.updateChannelStrict.mock.calls.every(([payload]) => !Object.hasOwn(payload, 'key'))).toBe(true);
    });
    it('rejects channel-bound plugin login metadata before making a copy or migrating any key', async () => {
        channels.get(1)!.type = 61;
        channels.get(1)!.key = JSON.stringify({
            type: 'plugin_credential',
            label: 'account-label',
            secret: 'DO_NOT_LOG',
        });
        await expect(prepareNativeModelGroups(models(), record)).rejects.toMatchObject({
            code: 'native_plugin_login_required',
        });
        expect(api.copyChannelStrict).not.toHaveBeenCalled();
        expect(api.updateTokenForCustomer).not.toHaveBeenCalled();
        expect(JSON.stringify(journals)).not.toContain('DO_NOT_LOG');
    });
    it('detects an unlabeled login credential dropped by the official copy API and leaves its copy paused', async () => {
        channels.get(1)!.type = 61;
        channels.get(1)!.key = JSON.stringify({ type: 'plugin_credential', secret: 'DO_NOT_LOG' });
        api.copyChannelStrict.mockImplementation(async (id: number, suffix: string) => {
            const cloned = { ...structuredClone(channels.get(id)!), id: nextId++, name: `Source${suffix}`, key: '' };
            channels.set(cloned.id, cloned);
            return cloned.id;
        });
        await expect(prepareNativeModelGroups(models(), record)).rejects.toMatchObject({
            code: 'native_plugin_credentials_not_copied',
        });
        expect(channels.get(100)?.status).toBe(2);
        expect(api.updateChannelStrict).not.toHaveBeenCalled();
        expect(api.updateTokenForCustomer).not.toHaveBeenCalled();
        expect(JSON.stringify(journals)).not.toContain('DO_NOT_LOG');
    });
    it('verifies plugin credential metadata when reusing serving replicas', async () => {
        channels.get(1)!.type = 61;
        const prepared = await prepareNativeModelGroups(models(), record);
        channels.get(100)!.key = '';
        api.copyChannelStrict.mockClear();
        await expect(prepareNativeModelGroups(prepared, record)).rejects.toMatchObject({
            code: 'native_plugin_credentials_not_copied',
        });
        expect(api.copyChannelStrict).not.toHaveBeenCalled();
        expect(api.updateTokenForCustomer).not.toHaveBeenCalled();
    });
    it('does not rewrite serving replicas when source configuration changes', async () => {
        const prepared = await prepareNativeModelGroups(models(), record);
        options.GroupRatio = JSON.stringify({ public: 1, [ga]: 1, [gb]: 1 });
        api.copyChannelStrict.mockClear();
        api.updateChannelStrict.mockClear();
        expect(await prepareNativeModelGroups(prepared, record)).toEqual(prepared);
        channels.get(1)!.base_url = 'https://changed.invalid';
        await expect(prepareNativeModelGroups(prepared, record)).rejects.toMatchObject({
            code: 'native_source_changed',
        });
        expect(api.copyChannelStrict).not.toHaveBeenCalled();
        expect(api.updateChannelStrict).not.toHaveBeenCalled();
    });
    it('retains failed copies disabled so an in-flight public task never loses its channel record', async () => {
        api.updateChannelStrict.mockRejectedValueOnce(new Error('configuration refused'));
        await expect(prepareNativeModelGroups(models(), record)).rejects.toThrow('configuration refused');
        expect(channels.get(100)?.status).toBe(2);
        expect(api.deleteChannelStrict).not.toHaveBeenCalled();
        expect(api.updateTokenForCustomer).not.toHaveBeenCalled();
    });
    it('applies per-model customer factors and only migrates the selected tier key', async () => {
        const prepared = await prepareNativeModelGroups(models(), record);
        const kiro = structuredClone(tokens.get(12));
        const original = structuredClone(tokens.get(11)!);
        const result = await publishNativeCustomerPricing(args(prepared), record);
        expect(JSON.parse(options.GroupRatio)).toEqual({ public: 1, kiro: 0.5, [ga]: 1, [gb]: 1 });
        expect(JSON.parse(options.GroupGroupRatio)).toEqual({
            other: { kiro: 0.2 },
            [internal]: { [ga]: 2 / 3, [gb]: 0.5 },
        });
        expect(tokens.get(11)).toEqual({ ...original, group: 'auto', auto_groups: [ga, gb], cross_group_retry: false });
        expect(tokens.get(12)).toEqual(kiro);
        expect(user.group).toBe(internal);
        expect(result.original_user_group).toBe('default');
        expect(result.token_snapshots[0].group).toBe('public');
        expect(JSON.stringify(result)).not.toContain('SECRET_TOKEN');
        expect(JSON.stringify(result)).not.toContain('USER_SECRET');
        expect(JSON.stringify(result)).not.toContain('CUSTOMER_PAT');
    });
    it('raises the auto-group limit exactly as needed with a durable rollback journal', async () => {
        const prepared = await prepareNativeModelGroups(models(), record);
        options.MaxTokenAutoGroups = '1';
        api.putOption.mockClear();

        const result = await publishNativeCustomerPricing(args(prepared), record);
        expect(options.MaxTokenAutoGroups).toBe('2');
        expect(result.before.options[0]).toMatchObject({
            key: 'MaxTokenAutoGroups',
            before: '1',
            after: '2',
            attempted: true,
            verified: true,
        });
        expect(tokens.get(11)).toMatchObject({ group: 'auto', auto_groups: [ga, gb] });
        await rollbackNativeSnapshot(result.before, customer, record);
        expect(options.MaxTokenAutoGroups).toBe('1');
        expect(tokens.get(11)?.group).toBe('public');
    });
    it('does not lower another operator increase to the auto-group limit during rollback', async () => {
        const prepared = await prepareNativeModelGroups(models(), record);
        options.MaxTokenAutoGroups = '1';
        const result = await publishNativeCustomerPricing(args(prepared), record);
        options.MaxTokenAutoGroups = '20';
        await expect(rollbackNativeSnapshot(result.before, customer, record)).rejects.toMatchObject({
            code: 'native_rollback_conflict',
        });
        expect(options.MaxTokenAutoGroups).toBe('20');
    });
    it('restores the previous auto limit after a later native write fails', async () => {
        const prepared = await prepareNativeModelGroups(models(), record);
        options.MaxTokenAutoGroups = '1';
        const original = api.putOption.getMockImplementation()!;
        api.putOption.mockImplementation(async (key: string, value: string) => {
            if (key === 'GroupRatio') throw new Error('subsequent write failed');
            await original(key, value);
        });
        await expect(publishNativeCustomerPricing(args(prepared), record)).rejects.toThrow('subsequent write failed');
        expect(options.MaxTokenAutoGroups).toBe('2');
        await rollbackNativeSnapshot(journals.at(-1)!, customer, record);
        expect(options.MaxTokenAutoGroups).toBe('1');
        expect(api.updateTokenForCustomer).not.toHaveBeenCalled();
    });
    it.each([2, 3, 4] as const)(
        'preserves inactive token status %s instead of silently reactivating it',
        async (status) => {
            const prepared = await prepareNativeModelGroups(models(), record);
            tokens.get(11)!.status = status;
            await publishNativeCustomerPricing(args(prepared), record);
            expect(tokens.get(11)).toMatchObject({ status, group: 'auto', auto_groups: [ga, gb] });
        },
    );
    it('refuses a key from another tier before any pricing mutation', async () => {
        const prepared = await prepareNativeModelGroups(models(), record);
        api.putOption.mockClear();
        await expect(
            publishNativeCustomerPricing({ ...args(prepared), portalTokenIds: [12] }, record),
        ).rejects.toMatchObject({ code: 'native_token_wrong_tier' });
        expect(api.putOption).not.toHaveBeenCalled();
        expect(api.updateUser).not.toHaveBeenCalled();
    });
    it('accepts a committed token update whose response was lost after verified readback', async () => {
        const prepared = await prepareNativeModelGroups(models(), record);
        api.updateTokenForCustomer.mockImplementationOnce(async (_auth: unknown, t: NewApiToken) => {
            tokens.set(t.id, structuredClone(t));
            throw new Error('response lost');
        });
        const result = await publishNativeCustomerPricing(args(prepared), record);
        expect(result.before.phase).toBe('published');
        expect(result.before.tokens[0].verified).toBe(true);
    });
    it('keeps the first pre-binding snapshot across later edits and restores it without resetting usage', async () => {
        const prepared = await prepareNativeModelGroups(models(), record);
        const result = await publishNativeCustomerPricing(args(prepared), record);
        tokens.get(11)!.used_quota = 999;
        tokens.get(11)!.remain_quota = 10000;
        const edited = await publishNativeCustomerPricing({ ...args(prepared), previousBinding: result }, record);
        expect(edited.token_snapshots[0].group).toBe('public');
        await restoreNativeCustomerPricing(
            {
                customerAuth: customer,
                portalUserId: portalId,
                publicGroup: 'public',
                portalTokenIds: [11],
                previousBinding: edited,
            },
            record,
        );
        expect(tokens.get(11)).toMatchObject({
            group: 'public',
            auto_groups: null,
            used_quota: 999,
            remain_quota: 10000,
            key: 'SECRET_TOKEN_11',
        });
        expect(user.group).toBe('default');
        expect(JSON.parse(options.GroupGroupRatio)).toEqual({ other: { kiro: 0.2 } });
        expect(JSON.parse(options[specialKey])).toEqual({ other: { kiro: 'Kiro' } });
        expect(channels.get(100)?.status).toBe(1);
    });
    it('restores prior auto permission exactly and keeps unrelated permissions', async () => {
        options[specialKey] = JSON.stringify({ [internal]: { '-:auto': 'deny auto', kiro: 'Kiro' } });
        const prepared = await prepareNativeModelGroups(models(), record);
        const result = await publishNativeCustomerPricing(args(prepared), record);
        expect(JSON.parse(options[specialKey])[internal].auto).toBe('Auto');
        await restoreNativeCustomerPricing(
            {
                customerAuth: customer,
                portalUserId: portalId,
                publicGroup: 'public',
                portalTokenIds: [11],
                previousBinding: result,
            },
            record,
        );
        expect(JSON.parse(options[specialKey])[internal]).toEqual({ '-:auto': 'deny auto', kiro: 'Kiro' });
    });
    it('restores newly created keys to the public tier and keeps other active bindings authorized', async () => {
        const prepared = await prepareNativeModelGroups(models(), record);
        const result = await publishNativeCustomerPricing(args(prepared), record);
        tokens.set(13, { ...makeToken(13, 'auto'), auto_groups: [ga, gb] });
        const extra = `portal-price-${'c'.repeat(32)}`;
        const perms = JSON.parse(options[specialKey]);
        perms[internal][extra] = 'Other tier';
        options[specialKey] = JSON.stringify(perms);
        await restoreNativeCustomerPricing(
            {
                customerAuth: customer,
                portalUserId: portalId,
                publicGroup: 'public',
                portalTokenIds: [11, 13],
                previousBinding: result,
                otherActiveBindings: [{ model_groups: [extra] }],
            },
            record,
        );
        expect(tokens.get(13)?.group).toBe('public');
        expect(user.group).toBe(internal);
        expect(JSON.parse(options[specialKey])[internal]).toEqual({ auto: 'Auto', [extra]: 'Other tier' });
    });
    it('rolls back partial publication using the last durable journal while preserving the key and quota', async () => {
        const prepared = await prepareNativeModelGroups(models(), record);
        const before = structuredClone(options);
        api.updateTokenForCustomer.mockRejectedValueOnce(new Error('token update refused'));
        await expect(publishNativeCustomerPricing(args(prepared), record)).rejects.toThrow('token update refused');
        const last = journals.at(-1)!;
        await rollbackNativeSnapshot(last, customer, record);
        expect(tokens.get(11)?.group).toBe('public');
        expect(user.group).toBe('default');
        expect(options).toEqual(before);
    });
    it('does not overwrite an unrelated concurrent global settings change during rollback', async () => {
        const prepared = await prepareNativeModelGroups(models(), record);
        const result = await publishNativeCustomerPricing(args(prepared), record);
        const matrix = JSON.parse(options.GroupGroupRatio);
        matrix.another = { kiro: 0.17 };
        options.GroupGroupRatio = JSON.stringify(matrix);
        await expect(rollbackNativeSnapshot(result.before, customer, record)).rejects.toMatchObject({
            code: 'native_rollback_conflict',
        });
        expect(JSON.parse(options.GroupGroupRatio).another).toEqual({ kiro: 0.17 });
    });
});
