import { assertPricingCatalogWritable, PricingPublishError } from '@/lib/admin/pricing-publish-lock';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope, tenantForInsert } from '@/lib/admin/tenant-scope';
import { Prisma } from '@prisma/client';
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

    const searchParams = request.nextUrl.searchParams;
    const pageValue = Number(searchParams.get('page') || '1');
    const pageSizeValue = Number(searchParams.get('page_size') || '20');
    const page = Number.isFinite(pageValue) ? Math.max(1, Math.trunc(pageValue)) : 1;
    const pageSize = Number.isFinite(pageSizeValue) ? Math.min(100, Math.max(1, Math.trunc(pageSizeValue))) : 20;
    const query = searchParams.get('q')?.trim();
    const vendor = searchParams.get('vendor')?.trim();
    const modality = searchParams.get('modality')?.trim();
    const enabled = searchParams.get('enabled');

    const where: Prisma.CatalogModelWhereInput = { ...tenantScope(admin) };
    if (query) {
        where.OR = [
            { display_name: { contains: query, mode: 'insensitive' } },
            { slug: { contains: query, mode: 'insensitive' } },
        ];
    }
    if (vendor) where.vendor = { contains: vendor, mode: 'insensitive' };
    if (modality && ['chat', 'image', 'embedding'].includes(modality)) where.modality = modality;
    if (enabled === 'true' || enabled === 'false') where.enabled = enabled === 'true';

    const [models, total] = await Promise.all([
        prisma.catalogModel.findMany({
            where,
            orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }, { id: 'asc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
        }),
        prisma.catalogModel.count({ where }),
    ]);
    return NextResponse.json({
        models,
        total,
        page,
        page_size: pageSize,
        total_pages: Math.ceil(total / pageSize),
    });
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

    try {
        return await prisma.$transaction(async (tx) => {
            await assertPricingCatalogWritable(tx);
            // slug 在本租户内唯一(DB 有 @@unique([tenant_id, slug]),这里先友好报错)。
            const tenant_id = tenantForInsert(admin);
            const dup = await tx.catalogModel.findFirst({ where: { tenant_id, slug: data.slug } });
            if (dup) {
                return NextResponse.json({ error: `slug "${data.slug}" 已存在` }, { status: 409 });
            }

            try {
                const topology = await loadChannelGroupTopology(tenant_id, tx);
                const issues = topology.validateUpstreamMap(data.upstream_map as UpstreamMapLike, {
                    allowEmpty: !data.enabled,
                });
                if (issues.length > 0) throw new ChannelGroupTopologyError(tenant_id, issues);
            } catch (error) {
                if (error instanceof ChannelGroupTopologyError) {
                    return NextResponse.json(topologyErrorPayload(error), { status: 409 });
                }
                if (
                    error &&
                    typeof error === 'object' &&
                    'code' in error &&
                    ['P2028', 'P2034'].includes(String(error.code))
                )
                    return NextResponse.json(
                        { error: 'catalog_write_busy', message: '目录正在被修改或等待价格发布，请稍后重试。' },
                        { status: 409 },
                    );
                throw error;
            }

            const model = await tx.catalogModel.create({
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
        });
    } catch (error) {
        if (error instanceof PricingPublishError)
            return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
        if (error && typeof error === 'object' && 'code' in error && ['P2028', 'P2034'].includes(String(error.code)))
            return NextResponse.json(
                { error: 'catalog_write_busy', message: '目录正在被修改或等待价格发布，请稍后重试。' },
                { status: 409 },
            );
        throw error;
    }
}
