/**
 * Light-weight analytics recorder (PR-T3 W7 D5).
 *
 * Replaces Mixpanel / PostHog for the launch. Both server-side
 * (image generate / favorite / delete) and client-side (model
 * selected / image downloaded) flows funnel through `record()` →
 * `prisma.analyticsEvent.create()`. Failures are isolated (try/catch
 * around the call) so an analytics blip doesn't break the user-facing
 * action it's instrumenting.
 *
 * Event types are tightly enumerated — adding a new type here is the
 * one place it has to live, both for the server-side recorder + the
 * `/api/portal/analytics` endpoint's whitelist guard.
 */
import 'server-only';
import { prisma } from '@/lib/db';

export const ANALYTICS_EVENT_TYPES = [
    // Image gen path (server-side fired)
    'image_generated',
    'image_generate_failed',
    'image_rate_limited',
    'image_balance_shortfall',
    'image_content_filter',
    // /image UI path (client-side fired via /api/portal/analytics)
    'model_selected',
    'image_favorited',
    'image_unfavorited',
    'image_downloaded',
    'image_deleted_ui',
    'cost_confirm_shown',
    'cost_confirm_canceled',
] as const;

export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];

const EVENT_TYPE_SET = new Set<string>(ANALYTICS_EVENT_TYPES);

export function isValidEventType(s: unknown): s is AnalyticsEventType {
    return typeof s === 'string' && EVENT_TYPE_SET.has(s);
}

/**
 * Persist one analytics row. Never throws — wrapped in try/catch so
 * the user-facing path doesn't fail if Prisma hiccups. The error is
 * logged + swallowed, which is the correct trade-off for instrumentation.
 *
 * `user_id` is optional: events from logged-out flows (e.g. landing
 * tracking; not used at launch) can omit it.
 */
export async function record(args: {
    userId: string | null;
    eventType: AnalyticsEventType;
    properties: Record<string, unknown>;
}): Promise<void> {
    try {
        await prisma.analyticsEvent.create({
            data: {
                user_id: args.userId,
                event_type: args.eventType,
                properties: args.properties as object,
            },
        });
    } catch (err) {
        // Best-effort — a failed analytics insert MUST NOT break the
        // surrounding business path. Log loudly so ops notices a
        // sustained failure (e.g. table missing, migration drift).
        console.warn(
            `[analytics] insert failed for event=${args.eventType} user=${args.userId ?? '<anon>'}:`,
            err instanceof Error ? err.message : err,
        );
    }
}
