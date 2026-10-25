/** Model plaza: Portal-authored tariffs and allowlisted, read-only performance metadata. */
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { loadPlazaData } from '@/lib/models/plaza-data';
import { loadBrowserCatalog } from '@/lib/models/catalog-browser';
import {
    filterPlazaPerformance,
    filterPlazaPerformanceSummary,
    loadPlazaPerformanceGroups,
} from '@/lib/models/plaza-performance';

export const dynamic = 'force-dynamic';
const ALLOWED = new Set(['pricing', 'perf-metrics/summary', 'perf-metrics']);
const performanceCache = new Map<string, { at: number; data: unknown }>();
const FRESH_MS = 60_000;
const STALE_MAX_MS = 10 * 60_000;

async function performance(url: URL) {
    const key = url.toString();
    const now = Date.now();
    const hit = performanceCache.get(key);
    if (hit && now - hit.at < FRESH_MS) return { data: hit.data, cache: 'hit' };
    try {
        const response = await fetch(url, {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
            signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error('Performance upstream unavailable');
        const data: unknown = await response.json();
        if (!data || typeof data !== 'object' || !('success' in data) || data.success !== true)
            throw new Error('Invalid performance envelope');
        if (performanceCache.size >= 500) performanceCache.clear();
        performanceCache.set(key, { at: now, data });
        return { data, cache: 'miss' };
    } catch (error) {
        if (hit && now - hit.at < STALE_MAX_MS) return { data: hit.data, cache: 'stale' };
        throw error;
    }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
    const { path } = await ctx.params;
    const sub = (path ?? []).join('/');
    if (!ALLOWED.has(sub)) return NextResponse.json({ success: false, message: 'not found' }, { status: 404 });
    if (sub === 'pricing') {
        try {
            // Identity and dedicated-price failures must not silently become anonymous prices.
            const user = await getCurrentUser(req);
            return NextResponse.json(await loadPlazaData(user), { headers: { 'Cache-Control': 'private, no-store' } });
        } catch {
            return NextResponse.json(
                { success: false, message: '当前无法获取模型清单与价格，请稍后重试。' },
                {
                    status: 503,
                    headers: { 'Cache-Control': 'private, no-store' },
                },
            );
        }
    }
    const hours = req.nextUrl.searchParams.get('hours') ?? '24';
    if (!/^\d+$/.test(hours) || Number(hours) < 1 || Number(hours) > 168)
        return NextResponse.json({ success: false, message: 'invalid hours' }, { status: 400 });
    try {
        const catalog = await loadBrowserCatalog();
        const visible = new Map(catalog.models.map((model) => [model.slug, model]));
        const url = new URL(`/api/${sub}`, process.env.NEWAPI_BASE_URL || 'http://localhost:3000');
        url.searchParams.set('hours', hours);
        if (sub === 'perf-metrics') {
            const name = req.nextUrl.searchParams.get('model');
            const model = name ? visible.get(name) : undefined;
            if (!model) return NextResponse.json({ success: false, message: 'not found' }, { status: 404 });
            url.searchParams.set('model', model.slug);
            const groups = await loadPlazaPerformanceGroups(catalog);
            const result = await performance(url);
            return NextResponse.json(filterPlazaPerformance(result.data, model, groups), {
                headers: { 'Cache-Control': 'no-store', 'x-silkroadai-cache': result.cache },
            });
        }
        const requested = req.nextUrl.searchParams.getAll('recent_model');
        if (requested.length > 20)
            return NextResponse.json({ success: false, message: 'too many models' }, { status: 400 });
        const names = [...new Set(requested.length ? requested : [...visible.keys()].slice(0, 20))].filter((name) =>
            visible.has(name),
        );
        if (!names.length)
            return NextResponse.json(
                { success: true, data: { models: [], recent_success_series: {} } },
                { headers: { 'Cache-Control': 'no-store' } },
            );
        for (const name of names) url.searchParams.append('recent_model', name);
        const result = await performance(url);
        return NextResponse.json(filterPlazaPerformanceSummary(result.data, new Set(names)), {
            headers: { 'Cache-Control': 'no-store', 'x-silkroadai-cache': result.cache },
        });
    } catch {
        return NextResponse.json(
            { success: false, message: '暂无可核验的运行数据' },
            { status: 502, headers: { 'Cache-Control': 'no-store' } },
        );
    }
}
