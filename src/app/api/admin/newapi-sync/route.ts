import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveAdmin } from '@/lib/admin/auth';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { tenantForInsert } from '@/lib/admin/tenant-scope';
import { applyNewApiSync, NewApiSyncError, previewNewApiSync } from '@/lib/admin/newapi-sync';

export const runtime = 'nodejs';
const schema = z
    .object({
        preview_token: z.string().max(100).optional(),
        selected: z.array(z.string().max(1200)).max(20000).optional(),
        activate: z.array(z.string().max(1200)).max(20000).optional(),
    })
    .strict();

export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
        return NextResponse.json({ error: 'invalid_input', message: '同步请求无效，请重新预览。' }, { status: 400 });
    const dryRun = request.nextUrl.searchParams.get('dryRun') !== 'false';
    if (!dryRun && (!parsed.data.preview_token || !parsed.data.selected?.length))
        return NextResponse.json(
            { error: 'preview_required', message: '请先预览并选择变化，再确认同步。' },
            { status: 400 },
        );
    try {
        const tenantId = tenantForInsert(admin);
        if (dryRun) return NextResponse.json({ dryRun, preview: await previewNewApiSync(tenantId) });
        const result = await applyNewApiSync(tenantId, admin.user?.id ?? null, parsed.data.preview_token!, {
            selected: parsed.data.selected!,
            activate: parsed.data.activate ?? [],
        });
        return NextResponse.json({ dryRun, ...result });
    } catch (error) {
        if (error instanceof NewApiSyncError)
            return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
        if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            ['P2034', 'P2025', 'P2002'].includes(String(error.code))
        )
            return NextResponse.json(
                { error: 'preview_stale', message: '配置正在被修改，请重新预览后再确认。' },
                { status: 409 },
            );
        // Do not return channel credentials, option payloads, database details or raw upstream exceptions.
        return NextResponse.json(
            {
                error: 'sync_failed',
                message: '无法完成同步，请检查 new-api 连接和配置后重新预览；本次没有提交部分修改。',
            },
            { status: 502 },
        );
    }
}
