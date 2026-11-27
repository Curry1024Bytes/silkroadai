import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

export const runtime = 'nodejs';

const colorRe = /^#[0-9a-fA-F]{6}$/;

const patchSchema = z.object({
    brand_name: z.string().min(1).max(100).optional(),
    logo_url: z.string().url().max(500).nullable().optional(),
    primary_color: z.string().regex(colorRe, '需 #RRGGBB 十六进制色值').nullable().optional(),
    support_email: z.string().email().max(254).nullable().optional(),
    support_wechat: z.string().max(64).nullable().optional(),
});

/** GET /api/partner/brand — 读取品牌配置 */
export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'staff');
    if (!admin) return unauthorizedResponse(request);
    if (!admin.tenant_id || admin.tenant_id === PLATFORM_TENANT_ID) {
        return NextResponse.json({ error: '仅白标代理可访问' }, { status: 403 });
    }

    const tenant = await prisma.tenant.findUnique({
        where: { id: admin.tenant_id },
        select: {
            brand_name: true,
            logo_url: true,
            primary_color: true,
            support_email: true,
            support_wechat: true,
        },
    });
    if (!tenant) return NextResponse.json({ error: '租户不存在' }, { status: 404 });

    return NextResponse.json({ brand: tenant });
}

/** PATCH /api/partner/brand — 更新品牌配置（代理可自改）*/
export async function PATCH(request: NextRequest) {
    const admin = await resolveAdmin(request, 'staff');
    if (!admin) return unauthorizedResponse(request);
    if (!admin.tenant_id || admin.tenant_id === PLATFORM_TENANT_ID) {
        return NextResponse.json({ error: '仅白标代理可访问' }, { status: 403 });
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten().fieldErrors }, { status: 400 });
    }

    if (Object.keys(parsed.data).length === 0) {
        return NextResponse.json({ error: '无可更新字段' }, { status: 400 });
    }

    const tenant = await prisma.tenant.update({
        where: { id: admin.tenant_id },
        data: parsed.data,
        select: {
            brand_name: true,
            logo_url: true,
            primary_color: true,
            support_email: true,
            support_wechat: true,
        },
    });

    return NextResponse.json({ brand: tenant });
}
