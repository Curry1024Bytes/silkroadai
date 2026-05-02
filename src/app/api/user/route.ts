import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { getUser, quotaToCny, quotaToUsd } from '@/lib/newapi/client';
import { resolveLocale } from '@/lib/locale';

/**
 * GET /api/user
 *
 * Returns the current portal user + their new-api tokens (cached) + a live
 * quota snapshot pulled from new-api (`getUser` admin call). Live pull is
 * cheap (one HTTP) and gives the customer the truth on every page load
 * without us having to maintain a sync cron.
 */
export async function GET(request: NextRequest) {
    const locale = resolveLocale(request.nextUrl.searchParams.get('lang'));

    const user = await getCurrentUser(request);
    if (!user) {
        return NextResponse.json(
            { error: locale === 'en' ? 'Unauthorized' : '未授权' },
            { status: 401 },
        );
    }

    const tokens = await prisma.newApiToken.findMany({
        where: { user_id: user.id, status: 'active' },
        orderBy: { created_at: 'asc' },
    });

    // Pull live quota for the user from new-api. If new-api is briefly
    // down, fall back to the cached values on the User row.
    let liveQuota: { remain: bigint; used: bigint } | null = null;
    if (user.newapi_user_id !== null && user.newapi_user_id !== undefined) {
        try {
            const u = await getUser(user.newapi_user_id);
            liveQuota = {
                remain: BigInt(u.quota),
                used: BigInt(u.used_quota),
            };
        } catch (err) {
            console.warn(
                `[user/route] new-api getUser failed for ${user.newapi_user_id}, falling back to cache:`,
                err,
            );
        }
    }

    const remainQuota: bigint =
        liveQuota?.remain ?? user.newapi_quota_cache ?? BigInt(0);
    const usedQuota: bigint =
        liveQuota?.used ?? user.newapi_used_quota_cache ?? BigInt(0);

    const tokensOut = tokens.map((t) => ({
        id: t.id,
        key_alias: t.key_alias,
        newapi_token_id: t.newapi_token_id,
        // Token rows in DB hold the full sk-... value — useful for the customer
        // to copy on first display. We don't mask here; client UI should redact.
        newapi_token_value: t.newapi_token_value,
        cached_remain_quota: t.cached_remain_quota?.toString() ?? null,
        cached_used_quota: t.cached_used_quota?.toString() ?? null,
        last_synced_at: t.last_synced_at,
        model_limits_enabled: t.model_limits_enabled,
        model_limits: t.model_limits,
        status: t.status,
        created_at: t.created_at,
    }));

    return NextResponse.json({
        portal_user: {
            id: user.id,
            email: user.email,
            nickname: user.nickname,
            avatar_url: user.avatar_url,
            email_verified: user.email_verified,
            locale: user.locale,
            status: user.status,
            newapi_user_id: user.newapi_user_id,
            newapi_username: user.newapi_username,
            created_at: user.created_at,
        },
        tokens: tokensOut,
        // BigInt is not JSON-serializable by default; expose as string + decimals.
        quota: {
            remain_raw: remainQuota.toString(),
            used_raw: usedQuota.toString(),
            remain_usd: quotaToUsd(Number(remainQuota)),
            remain_cny: quotaToCny(Number(remainQuota)),
            live: liveQuota !== null,
        },
    });
}
