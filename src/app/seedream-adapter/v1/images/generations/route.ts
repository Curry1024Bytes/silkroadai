import { NextRequest } from 'next/server';
import { handleSeedreamImage } from '@/lib/seedream/adapter';

// new-api OpenAI 型渠道(pass_through_body_enabled)打 {base_url}/v1/images/generations;逻辑见 @/lib/seedream/adapter
export async function POST(req: NextRequest) {
    return handleSeedreamImage(req);
}
