/**
 * /api/portal/keys
 *   GET  — list current user's active keys (no full sk- in payload)
 *   POST — create a new key (returns full sk- ONCE, in this response only)
 *
 * Both endpoints are session-cookie auth (W3 D3+). Layout already gates the
 * /keys UI but a direct API call without a session must still 401 cleanly,
 * so the route does its own getCurrentUser check.
 *
 * Token cap: removed 2026-07-25 (was MAX_TOKENS_PER_USER=10 since W6 D4,
 * 5 before that). Customers may create as many keys as they need; budget
 * is still gated solely by user.quota (gotcha #12), so key count adds no
 * spend exposure.
 *
 * Token defaults align with W3 D6 provisionNewCustomer:
 *   - unlimited_quota=true (gotcha #12 — predicates on user.quota, not per-token)
 *   - expired_time=-1 (never expires unless customer explicitly revokes)
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import {
    createTokenForCustomer,
    listTokensForCustomer,
    getTokenKey,
    deleteToken as newapiDeleteToken,
} from '@/lib/newapi/client';
import { withCustomerKeyMutation, customerKeyMutationTimeout } from '@/lib/newapi/customer-key-mutation';
import { PricingPublishError } from '@/lib/admin/pricing-publish-lock';
import { formatTokenForDisplay } from '@/lib/newapi/token-format';
import { PORTAL_INTERNAL_TOKEN_NAME } from '@/lib/newapi/system-token';
import { listEnabledChannelGroups, restrictGroupsForUser } from '@/lib/channel-group';
import { ChannelGroupTopologyError, topologyErrorPayload } from '@/lib/channel-group-topology';

export const runtime = 'nodejs';

const CreateKeySchema = z.object({
    // PR-T1 Phase 0e: reserve `portal-internal` for the server-managed
    // system token. Rejecting it here prevents a customer from creating
    // a NewApiToken row that collides with `listTokensForCustomer`
    // disambiguation in `getOrCreateSystemToken`.
    alias: z
        .string()
        .trim()
        .min(1, 'alias must not be empty')
        .max(50, 'alias must be ≤ 50 chars')
        // Reserve the whole `portal-internal*` prefix — covers the primary
        // system token AND the per-group tokens (`portal-internal-official`,
        // etc.) so a customer can't mint a key that collides with the routing.
        .refine((s) => !s.startsWith(PORTAL_INTERNAL_TOKEN_NAME), {
            message: `alias starting with "${PORTAL_INTERNAL_TOKEN_NAME}" is reserved`,
        }),
    // P3:档次 = 当前租户启用的 ChannelGroup.key。可选;不传走唯一默认档。
    // 值域不写死 enum —— 数据驱动 + 可白标扩展,handler 内
    // 按本 tenant 的 enabled 档次校验。
    tier: z.string().trim().min(1).max(50).optional(),
});

export async function GET(req: NextRequest) {
    const user = await getCurrentUser(req);
    if (!user) {
        return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }

    const tokens = await prisma.newApiToken.findMany({
        where: {
            user_id: user.id,
            status: 'active',
            // PR-T1 Phase 0e: defensive — system token is stored on
            // `User.newapi_system_token_value`, not in this table, so
            // this filter is a no-op today. Future-proofs against any
            // path that mistakenly mirrors `portal-internal` to the
            // NewApiToken table; customer must never see it in /keys.
            key_alias: { not: { startsWith: PORTAL_INTERNAL_TOKEN_NAME } },
        },
        orderBy: { created_at: 'asc' },
        select: {
            id: true,
            key_alias: true,
            newapi_token_value: true,
            tier: true,
            created_at: true,
            // W6 D4: per-key usage cache. Cheap to project; clients (the
            // /keys page server component or future API consumers) can
            // skip a separate fetch for the dashboard summary.
            cached_used_quota: true,
            cached_used_at: true,
        },
    });

    return NextResponse.json({
        tokens: tokens.map((t) => ({
            id: t.id,
            key_alias: t.key_alias,
            tier: t.tier,
            // W7 D4 PR-H Tier A: prefix the stored 48-char value before
            // masking so the rendered display reads `sk-XXXX****YYYY`.
            masked_key: maskKey(formatTokenForDisplay(t.newapi_token_value)),
            created_at: t.created_at.toISOString(),
            // BigInt → string for JSON serialization (Number can lose
            // precision for very-high quota counts).
            cached_used_quota: t.cached_used_quota.toString(),
            cached_used_at: t.cached_used_at?.toISOString() ?? null,
        })),
    });
}

export async function POST(req: NextRequest) {
    const user = await getCurrentUser(req);
    if (!user) {
        return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }
    if (user.newapi_user_id == null || !user.newapi_access_token) {
        // Should never happen for a register/OAuth-provisioned user; flag as
        // upstream issue if it does (see W2 D6 provisionNewCustomer).
        console.error(`[portal/keys POST] user ${user.id} has no newapi_user_id/access_token; cannot create token`);
        return NextResponse.json({ error: 'account_not_provisioned' }, { status: 500 });
    }

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = CreateKeySchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const { alias, tier: requestedTier } = parsed.data;

    // P3:resolve 档次 → new-api group(portal key 与 new-api group 解耦)。
    // 不传档次 → 唯一默认档。非法档次 → 400。任何拓扑缺失都直接 503，
    // 不会退回 pool/default 等历史字面量。
    // per-customer 白名单收窄(allowed_tier_keys 非空 → 只允许这些档)。与 /keys
    // 页用同一个 restrictGroupsForUser,展示与校验一致。
    let enabled: Awaited<ReturnType<typeof listEnabledChannelGroups>>;
    try {
        enabled = await listEnabledChannelGroups(user.tenant_id);
    } catch (error) {
        if (error instanceof ChannelGroupTopologyError) {
            console.error('[portal/keys POST] invalid channel-group topology', error);
            return NextResponse.json(topologyErrorPayload(error), { status: 503 });
        }
        throw error;
    }
    const groups = restrictGroupsForUser(enabled, user.allowed_tier_keys);
    const restricted = user.allowed_tier_keys.length > 0;
    if (groups.length === 0) {
        // 无启用档次时绝不回退 new-api default/pool;该 Key 会创建成功却在调用时 403。
        if (!restricted) {
            console.error(`[portal/keys POST] tenant ${user.tenant_id ?? 'platform'} has no enabled channel groups`);
            return NextResponse.json({ error: 'tier_unavailable' }, { status: 503 });
        }
        return NextResponse.json({ error: 'invalid_tier', allowed: groups.map((g) => g.key) }, { status: 400 });
    }
    const chosen = requestedTier
        ? groups.find((g) => g.key === requestedTier)
        : (groups.find((g) => g.is_default) ?? (restricted ? groups[0] : undefined));
    if (!chosen) {
        if (!requestedTier) {
            console.error(`[portal/keys POST] tenant ${user.tenant_id ?? 'platform'} has no enabled default tier`);
            return NextResponse.json({ error: 'default_tier_unavailable' }, { status: 503 });
        }
        return NextResponse.json({ error: 'invalid_tier', allowed: groups.map((g) => g.key) }, { status: 400 });
    }
    const tier = chosen.key;
    const newapiGroup = chosen.newapi_group;

    const customerAuth = {
        accessToken: user.newapi_access_token,
        userId: user.newapi_user_id,
    };

    let issuedTokenId: number | undefined;
    let persistenceFailed = false;
    let createFailed = false;
    try {
        return await withCustomerKeyMutation({ tenantId: user.tenant_id, tierKey: tier, newapiGroup }, async (tx) => {
            // 3-step new-api flow (mirrors provisionNewCustomer):
            //   1. createTokenForCustomer(name=alias)  — returns void
            //   2. listTokensForCustomer → find by name → get id
            //   3. getTokenKey(id) → real sk-...
            let newapiTokenId: number;
            let realKey: string;
            try {
                await createTokenForCustomer(customerAuth, {
                    name: alias,
                    unlimited_quota: true, // gotcha #12 — quota lives on user, not token
                    expired_time: -1,
                    group: newapiGroup, // P3: 当前动态档次显式下发的 new-api group
                });

                // Find newly-created by name. Same-alias collisions are possible but
                // rare; if multiple match we pick the most recent (id desc).
                const list = await listTokensForCustomer(customerAuth, 1, 50);
                const found = list.items.filter((t) => t.name === alias).sort((a, b) => b.id - a.id)[0];
                if (!found) {
                    throw new Error(`created token name=${alias} not found in subsequent list`);
                }
                newapiTokenId = found.id;
                issuedTokenId = found.id;
                realKey = await getTokenKey(customerAuth, newapiTokenId);
            } catch (newapiErr) {
                // Unwind the SQL transaction before compensation. Never search
                // by alias for cleanup: an older Key in another group may share it.
                createFailed = true;
                throw newapiErr;
            }

            // Persist Prisma row. If Prisma write fails, the new-api token is orphan
            // — try to roll it back like the W3 D6 register pattern.
            let row;
            try {
                await customerKeyMutationTimeout();
                row = await tx.newApiToken.create({
                    data: {
                        user_id: user.id,
                        newapi_token_id: newapiTokenId,
                        newapi_token_value: realKey,
                        key_alias: alias,
                        tier, // P3: portal 档次 key(new-api group 经 newapiGroup 解耦下发)
                        status: 'active',
                    },
                    select: { id: true, key_alias: true, tier: true, created_at: true },
                });
            } catch (dbErr) {
                // Release the failed SQL transaction before remote compensation.
                persistenceFailed = true;
                throw dbErr;
            }

            return NextResponse.json({
                id: row.id,
                key_alias: row.key_alias,
                tier: row.tier,
                // ONE-TIME: full sk- only in the create response. Subsequent reveals
                // go through GET /api/portal/keys/[id]/key (also auth + ownership
                // checked).
                // W7 D4 PR-H Tier A: prepend `sk-` so the customer's first paste
                // (this response is auto-revealed in the UI) lands a working
                // Authorization value. DB stores the raw 48-char id (matches
                // new-api's canonical representation); prefix is purely a
                // display/wire concern.
                key: formatTokenForDisplay(realKey),
                created_at: row.created_at.toISOString(),
            });
        });
    } catch (error) {
        if (issuedTokenId !== undefined) {
            await newapiDeleteToken(customerAuth, issuedTokenId).catch((cleanupError) =>
                console.error('[portal/keys POST] remote cleanup failed after transaction rollback', cleanupError),
            );
        }
        if (createFailed) {
            console.error(`[portal/keys POST] new-api create flow failed for user ${user.id}:`, error);
            return NextResponse.json({ error: 'newapi_create_failed' }, { status: 502 });
        }
        if (persistenceFailed) {
            console.error('[portal/keys POST] key persistence failed', error);
            return NextResponse.json({ error: 'persistence_failed' }, { status: 500 });
        }
        if (error instanceof PricingPublishError) {
            return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
        }
        console.error('[portal/keys POST] coordinated key creation failed', error);
        return NextResponse.json({ error: 'key_creation_unavailable' }, { status: 503 });
    }
}

/** Server-side mask helper, identical algorithm to the page-level one. */
function maskKey(value: string): string {
    if (value.length <= 12) return '*'.repeat(Math.max(8, value.length));
    return `${value.slice(0, 7)}****${value.slice(-4)}`;
}
