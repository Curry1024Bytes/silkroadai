import 'server-only';

import {
    copyChannelStrict,
    getChannelStrict,
    getChannelPluginCredentialMetadataStrict,
    getOption,
    getTokenForCustomer,
    getUser,
    putOption,
    setChannelStatusStrict,
    updateChannelStrict,
    updateTokenForCustomer,
    updateUser,
    type NewApiChannel,
    type NewApiToken,
    type NewApiPluginCredentialMetadata,
} from '@/lib/newapi/client';
import { internalNewApiUserGroup } from '@/lib/newapi/user-tier-multiplier';
import { CustomerPricingError, fingerprint } from './math';
import type { NativeModelPrice, NativeTokenBinding } from './types';

export type NativeCustomerAuth = { accessToken: string; userId: number };
export type SafeTokenSnapshot = Omit<NewApiToken, 'key'>;
export type NativeAutoPermissions = Record<'auto' | '+:auto' | '-:auto', { present: boolean; value?: string }>;
export interface PreparedNativeModelPrice extends NativeModelPrice {
    source_fingerprint: string;
}
export interface NativePreviousBinding {
    model_groups: string[];
    token_snapshots: SafeTokenSnapshot[];
    original_user_group: string;
    original_auto_permissions?: NativeAutoPermissions;
}
type NativeOptionChange = { key: string; before: string | null; after: string; attempted: boolean; verified: boolean };
type NativeTokenChange = {
    before: SafeTokenSnapshot;
    after: NativeTokenBinding;
    attempted: boolean;
    verified: boolean;
};
/** Persist before each remote write. Credentials and complete channel payloads never enter this journal. */
export interface NativeSnapshot {
    version: 1;
    operation: 'prepare' | 'publish' | 'restore';
    phase: string;
    options: NativeOptionChange[];
    tokens: NativeTokenChange[];
    user: { id: number; before_group: string; after_group: string; attempted: boolean; verified: boolean } | null;
    created_channels: Array<{ id: number; source_id: number; group: string; model: string; configured: boolean }>;
    pending_copy: { source_id: number; suffix: string; group: string; model: string } | null;
}
export type NativeJournal = NativeSnapshot;
export type NativeProgress = (journal: NativeJournal) => Promise<void>;
export interface NativePublishArgs {
    customerAuth: NativeCustomerAuth;
    portalUserId: string;
    publicGroup: string;
    models: Array<NativeModelPrice & { source_fingerprint?: string }>;
    portalTokenIds: number[];
    previousBinding?: NativePreviousBinding;
    originalUserGroup?: string;
    originalAutoPermissions?: NativeAutoPermissions;
    keepUserGroup?: boolean;
}
export interface NativePublishResult {
    model_groups: string[];
    token_snapshots: SafeTokenSnapshot[];
    original_user_group: string;
    original_auto_permissions: NativeAutoPermissions;
    before: NativeSnapshot;
}
export interface NativeRestoreArgs {
    customerAuth: NativeCustomerAuth;
    portalUserId: string;
    publicGroup: string;
    portalTokenIds: number[];
    previousBinding: NativePreviousBinding;
    otherActiveBindings?: Array<{ model_groups: string[]; original_user_group?: string }>;
}

