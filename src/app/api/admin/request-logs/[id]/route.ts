import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { extractClientIP } from '@/lib/auth/extract-ip';
import { writeAccessAudit } from '@/lib/reqlog/access-audit';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/admin/request-logs/[id] — 单条 RequestLog 完整元数据(不含 R2 原文)。
 * **superadmin only**。看元数据写 `view_meta` 审计 —— best-effort(元数据不含客户原文)。
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const { id } = await ctx.params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });

    const log = await prisma.requestLog.findUnique({ where: { id } });
    if (!log) return NextResponse.json({ error: 'not found' }, { status: 404 });

    void writeAccessAudit({
        principal: admin,
        action: 'view_meta',
        requestLogId: id,
        ip: extractClientIP(request),
    }).catch((e) => console.warn('[reqlog-access] view_meta audit failed (best-effort)', e));

    return NextResponse.json({ log });
}
