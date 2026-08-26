import { NextRequest } from 'next/server';
import { streamContent } from '@/lib/minimax/adapter';

// new-api result_url 内容代理回抓这里(渠道 base_url 走内网)。逻辑见 @/lib/minimax/adapter
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    return streamContent(req, id);
}
