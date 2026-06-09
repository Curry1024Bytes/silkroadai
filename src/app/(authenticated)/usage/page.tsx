/**
 * /usage — merged into the unified /dashboard console (客户控制台三合一).
 *
 * Usage summary, the model-consumption chart, the per-model breakdown, and
 * the per-call detail table all live on /dashboard now (period tabs drive
 * them). This route is kept as a 307 redirect (the default for `redirect()`
 * during render) so existing bookmarks / links / docs don't 404. The
 * `?period=` querystring is forwarded so a bookmarked window lands on the
 * same window in the merged console.
 */
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function UsagePage({
    searchParams,
}: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<never> {
    const params = (await searchParams) ?? {};
    const raw = params.period;
    const period = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;
    redirect(period ? `/dashboard?period=${encodeURIComponent(period)}` : '/dashboard');
}
