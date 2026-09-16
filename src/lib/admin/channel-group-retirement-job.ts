import 'server-only';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Prisma, ChannelGroupRetirementJob } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { AdminPrincipal } from './auth';
import { tenantScope } from './tenant-scope';
import { retirementTenantId, retirementTenantScope, retirementAdminScope } from './channel-group-retirement-scope';
import { canonicalSync } from './newapi-sync-plan';
import { assertPricingCatalogWritable, lockPricingPublisher, PricingPublishError } from './pricing-publish-lock';
import {
    buildChannelGroupRetirement,
    commitChannelGroupRetirement,
    ChannelGroupRetirementError,
} from './channel-group-retirement';
import { readChannelGroupRetirementSource, type ChannelGroupRetirementSource } from './channel-group-retirement-source';
import {
    inspectCustomerTokenForRevocation,
    revokeVerifiedCustomerToken,
    confirmPreviouslyAbsentCustomerToken,
    inspectStoredCustomerToken,
    confirmAbsentStoredCustomerToken,
    TokenRevocationError,
    type TokenRevocationMetadata,
} from '@/lib/newapi/token-revocation';
import type {
    ChannelGroupRetirementPreview,
    ChannelGroupRetirementKeyPreview,
    ChannelGroupRetirementJobView,
    ChannelGroupRetirementOrphan,
    ChannelGroupRetirementResult,
} from './channel-group-retirement-types';

export type RetirementJobSelection = {
    groupId: string | null;
    tenantId: string | null;
    tierKey: string;
    newapiGroup: string;
    replacementDefaultId?: string | null;
    /** Only for already-missing orphan keys; never authorizes a remote DELETE. */
    archiveOnly?: boolean;
};
type JobDb = Pick<Prisma.TransactionClient, 'channelGroup' | 'catalogModel' | 'newApiToken'>;
const keySelect = {
    id: true,
    user_id: true,
    newapi_token_id: true,
    newapi_token_value: true,
    key_alias: true,
    tier: true,
    status: true,
    user: { select: { id: true, tenant_id: true, newapi_user_id: true, newapi_access_token: true } },
} satisfies Prisma.NewApiTokenSelect;
type LocalKey = Prisma.NewApiTokenGetPayload<{ select: typeof keySelect }>;
type ObservedKey = {
    local: {
        id: string;
        user_id: string;
        newapi_user_id: number | null;
        newapi_token_id: number;
        credential_hash: string;
        tier: string;
        status: string;
        label: string;
    };
    preview: ChannelGroupRetirementKeyPreview;
    verified: TokenRevocationMetadata | null;
};
type LocalPlan = {
    preview: ChannelGroupRetirementPreview;
    catalogHash: string;
    keys: LocalKey[];
    cleanup: Awaited<ReturnType<typeof buildChannelGroupRetirement>> | null;
};
type JobPlan = {
    version: 1;
    selection: RetirementJobSelection;
    catalog_hash: string;
    keys: ObservedKey['local'][];
    source: ChannelGroupRetirementSource;
    initial_preview: ChannelGroupRetirementPreview;
};
const LEASE_MS = 120_000;
function json<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}
function digest(value: unknown) {
    return createHash('sha256')
        .update(canonicalSync(json(value)))
        .digest('hex');
}
const unavailable = (message: string) => new ChannelGroupRetirementError('retirement_job_unavailable', message, 503);

function publicSource(source: ChannelGroupRetirementSource): ChannelGroupRetirementSource {
    const messages = {
        missing: 'new-api 未发现该分组或渠道引用。本次仍会逐把核实并撤销明确属于该档的客户 Key。',
        present:
            'new-api 中仍有该分组配置或渠道引用。本次会撤销所列客户 Key 并清理 Portal，不删除 new-api 分组或渠道。',
        unknown: '暂时无法完整确认 new-api 分组配置；每把客户 Key 仍须独立核实所属客户和分组后才能撤销。',
    };
    return { ...source, upstream: { status: source.upstream.status, message: messages[source.upstream.status] } };
}

function assertTargetScope(selection: Pick<RetirementJobSelection, 'tenantId' | 'tierKey'>, admin: AdminPrincipal) {
    const scope = tenantScope(admin);
    if (scope.tenant_id && retirementTenantId(scope.tenant_id) !== retirementTenantId(selection.tenantId))
        throw new ChannelGroupRetirementError('group_not_found', '渠道分组不存在。', 404);
    if (!selection.tierKey.trim() || selection.tierKey.length > 200)
        throw new ChannelGroupRetirementError('invalid_input', '档次标识不能为空。', 400);
}
function assertSelectionScope(selection: RetirementJobSelection, admin: AdminPrincipal) {
    assertTargetScope(selection, admin);
    if (selection.archiveOnly !== undefined && typeof selection.archiveOnly !== 'boolean')
        throw new ChannelGroupRetirementError('invalid_input', '归档模式无效，请重新预览。', 400);
    if (selection.archiveOnly) {
        if (selection.archiveOnly !== true || selection.groupId !== null || selection.newapiGroup !== '')
            throw new ChannelGroupRetirementError('invalid_input', '仅可归档已删除分组的失效 Key。', 400);
        return;
    }
    if (!selection.newapiGroup.trim() || selection.newapiGroup.length > 200)
        throw new ChannelGroupRetirementError('invalid_input', '档次和 new-api 分组名称不能为空。', 400);
}

