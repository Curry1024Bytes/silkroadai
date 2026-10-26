/**
 * 客户专属倍率(2026-10-25,PR-2 写路径)。superadmin only。
 *   GET  → 当前状态(portal 留痕 + new-api 矩阵 / 用户分组现值 + 漂移 + 可选档次)
 *   PUT  → 整体替换 { overrides: [{ newapi_group, ratio, note? }] };空数组 = 取消全部专属价(用户分组回 default)
 * 机制与硬规则见 src/lib/newapi/customer-ratio.ts 文件头。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { CustomerRatioError, getCustomerRatioState, setCustomerRatios } from '@/lib/newapi/customer-ratio';

export const runtime = 'nodejs';

const PutSchema = z.object({
    overrides: z
        .array(
            z.object({
                newapi_group: z.string().trim().min(1).max(64),
                ratio: z.number().positive().max(100),
                note: z.string().trim().max(200).optional().nullable(),
            }),
        )
        .max(50),
});

async function findScopedUser(request: NextRequest, id: string) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return { admin: null, user: null };
    const user = await prisma.user.findFirst({ where: { id, ...tenantScope(admin) }, select: { id: true } });
    return { admin, user };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const { admin, user } = await findScopedUser(request, id);
    if (!admin) return unauthorizedResponse(request);
    if (!user) return NextResponse.json({ error: '客户不存在' }, { status: 404 });
    try {
        return NextResponse.json(await getCustomerRatioState(user.id));
    } catch (err) {
        console.error(`[admin/special-ratios GET] ${id}:`, err);
        return NextResponse.json({ error: 'state_unavailable' }, { status: 502 });
    }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const { admin, user } = await findScopedUser(request, id);
    if (!admin) return unauthorizedResponse(request);
    if (!user) return NextResponse.json({ error: '客户不存在' }, { status: 404 });
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = PutSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    try {
        const result = await setCustomerRatios(
            user.id,
            parsed.data.overrides,
            admin.viaBreakGlass ? 'break-glass' : (admin.user?.id ?? null),
        );
        const state = await getCustomerRatioState(user.id);
        return NextResponse.json({ ok: true, result, state });
    } catch (err) {
        if (err instanceof CustomerRatioError) {
            const status =
                err.code === 'account_not_provisioned'
                    ? 409
                    : err.code === 'newapi_user_unreadable' || err.code === 'token_pin_failed'
                      ? 502
                      : 400;
            return NextResponse.json({ error: err.code, message: err.message }, { status });
        }
        console.error(`[admin/special-ratios PUT] ${id}:`, err);
        return NextResponse.json({ error: 'newapi_write_failed' }, { status: 502 });
    }
}
