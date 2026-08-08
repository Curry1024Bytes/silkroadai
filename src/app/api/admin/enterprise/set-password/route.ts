import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { hash } from 'bcryptjs';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';

export const runtime = 'nodejs';

/**
 * POST /api/admin/enterprise/set-password — 企业客户 dashboard 登录密码下发/重置(P2)。
 *
 * P1 开户建的 User 无密码(API-only);P2 dashboard 上线后 admin 用这里设初始密码
 * 交给客户(企业客户无自助注册/找回,见决策 Q5)。守门:superadmin(break-glass
 * x-admin-token 也过)。设密同时 session_token_version++ 踢掉既有登录态(重置场景安全)。
 */
const schema = z
    .object({
        user_id: z.string().uuid().optional(),
        email: z
            .string()
            .trim()
            .email()
            .transform((s) => s.toLowerCase())
            .optional(),
        password: z.string().min(8).max(128),
    })
    .refine((d) => d.user_id || d.email, { message: 'user_id 或 email 必须给一个' });

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
        return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten() }, { status: 400 });
    }
    const { user_id, email, password } = parsed.data;

    const user = await prisma.user.findFirst({
        where: user_id ? { id: user_id } : { email },
        select: { id: true, email: true },
    });
    if (!user) return NextResponse.json({ error: 'user_not_found' }, { status: 404 });

    const password_hash = await hash(password, 12);
    await prisma.user.update({
        where: { id: user.id },
        data: { password_hash, session_token_version: { increment: 1 } },
    });
    return NextResponse.json({ user_id: user.id, email: user.email, ok: true });
}
