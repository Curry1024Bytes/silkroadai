import { NextRequest, NextResponse } from 'next/server';

/**
 * Seedance 测试工具 — 提交代理(同源,绕浏览器 CORS)。
 * 客户在工具里填自己的 key → 本路由原样转发到 new-api 视频接口,key 仅服务端中转。
 * 不加任何限流(运营策略),不存任何东西。
 */
const BASE = process.env.NEWAPI_BASE_URL || 'http://localhost:3000';

export async function POST(req: NextRequest) {
    const auth = req.headers.get('authorization') || '';
    if (!auth) return NextResponse.json({ error: '缺少 API Key' }, { status: 401 });
    const body = await req.text();
    try {
        const up = await fetch(`${BASE}/v1/video/generations`, {
            method: 'POST',
            headers: { Authorization: auth, 'Content-Type': 'application/json' },
            body,
        });
        return new NextResponse(await up.text(), {
            status: up.status,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (e) {
        return NextResponse.json({ error: { message: `上游不可达: ${String(e)}` } }, { status: 502 });
    }
}