const SPECIAL_GROUPS = 'group_ratio_setting.group_special_usable_group';
const GROUP_PATTERN = /^portal-price-[a-f0-9]{32}$/;
const VOLATILE_CHANNEL_FIELDS = new Set([
    'id',
    'key',
    'name',
    'tag',
    'remark',
    'created_time',
    'test_time',
    'response_time',
    'balance',
    'balance_updated_time',
    'used_quota',
    'other_info',
    'balance_detail',
    'channel_info',
]);
const fail = (code: string, text: string): never => {
    throw new CustomerPricingError(code, text);
};
function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function dict(raw: string | null, key: string): Record<string, unknown> {
    if (raw === null || raw === '') return {};
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return fail('native_option_invalid', `${key} 配置无法解析，未覆盖。`);
    }
    if (!object(value)) return fail('native_option_invalid', `${key} 配置格式无效，未覆盖。`);
    return value;
}
function row(values: Record<string, unknown>, key: string): Record<string, unknown> {
    if (!Object.hasOwn(values, key)) return {};
    if (!object(values[key])) return fail('native_option_invalid', '客户分组配置格式无效。');
    return { ...values[key] };
}
function autoPermissions(permissions: Record<string, unknown>): NativeAutoPermissions {
    const result = {} as NativeAutoPermissions;
    for (const key of ['auto', '+:auto', '-:auto'] as const) {
        if (Object.hasOwn(permissions, key) && typeof permissions[key] !== 'string')
            fail('native_permission_invalid', '自动分组权限配置无效。');
        result[key] = Object.hasOwn(permissions, key)
            ? { present: true, value: permissions[key] as string }
            : { present: false };
    }
    return result;
}
function csv(value: unknown): string[] {
    return typeof value === 'string'
        ? value
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean)
        : [];
}
function same(a: unknown, b: unknown): boolean {
    return fingerprint(a) === fingerprint(b);
}
function equivalentRaw(a: string | null, b: string | null): boolean {
    if (a === b) return true;
    try {
        return same(JSON.parse(a ?? 'null'), JSON.parse(b ?? 'null'));
    } catch {
        return false;
    }
}
function fresh(operation: NativeSnapshot['operation']): NativeSnapshot {
    return {
        version: 1,
        operation,
        phase: 'preflight',
        options: [],
        tokens: [],
        user: null,
        created_channels: [],
        pending_copy: null,
    };
}
async function progress(journal: NativeJournal, phase: string, callback: NativeProgress) {
    journal.phase = phase;
    await callback(structuredClone(journal));
}
function safeToken(token: NewApiToken): SafeTokenSnapshot {
    // An explicit allowlist prevents future server response fields carrying credentials into audit JSON.
    return {
        id: token.id,
        user_id: token.user_id,
        status: token.status,
        name: token.name,
        created_time: token.created_time,
        accessed_time: token.accessed_time,
        expired_time: token.expired_time,
        remain_quota: token.remain_quota,
        unlimited_quota: token.unlimited_quota,
        model_limits_enabled: token.model_limits_enabled,
        model_limits: token.model_limits,
        used_quota: token.used_quota,
        group: token.group,
        allow_ips: token.allow_ips ?? null,
        cross_group_retry: token.cross_group_retry ?? false,
        auto_groups: token.auto_groups ?? null,
    };
}
function binding(token: Pick<SafeTokenSnapshot, 'group' | 'auto_groups' | 'cross_group_retry'>): NativeTokenBinding {
    return {
        group: token.group,
        auto_groups: token.group === 'auto' ? (token.auto_groups ?? null) : null,
        cross_group_retry: token.group === 'auto' ? (token.cross_group_retry ?? false) : false,
    };
}
function validModels(models: NativeModelPrice[]) {
    if (
        !models.length ||
        new Set(models.map((m) => m.group)).size !== models.length ||
        new Set(models.map((m) => m.model_name)).size !== models.length
    )
        fail('native_models_invalid', '内部模型分组必须完整、非空且唯一。');
    for (const m of models) {
        if (
            !GROUP_PATTERN.test(m.group) ||
            !m.model_name.trim() ||
            !(m.public_ratio > 0) ||
            !(m.customer_ratio > 0) ||
            !Number.isFinite(m.public_ratio) ||
            !Number.isFinite(m.customer_ratio) ||
            !m.source_channel_ids.length ||
            new Set(m.source_channel_ids).size !== m.source_channel_ids.length
        )
            fail('native_models_invalid', '内部模型分组或计费倍率无效。');
    }
}
function channelConfig(channel: NewApiChannel) {
    const config = Object.fromEntries(Object.entries(channel).filter(([key]) => !VOLATILE_CHANNEL_FIELDS.has(key)));
    if (object(channel.channel_info)) {
        config.channel_info = {
            is_multi_key: channel.channel_info.is_multi_key,
            multi_key_size: channel.channel_info.multi_key_size,
            multi_key_mode: channel.channel_info.multi_key_mode,
        };
    }
    return config;
}
function replicaConfig(channel: NewApiChannel) {
    const config = channelConfig(channel);
    delete config.models;
    delete config.group;
    delete config.test_model;
    delete config.status;
    return config;
}
function assertReplica(replica: NewApiChannel, source: NewApiChannel, model: NativeModelPrice) {
    if (
        replica.status !== 1 ||
        replica.group !== model.group ||
        replica.models !== model.model_name ||
        !same(replicaConfig(replica), replicaConfig(source))
    )
        fail('native_replica_mismatch', '内部渠道副本与源渠道或模型归属不一致，请先核对。');
}

