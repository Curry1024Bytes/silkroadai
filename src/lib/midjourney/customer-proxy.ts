/**
 * Midjourney 对客层:`ai.silkroadai.io/mj/*` → new-api 内置 MJ 中继(见 adapter.ts 文件头)。
 *
 * 鉴权 / 计费 / 任务归属全在 new-api,这里只把任务查询响应里的 `videoUrls` 还原成客户文档
 * 约定的 `imageUrls`(适配器借 videoUrls 把四张单图存进 new-api)。其余路径纯透传。
 */
import { NextRequest, NextResponse } from 'next/server';
import { forwardHeaders, passthroughResponse } from '@/lib/proxy/forward';

const NEWAPI_BASE_URL = process.env.NEWAPI_BASE_URL || 'http://localhost:3000';

/** new-api 提交上游给 60s;留出它自身的处理余量。 */
const NEWAPI_TIMEOUT_MS = 120_000;

const TASK_QUERY_PATH = /^\/mj\/task\/(?:[^/]+\/fetch|list-by-condition)$/;

function toCustomerTask(task: unknown): unknown {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return task;
    const t = task as Record<string, unknown>;
    if (!('id' in t)) return task; // new-api 错误体 {code, description}
    const carried = Array.isArray(t.videoUrls) ? (t.videoUrls as Array<{ url?: string }>) : [];
    const urls = carried.map((v) => v?.url).filter((u): u is string => !!u);
    return {
        ...t,
        imageUrls: urls.length ? urls.map((url) => ({ url, thumbnailUrl: url })) : null,
        videoUrls: null,
    };
}

export async function handleCustomerRequest(req: NextRequest, segments: string[]): Promise<NextResponse> {
    const path = `/mj/${segments.join('/')}`;
    const upstream = await fetch(`${NEWAPI_BASE_URL}${path}${req.nextUrl.search}`, {
        method: req.method,
        headers: forwardHeaders(req),
        body: req.method === 'GET' ? undefined : await req.arrayBuffer(),
        signal: AbortSignal.timeout(NEWAPI_TIMEOUT_MS),
    });
    if (!upstream.ok || !TASK_QUERY_PATH.test(path)) return passthroughResponse(upstream);

    const text = await upstream.text();
    let payload: unknown;
    try {
        payload = JSON.parse(text);
    } catch {
        return new NextResponse(text, { status: upstream.status });
    }
    return NextResponse.json(Array.isArray(payload) ? payload.map(toCustomerTask) : toCustomerTask(payload));
}
