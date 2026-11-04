import { NextRequest } from 'next/server';
import { handleCustomerRequest } from '@/lib/midjourney/customer-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ path: string[] }> };

// 客户 MJ 接口 ai.silkroadai.io/mj/*;逻辑见 @/lib/midjourney/customer-proxy
export async function GET(req: NextRequest, { params }: Ctx) {
    return handleCustomerRequest(req, (await params).path);
}

export async function POST(req: NextRequest, { params }: Ctx) {
    return handleCustomerRequest(req, (await params).path);
}