async function pluginKeyMetadata(source: NewApiChannel): Promise<NewApiPluginCredentialMetadata[] | null> {
    if (Number(source.type) !== 61) return null;
    const items = await getChannelPluginCredentialMetadataStrict(source.id);
    if (items.some((item) => item.label !== '' || item.account_id !== '' || item.expires_at !== 0 || item.needs_login))
        fail(
            'native_plugin_login_required',
            '该插件渠道使用绑定渠道的登录凭据，官方接口不允许复制；请先为内部副本独立完成插件登录。静态 API Key 插件渠道可直接设置专属价格。',
        );
    return items;
}

async function assertPluginKeysPreserved(replica: NewApiChannel, metadata: NewApiPluginCredentialMetadata[] | null) {
    if (metadata === null) return;
    const copied = await getChannelPluginCredentialMetadataStrict(replica.id);
    if (!same(metadata, copied))
        fail(
            'native_plugin_credentials_not_copied',
            '官方复制未保留插件渠道的全部凭据，内部副本已暂停；请为副本独立完成插件登录后再核验。',
        );
}

/** Native clone API never reveals a provider key. Existing serving replicas are never rewritten here. */
export async function prepareNativeModelGroups(
    models: Array<NativeModelPrice & { source_fingerprint?: string }>,
    onProgress: NativeProgress,
): Promise<PreparedNativeModelPrice[]> {
    validModels(models);
    const journal = fresh('prepare');
    const publicRatios = dict(await getOption('GroupRatio', true), 'GroupRatio');
    const sourceIds = [...new Set(models.flatMap((m) => m.source_channel_ids))];
    const sources = new Map<number, NewApiChannel>();
    const pluginMetadata = new Map<number, NewApiPluginCredentialMetadata[] | null>();
    for (const id of sourceIds) {
        const source = await getChannelStrict(id);
        if (source.status !== 1) fail('native_source_unsupported', '源渠道未启用。');
        pluginMetadata.set(id, await pluginKeyMetadata(source));
        sources.set(id, source);
    }
    const result: PreparedNativeModelPrice[] = [];
    // Complete all read-only checks before creating any replica.
    for (const model of models) {
        for (const id of model.source_channel_ids)
            if (!csv(sources.get(id)!.models).includes(model.model_name))
                fail('native_source_model_missing', '源渠道已不再提供该模型，请重新预览。');
        const hash = fingerprint(
            model.source_channel_ids.map((id) => ({ id, config: channelConfig(sources.get(id)!) })),
        );
        if (model.replica_channel_ids.length) {
            if (
                model.source_fingerprint !== hash ||
                model.replica_channel_ids.length !== model.source_channel_ids.length
            )
                fail('native_source_changed', '源渠道配置已变化，请先核对内部副本再发布客户价格。');
            for (const [index, id] of model.replica_channel_ids.entries()) {
                const replica = await getChannelStrict(id);
                assertReplica(replica, sources.get(model.source_channel_ids[index])!, model);
                await assertPluginKeysPreserved(replica, pluginMetadata.get(model.source_channel_ids[index])!);
            }
        } else if (Object.hasOwn(publicRatios, model.group)) {
            fail('native_group_collision', '同名内部计费分组已存在但未登记副本，拒绝接管。');
        }
        result.push({ ...model, replica_channel_ids: [...model.replica_channel_ids], source_fingerprint: hash });
    }
    await progress(journal, 'replicas_preflight_complete', onProgress);
    try {
        for (const model of result) {
            if (model.replica_channel_ids.length) continue;
            for (const sourceId of model.source_channel_ids) {
                const source = sources.get(sourceId)!;
                const suffix = `_portal_${model.group.slice(-12)}_${sourceId}`;
                journal.pending_copy = { source_id: sourceId, suffix, group: model.group, model: model.model_name };
                await progress(journal, 'copy_channel_intent', onProgress);
                const id = await copyChannelStrict(sourceId, suffix);
                const created = {
                    id,
                    source_id: sourceId,
                    group: model.group,
                    model: model.model_name,
                    configured: false,
                };
                journal.created_channels.push(created);
                journal.pending_copy = null;
                await progress(journal, 'copy_channel_created', onProgress);
                const copy = await getChannelStrict(id);
                if (copy.status !== source.status || !same(replicaConfig(copy), replicaConfig(source)))
                    fail('native_copy_unsupported', '渠道复制未保留运行配置或登录凭据，未迁移任何 Key。');
                await progress(journal, 'disable_new_replica_intent', onProgress);
                await setChannelStatusStrict(id, 2);
                await assertPluginKeysPreserved(copy, pluginMetadata.get(sourceId)!);
                await progress(journal, 'configure_replica_intent', onProgress);
                const payload: NewApiChannel = {
                    ...copy,
                    group: model.group,
                    models: model.model_name,
                    test_model: model.model_name,
                    tag: `portal-price:${model.group.slice(-12)}`,
                };
                delete payload.key;
                await updateChannelStrict(payload);
                await progress(journal, 'enable_replica_intent', onProgress);
                await setChannelStatusStrict(id, 1);
                const confirmed = await getChannelStrict(id);
                assertReplica(confirmed, source, model);
                await assertPluginKeysPreserved(confirmed, pluginMetadata.get(sourceId)!);
                created.configured = true;
                model.replica_channel_ids.push(id);
                await progress(journal, 'replica_verified', onProgress);
            }
        }
        await progress(journal, 'prepared', onProgress);
        return result;
    } catch (error) {
        // Native copy briefly inherits the public group. Keep disabled replicas because an
        // asynchronous task may already reference their IDs; stopping new routing is enough.
        for (const created of [...journal.created_channels].reverse()) {
            try {
                await progress(journal, 'disable_unpublished_replica_intent', onProgress);
                await setChannelStatusStrict(created.id, 2);
            } catch {
                fail('native_replica_cleanup_failed', '准备渠道失败且副本停用未确认，请按发布记录核对。');
            }
        }
        if (journal.pending_copy)
            fail('native_copy_unconfirmed', '渠道复制结果未确认，可能存在未登记副本；请按发布记录核对后再重试。');
        throw error;
    }
}

