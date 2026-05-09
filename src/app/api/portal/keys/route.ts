/**
 * /api/portal/keys
 *   GET  — list current user's active keys (no full sk- in payload)
 *   POST — create a new key (returns full sk- ONCE, in this response only)
 *
 * Both endpoints are session-cookie auth (W3 D3+). Layout already gates the
 * /keys UI but a direct API call without a session must still 401 cleanly,
 * so the route does its own getCurrentUser check.
 *
 * Token CAP: MAX_TOKENS_PER_USER = 10 (W6 D4 — bumped from 5 in W4-2 D5
 * after multi-environment customers asked for more headroom). The UI
 * pre-disables the create button but the server enforces independently
 * (defense in depth). Future tier-based dynamic limit lives on a User
 * column, not this constant.
 *
 * Token defaults align with W3 D6 provisionNewCustomer:
 *   - unlimited_quota=true (gotcha #12 — predicates on user.quota, not per-token)
 *   - expired_time=-1 (never expires unless customer explicitly revokes)
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import {
    createTokenForCustomer,
    listTokensForCustomer,
    getTokenKey,
    deleteToken as newapiDeleteToken,
} from '@/lib/newapi/client';
import { formatTokenForDisplay } from '@/lib/newapi/token-format';

export const runtime = 'nodejs';

export const MAX_TOKENS_PER_USER = 10;

const CreateKeySchema = z.object({
    alias: z.string().trim().min(1, 'alias must not be empty').max(50, 'alias must be ≤ 50 chars'),
});

export async function GET(req: NextRequest) {
    const user = await getCurrentUser(req);
    if (!user) {
        return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }

    const tokens = await prisma.newApiToken.findMany({
        where: { user_id: user.id, status: 'active' },
        orderBy: { created_at: 'asc' },
        select: {
            id: true,
            key_alias: true,
            newapi_token_value: true,
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
    const { alias } = parsed.data;

    // Server-side cap (UI also enforces, but defense in depth)
    const activeCount = await prisma.newApiToken.count({
        where: { user_id: user.id, status: 'active' },
    });
    if (activeCount >= MAX_TOKENS_PER_USER) {
        return NextResponse.json({ error: 'token_limit_reached', max: MAX_TOKENS_PER_USER }, { status: 400 });
    }

    const customerAuth = {
        accessToken: user.newapi_access_token,
        userId: user.newapi_user_id,
    };

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
        });

        // Find newly-created by name. Same-alias collisions are possible but
        // rare; if multiple match we pick the most recent (id desc).
        const list = await listTokensForCustomer(customerAuth, 1, 50);
        const found = list.items.filter((t) => t.name === alias).sort((a, b) => b.id - a.id)[0];
        if (!found) {
            throw new Error(`created token name=${alias} not found in subsequent list`);
        }
        newapiTokenId = found.id;
        realKey = await getTokenKey(customerAuth, newapiTokenId);
    } catch (newapiErr) {
        console.error(`[portal/keys POST] new-api create flow failed for user ${user.id}:`, newapiErr);
        // If the token was created but a later step (list/getKey) failed,
        // we'd leave an orphan. Best-effort cleanup: try to delete it by
        // looking it up by name. Failure here is logged but doesn't block
        // surfacing the error to the user.
        try {
            const list = await listTokensForCustomer(customerAuth, 1, 50);
            const orphan = list.items.find((t) => t.name === alias);
            if (orphan) {
                await newapiDeleteToken(customerAuth, orphan.id);
                console.warn(`[portal/keys POST] cleaned orphan new-api token id=${orphan.id} name=${alias}`);
            }
        } catch (cleanupErr) {
            console.error(`[portal/keys POST] orphan cleanup also failed for user ${user.id}:`, cleanupErr);
        }
        return NextResponse.json({ error: 'newapi_create_failed' }, { status: 502 });
    }

    // Persist Prisma row. If Prisma write fails, the new-api token is orphan
    // — try to roll it back like the W3 D6 register pattern.
    let row;
    try {
        row = await prisma.newApiToken.create({
            data: {
                user_id: user.id,
                newapi_token_id: newapiTokenId,
                newapi_token_value: realKey,
                key_alias: alias,
                status: 'active',
            },
            select: { id: true, key_alias: true, created_at: true },
        });
    } catch (dbErr) {
        // Unique-violation on newapi_token_id can happen if a previous
        // attempt half-succeeded (token in DB but earlier response failed).
        // For W4-2 D5 scope we treat any DB error as a hard fail.
        if (dbErr instanceof Prisma.PrismaClientKnownRequestError && dbErr.code === 'P2002') {
            console.warn(`[portal/keys POST] duplicate token row for user ${user.id}, sk truncated`);
        } else {
            console.error(`[portal/keys POST] prisma create failed for user ${user.id}:`, dbErr);
        }
        await newapiDeleteToken(customerAuth, newapiTokenId).catch((err) =>
            console.error(`[portal/keys POST] new-api rollback failed for token ${newapiTokenId}:`, err),
        );
        return NextResponse.json({ error: 'persistence_failed' }, { status: 500 });
    }

    return NextResponse.json({
        id: row.id,
        key_alias: row.key_alias,
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
}

/** Server-side mask helper, identical algorithm to the page-level one. */
function maskKey(value: string): string {
    if (value.length <= 12) return '*'.repeat(Math.max(8, value.length));
    return `${value.slice(0, 7)}****${value.slice(-4)}`;
}
