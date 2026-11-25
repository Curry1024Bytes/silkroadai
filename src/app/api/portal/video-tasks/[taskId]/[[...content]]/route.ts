import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { customerVideoDisplay, readCustomerVideoTasks, streamCustomerVideo } from '@/lib/customer-video-tasks';

export const runtime = 'nodejs';

async function handle(req: NextRequest, context: { params: Promise<{ taskId: string; content?: string[] }> }) {
    const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' };
    const user = await getCurrentUser(req);
    if (!user || user.status !== 'active')
        return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401, headers });
    const { taskId, content = [] } = await context.params;
    if (
        !/^task_[A-Za-z0-9]{32}$/.test(taskId) ||
        content.length > 1 ||
        (content.length === 1 && content[0] !== 'content')
    )
        return NextResponse.json({ error: 'invalid_params' }, { status: 400, headers });
    if (!user.newapi_user_id) return NextResponse.json({ error: 'video_not_found' }, { status: 404, headers });
    try {
        const task = (await readCustomerVideoTasks(user.newapi_user_id, [taskId])).get(taskId);
        if (!task) return NextResponse.json({ error: 'video_not_found' }, { status: 404, headers });
        if (content.length) return streamCustomerVideo(req, task, taskId);
        if (req.method === 'HEAD') return new NextResponse(null, { headers });
        return NextResponse.json({ task: await customerVideoDisplay(task) }, { headers });
    } catch {
        return NextResponse.json({ error: 'video_lookup_unavailable' }, { status: 503, headers });
    }
}

export const GET = handle;
export const HEAD = handle;