async function writeOption(
    journal: NativeSnapshot,
    key: string,
    before: string | null,
    after: string,
    onProgress: NativeProgress,
) {
    if (equivalentRaw(before, after)) return;
    const observed = await getOption(key, true);
    if (!equivalentRaw(observed, before) && !equivalentRaw(observed, after))
        fail('native_option_changed', 'new-api 配置已被其他人修改，请重新预览。');
    const change: NativeOptionChange = { key, before, after, attempted: true, verified: false };
    journal.options.push(change);
    await progress(journal, `option_${key}_intent`, onProgress);
    let failure: unknown;
    try {
        await putOption(key, after, 15_000);
    } catch (error) {
        failure = error;
    }
    if (!equivalentRaw(await getOption(key, true), after)) {
        if (failure) throw failure;
        fail('native_option_unverified', 'new-api 未按预期保存配置，正在保留回滚证据。');
    }
    change.verified = true;
    await progress(journal, `option_${key}_verified`, onProgress);
}
async function writeUser(journal: NativeSnapshot, onProgress: NativeProgress) {
    const change = journal.user!;
    if (change.before_group === change.after_group) return;
    const current = await getUser(change.id);
    if (current.group !== change.before_group) fail('native_user_changed', '客户分组已被其他人修改。');
    change.attempted = true;
    await progress(journal, 'user_group_intent', onProgress);
    let failure: unknown;
    try {
        await updateUser({ ...current, group: change.after_group }, 15_000);
    } catch (error) {
        failure = error;
    }
    if ((await getUser(change.id)).group !== change.after_group) {
        if (failure) throw failure;
        fail('native_user_unverified', '客户分组更新未通过回读核对。');
    }
    change.verified = true;
    await progress(journal, 'user_group_verified', onProgress);
}
async function writeToken(
    journal: NativeSnapshot,
    change: NativeTokenChange,
    auth: NativeCustomerAuth,
    onProgress: NativeProgress,
) {
    const current = await getTokenForCustomer(auth, change.before.id, 10_000);
    if (current.user_id !== auth.userId || !same(binding(current), binding(change.before)))
        fail('native_token_changed', '客户 Key 分组已被其他操作修改，请重新核对。');
    if (same(binding(current), change.after)) return;
    change.attempted = true;
    await progress(journal, `token_${current.id}_intent`, onProgress);
    let failure: unknown;
    try {
        await updateTokenForCustomer(auth, { ...current, ...change.after }, 15_000);
    } catch (error) {
        failure = error;
    }
    const readback = await getTokenForCustomer(auth, current.id, 10_000);
    if (!same(binding(readback), change.after) || readback.status !== current.status) {
        if (failure) throw failure;
        fail('native_token_unverified', '客户 Key 未按预期保存计费分组。');
    }
    change.verified = true;
    await progress(journal, `token_${current.id}_verified`, onProgress);
}

