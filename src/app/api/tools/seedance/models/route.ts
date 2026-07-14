import { NextRequest, NextResponse } from 'next/server';

/**
 * Seedance 测试工具 — 模型列表(同源)。用客户的 key 拉 /v1/models,
 * 只回该 key 能调的 seedance/dreamina 视频模型(自动按 key 的档位过滤,避免选错档)。
 */
const BASE = process.env.NEWAPI_BASE_URL || 'http://localhost:3000';

export async function GET(req: NextRequest) {
    const auth = req.headers.get('authorization') || '';
    if (!auth) return NextResponse.json({ error: '缺少 API Key' }, { status: 401 });
    let up: Response;
    try {
        up = await fetch(`${BASE}/v1/models`, { headers: { Authorization: auth } });
    } catch (e) {
        return NextResponse.json({ error: { message: `上游不可达: ${String(e)}` } }, { status: 502 });
    }
    const text = await up.text();
    if (!up.ok) return new NextResponse(text, { status: up.status, headers: { 'Content-Type': 'application/json' } });
    let ids: string[] = [];
    try {
        const data = JSON.parse(text) as { data?: Array<{ id?: string }> };
        ids = (data.data || []).map((m) => m.id || '').filter(Boolean);
    } catch {
        return NextResponse.json({ error: { message: '模型列表解析失败' } }, { status: 502 });
    }
    const video = ids.filter((id) => /seedance|dreamina|artsdance/i.test(id)).sort();
    return NextResponse.json({ models: video });
}
