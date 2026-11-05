/**
 * Remote checks for compiled customers: account links, per-user overrides and
 * whether a customer can be moved into or out of its internal group.
 */
import 'server-only';
import { getUser, listGroupUserRatios, listTokensForCustomer } from '@/lib/newapi/client';
import type { Diagnostic } from './compile';
import { SaleRulePublishError } from './errors';
import {
    INTERNAL_GROUP_PREFIX,
    internalGroupFor,
    moveInProblems,
    moveOutProblems,
    parseTokenGroups,
    type LiveSaleOptions,
    type NestedRatioMap,
} from './options';
import type { UserMove } from './plan';
import { isRecord, tenantOf, type Db, type PortalState } from './state';

export interface Resolution {
    held: Map<string, Diagnostic>;
    diagnostics: Diagnostic[];
    moves: UserMove[];
    /** Original new-api group per user, recorded on the mirror rows. */
    originals: Record<string, string>;
}

const TOKEN_PAGE_SIZE = 100;
const TOKEN_PAGE_LIMIT = 50;

/** Every key's parsed group list (disabled keys included: they can be re-enabled). */
async function listCustomerKeyGroups(auth: { accessToken: string; userId: number }): Promise<string[][]> {
    const seen = new Map<number, string[]>();
    for (let page = 1; page <= TOKEN_PAGE_LIMIT; page += 1) {
        const response = await listTokensForCustomer(auth, page, TOKEN_PAGE_SIZE);
        for (const token of response.items) if (!seen.has(token.id)) seen.set(token.id, parseTokenGroups(token.group));
        if (seen.size >= response.total || response.items.length === 0) return [...seen.values()];
    }
    throw new SaleRulePublishError('sale_rules_keys_unreadable', '客户 Key 数量超出核对上限，请人工处理。', 502);
}

/** Move-in sources recorded by earlier publications: survives a lost mirror write. */
async function knownOriginals(db: Db, userIds: Set<string>): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (!userIds.size) return result;
    const publications = await db.pricingRulePublication.findMany({
        orderBy: { created_at: 'desc' },
        take: 200,
        select: { moves: true },
    });
    for (const publication of publications) {
        if (!Array.isArray(publication.moves)) continue;
        for (const move of publication.moves) {
            if (!isRecord(move) || move.direction !== 'in') continue;
            const { userId, from } = move;
            if (typeof userId === 'string' && typeof from === 'string' && from && userIds.has(userId))
                if (!result.has(userId)) result.set(userId, from);
        }
    }
    return result;
}
function hold(resolution: Resolution, userId: string, newapiGroup: string | undefined, code: string, message: string) {
    if (!resolution.held.has(userId))
        resolution.held.set(userId, { level: 'block', code, message, userId, newapiGroup });
}

function note(resolution: Resolution, userId: string, newapiGroup: string | undefined, code: string, message: string) {
    resolution.diagnostics.push({ level: 'warn', code, message, userId, newapiGroup });
}

interface PortalUserRef {
    id: string;
    tenant_id: string | null;
    newapi_user_id: number | null;
    newapi_access_token: string | null;
}

interface ResolveArgs {
    db: Db;
    state: PortalState;
    live: LiveSaleOptions;
    owned: Record<string, string[]>;
    nextRows: NestedRatioMap;
}

