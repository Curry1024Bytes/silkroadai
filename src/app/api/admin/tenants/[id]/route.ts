import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { normalizeHost } from '@/lib/tenant/resolve';

export const runtime = 'nodejs';

const colorRe = /^#[0-9a-fA-F]{6}$/;

function normalizeDomains(domains: string[]): string[] {
    const seen = new Set<string>();
    for (const d of domains) {
        const n = normalizeHost(d);
        if (n) seen.add(n);
    }
    return Array.from(seen);
}

// slug is immutable post-create (stable identifier; platform slug must never change — P6a §5).
const updateSchema = z.object({
    brand_name: z.string().min(1).max(100).optional(),
    primary_domain: z.string().max(253).nullable().optional(),
    domains: z.array(z.string().max(253)).max(20).optional(),
    logo_url: z.string().url().max(500).nullable().optional(),
    primary_color: z.string().regex(colorRe, '需 #RRGGBB 十六进制色值').nullable().optional(),
    support_email: z.string().email().max(254).nullable().optional(),
    support_wechat: z.string().max(64).nullable().optional(),
    signup_enabled: z.boolean().optional(),
    status: z.enum(['active', 'suspended']).optional(),
});

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const { id } = await params;
    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) return NextResponse.json({ error: '租户不存在' }, { status: 404 });
    return NextResponse.json({ tenant });
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
    const existing = await prisma.tenant.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return NextResponse.json({ error: '租户不存在' }, { status: 404 });

    const d = parsed.data;
    const data: Record<string, unknown> = {};
    if (d.brand_name !== undefined) data.brand_name = d.brand_name;
    if (d.primary_domain !== undefined)
        data.primary_domain = d.primary_domain ? normalizeHost(d.primary_domain) || null : null;
    if (d.domains !== undefined) data.domains = normalizeDomains(d.domains);
    if (d.logo_url !== undefined) data.logo_url = d.logo_url;
    if (d.primary_color !== undefined) data.primary_color = d.primary_color;
    if (d.support_email !== undefined) data.support_email = d.support_email;
    if (d.support_wechat !== undefined) data.support_wechat = d.support_wechat;
    if (d.signup_enabled !== undefined) data.signup_enabled = d.signup_enabled;
    if (d.status !== undefined) data.status = d.status;

    const tenant = await prisma.tenant.update({ where: { id }, data });
    return NextResponse.json({ tenant });
}
