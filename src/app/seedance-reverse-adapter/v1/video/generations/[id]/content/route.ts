import { NextRequest } from 'next/server';
import { streamContent } from '@/lib/seedance/reverse-adapter';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    return streamContent(req, id);
}
