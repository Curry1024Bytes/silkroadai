import { NextRequest } from 'next/server';
import { submitVideo } from '@/lib/seedance/reverse-adapter';

// 备用路径(/v1/video/generations);逻辑见 @/lib/seedance/reverse-adapter
export async function POST(req: NextRequest) {
    return submitVideo(req);
}