async function readLocalPlan(
    db: JobDb,
    selection: RetirementJobSelection,
    source: ChannelGroupRetirementSource,
): Promise<LocalPlan> {
    const claimed =
        !selection.archiveOnly &&
        (await db.channelGroup.findFirst({
            where: {
                ...retirementTenantScope(selection.tenantId),
                newapi_group: selection.newapiGroup,
                enabled: true,
                key: { not: selection.tierKey },
            },
            select: { id: true },
        }));
    if (claimed)
        throw new ChannelGroupRetirementError(
            'group_claimed_by_other_tier',
            '该 new-api 分组属于另一个已启用档次，不能从旧档撤销它的 Key。',
        );
    const keys = await db.newApiToken.findMany({
        where: { tier: selection.tierKey, user: retirementTenantScope(selection.tenantId) },
        select: keySelect,
        orderBy: { id: 'asc' },
    });
    if (selection.groupId) {
        const cleanup = await buildChannelGroupRetirement(
            db,
            {
                groupId: selection.groupId,
                tenantId: selection.tenantId,
                replacementDefaultId: selection.replacementDefaultId,
            },
            source,
        );
        if (cleanup.group.key !== selection.tierKey || cleanup.group.newapi_group !== selection.newapiGroup)
            throw new ChannelGroupRetirementError('preview_stale', '分组标识已变化，请重新预览。');
        // Catalogue rows remain scoped to the selected group's actual tenant.
        // Customer keys include both historical null and canonical platform users.
        cleanup.preview.existing_keys = {
            total: keys.length,
            active: keys.filter((key) => key.status === 'active').length,
        };
        return {
            preview: cleanup.preview,
            keys,
            cleanup,
            catalogHash: digest({ groups: cleanup.snapshot.groups, catalog: cleanup.snapshot.catalog }),
        };
    }
    if (selection.replacementDefaultId)
        throw new ChannelGroupRetirementError('invalid_input', '遗留 Key 清理不需要替换默认档。', 400);
    const existing = await db.channelGroup.findFirst({
        where: { ...retirementTenantScope(selection.tenantId), key: selection.tierKey },
        select: { id: true },
    });
    if (existing) throw new ChannelGroupRetirementError('group_exists', '该分组仍存在，请从分组列表发起清理。');
    if (!keys.length) throw new ChannelGroupRetirementError('orphan_not_found', '未找到本租户该档次的遗留 Key。', 404);
    const preview: ChannelGroupRetirementPreview = {
        group: {
            id: `orphan:${selection.tierKey}`,
            key: selection.tierKey,
            display_name: selection.tierKey,
            newapi_group: selection.archiveOnly ? null : selection.newapiGroup,
            is_default: false,
            enabled: false,
        },
        models: [],
        existing_keys: { total: keys.length, active: keys.filter((key) => key.status === 'active').length },
        default_candidates: [],
        replacement_default_id: null,
        upstream: source.upstream,
        issues: [],
        canApply: true,
        preview_token: '',
    };
    return {
        preview,
        keys,
        cleanup: null,
        catalogHash: digest({ absent: true, tenant: selection.tenantId, tier: selection.tierKey }),
    };
}

