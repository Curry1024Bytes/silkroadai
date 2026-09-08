import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveEnterpriseAdmin } from '@/lib/enterprise/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/enterprise/logs/[id] — 单条请求日志全量 JSON(含入参 / 上游响应原文)。
 * ?download=1 → Content-Disposition attachment(详情页「下载 JSON」按钮)。
 * 守门:superadmin。upstream_body 含上游域名,仅内部使用(#271)。
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
    const admin = await resolveEnterpriseAdmin(request);
    if (!admin) return unauthorizedResponse(request);

    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
        return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
    }
    const log = await prisma.enterpriseRequestLog.findUnique({ where: { id } });
    if (!log) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
    if (request.nextUrl.searchParams.get('download') === '1') {
        headers['Content-Disposition'] = `attachment; filename="reqlog-${log.id}.json"`;
    }
    return new NextResponse(JSON.stringify(log, null, 2), { status: 200, headers });
}
