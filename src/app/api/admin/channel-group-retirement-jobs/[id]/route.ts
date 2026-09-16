import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveAdmin } from '@/lib/admin/auth';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { getRetirementJob, resumeRetirementJob, stopRetirementJob } from '@/lib/admin/channel-group-retirement-job';
import { retirementErrorResponse } from '@/lib/admin/channel-group-retirement-response';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
const schema = z.object({ action: z.enum(['resume', 'stop']) }).strict();

export async function GET(request: NextRequest, { params }: Context) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    try {
        return NextResponse.json({ job: await getRetirementJob((await params).id, admin) });
    } catch (error) {
        return retirementErrorResponse(error);
    }
}

export async function POST(request: NextRequest, { params }: Context) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
        return NextResponse.json({ error: 'invalid_input', message: '任务操作无效，请刷新后重试。' }, { status: 400 });
    try {
        const id = (await params).id;
        return NextResponse.json({
            job: await (parsed.data.action === 'resume'
                ? resumeRetirementJob(id, admin)
                : stopRetirementJob(id, admin)),
        });
    } catch (error) {
        return retirementErrorResponse(error);
    }
}
