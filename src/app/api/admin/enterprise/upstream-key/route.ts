import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { encryptUpstreamKey } from '@/lib/enterprise/crypto';

export const runtime = 'nodejs';

/**
 * POST /api/admin/enterprise/upstream-key — 按版本设置/替换客户上游 key(2026-07-23 海外版)。
 * upsert (user_id, region) 行:海外开通 = 给客户加一行 region='global';替换 = 覆盖 enc。
 * discount 已有行保留(replace 不动折扣);新行默认 1。守门:superadmin。
 */
const schema = z.object({
    user_id: z.string().uuid(),
    region: z.enum(['cn', 'global', 'promax', 'volc']),
    upstream_key: z.string().trim().min(8).max(200),
    note: z.string().trim().max(200).optional(),
});

export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const { user_id, region, upstream_key, note } = parsed.data;

    const user = await prisma.user.findUnique({ where: { id: user_id }, select: { id: true } });
    if (!user) return NextResponse.json({ error: 'user_not_found' }, { status: 404 });

    const enc = encryptUpstreamKey(upstream_key);
    await prisma.enterpriseUpstreamKey.upsert({
        where: { user_id_region: { user_id, region } },
        create: { user_id, region, upstream_key_enc: enc, note: note ?? null },
        update: { upstream_key_enc: enc, ...(note !== undefined ? { note } : {}) },
    });
    return NextResponse.json({ ok: true, user_id, region });
}
