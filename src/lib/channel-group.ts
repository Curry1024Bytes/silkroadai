import 'server-only';
import { prisma } from '@/lib/db';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import { getOption } from '@/lib/newapi/client';

// ─────────────────────────────────────────────────────────────────────────
// 档次同步:new-api `UserUsableGroups` 是唯一事实源(运维只改 new-api,portal
// 60s 内跟进)。new-api 建 token 本来就要求 group ∈ UserUsableGroups(否则
// 403「已被弃用」),所以以它为准同时消除「portal 展示了但 new-api 拒建」的
// 潜在 403。同步规则:
//   - 按 newapi_group 匹配已有行 → 更新 display_name + 置回 enabled(key 不动,
//     已发 key 的 NewApiToken.tier / User.allowed_tier_keys 全不受影响)
//   - new-api 新增的组 → 自动建行(key = 组名 slug,排到现有档次末尾)
//   - new-api 删掉的组 → enabled=false 软下架(老 key 照常工作,新建选不到)
//   - 显示名以 "@" 开头 = 隐藏组:保留在 UserUsableGroups(new-api 建 token 的
//     门,studio / chat 内部建 key 还要过它)但不对客户展示 —— 对应行软下架、
//     也不自动建行。运维在 new-api 里给显示名加/去 "@" 即可隐/显。
//   - 同一 newapi_group 对应多行 portal 档(如 geminit3 与 pool 都指 default)
//     → 只管 enabled,不动 display_name(保留 portal 侧的别名区分)
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
    const rowsPerGroup = new Map<string, number>();
    for (const row of rows) {
        rowsPerGroup.set(row.newapi_group, (rowsPerGroup.get(row.newapi_group) ?? 0) + 1);
    }

    for (const row of rows) {
        const name = live.get(row.newapi_group);
        if (name !== undefined) {
            covered.add(row.newapi_group);
            const data: { display_name?: string; enabled?: boolean } = {};
            // 多行共用一个 newapi_group(portal 侧别名,如 geminit3/pool 都指
            // default)时不动 display_name,否则会把别名改成同一个名字。
            const soleRowForGroup = rowsPerGroup.get(row.newapi_group) === 1;
            if (soleRowForGroup && row.display_name !== name) data.display_name = name;
            if (!row.enabled) data.enabled = true;
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
                    enabled: true,
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
 * 客户可选的档次 = 某 tenant 下 enabled 的 ChannelGroup,按 tier_level 升序
 * (pool=0 在前,official=1 在后)。null tenant_id → 平台主体。
 *
 * 平台 tenant 读之前先跑一轮 new-api 同步(60s 节流 + 失败静默),让 new-api
 * 后台增删 UserUsableGroups 在一分钟内反映到 /keys 档次单选与建 key 校验。
 *
 * 用在:建 key 校验/解析档次(/api/portal/keys POST)+ /keys 页渲染档次单选。
 */
export async function listEnabledChannelGroups(tenantId: string | null) {
    const resolvedTenantId = tenantId ?? PLATFORM_TENANT_ID;
    if (resolvedTenantId === PLATFORM_TENANT_ID) await syncChannelGroupsFromNewApi();
    return prisma.channelGroup.findMany({
        where: { tenant_id: resolvedTenantId, enabled: true },
        orderBy: { tier_level: 'asc' },
    });
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
