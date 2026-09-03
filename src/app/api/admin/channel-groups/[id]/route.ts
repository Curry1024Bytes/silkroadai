import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';

export const runtime = 'nodejs';

async function enabledModelReferences(tenantId: string | null, tier: string) {
    const models = await prisma.catalogModel.findMany({
        where: { tenant_id: tenantId, enabled: true },
        select: { id: true, slug: true, upstream_map: true },
    });
    return models.flatMap((model) => {
        const map = model.upstream_map as Record<string, { channel_id?: unknown }>;
        const channelId = map?.[tier]?.channel_id;
        return typeof channelId === 'number' ? [{ id: model.id, slug: model.slug, channel_id: channelId }] : [];
    });
}

// key 是档次标识(NewApiToken.tier 引用它),改了会让已建 key 的档次标签悬空 —
// P3 不允许改 key(要换标识就新建一个档次)。其余字段可改。
const updateSchema = z.object({
    display_name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).nullable().optional(),
    newapi_group: z.string().trim().min(1).max(50).optional(),
    tier_level: z.number().int().min(0).optional(),
    enabled: z.boolean().optional(),
    is_default: z.boolean().optional(),
    newapi_channel_ids: z.array(z.number().int()).optional(),
});

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const { id } = await params;
    const group = await prisma.channelGroup.findFirst({ where: { id, ...tenantScope(admin) } });
    if (!group) return NextResponse.json({ error: '渠道分组不存在' }, { status: 404 });
    return NextResponse.json({ group });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const { id } = await params;
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }

    const existing = await prisma.channelGroup.findFirst({ where: { id, ...tenantScope(admin) } });
    if (!existing) return NextResponse.json({ error: '渠道分组不存在' }, { status: 404 });
    const nextIsDefault = parsed.data.is_default ?? existing.is_default;
    const nextEnabled = parsed.data.enabled ?? existing.enabled;
    if (nextIsDefault && !nextEnabled) {
        return NextResponse.json({ error: 'default_tier_must_be_enabled' }, { status: 409 });
    }
    if (existing.is_default && existing.enabled && !nextIsDefault) {
        return NextResponse.json(
            { error: 'active_default_tier_required', message: '请先将另一档次设为默认档' },
            { status: 409 },
        );
    }
    const nextChannelIds = parsed.data.newapi_channel_ids ?? existing.newapi_channel_ids ?? [];
    if (nextEnabled && nextChannelIds.length === 0) {
        return NextResponse.json({ error: 'active_tier_requires_channels' }, { status: 409 });
    }
    if (nextEnabled) {
        const nextNewApiGroup = parsed.data.newapi_group ?? existing.newapi_group;
        const conflicts = await prisma.channelGroup.findMany({
            where: {
                tenant_id: existing.tenant_id,
                enabled: true,
                NOT: { id: existing.id },
                OR: [{ newapi_group: nextNewApiGroup }, { newapi_channel_ids: { hasSome: nextChannelIds } }],
            },
            select: { key: true, newapi_group: true, newapi_channel_ids: true },
        });
        const groupOwner = conflicts.find((group) => group.newapi_group === nextNewApiGroup);
        if (groupOwner) {
            return NextResponse.json(
                { error: 'newapi_group_already_assigned', newapi_group: nextNewApiGroup, tier: groupOwner.key },
                { status: 409 },
            );
        }
        const overlaps = conflicts.filter((group) =>
            group.newapi_channel_ids.some((id) => nextChannelIds.includes(id)),
        );
        if (overlaps.length > 0) {
            return NextResponse.json(
                {
                    error: 'channel_already_assigned',
                    conflicts: overlaps.map((group) => ({
                        tier: group.key,
                        channel_ids: group.newapi_channel_ids.filter((id) => nextChannelIds.includes(id)),
                    })),
                },
                { status: 409 },
            );
        }
    }

    if (existing.enabled && (!nextEnabled || parsed.data.newapi_channel_ids !== undefined)) {
        const modelRefs = await enabledModelReferences(existing.tenant_id, existing.key);
        const brokenRefs = nextEnabled
            ? modelRefs.filter((ref) => !nextChannelIds.includes(ref.channel_id))
            : modelRefs;
        if (brokenRefs.length > 0) {
            return NextResponse.json(
                {
                    error: 'tier_in_use_by_enabled_models',
                    message: '请先下架或改写引用该档次/渠道的模型',
                    models: brokenRefs,
                },
                { status: 409 },
            );
        }
    }

    // 单一默认档不变式:把本档设为默认时,清掉同租户其它默认。
    const group = await prisma.$transaction(async (tx) => {
        if (parsed.data.is_default === true) {
            await tx.channelGroup.updateMany({
                where: { tenant_id: existing.tenant_id, NOT: { id: existing.id } },
                data: { is_default: false },
            });
        }
        return tx.channelGroup.update({ where: { id: existing.id }, data: parsed.data });
    });
    return NextResponse.json({ group });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const { id } = await params;
    const existing = await prisma.channelGroup.findFirst({ where: { id, ...tenantScope(admin) } });
    if (!existing) return NextResponse.json({ error: '渠道分组不存在' }, { status: 404 });
    if (existing.is_default && existing.enabled) {
        return NextResponse.json(
            { error: 'active_default_tier_required', message: '请先将另一档次设为默认档' },
            { status: 409 },
        );
    }

    const modelRefs = await enabledModelReferences(existing.tenant_id, existing.key);
    if (modelRefs.length > 0) {
        return NextResponse.json(
            {
                error: 'tier_in_use_by_enabled_models',
                message: '请先下架或改写引用该档次的模型',
                models: modelRefs,
            },
            { status: 409 },
        );
    }

    // 已建 token 的 new-api group 已下发、照常工作；但启用模型不得留下悬空
    // upstream_map，所以必须先下架或改写所有活动引用。
    await prisma.channelGroup.delete({ where: { id: existing.id } });
    return NextResponse.json({ success: true });
}
