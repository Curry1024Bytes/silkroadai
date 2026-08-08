import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';

export const runtime = 'nodejs';

/**
 * 全局折扣(按 渠道×模型 的临时促销,如上游 fast/mini 降价一个月我们跟降)。守门:superadmin。
 * 计价优先级:客户议价(绝对单价 override)> 全局折扣 > 客户折扣率。全局折扣【覆盖客户折扣率】,
 * 按 (region, variant) 隔离(只影响目标模型),expires_at 到期读时自动失效。
 *   GET  → 列出全部(带 active/expired 标记)
 *   POST → 设/改一条;discount=null 清除该 (region, variant)
 */
const schema = z.object({
    region: z.enum(['cn', 'global', 'promax', 'volc']),
    variant: z.enum(['pro', 'fast', 'mini', '2.5', 'promax', 'promax-fast', 'promax-mini', 'promax-2.5']),
    // 0.05~2(>1 = 上浮);null = 清除该档全局折扣(回落客户折扣率)
    discount: z.number().min(0.05).max(2).nullable(),
    // 到期时间(ISO 字符串;null / 省略 = 手动撤销前长期有效)
    expires_at: z.string().datetime().nullable().optional(),
    note: z.string().trim().max(200).optional(),
});

export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    const rows = await prisma.enterpriseGlobalDiscount.findMany({
        orderBy: [{ region: 'asc' }, { variant: 'asc' }],
    });
    const now = Date.now();
    return NextResponse.json({
        discounts: rows.map((r) => ({
            region: r.region,
            variant: r.variant,
            discount: Number(r.discount),
            expires_at: r.expires_at?.toISOString() ?? null,
            expired: r.expires_at ? r.expires_at.getTime() <= now : false,
            note: r.note ?? null,
            created_at: r.created_at.toISOString(),
        })),
    });
}

export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const { region, variant, discount, expires_at, note } = parsed.data;

    if (discount == null) {
        await prisma.enterpriseGlobalDiscount.deleteMany({ where: { region, variant } });
        return NextResponse.json({ ok: true, region, variant, discount: null, cleared: true });
    }

    const expiresAt = expires_at ? new Date(expires_at) : null;
    const row = await prisma.enterpriseGlobalDiscount.upsert({
        where: { region_variant: { region, variant } },
        create: { region, variant, discount, expires_at: expiresAt, note, created_by: admin.user?.id ?? null },
        update: { discount, expires_at: expiresAt, note },
    });
    return NextResponse.json({
        ok: true,
        region,
        variant,
        discount: Number(row.discount),
        expires_at: row.expires_at?.toISOString() ?? null,
    });
}
