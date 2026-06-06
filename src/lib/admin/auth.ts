import type { NextRequest } from 'next/server';
import type { User, UserRole } from '@prisma/client';
import { getCurrentUser } from '@/lib/auth/session';
import { isBreakGlassToken, AdminUnauthorizedError } from '@/lib/admin-auth';
import { roleAtLeast } from './roles';

/**
 * 解析出的 admin 主体。
 * - session 登录:`user` 非空,`role` / `tenant_id` 取自该 user。
 * - break-glass(ADMIN_TOKEN):`user=null`,等价 superadmin、`tenant_id=null`
 *   (→ tenantScope 返回 `{}`,看全部)。`viaBreakGlass` 便于审计日志区分。
 */
export interface AdminPrincipal {
    user: User | null;
    role: UserRole;
    tenant_id: string | null;
    viaBreakGlass: boolean;
}

/**
 * Session-based admin user:取当前登录 user,role >= staff 才返回,否则 null。
 * 只认 cookie session —— break-glass token 不走这里(那是 {@link resolveAdmin}
 * 的回退)。供 /admin layout 守门 + 登录后跳转判定用。
 */
export async function getAdminUser(req: NextRequest): Promise<User | null> {
    const user = await getCurrentUser(req);
    if (!user) return null;
    return roleAtLeast(user.role, 'staff') ? user : null;
}

/**
 * 解析 admin 主体(非抛出)。守门顺序(设计 §3.1):先试 session role,再回退
 * break-glass ADMIN_TOKEN。都不满足返回 null。`minRole` 默认 staff。
 *
 * break-glass 等价 superadmin,满足任何 `minRole`。
 */
export async function resolveAdmin(req: NextRequest, minRole: UserRole = 'staff'): Promise<AdminPrincipal | null> {
    const user = await getCurrentUser(req);
    if (user && roleAtLeast(user.role, minRole)) {
        return { user, role: user.role, tenant_id: user.tenant_id, viaBreakGlass: false };
    }
    if (isBreakGlassToken(req)) {
        return { user: null, role: 'superadmin', tenant_id: null, viaBreakGlass: true };
    }
    return null;
}

/**
 * 守门:满足 `minRole` 返回 {@link AdminPrincipal},否则抛
 * {@link AdminUnauthorizedError}(复用现有错误类,API 出口转 401)。
 */
export async function requireRole(req: NextRequest, minRole: UserRole): Promise<AdminPrincipal> {
    const admin = await resolveAdmin(req, minRole);
    if (!admin) throw new AdminUnauthorizedError();
    return admin;
}
