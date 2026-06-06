import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope, tenantForInsert } from '@/lib/admin/tenant-scope';

export const runtime = 'nodejs';

const createSchema = z.object({
    key: z
        .string()
        .trim()
        .min(1)
        .max(50)
        .regex(/^[a-z0-9-]+$/, 'key 只能是小写字母 / 数字 / 连字符'),
    display_name: z.string().min(1).max(100),
    description: z.string().max(500).nullable().optional(),
    newapi_group: z.string().trim().min(1).max(50),
    tier_level: z.number().int().min(0).optional().default(0),
    enabled: z.boolean().optional().default(true),
    is_default: z.boolean().optional().default(false),
    newapi_channel_ids: z.array(z.number().int()).optional().default([]),
});

export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);

    const groups = await prisma.channelGroup.findMany({
        where: { ...tenantScope(admin) },
        orderBy: [{ tier_level: 'asc' }, { created_at: 'asc' }],
    });
    return NextResponse.json({ groups });
}

export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const data = parsed.data;
    const tenant_id = tenantForInsert(admin);

    const dup = await prisma.channelGroup.findFirst({ where: { tenant_id, key: data.key } });
    if (dup) {
        return NextResponse.json({ error: `档次 key "${data.key}" 已存在` }, { status: 409 });
    }

    // 单一默认档不变式:设新档为默认时,先清掉本租户其它默认。
    const group = await prisma.$transaction(async (tx) => {
        if (data.is_default) {
            await tx.channelGroup.updateMany({ where: { tenant_id }, data: { is_default: false } });
        }
        return tx.channelGroup.create({ data: { tenant_id, ...data } });
    });
    return NextResponse.json({ group }, { status: 201 });
}