function safeKey(key: LocalKey): ObservedKey['local'] {
    return {
        id: key.id,
        user_id: key.user_id,
        newapi_user_id: key.user.newapi_user_id,
        newapi_token_id: key.newapi_token_id,
        credential_hash: digest(key.newapi_token_value),
        tier: key.tier,
        status: key.status,
        label: key.key_alias,
    };
}
function errorMessage(error: unknown): { code: string; message: string } {
    if (error instanceof TokenRevocationError) {
        const messages: Record<string, string> = {
            owner_mismatch: 'Key 的实际所属客户不匹配，未撤销。',
            token_mismatch: 'new-api 返回的 Key 身份不匹配，未撤销。',
            group_mismatch: 'Key 已属于其他分组，未撤销；请核对迁移记录。',
            authentication_failed: '无法验证客户授权，请恢复连接或授权后重试。',
            invalid_target: '客户或 Key 身份资料不完整，无法安全撤销。',
            delete_not_confirmed: '尚未确认远端撤销结果，请重试核验。',
            credential_still_accepted: '管理记录已移除，但旧 Key 仍被接受；等待缓存失效后再次核验。',
            credential_check_unconfirmed: '管理记录已移除，但尚不能确认旧 Key 失效，请重试核验。',
            token_still_present: '远端 Key 记录仍存在，不能按已失效归档，请重新核对。',
        };
        return { code: error.code, message: messages[error.code] ?? '暂时无法确认 new-api 返回结果，请稍后重试核验。' };
    }
    if (error instanceof ChannelGroupRetirementError || error instanceof PricingPublishError)
        return { code: error.code, message: error.message };
    return { code: 'verification_unavailable', message: '核验暂未完成，请刷新任务后重试；不会将未知结果当作成功。' };
}
async function observeKey(key: LocalKey, group: string, archiveOnly = false): Promise<ObservedKey> {
    const local = safeKey(key);
    const base = { id: key.id, label: key.key_alias, user_id: key.user_id, actual_group: null };
    if (!key.user.newapi_user_id || !key.user.newapi_access_token)
        return {
            local,
            verified: null,
            preview: { ...base, status: 'unknown', message: '客户授权资料不完整，暂不能核实 Key。' },
        };
    try {
        if (archiveOnly) {
            await confirmAbsentStoredCustomerToken(
                { userId: key.user.newapi_user_id, accessToken: key.user.newapi_access_token },
                { tokenId: key.newapi_token_id, ownerId: key.user.newapi_user_id },
                {
                    kind: 'portal_stored_link',
                    tokenId: key.newapi_token_id,
                    ownerId: key.user.newapi_user_id,
                    apiKey: key.newapi_token_value,
                },
            );
            return {
                local,
                verified: null,
                preview: {
                    ...base,
                    status: 'already_absent',
                    message: '已核实远端 Key 不存在且旧凭据失效；仅归档历史记录，不发起撤销。',
                },
            };
        }
        const result = await inspectCustomerTokenForRevocation(
            { userId: key.user.newapi_user_id, accessToken: key.user.newapi_access_token },
            { tokenId: key.newapi_token_id, ownerId: key.user.newapi_user_id, group },
        );
        if (result.state === 'missing') {
            await confirmPreviouslyAbsentCustomerToken(
                { userId: key.user.newapi_user_id, accessToken: key.user.newapi_access_token },
                { tokenId: key.newapi_token_id, ownerId: key.user.newapi_user_id, group },
                {
                    kind: 'portal_stored_link',
                    tokenId: key.newapi_token_id,
                    ownerId: key.user.newapi_user_id,
                    apiKey: key.newapi_token_value,
                },
            );
            return {
                local,
                verified: null,
                preview: {
                    ...base,
                    status: 'already_absent',
                    message:
                        '结合已有客户归属记录，已核实远端记录不存在且旧凭据被拒绝；将归档为已失效，不计为本次撤销。',
                },
            };
        }
        return {
            local,
            verified: result.token,
            preview: {
                ...base,
                actual_group: result.token.group,
                status: 'ready',
                message: '已核对所属客户和分组，可撤销。',
            },
        };
    } catch (error) {
        const safe = errorMessage(error);
        return {
            local,
            verified: null,
            preview: {
                ...base,
                status: error instanceof TokenRevocationError && !error.retryable ? 'blocked' : 'unknown',
                message: safe.message,
            },
        };
    }
}
async function observeKeys(keys: LocalKey[], group: string, archiveOnly = false): Promise<ObservedKey[]> {
    const results: ObservedKey[] = [];
    // Bounded reads, never a remote DELETE during preview.
    for (let offset = 0; offset < keys.length; offset += 4)
        results.push(
            ...(await Promise.all(keys.slice(offset, offset + 4).map((key) => observeKey(key, group, archiveOnly)))),
        );
    return results;
}
function signingSecret() {
    const secret = process.env.PORTAL_JWT_SECRET;
    if (!secret || secret.length < 32) throw unavailable('删除预览签名配置不可用。');
    return secret;
}
function actor(admin: AdminPrincipal) {
    return { id: admin.user?.id ?? null, role: admin.role, tenant: admin.tenant_id, breakGlass: admin.viaBreakGlass };
}
function sign(encoded: string) {
    return createHmac('sha256', signingSecret()).update(`group-retirement-job-v1.${encoded}`).digest('base64url');
}
function previewState(
    local: LocalPlan,
    observed: ObservedKey[],
    source: ChannelGroupRetirementSource,
    selection: RetirementJobSelection,
) {
    return digest({
        catalog: local.catalogHash,
        keys: observed,
        source,
        selection: {
            ...selection,
            archiveOnly: Boolean(selection.archiveOnly),
            replacementDefaultId: local.preview.replacement_default_id,
        },
    });
}
function issuePreview(state: string, admin: AdminPrincipal) {
    const encoded = Buffer.from(
        JSON.stringify({ state, actor: digest(actor(admin)), issuedAt: Date.now(), nonce: randomUUID() }),
    ).toString('base64url');
    return `${encoded}.${sign(encoded)}`;
}
function verifiedPreviewState(token: string, admin: AdminPrincipal): string {
    const parts = token.split('.');
    const invalid = () => new ChannelGroupRetirementError('preview_invalid', '请重新查看撤销 Key 的影响并确认。', 400);
    if (token.length > 4096 || parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)))
        throw invalid();
    const expected = Buffer.from(sign(parts[0])),
        actual = Buffer.from(parts[1]);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw invalid();
    let payload: { state: string; actor: string; issuedAt: number };
    try {
        payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    } catch {
        throw invalid();
    }
    if (
        !payload ||
        typeof payload !== 'object' ||
        payload.actor !== digest(actor(admin)) ||
        !Number.isSafeInteger(payload.issuedAt) ||
        typeof payload.state !== 'string'
    )
        throw invalid();
    const age = Date.now() - payload.issuedAt;
    if (age < 0 || age >= 600_000)
        throw new ChannelGroupRetirementError('preview_expired', '预览已过期，请重新核对 Key 清单。');
    return payload.state;
}
function verifyPreview(token: string, state: string, admin: AdminPrincipal) {
    if (verifiedPreviewState(token, admin) !== state)
        throw new ChannelGroupRetirementError('preview_stale', '分组、模型或 Key 的实际状态已变化，请重新预览。');
}
function decorate(local: LocalPlan, observed: ObservedKey[], selection: RetirementJobSelection) {
    const preview = local.preview;
    preview.revocation = {
        keys: observed.map((key) => key.preview),
        customers: new Set(observed.map((key) => key.local.user_id)).size,
        expected_group: selection.archiveOnly ? null : selection.newapiGroup,
        orphaned: !selection.groupId,
        ...(selection.archiveOnly ? { archive_only: true } : {}),
    };
    const unresolved = observed.filter((key) => !['ready', 'already_absent'].includes(key.preview.status));
    if (unresolved.length)
        preview.issues.push({
            code: 'key_identity_unverified',
            message: `${unresolved.length} 把 Key 的实际归属或状态尚未核实，请先处理下方提示。`,
        });
    preview.canApply = preview.issues.length === 0;
    return preview;
}

async function retirementSource(selection: RetirementJobSelection): Promise<ChannelGroupRetirementSource> {
    if (!selection.archiveOnly) return publicSource(await readChannelGroupRetirementSource(selection.newapiGroup));
    // An unknown former group is never guessed or sent to new-api as a default group.
    return {
        group_name: '',
        upstream: {
            status: 'unknown',
            message: '原分组名称无需恢复；本次仅核验并归档已经失效的遗留 Key，不发送远端删除请求。',
        },
        evidence: { channels: null, usable_groups: null, ratio_groups: null },
    };
}

/**
 * Explanation only: neither this label nor a history match authorizes DELETE.
 * Authorization binds the signed exact group, owner/id/credential snapshot and
 * a fresh strict remote inspection. Rebuild the explanation on apply so the
 * durable initial preview records server-verified context, never a UI claim.
 */
