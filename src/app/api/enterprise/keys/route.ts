import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireEnterpriseUser } from '@/lib/enterprise/session';
import { generateEnterpriseKey } from '@/lib/enterprise/keys';

export const runtime = 'nodejs';

/**
 * 企业门户密钥管理 API(P2,cookie 会话 + 企业客户判定)。
 * GET  → 本人密钥列表(prefix/状态/时间,永不回明文/哈希)。
 * POST → 创建(active 上限 10;明文只在本响应返一次)。
 */
const MAX_ACTIVE_KEYS = 10;

export async function GET(req: NextRequest) {
    const user = await requireEnterpriseUser(req);
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const keys = await prisma.enterpriseKey.findMany({
        where: { user_id: user.id },
        orderBy: { created_at: 'asc' },
        select: { id: true, name: true, key_prefix: true, status: true, created_at: true, last_used_at: true },
    });
    return NextResponse.json({ keys });
}

const createSchema = z.object({ name: z.string().trim().min(1).max(50) });

export async function POST(req: NextRequest) {
    const user = await requireEnterpriseUser(req);
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 });

    const activeCount = await prisma.enterpriseKey.count({ where: { user_id: user.id, status: 'active' } });
    if (activeCount >= MAX_ACTIVE_KEYS) {
        return NextResponse.json({ error: 'key_limit_reached' }, { status: 400 });
    }

    const g = generateEnterpriseKey();
    const row = await prisma.enterpriseKey.create({
        data: {
            user_id: user.id,
            tenant_id: user.tenant_id,
            key_hash: g.hash,
            key_prefix: g.prefix,
            name: parsed.data.name,
        },
        select: { id: true, name: true, key_prefix: true, status: true, created_at: true, last_used_at: true },
    });
    // ⚠️ 明文只在这里返回一次(DB 只存 sha256)
    return NextResponse.json({ key: g.key, row });
}
