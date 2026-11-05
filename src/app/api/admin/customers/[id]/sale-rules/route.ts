import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { extractClientIP } from '@/lib/auth/extract-ip';
import { checkCustomerSaleRules, loadCustomerSaleRules, presentImpact } from '@/lib/pricing-rules/board';
import { confirmationSchema, saleRuleChangeSchema, saleRuleErrorBody, saveSaleRule } from '@/lib/pricing-rules/service';

export const runtime = 'nodejs';
const noStore = { 'Cache-Control': 'private, no-store' };

const bodySchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('check') }).strict(),
    z
        .object({ action: z.literal('save_rule'), change: saleRuleChangeSchema, confirmation: confirmationSchema })
        .strict(),
]);

function errorResponse(error: unknown) {
    const { body, status } = saleRuleErrorBody(error);
    return NextResponse.json(body, { status, headers: noStore });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);
    try {
        return NextResponse.json(await loadCustomerSaleRules(admin, id), { headers: noStore });
    } catch (error) {
        return errorResponse(error);
    }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);
    const context = {
        admin,
        ip: extractClientIP(request),
        userAgent: request.headers.get('user-agent'),
        path: `/api/admin/customers/${id}/sale-rules`,
    };
    try {
        const body = bodySchema.parse(await request.json());
        if (body.action === 'check')
            return NextResponse.json(await checkCustomerSaleRules(admin, id), { headers: noStore });
        const result = await saveSaleRule(context, body.change, body.confirmation, id);
        return NextResponse.json({ ...result, impact: await presentImpact(result.impact) }, { headers: noStore });
    } catch (error) {
        return errorResponse(error);
    }
}
