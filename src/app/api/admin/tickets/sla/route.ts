/** GET/PUT /api/admin/tickets/sla — 工单 SLA 阈值(SystemConfig)+ 当前统计。PUT 仅 superadmin。 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { getTicketSlaStats, setTicketSla, SLA_LIMITS } from '@/lib/tickets/sla';
import { readJson } from '@/lib/tickets/http';

export const runtime = 'nodejs';

const Schema = z.object({
    firstReplyHours: z.number().int().min(SLA_LIMITS.min).max(SLA_LIMITS.max),
    resolveHours: z.number().int().min(SLA_LIMITS.min).max(SLA_LIMITS.max),
});

export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);
    return NextResponse.json({ sla: await getTicketSlaStats(admin) });
}

export async function PUT(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    const parsed = Schema.safeParse(await readJson(request));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    await setTicketSla(parsed.data);
    return NextResponse.json({ sla: await getTicketSlaStats(admin) });
}
