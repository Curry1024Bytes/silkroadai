import { NextRequest, NextResponse } from 'next/server';

/**
 * 工具 — 对话流式代理。转发到 portal 自己的 /v1 代理(localhost:3002),
 * 这样能拿到代理层的 Claude 缓存翻译等;原样 pipe SSE 回浏览器(同源,绕 CORS)。
 * key 仅服务端中转、不保存。无限流。
 */
const SELF = `http://127.0.0.1:${process.env.PORT || 3002}`;

export async function POST(req: NextRequest) {
    const auth = req.headers.get('authorization') || '';
    if (!auth) return NextResponse.json({ error: '缺少 API Key' }, { status: 401 });
    const body = await req.text();
    let up: Response;
    try {
        up = await fetch(`${SELF}/v1/chat/completions`, {
            method: 'POST',
            headers: { Authorization: auth, 'Content-Type': 'application/json' },
            body,
        });
    } catch (e) {
        return NextResponse.json({ error: { message: `代理不可达: ${String(e)}` } }, { status: 502 });
    }
    return new Response(up.body, {
        status: up.status,
        headers: {
            'Content-Type': up.headers.get('content-type') || 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
        },
    });
}
