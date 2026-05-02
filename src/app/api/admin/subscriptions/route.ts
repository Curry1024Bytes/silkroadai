import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminToken, unauthorizedResponse } from '@/lib/admin-auth';
import { getUserSubscriptions, getUser, listSubscriptions } from '@/lib/litellm/client';

export async function GET(request: NextRequest) {
  if (!(await verifyAdminToken(request))) return unauthorizedResponse(request);

  try {
    const searchParams = request.nextUrl.searchParams;
    const userId = searchParams.get('user_id');
    const groupId = searchParams.get('group_id');
    const status = searchParams.get('status');
    const page = searchParams.get('page');
    const pageSize = searchParams.get('page_size');

    if (userId) {
      // 按用户查询（原有逻辑）
      const parsedUserId = Number(userId);
      if (!Number.isFinite(parsedUserId) || parsedUserId <= 0) {
        return NextResponse.json({ error: '无效的 user_id' }, { status: 400 });
      }

      const [subscriptions, user] = await Promise.all([
        getUserSubscriptions(parsedUserId),
        getUser(parsedUserId).catch(() => null),
      ]);

      const filtered = groupId ? subscriptions.filter((s) => s.group_id === Number(groupId)) : subscriptions;

      return NextResponse.json({
        subscriptions: filtered,
        user: user ? { id: user.id, username: user.username, email: user.email } : null,
      });
    }

    // 无 user_id 时列出所有订阅
    const result = await listSubscriptions({
      group_id: groupId ? Number(groupId) : undefined,
      status: status || undefined,
      page: page ? Math.max(1, Number(page)) : undefined,
      page_size: pageSize ? Math.min(200, Math.max(1, Number(pageSize))) : undefined,
    });

    return NextResponse.json({
      subscriptions: result.subscriptions,
      total: result.total,
      page: result.page,
      page_size: result.page_size,
      user: null,
    });
  } catch (error) {
    console.error('Failed to query subscriptions:', error);
    return NextResponse.json({ error: '查询订阅信息失败' }, { status: 500 });
  }
}
