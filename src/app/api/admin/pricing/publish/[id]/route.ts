import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { changePricingJob, pricingPublishErrorResponse } from '@/lib/admin/pricing-publish';

export const runtime = 'nodejs';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = z.object({ action: z.enum(['retry', 'cancel']) }).safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    try {
        return NextResponse.json({ job: await changePricingJob(id, parsed.data.action, admin) });
    } catch (error) {
        const response = pricingPublishErrorResponse(error);
        return NextResponse.json(response.body, { status: response.status });
    }
}
