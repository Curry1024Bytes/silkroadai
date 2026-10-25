/**
 * PATCH  /api/portal/keys/[id] — rename a key (alias only).
 * DELETE /api/portal/keys/[id] — revoke a key.
 *
 * PATCH steps:
 *   1. Auth (cookie session) + zod `{ alias }` (same rule as create: 1-50
 *      chars, `portal-internal*` prefix reserved)
 *   2. Load token row, verify user_id matches session (IDOR → 401)
 *   3. Revoked token → 410 (nothing upstream to rename)
 *   4. new-api renameToken (GET + full PUT, see client.ts) FIRST — if it
 *      throws we leave Prisma untouched so list + new-api stay in sync
 *   5. Prisma `key_alias` update
 *
 * DELETE steps:
 *   1. Auth (cookie session)
 *   2. Load token row, verify user_id matches session (defense against IDOR)
 *   3. Call new-api deleteToken(customerAuth, newapi_token_id) — true revoke
 *      on the upstream side (sk- becomes invalid immediately)
 *   4. Set Prisma `status='disabled'` (NOT hard delete — Order/RechargeLog
 *      have FK refs that default to RESTRICT; soft-delete preserves audit
 *      trail and avoids cascade surprises)
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import {
    deleteToken as newapiDeleteToken,
    renameToken as newapiRenameToken,
    updateTokenForCustomer as newapiUpdateToken,
    type TokenBudgetPatch,
} from '@/lib/newapi/client';
import { cnyToQuota } from '@/lib/newapi/quota-units';
import { isoToExpiredTime } from '@/lib/newapi/token-meta';
import { ExpiresAtSchema, QuotaCnySchema } from '@/lib/keys/request-schema';
import { keyQuotaLimitsEnabled } from '@/lib/keys/quota-policy';
import { KEY_INACTIVE_MESSAGE } from '@/lib/keys/quota-expiry';
import { listEnabledChannelGroups, restrictGroupsForUser } from '@/lib/channel-group';
import { withCustomerKeyMutation } from '@/lib/newapi/customer-key-mutation';
import { PricingPublishError } from '@/lib/admin/pricing-publish-lock';
import { PORTAL_INTERNAL_TOKEN_NAME } from '@/lib/newapi/system-token';

export const runtime = 'nodejs';

/** Same alias rule as POST /api/portal/keys (CreateKeySchema.alias). Kept
 *  in sync by hand — the two routes are separate modules and the create
 *  schema also carries `tier`, which rename must not accept. */
const AliasSchema = z
    .string()
    .trim()
    .min(1, 'alias must not be empty')
    .max(50, 'alias must be ≤ 50 chars')
    .refine((s) => !s.startsWith(PORTAL_INTERNAL_TOKEN_NAME), {
        message: `alias starting with "${PORTAL_INTERNAL_TOKEN_NAME}" is reserved`,
    });

/**
 * PATCH body:改名 / 额度上限 / 到期时间,任意组合,至少一项(2026-10-22 起)。
 *   alias:      改名(行为与原 rename 完全一致:同名 no-op、new-api 先于 Prisma)
 *   quotaCny:   number → 设额度上限(¥,绝对值,不是增量);null → 取消额度(无限)
 *   expiresAt:  ISO → 设到期;null → 永不过期
 */
