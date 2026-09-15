import { NextRequest, NextResponse } from 'next/server';
import { resolveAdmin } from '@/lib/admin/auth';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { listCostRules, saveCostRules, costRuleSaveSchema } from '@/lib/admin/pricing-cost-store';
import { listCostCapabilities } from '@/lib/admin/pricing-cost-capabilities';
import { readCostBody, costErrorResponse } from '@/lib/admin/pricing-cost-http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    try {
        const [rules, capability] = await Promise.all([listCostRules(admin), listCostCapabilities(admin)]);
        return NextResponse.json({ rules, ...capability });
    } catch (error) {
        return costErrorResponse(error);
    }
}

export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    try {
        const input = costRuleSaveSchema.parse(await readCostBody(request));
        const [rule] = await saveCostRules([input], admin);
        return NextResponse.json({ rule });
    } catch (error) {
        return costErrorResponse(error);
    }
}
