/**
 * /api/portal/balance-alert-threshold (W6 D2)
 *
 * POST — update the current user's balance alert threshold (CNY).
 *   - Range [0, 1000] integer. 0 disables the alert (scheduler skips users
 *     where threshold = 0 via the WHERE clause).
 *   - Cookie-session auth; user can only update their own row by definition
 *     (we update WHERE id = current user). No id in body → no IDOR surface.
 *   - Returns the persisted value so the client can update its UI without
 *     re-fetching.
 *
 * No GET — the value comes off the session user on /balance render directly,
 * no separate fetch needed.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';

export const runtime = 'nodejs';

const ThresholdSchema = z.object({
    threshold: z
        .number()
        .int({ message: 'threshold must be an integer' })
        .min(0, 'threshold must be ≥ 0')
        .max(1000, 'threshold must be ≤ 1000'),
});

export async function POST(req: NextRequest) {
    const user = await getCurrentUser(req);
    if (!user) {
        return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
    }

    const parsed = ThresholdSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: 'invalid_threshold', details: parsed.error.flatten() }, { status: 400 });
    }

    const { threshold } = parsed.data;

    await prisma.user.update({
        where: { id: user.id },
        data: {
            balance_alert_threshold_cny: new Prisma.Decimal(threshold),
        },
    });

    return NextResponse.json({ threshold });
}