async function orphanGroupExplanation(
    keys: LocalKey[],
    selection: RetirementJobSelection,
): Promise<NonNullable<ChannelGroupRetirementPreview['group_resolution']>> {
    if (selection.archiveOnly)
        return {
            source: 'already_absent',
            message: '远端 Key 均已不存在。核验旧凭据失效后只归档记录，无需恢复原分组名，也不会发起撤销。',
        };
    const history = await prisma.channelGroupRetirementJob.findMany({
        where: { ...retirementTenantScope(selection.tenantId), tier_key: selection.tierKey, orphaned: false },
        select: { newapi_group: true, plan: true },
    });
    const originalGroups = new Set<string>();
    for (const record of history) {
        const plan = record.plan as unknown as Partial<JobPlan> | null;
        if (
            !plan ||
            plan.version !== 1 ||
            !plan.selection?.groupId ||
            retirementTenantId(plan.selection.tenantId) !== retirementTenantId(selection.tenantId) ||
            plan.selection.tierKey !== selection.tierKey ||
            plan.selection.newapiGroup !== record.newapi_group ||
            !record.newapi_group.trim() ||
            !Array.isArray(plan.keys)
        )
            continue;
        if (
            keys.some((key) =>
                plan.keys!.some(
                    (saved) =>
                        saved &&
                        saved.id === key.id &&
                        saved.user_id === key.user_id &&
                        saved.newapi_user_id === key.user.newapi_user_id &&
                        saved.newapi_token_id === key.newapi_token_id &&
                        saved.credential_hash === digest(key.newapi_token_value),
                ),
            )
        )
            originalGroups.add(record.newapi_group);
    }
    if (originalGroups.size > 1 || (originalGroups.size === 1 && !originalGroups.has(selection.newapiGroup)))
        throw new ChannelGroupRetirementError(
            'orphan_history_conflict',
            '历史分组与 Key 的当前归属不一致，可能已经迁移。已停止自动清理，请先核对归属。',
            409,
        );
    return originalGroups.size === 1
        ? { source: 'history', message: '已通过保存的分组历史与 Key 身份记录核对归属，请确认下方待撤销清单。' }
        : {
              source: 'current_keys',
              message:
                  '已根据 Key 当前归属识别分组；这不证明历史分组名称。请核对下方待撤销清单，确认这些 Key 仍应停用。',
          };
}

/** Discover current membership from owner-scoped metadata; never infer a group from a tier label. */
export async function previewOrphanRetirementJob(
    target: Pick<RetirementJobSelection, 'tenantId' | 'tierKey'>,
    admin: AdminPrincipal,
) {
    assertTargetScope(target, admin);
    const existing = await prisma.channelGroup.findFirst({
        where: { ...retirementTenantScope(target.tenantId), key: target.tierKey },
        select: { id: true },
    });
    if (existing) throw new ChannelGroupRetirementError('group_exists', '该分组仍存在，请从分组列表发起清理。');
    const keys = await prisma.newApiToken.findMany({
        where: { tier: target.tierKey, user: retirementTenantScope(target.tenantId) },
        select: keySelect,
        orderBy: { id: 'asc' },
    });
    if (!keys.length) throw new ChannelGroupRetirementError('orphan_not_found', '未找到该档次的遗留 Key。', 404);
    const groups = new Set<string>();
    let unknown = 0;
    let present = 0;
    for (let offset = 0; offset < keys.length; offset += 4) {
        const results = await Promise.allSettled(
            keys.slice(offset, offset + 4).map(async (key) => {
                if (!key.user.newapi_user_id || !key.user.newapi_access_token) throw unavailable('客户授权不完整。');
                return inspectStoredCustomerToken(
                    { userId: key.user.newapi_user_id, accessToken: key.user.newapi_access_token },
                    { tokenId: key.newapi_token_id, ownerId: key.user.newapi_user_id },
                );
            }),
        );
        for (const result of results) {
            if (result.status === 'rejected') {
                unknown++;
                continue;
            }
            if (result.value.state === 'present') {
                present++;
                const group = result.value.token.group;
                if (!group.trim() || group.length > 200 || group !== group.trim()) unknown++;
                else groups.add(group);
            }
        }
    }
    if (unknown)
        throw new ChannelGroupRetirementError(
            'orphan_identity_unverified',
            `${unknown} 把 Key 的所属客户或当前分组暂未核实。请恢复连接或客户授权后重新核对，无需填写旧分组名。`,
            409,
        );
    if (groups.size > 1)
        throw new ChannelGroupRetirementError(
            'orphan_groups_conflict',
            '遗留 Key 当前属于多个分组，可能已有迁移。已停止自动清理，请先在 new-api 核对这批 Key 的归属。',
            409,
        );

    const archiveOnly = present === 0;
    const newapiGroup = archiveOnly ? '' : [...groups][0];
    const selection: RetirementJobSelection = {
        ...target,
        groupId: null,
        newapiGroup,
        ...(archiveOnly ? { archiveOnly: true } : {}),
    };
    return previewRetirementJob(selection, admin);
}

export async function previewRetirementJob(selection: RetirementJobSelection, admin: AdminPrincipal) {
    assertSelectionScope(selection, admin);
    const source = await retirementSource(selection);
    const local = await readLocalPlan(prisma, selection, source);
    const observed = await observeKeys(local.keys, selection.newapiGroup, selection.archiveOnly);
    const preview = decorate(local, observed, selection);
    if (!selection.groupId) preview.group_resolution = await orphanGroupExplanation(local.keys, selection);
    preview.preview_token = issuePreview(previewState(local, observed, source, selection), admin);
    return preview;
}

function assertSameSelection(job: ChannelGroupRetirementJob, selection: RetirementJobSelection) {
    if (
        job.group_id !== selection.groupId ||
        job.tenant_id !== selection.tenantId ||
        job.tier_key !== selection.tierKey ||
        job.newapi_group !== selection.newapiGroup ||
        Boolean(storedPlan(job).selection.archiveOnly) !== Boolean(selection.archiveOnly) ||
        (selection.replacementDefaultId && job.replacement_default_id !== selection.replacementDefaultId)
    )
        throw new ChannelGroupRetirementError('preview_invalid', '该预览不属于当前选择的分组。', 400);
}

