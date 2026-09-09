import { NextRequest } from 'next/server';
import { handleAdapter25Image } from '@/lib/image-adapter25/adapter';

// new-api OpenAI 型渠道打 {base_url}/v1/images/edits(multipart);gpt-image-2.5 独立适配器,逻辑见 @/lib/image-adapter25/adapter
export async function POST(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
    const { provider } = await ctx.params;
    return handleAdapter25Image(req, 'edits', provider);
}
