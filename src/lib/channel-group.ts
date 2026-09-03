import 'server-only';
import { prisma } from '@/lib/db';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import { getOption } from '@/lib/newapi/client';
import { ChannelGroupTopology } from '@/lib/channel-group-topology';

// ─────────────────────────────────────────────────────────────────────────
// 档次同步:new-api `UserUsableGroups` 只用于发现/下架,ChannelGroup 才是 Portal
// 侧可售档次事实源。new-api 建 token 要求 group ∈ UserUsableGroups(否则 403),
// 因此仍在读前做安全对账,但绝不能把一个没有渠道归属的上游组直接变成可售档次:
//   - 按 newapi_group 匹配已有行 → 更新 display_name；不会自动复活 disabled 行
//   - new-api 新增的组 → 自动建【disabled 候选】,待 operator 登记唯一渠道、默认
//     关系后再启用
//   - new-api 删掉的组 → enabled=false 软下架(老 key 照常工作,新建选不到)
//   - 显示名以 "@" 开头 = 隐藏组:保留在 UserUsableGroups(new-api 建 token 的
//     门,studio / chat 内部建 key 还要过它)但不对客户展示 —— 对应行软下架、
//     也不自动建行。运维在 new-api 里给显示名加/去 "@" 即可隐/显。
//   - tier_level / is_default / description 仍归 portal 管,不被同步覆盖
// 防御:option 缺失 / JSON 坏 / 字典为空(疑似误清)→ 跳过本轮,DB 现状兜底。
// ─────────────────────────────────────────────────────────────────────────

const SYNC_TTL_MS = 60_000;
let lastSyncAttemptAt = 0;
let inflightSync: Promise<void> | null = null;

/** 测试专用:重置进程内节流状态,让下一次调用真正打 new-api。 */
export function __resetChannelGroupSyncForTests(): void {
    lastSyncAttemptAt = 0;
    inflightSync = null;
}

/** new-api 组名 → portal 档次 key。保留 CJK,只做小写 + 空白转连字符。 */
function slugifyTierKey(group: string): string {
    return group.trim().toLowerCase().replace(/\s+/g, '-');
}

async function runSync(): Promise<void> {
    const raw = await getOption('UserUsableGroups');
    if (raw == null) return; // option 不存在(老版本 new-api)→ 不动 DB

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        console.warn('[channel-group] UserUsableGroups is not valid JSON — skipping sync');
        return;
    }
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.warn('[channel-group] UserUsableGroups is not an object — skipping sync');
        return;
    }
    const live = new Map<string, string>();
    let sawAnyEntry = false;
    for (const [group, name] of Object.entries(parsed as Record<string, unknown>)) {
        if (!group.trim() || typeof name !== 'string') continue;
        sawAnyEntry = true;
        const trimmed = name.trim();
        if (trimmed.startsWith('@')) continue; // "@" 前缀 = 内部组,不对客户展示
        live.set(group, trimmed || group);
    }
    if (!sawAnyEntry) {
        // 全空 = 大概率运维误清,不整锅下架(那会让建 key 全挂)。
        console.warn('[channel-group] UserUsableGroups is empty — skipping sync (keeping current tiers)');
        return;
    }

    const rows = await prisma.channelGroup.findMany({ where: { tenant_id: PLATFORM_TENANT_ID } });
    const ops = [];
    const usedKeys = new Set(rows.map((r) => r.key));
    let nextLevel = rows.reduce((max, r) => Math.max(max, r.tier_level), -1) + 1;
    const covered = new Set<string>();
    for (const row of rows) {
        const name = live.get(row.newapi_group);
        if (name !== undefined) {
            covered.add(row.newapi_group);
            const data: { display_name?: string } = {};
            if (row.display_name !== name) data.display_name = name;
            if (Object.keys(data).length > 0) {
                ops.push(prisma.channelGroup.update({ where: { id: row.id }, data }));
            }
        } else if (row.enabled) {
            ops.push(prisma.channelGroup.update({ where: { id: row.id }, data: { enabled: false } }));
        }
    }

    for (const [group, name] of live) {
        if (covered.has(group)) continue;
        const base = slugifyTierKey(group);
        let key = base;
        for (let i = 2; usedKeys.has(key); i++) key = `${base}-${i}`;
        usedKeys.add(key);
        ops.push(
            prisma.channelGroup.create({
                data: {
                    tenant_id: PLATFORM_TENANT_ID,
                    key,
                    display_name: name,
                    newapi_group: group,
                    tier_level: nextLevel++,
                    enabled: false,
                    is_default: false,
                },
            }),
        );
    }

    if (ops.length > 0) await prisma.$transaction(ops);
}