export async function startRetirementJob(selection: RetirementJobSelection, admin: AdminPrincipal, token: string) {
    assertSelectionScope(selection, admin);
    verifiedPreviewState(token, admin);
    const previewHash = digest(token);
    const previous = await prisma.channelGroupRetirementJob.findFirst({
        where: { preview_hash: previewHash, ...retirementAdminScope(admin) },
    });
    if (previous) {
        assertSameSelection(previous, selection);
        return jobView(previous);
    }
    const source = await retirementSource(selection);
    const before = await readLocalPlan(prisma, selection, source);
    const observed = await observeKeys(before.keys, selection.newapiGroup, selection.archiveOnly);
    const resolution = selection.groupId ? undefined : await orphanGroupExplanation(before.keys, selection);
    const created = await prisma.$transaction(
        async (tx) => {
            // Serialize idempotent submissions before checking the global busy guard.
            await lockPricingPublisher(tx);
            const previous = await tx.channelGroupRetirementJob.findFirst({
                where: { preview_hash: previewHash, ...retirementAdminScope(admin) },
            });
            if (previous) {
                assertSameSelection(previous, selection);
                return previous;
            }
            await assertPricingCatalogWritable(tx);
            const local = await readLocalPlan(tx, selection, source);
            if (digest(local.keys.map(safeKey)) !== digest(observed.map((key) => key.local)))
                throw new ChannelGroupRetirementError('preview_stale', 'Key 清单已变化，请重新预览。');
            const preview = decorate(local, observed, selection);
            if (resolution) preview.group_resolution = resolution;
            verifyPreview(token, previewState(local, observed, source, selection), admin);
            if (!preview.canApply)
                throw new ChannelGroupRetirementError('retirement_blocked', preview.issues[0].message);
            const savedSelection = { ...selection, replacementDefaultId: preview.replacement_default_id };
            const plan: JobPlan = {
                version: 1,
                selection: savedSelection,
                catalog_hash: local.catalogHash,
                keys: observed.map((key) => key.local),
                source,
                initial_preview: preview,
            };
            const job = await tx.channelGroupRetirementJob.create({
                data: {
                    tenant_id: selection.tenantId,
                    requested_by: admin.user?.id ?? null,
                    group_id: selection.groupId,
                    tier_key: selection.tierKey,
                    group_name: preview.group.display_name,
                    newapi_group: selection.newapiGroup,
                    replacement_default_id: preview.replacement_default_id,
                    orphaned: !selection.groupId,
                    preview_hash: previewHash,
                    plan: json(plan) as unknown as Prisma.InputJsonValue,
                    status: 'queued',
                    message: selection.archiveOnly
                        ? '已冻结相关变更，等待逐项重新核验并归档失效 Key；不会发送远端删除请求。'
                        : '已冻结目录与相关 Key 变更，等待逐项撤销并核验。',
                },
            });
            if (observed.length)
                await tx.channelGroupRetirementKey.createMany({
                    data: observed.map((key) => ({
                        job_id: job.id,
                        portal_key_id: key.local.id,
                        user_id: key.local.user_id,
                        newapi_user_id: key.local.newapi_user_id,
                        newapi_token_id: key.local.newapi_token_id,
                        expected_group: selection.newapiGroup,
                        credential_hash: key.local.credential_hash,
                        ownership_evidence: key.verified ? 'remote_verified' : 'portal_stored_link',
                        label: key.local.label,
                        verified_remote: key.verified
                            ? (json(key.verified) as unknown as Prisma.InputJsonValue)
                            : undefined,
                        verified_at: key.verified ? new Date() : null,
                        status: 'pending',
                        message: selection.archiveOnly ? '等待重新核验并归档。' : '等待撤销。',
                    })),
                });
            return job;
        },
        { isolationLevel: 'Serializable', timeout: 15000 },
    );
    return jobView(created);
}

