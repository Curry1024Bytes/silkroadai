import { NextRequest, NextResponse } from 'next/server';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope, tenantForInsert } from '@/lib/admin/tenant-scope';
import { prisma } from '@/lib/db';
import { getGroup } from '@/lib/litellm/client';

export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);

    try {
        const channels = await prisma.channel.findMany({
            where: { ...tenantScope(admin) },
            orderBy: { sortOrder: 'asc' },
        });

        // 并发检查每个渠道对应的 Sub2API 分组是否仍然存在
        const results = await Promise.all(
            channels.map(async (channel) => {
                let groupExists = false;
                if (channel.groupId !== null) {
                    try {
                        const group = await getGroup(channel.groupId);
                        groupExists = group !== null;
                    } catch {
                        groupExists = false;
                    }
                }
                return {
                    ...channel,
                    rateMultiplier: Number(channel.rateMultiplier),
                    groupExists,
                };
            }),
        );

        return NextResponse.json({ channels: results });
    } catch (error) {
        console.error('Failed to list channels:', error);
        return NextResponse.json({ error: '获取渠道列表失败' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);

    try {
        const body = await request.json();
        const { group_id, name, platform, rate_multiplier, description, models, features, sort_order, enabled } = body;

        if (!name || !platform || rate_multiplier === undefined) {
            return NextResponse.json({ error: '缺少必填字段: name, platform, rate_multiplier' }, { status: 400 });
        }

        if (typeof name !== 'string' || name.trim() === '') {
            return NextResponse.json({ error: 'name 必须非空' }, { status: 400 });
        }
        if (typeof rate_multiplier !== 'number' || rate_multiplier <= 0) {
            return NextResponse.json({ error: 'rate_multiplier 必须是正数' }, { status: 400 });
        }
        if (sort_order !== undefined && (!Number.isInteger(sort_order) || sort_order < 0)) {
            return NextResponse.json({ error: 'sort_order 必须是非负整数' }, { status: 400 });
        }

        // 验证 group_id 唯一性（仅在提供了 group_id 时）
        if (group_id) {
            const existing = await prisma.channel.findUnique({
                where: { groupId: Number(group_id) },
            });

            if (existing) {
                return NextResponse.json(
                    { error: `分组 ID ${group_id} 已被渠道「${existing.name}」使用` },
                    { status: 409 },
                );
            }
        }

        const channel = await prisma.channel.create({
            data: {
                groupId: group_id ? Number(group_id) : null,
                name,
                platform,
                rateMultiplier: rate_multiplier,
                description: description ?? null,
                models: models ?? null,
                features: features ?? null,
                sortOrder: sort_order ?? 0,
                enabled: enabled ?? true,
                tenant_id: tenantForInsert(admin),
            },
        });

        return NextResponse.json(
            {
                ...channel,
                rateMultiplier: Number(channel.rateMultiplier),
            },
            { status: 201 },
        );
    } catch (error) {
        console.error('Failed to create channel:', error);
        return NextResponse.json({ error: '创建渠道失败' }, { status: 500 });
    }
}
