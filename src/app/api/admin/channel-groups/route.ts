import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope, tenantForInsert } from '@/lib/admin/tenant-scope';
import { generateChannelGroupKey } from '@/lib/channel-group-key';

export const runtime = 'nodejs';

const createSchema = z.object({
    key: z.preprocess(
        (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
        z
            .string()
            .trim()
            .max(50, '最多 50 个字符')
            .regex(/^[a-z0-9-]+$/, '只能使用小写字母、数字和连字符；也可以留空自动生成')
            .optional(),
    ),
    display_name: z.string().trim().min(1, '请填写显示名').max(100, '最多 100 个字符'),
    description: z.string().max(500).nullable().optional(),
    newapi_group: z.string().trim().min(1, '请填写 new-api 分组名').max(50, '最多 50 个字符'),
    tier_level: z.number().int().min(0).optional().default(0),
    enabled: z.boolean().optional().default(false),
    is_default: z.boolean().optional().default(false),
    newapi_channel_ids: z.array(z.number().int().positive()).optional().default([]),
});

export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const groups = await prisma.channelGroup.findMany({
        where: { ...tenantScope(admin) },
        orderBy: [{ tier_level: 'asc' }, { created_at: 'asc' }],
    });
    return NextResponse.json({ groups });
}

export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const data = parsed.data;
    const tenant_id = tenantForInsert(admin);
    if (data.is_default && !data.enabled) {
        return NextResponse.json({ error: 'default_tier_must_be_enabled' }, { status: 400 });
    }
    if (data.enabled && data.newapi_channel_ids.length === 0) {
        return NextResponse.json({ error: 'active_tier_requires_channels' }, { status: 400 });
    }

    if (data.key) {
        const dup = await prisma.channelGroup.findFirst({ where: { tenant_id, key: data.key } });
        if (dup) {
            return NextResponse.json({ error: `档次 key "${data.key}" 已存在` }, { status: 409 });
        }
    }
    if (data.enabled) {
        const conflicts = await prisma.channelGroup.findMany({
            where: {
                tenant_id,
                enabled: true,
                OR: [{ newapi_group: data.newapi_group }, { newapi_channel_ids: { hasSome: data.newapi_channel_ids } }],
            },
            select: { key: true, newapi_group: true, newapi_channel_ids: true },
        });
        const groupOwner = conflicts.find((group) => group.newapi_group === data.newapi_group);
        if (groupOwner) {
            return NextResponse.json(
                { error: 'newapi_group_already_assigned', newapi_group: data.newapi_group, tier: groupOwner.key },
                { status: 409 },
            );
        }
        const overlaps = conflicts.filter((group) =>
            group.newapi_channel_ids.some((id) => data.newapi_channel_ids.includes(id)),
        );
        if (overlaps.length > 0) {
            return NextResponse.json(
                {
                    error: 'channel_already_assigned',
                    conflicts: overlaps.map((group) => ({
                        tier: group.key,
                        channel_ids: group.newapi_channel_ids.filter((id) => data.newapi_channel_ids.includes(id)),
                    })),
                },
                { status: 409 },
            );
        }
    }

    // Retry only generated-key collisions: another process may have created the same
    // candidate since our read. Each failed transaction also rolls back default changes.
    for (let attempt = 0; attempt < 3; attempt++) {
        let key = data.key;
        if (!key) {
            const rows = await prisma.channelGroup.findMany({ where: { tenant_id }, select: { key: true } });
            key = generateChannelGroupKey(
                data.newapi_group,
                rows.map((row) => row.key),
            );
        }
        try {
            // 单一默认档不变式:设新档为默认时,先清掉本租户其它默认。
            const group = await prisma.$transaction(async (tx) => {
                if (data.is_default) {
                    await tx.channelGroup.updateMany({ where: { tenant_id }, data: { is_default: false } });
                }
                return tx.channelGroup.create({ data: { tenant_id, ...data, key } });
            });
            return NextResponse.json({ group }, { status: 201 });
        } catch (error) {
            if (!isKeyConflict(error)) throw error;
            if (data.key) {
                return NextResponse.json({ error: `档次 key "${data.key}" 已存在` }, { status: 409 });
            }
        }
    }
    return NextResponse.json({ error: 'tier_key_conflict' }, { status: 409 });
}

function isKeyConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'P2002') return false;
    if (!('meta' in error) || !error.meta || typeof error.meta !== 'object' || !('target' in error.meta)) return false;
    const target = error.meta.target;
    return Array.isArray(target)
        ? target.includes('key')
        : typeof target === 'string' && target === 'channel_groups_tenant_id_key_key';
}
