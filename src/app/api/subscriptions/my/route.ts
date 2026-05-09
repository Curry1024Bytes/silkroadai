import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserByToken, getUserSubscriptions, getAllGroups } from '@/lib/litellm/client';

export async function GET(request: NextRequest) {
    const token = request.nextUrl.searchParams.get('token')?.trim();
    if (!token) {
        return NextResponse.json({ error: '缺少 token' }, { status: 401 });
    }

    let userId: number;
    try {
        const user = await getCurrentUserByToken(token);
        userId = user.id;
    } catch {
        return NextResponse.json({ error: '无效的 token' }, { status: 401 });
    }

    try {
        const [subscriptions, groups] = await Promise.all([
            getUserSubscriptions(userId),
            getAllGroups().catch(() => []),
        ]);

        const groupMap = new Map(groups.map((g) => [g.id, g]));

        const enriched = subscriptions.map((sub) => {
            const group = groupMap.get(sub.group_id);
            return {
                ...sub,
                group_name: group?.name ?? null,
                platform: group?.platform ?? null,
            };
        });

        return NextResponse.json({ subscriptions: enriched });
    } catch (error) {
        console.error('Failed to get user subscriptions:', error);
        return NextResponse.json({ error: '获取订阅信息失败' }, { status: 500 });
    }
}
