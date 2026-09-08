/**
 * 企业运营后台守门 + 管理员操作审计(2026-09-04)。
 *
 * 背景:/enterprise-admin 此前 superadmin-only。放开给次级管理员时【不动全局 UserRole】——
 * staff/admin role 会连带解锁主站 /admin(getAdminUser 收 staff+),权限外溢。
 * 次级管理员 = enterprise_admins 表有行的 User(role 仍是 customer),只对企业运营后台生效。
 *
 * 等级:
 *  - super     = 全局 superadmin session 或 break-glass ADMIN_TOKEN(全权,含 授予/撤销
 *                次级管理员 + 查看审计日志)
 *  - secondary = enterprise_admins 有行(后台日常操作全开,但看不到审计日志/管理员管理)
 *
 * 审计:每个【成功的写操作】调 auditAdminAction 落 admin_audit_logs 一行。
 * fire-and-forget(任何失败只 warn,绝不影响操作本身);params 脱敏(password/key/
 * secret/token 字段值 → [redacted])+ 8KB 截断。superadmin 的操作同样记(对称,可自查)。
 */
import 'server-only';
import type { NextRequest } from 'next/server';
import type { User } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { isBreakGlassToken } from '@/lib/admin-auth';
import { roleAtLeast } from '@/lib/admin/roles';

export type EnterpriseAdminLevel = 'super' | 'secondary';

export interface EnterpriseAdminPrincipal {
    user: User | null; // break-glass → null
    level: EnterpriseAdminLevel;
    viaBreakGlass: boolean;
}

/**
 * 解析企业运营后台管理员。opts.superOnly = 该端点仍限 superadmin
 * (授予/撤销管理员、审计日志、请求日志导出等监督面)。
 */
export async function resolveEnterpriseAdmin(
    req: NextRequest,
    opts?: { superOnly?: boolean },
): Promise<EnterpriseAdminPrincipal | null> {
    const user = await getCurrentUser(req);
    if (user && roleAtLeast(user.role, 'superadmin')) {
        return { user, level: 'super', viaBreakGlass: false };
    }
    if (isBreakGlassToken(req)) {
        return { user: null, level: 'super', viaBreakGlass: true };
    }
    if (opts?.superOnly) return null;
    if (user && user.status === 'active') {
        const row = await prisma.enterpriseAdmin.findUnique({ where: { user_id: user.id } });
        if (row) return { user, level: 'secondary', viaBreakGlass: false };
    }
    return null;
}

/** server component(layout/页面)用:从当前请求 cookie 解析管理员;非管理员 → null。 */
export async function resolveEnterpriseAdminFromCookies(): Promise<EnterpriseAdminPrincipal | null> {
    const { headers } = await import('next/headers');
    const { NextRequest } = await import('next/server');
    const h = await headers();
    const req = new NextRequest('http://internal/enterprise-admin', {
        method: 'GET',
        headers: { cookie: h.get('cookie') || '' },
    });
    return resolveEnterpriseAdmin(req);
}

// ── 审计 ──

const MAX_PARAMS_BYTES = 8 * 1024;
const SENSITIVE_KEY = /password|secret|token|(^|_)key($|_)|upstream_key/i;

/** 深走对象,敏感字段值替换 [redacted](上游 key / 客户新密码等绝不落审计表)。 */
export function redactAuditParams(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(redactAuditParams);
    if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            out[k] = SENSITIVE_KEY.test(k) && typeof val === 'string' && val ? '[redacted]' : redactAuditParams(val);
        }
        return out;
    }
    return v;
}

export interface AuditInfo {
    /** 目标标识(客户 user_id / key id / email …),列表页直接可筛。 */
    target?: string | null;
    /** 入参(已 zod 校验的对象最好)—— 落库前自动脱敏 + 截断。 */
    params?: unknown;
}

/**
 * 落一行审计。fire-and-forget:任何失败(含同步异常)只 warn,绝不抛。
 * 只在【写操作成功后】调用 —— 审计表记的是「做成了什么」,不是尝试。
 */
export function auditAdminAction(
    req: NextRequest,
    admin: EnterpriseAdminPrincipal,
    action: string,
    info?: AuditInfo,
): void {
    void (async () => {
        try {
            let params: string | null = null;
            if (info?.params !== undefined) {
                const s = JSON.stringify(redactAuditParams(info.params));
                params = s.length > MAX_PARAMS_BYTES ? s.slice(0, MAX_PARAMS_BYTES) + '…[truncated]' : s;
            }
            const fwd = req.headers.get('x-forwarded-for');
            await prisma.adminAuditLog.create({
                data: {
                    admin_user_id: admin.user?.id ?? null,
                    admin_email: admin.user?.email ?? null,
                    level: admin.viaBreakGlass ? 'break_glass' : admin.level,
                    action,
                    method: req.method,
                    path: req.nextUrl.pathname.slice(0, 256),
                    target: info?.target?.slice(0, 256) ?? null,
                    params,
                    client_ip: fwd ? fwd.split(',')[0].trim().slice(0, 64) : null,
                    user_agent: req.headers.get('user-agent')?.slice(0, 256) ?? null,
                },
            });
        } catch (e) {
            console.warn('[enterprise-admin-audit] write failed', { action, err: String(e) });
        }
    })().catch((e) => console.warn('[enterprise-admin-audit] write failed(outer)', String(e)));
}
