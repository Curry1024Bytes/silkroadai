import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCurrentUserByToken } from '@/lib/litellm/client';
import { getGroup } from '@/lib/litellm/client';

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')?.trim();
  if (!token) {
    return NextResponse.json({ error: '缺少 token' }, { status: 401 });
  }

  try {
    await getCurrentUserByToken(token);
  } catch {
    return NextResponse.json({ error: '无效的 token' }, { status: 401 });
  }

  try {
    const channels = await prisma.channel.findMany({
      where: { enabled: true },
      orderBy: { sortOrder: 'asc' },
    });

    // 并发校验每个渠道对应的 Sub2API 分组是否存在（未关联分组的渠道直接展示）
    const results = await Promise.all(
      channels.map(async (ch) => {
        if (ch.groupId !== null) {
          let groupActive = false;
          try {
            const group = await getGroup(ch.groupId);
            groupActive = group !== null && group.status === 'active';
          } catch {
            groupActive = false;
          }

          if (!groupActive) return null; // 过滤掉分组不存在的渠道
        }

        return {
          id: ch.id,
          groupId: ch.groupId,
          name: ch.name,
          platform: ch.platform,
          rateMultiplier: Number(ch.rateMultiplier),
          description: ch.description,
          models: ch.models ? JSON.parse(ch.models) : [],
          features: ch.features ? JSON.parse(ch.features) : [],
          sortOrder: ch.sortOrder,
        };
      }),
    );

    return NextResponse.json({ channels: results.filter(Boolean) });
  } catch (error) {
    console.error('Failed to list channels:', error);
    return NextResponse.json({ error: '获取渠道列表失败' }, { status: 500 });
  }
}