export async function publishNativeCustomerPricing(
    args: NativePublishArgs,
    onProgress: NativeProgress,
): Promise<NativePublishResult> {
    validModels(args.models);
    const journal = fresh('publish');
    const user = await getUser(args.customerAuth.userId);
    const internal = internalNewApiUserGroup(args.portalUserId);
    const original = args.previousBinding?.original_user_group ?? args.originalUserGroup ?? user.group;
    const names = args.models.map((m) => m.group);
    const optionNames = [
        'GroupRatio',
        'GroupGroupRatio',
        SPECIAL_GROUPS,
        'UserUsableGroups',
        'MaxTokenAutoGroups',
        'group_ratio_setting.group_ratio',
        'group_ratio_setting.group_group_ratio',
    ];
    const values = Object.fromEntries(
        await Promise.all(optionNames.map(async (key) => [key, await getOption(key, true)])),
    );
    const max = values.MaxTokenAutoGroups === null ? 5 : Number(values.MaxTokenAutoGroups);
    if (!Number.isSafeInteger(max) || max <= 0) fail('native_auto_limit_invalid', '自动分组数量限制无效。');
    const ratios = dict(values.GroupRatio, 'GroupRatio');
    const usable = dict(values.UserUsableGroups, 'UserUsableGroups');
    if (Object.hasOwn(ratios, internal) || Object.hasOwn(usable, internal))
        fail('native_user_group_collision', '客户内部组与公开分组冲突，拒绝修改。');
    if (!(typeof ratios[args.publicGroup] === 'number' && Number(ratios[args.publicGroup]) > 0))
        fail('native_parent_unavailable', '原公开计费分组不存在或倍率无效。');
    const matrix = dict(values.GroupGroupRatio, 'GroupGroupRatio');
    const special = dict(values[SPECIAL_GROUPS], SPECIAL_GROUPS);
    const customerRatios = row(matrix, internal);
    const permissions = row(special, internal);
    const originalAuto =
        args.previousBinding?.original_auto_permissions ?? args.originalAutoPermissions ?? autoPermissions(permissions);
    permissions.auto = 'Auto';
    delete permissions['+:auto'];
    for (const m of args.models) {
        if (!m.replica_channel_ids.length) fail('native_replica_missing', '内部模型渠道尚未准备完成。');
        if (m.public_ratio !== ratios[args.publicGroup])
            fail('native_public_ratio_changed', '公共倍率已变化，请重新预览。');
        const sourceConfigs: Array<{ id: number; config: Record<string, unknown> }> = [];
        const pluginMetadata = new Map<number, NewApiPluginCredentialMetadata[] | null>();
        for (const id of m.source_channel_ids) {
            const source = await getChannelStrict(id);
            if (
                source.status !== 1 ||
                !csv(source.group).includes(args.publicGroup) ||
                !csv(source.models).includes(m.model_name)
            )
                fail('native_source_changed', '源渠道与公开档次的模型归属已变化，请重新预览。');
            sourceConfigs.push({ id, config: channelConfig(source) });
            pluginMetadata.set(id, await pluginKeyMetadata(source));
        }
        if (!m.source_fingerprint || fingerprint(sourceConfigs) !== m.source_fingerprint)
            fail('native_source_changed', '源渠道配置已变化，请重新准备内部副本。');
        for (const [index, id] of m.replica_channel_ids.entries()) {
            const ch = await getChannelStrict(id);
            if (ch.status !== 1 || ch.group !== m.group || ch.models !== m.model_name)
                fail('native_replica_mismatch', '内部渠道与模型分组不一致。');
            if (!pluginMetadata.has(m.source_channel_ids[index]))
                fail('native_replica_mismatch', '内部渠道副本与来源渠道数量不一致。');
            await assertPluginKeysPreserved(ch, pluginMetadata.get(m.source_channel_ids[index])!);
        }
        ratios[m.group] = m.public_ratio;
        customerRatios[m.group] = m.customer_ratio;
        permissions[m.group] = 'Customer model price';
        delete permissions[`-:${m.group}`];
        delete permissions[`+:${m.group}`];
    }
    delete permissions['-:auto'];
    matrix[internal] = customerRatios;
    special[internal] = permissions;
    if (new Set(args.portalTokenIds).size !== args.portalTokenIds.length)
        fail('native_token_duplicates', '客户 Key 列表重复。');
    const previousTokens = new Map((args.previousBinding?.token_snapshots ?? []).map((t) => [t.id, t]));
    const snapshots: SafeTokenSnapshot[] = [];
    for (const id of args.portalTokenIds) {
        const token = await getTokenForCustomer(args.customerAuth, id, 10_000);
        if (token.user_id !== args.customerAuth.userId || ![1, 2, 3, 4].includes(token.status))
            fail('native_token_unavailable', '选中档次的 Key 不存在、不是该客户所有或状态无法确认。');
        const expectedPrevious = args.previousBinding && {
            group: 'auto',
            auto_groups: args.previousBinding.model_groups,
            cross_group_retry: false,
        };
        if (token.group !== args.publicGroup && !(expectedPrevious && same(binding(token), expectedPrevious)))
            fail('native_token_wrong_tier', '选中 Key 不属于本档次，未迁移其他分组的 Key。');
        const current = safeToken(token);
        snapshots.push(
            previousTokens.get(id) ??
                (token.group === args.publicGroup
                    ? current
                    : { ...current, group: args.publicGroup, auto_groups: null, cross_group_retry: false }),
        );
        journal.tokens.push({
            before: current,
            after: { group: 'auto', auto_groups: names, cross_group_retry: false },
            attempted: false,
            verified: false,
        });
    }
    journal.user = { id: user.id, before_group: user.group, after_group: internal, attempted: false, verified: false };
    await progress(journal, 'publication_preflight_complete', onProgress);
    if (names.length > max)
        await writeOption(journal, 'MaxTokenAutoGroups', values.MaxTokenAutoGroups, String(names.length), onProgress);
    await writeOption(journal, 'GroupRatio', values.GroupRatio, JSON.stringify(ratios), onProgress);
    if (values['group_ratio_setting.group_ratio'] !== null)
        await writeOption(
            journal,
            'group_ratio_setting.group_ratio',
            values['group_ratio_setting.group_ratio'],
            JSON.stringify(ratios),
            onProgress,
        );
    await writeOption(journal, 'GroupGroupRatio', values.GroupGroupRatio, JSON.stringify(matrix), onProgress);
    if (values['group_ratio_setting.group_group_ratio'] !== null)
        await writeOption(
            journal,
            'group_ratio_setting.group_group_ratio',
            values['group_ratio_setting.group_group_ratio'],
            JSON.stringify(matrix),
            onProgress,
        );
    await writeOption(journal, SPECIAL_GROUPS, values[SPECIAL_GROUPS], JSON.stringify(special), onProgress);
    await writeUser(journal, onProgress);
    for (const change of journal.tokens) await writeToken(journal, change, args.customerAuth, onProgress);
    await progress(journal, 'published', onProgress);
    return {
        model_groups: names,
        token_snapshots: snapshots,
        original_user_group: original,
        original_auto_permissions: originalAuto,
        before: journal,
    };
}

