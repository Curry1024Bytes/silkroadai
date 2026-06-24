import { NextRequest, NextResponse } from 'next/server';

// Seedance 测试工具 — 轮询代理(同源)。转发到 new-api 视频任务查询。
const BASE = process.env.NEWAPI_BASE_URL || 'http://localhost:3000';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const auth = req.headers.get('authorization') || '';
    if (!auth) return NextResponse.json({ error: '缺少 API Key' }, { status: 401 });
    const { id } = await ctx.params;
    try {
        const up = await fetch(`${BASE}/v1/video/generations/${encodeURIComponent(id)}`, {
            headers: { Authorization: auth },
        });
        return new NextResponse(await up.text(), {
            status: up.status,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (e) {
        return NextResponse.json({ error: { message: `上游不可达: ${String(e)}` } }, { status: 502 });
    }
}