async function jobView(job: ChannelGroupRetirementJob): Promise<ChannelGroupRetirementJobView> {
    const items = await prisma.channelGroupRetirementKey.findMany({
        where: { job_id: job.id },
        orderBy: { portal_key_id: 'asc' },
    });
    const revoked = items.filter((key) => key.status === 'confirmed').length;
    const alreadyAbsent = items.filter((key) => key.status === 'already_absent').length;
    const confirmed = revoked + alreadyAbsent;
    const failed = items.filter((key) => key.status === 'blocked').length;
    return {
        id: job.id,
        tenant_id: job.tenant_id,
        group_key: job.tier_key,
        group_name: job.group_name,
        newapi_group: job.newapi_group || null,
        orphaned: job.orphaned,
        ...((job.plan as unknown as Partial<JobPlan>)?.selection?.archiveOnly ? { archive_only: true } : {}),
        status: job.status as ChannelGroupRetirementJobView['status'],
        message: job.message,
        summary: {
            total: items.length,
            confirmed,
            pending: items.length - confirmed - failed,
            failed,
            revoked,
            already_absent: alreadyAbsent,
        },
        keys: items.map((key) => ({
            id: key.portal_key_id,
            label: key.label,
            user_id: key.user_id,
            status: key.status as ChannelGroupRetirementJobView['keys'][number]['status'],
            message: key.message,
        })),
        canResume:
            !['succeeded', 'cancelled'].includes(job.status) &&
            (!job.lease_until || job.lease_until.getTime() <= Date.now()),
        canStop:
            !['succeeded', 'cancelled'].includes(job.status) &&
            (!job.lease_until || job.lease_until.getTime() <= Date.now()) &&
            !items.some((item) => item.delete_started_at && !['confirmed', 'already_absent'].includes(item.status)),
        created_at: job.created_at.toISOString(),
        updated_at: job.updated_at.toISOString(),
        result: job.result ? (job.result as unknown as ChannelGroupRetirementResult) : null,
    };
}
export async function getRetirementJob(id: string, admin: AdminPrincipal) {
    const job = await prisma.channelGroupRetirementJob.findFirst({ where: { id, ...retirementAdminScope(admin) } });
    if (!job) throw new ChannelGroupRetirementError('job_not_found', '删除任务不存在。', 404);
    return jobView(job);
}
export async function listRetirementJobs(admin: AdminPrincipal) {
    const [jobs, groups, keys] = await Promise.all([
        prisma.channelGroupRetirementJob.findMany({
            where: retirementAdminScope(admin),
            orderBy: { created_at: 'desc' },
            take: 100,
        }),
        prisma.channelGroup.findMany({ where: retirementAdminScope(admin), select: { tenant_id: true, key: true } }),
        prisma.newApiToken.findMany({
            where: { user: retirementAdminScope(admin) },
            select: {
                id: true,
                user_id: true,
                newapi_token_id: true,
                newapi_token_value: true,
                tier: true,
                status: true,
                user: { select: { tenant_id: true, newapi_user_id: true } },
            },
        }),
    ]);
    const completed = keys.length
        ? await prisma.channelGroupRetirementKey.findMany({
              where: {
                  portal_key_id: { in: keys.map((key) => key.id) },
                  status: { in: ['confirmed', 'already_absent'] },
              },
              select: {
                  portal_key_id: true,
                  user_id: true,
                  newapi_user_id: true,
                  newapi_token_id: true,
                  credential_hash: true,
              },
          })
        : [];
    const archived = (key: (typeof keys)[number]) =>
        key.status === 'disabled' &&
        completed.some(
            (item) =>
                item.portal_key_id === key.id &&
                item.user_id === key.user_id &&
                item.newapi_user_id === key.user.newapi_user_id &&
                item.newapi_token_id === key.newapi_token_id &&
                item.credential_hash === digest(key.newapi_token_value),
        );
    const registered = new Set(groups.map((group) => JSON.stringify([retirementTenantId(group.tenant_id), group.key])));
    const orphaned = new Map<string, ChannelGroupRetirementOrphan>();
    for (const key of keys) {
        const id = JSON.stringify([retirementTenantId(key.user.tenant_id), key.tier]);
        if (registered.has(id) || archived(key)) continue;
        const entry = orphaned.get(id) ?? {
            tenant_id: retirementTenantId(key.user.tenant_id),
            tier_key: key.tier,
            key_count: 0,
            active_key_count: 0,
        };
        entry.key_count++;
        if (key.status === 'active') entry.active_key_count++;
        orphaned.set(id, entry);
    }
    return { jobs: await Promise.all(jobs.map(jobView)), orphan_groups: [...orphaned.values()] };
}

function storedPlan(job: ChannelGroupRetirementJob): JobPlan {
    const plan = job.plan as unknown as JobPlan;
    if (
        !plan ||
        plan.version !== 1 ||
        !plan.selection ||
        plan.selection.tenantId !== job.tenant_id ||
        plan.selection.groupId !== job.group_id ||
        plan.selection.tierKey !== job.tier_key ||
        plan.selection.newapiGroup !== job.newapi_group ||
        (plan.selection.archiveOnly !== undefined && typeof plan.selection.archiveOnly !== 'boolean') ||
        job.orphaned !== (job.group_id === null) ||
        (plan.selection.archiveOnly && (!job.orphaned || job.group_id !== null || job.newapi_group !== '')) ||
        (!plan.selection.archiveOnly && !job.newapi_group.trim()) ||
        !Array.isArray(plan.keys) ||
        !plan.catalog_hash
    )
        throw unavailable('任务快照不完整，不能继续撤销。');
    if (
        plan.selection.archiveOnly &&
        (plan.keys.length === 0 ||
            plan.source?.group_name !== '' ||
            plan.initial_preview?.group?.newapi_group !== null ||
            plan.initial_preview?.revocation?.archive_only !== true ||
            plan.initial_preview.revocation.expected_group !== null ||
            !Array.isArray(plan.initial_preview.revocation.keys) ||
            plan.initial_preview.revocation.keys.length !== plan.keys.length ||
            plan.initial_preview.revocation.keys.some((key) => key.status !== 'already_absent'))
    )
        throw unavailable('失效归档任务快照不完整，不能发送任何远端删除请求。');
    return plan;
}
async function ownedJob(tx: Prisma.TransactionClient, id: string, runner: string) {
    const job = await tx.channelGroupRetirementJob.findFirst({ where: { id, runner_token: runner } });
    if (!job || !job.lease_until || job.lease_until.getTime() <= Date.now())
        throw new ChannelGroupRetirementError('worker_expired', '本次处理时限已结束，请刷新任务继续核验。');
    return job;
}
async function finalizeJob(tx: Prisma.TransactionClient, job: ChannelGroupRetirementJob) {
    const plan = storedPlan(job);
    const local = await readLocalPlan(tx, plan.selection, plan.source);
    if (local.catalogHash !== plan.catalog_hash)
        throw new ChannelGroupRetirementError(
            'catalog_changed',
            '撤销期间分组或模型发生变化，请管理员核对后处理；已撤销的 Key 不会恢复。',
        );
    const current = local.keys.map(safeKey).map((key) => ({ ...key, status: null }));
    const initial = plan.keys.map((key) => ({ ...key, status: null }));
    if (digest(current) !== digest(initial) || local.keys.some((key) => key.status !== 'disabled'))
        throw new ChannelGroupRetirementError('key_scope_changed', 'Key 清单或状态已变化，尚不能完成分组清理。');
    if (!local.preview.canApply)
        throw new ChannelGroupRetirementError('retirement_blocked', local.preview.issues[0].message);
    const result: ChannelGroupRetirementResult = local.cleanup
        ? await commitChannelGroupRetirement(tx, local.cleanup, job.tenant_id)
        : {
              group_key: job.tier_key,
              group_name: job.group_name,
              updated_models: 0,
              disabled_models: 0,
              existing_keys: plan.initial_preview.existing_keys,
              replacement_default_name: null,
          };
    const items = await tx.channelGroupRetirementKey.findMany({
        where: { job_id: job.id },
        select: { status: true, delete_started_at: true, verified_remote: true, ownership_evidence: true },
    });
    if (
        items.length !== plan.keys.length ||
        items.some((item) => !['confirmed', 'already_absent'].includes(item.status))
    )
        throw new ChannelGroupRetirementError('key_confirmation_incomplete', '尚有 Key 未完成核验，不能清理分组。');
    if (
        plan.selection.archiveOnly &&
        items.some(
            (item) =>
                item.status !== 'already_absent' ||
                item.delete_started_at ||
                item.verified_remote ||
                item.ownership_evidence !== 'portal_stored_link',
        )
    )
        throw unavailable('失效归档任务存在不一致的撤销记录，请管理员核对。');
    result.existing_keys = plan.initial_preview.existing_keys;
    result.revoked_keys = items.filter((item) => item.status === 'confirmed').length;
    result.already_absent_keys = items.filter((item) => item.status === 'already_absent').length;
    if (plan.selection.archiveOnly) result.archive_only = true;
    await tx.channelGroupRetirementJob.update({
        where: { id: job.id },
        data: {
            status: 'succeeded',
            message: plan.selection.archiveOnly
                ? '已逐项核验并归档失效 Key，未发送远端删除请求；历史与客户余额保留。'
                : '全部 Key 已完成撤销或已失效归档，分组清理完成；历史与客户余额保留。',
            result: json(result) as unknown as Prisma.InputJsonValue,
            completed_at: new Date(),
            runner_token: null,
            lease_until: null,
        },
    });
}

