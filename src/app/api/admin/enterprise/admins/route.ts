import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { hash } from 'bcryptjs';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveEnterpriseAdmin, auditAdminAction } from '@/lib/enterprise/admin-auth';

export const runtime = 'nodejs';

/**
 * 企业运营后台 次级管理员管理(2026-09-04)。守门:superadmin-only(次级管理员不能自我繁殖)。
 *
 * GET  — 列出全部次级管理员(join user email/状态)。
 * POST — 授予:{email, password?, note?}
 *   · email 已有 portal 账号 → 直接加 enterprise_admins 行(不动其 role/密码);
 *   · 无账号且给了 password → 建【裸 User】(role=customer,不 provision new-api,
 *     纯登录账号)+ 行 —— 次级管理员不是客户,不给任何调用面;
 *   · 无账号且没给 password → 400 提示补密码。
 * 次级管理员权限只对 /enterprise-admin 生效(admin-auth.ts),不外溢主站。
 */
const grantSchema = z.object({
    email: z
        .string()
        .trim()
        .email()
        .transform((s) => s.toLowerCase()),
    password: z.string().min(8).max(128).optional(),
    note: z.string().trim().max(200).optional(),
});

export async function GET(request: NextRequest) {
    const admin = await resolveEnterpriseAdmin(request, { superOnly: true });
    if (!admin) return unauthorizedResponse(request);

    const rows = await prisma.enterpriseAdmin.findMany({ orderBy: { created_at: 'asc' } });
    const users = await prisma.user.findMany({
        where: { id: { in: rows.map((r) => r.user_id) } },
        select: { id: true, email: true, nickname: true, status: true, last_login_at: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return NextResponse.json({
        admins: rows.map((r) => {
            const u = byId.get(r.user_id);
            return {
                user_id: r.user_id,
                email: u?.email ?? null,
                nickname: u?.nickname ?? null,
                user_status: u?.status ?? null,
                last_login_at: u?.last_login_at?.toISOString() ?? null,
                note: r.note ?? null,
                created_at: r.created_at.toISOString(),
            };
        }),
    });
}

export async function POST(request: NextRequest) {
    const admin = await resolveEnterpriseAdmin(request, { superOnly: true });
    if (!admin) return unauthorizedResponse(request);

    const parsed = grantSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const { email, password, note } = parsed.data;

    let user = await prisma.user.findUnique({ where: { email }, select: { id: true, status: true } });
    let created = false;
    if (!user) {
        if (!password) {
            return NextResponse.json(
                { error: 'user_not_found', detail: '该邮箱无账号 —— 传 password 一并创建登录账号' },
                { status: 400 },
            );
        }
        const password_hash = await hash(password, 12);
        const u = await prisma.user.create({
            data: { email, password_hash, email_verified: true, email_verified_at: new Date() },
            select: { id: true, status: true },
        });
        user = u;
        created = true;
    } else if (user.status !== 'active') {
        return NextResponse.json({ error: 'user_disabled', detail: '该账号已停用,先恢复再授予' }, { status: 400 });
    } else if (password) {
        // 已有账号 + 又传了密码:拒绝(改密走 set-password,别在授予里顺手覆盖别人密码)
        return NextResponse.json(
            { error: 'user_exists', detail: '该邮箱已有账号,不能在授予时改密码;直接授予请去掉 password' },
            { status: 409 },
        );
    }

    await prisma.enterpriseAdmin.upsert({
        where: { user_id: user.id },
        create: { user_id: user.id, note: note ?? null, created_by: admin.user?.id ?? null },
        update: { note: note ?? null },
    });
    auditAdminAction(request, admin, 'admin_grant', {
        target: email,
        params: { user_id: user.id, email, note: note ?? null, account_created: created, password: '[redacted]' },
    });
    return NextResponse.json({ ok: true, user_id: user.id, email, account_created: created });
}
