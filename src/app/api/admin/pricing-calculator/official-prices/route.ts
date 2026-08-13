import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveAdmin } from '@/lib/admin/auth';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { getLiteLlmPriceCatalog, searchOfficialModelPrices } from '@/lib/admin/litellm-official-prices';

export const runtime = 'nodejs';

const querySchema = z.string().trim().min(1).max(120);

/**
 * GET /api/admin/pricing-calculator/official-prices?q=model-name
 *
 * Read-only reference lookup for the operator calculator. It deliberately
 * returns a narrow search result instead of forwarding LiteLLM's full catalog.
 */
export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const parsed = querySchema.safeParse(new URL(request.url).searchParams.get('q') ?? '');
    if (!parsed.success) return NextResponse.json({ error: 'invalid_query' }, { status: 400 });

    try {
        const catalog = await getLiteLlmPriceCatalog();
        return NextResponse.json(
            {
                query: parsed.data,
                source: catalog.source,
                source_label: catalog.sourceLabel,
                fetched_at: catalog.fetchedAt,
                models: searchOfficialModelPrices(catalog.models, parsed.data),
            },
            { headers: { 'Cache-Control': 'private, no-store' } },
        );
    } catch {
        return NextResponse.json({ error: 'official_price_source_unavailable' }, { status: 503 });
    }
}
