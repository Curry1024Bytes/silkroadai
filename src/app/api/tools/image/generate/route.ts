import { NextRequest, NextResponse } from 'next/server';

/**
 * 工具 — 生图代理。转发到 portal 自己的 /v1 代理(localhost:3002),拿到代理层
 * 的 Gemini 生图翻译 / 自定义 OSS 等。body 含 image → 走 /v1/images/edits(图生图),
 * 否则 /v1/images/generations(文生图)。key 仅服务端中转、不保存。无限流。
 */
const SELF = `http://127.0.0.1:${process.env.PORT || 3002}`;

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
        up = await fetch(`${SELF}${path}`, {
            method: 'POST',
            headers: { Authorization: auth, 'Content-Type': 'application/json' },
            body: raw,
        });
    } catch (e) {
        return NextResponse.json({ error: { message: `代理不可达: ${String(e)}` } }, { status: 502 });
    }
    return new NextResponse(await up.text(), {
        status: up.status,
        headers: { 'Content-Type': 'application/json' },
    });
}