/** Restore only this tier's keys; shared replica channels remain for in-flight tasks and other customers. */
export async function restoreNativeCustomerPricing(
    args: NativeRestoreArgs,
    onProgress: NativeProgress,
): Promise<NativeSnapshot> {
    const journal = fresh('restore');
    const user = await getUser(args.customerAuth.userId);
    const internal = internalNewApiUserGroup(args.portalUserId);
    if (user.group !== internal) fail('native_user_changed', '客户内部组已变化，拒绝猜测恢复目标。');
    const snapshotById = new Map(args.previousBinding.token_snapshots.map((t) => [t.id, t]));
    const expected: NativeTokenBinding = {
        group: 'auto',
        auto_groups: args.previousBinding.model_groups,
        cross_group_retry: false,
    };
    for (const id of args.portalTokenIds) {
        const token = await getTokenForCustomer(args.customerAuth, id, 10_000);
        if (token.user_id !== args.customerAuth.userId || !same(binding(token), expected))
            fail('native_token_changed', '该档次 Key 的分组已被修改，未覆盖其他设置。');
        const before = safeToken(token);
        const original = snapshotById.get(id);
        journal.tokens.push({
            before,
            after: original
                ? binding(original)
                : { group: args.publicGroup, auto_groups: null, cross_group_retry: false },
            attempted: false,
            verified: false,
        });
    }
    const [matrixRaw, specialRaw, matrixCopy] = await Promise.all([
        getOption('GroupGroupRatio', true),
        getOption(SPECIAL_GROUPS, true),
        getOption('group_ratio_setting.group_group_ratio', true),
    ]);
    const matrix = dict(matrixRaw, 'GroupGroupRatio');
    const special = dict(specialRaw, SPECIAL_GROUPS);
    const ratios = row(matrix, internal),
        permissions = row(special, internal);
    const others = new Set((args.otherActiveBindings ?? []).flatMap((b) => b.model_groups));
    for (const group of args.previousBinding.model_groups) {
        if (others.has(group)) continue;
        delete ratios[group];
        delete permissions[group];
        delete permissions[`+:${group}`];
        delete permissions[`-:${group}`];
    }
    if (Object.keys(ratios).length) matrix[internal] = ratios;
    else delete matrix[internal];
    if (others.size === 0) {
        const savedAuto =
            args.previousBinding.original_auto_permissions ??
            (() => {
                throw new CustomerPricingError(
                    'native_original_permission_unknown',
                    '缺少最初的自动分组权限记录，未执行恢复。',
                );
            })();
        for (const key of ['auto', '+:auto', '-:auto'] as const) {
            const original = savedAuto[key];
            if (
                !original ||
                typeof original.present !== 'boolean' ||
                (original.present && typeof original.value !== 'string')
            )
                fail('native_original_permission_unknown', '最初的自动分组权限记录无效，未执行恢复。');
            if (original.present) permissions[key] = original.value;
            else delete permissions[key];
        }
    }
    if (Object.keys(permissions).length) special[internal] = permissions;
    else delete special[internal];
    journal.user = {
        id: user.id,
        before_group: user.group,
        after_group: others.size ? internal : args.previousBinding.original_user_group,
        attempted: false,
        verified: false,
    };
    await progress(journal, 'restoration_preflight_complete', onProgress);
    for (const change of journal.tokens) await writeToken(journal, change, args.customerAuth, onProgress);
    await writeUser(journal, onProgress);
    await writeOption(journal, 'GroupGroupRatio', matrixRaw, JSON.stringify(matrix), onProgress);
    if (matrixCopy !== null)
        await writeOption(
            journal,
            'group_ratio_setting.group_group_ratio',
            matrixCopy,
            JSON.stringify(matrix),
            onProgress,
        );
    await writeOption(journal, SPECIAL_GROUPS, specialRaw, JSON.stringify(special), onProgress);
    await progress(journal, 'restored', onProgress);
    return journal;
}

