import { NextRequest } from 'next/server';
import { pollVideo } from '@/lib/minimax/adapter';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    return pollVideo(req, id);
}
