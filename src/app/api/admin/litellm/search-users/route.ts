import { NextRequest, NextResponse } from 'next/server';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { searchUsers } from '@/lib/litellm/client';

export async function GET(request: NextRequest) {
    if (!(await resolveAdmin(request, 'superadmin'))) return unauthorizedResponse(request);

    const keyword = request.nextUrl.searchParams.get('keyword')?.trim();
    if (!keyword) {
        return NextResponse.json({ users: [] });
    }

    try {
        const users = await searchUsers(keyword);
        return NextResponse.json({ users });
    } catch (error) {
        console.error('Failed to search users:', error instanceof Error ? error.message : String(error));
        return NextResponse.json({ error: '搜索用户失败' }, { status: 500 });
    }
}
