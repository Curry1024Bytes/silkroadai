import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { migrateUserToPortal, rollbackUserToNewapi } from '@/lib/billing/billing-migration';

export const runtime = 'nodejs';

/**
 * POST /api/admin/customers/[id]/billing-mode — P4c-4 灰度翻号(单号、原子、可逆、留痕)。
 *
 * body `{ action: 'to_portal' | 'to_newapi' }`:
 *   - to_portal:newapi → portal,把 new-api quota 快照迁进 ¥账本(migrateUserToPortal)。
 *   - to_newapi:portal → newapi,把当前账本余额折回 new-api quota(rollbackUserToNewapi)。
 *
 * 守门:**superadmin**(平台级计费操作,比 P4c-1 调余额的 admin 更高权)+ tenantScope(IDOR-safe)。
 * 审计:AnalyticsEvent('admin_billing_mode_changed')记 action + 快照(amountCny / backupQuota)+ 操作 admin。
 *
 * ⚠️ CAS 幂等(helper 内):翻进只在 newapi、回滚只在 portal,重复点不双 seed / 双还。
 * ⚠️ 本任务不真翻任何号(operator 在 P4c-5 才用);newapi 客户不受影响。
 */
const schema = z.object({ action: z.enum(['to_portal', 'to_newapi']) });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    // 平台级计费操作 → superadmin（比调余额更高权）。
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const { id } = await params;

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }

    // IDOR 防护:目标客户必须属于本租户。
    const user = await prisma.user.findFirst({ where: { id, ...tenantScope(admin) }, select: { id: true } });
    if (!user) return NextResponse.json({ error: '客户不存在' }, { status: 404 });

    const result =
        parsed.data.action === 'to_portal'
            ? await migrateUserToPortal(user.id, admin.user?.id ?? null)
            : await rollbackUserToNewapi(user.id, admin.user?.id ?? null);

    // 审计流(LedgerEntry migration 是权威账本留痕;这条是 admin 行为审计,best-effort)。
    try {
        await prisma.analyticsEvent.create({
            data: {
                user_id: user.id,
                event_type: 'admin_billing_mode_changed',
                properties: {
                    action: result.action,
                    flipped: result.flipped,
                    amount_cny: result.amountCny,
                    backup_quota: result.backupQuota,
                    new_billing_mode: result.newBillingMode,
                    changed_by: admin.user?.id ?? null,
                    via_break_glass: admin.viaBreakGlass,
                },
            },
        });
    } catch (err) {
        console.warn('[billing-mode] audit event insert failed:', err instanceof Error ? err.message : err);
    }

    return NextResponse.json({ ok: true, ...result }, { status: 200 });
}