/** Per-user ratios outrank GroupGroupRatio: an owned customer with one cannot be priced by the publisher. */
async function checkUserOverrides(
    resolution: Resolution,
    group: string,
    members: string[],
    byNewApiId: Map<number, string>,
) {
    let overrides: Array<{ user_id: number; ratio: number }>;
    try {
        overrides = await listGroupUserRatios(group);
    } catch {
        for (const userId of members)
            hold(resolution, userId, group, 'group_check_failed', '无法读取 new-api 用户单独倍率，本次跳过该客户。');
        return;
    }
    let others = 0;
    for (const row of overrides) {
        const userId = byNewApiId.get(row.user_id);
        if (userId && members.includes(userId))
            hold(
                resolution,
                userId,
                group,
                'group_user_ratio_override',
                '该客户在 new-api 有单独的用户倍率，优先级高于专属倍率，请先在 new-api 删除。',
            );
        else others += 1;
    }
    if (others)
        resolution.diagnostics.push({
            level: 'warn',
            code: 'group_user_ratio_present',
            message: `该计费分组有 ${others} 个用户设置了 new-api 单独倍率，售卖规则对他们不生效。`,
            newapiGroup: group,
        });
}
/** Customers without a new-api account, or whose tenant differs from the group's, are never rewritten. */
function checkLinks(resolution: Resolution, args: ResolveArgs, users: Map<string, PortalUserRef>) {
    const groupTenant = new Map(args.state.groups.map((group) => [group.newapi_group, tenantOf(group.tenant_id)]));
    for (const [group, members] of Object.entries(args.owned))
        for (const userId of members) {
            const user = users.get(userId);
            if (!user || user.newapi_user_id === null)
                hold(resolution, userId, group, 'customer_unlinked', '客户不存在或未开通 new-api 账号。');
            else if (tenantOf(user.tenant_id) !== groupTenant.get(group))
                hold(resolution, userId, group, 'tenant_mismatch', '客户所属主体与计费分组不一致。');
        }
}

/** Original group recorded for a customer: enabled mirror row, then publication history, then the latest row. */
function recordedOriginal(rows: PortalState['multipliers'], fromHistory: string | undefined): string | undefined {
    const enabled = rows.find((row) => row.enabled && row.original_newapi_user_group);
    if (enabled) return enabled.original_newapi_user_group;
    if (fromHistory) return fromHistory;
    return [...rows]
        .filter((row) => row.original_newapi_user_group)
        .sort((left, right) => right.updated_at.getTime() - left.updated_at.getTime())[0]?.original_newapi_user_group;
}

interface MoveContext {
    resolution: Resolution;
    live: LiveSaleOptions;
    userId: string;
    newapiUserId: number;
    /** First owned group, used to place diagnostics. */
    group: string;
    internal: string;
    recorded: string | undefined;
    claimsInternal: boolean;
    legacy: boolean;
    auth: { accessToken: string; userId: number } | null;
}

async function keyGroupsOrNull(auth: { accessToken: string; userId: number }): Promise<string[][] | null> {
    try {
        return await listCustomerKeyGroups(auth);
    } catch {
        return null;
    }
}
/** The customer needs rows in its internal group: make sure it is (or can safely be moved) there. */
async function planMoveIn(ctx: MoveContext, remoteGroup: string) {
    const { resolution, userId, group, internal } = ctx;
    if (remoteGroup === internal) {
        if (ctx.recorded) resolution.originals[userId] = ctx.recorded;
        else hold(resolution, userId, group, 'original_group_unknown', '客户已在内部分组但原分组未记录，请人工核对。');
        return;
    }
    const foreign = !remoteGroup || remoteGroup.startsWith(INTERNAL_GROUP_PREFIX);
    if (foreign || (ctx.claimsInternal && remoteGroup !== ctx.recorded)) {
        hold(resolution, userId, group, 'user_group_drift', '客户的 new-api 分组在 Portal 之外被修改，请人工核对。');
        return;
    }
    if (!ctx.auth) {
        hold(resolution, userId, group, 'customer_keys_unreadable', '缺少客户凭据，无法核对客户 Key。');
        return;
    }
    const keyGroups = await keyGroupsOrNull(ctx.auth);
    if (!keyGroups) {
        hold(resolution, userId, group, 'customer_keys_unreadable', '无法读取客户 Key，本次跳过该客户。');
        return;
    }
    const problems = moveInProblems({ live: ctx.live, fromGroup: remoteGroup, internalGroup: internal, keyGroups });
    if (problems.length) {
        hold(resolution, userId, group, 'move_in_blocked', `无法启用专属倍率：${problems.join('；')}`);
        return;
    }
    resolution.moves.push({ userId, newapiUserId: ctx.newapiUserId, from: remoteGroup, to: internal, direction: 'in' });
    resolution.originals[userId] = remoteGroup;
}

