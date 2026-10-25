import 'server-only';
import { prisma } from '@/lib/db';

/** Usage is billing evidence; an absent, zero, fractional or unsafe value is not billable. */
export function taskCompletionTokens(body: Record<string, unknown>): number | null {
    const usage =
        body.usage && typeof body.usage === 'object'
            ? (body.usage as { completion_tokens?: unknown; total_tokens?: unknown })
            : undefined;
    const value = usage?.completion_tokens ?? usage?.total_tokens;
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** A real output can establish generation completion before usage is available. */
export function hasCompletedVideoUrl(body: Record<string, unknown>): boolean {
    const value = typeof body.video_url === 'string' ? body.video_url : body.url;
    if (typeof value !== 'string' || !value.trim()) return false;
    try {
        const url = new URL(value);
        return (url.protocol === 'https:' || url.protocol === 'http:') && !!url.hostname;
    } catch {
        return false;
    }
}

/** Generation terminality and billing readiness are independent. Never revive a failed
 * task or replace previously recorded usage. A competing completion is safe to reuse. */
export async function recordVideoTaskCompletion(taskId: string, tokens: number | null): Promise<boolean> {
    const changed = await prisma.seedanceVideoTask.updateMany({
        where: {
            id: taskId,
            status: { in: ['queued', 'in_progress', 'completed'] },
            billed: false,
            ...(tokens === null ? {} : { tokens: null }),
        },
        data: { status: 'completed', ...(tokens === null ? {} : { tokens: BigInt(tokens) }) },
    });
    if (changed.count > 0) return true;
    const latest = await prisma.seedanceVideoTask.findUnique({ where: { id: taskId }, select: { status: true } });
    return latest?.status === 'completed';
}