/**
 * 把 new-api `UserUsableGroups` 同步进 channel_groups(平台 tenant)。60s 进程内
 * 节流(成败都计一次 attempt,new-api 宕机时不会每请求都打一枪);并发请求共享
 * 同一个 in-flight promise。任何失败只 warn 不抛 —— 调用方继续用 DB 现有行。
 */
export async function syncChannelGroupsFromNewApi(): Promise<void> {
    if (inflightSync) return inflightSync;
    if (Date.now() - lastSyncAttemptAt < SYNC_TTL_MS) return;
    lastSyncAttemptAt = Date.now();
    inflightSync = runSync()
        .catch((err) => {
            console.warn('[channel-group] sync from new-api failed — serving existing DB tiers', err);
        })
        .finally(() => {
            inflightSync = null;
        });
    return inflightSync;
}

/**
 * 客户可选的档次 = 某 tenant 下 enabled 的 ChannelGroup,按 tier_level 升序。
 * null tenant_id → 平台主体。返回前统一验证:唯一默认档、每档至少一个渠道、
 * channel_id 与 newapi_group 均不得跨档重复。配置错误直接抛出,禁止继续出售空壳档。
 *
 * 平台 tenant 读之前先跑一轮 new-api 同步(60s 节流 + 失败静默),让 new-api
 * 后台增删 UserUsableGroups 在一分钟内反映到 /keys 档次单选与建 key 校验。
 *
 * 用在:建 key 校验/解析档次(/api/portal/keys POST)+ /keys 页渲染档次单选。
 */
export async function listEnabledChannelGroups(tenantId: string | null) {
    const resolvedTenantId = tenantId ?? PLATFORM_TENANT_ID;
    if (resolvedTenantId === PLATFORM_TENANT_ID) await syncChannelGroupsFromNewApi();
    const groups = await prisma.channelGroup.findMany({
        where: { tenant_id: resolvedTenantId, enabled: true },
        orderBy: { tier_level: 'asc' },
    });
    new ChannelGroupTopology(resolvedTenantId, groups);
    return groups;
}

/**
 * 新开户首个 Key 必须显式使用通过完整拓扑校验后的唯一默认档次。配置缺失、
 * 重复或渠道归属不完整时直接失败,不退回任何写死的 new-api group。
 */
export async function getDefaultChannelGroup(tenantId: string | null) {
    const groups = await listEnabledChannelGroups(tenantId);
    return groups.find((group) => group.is_default)!;
}

// ─────────────────────────────────────────────────────────────────────────
// 档次倍率:同步 new-api `GroupRatio`(与 new-api 自家分组下拉的「Nx 倍率」徽章
// 同源)。60s 进程内缓存(镜像上面 UserUsableGroups 同步节流);new-api 不可达 /
// option 缺失 / JSON 坏 → 返上一次好值(无则空表),/keys 页降级为不显示倍率,
// 不阻塞档次选择。
// ─────────────────────────────────────────────────────────────────────────

let ratioCache: Record<string, number> = {};
let ratioFetchedAt = 0;

/** 测试专用:清空倍率缓存。 */
export function __resetGroupRatioCacheForTests(): void {
    ratioCache = {};
    ratioFetchedAt = 0;
}

/** new-api 组名 → GroupRatio 倍率(如 { 'cc-kiro': 0.4 })。失败时返上次缓存。 */
export async function getGroupRatios(): Promise<Record<string, number>> {
    if (Date.now() - ratioFetchedAt < SYNC_TTL_MS) return ratioCache;
    try {
        const raw = await getOption('GroupRatio');
        if (raw != null) {
            const parsed: unknown = JSON.parse(raw);
            if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const next: Record<string, number> = {};
                for (const [group, ratio] of Object.entries(parsed as Record<string, unknown>)) {
                    if (typeof ratio === 'number' && Number.isFinite(ratio)) next[group] = ratio;
                }
                ratioCache = next;
            }
        }
        ratioFetchedAt = Date.now(); // option 缺失也压节流,别每请求都打 new-api
    } catch {
        ratioFetchedAt = Date.now(); // 失败同样压节流,返 stale
    }
    return ratioCache;
}

/**
 * Per-customer 档次门:若 user.allowed_tier_keys 非空,把可见/可建档次收窄到
 * 这些 key;空数组 = 不限制(看本 tenant 全部 enabled,现状)。
 *
 * 纯函数(不查库)—— 同时用在 /keys 页(收窄展示)和建 key POST(收窄校验),
 * 保证两处用同一套规则。运维按客户在 User.allowed_tier_keys 设值;通用 admin
 * UI 待做。
 */
export function restrictGroupsForUser<T extends { key: string }>(groups: T[], allowedTierKeys: string[]): T[] {
    if (!allowedTierKeys || allowedTierKeys.length === 0) return groups;
    const allow = new Set(allowedTierKeys);
    return groups.filter((g) => allow.has(g.key));
}
