import { NextRequest, NextResponse } from 'next/server';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { getAllGroups } from '@/lib/litellm/client';

export async function GET(request: NextRequest) {
    if (!(await resolveAdmin(request, 'superadmin'))) return unauthorizedResponse(request);

    try {
        const groups = await getAllGroups();
        return NextResponse.json({ groups });
    } catch (error) {
        console.error('Failed to fetch Sub2API groups:', error);
        return NextResponse.json({ error: '获取 Sub2API 分组列表失败' }, { status: 500 });
    }
}
