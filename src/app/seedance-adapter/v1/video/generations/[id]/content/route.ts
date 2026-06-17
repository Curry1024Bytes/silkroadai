import { NextRequest } from 'next/server';
import { streamContent } from '@/lib/seedance/adapter';

// 备用路径的内容代理(主路径 /v1/videos/{id}/content)。逻辑见 @/lib/seedance/adapter
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    return streamContent(req, id);
}