const UpdateKeySchema = z
    .object({
        alias: AliasSchema.optional(),
        quotaCny: QuotaCnySchema.nullable().optional(),
        expiresAt: ExpiresAtSchema.nullable().optional(),
    })
    .refine((o) => o.alias !== undefined || o.quotaCny !== undefined || o.expiresAt !== undefined, {
        message: 'nothing to update',
    });

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(req);
    if (!user) {
        return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }
    if (user.newapi_user_id == null || !user.newapi_access_token) {
        console.error(`[portal/keys PATCH] user ${user.id} has no newapi auth; cannot update`);
        return NextResponse.json({ error: 'account_not_provisioned' }, { status: 500 });
    }

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
    }
    const parsed = UpdateKeySchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'validation_error', details: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const { alias, quotaCny, expiresAt } = parsed.data;
    if (quotaCny != null && !keyQuotaLimitsEnabled()) {
        return NextResponse.json({ error: 'key_quota_limits_disabled' }, { status: 403 });
    }
    const budgetRequested = quotaCny !== undefined || expiresAt !== undefined;

    const { id } = await params;
    const token = await prisma.newApiToken.findUnique({
        where: { id },
        select: {
            id: true,
            user_id: true,
            newapi_token_id: true,
            status: true,
            key_alias: true,
            tier: true,
        },
    });
    if (!token) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    // IDOR defense: 401 (not 403) so an attacker can't enumerate other users' ids.
    if (token.user_id !== user.id) {
        return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }
    if (token.status !== 'active') {
        return NextResponse.json({ error: 'token_revoked' }, { status: 410 });
    }

    const aliasChanged = alias !== undefined && token.key_alias !== alias;
    if (!budgetRequested && !aliasChanged) {
        // alias-only no-op:不碰 new-api 也不碰 Prisma
        return NextResponse.json({ ok: true, key_alias: token.key_alias });
    }

    const customerAuth = {
        accessToken: user.newapi_access_token,
        userId: user.newapi_user_id,
    };

    let requiresReactivation = false;
    // new-api first (mirrors DELETE ordering): a failure here leaves the
    // portal row untouched so the customer can retry, instead of a
    // portal/new-api split.
    try {
        if (!budgetRequested) {
            await newapiRenameToken(customerAuth, token.newapi_token_id, alias as string);
        } else {
            // 额度 / 到期(可顺带改名)走一次全量 GET→PUT(new-api PUT 是全量覆盖)。
            // 取消额度只翻 unlimited_quota,remain_quota 保持原值;设额度写绝对值。
            const patch: TokenBudgetPatch = {};
            if (aliasChanged) patch.name = alias as string;
            if (quotaCny !== undefined) {
                patch.unlimited_quota = quotaCny === null;
                if (quotaCny !== null) patch.remain_quota = cnyToQuota(quotaCny);
            }
            if (expiresAt !== undefined) patch.expired_time = isoToExpiredTime(expiresAt);
            const groups = restrictGroupsForUser(
                await listEnabledChannelGroups(user.tenant_id),
                user.allowed_tier_keys ?? [],
            );
            const group = groups.find((candidate) => candidate.key === token.tier);
            if (!group) return NextResponse.json({ error: 'tier_unavailable' }, { status: 403 });
            await withCustomerKeyMutation(
                { tenantId: user.tenant_id, tierKey: group.key, newapiGroup: group.newapi_group },
                async (tx) => {
                    const result = await newapiUpdateToken(customerAuth, token.newapi_token_id, patch);
                    requiresReactivation = result?.requiresReactivation === true;
                    if (aliasChanged)
                        await tx.newApiToken.update({ where: { id }, data: { key_alias: alias as string } });
                },
            );
        }
    } catch (newapiErr) {
        if (newapiErr instanceof PricingPublishError)
            return NextResponse.json(
                { error: newapiErr.code, message: newapiErr.message },
                { status: newapiErr.status },
            );
        console.error(`[portal/keys PATCH] new-api update failed for portal token ${id}:`, newapiErr);
        return NextResponse.json({ error: 'newapi_update_failed' }, { status: 502 });
    }

    if (aliasChanged && !budgetRequested) {
        await prisma.newApiToken.update({
            where: { id },
            data: { key_alias: alias as string },
        });
    }

    return NextResponse.json({
        ok: true,
        ...(requiresReactivation
            ? { settings_saved: true, requires_reactivation: true, message: KEY_INACTIVE_MESSAGE }
            : {}),
        key_alias: aliasChanged ? (alias as string) : token.key_alias,
        ...(quotaCny !== undefined ? { quota_unlimited: quotaCny === null, remainCny: quotaCny } : {}),
        ...(expiresAt !== undefined ? { expires_at: expiresAt ? new Date(expiresAt).toISOString() : null } : {}),
    });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(req);
    if (!user) {
        return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }
    if (user.newapi_user_id == null || !user.newapi_access_token) {
        console.error(`[portal/keys DELETE] user ${user.id} has no newapi auth; cannot revoke`);
        return NextResponse.json({ error: 'account_not_provisioned' }, { status: 500 });
    }

    const { id } = await params;
    const token = await prisma.newApiToken.findUnique({
        where: { id },
        select: {
            id: true,
            user_id: true,
            newapi_token_id: true,
            status: true,
        },
    });
    if (!token) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    // IDOR defense: a user cannot revoke another user's token even by
    // guessing the UUID. Returns 401 (not 403/404) to avoid leaking
    // existence — same shape as the unauth case.
    if (token.user_id !== user.id) {
        return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }
    if (token.status !== 'active') {
        // Already revoked — idempotent return so a double-click doesn't
        // confuse the UI.
        return NextResponse.json({ ok: true, already: true });
    }

    const customerAuth = {
        accessToken: user.newapi_access_token,
        userId: user.newapi_user_id,
    };

    // new-api side first — if this throws, we leave Prisma untouched so the
    // user still sees the key (and can retry). If we flipped Prisma first
    // and new-api delete failed, the customer would see the key gone but
    // it'd still work upstream — confusing.
    try {
        await newapiDeleteToken(customerAuth, token.newapi_token_id);
    } catch (newapiErr) {
        console.error(`[portal/keys DELETE] new-api deleteToken failed for portal token ${id}:`, newapiErr);
        return NextResponse.json({ error: 'newapi_delete_failed' }, { status: 502 });
    }

    await prisma.newApiToken.update({
        where: { id },
        data: { status: 'disabled' },
    });

    return NextResponse.json({ ok: true });
}
