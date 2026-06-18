import { NextRequest } from 'next/server';
import { submitVideo } from '@/lib/seedance/reverse-adapter';

// new-api 视频中转打这条(/v1/videos);逻辑见 @/lib/seedance/reverse-adapter
export async function POST(req: NextRequest) {
    return submitVideo(req);
}
