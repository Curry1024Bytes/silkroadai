import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { migrateUserKeysToTier, UserTierMultiplierError } from '@/lib/newapi/user-tier-multiplier';

export const runtime = 'nodejs';

const MigrateKeysSchema = z.object({
    tier_key: z.string().trim().min(1).max(100),
});

/**
 * POST — apply an existing dedicated rate to all active historical keys.
 * Key material never enters this handler: only upstream token IDs and Portal
 * tier metadata are updated.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: '请求格式无效' }, { status: 400 });
    }
    const parsed = MigrateKeysSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: '档次格式无效', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }

    const customer = await prisma.user.findFirst({
        where: { id, ...tenantScope(admin) },
        select: {
            id: true,
            tenant_id: true,
            newapi_user_id: true,
            newapi_access_token: true,
        },
    });
    if (!customer) return NextResponse.json({ error: '客户不存在' }, { status: 404 });

    try {
        const result = await migrateUserKeysToTier({ user: customer, tierKey: parsed.data.tier_key });
        return NextResponse.json({ ok: true, ...result });
    } catch (err) {
        if (err instanceof UserTierMultiplierError) {
            return NextResponse.json({ error: err.message }, { status: err.status });
        }
        console.error('[admin/rate-overrides] key migration failed', { customerId: id, err });
        return NextResponse.json({ error: '历史 API Key 迁移失败' }, { status: 502 });
    }
}
