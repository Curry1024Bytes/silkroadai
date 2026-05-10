/**
 * POST /api/portal/analytics — client-side event ingest (PR-T3).
 *
 * Lightweight: cookie auth → whitelist event_type → INSERT row.
 * Body shape:
 *   { event_type: string, properties: Record<string, unknown> }
 *
 * Failure mode: any 4xx/5xx from this endpoint MUST NOT break the
 * caller — analytics is best-effort. The client-side recorder
 * silently catches errors. Never returns user data; just `{ ok: true }`
 * or a generic error code.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/lib/auth/session';
import { ANALYTICS_EVENT_TYPES, isValidEventType, record } from '@/lib/analytics/recorder';

export const runtime = 'nodejs';

const BodySchema = z.object({
    event_type: z.enum(ANALYTICS_EVENT_TYPES as unknown as [string, ...string[]]),
    properties: z.record(z.string(), z.unknown()).optional().default({}),
});

const PROPERTIES_MAX_SIZE_BYTES = 4_000;

export async function POST(req: NextRequest): Promise<NextResponse> {
    const user = await getCurrentUser(req);
    if (!user) {
        // Unauth analytics rejected. Logged-out tracking isn't used at
        // launch; if it is later, swap to allow null user_id here.
        return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const { event_type, properties } = parsed.data;
    if (!isValidEventType(event_type)) {
        // Defensive — zod's enum already gates this, but the typed
        // guard makes the code shape clearer.
        return NextResponse.json({ error: 'invalid_event_type' }, { status: 400 });
    }

    // Cap properties size at ~4KB so a buggy client can't shove huge
    // payloads. Reject silently (200 ok=false) so it doesn't affect
    // user-facing flow.
    const serialized = JSON.stringify(properties);
    if (serialized.length > PROPERTIES_MAX_SIZE_BYTES) {
        return NextResponse.json({ ok: false, dropped: 'properties_too_large' }, { status: 200 });
    }

    await record({
        userId: user.id,
        eventType: event_type,
        properties,
    });

    return NextResponse.json({ ok: true });
}
