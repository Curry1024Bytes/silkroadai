import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantForInsert, tenantScope } from '@/lib/admin/tenant-scope';
import {
    normalizeUpstreamCostInput,
    UPSTREAM_COST_STATUSES,
    type NormalizedUpstreamCostInput,
} from '@/lib/billing/upstream-cost-ledger';

export const runtime = 'nodejs';

/**
 * /api/admin/upstream-costs — 上游成本台账（仅 Portal PostgreSQL）。
 *
 * 本接口只读/写 Portal 的审计台账，绝不访问 new-api 的写接口，也不修改余额、
 * quota、客户 Key 或请求路由。供应商实际扣费尚未自动化前，人工记录与 CSV
 * 导入是唯一成本来源；`source` 由服务端固定为 manual，不能由客户端伪造。
 */

const listSchema = z.object({
    page: z.coerce.number().int().positive().max(10_000).catch(1),
    page_size: z.coerce.number().int().positive().max(100).catch(25),
    status: z.enum(UPSTREAM_COST_STATUSES).optional(),
});

function asEntryData(value: NormalizedUpstreamCostInput) {
    return {
        ...value,
        source: 'manual' as const,
    };
}

export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const parsed = listSchema.safeParse({
        page: request.nextUrl.searchParams.get('page') ?? undefined,
        page_size: request.nextUrl.searchParams.get('page_size') ?? undefined,
        status: request.nextUrl.searchParams.get('status') ?? undefined,
    });
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', message: 'status、page 或 page_size 参数无效' },
            { status: 400 },
        );
    }
    const query = parsed.data;
    const where = { ...tenantScope(admin), ...(query.status ? { status: query.status } : {}) };
    const [entries, total] = await Promise.all([
        prisma.upstreamCostEntry.findMany({
            where,
            orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
            skip: (query.page - 1) * query.page_size,
            take: query.page_size,
            include: { import: { select: { id: true, filename: true, created_at: true } } },
        }),
        prisma.upstreamCostEntry.count({ where }),
    ]);
    return NextResponse.json({
        entries,
        total,
        page: query.page,
        page_size: query.page_size,
        total_pages: Math.max(1, Math.ceil(total / query.page_size)),
    });
}

export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input', message: '请求体必须是 JSON 成本记录' }, { status: 400 });
    }

    let value: NormalizedUpstreamCostInput;
    try {
        value = normalizeUpstreamCostInput(body);
    } catch (error) {
        return NextResponse.json(
            { error: 'invalid_input', message: error instanceof Error ? error.message : '成本记录无效' },
            { status: 400 },
        );
    }

    const entry = await prisma.upstreamCostEntry.create({
        data: {
            ...asEntryData(value),
            tenant_id: tenantForInsert(admin),
            created_by: admin.user?.id ?? null,
        },
    });
    return NextResponse.json({ entry }, { status: 201 });
}
