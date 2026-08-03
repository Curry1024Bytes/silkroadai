import { NextRequest } from 'next/server';
import { handleAdapterImage } from '@/lib/image-adapter/adapter';

// new-api OpenAI 型渠道打 {base_url}/v1/images/generations;逻辑见 @/lib/image-adapter/adapter
export async function POST(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
    const { provider } = await ctx.params;
    return handleAdapterImage(req, 'generations', provider);
}
