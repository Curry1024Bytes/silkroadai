import { NextRequest, NextResponse } from 'next/server';

/**
 * 工具 — 异步生图代理。提交立即得到 task_id,之后按 task_id 查询结果。
 * 生图耗时可能超过 Cloudflare 空闲连接时限;底层 /v1 图片任务在服务端继续执行并落库,
 * 页面断线后也能凭同一把 Key 取回结果。Key 仅用于本次请求,不保存。
 */
const SELF = `http://127.0.0.1:${process.env.PORT || 3002}`;

function upstreamResponse(up: Response): NextResponse {
    return new NextResponse(up.body, {
        status: up.status,
        headers: { 'Content-Type': up.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' },
    });
}

export async function POST(req: NextRequest) {
    const auth = req.headers.get('authorization') || '';
    if (!auth) return NextResponse.json({ error: '缺少 API Key' }, { status: 401 });
    const raw = await req.text();
    let isEdit = false;
    try {
        const b = JSON.parse(raw) as { image?: unknown; images?: unknown };
        isEdit = Boolean(b.image || b.images);
    } catch {
        /* 非 JSON 也透传 */
    }
    const path = isEdit ? '/v1/images/edits' : '/v1/images/generations';
    let up: Response;
    try {
        up = await fetch(`${SELF}${path}?async=true`, {
            method: 'POST',
            headers: { Authorization: auth, 'Content-Type': 'application/json' },
            body: raw,
        });
    } catch (e) {
        return NextResponse.json({ error: { message: `代理不可达: ${String(e)}` } }, { status: 502 });
    }
    return upstreamResponse(up);
}

export async function GET(req: NextRequest) {
    const auth = req.headers.get('authorization') || '';
    if (!auth) return NextResponse.json({ error: '缺少 API Key' }, { status: 401 });
    const taskId = req.nextUrl.searchParams.get('task_id') || '';
    if (!/^[0-9a-f]{32}$/.test(taskId)) {
        return NextResponse.json({ error: '无效的任务号' }, { status: 400 });
    }
    try {
        const up = await fetch(`${SELF}/v1/images/tasks/${taskId}`, {
            headers: { Authorization: auth },
            cache: 'no-store',
        });
        return upstreamResponse(up);
    } catch (e) {
        return NextResponse.json({ error: { message: `查询任务失败: ${String(e)}` } }, { status: 502 });
    }
}
