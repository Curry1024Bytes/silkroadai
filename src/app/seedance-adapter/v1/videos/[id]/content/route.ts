import { NextRequest } from 'next/server';
import { streamContent } from '@/lib/seedance/adapter';

// new-api result_url 内容代理回抓这里(渠道 base_url 走公网 443)。逻辑见 @/lib/seedance/adapter
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    return streamContent(req, id);
}
