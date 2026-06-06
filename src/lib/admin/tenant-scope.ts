import type { UserRole } from '@prisma/client';

/**
 * 平台主体租户的固定 UUID。
 *
 * ⚠️ 必须与 prisma/migrations/20260606125813_add_user_role_and_tenant 里 INSERT
 * 的值【完全一致】。所有现存数据在该 migration 内回填到这一行;非 superadmin
 * 的 admin 查询都被 tenantScope() 收敛到这个 id(或其自身 tenant_id)。
 */
export const PLATFORM_TENANT_ID = '00000000-0000-0000-0000-000000000001';
export const PLATFORM_TENANT_SLUG = 'silkroadai';

/**
 * 给定 admin,返回应施加到 Prisma `where` 的 tenant 过滤条件。
 *
 * - superadmin            → `{}`(不过滤,看全部)。
 * - admin / staff         → `{ tenant_id: admin.tenant_id ?? PLATFORM_TENANT_ID }`
 *   —— 强制只看自己租户的数据(P6 白标隔离的核心地基)。
 * - tenant_id 为 null     → 视为平台主体(回退到 PLATFORM_TENANT_ID)。
 *
 * ── 用法约定(后续阶段强制遵守,review 时当硬性 checklist)──
 * 所有 admin 数据查询【必须】把 `tenantScope(admin)` spread 进 Prisma `where`,
 * 且仅用于【已有 tenant_id 列】的模型。P1 已加列的模型 = users / orders /
 * channels / subscription_plans / payment_provider_instances。其余模型在各自
 * 阶段(P2 catalog、P4 ledger/usage…)加 tenant_id 列后再接入本 helper。
 *
 * ── P1 现状 ──
 * 唯一被授予的角色是 superadmin(operator,见 scripts/grant-admin.ts),因此
 * tenantScope 实际恒返回 `{}` —— spread 进任何查询都是 no-op,行为与改造前
 * 完全一致(回归应全绿)。staff / admin 的真实租户收敛在 P6 白标上线、真有
 * partner 数据进来时才生效。
 */
export function tenantScope(admin: { role: UserRole; tenant_id: string | null }): { tenant_id?: string } {
    if (admin.role === 'superadmin') return {};
    return { tenant_id: admin.tenant_id ?? PLATFORM_TENANT_ID };
}

/**
 * 新建行应打的 `tenant_id`。session admin 用自己的 tenant_id;break-glass /
 * tenant_id 为 null → 平台主体。P1 只有 superadmin(其 tenant_id 已回填为平台
 * 主体),故恒为 PLATFORM_TENANT_ID —— 新建的 channel / plan / provider 都归主体。
 */
export function tenantForInsert(admin: { tenant_id: string | null }): string {
    return admin.tenant_id ?? PLATFORM_TENANT_ID;
}
