import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import {
    enqueueGlobalModelPricing,
    previewGlobalModelPricing,
    pricingPublishErrorResponse,
    readPublishSource,
    readPublishState,
} from '@/lib/admin/pricing-publish';
import { globalModelBaseInputSchema } from '@/lib/admin/global-model-pricing-types';
import { listGlobalModelPrices } from '@/lib/admin/global-model-pricing';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';
const noStore = { 'Cache-Control': 'private, no-store' };

const bodySchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('preview'), model_id: z.string().uuid() }).strict(),
    z
        .object({
            action: z.literal('publish'),
            preview_token: z.string().min(1).max(200),
            ...globalModelBaseInputSchema.shape,
        })
        .strict(),
]);

export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    try {
        const [state, source] = await Promise.all([readPublishState(prisma), readPublishSource()]);
        return NextResponse.json(
            { models: listGlobalModelPrices(state, source, admin.tenant_id) },
            { headers: noStore },
        );
    } catch (error) {
        const response = pricingPublishErrorResponse(error);
        return NextResponse.json(response.body, { status: response.status, headers: noStore });
    }
}

export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    try {
        const body = bodySchema.parse(await request.json());
        if (body.action === 'preview') {
            return NextResponse.json(
                { preview: await previewGlobalModelPricing({ model_id: body.model_id }, admin) },
                { headers: noStore },
            );
        }
        const input = globalModelBaseInputSchema.parse({
            model_id: body.model_id,
            base_input_cny_per_1m: body.base_input_cny_per_1m,
            base_output_cny_per_1m: body.base_output_cny_per_1m,
            base_per_image_cny: body.base_per_image_cny,
            base_cache_read_cny_per_1m: body.base_cache_read_cny_per_1m,
            base_cache_write_cny_per_1m: body.base_cache_write_cny_per_1m,
            base_cache_write_1h_cny_per_1m: body.base_cache_write_1h_cny_per_1m,
            official_quote: body.official_quote,
        });
        return NextResponse.json(
            { job: await enqueueGlobalModelPricing(input, body.preview_token, admin) },
            { status: 202, headers: noStore },
        );
    } catch (error) {
        if (error instanceof z.ZodError)
            return NextResponse.json(
                { error: 'invalid_input', message: error.issues[0]?.message ?? '官方基础价格式无效。' },
                { status: 400, headers: noStore },
            );
        const response = pricingPublishErrorResponse(error);
        return NextResponse.json(response.body, { status: response.status, headers: noStore });
    }
}
