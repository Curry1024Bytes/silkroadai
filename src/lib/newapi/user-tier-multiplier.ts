import 'server-only';

import { prisma } from '@/lib/db';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import { getOption, getUser, putOption, updateUser, type NewApiUser } from '@/lib/newapi/client';

export const GROUP_GROUP_RATIO_OPTION = 'GroupGroupRatio';
const PORTAL_PERSISTENCE_FAILURE =
    'Portal persistence failed; new-api compensation was attempted. Check high-priority logs.';

// GroupGroupRatio is one global JSON option. Serialize Portal-originated
// read/merge/write flows in this process so concurrent admin saves do not
// lose each other's rules. new-api has no CAS/ETag for this option; native
// admin edits remain an operational conflict and are post-write verified.
let optionSyncTail: Promise<void> = Promise.resolve();

async function withOptionSyncLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = optionSyncTail;
    let release: () => void = () => undefined;
    optionSyncTail = new Promise<void>((resolve) => {
        release = resolve;
    });
    await previous;
    try {
        return await work();
    } finally {
        release();
    }
}

type GroupGroupRatio = Record<string, Record<string, number>>;

export class UserTierMultiplierError extends Error {
    constructor(
        message: string,
        public readonly status: number = 502,
    ) {
        super(message);
        this.name = 'UserTierMultiplierError';
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Keep this strict: a malformed upstream option must never be silently
 * replaced by a smaller document when an operator saves one customer rule.
 */
export function parseGroupGroupRatio(raw: string | null): GroupGroupRatio {
    if (raw == null || raw.trim() === '') return {};

    let decoded: unknown;
    try {
        decoded = JSON.parse(raw);
    } catch {
        throw new UserTierMultiplierError(`${GROUP_GROUP_RATIO_OPTION} is not valid JSON; refusing to overwrite it`);
    }
    if (!isRecord(decoded)) {
        throw new UserTierMultiplierError(
            `${GROUP_GROUP_RATIO_OPTION} must be a JSON object; refusing to overwrite it`,
        );
    }

    const result: GroupGroupRatio = {};
    for (const [userGroup, rules] of Object.entries(decoded)) {
        if (!userGroup.trim() || !isRecord(rules)) {
            throw new UserTierMultiplierError(`${GROUP_GROUP_RATIO_OPTION} has an invalid user-group rule`);
        }
        const inner: Record<string, number> = {};
        for (const [billingGroup, ratio] of Object.entries(rules)) {
            if (!billingGroup.trim() || typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0) {
                throw new UserTierMultiplierError(`${GROUP_GROUP_RATIO_OPTION} has an invalid multiplier`);
            }
            inner[billingGroup] = ratio;
        }
        result[userGroup] = inner;
    }
    return result;
}

function cloneGroupGroupRatio(value: GroupGroupRatio): GroupGroupRatio {
    return Object.fromEntries(Object.entries(value).map(([group, rules]) => [group, { ...rules }]));
}

function ratioOptionJson(value: GroupGroupRatio): string {
    return JSON.stringify(value);
}

function equalGroupGroupRatios(left: GroupGroupRatio, right: GroupGroupRatio): boolean {
    const leftGroups = Object.keys(left);
    const rightGroups = Object.keys(right);
    if (leftGroups.length !== rightGroups.length) return false;

    return leftGroups.every((userGroup) => {
        const leftRules = left[userGroup];
        const rightRules = right[userGroup];
        if (!rightRules) return false;
        const leftBillingGroups = Object.keys(leftRules);
        if (leftBillingGroups.length !== Object.keys(rightRules).length) return false;
        return leftBillingGroups.every((billingGroup) => leftRules[billingGroup] === rightRules[billingGroup]);
    });
}

export function internalNewApiUserGroup(portalUserId: string): string {
    // Full UUID removes the collision risk of a short prefix while staying
    // well below new-api User.group's 64-character storage limit.
    return `portal-user-${portalUserId.replaceAll('-', '')}`;
}

function assertSafeInternalGroup(group: string, usableGroupsRaw: string | null, ratiosRaw: string | null): void {
    const usableGroups = parseStringMap(usableGroupsRaw, 'UserUsableGroups');
    if (Object.hasOwn(usableGroups, group)) {
        throw new UserTierMultiplierError(
            `Reserved internal group ${group} is present in UserUsableGroups; remove it from new-api before saving`,
            409,
        );
    }

    const ratios = parseFlatRatioMap(ratiosRaw);
    if (Object.hasOwn(ratios, group)) {
        throw new UserTierMultiplierError(
            `Reserved internal group ${group} is present in GroupRatio; remove it from new-api before saving`,
            409,
        );
    }
}

function parseStringMap(raw: string | null, optionName: string): Record<string, string> {
    if (raw == null || raw.trim() === '') return {};
    let decoded: unknown;
    try {
        decoded = JSON.parse(raw);
    } catch {
        throw new UserTierMultiplierError(`${optionName} is not valid JSON; cannot verify internal group visibility`);
    }
    if (!isRecord(decoded) || Object.values(decoded).some((value) => typeof value !== 'string')) {
        throw new UserTierMultiplierError(`${optionName} is malformed; cannot verify internal group visibility`);
    }
    return decoded as Record<string, string>;
}

function parseFlatRatioMap(raw: string | null): Record<string, number> {
    if (raw == null || raw.trim() === '') return {};
    let decoded: unknown;
    try {
        decoded = JSON.parse(raw);
    } catch {
        throw new UserTierMultiplierError('GroupRatio is not valid JSON; cannot verify internal group visibility');
    }
    if (
        !isRecord(decoded) ||
        Object.values(decoded).some((value) => typeof value !== 'number' || !Number.isFinite(value))
    ) {
        throw new UserTierMultiplierError('GroupRatio is malformed; cannot verify internal group visibility');
    }
    return decoded as Record<string, number>;
}

/**
 * A timeout can mean either "new-api rejected the write" or "new-api committed
 * it but the response was lost". Read back the exact state before deciding
 * whether Portal may continue or compensate.
 */
async function updateUserGroupWithReadback(args: {
    user: NewApiUser;
    group: string;
    operation: string;
    force?: boolean;
}): Promise<boolean> {
    if (!args.force && args.user.group === args.group) return false;

    try {
        await updateUser({ ...args.user, group: args.group });
        return true;
    } catch (writeErr) {
        try {
            const reloaded = await getUser(args.user.id);
            if (reloaded.group === args.group) return true;
        } catch (readErr) {
            console.error('[user-tier-multiplier] CRITICAL cannot reconcile uncertain new-api user write', {
                operation: args.operation,
                userId: args.user.id,
                writeError: writeErr instanceof Error ? writeErr.message : String(writeErr),
                readError: readErr instanceof Error ? readErr.message : String(readErr),
            });
        }
        throw writeErr;
    }
}

async function putGroupGroupRatioWithReadback(args: { value: string; operation: string }): Promise<boolean> {
    const expected = parseGroupGroupRatio(args.value);
    try {
        await putOption(GROUP_GROUP_RATIO_OPTION, args.value);
        return true;
    } catch (writeErr) {
        try {
            const actual = parseGroupGroupRatio(await getOption(GROUP_GROUP_RATIO_OPTION));
            if (equalGroupGroupRatios(actual, expected)) return true;
        } catch (readErr) {
            console.error('[user-tier-multiplier] CRITICAL cannot reconcile uncertain new-api option write', {
                operation: args.operation,
                option: GROUP_GROUP_RATIO_OPTION,
                writeError: writeErr instanceof Error ? writeErr.message : String(writeErr),
                readError: readErr instanceof Error ? readErr.message : String(readErr),
            });
        }
        throw writeErr;
    }
}

async function rollbackNewApiState(args: {
    user: NewApiUser;
    originalRatioJson: string;
    changedUser: boolean;
    changedRatio: boolean;
    operation: string;
}): Promise<void> {
    const failures: unknown[] = [];
    if (args.changedRatio) {
        try {
            await putGroupGroupRatioWithReadback({
                value: args.originalRatioJson,
                operation: `${args.operation}-restore-option`,
            });
        } catch (err) {
            failures.push(err);
        }
    }
    if (args.changedUser) {
        try {
            await updateUserGroupWithReadback({
                user: args.user,
                group: args.user.group,
                operation: `${args.operation}-restore-user`,
                force: true,
            });
        } catch (err) {
            failures.push(err);
        }
    }
    if (failures.length > 0) {
        console.error('[user-tier-multiplier] CRITICAL new-api rollback failed', {
            operation: args.operation,
            userId: args.user.id,
            failures: failures.map((failure) => (failure instanceof Error ? failure.message : String(failure))),
        });
    }
}

async function verifyNewApiState(args: {
    userId: number;
    userGroup: string;
    expectedRatio: number | undefined;
    billingGroup: string;
}) {
    const [reloadedUser, ratioRaw] = await Promise.all([getUser(args.userId), getOption(GROUP_GROUP_RATIO_OPTION)]);
    const ratios = parseGroupGroupRatio(ratioRaw);
    const actual = ratios[args.userGroup]?.[args.billingGroup];
    if (reloadedUser.group !== args.userGroup || actual !== args.expectedRatio) {
        throw new UserTierMultiplierError('new-api did not persist the requested dedicated multiplier');
    }
}

export async function listUserTierMultipliers(userId: string) {
    return prisma.userTierMultiplier.findMany({
        where: { user_id: userId, enabled: true },
        orderBy: { created_at: 'asc' },
        select: {
            id: true,
            tier_key: true,
            newapi_billing_group: true,
            multiplier: true,
            synced_at: true,
            created_at: true,
            updated_at: true,
        },
    });
}

async function saveUserTierMultiplierUnlocked(args: {
    user: { id: string; tenant_id: string | null; newapi_user_id: number | null };
    tierKey: string;
    multiplier: number;
    createdBy: string | null;
}) {
    if (args.user.newapi_user_id == null) {
        throw new UserTierMultiplierError('Customer has no linked new-api account', 409);
    }
    if (!Number.isFinite(args.multiplier) || args.multiplier <= 0 || args.multiplier > 100) {
        throw new UserTierMultiplierError('Multiplier must be a positive number no greater than 100', 400);
    }

    const tier = await prisma.channelGroup.findFirst({
        where: { tenant_id: args.user.tenant_id ?? PLATFORM_TENANT_ID, key: args.tierKey, enabled: true },
        select: { key: true, newapi_group: true, display_name: true },
    });
    if (!tier) throw new UserTierMultiplierError('Selected Portal tier is unavailable', 400);

    const [existing, conflictingGroupRule, priorActiveOverride] = await Promise.all([
        prisma.userTierMultiplier.findUnique({
            where: { user_id_tier_key: { user_id: args.user.id, tier_key: tier.key } },
            select: { id: true, newapi_user_group: true, original_newapi_user_group: true },
        }),
        prisma.userTierMultiplier.findFirst({
            where: {
                user_id: args.user.id,
                enabled: true,
                newapi_billing_group: tier.newapi_group,
                NOT: { tier_key: tier.key },
            },
            select: { tier_key: true },
        }),
        prisma.userTierMultiplier.findFirst({
            where: { user_id: args.user.id, enabled: true },
            select: { original_newapi_user_group: true },
        }),
    ]);
    if (conflictingGroupRule) {
        throw new UserTierMultiplierError(
            `Portal tier ${conflictingGroupRule.tier_key} already owns this new-api billing group for the customer`,
            409,
        );
    }
    const internalGroup = existing?.newapi_user_group ?? internalNewApiUserGroup(args.user.id);

    const [newApiUser, originalRatioRaw, usableGroupsRaw, publicRatiosRaw] = await Promise.all([
        getUser(args.user.newapi_user_id),
        getOption(GROUP_GROUP_RATIO_OPTION),
        getOption('UserUsableGroups'),
        getOption('GroupRatio'),
    ]);
    assertSafeInternalGroup(internalGroup, usableGroupsRaw, publicRatiosRaw);
    const publicRatios = parseFlatRatioMap(publicRatiosRaw);
    if (!Object.hasOwn(publicRatios, tier.newapi_group)) {
        throw new UserTierMultiplierError(
            `new-api GroupRatio does not contain the selected billing group ${tier.newapi_group}`,
            409,
        );
    }
    const originalRatios = parseGroupGroupRatio(originalRatioRaw);
    const nextRatios = cloneGroupGroupRatio(originalRatios);
    nextRatios[internalGroup] = { ...nextRatios[internalGroup], [tier.newapi_group]: args.multiplier };
    const nextRatioJson = ratioOptionJson(nextRatios);
    const originalRatioJson = originalRatioRaw ?? '{}';
    // Multiple Portal tiers can map to different new-api billing groups for
    // the same customer. They all share the one User.group, so every row must
    // retain the very first pre-override group for last-rule restoration.
    const originalUserGroup =
        existing?.original_newapi_user_group ?? priorActiveOverride?.original_newapi_user_group ?? newApiUser.group;

    let changedUser = false;
    let changedRatio = false;
    try {
        if (newApiUser.group !== internalGroup) {
            // Mark before the network call: a failed response is ambiguous,
            // so compensation must assume new-api may have committed it.
            changedUser = true;
            await updateUserGroupWithReadback({
                user: newApiUser,
                group: internalGroup,
                operation: 'save-set-user-group',
            });
        }
        changedRatio = true;
        await putGroupGroupRatioWithReadback({
            value: nextRatioJson,
            operation: 'save-set-option',
        });
        await verifyNewApiState({
            userId: args.user.newapi_user_id,
            userGroup: internalGroup,
            billingGroup: tier.newapi_group,
            expectedRatio: args.multiplier,
        });

        try {
            const now = new Date();
            return await prisma.userTierMultiplier.upsert({
                where: { user_id_tier_key: { user_id: args.user.id, tier_key: tier.key } },
                create: {
                    user_id: args.user.id,
                    tier_key: tier.key,
                    newapi_billing_group: tier.newapi_group,
                    newapi_user_group: internalGroup,
                    original_newapi_user_group: originalUserGroup,
                    multiplier: args.multiplier,
                    enabled: true,
                    synced_at: now,
                    created_by: args.createdBy,
                },
                update: {
                    newapi_billing_group: tier.newapi_group,
                    newapi_user_group: internalGroup,
                    original_newapi_user_group: originalUserGroup,
                    multiplier: args.multiplier,
                    enabled: true,
                    synced_at: now,
                    created_by: args.createdBy,
                },
                select: {
                    id: true,
                    tier_key: true,
                    newapi_billing_group: true,
                    multiplier: true,
                    synced_at: true,
                    created_at: true,
                    updated_at: true,
                },
            });
        } catch {
            await rollbackNewApiState({
                user: newApiUser,
                originalRatioJson,
                changedUser,
                changedRatio,
                operation: 'persist-save',
            });
            throw new UserTierMultiplierError(PORTAL_PERSISTENCE_FAILURE);
        }
    } catch (err) {
        if (!(err instanceof UserTierMultiplierError && err.message === PORTAL_PERSISTENCE_FAILURE)) {
            await rollbackNewApiState({
                user: newApiUser,
                originalRatioJson,
                changedUser,
                changedRatio,
                operation: 'save',
            });
        }
        throw err;
    }
}

async function disableUserTierMultiplierUnlocked(args: {
    user: { id: string; newapi_user_id: number | null };
    overrideId: string;
}) {
    if (args.user.newapi_user_id == null) {
        throw new UserTierMultiplierError('Customer has no linked new-api account', 409);
    }

    const override = await prisma.userTierMultiplier.findFirst({
        where: { id: args.overrideId, user_id: args.user.id, enabled: true },
        select: {
            id: true,
            tier_key: true,
            newapi_billing_group: true,
            newapi_user_group: true,
            original_newapi_user_group: true,
        },
    });
    if (!override) throw new UserTierMultiplierError('Dedicated multiplier not found', 404);

    const [newApiUser, originalRatioRaw, activeRules] = await Promise.all([
        getUser(args.user.newapi_user_id),
        getOption(GROUP_GROUP_RATIO_OPTION),
        prisma.userTierMultiplier.findMany({
            where: { user_id: args.user.id, enabled: true, NOT: { id: override.id } },
            select: { id: true },
        }),
    ]);
    if (newApiUser.group !== override.newapi_user_group) {
        throw new UserTierMultiplierError(
            'new-api user group changed outside Portal; refusing to remove a rule unsafely',
            409,
        );
    }

    const originalRatios = parseGroupGroupRatio(originalRatioRaw);
    const nextRatios = cloneGroupGroupRatio(originalRatios);
    const perUser = nextRatios[override.newapi_user_group];
    if (perUser) {
        delete perUser[override.newapi_billing_group];
        if (Object.keys(perUser).length === 0) delete nextRatios[override.newapi_user_group];
    }
    const nextRatioJson = ratioOptionJson(nextRatios);
    const originalRatioJson = originalRatioRaw ?? '{}';
    const isLastRule = activeRules.length === 0;
    const restoredGroup = isLastRule ? override.original_newapi_user_group : override.newapi_user_group;

    let changedUser = false;
    let changedRatio = false;
    try {
        if (isLastRule) {
            changedUser = newApiUser.group !== restoredGroup;
            await updateUserGroupWithReadback({
                user: newApiUser,
                group: restoredGroup,
                operation: 'delete-restore-user-group',
            });
        }
        changedRatio = true;
        await putGroupGroupRatioWithReadback({
            value: nextRatioJson,
            operation: 'delete-remove-option',
        });
        await verifyNewApiState({
            userId: args.user.newapi_user_id,
            userGroup: restoredGroup,
            billingGroup: override.newapi_billing_group,
            expectedRatio: nextRatios[restoredGroup]?.[override.newapi_billing_group],
        });

        try {
            return await prisma.userTierMultiplier.update({
                where: { id: override.id },
                data: { enabled: false, synced_at: new Date() },
                select: { id: true },
            });
        } catch {
            await rollbackNewApiState({
                user: newApiUser,
                originalRatioJson,
                changedUser,
                changedRatio,
                operation: 'persist-delete',
            });
            throw new UserTierMultiplierError(PORTAL_PERSISTENCE_FAILURE);
        }
    } catch (err) {
        if (!(err instanceof UserTierMultiplierError && err.message === PORTAL_PERSISTENCE_FAILURE)) {
            await rollbackNewApiState({
                user: newApiUser,
                originalRatioJson,
                changedUser,
                changedRatio,
                operation: 'delete',
            });
        }
        throw err;
    }
}

/** Serialize all Portal updates to new-api's global GroupGroupRatio option. */
export function saveUserTierMultiplier(args: Parameters<typeof saveUserTierMultiplierUnlocked>[0]) {
    return withOptionSyncLock(() => saveUserTierMultiplierUnlocked(args));
}

/** Serialize deletes with saves so global-option updates cannot interleave. */
export function disableUserTierMultiplier(args: Parameters<typeof disableUserTierMultiplierUnlocked>[0]) {
    return withOptionSyncLock(() => disableUserTierMultiplierUnlocked(args));
}
