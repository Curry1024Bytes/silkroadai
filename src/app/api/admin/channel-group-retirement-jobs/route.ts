import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveAdmin } from '@/lib/admin/auth';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { listRetirementJobs, previewRetirementJob, startRetirementJob } from '@/lib/admin/channel-group-retirement-job';
import { retirementErrorResponse } from '@/lib/admin/channel-group-retirement-response';

export const runtime = 'nodejs';
const schema = z
    .object({
        action: z.enum(['preview', 'apply']),
        tenant_id: z.string().uuid().nullable(),
        tier_key: z.string().trim().min(1).max(200),
        newapi_group: z.string().trim().min(1).max(200),
        preview_token: z.string().min(1).max(4096).optional(),
    })
    .strict();

export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    try {
        return NextResponse.json(await listRetirementJobs(admin));
    } catch (error) {
        return retirementErrorResponse(error);
    }
}

export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success || (parsed.data.action === 'apply' && !parsed.data.preview_token))
        return NextResponse.json(
            { error: 'invalid_input', message: '请填写遗留档次、new-api 分组并先预览。' },
            { status: 400 },
        );
    const selection = {
        groupId: null,
        tenantId: parsed.data.tenant_id,
        tierKey: parsed.data.tier_key,
        newapiGroup: parsed.data.newapi_group,
    };
    try {
        return parsed.data.action === 'preview'
            ? NextResponse.json({ preview: await previewRetirementJob(selection, admin) })
            : NextResponse.json(
                  { job: await startRetirementJob(selection, admin, parsed.data.preview_token!) },
                  { status: 202 },
              );
    } catch (error) {
        return retirementErrorResponse(error);
    }
}
