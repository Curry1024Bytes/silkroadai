import { NextRequest } from 'next/server';
import { submitVideo } from '@/lib/seedance/adapter';

// 备用路径(若 new-api 某版本用 /v1/video/generations);主路径是 /v1/videos。逻辑见 @/lib/seedance/adapter
export async function POST(req: NextRequest) {
    return submitVideo(req);
}
