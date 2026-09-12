import { NextRequest, NextResponse } from 'next/server';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';

export const runtime = 'nodejs';

/** Keep the old URL explicit and safe: an unreviewed resync must never bypass
 * durable publication or silently choose one tier's globally shared price. */
export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    return NextResponse.json(
        {
            error: 'pricing_preview_required',
            message: '请刷新定价页，选择具体档次并预览发布。已有任务请在发布记录中继续核验。',
        },
        { status: 409 },
    );
}
