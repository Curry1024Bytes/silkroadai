import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { prisma } from '@/lib/db';

const updateChannelSchema = z.object({
    group_id: z.number().int().positive().nullable().optional(),
    name: z.string().min(1).max(100).optional(),
    platform: z.string().min(1).max(50).optional(),
    rate_multiplier: z.number().positive().optional(),
    description: z.string().max(500).nullable().optional(),
    models: z
        .union([z.array(z.string()), z.string()])
        .nullable()
        .optional(),
    features: z
        .union([z.record(z.string(), z.unknown()), z.string()])
        .nullable()
        .optional(),
    sort_order: z.number().int().min(0).optional(),
    enabled: z.boolean().optional(),
});

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);

    try {
        const { id } = await params;
        const rawBody = await request.json();
        const parsed = updateChannelSchema.safeParse(rawBody);
        if (!parsed.success) {
            return NextResponse.json({ error: '参数校验失败' }, { status: 400 });
        }
        const body = parsed.data;

        const existing = await prisma.channel.findFirst({ where: { id, ...tenantScope(admin) } });
        if (!existing) {
            return NextResponse.json({ error: '渠道不存在' }, { status: 404 });
        }

        // 如果更新了 group_id，检查唯一性
        if (body.group_id !== undefined && body.group_id !== null && Number(body.group_id) !== existing.groupId) {
            const conflict = await prisma.channel.findUnique({
                where: { groupId: Number(body.group_id) },
            });
            if (conflict) {
                return NextResponse.json(
                    { error: `分组 ID ${body.group_id} 已被渠道「${conflict.name}」使用` },
                    { status: 409 },
                );
            }
        }

        const data: Record<string, unknown> = {};
        if (body.group_id !== undefined) data.groupId = body.group_id;
        if (body.name !== undefined) data.name = body.name;
        if (body.platform !== undefined) data.platform = body.platform;
        if (body.rate_multiplier !== undefined) data.rateMultiplier = body.rate_multiplier;
        if (body.description !== undefined) data.description = body.description;
        if (body.models !== undefined) data.models = body.models;
        if (body.features !== undefined) data.features = body.features;
        if (body.sort_order !== undefined) data.sortOrder = body.sort_order;
        if (body.enabled !== undefined) data.enabled = body.enabled;

        const channel = await prisma.channel.update({
            where: { id },
            data,
        });

        return NextResponse.json({
            ...channel,
            rateMultiplier: Number(channel.rateMultiplier),
        });
    } catch (error) {
        console.error('Failed to update channel:', error);
        return NextResponse.json({ error: '更新渠道失败' }, { status: 500 });
    }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'admin');
    if (!admin) return unauthorizedResponse(request);

    try {
        const { id } = await params;

        const existing = await prisma.channel.findFirst({ where: { id, ...tenantScope(admin) } });
        if (!existing) {
            return NextResponse.json({ error: '渠道不存在' }, { status: 404 });
        }

        await prisma.channel.delete({ where: { id } });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Failed to delete channel:', error);
        return NextResponse.json({ error: '删除渠道失败' }, { status: 500 });
    }
}
