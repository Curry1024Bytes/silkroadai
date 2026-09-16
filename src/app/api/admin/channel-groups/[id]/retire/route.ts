import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { PricingPublishError } from '@/lib/admin/pricing-publish-lock';
import { ChannelGroupRetirementError } from '@/lib/admin/channel-group-retirement';
import { previewRetirementJob, startRetirementJob } from '@/lib/admin/channel-group-retirement-job';

export const runtime = 'nodejs';
const schema = z
    .object({
        action: z.enum(['preview', 'apply']),
        replacement_default_id: z.string().min(1).max(100).nullable().optional(),
        preview_token: z.string().min(1).max(4096).optional(),
    })
    .strict();

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
        return NextResponse.json({ error: 'invalid_input', message: '删除参数无效，请刷新后重试。' }, { status: 400 });
    if (parsed.data.action === 'apply' && !parsed.data.preview_token)
        return NextResponse.json(
            { error: 'preview_required', message: '请先查看删除影响，再确认删除。' },
            { status: 400 },
        );
    const { id } = await params;
    try {
        // Authorize and locate the tenant before any upstream reads.
        const group = await prisma.channelGroup.findFirst({
            where: { id, ...tenantScope(admin) },
            select: { id: true, tenant_id: true, key: true, newapi_group: true },
        });
        if (!group)
            return NextResponse.json(
                { error: 'group_not_found', message: '渠道分组不存在，请刷新列表。' },
                { status: 404 },
            );
        const selection = {
            groupId: group.id,
            tenantId: group.tenant_id,
            tierKey: group.key,
            newapiGroup: group.newapi_group,
            replacementDefaultId: parsed.data.replacement_default_id,
        };
        if (parsed.data.action === 'preview')
            return NextResponse.json({ preview: await previewRetirementJob(selection, admin) });
        const job = await startRetirementJob(selection, admin, parsed.data.preview_token!);
        return NextResponse.json({ job }, { status: 202 });
    } catch (error) {
        if (error instanceof ChannelGroupRetirementError || error instanceof PricingPublishError)
            return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
        if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            ['P2028', 'P2034', 'P2025'].includes(String(error.code))
        )
            return NextResponse.json(
                { error: 'preview_stale', message: '配置正在被修改，请重新预览后确认。' },
                { status: 409 },
            );
        return NextResponse.json(
            { error: 'retirement_failed', message: '任务未完成，请刷新任务查看实际进度；已撤销的 Key 不会恢复。' },
            { status: 500 },
        );
    }
}
