/**
 * GET /api/portal/keys/[id]/key — reveal the full sk-... for a single key.
 *
 * The full token_value is in the portal Prisma row (set during create).
 * We do NOT call new-api here — that would burn the gotcha #11 POST
 * /api/token/{id}/key on every reveal, which is wasteful (and POST has
 * "rotate" semantics on some upstream variants we'd rather not touch).
 *
 * Auth: cookie session + ownership check. Same 401-on-mismatch pattern as
 * DELETE so existence isn't leaked through 404 vs 401 differentiation.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { formatTokenForDisplay } from '@/lib/newapi/token-format';

export const runtime = 'nodejs';

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const user = await getCurrentUser(req);
    if (!user) {
        return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }

    const { id } = await params;
    const token = await prisma.newApiToken.findUnique({
        where: { id },
        select: {
            user_id: true,
            newapi_token_value: true,
            status: true,
        },
    });
    if (!token) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    if (token.user_id !== user.id) {
        // IDOR defense; 401 not 403/404 to avoid leaking existence.
        return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }
    if (token.status !== 'active') {
        // Don't surface revoked keys' raw value
        return NextResponse.json({ error: 'token_revoked' }, { status: 410 });
    }

    // W7 D4 PR-H Tier A: stored value omits the `sk-` prefix that the
    // wire format requires (new-api stores the bare 48-char id; we
    // mirror its storage). Apply the prefix here at the response
    // boundary so the customer pastes a working Authorization value
    // verbatim. `formatTokenForDisplay` is idempotent — safe even if
    // the stored representation ever flips to prefixed form.
    return NextResponse.json({ key: formatTokenForDisplay(token.newapi_token_value) });
}
