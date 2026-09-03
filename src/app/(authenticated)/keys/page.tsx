/**
 * /keys — API Keys list + create + revoke + reveal.
 *
 * Layout has already auth-gated; we just need the user.id to scope the
 * Prisma list query. Revoked keys (status != 'active') are filtered out
 * server-side so they never reach the UI.
 *
 * The full token_value is intentionally NOT shipped here — only an
 * obfuscated mask. The UI fetches the real sk- on demand via
 * /api/portal/keys/[id]/key, which performs its own auth + ownership check.
 */
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { getTokenUsageWithCache } from '@/lib/newapi/token-usage';
import { quotaToCny } from '@/lib/newapi/quota-units';
import { formatTokenForDisplay } from '@/lib/newapi/token-format';
import { listEnabledChannelGroups, restrictGroupsForUser, getGroupRatios } from '@/lib/channel-group';
import { listUserTierMultipliers } from '@/lib/newapi/user-tier-multiplier';
import { KeysList, type KeyRow } from './keys-list';
import { KeysSnippetsPanel } from './keys-snippets-panel';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'API Keys — LLmRoute' };

async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/keys', {
        method: 'GET',
        headers: { cookie },
    });
    return getCurrentUser(req);
}

/** Mask a sk-xxxx-looking string as `sk-xxxx****yyyy`. Defensive: if the
 *  value is shorter than the prefix+suffix we'd reveal, fully mask it. */
function maskKey(value: string): string {
    if (value.length <= 12) return '*'.repeat(Math.max(8, value.length));
    return `${value.slice(0, 7)}****${value.slice(-4)}`;
}

export default async function KeysPage() {
    const user = await getSessionUser();
    // Layout already gated; null branch only to satisfy TS narrowing.
    if (!user) return null;

    const tokens = await prisma.newApiToken.findMany({
        where: { user_id: user.id, status: 'active' },
        orderBy: { created_at: 'asc' },
        select: {
            id: true,
            key_alias: true,
            newapi_token_value: true,
            newapi_token_id: true,
            tier: true,
            created_at: true,
            // 2026-08-15:把 60s 行缓存的两列一并捞出来传给 getTokenUsageWithCache,
            // 省掉它内部对【刚查过的同一行】再做一次 findUnique(N 个 key = N 次多余往返)。
            cached_used_quota: true,
            cached_used_at: true,
        },
    });

    // W6 D4: parallel per-token usage fetch,每 token 走各自的 60s 行缓存
    // (⚠️ 不是批量合并的,冷缓存时是 N 发上游,见 token-usage.ts 头注释)。
    // 单个 token 失败只影响该行快照(记 warn + 该行不显示用量)。
    // 2026-08-15:档次/倍率两项本来串在这段之后白等一个 RTT,一并并到这里。
    const [usageSnaps, tierGroupsRaw, ratios, overrides] = await Promise.all([
        Promise.all(
            tokens.map(async (t) => {
                if (user.newapi_user_id == null) return null;
                try {
                    return await getTokenUsageWithCache({
                        prismaTokenId: t.id,
                        newapiUserId: user.newapi_user_id,
                        newapiTokenId: t.newapi_token_id,
                        cachedRow: { cached_used_quota: t.cached_used_quota, cached_used_at: t.cached_used_at },
                    });
                } catch (err) {
                    console.warn(`[keys] usage fetch failed for token ${t.id}:`, err);
                    return null;
                }
            }),
        ),
        listEnabledChannelGroups(user.tenant_id).catch((err) => {
            console.error('[keys] invalid channel-group topology; disabling key creation', err);
            return [];
        }),
        getGroupRatios(),
        listUserTierMultipliers(user.id).catch((err) => {
            console.warn(`[keys] dedicated multiplier lookup failed for user ${user.id}:`, err);
            return [];
        }),
    ]);

    const overrideByTier = new Map(overrides.map((override) => [override.tier_key, Number(override.multiplier)]));
    const newApiGroupByTier = new Map(tierGroupsRaw.map((group) => [group.key, group.newapi_group]));

    const rows: KeyRow[] = tokens.map((t, i) => {
        const snap = usageSnaps[i];
        return {
            id: t.id,
            key_alias: t.key_alias,
            // W7 D4 PR-H Tier A: stored value is the bare 48-char id;
            // wire format requires `sk-` prefix. Apply at the display
            // boundary so the masked output reads `sk-XXXX****YYYY`
            // matching the customer's expectation when they paste into
            // their `Authorization: Bearer …` header.
            masked_key: maskKey(formatTokenForDisplay(t.newapi_token_value)),
            created_at: t.created_at.toISOString(),
            // BigInt → number is safe here: even a power user burning
            // 10^15 quota a year is well within Number.MAX_SAFE_INTEGER.
            // Pass null for failed lookups so UI can hide the row's
            // usage line gracefully.
            used_quota: snap ? Number(snap.used_quota) : null,
            // ¥ computed server-side; keys-list is a client island (server-only FX env).
            usedCny: snap ? quotaToCny(Number(snap.used_quota)) : null,
            last_used_at: snap?.last_used_at ? snap.last_used_at.toISOString() : null,
            tier: t.tier,
            effective_ratio: overrideByTier.get(t.tier) ?? ratios[newApiGroupByTier.get(t.tier) ?? ''] ?? null,
        };
    });

    // P3: enabled 档次(低价号池 / 官方稳定)供建 key 时单选。数据驱动 —
    // 客户 tenant 下 enabled 的 ChannelGroup,再按 per-customer 白名单收窄
    // (allowed_tier_keys 非空 → 只显示这些档;空 → 全部)。
    // 倍率与 new-api 自家分组下拉的「Nx 倍率」徽章同源(GroupRatio,60s 缓存);
    // new-api 不可达时降级为 null(下拉不显示徽章,不阻塞建 key)。
    // 两者的 fetch 已并进上面的 Promise.all,这里只做纯内存的收窄/拼装。
    const tierGroups = restrictGroupsForUser(tierGroupsRaw, user.allowed_tier_keys);
    const tiers = tierGroups.map((g) => ({
        key: g.key,
        display_name: g.display_name,
        description: g.description,
        is_default: g.is_default,
        newapi_group: g.newapi_group,
        ratio: overrideByTier.get(g.key) ?? ratios[g.newapi_group] ?? null,
    }));

    return (
        <section className="space-y-6">
            <div>
                <p className="m-0 mb-1 text-xs font-semibold text-portal-gold">ACCESS</p>
                <h1 className="m-0 text-[28px] font-semibold leading-tight text-portal-ink">API Keys</h1>
                <p className="m-0 mt-2 max-w-3xl text-sm leading-relaxed text-portal-muted">
                    创建并管理用于调用 LLmRoute 的访问密钥。密钥撤销后立即失效。
                </p>
            </div>
            <KeysList initialRows={rows} tiers={tiers} />
            {/* W7 D4 PR-R Item C — unified 调用示例 panel below the
             *  keys table replaces the per-row KeyHowtoPanel that PR-G
             *  used to stitch into each row. Static `YOUR_API_KEY`
             *  placeholder + curl / Python / Node tabs. */}
            <KeysSnippetsPanel />
        </section>
    );
}
