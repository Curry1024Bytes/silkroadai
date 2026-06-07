/**
 * grant-admin — 给某个邮箱的 user 授予 / 调整后台角色。
 *
 * P1 把单 ADMIN_TOKEN 升级为 User.role(customer/staff/admin/superadmin)。
 * 为避免把任何人的邮箱写进 migration,角色授予走这个独立脚本,由 operator 在
 * 部署后手动跑(典型:给自己授 superadmin)。
 *
 * 用法:
 *   pnpm tsx scripts/grant-admin.ts <email> <role>
 * 例:
 *   pnpm tsx scripts/grant-admin.ts ops@silkroadai.io superadmin
 *
 * role ∈ { customer | staff | admin | superadmin }
 *   - customer    降级 / 撤销后台权限
 *   - staff       ⚠️ P6a 起 /admin console 入口门提到 role ≥ admin(与 /api/admin/* 一致),
 *                 staff 现在【进不了后台 UI】(会重定向到登录)。枚举值保留供将来细分。
 *   - admin       平台管理员 OR 白标 partner 运营(tenantScope 限制只看自己租户)。
 *                 ⭐ P6a partner 运营授 'admin'(不是 staff!)。该 user 的 tenant_id 需 = partner
 *                 租户:让 partner 运营【先在 partner 域名注册】(注册自动归该域名租户),再授 admin。
 *   - superadmin  平台超管(= 现 ADMIN_TOKEN 等价)。租户管理 /admin/tenants 是 superadmin 专属。
 *
 * 读 .env 的 DATABASE_URL。只改 portal 自有 User 表的 role(不改 tenant_id,不碰 new-api)。
 */
import 'dotenv/config';
import { prisma } from '@/lib/db';
import type { UserRole } from '@prisma/client';

const VALID_ROLES = ['customer', 'staff', 'admin', 'superadmin'] as const;

async function main() {
    const emailArg = process.argv[2]?.trim().toLowerCase();
    const roleArg = process.argv[3]?.trim();

    if (!emailArg || !roleArg) {
        console.error('用法: pnpm tsx scripts/grant-admin.ts <email> <role>');
        console.error(`role ∈ { ${VALID_ROLES.join(' | ')} }`);
        process.exit(1);
    }
    if (!(VALID_ROLES as readonly string[]).includes(roleArg)) {
        console.error(`✗ 无效 role: "${roleArg}"。必须是 ${VALID_ROLES.join(' / ')} 之一。`);
        process.exit(1);
    }
    const email = emailArg;
    const role = roleArg as UserRole;

    const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true, role: true },
    });
    if (!user) {
        console.error(`✗ 找不到 email = ${email} 的用户。先确认该邮箱已注册。`);
        process.exit(1);
    }

    if (user.role === role) {
        console.log(`= ${email} 已经是 ${role},无需改动。`);
        return;
    }

    const updated = await prisma.user.update({
        where: { id: user.id },
        data: { role },
        select: { email: true, role: true },
    });
    console.log(`✓ ${updated.email}: ${user.role} → ${updated.role}`);
}

main()
    .catch((err) => {
        console.error('grant-admin 失败:', err);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