/** One explicit resume handles at most one key. Durable state survives process/browser interruption. */
export async function resumeRetirementJob(id: string, admin: AdminPrincipal): Promise<ChannelGroupRetirementJobView> {
    const runner = randomUUID();
    const claim = await prisma.$transaction(
        async (tx) => {
            const job = await tx.channelGroupRetirementJob.findFirst({ where: { id, ...retirementAdminScope(admin) } });
            if (!job) throw new ChannelGroupRetirementError('job_not_found', '删除任务不存在。', 404);
            if (
                ['succeeded', 'cancelled'].includes(job.status) ||
                (job.lease_until && job.lease_until.getTime() > Date.now())
            )
                return { job, item: null, skip: true };
            await assertPricingCatalogWritable(tx, { retirementJobId: id });
            const plan = storedPlan(job);
            const items = await tx.channelGroupRetirementKey.findMany({
                where: { job_id: id, status: { notIn: ['confirmed', 'already_absent'] } },
                orderBy: [{ attempts: 'asc' }, { portal_key_id: 'asc' }],
            });
            if (!items.length) {
                await finalizeJob(tx, job);
                return { job, item: null, skip: true };
            }
            const item = items[0];
            await tx.channelGroupRetirementJob.update({
                where: { id },
                data: {
                    status: 'running',
                    runner_token: runner,
                    lease_until: new Date(Date.now() + LEASE_MS),
                    message: plan.selection.archiveOnly
                        ? '正在重新核实并归档失效 Key，不发送远端删除请求。'
                        : '正在逐项核实并撤销 Key。',
                },
            });
            await tx.channelGroupRetirementKey.update({
                where: { id: item.id },
                data: {
                    status: 'revoking',
                    attempts: { increment: 1 },
                    message: '正在核实所属客户、分组与远端结果。',
                },
            });
            return { job, item, skip: false };
        },
        { isolationLevel: 'Serializable', timeout: 15000 },
    );
    if (claim.skip || !claim.item) return getRetirementJob(id, admin);
    const item = claim.item;
    try {
        const key = await prisma.newApiToken.findFirst({
            where: {
                id: item.portal_key_id,
                user_id: item.user_id,
                newapi_token_id: item.newapi_token_id,
                tier: claim.job.tier_key,
                user: retirementTenantScope(claim.job.tenant_id),
            },
            select: { ...keySelect, newapi_token_value: true },
        });
        if (
            !key ||
            key.user.newapi_user_id !== item.newapi_user_id ||
            !key.user.newapi_user_id ||
            !key.user.newapi_access_token
        )
            throw new ChannelGroupRetirementError('key_identity_changed', '客户或 Key 资料已变化，未发送撤销请求。');
        if (digest(key.newapi_token_value) !== item.credential_hash)
            throw new ChannelGroupRetirementError('key_identity_changed', 'Key 凭据已变化，未发送撤销请求。');
        const plan = storedPlan(claim.job);
        const planned = plan.keys.find((entry) => entry.id === item.portal_key_id);
        if (
            !planned ||
            planned.user_id !== item.user_id ||
            planned.newapi_user_id !== item.newapi_user_id ||
            planned.newapi_token_id !== item.newapi_token_id ||
            planned.credential_hash !== item.credential_hash ||
            planned.tier !== claim.job.tier_key ||
            item.expected_group !== claim.job.newapi_group
        )
            throw unavailable('任务 Key 快照不一致，不能继续撤销。');
        const verified = item.verified_remote as unknown as TokenRevocationMetadata | null;
        let completion: 'confirmed' | 'already_absent';
        // The durable intent is committed before remote writes. A resumed attempt
        // reads the remote record first; uncertain results never become success.
        const auth = { userId: key.user.newapi_user_id, accessToken: key.user.newapi_access_token };
        const target = { tokenId: item.newapi_token_id, ownerId: key.user.newapi_user_id, group: item.expected_group };
        if (plan.selection.archiveOnly) {
            if (verified || item.ownership_evidence !== 'portal_stored_link' || item.delete_started_at)
                throw unavailable('失效归档任务的 Key 证据不一致，不能发送远端删除请求。');
            await confirmAbsentStoredCustomerToken(
                auth,
                { tokenId: item.newapi_token_id, ownerId: key.user.newapi_user_id },
                {
                    kind: 'portal_stored_link',
                    tokenId: key.newapi_token_id,
                    ownerId: key.user.newapi_user_id,
                    apiKey: key.newapi_token_value,
                },
            );
            completion = 'already_absent';
        } else if (verified && item.ownership_evidence === 'remote_verified') {
            const revoked = await revokeVerifiedCustomerToken(
                auth,
                target,
                verified,
                key.newapi_token_value,
                async () => {
                    await prisma.$transaction(
                        async (tx) => {
                            await assertPricingCatalogWritable(tx, { retirementJobId: id });
                            const owned = await ownedJob(tx, id, runner);
                            if (owned.lease_until!.getTime() - Date.now() < 60_000)
                                throw new ChannelGroupRetirementError(
                                    'worker_expiring',
                                    '本次处理剩余时限不足，请继续任务后重新核验。',
                                );
                            await tx.channelGroupRetirementKey.update({
                                where: { id: item.id },
                                data: { delete_started_at: new Date(), message: '已记录远端删除意图，正在等待核验。' },
                            });
                        },
                        { isolationLevel: 'Serializable', timeout: 15000 },
                    );
                },
            );
            completion =
                revoked.confirmation === 'already_missing' && !item.delete_started_at ? 'already_absent' : 'confirmed';
        } else if (!verified && item.ownership_evidence === 'portal_stored_link') {
            await confirmPreviouslyAbsentCustomerToken(auth, target, {
                kind: 'portal_stored_link',
                tokenId: key.newapi_token_id,
                ownerId: key.user.newapi_user_id,
                apiKey: key.newapi_token_value,
            });
            completion = 'already_absent';
        } else {
            throw new ChannelGroupRetirementError('identity_unverified', '缺少已核验的归属证据，请重新核对。');
        }
        await prisma.$transaction(
            async (tx) => {
                await assertPricingCatalogWritable(tx, { retirementJobId: id });
                const job = await ownedJob(tx, id, runner);
                const local = await tx.newApiToken.findFirst({
                    where: {
                        id: item.portal_key_id,
                        user_id: item.user_id,
                        newapi_token_id: item.newapi_token_id,
                        tier: job.tier_key,
                        user: { ...retirementTenantScope(job.tenant_id), newapi_user_id: item.newapi_user_id },
                    },
                    select: { id: true, newapi_token_value: true },
                });
                if (!local || digest(local.newapi_token_value) !== item.credential_hash)
                    throw new ChannelGroupRetirementError(
                        'key_identity_changed',
                        '远端已核验，但本地 Key 资料变化，请管理员核对。',
                    );
                await tx.newApiToken.update({ where: { id: local.id }, data: { status: 'disabled' } });
                await tx.channelGroupRetirementKey.update({
                    where: { id: item.id },
                    data: {
                        status: completion,
                        confirmed_at: new Date(),
                        message:
                            completion === 'confirmed'
                                ? '已核实远端记录移除且旧凭据被拒绝，历史记录保留。'
                                : '已结合历史客户归属记录确认该 Key 已失效，完成归档；未计为本次远端撤销。',
                        last_error_code: null,
                    },
                });
                await tx.channelGroupRetirementJob.update({
                    where: { id },
                    data: {
                        runner_token: null,
                        lease_until: null,
                        status: 'queued',
                        message: '本项已核验完成，继续处理剩余 Key。',
                    },
                });
            },
            { isolationLevel: 'Serializable', timeout: 15000 },
        );
    } catch (error) {
        const safe = errorMessage(error);
        await prisma.$transaction(
            async (tx) => {
                await assertPricingCatalogWritable(tx, { retirementJobId: id });
                const job = await tx.channelGroupRetirementJob.findFirst({ where: { id, runner_token: runner } });
                if (!job) return;
                await tx.channelGroupRetirementKey.update({
                    where: { id: item.id },
                    data: { status: 'blocked', message: safe.message, last_error_code: safe.code },
                });
                await tx.channelGroupRetirementJob.update({
                    where: { id },
                    data: {
                        status: 'needs_attention',
                        message: '部分 Key 尚未核验完成；已撤销项不会重复恢复，请重试未完成项。',
                        runner_token: null,
                        lease_until: null,
                    },
                });
            },
            { isolationLevel: 'Serializable', timeout: 15000 },
        );
    }
    return getRetirementJob(id, admin);
}

