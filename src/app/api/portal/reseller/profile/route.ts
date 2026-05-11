/**
 * GET /api/portal/reseller/profile (PR-U1)
 *
 * Returns the current user's reseller row. 404 when user hasn't joined
 * the program. UI uses this to decide whether to render the
 * "join the program" CTA or the dashboard.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { getAuthedReseller } from '@/lib/reseller/auth-helper';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
    const auth = await getAuthedReseller(req);
    if (!auth.ok) return auth.response;
    const { reseller } = auth.ctx;
    return NextResponse.json({
        reseller_id: reseller.id,
        user_id: reseller.user_id,
        tier: reseller.tier,
        status: reseller.status,
        cumulative_gmv: reseller.cumulative_gmv.toString(),
        settle_method: reseller.settle_method,
        settle_account: reseller.settle_account,
        settle_name: reseller.settle_name,
        joined_at: reseller.joined_at.toISOString(),
    });
}
