import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { parseCatalogBillingDetails } from '@/lib/models/catalog-pricing-details';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const prices = await prisma.catalogPrice.findMany({
            where: {
                billing_details: {
                    not: null as unknown,
                },
            },
            select: {
                id: true,
                tier: true,
                billing_details: true,
            },
            take: 300, // Test all
        });

        const errors: Array<{ id: string; tier: string; error: string; data: unknown }> = [];
        let successCount = 0;

        for (const price of prices) {
            try {
                parseCatalogBillingDetails(price.billing_details);
                successCount++;
            } catch (error) {
                errors.push({
                    id: price.id,
                    tier: price.tier,
                    error: error instanceof Error ? error.message : String(error),
                    data: price.billing_details,
                });
            }
        }

        return NextResponse.json({
            total: prices.length,
            success: successCount,
            failed: errors.length,
            errors: errors.slice(0, 10), // Return first 10 errors
        });
    } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
}
