import { NextRequest } from 'next/server';
import { handleAdapterRequest } from '@/lib/midjourney/adapter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ path: string[] }> };

// new-api MJ 渠道的 base_url 指向这里;逻辑见 @/lib/midjourney/adapter
export async function GET(req: NextRequest, { params }: Ctx) {
    return handleAdapterRequest(req, (await params).path);
}

export async function POST(req: NextRequest, { params }: Ctx) {
    return handleAdapterRequest(req, (await params).path);
}
