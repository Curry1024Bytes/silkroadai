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
import { KeysList, type KeyRow } from './keys-list';

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
            created_at: true,
        },
    });

    const rows: KeyRow[] = tokens.map((t) => ({
        id: t.id,
        key_alias: t.key_alias,
        masked_key: maskKey(t.newapi_token_value),
        created_at: t.created_at.toISOString(),
    }));

    return (
        <section>
            <h1 style={{ margin: '0 0 8px', fontSize: 22, color: '#0a1535' }}>API Keys</h1>
            <p style={{ margin: '0 0 24px', fontSize: 13, color: '#5a6478' }}>
                管理用于调用 Silk Road AI 的访问密钥。撤销后立即失效。
            </p>
            <KeysList initialRows={rows} />
        </section>
    );
}