/** Called by the durable publisher on remote failure or a failed local commit. Never stores auth in the journal. */
export async function rollbackNativeSnapshot(
    snapshot: NativeSnapshot,
    auth: NativeCustomerAuth,
    onProgress: NativeProgress,
): Promise<void> {
    const restoreTokens = async () => {
        for (const change of [...snapshot.tokens].reverse()) {
            if (!change.attempted) continue;
            const current = await getTokenForCustomer(auth, change.before.id, 10_000);
            if (same(binding(current), binding(change.before))) continue;
            if (current.user_id !== auth.userId || !same(binding(current), change.after))
                fail('native_rollback_conflict', 'Key 已被其他操作修改，回滚未覆盖该变化。');
            await progress(snapshot, `rollback_token_${current.id}_intent`, onProgress);
            let failure: unknown;
            try {
                await updateTokenForCustomer(auth, { ...current, ...binding(change.before) }, 15_000);
            } catch (error) {
                failure = error;
            }
            if (!same(binding(await getTokenForCustomer(auth, current.id, 10_000)), binding(change.before)))
                if (failure) throw failure;
                else fail('native_rollback_unverified', 'Key 回滚未通过核对。');
        }
    };
    const restoreUser = async () => {
        if (snapshot.user?.attempted) {
            const change = snapshot.user,
                current = await getUser(change.id);
            if (current.group !== change.before_group) {
                if (current.group !== change.after_group)
                    fail('native_rollback_conflict', '客户分组已变化，回滚未覆盖该变化。');
                await progress(snapshot, 'rollback_user_intent', onProgress);
                let failure: unknown;
                try {
                    await updateUser({ ...current, group: change.before_group }, 15_000);
                } catch (error) {
                    failure = error;
                }
                if ((await getUser(current.id)).group !== change.before_group)
                    if (failure) throw failure;
                    else fail('native_rollback_unverified', '客户分组回滚未通过核对。');
            }
        }
    };
    const restoreOptions = async () => {
        for (const change of [...snapshot.options].reverse()) {
            if (!change.attempted) continue;
            const actual = await getOption(change.key, true);
            if (equivalentRaw(actual, change.before)) continue;
            if (!equivalentRaw(actual, change.after))
                fail('native_rollback_conflict', '全局配置已变化，回滚未覆盖其他人的修改。');
            // Missing map options use their empty-map semantics; max-token count uses its native default.
            const target = change.before ?? (change.key === 'MaxTokenAutoGroups' ? '5' : '{}');
            await progress(snapshot, `rollback_option_${change.key}_intent`, onProgress);
            let failure: unknown;
            try {
                await putOption(change.key, target, 15_000);
            } catch (error) {
                failure = error;
            }
            if (!equivalentRaw(await getOption(change.key, true), target))
                if (failure) throw failure;
                else fail('native_rollback_unverified', '计费配置回滚未通过核对。');
        }
    };
    if (snapshot.operation === 'restore') {
        // A restored public-group user cannot assign private Auto groups until their
        // original permissions and internal user group have themselves been restored.
        await restoreOptions();
        await restoreUser();
        await restoreTokens();
    } else {
        await restoreTokens();
        await restoreUser();
        await restoreOptions();
    }
    await progress(snapshot, 'rolled_back', onProgress);
}
