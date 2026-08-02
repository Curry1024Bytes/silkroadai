import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireEnterpriseUser } from '@/lib/enterprise/session';
import { generateAkSk, hashEnterpriseKey } from '@/lib/enterprise/keys';
import { encryptSecret } from '@/lib/enterprise/crypto';

export const runtime = 'nodejs';

/**
 * 企业门户 AK/SK 凭据管理(2026-07-28,火山 SignerV4 签名鉴权用)。
 * GET  → 本人 AK/SK 列表(AK 明文 + 状态/时间;SK 永不回显)。
 * POST → 生成新对(SK 明文只在本响应返一次;DB 加密存)。
 */
export async function GET(req: NextRequest) {
    const user = await requireEnterpriseUser(req);
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const items = await prisma.enterpriseAkSk.findMany({
        where: { user_id: user.id },
        orderBy: { created_at: 'asc' },
        select: { id: true, access_key: true, name: true, status: true, created_at: true, last_used_at: true },
    });
    return NextResponse.json({ items });
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

    const { accessKey, secretKey } = generateAkSk();
    const row = await prisma.enterpriseAkSk.create({
        data: {
            user_id: user.id,
            tenant_id: user.tenant_id,
            access_key: accessKey,
            secret_key_enc: encryptSecret(secretKey),
            secret_key_hash: hashEnterpriseKey(secretKey), // SK 可直接当 Bearer key 用(2026-07-30)
            name: parsed.data.name,
        },
        select: { id: true, access_key: true, name: true, status: true, created_at: true, last_used_at: true },
    });
    // ⚠️ SK 明文只在这里返回一次(DB 只存密文)
    return NextResponse.json({ access_key: accessKey, secret_key: secretKey, row });
}
