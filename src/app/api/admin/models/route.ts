import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope, tenantForInsert } from '@/lib/admin/tenant-scope';
import {
    ChannelGroupTopologyError,
    loadChannelGroupTopology,
    topologyErrorPayload,
    type UpstreamMapLike,
} from '@/lib/channel-group-topology';

export const runtime = 'nodejs';

// upstream_map: { [tier]: { channel_id, upstream_model } }. tier and channel
// ownership are checked against the tenant's active ChannelGroup topology.
const upstreamMapSchema = z.record(
    z.string().min(1),
    z.object({
        channel_id: z.number().int(),
        upstream_model: z.string().min(1),
    }),
);

const createModelSchema = z.object({
    slug: z
        .string()
        .min(1)
        .max(100)
        .transform((s) => s.trim()),
    display_name: z.string().min(1).max(100),
    vendor: z.string().min(1).max(50),
    modality: z.enum(['chat', 'image', 'embedding']).default('chat'),
    context_window: z.number().int().positive().nullable().optional(),
    enabled: z.boolean().optional().default(true),
    sort_order: z.number().int().min(0).optional().default(0),
    upstream_map: upstreamMapSchema.default({}),
});

export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const models = await prisma.catalogModel.findMany({
        where: { ...tenantScope(admin) },
        orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
    });
    return NextResponse.json({ models });
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
    const parsed = createModelSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const data = parsed.data;

    // slug 在本租户内唯一(DB 有 @@unique([tenant_id, slug]),这里先友好报错)。
    const tenant_id = tenantForInsert(admin);
    const dup = await prisma.catalogModel.findFirst({ where: { tenant_id, slug: data.slug } });
    if (dup) {
        return NextResponse.json({ error: `slug "${data.slug}" 已存在` }, { status: 409 });
    }

    try {
        const topology = await loadChannelGroupTopology(tenant_id);
        const issues = topology.validateUpstreamMap(data.upstream_map as UpstreamMapLike, {
            allowEmpty: !data.enabled,
        });
        if (issues.length > 0) throw new ChannelGroupTopologyError(tenant_id, issues);
    } catch (error) {
        if (error instanceof ChannelGroupTopologyError) {
            return NextResponse.json(topologyErrorPayload(error), { status: 409 });
        }
        throw error;
    }

    const model = await prisma.catalogModel.create({
        data: {
            tenant_id,
            slug: data.slug,
            display_name: data.display_name,
            vendor: data.vendor,
            modality: data.modality,
            context_window: data.context_window ?? null,
            enabled: data.enabled,
            sort_order: data.sort_order,
            upstream_map: data.upstream_map,
        },
    });
    return NextResponse.json({ model }, { status: 201 });
}
