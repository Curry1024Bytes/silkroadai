import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { extractClientIP } from '@/lib/auth/extract-ip';
import { loadSaleRuleBoard, presentConversion, presentImpact, presentPlan } from '@/lib/pricing-rules/board';
import { previewSaleRules } from '@/lib/pricing-rules/publish';
import {
    adoptBillingGroup,
    adoptSchema,
    confirmationSchema,
    publishManually,
    publishSchema,
    saleRuleChangeSchema,
    saleRuleErrorBody,
    saveSaleRule,
    saveUnifiedSaleRatio,
    unifiedRatioSchema,
} from '@/lib/pricing-rules/service';

export const runtime = 'nodejs';
const noStore = { 'Cache-Control': 'private, no-store' };
const PATH = '/api/admin/pricing/sale-rules';

const bodySchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('preview') }).strict(),
    z.object({ action: z.literal('publish'), publish: publishSchema }).strict(),
    z
        .object({ action: z.literal('save_rule'), change: saleRuleChangeSchema, confirmation: confirmationSchema })
        .strict(),
    z.object({ action: z.literal('adopt'), adopt: adoptSchema, confirmation: confirmationSchema }).strict(),
    z
        .object({ action: z.literal('unified_ratio'), unified: unifiedRatioSchema, confirmation: confirmationSchema })
        .strict(),
]);

function errorResponse(error: unknown) {
    const { body, status } = saleRuleErrorBody(error);
    return NextResponse.json(body, { status, headers: noStore });
}

export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    try {
        return NextResponse.json(await loadSaleRuleBoard(admin), { headers: noStore });
    } catch (error) {
        return errorResponse(error);
    }
}

export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    const context = { admin, ip: extractClientIP(request), userAgent: request.headers.get('user-agent'), path: PATH };
    try {
        const body = bodySchema.parse(await request.json());
        switch (body.action) {
            case 'preview':
                return NextResponse.json({ plan: await presentPlan(await previewSaleRules()) }, { headers: noStore });
            case 'publish': {
                const result = await publishManually(context, body.publish);
                return NextResponse.json(
                    {
                        outcome: result.outcome,
                        publication_id: result.publicationId,
                        catalog_rows: result.catalogRows,
                        plan: await presentPlan(result.plan),
                    },
                    { headers: noStore },
                );
            }
            case 'save_rule': {
                const result = await saveSaleRule(context, body.change, body.confirmation);
                return NextResponse.json(
                    { ...result, impact: await presentImpact(result.impact) },
                    { headers: noStore },
                );
            }
            case 'adopt': {
                const result = await adoptBillingGroup(context, body.adopt, body.confirmation);
                return NextResponse.json(
                    {
                        ...result,
                        impact: await presentImpact(result.impact),
                        conversion: await presentConversion(result.conversion),
                    },
                    { headers: noStore },
                );
            }
            case 'unified_ratio': {
                const result = await saveUnifiedSaleRatio(context, body.unified, body.confirmation);
                return NextResponse.json(
                    { ...result, impact: await presentImpact(result.impact) },
                    { headers: noStore },
                );
            }
        }
    } catch (error) {
        return errorResponse(error);
    }
}
