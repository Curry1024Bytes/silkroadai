import { NextRequest, NextResponse } from 'next/server';
import { resolveAdmin } from '@/lib/admin/auth';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { saveCostRules, costRuleBulkSchema } from '@/lib/admin/pricing-cost-store';
import { readCostBody, costErrorResponse } from '@/lib/admin/pricing-cost-http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    try {
        const input = costRuleBulkSchema.parse(await readCostBody(request));
        return NextResponse.json({ rules: await saveCostRules(input.rules, admin) });
    } catch (error) {
        return costErrorResponse(error);
    }
}
