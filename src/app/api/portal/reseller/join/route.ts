/**
 * POST /api/portal/reseller/join (PR-U1)
 *
 * Idempotent "promote user to reseller" handler. On first call:
 *   - create Reseller row (tier=bronze, status=active, cumulative_gmv=0)
 *   - auto-generate 1 default ResellerInviteCode based on email local part
 *   - settle_method/account/name optional in body (user can fill later on
 *     dashboard); if provided, persisted with the Reseller row
 *
 * Re-call (user already a reseller) → 200 with existing reseller, no-op.
 * Race-safe: the (user_id) unique index on resellers catches a P2002 if
 * two concurrent calls land for the same user; we return the existing row
 * in that branch.
 *
 * Default code generation: take email local part, uppercase, strip non
 * [A-Z0-9-], cap at 12 chars, append `-DEFAULT`. Collision: append `-N`
 * incrementally up to N=10 before giving up (extremely unlikely with the
 * 14-char prefix + appended number).
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getAuthedUserId } from '@/lib/reseller/auth-helper';
import { MAX_CODE_LENGTH } from '@/lib/reseller/code';

export const runtime = 'nodejs';

const JoinSchema = z.object({
    settle_method: z.string().max(32).optional(),
    settle_account: z.string().max(128).optional(),
    settle_name: z.string().max(64).optional(),
});

const DEFAULT_CODE_SUFFIX = '-DEFAULT';
const MAX_DEFAULT_CODE_RETRIES = 10;

/** Derive a candidate code from email local part. Uppercase + strip
 *  non-alphanumeric-or-hyphen + cap at 12 chars before the suffix. */
function deriveDefaultCodeFromEmail(email: string): string {
    const local = email.split('@')[0] ?? '';
    const cleaned = local
        .toUpperCase()
        .replace(/[^A-Z0-9-]/g, '')
        .slice(0, MAX_CODE_LENGTH - DEFAULT_CODE_SUFFIX.length);
    const base = cleaned.length === 0 ? 'USER' : cleaned;
    return `${base}${DEFAULT_CODE_SUFFIX}`;
}

export async function POST(req: NextRequest) {
    const auth = await getAuthedUserId(req);
    if (!auth.ok) return auth.response;
    const { userId } = auth;

    let body: unknown = {};
    if (req.headers.get('content-length') !== '0') {
        try {
            body = await req.json();
        } catch {
            // Empty body is fine — body fields are all optional. Treat
            // unparseable JSON as empty.
            body = {};
        }
    }
    const parsed = JoinSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: 'invalid_input', details: parsed.error.flatten() }, { status: 400 });
    }
    const { settle_method, settle_account, settle_name } = parsed.data;

    // Idempotent: existing reseller → return as-is, no-op.
    const existing = await prisma.reseller.findUnique({ where: { user_id: userId } });
    if (existing) {
        return NextResponse.json({ reseller: existing, created: false }, { status: 200 });
    }

    // Fetch email to derive the default code.
    const userRow = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
    });
    if (!userRow) {
        // Defensive — session valid but user row gone is a corrupted state.
        return NextResponse.json({ error: 'user_not_found' }, { status: 404 });
    }

    // Create reseller + default code in one transaction.
    try {
        const result = await prisma.$transaction(async (tx) => {
            const reseller = await tx.reseller.create({
                data: {
                    user_id: userId,
                    settle_method: settle_method ?? null,
                    settle_account: settle_account ?? null,
                    settle_name: settle_name ?? null,
                },
            });
            // Try the default code; on unique collision, append -N.
            const baseCode = deriveDefaultCodeFromEmail(userRow.email);
            let attempt = 0;
            let defaultCode: { id: string; code: string } | null = null;
            while (attempt <= MAX_DEFAULT_CODE_RETRIES) {
                const candidate = attempt === 0 ? baseCode : `${baseCode.slice(0, MAX_CODE_LENGTH - 2)}-${attempt}`;
                try {
                    const created = await tx.resellerInviteCode.create({
                        data: {
                            reseller_id: reseller.id,
                            code: candidate,
                            label: '默认',
                        },
                        select: { id: true, code: true },
                    });
                    defaultCode = created;
                    break;
                } catch (codeErr) {
                    if (codeErr instanceof Prisma.PrismaClientKnownRequestError && codeErr.code === 'P2002') {
                        attempt++;
                        continue;
                    }
                    throw codeErr;
                }
            }
            return { reseller, defaultCode };
        });

        return NextResponse.json(
            {
                reseller: result.reseller,
                default_code: result.defaultCode,
                created: true,
            },
            { status: 201 },
        );
    } catch (err) {
        // Race: another request created the reseller between our check
        // and tx start. Treat as success — load the actual row.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            const racedReseller = await prisma.reseller.findUnique({ where: { user_id: userId } });
            if (racedReseller) {
                return NextResponse.json({ reseller: racedReseller, created: false }, { status: 200 });
            }
        }
        console.error('[reseller/join] failed', err);
        return NextResponse.json({ error: 'create_failed' }, { status: 500 });
    }
}
