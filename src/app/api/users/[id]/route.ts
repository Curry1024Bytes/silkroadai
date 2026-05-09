import { NextResponse } from 'next/server';
import { getUser, getCurrentUserByToken } from '@/lib/litellm/client';

// 仅返回用户是否存在，不暴露私隐信息（用户名/邮箱/余额需 token 验证）
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const { searchParams } = new URL(request.url);
    const token = searchParams.get('token')?.trim();
    if (!token) {
        return NextResponse.json({ error: 'token is required' }, { status: 400 });
    }

    let currentUser: { id: number };
    try {
        currentUser = await getCurrentUserByToken(token);
    } catch {
        return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const userId = Number(id);

    if (!Number.isInteger(userId) || userId <= 0) {
        return NextResponse.json({ error: 'Invalid user id' }, { status: 400 });
    }

    // 只允许查询自身用户信息，防止 IDOR 用户枚举
    if (userId !== currentUser.id) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    try {
        const user = await getUser(userId);
        return NextResponse.json({ id: user.id, exists: true });
    } catch (error) {
        if (error instanceof Error && error.message === 'USER_NOT_FOUND') {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }
        console.error('Get user info error:', error);
        return NextResponse.json({ error: 'Get user info failed' }, { status: 500 });
    }
}
