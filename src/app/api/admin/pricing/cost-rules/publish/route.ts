import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { resolveAdmin } from '@/lib/admin/auth';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { pricingCostSelectionsSchema, resolvePricingCostSelection } from '@/lib/admin/pricing-cost-publication-guard';
import { previewPricingBatch, enqueuePricingBatch } from '@/lib/admin/pricing-publish';
import { signCostSelection, verifyCostSelection } from '@/lib/admin/pricing-cost-signature';
import { readCostBody, costErrorResponse } from '@/lib/admin/pricing-cost-http';

export const runtime = 'nodejs';
const bodySchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('preview'), selections: pricingCostSelectionsSchema }).strict(),
    z
        .object({
            action: z.literal('publish'),
            selections: pricingCostSelectionsSchema,
            preview_token: z.string().min(1).max(200),
            selection_token: z.string().length(64),
        })
        .strict(),
]);

export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    try {
        const body = bodySchema.parse(await readCostBody(request));
        const selected = await resolvePricingCostSelection(prisma, body.selections, admin);
        if (body.action === 'preview') {
            const preview = await previewPricingBatch(selected.inputs, admin, selected.context);
            preview.warnings.push(
                preview.publication_mode === 'uniform_token'
                    ? '客户售价不随上下文长度变化。成本按所填上游报价估算；发布核验包含输入、输出和已填写的缓存读取价格。'
                    : preview.publication_mode === 'tiered_token'
                      ? '利润试算按所填基础报价计算，不包含退款、支付手续费及用量差异。发布核验包含下列全部阶梯和缓存读取价格。'
                      : '本次利润为所填上游报价的估算，不包含退款、支付手续费及实际用量差异。缓存价格尚未单独核验；new-api 现有缓存倍率仍按其计费规则生效。',
            );
            return NextResponse.json({
                preview,
                cost_rows: selected.cost_rows,
                selection_token: signCostSelection(admin, selected.context, preview.preview_token),
            });
        }
        verifyCostSelection(admin, selected.context, body.preview_token, body.selection_token);
        const job = await enqueuePricingBatch(selected.inputs, body.preview_token, admin, selected.context);
        return NextResponse.json({ job }, { status: 202 });
    } catch (error) {
        return costErrorResponse(error);
    }
}
