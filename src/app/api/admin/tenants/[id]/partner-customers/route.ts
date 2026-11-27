import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import { getUser } from '@/lib/newapi/client';
import { assignExistingPartnerCustomer, type PartnerAssignResult } from '@/lib/partner/assign-group';
import { partnerErrorResponse } from '@/lib/partner/errors';
import { partnerUserGroup } from '@/lib/partner/group';

export const runtime = 'nodejs';

/**
 * /api/admin/tenants/[id]/partner-customers — 存量客户归入代理分组（一次性操作）。
 *
 * GET  — 列出该代理下已开通 new-api 的客户及其当前 new-api 用户分组
 * POST — { user_ids } 逐个迁移；不满足迁移条件的客户原样保留并返回原因
 */

const MAX_LIST = 200;
const assignSchema = z.object({ user_ids: z.array(z.string().uuid()).min(1).max(50) });

async function guard(request: NextRequest, id: string): Promise<NextResponse | null> {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    if (id === PLATFORM_TENANT_ID) {
        return NextResponse.json({ error: 'platform_tenant', message: '平台客户不能归入代理分组' }, { status: 400 });
    }
    const tenant = await prisma.tenant.findUnique({ where: { id }, select: { id: true } });
    if (!tenant) return NextResponse.json({ error: 'not_found', message: '租户不存在' }, { status: 404 });
    return null;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const denied = await guard(request, id);
    if (denied) return denied;

    const users = await prisma.user.findMany({
        where: { tenant_id: id, newapi_user_id: { not: null } },
        orderBy: { created_at: 'asc' },
        take: MAX_LIST,
        select: { id: true, email: true, newapi_user_id: true },
    });
    const partnerGroup = partnerUserGroup(id);
    const customers: Array<{ id: string; email: string; group: string | null; assigned: boolean }> = [];
    // new-api 共享给全站，逐个查，避免并发打满。
    for (const user of users) {
        const group = await getUser(user.newapi_user_id!)
            .then((remote) => remote.group ?? '')
            .catch(() => null);
        customers.push({ id: user.id, email: user.email, group, assigned: group === partnerGroup });
    }
    return NextResponse.json({ partner_group: partnerGroup, customers, truncated: users.length === MAX_LIST });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const denied = await guard(request, id);
    if (denied) return denied;

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = assignSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten().fieldErrors }, { status: 400 });
    }

    const results: Array<PartnerAssignResult | { user_id: string; status: 'error'; problems: string[] }> = [];
    for (const userId of parsed.data.user_ids) {
        try {
            results.push(await assignExistingPartnerCustomer(userId, id));
        } catch (error) {
            results.push({ user_id: userId, status: 'error', problems: [partnerErrorResponse(error).body.message] });
        }
    }
    return NextResponse.json({ results });
}
