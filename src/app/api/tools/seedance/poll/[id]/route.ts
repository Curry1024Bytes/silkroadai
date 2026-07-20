import { NextRequest, NextResponse } from 'next/server';

import { PORTAL_SELF_V1_BASE } from '@/lib/seedance/tools-proxy-base';

// Seedance 测试工具 — 轮询代理(同源)。转发到【portal /v1 代理】(seedance-cn 任务的
// 轮询扣费在代理层,见 tools-proxy-base.ts;非 cn 任务代理透传 new-api,行为不变)。
const BASE = PORTAL_SELF_V1_BASE;

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
