import type { UserRole } from '@prisma/client';

/**
 * 角色特权序:customer < staff < admin < superadmin。
 *
 * 单独成文件(零运行时依赖,只引 @prisma/client 类型)以避免 admin-auth.ts ↔
 * admin/auth.ts 之间形成循环引用 —— 两者都从这里取 roleAtLeast。
 */
export const ROLE_ORDER: Record<UserRole, number> = {
    customer: 0,
    staff: 1,
    admin: 2,
    superadmin: 3,
};

/** `role` 在特权序里 >= `min` 时为 true。 */
export function roleAtLeast(role: UserRole, min: UserRole): boolean {
    return ROLE_ORDER[role] >= ROLE_ORDER[min];
}
