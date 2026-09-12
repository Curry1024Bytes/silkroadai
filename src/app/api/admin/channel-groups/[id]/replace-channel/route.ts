import { PricingPublishError } from '@/lib/admin/pricing-publish-lock';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope } from '@/lib/admin/tenant-scope';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { getChannel, listChannels } from '@/lib/newapi/client';
import {
    applyChannelReplacement,
    buildChannelReplacement,
    ChannelReplacementError,
    replacementChannel,
} from '@/lib/admin/channel-replacement';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Context) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    const { id } = await params;
    const group = await prisma.channelGroup.findFirst({ where: { id, ...tenantScope(admin) } });
    if (!group) return NextResponse.json({ error: 'group_not_found', message: '渠道分组不存在。' }, { status: 404 });
    const owners = await prisma.channelGroup.findMany({
        where: { tenant_id: group.tenant_id, enabled: true },
        select: { key: true, newapi_channel_ids: true },
    });
    try {
        const channels = (await listChannels()).map((channel) =>
            replacementChannel(
                channel,
                owners.find((owner) => owner.newapi_channel_ids.includes(channel.id))?.key ?? null,
            ),
        );
        return NextResponse.json({
            group: {
                id: group.id,
                key: group.key,
                display_name: group.display_name,
                newapi_group: group.newapi_group,
                newapi_channel_ids: group.newapi_channel_ids,
                enabled: group.enabled,
            },
            channels,
        });
    } catch {
        return NextResponse.json(
            { error: 'channels_unavailable', message: '无法读取 new-api 渠道列表，请检查连接后重试。' },
            { status: 502 },
        );
    }
}

const schema = z
    .object({
        source_channel_id: z.number().int().positive(),
        target_channel_id: z.number().int().positive(),
        preview_token: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
    })
    .strict();

export async function POST(request: NextRequest, { params }: Context) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
        return NextResponse.json({ error: 'invalid_input', message: '请选择原渠道和新渠道。' }, { status: 400 });
    const apply = request.nextUrl.searchParams.get('dryRun') === 'false';
    if (apply && !parsed.data.preview_token) {
        return NextResponse.json(
            { error: 'preview_required', message: '请先预览受影响的模型，再确认替换。' },
            { status: 400 },
        );
    }
    const { id } = await params;
    const group = await prisma.channelGroup.findFirst({ where: { id, ...tenantScope(admin) } });
    if (!group) return NextResponse.json({ error: 'group_not_found', message: '渠道分组不存在。' }, { status: 404 });
    let target;
    try {
        target = replacementChannel(await getChannel(parsed.data.target_channel_id));
        if (target.id !== parsed.data.target_channel_id) throw new Error('channel id mismatch');
    } catch {
        return NextResponse.json(
            { error: 'target_unavailable', message: '无法读取新渠道，请确认它仍存在且 new-api 连接正常。' },
            { status: 502 },
        );
    }
    try {
        const preview = apply
            ? await applyChannelReplacement({
                  groupId: id,
                  tenantId: group.tenant_id,
                  sourceId: parsed.data.source_channel_id,
                  target,
                  previewToken: parsed.data.preview_token!,
              })
            : (await buildChannelReplacement(prisma, id, group.tenant_id, parsed.data.source_channel_id, target))
                  .preview;
        return NextResponse.json({ dryRun: !apply, preview });
    } catch (error) {
        if (error instanceof PricingPublishError)
            return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
        if (error instanceof ChannelReplacementError) {
            return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
        }
        if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            ['P2028', 'P2034', 'P2025'].includes(String(error.code))
        ) {
            return NextResponse.json(
                { error: 'preview_stale', message: '配置正在被修改，请重新预览后再确认替换。' },
                { status: 409 },
            );
        }
        // Do not echo new-api payloads or DB errors to the browser.
        return NextResponse.json(
            { error: 'replacement_failed', message: '替换未完成，已回滚本次修改。请刷新预览后重试。' },
            { status: 500 },
        );
    }
}