/** No rows left for the customer: return it to its original group when that is safe. Never held. */
async function planMoveOut(ctx: MoveContext) {
    const { resolution, userId, group, internal } = ctx;
    const skip = (message: string) => note(resolution, userId, group, 'move_out_skipped', message);
    if (ctx.legacy) return skip('客户仍有旧专属倍率，暂不移回原分组。');
    if (!ctx.recorded || ctx.recorded === internal) return skip('原分组未记录，客户暂留内部分组。');
    if (!ctx.auth) return skip('缺少客户凭据，客户暂留内部分组。');
    const keyGroups = await keyGroupsOrNull(ctx.auth);
    if (!keyGroups) return skip('无法读取客户 Key，客户暂留内部分组。');
    const problems = moveOutProblems({ live: ctx.live, internalGroup: internal, toGroup: ctx.recorded, keyGroups });
    if (problems.length) return skip(`客户暂留内部分组：${problems.join('；')}`);
    resolution.moves.push({
        userId,
        newapiUserId: ctx.newapiUserId,
        from: internal,
        to: ctx.recorded,
        direction: 'out',
    });
}
async function resolveMoves(resolution: Resolution, args: ResolveArgs, users: Map<string, PortalUserRef>) {
    const firstGroup = new Map<string, string>();
    for (const [group, members] of Object.entries(args.owned))
        for (const userId of members) if (!firstGroup.has(userId)) firstGroup.set(userId, group);
    const pending = [...firstGroup.keys()].filter((userId) => !resolution.held.has(userId)).sort();
    const history = await knownOriginals(args.db, new Set(pending));
    for (const userId of pending) {
        const user = users.get(userId)!;
        const rows = args.state.multipliers.filter((row) => row.user_id === userId);
        const enabled = rows.filter((row) => row.enabled);
        const internal = internalGroupFor(userId);
        const ctx: MoveContext = {
            resolution,
            live: args.live,
            userId,
            newapiUserId: user.newapi_user_id!,
            group: firstGroup.get(userId)!,
            internal,
            recorded: recordedOriginal(rows, history.get(userId)),
            claimsInternal: enabled.some((row) => row.newapi_user_group === internal),
            legacy: enabled.some((row) => !row.managed_by_rules),
            auth: user.newapi_access_token
                ? { accessToken: user.newapi_access_token, userId: user.newapi_user_id! }
                : null,
        };
        const needsInternal = Object.keys(args.nextRows[internal] ?? {}).length > 0;
        let remoteGroup: string | null = null;
        try {
            remoteGroup = (await getUser(ctx.newapiUserId)).group ?? '';
        } catch {
            remoteGroup = null;
        }
        if (needsInternal) {
            if (remoteGroup === null)
                hold(resolution, userId, ctx.group, 'customer_check_failed', '无法读取客户 new-api 账号，本次跳过。');
            else await planMoveIn(ctx, remoteGroup);
        } else if (remoteGroup === null) note(resolution, userId, ctx.group, 'move_out_skipped', '无法读取客户账号。');
        else if (remoteGroup === internal) await planMoveOut(ctx);
    }
}

/** Remote checks for every owned customer. Sequential: customer counts are small and new-api is shared. */
export async function resolveRemote(args: ResolveArgs): Promise<Resolution> {
    const resolution: Resolution = { held: new Map(), diagnostics: [], moves: [], originals: {} };
    const ids = [...new Set(Object.values(args.owned).flat())];
    const rows: PortalUserRef[] = ids.length
        ? await args.db.user.findMany({
              where: { id: { in: ids } },
              select: { id: true, tenant_id: true, newapi_user_id: true, newapi_access_token: true },
          })
        : [];
    const users = new Map(rows.map((user) => [user.id, user]));
    const byNewApiId = new Map(
        rows.flatMap((user): Array<[number, string]> =>
            user.newapi_user_id === null ? [] : [[user.newapi_user_id, user.id]],
        ),
    );
    checkLinks(resolution, args, users);
    for (const [group, members] of Object.entries(args.owned))
        await checkUserOverrides(resolution, group, members, byNewApiId);
    await resolveMoves(resolution, args, users);
    return resolution;
}
