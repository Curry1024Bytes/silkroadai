/**
 * Portal-managed "system" token (PR-T1 Phase 0).
 *
 * Background — why a separate token, not the customer's:
 *   /v1/* model proxy on new-api accepts only `Bearer sk-…` from the
 *   customer's token table; the admin-token act-as pattern (gotcha #10)
 *   is for /api/* admin endpoints. Portal-managed services (image gen
 *   today; future chat UI / self-hosted models / image-to-image) need
 *   to call /v1/* on the customer's behalf. Re-using one of the
 *   customer's NewApiToken rows is fragile — they can revoke it.
 *
 * Solution: at first portal-managed service hit (or eagerly at register
 * / OAuth callback), provision an extra new-api token named
 * `portal-internal` and pin its sk- value to `User.newapi_system_token_value`.
 * Customer never sees it (the /keys page reads from the `NewApiToken`
 * Prisma table; the system token doesn't get a row there). Portal
 * forwards `Bearer sk-{value}` to /v1/* and quota deducts from the
 * customer's account just like a normal call.
 *
 * Lazy provision + race safety:
 *   - Read `User.newapi_system_token_value`. If non-null, return.
 *   - Otherwise create via the customer's existing access_token (3-step
 *     flow same as `provisionNewCustomer`: create → list → getKey).
 *   - Race-safe write-back via CAS: `updateMany WHERE token_value IS
 *     NULL`. Loser detects via `count === 0`, re-fetches winner's value,
 *     deletes its own orphan token in new-api.
 *
 * Server-only — no client bundle should reach for this. Adds the
 * standard `import 'server-only'` guard.
 */
import 'server-only';
import { prisma } from '@/lib/db';
import { createTokenForCustomer, deleteToken, getTokenKey, listTokensForCustomer } from './client';
import { formatTokenForDisplay } from './token-format';

/** Reserved token name on new-api side. Must match the filter applied
 *  in /api/portal/keys list/reveal/delete to avoid customer interaction
 *  with the system token. */
export const PORTAL_INTERNAL_TOKEN_NAME = 'portal-internal';

/** Error code surfaced when the user has no new-api linkage yet. The
 *  caller (e.g. POST /api/portal/image/generate) should map to a 4xx
 *  with a friendly message rather than 500. */
export class PortalSystemTokenError extends Error {
    constructor(
        message: string,
        public code:
            | 'user_not_found'
            | 'user_not_provisioned'
            | 'newapi_create_failed'
            | 'newapi_lookup_failed'
            | 'persistence_failed',
    ) {
        super(message);
        this.name = 'PortalSystemTokenError';
    }
}

/**
 * Returns the user's portal system token in **wire format** (with
 * `sk-` prefix), creating one on the first call.
 *
 * Idempotent + race-safe — concurrent callers may both create a new-api
 * token, but only one's value gets persisted; the loser cleans up its
 * orphan token. Steady-state cost is a single Prisma read per call
 * once provisioning is done.
 *
 * Throws `PortalSystemTokenError` for typed failure modes; un-typed
 * Errors bubble for unexpected upstream issues (caller should log +
 * 500). Call sites that can degrade gracefully (e.g. eager-provision at
 * register) should `.catch()` and fall back to lazy.
 */
export async function getOrCreateSystemToken(userId: string): Promise<string> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            status: true,
            newapi_user_id: true,
            newapi_access_token: true,
            newapi_system_token_id: true,
            newapi_system_token_value: true,
        },
    });

    if (!user) {
        throw new PortalSystemTokenError(`user ${userId} not found`, 'user_not_found');
    }

    // Fast path: token already provisioned.
    if (user.newapi_system_token_value) {
        return formatTokenForDisplay(user.newapi_system_token_value);
    }

    if (user.newapi_user_id == null || !user.newapi_access_token) {
        throw new PortalSystemTokenError(
            `user ${userId} has no new-api linkage; cannot provision system token`,
            'user_not_provisioned',
        );
    }

    const customerAuth = {
        accessToken: user.newapi_access_token,
        userId: user.newapi_user_id,
    };

    // 3-step flow mirrors provisionNewCustomer / portal/keys POST:
    //   1. create (no return)
    //   2. list → find by name → get id
    //   3. getKey(id) → real sk-…
    let newapiTokenId: number;
    let realKey: string;

    try {
        await createTokenForCustomer(customerAuth, {
            name: PORTAL_INTERNAL_TOKEN_NAME,
            unlimited_quota: true, // gotcha #12 — quota lives on user, not token
            expired_time: -1,
        });
    } catch (err) {
        throw new PortalSystemTokenError(
            `new-api createTokenForCustomer failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
            'newapi_create_failed',
        );
    }

    try {
        // pageSize 50 covers customer's max 10 manual keys + the new
        // portal-internal token; if a customer ever crosses 50 we'd need
        // pagination, but max-tokens-per-user is 10 (W6 D4) so 50 is safe.
        const list = await listTokensForCustomer(customerAuth, 1, 50);
        const matches = list.items.filter((t) => t.name === PORTAL_INTERNAL_TOKEN_NAME).sort((a, b) => b.id - a.id);
        if (matches.length === 0) {
            throw new Error(`created token name=${PORTAL_INTERNAL_TOKEN_NAME} not found in subsequent list`);
        }
        // If a previous half-failed attempt left an extra portal-internal
        // token, we picked the most-recent (id desc). Older orphan rows
        // remain on new-api side; not worth a cleanup here (rare; would
        // need extra delete calls + risk timeouts).
        newapiTokenId = matches[0].id;
        realKey = await getTokenKey(customerAuth, newapiTokenId);
    } catch (err) {
        throw new PortalSystemTokenError(
            `new-api list/getKey failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
            'newapi_lookup_failed',
        );
    }

    // Race-safe persist: only the first concurrent caller wins; losers
    // re-fetch and clean their orphan token.
    const claim = await prisma.user.updateMany({
        where: {
            id: userId,
            newapi_system_token_value: null,
        },
        data: {
            newapi_system_token_id: String(newapiTokenId),
            newapi_system_token_value: realKey,
        },
    });

    if (claim.count === 0) {
        // Lost the race — another concurrent caller already persisted.
        // Delete our orphan new-api token (best-effort) and return the
        // winner's value.
        await deleteToken(customerAuth, newapiTokenId).catch((err) =>
            console.warn(`[system-token] orphan cleanup for token ${newapiTokenId} failed:`, err),
        );

        const winner = await prisma.user.findUnique({
            where: { id: userId },
            select: { newapi_system_token_value: true },
        });
        if (winner?.newapi_system_token_value) {
            return formatTokenForDisplay(winner.newapi_system_token_value);
        }
        // Defensive: race-lost claim but null on re-read shouldn't happen
        // unless someone wiped the column between updateMany and findUnique.
        throw new PortalSystemTokenError(
            `race-lost claim but value still null after re-fetch (user ${userId})`,
            'persistence_failed',
        );
    }

    return formatTokenForDisplay(realKey);
}
