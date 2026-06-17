import { NextRequest } from 'next/server';
import { submitVideo } from '@/lib/seedance/adapter';

// new-api 视频中转实测打这条(/v1/videos);逻辑见 @/lib/seedance/adapter
export async function POST(req: NextRequest) {
    return submitVideo(req);
}
