/**
 * 模型广场数据代理(2026-10-22)。
 *
 * vendored new-api pricing feature(src/vendor/newapi-web)在浏览器里只打
 * 本路由;这里把白名单内的 new-api **公开**接口在服务端转发出去,new-api 的
 * 主机名不进浏览器。无需 admin token —— 三个端点上游本就匿名可读。
 *
 * 白名单:
 *   GET /api/portal/models/pricing                 → GET {NEWAPI}/api/pricing
 *   GET /api/portal/models/perf-metrics/summary     → GET {NEWAPI}/api/perf-metrics/summary
 *   GET /api/portal/models/perf-metrics             → GET {NEWAPI}/api/perf-metrics
 *
 * 60s 进程内缓存(按完整 query 为 key),new-api 抖动时回 stale(最多 10min)。
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

const NEWAPI_BASE_URL = process.env.NEWAPI_BASE_URL || 'http://localhost:3000';
const ALLOWED = new Set(['pricing', 'perf-metrics/summary', 'perf-metrics']);
const FRESH_MS = 60_000;
const STALE_MAX_MS = 10 * 60_000;
const UPSTREAM_TIMEOUT_MS = 15_000;

interface CacheEntry {
    at: number;
    status: number;
    body: string;
}
const cache = new Map<string, CacheEntry>();

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
    const { path } = await ctx.params;
    const sub = (path ?? []).join('/');
    if (!ALLOWED.has(sub)) {
        return NextResponse.json({ success: false, message: 'not found' }, { status: 404 });
    }
    const upstream = new URL(`/api/${sub}`, NEWAPI_BASE_URL);
    upstream.search = req.nextUrl.search;
    // 2026-10-23 专属倍率:`pricing` 有登录态时以客户身份转发(Authorization + New-Api-User),
    // new-api 会按该用户的 GroupGroupRatio 覆盖返回 group_ratio —— 与 new-api 自家前端同源。
    // 缓存按用户隔离;匿名请求保持原样。其余端点(perf-metrics)与用户无关,不带身份。
    let actAs: { accessToken: string; userId: number } | null = null;
    if (sub === 'pricing') {
        try {
            const user = await getCurrentUser(req);
            if (user?.newapi_user_id != null && user.newapi_access_token) {
                actAs = { accessToken: user.newapi_access_token, userId: user.newapi_user_id };
            }
        } catch (err) {
            console.warn('[models-proxy] session lookup failed, serving anonymous pricing', String(err));
        }
    }
    const key = actAs ? `${upstream.toString()}#u=${actAs.userId}` : upstream.toString();
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < FRESH_MS) {
        return new NextResponse(hit.body, {
            status: hit.status,
            headers: { 'content-type': 'application/json', 'x-silkroadai-cache': 'hit' },
        });
    }
    try {
        const res = await fetch(upstream.toString(), {
            headers: {
                Accept: 'application/json',
                ...(actAs ? { Authorization: actAs.accessToken, 'New-Api-User': String(actAs.userId) } : {}),
            },
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
            cache: 'no-store',
        });
        const body = await res.text();
        if (res.ok) cache.set(key, { at: now, status: res.status, body });
        return new NextResponse(body, {
            status: res.status,
            headers: { 'content-type': 'application/json', 'x-silkroadai-cache': 'miss' },
        });
    } catch (err) {
        if (hit && now - hit.at < STALE_MAX_MS) {
            console.warn('[models-proxy] upstream unreachable, serving stale', { sub, err: String(err) });
            return new NextResponse(hit.body, {
                status: hit.status,
                headers: { 'content-type': 'application/json', 'x-silkroadai-cache': 'stale' },
            });
        }
        console.warn('[models-proxy] upstream unreachable', { sub, err: String(err) });
        return NextResponse.json({ success: false, message: 'upstream unavailable' }, { status: 502 });
    }
}
