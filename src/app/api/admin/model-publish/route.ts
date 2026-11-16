import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveAdmin } from '@/lib/admin/auth';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { tenantForInsert } from '@/lib/admin/tenant-scope';
import { applyModelPublish, ModelPublishError, previewModelPublish } from '@/lib/admin/model-publish';

export const runtime = 'nodejs';

const schema = z.object({ preview_token: z.string().min(1).max(200).optional() }).strict();

export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
        return NextResponse.json({ error: 'invalid_input', message: '发布请求无效，请重新预览。' }, { status: 400 });

    // Preview is the default. A write requires an explicit query flag plus a signed preview token.
    const dryRun = request.nextUrl.searchParams.get('dryRun') !== 'false';
    if (!dryRun && !parsed.data.preview_token)
        return NextResponse.json({ error: 'preview_required', message: '请先预览，再确认发布。' }, { status: 400 });

    const tenantId = tenantForInsert(admin);
    try {
        if (dryRun) return NextResponse.json({ dryRun, preview: await previewModelPublish(tenantId) });
        const result = await applyModelPublish(tenantId, admin.user?.id ?? null, parsed.data.preview_token!);
        return NextResponse.json({ dryRun, ...result });
    } catch (error) {
        if (error instanceof ModelPublishError)
            return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
        if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            ['P2028', 'P2034', 'P2025', 'P2002'].includes(String(error.code))
        )
            return NextResponse.json(
                { error: 'preview_stale', message: '配置正在被修改，请重新预览后再确认发布。' },
                { status: 409 },
            );
        // Upstream errors can contain channel settings or credentials. Keep the response generic.
        return NextResponse.json(
            {
                error: 'model_publish_failed',
                message: '无法完成模型发布，请检查 new-api 连接和渠道配置后重新预览。',
            },
            { status: 502 },
        );
    }
}
