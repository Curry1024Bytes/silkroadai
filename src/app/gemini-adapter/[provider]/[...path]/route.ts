import { NextRequest, NextResponse } from 'next/server';
import { handleGeminiAdapter } from '@/lib/gemini-adapter/adapter';

// new-api Gemini 型(type=24)渠道打 {base_url}/v1beta/models/{model}:{generateContent|streamGenerateContent}
// base_url = http://172.20.0.1:3010/gemini-adapter/<provider>。逻辑见 @/lib/gemini-adapter/adapter。
export async function POST(req: NextRequest, ctx: { params: Promise<{ provider: string; path: string[] }> }) {
    const { provider, path } = await ctx.params;
    // path = ['v1beta', 'models', '{model}:{action}']
    const last = path[path.length - 1] ?? '';
    const idx = last.lastIndexOf(':');
    if (path[0] !== 'v1beta' || path[1] !== 'models' || path.length !== 3 || idx <= 0) {
        return NextResponse.json(
            { error: { code: 404, message: `unsupported path: /${path.join('/')}`, status: 'not_found' } },
            { status: 404 },
        );
    }
    return handleGeminiAdapter(req, provider, decodeURIComponent(last.slice(0, idx)), last.slice(idx + 1));
}
