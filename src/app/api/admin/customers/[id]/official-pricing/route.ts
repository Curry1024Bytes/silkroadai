import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { loadOfficialContext, publicOfficialView } from '@/lib/customer-pricing/context';
import { CustomerPricingError } from '@/lib/customer-pricing/math';
import { compileCustomerPreview } from '@/lib/customer-pricing/preview';
import { officialReferenceSchema, saveOfficialReference } from '@/lib/customer-pricing/reference';
import { saveCustomerOfficialPricing } from '@/lib/customer-pricing/service';
import { recoverCustomerOfficialPricing } from '@/lib/customer-pricing/recovery';
import type { OfficialPricingDraft } from '@/lib/customer-pricing/types';

export const runtime = 'nodejs';
const noStore = { 'Cache-Control': 'private, no-store' };
const draftFields = {
    tier_key: z.string().trim().min(1).max(100),
    model_id: z.string().uuid().nullable().optional(),
    model_ids: z.array(z.string().uuid()).min(1).optional(),
    official_multiplier: z.number().finite().positive().max(100).nullable(),
};
const schema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('recover'), change_id: z.string().uuid() }).strict(),
    z.object({ action: z.literal('preview'), ...draftFields }).strict(),
    z
        .object({
            action: z.literal('save'),
            ...draftFields,
            expected_version: z.string().min(1),
            preview_hash: z.string().min(1),
            confirm_below_cost: z.boolean().optional(),
            confirm_increases: z.boolean().optional(),
        })
        .strict(),
    officialReferenceSchema.strict(),
]);

async function customerFor(req: NextRequest, id: string) {
    const admin = await resolveAdmin(req, 'admin');
    if (!admin) return { admin: null, customer: null };
    const customer = await prisma.user.findFirst({ where: { id, ...tenantScope(admin) }, select: { id: true } });
    return { admin, customer };
}

function failure(error: unknown) {
    if (error instanceof CustomerPricingError)
        return NextResponse.json(
            { error: error.code, message: error.message },
            { status: error.status, headers: noStore },
        );
    console.error('[customer-official-pricing] operation failed', {
        kind: error instanceof Error ? error.name : 'unknown',
    });
    return NextResponse.json(
        { error: 'customer_pricing_unavailable', message: '客户定价核验暂不可用，请刷新后重试。' },
        { status: 503, headers: noStore },
    );
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    const { admin, customer } = await customerFor(req, id);
    if (!admin) return unauthorizedResponse(req);
    if (!customer) return NextResponse.json({ error: '客户不存在。' }, { status: 404 });
    try {
        const [context, pending_changes] = await Promise.all([
            loadOfficialContext(id),
            prisma.customerPricingChange.findMany({
                where: { user_id: id, status: { in: ['preparing', 'applying', 'failed'] } },
                select: { id: true, tier_key: true, status: true },
                orderBy: { created_at: 'asc' },
            }),
        ]);
        return NextResponse.json({ ...publicOfficialView(context), pending_changes }, { headers: noStore });
    } catch (error) {
        return failure(error);
    }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    const { admin, customer } = await customerFor(req, id);
    if (!admin) return unauthorizedResponse(req);
    if (!customer) return NextResponse.json({ error: '客户不存在。' }, { status: 404 });
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success)
        return NextResponse.json(
            { error: 'invalid_request', message: '请填写有效的分组、模型和官方价倍率。' },
            { status: 400 },
        );
    try {
        const input = parsed.data;
        if (input.action === 'recover')
            return NextResponse.json(
                {
                    ok: true,
                    result: await recoverCustomerOfficialPricing({
                        userId: id,
                        changeId: input.change_id,
                        actorId: admin.user?.id ?? null,
                    }),
                },
                { headers: noStore },
            );
        if (input.action === 'reference')
            return NextResponse.json(
                { ok: true, view: await saveOfficialReference(id, admin.user?.id ?? null, input) },
                { headers: noStore },
            );
        const { model_id, model_ids, tier_key, official_multiplier } = input;
        let draft: OfficialPricingDraft;
        if (model_ids !== undefined && model_id === undefined) draft = { tier_key, official_multiplier, model_ids };
        else if (model_id !== undefined && model_ids === undefined) draft = { tier_key, official_multiplier, model_id };
        else throw new CustomerPricingError('invalid_model_selection', '请选择要设置的型号或整个分组。', 400);
        if (input.action === 'preview') {
            const [context, count] = await Promise.all([
                loadOfficialContext(id),
                prisma.newApiToken.count({ where: { user_id: id, tier: input.tier_key, status: 'active' } }),
            ]);
            return NextResponse.json(
                { preview: compileCustomerPreview(context, draft, count).preview },
                { headers: noStore },
            );
        }
        const result = await saveCustomerOfficialPricing({
            userId: id,
            actorId: admin.user?.id ?? null,
            draft,
            expectedVersion: input.expected_version,
            previewHash: input.preview_hash,
            confirmBelowCost: input.confirm_below_cost === true,
            confirmIncreases: input.confirm_increases === true,
        });
        return NextResponse.json({ ok: true, result }, { headers: noStore });
    } catch (error) {
        return failure(error);
    }
}
