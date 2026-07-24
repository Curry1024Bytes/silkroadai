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
        select: {
            id: true,
            name: true,
            key_prefix: true,
            region: true,
            status: true,
            created_at: true,
            last_used_at: true,
        },
    });
    return NextResponse.json({ keys });
}

const createSchema = z.object({
    name: z.string().trim().min(1).max(50),
    // 版本绑定(2026-07-23 海外版):key 只能调对应版本模型
    region: z.enum(['cn', 'global', 'promax']).default('cn'),
});

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

    // 版本开通门(2026-07-24):该版本没配上游 key 就不让建 —— 否则客户拿到 key 一调就 503,
    // 且看不出原因。开通 = 运营后台给该客户写对应 region 的上游 key 行。
    const enabled = await prisma.enterpriseUpstreamKey.findUnique({
        where: { user_id_region: { user_id: user.id, region: parsed.data.region } },
        select: { id: true },
    });
    if (!enabled) {
        return NextResponse.json({ error: 'region_not_enabled' }, { status: 400 });
    }

    const g = generateEnterpriseKey();
    const row = await prisma.enterpriseKey.create({
        data: {
            user_id: user.id,
            tenant_id: user.tenant_id,
            key_hash: g.hash,
            key_prefix: g.prefix,
            name: parsed.data.name,
            region: parsed.data.region,
        },
        select: {
            id: true,
            name: true,
            key_prefix: true,
            region: true,
            status: true,
            created_at: true,
            last_used_at: true,
        },
    });
    // ⚠️ 明文只在这里返回一次(DB 只存 sha256)
    return NextResponse.json({ key: g.key, row });
}