/** Stop only when no remote write can still be outstanding. Confirmed revocations are never undone. */
export async function stopRetirementJob(id: string, admin: AdminPrincipal) {
    await prisma.$transaction(
        async (tx) => {
            const job = await tx.channelGroupRetirementJob.findFirst({ where: { id, ...retirementAdminScope(admin) } });
            if (!job) throw new ChannelGroupRetirementError('job_not_found', '删除任务不存在。', 404);
            if (['succeeded', 'cancelled'].includes(job.status)) return;
            await assertPricingCatalogWritable(tx, { retirementJobId: id });
            if (job.lease_until && job.lease_until.getTime() > Date.now())
                throw new ChannelGroupRetirementError(
                    'worker_active',
                    '当前 Key 仍在处理中，请等待本项核验完成后停止。',
                );
            const uncertain = await tx.channelGroupRetirementKey.findFirst({
                where: {
                    job_id: id,
                    delete_started_at: { not: null },
                    status: { notIn: ['confirmed', 'already_absent'] },
                },
                select: { id: true },
            });
            if (uncertain)
                throw new ChannelGroupRetirementError(
                    'delete_result_unconfirmed',
                    '存在已发送但尚未确认结果的远端删除，必须先继续核验，不能释放分组变更锁。',
                );
            await tx.channelGroupRetirementJob.update({
                where: { id },
                data: {
                    status: 'cancelled',
                    runner_token: null,
                    lease_until: null,
                    completed_at: new Date(),
                    message: '任务已停止，分组与模型映射保留；已撤销的 Key 不会恢复。处理配置后可重新预览。',
                },
            });
        },
        { isolationLevel: 'Serializable', timeout: 15000 },
    );
    return getRetirementJob(id, admin);
}
