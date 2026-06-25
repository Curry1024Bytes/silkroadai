import { NextRequest, NextResponse } from 'next/server';
import { categorizeByType, HIDDEN_MODELS } from '@/lib/models/categorize';

// 工具 — 生图模型列表(用客户 key 拉 /v1/models,只回 image-gen 类)。
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
        const d = JSON.parse(text) as { data?: Array<{ id?: string }> };
        ids = (d.data || []).map((m) => m.id || '').filter(Boolean);
    } catch {
        return NextResponse.json({ error: { message: '模型列表解析失败' } }, { status: 502 });
    }
    const img = ids
        .filter((id) => !HIDDEN_MODELS.has(id))
        .filter((id) => categorizeByType(id) === 'image-gen')
        .sort();
    return NextResponse.json({ models: img });
}
