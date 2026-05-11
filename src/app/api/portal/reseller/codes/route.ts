/**
 * /api/portal/reseller/codes (PR-U1)
 *
 * GET  — list all codes (active + inactive) for the current user's reseller,
 *        including per-code attribution count + total GMV (computed via
 *        join from User.inviter_code_id grouped count + sum of
 *        ResellerCommission.attributed_gmv).
 *
 * POST — create a new code for the current user's reseller.
 *        Body: { code: string, label?: string }
 *        Validation:
 *          - format/length via validateAndNormalizeCode (3-20 chars, [A-Z0-9-])
 *          - env-collision (must not be in INVITE_CODES env)
 *          - per-reseller cap: MAX_CODES_PER_RESELLER (10) active codes
 *          - DB-level unique on `code` column (race-safe)
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getAuthedReseller } from '@/lib/reseller/auth-helper';
import { validateAndNormalizeCode, MAX_CODES_PER_RESELLER, MAX_CODE_LENGTH } from '@/lib/reseller/code';

export const runtime = 'nodejs';

const CreateSchema = z.object({
    code: z.string().min(3).max(MAX_CODE_LENGTH),
    label: z.string().max(64).optional(),
});

export async function GET(req: NextRequest) {
    const auth = await getAuthedReseller(req);
    if (!auth.ok) return auth.response;
    const { ctx } = auth;

    const codes = await prisma.resellerInviteCode.findMany({
        where: { reseller_id: ctx.reseller.id },
        orderBy: { created_at: 'asc' },
    });

    // For each code: attribution count (Users with inviter_code_id = code.id)
    // + sum of attributed_gmv across all commission rows. Done in two parallel
    // groupBys to avoid N+1.
    const [attributionCounts, gmvSums] = await Promise.all([
        prisma.user.groupBy({
            by: ['inviter_code_id'],
            where: { inviter_code_id: { in: codes.map((c) => c.id) } },
            _count: { _all: true },
        }),
        // gmv sum is bound to commissions, not user rows — but a code's
        // gmv is just "sum of attributed_gmv across that code's customers'
        // commissions". Cheap groupBy via inviter_code_id ON User join is
        // not directly expressible in Prisma; we do a sub-query:
        //   1. find user_ids attributed to each code
        //   2. sum commission.attributed_gmv by user_id
        //   3. roll up by inviter_code_id in JS
        // For launch scale (resellers with < 100 customers each) this is fine.
        // If a single reseller hits 1k+ attributed users, refactor to a raw SQL
        // groupBy join.
        prisma.user.findMany({
            where: { inviter_code_id: { in: codes.map((c) => c.id) } },
            select: {
                inviter_code_id: true,
                reseller_commissions_as_customer: {
                    select: { attributed_gmv: true },
                },
            },
        }),
    ]);

    const countByCode = new Map<string, number>();
    for (const row of attributionCounts) {
        if (row.inviter_code_id) countByCode.set(row.inviter_code_id, row._count._all);
    }
    const gmvByCode = new Map<string, number>();
    for (const u of gmvSums) {
        if (!u.inviter_code_id) continue;
        const sum = u.reseller_commissions_as_customer.reduce((acc, c) => acc + Number(c.attributed_gmv), 0);
        gmvByCode.set(u.inviter_code_id, (gmvByCode.get(u.inviter_code_id) ?? 0) + sum);
    }

    return NextResponse.json({
        codes: codes.map((c) => ({
            id: c.id,
            code: c.code,
            label: c.label,
            is_active: c.is_active,
            attributed_user_count: countByCode.get(c.id) ?? 0,
            total_attributed_gmv_cny: gmvByCode.get(c.id) ?? 0,
            created_at: c.created_at.toISOString(),
        })),
    });
}

export async function POST(req: NextRequest) {
    const auth = await getAuthedReseller(req);
    if (!auth.ok) return auth.response;
    const { ctx } = auth;

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
    }
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: 'invalid_input', details: parsed.error.flatten() }, { status: 400 });
    }
    const { code, label } = parsed.data;

    // Normalize + env-collision check.
    const valid = validateAndNormalizeCode(code);
    if (!valid.ok || !valid.code) {
        return NextResponse.json({ error: valid.error ?? 'invalid_code', message: valid.message }, { status: 400 });
    }
    const normalized = valid.code;

    // Per-reseller cap on active codes (brief: max 10 active per reseller).
    const activeCount = await prisma.resellerInviteCode.count({
        where: { reseller_id: ctx.reseller.id, is_active: true },
    });
    if (activeCount >= MAX_CODES_PER_RESELLER) {
        return NextResponse.json(
            {
                error: 'max_codes_reached',
                message: `已达到最多 ${MAX_CODES_PER_RESELLER} 个活跃邀请码上限,请先删除不用的码`,
            },
            { status: 400 },
        );
    }

    try {
        const created = await prisma.resellerInviteCode.create({
            data: {
                reseller_id: ctx.reseller.id,
                code: normalized,
                label: label ?? null,
            },
        });
        return NextResponse.json(
            {
                id: created.id,
                code: created.code,
                label: created.label,
                is_active: created.is_active,
                created_at: created.created_at.toISOString(),
            },
            { status: 201 },
        );
    } catch (err) {
        // DB-level unique collision: another reseller (or this reseller)
        // already has this code.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            return NextResponse.json({ error: 'code_taken', message: '该邀请码已被使用,请换一个' }, { status: 409 });
        }
        console.error('[reseller/codes POST] failed', err);
        return NextResponse.json({ error: 'create_failed' }, { status: 500 });
    }
}
