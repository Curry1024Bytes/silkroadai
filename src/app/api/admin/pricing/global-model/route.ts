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
    z.object({ action: z.literal('preview'), ...globalModelBaseInputSchema.shape }).strict(),
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
        const { action } = body;
        const payload: Record<string, unknown> = { ...body };
        delete payload.action;
        delete payload.preview_token;
        const input = globalModelBaseInputSchema.parse(payload);
        if (action === 'preview') {
            return NextResponse.json({ preview: await previewGlobalModelPricing(input, admin) }, { headers: noStore });
        }
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
