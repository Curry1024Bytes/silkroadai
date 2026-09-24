import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { extractClientIP } from '@/lib/auth/extract-ip';
import { pricingPublishErrorResponse } from '@/lib/admin/pricing-publish';
import { basePriceSchema, SimplePricingError } from '@/lib/admin/pricing-simple-core';
import {
    loadSimplePricing,
    previewModel,
    previewTier,
    resyncCatalog,
    saveModel,
    saveTier,
    verifyRuntime,
} from '@/lib/admin/pricing-simple';

export const runtime = 'nodejs';
const noStore = { 'Cache-Control': 'private, no-store' };

const modelName = z.string().trim().min(1).max(200);
const ratio = z.number().finite().positive().max(1000);

const bodySchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('preview_tier'), group_id: z.string().uuid(), ratio }).strict(),
    z
        .object({
            action: z.literal('save_tier'),
            group_id: z.string().uuid(),
            ratio,
            expected_ratio: ratio.nullable(),
        })
        .strict(),
    z.object({ action: z.literal('preview_model'), model: modelName, base: basePriceSchema }).strict(),
    z
        .object({
            action: z.literal('save_model'),
            model: modelName,
            base: basePriceSchema,
            expected_state: z.string().min(1).max(200_000),
        })
        .strict(),
    z.object({ action: z.literal('resync_catalog') }).strict(),
    z.object({ action: z.literal('verify_runtime'), models: z.array(modelName).min(1).max(30) }).strict(),
]);

function errorResponse(error: unknown) {
    if (error instanceof z.ZodError)
        return NextResponse.json(
            { error: 'invalid_input', message: error.issues[0]?.message ?? '价格格式无效。' },
            { status: 400, headers: noStore },
        );
    if (error instanceof SimplePricingError)
        return NextResponse.json(
            { error: error.code, message: error.message },
            { status: error.status, headers: noStore },
        );
    const response = pricingPublishErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status, headers: noStore });
}

export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    try {
        return NextResponse.json(await loadSimplePricing(admin), { headers: noStore });
    } catch (error) {
        return errorResponse(error);
    }
}

export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    const context = { admin, ip: extractClientIP(request), userAgent: request.headers.get('user-agent') };
    try {
        const body = bodySchema.parse(await request.json());
        switch (body.action) {
            case 'preview_tier':
                return NextResponse.json(
                    { preview: await previewTier(admin, body.group_id, body.ratio) },
                    { headers: noStore },
                );
            case 'save_tier':
                return NextResponse.json(
                    { result: await saveTier(context, body.group_id, body.ratio, body.expected_ratio) },
                    { headers: noStore },
                );
            case 'preview_model':
                return NextResponse.json(
                    { preview: await previewModel(admin, body.model, body.base) },
                    { headers: noStore },
                );
            case 'save_model':
                return NextResponse.json(
                    { result: await saveModel(context, body.model, body.base, body.expected_state) },
                    { headers: noStore },
                );
            case 'resync_catalog':
                return NextResponse.json({ result: await resyncCatalog(context) }, { headers: noStore });
            case 'verify_runtime':
                return NextResponse.json({ check: await verifyRuntime(body.models) }, { headers: noStore });
        }
    } catch (error) {
        return errorResponse(error);
    }
}
