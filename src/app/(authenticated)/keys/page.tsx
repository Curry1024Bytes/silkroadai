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
import { formatTokenForDisplay } from '@/lib/newapi/token-format';
import { KeysList, type KeyRow } from './keys-list';
import { KeysSnippetsPanel } from './keys-snippets-panel';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'API Keys — Silk Road AI' };

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
            created_at: true,
        },
    });

    // W6 D4: parallel per-token usage fetch. Each call goes through the
    // 60s row cache so this is at most one batched new-api round-trip per
    // tab — and zero when the cache is fresh. Failures per-token are
    // contained to that row's snapshot (logged + null usage shown).
    const usageSnaps = await Promise.all(
        tokens.map(async (t) => {
            if (user.newapi_user_id == null) return null;
            try {
                return await getTokenUsageWithCache({
                    prismaTokenId: t.id,
                    newapiUserId: user.newapi_user_id,
                    newapiTokenId: t.newapi_token_id,
                });
            } catch (err) {
                console.warn(`[keys] usage fetch failed for token ${t.id}:`, err);
                return null;
            }
        }),
    );

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
            last_used_at: snap?.last_used_at ? snap.last_used_at.toISOString() : null,
        };
    });

    return (
        <section>
            <h1 className="m-0 mb-2 text-2xl font-semibold text-navy">API Keys</h1>
            <p className="m-0 mb-6 text-sm text-muted-ink">管理用于调用 Silk Road AI 的访问密钥。撤销后立即失效。</p>
            <KeysList initialRows={rows} />
            {/* W7 D4 PR-R Item C — unified 调用示例 panel below the
             *  keys table replaces the per-row KeyHowtoPanel that PR-G
             *  used to stitch into each row. Static `YOUR_API_KEY`
             *  placeholder + curl / Python / Node tabs. */}
            <KeysSnippetsPanel />
        </section>
    );
}
