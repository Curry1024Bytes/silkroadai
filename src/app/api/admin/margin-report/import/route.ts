import { NextRequest, NextResponse } from 'next/server';
import { resolveAdmin } from '@/lib/admin/auth';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { importMarginCosts, MarginImportConflict, marginImportSchema } from '@/lib/billing/margin-import';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
        return NextResponse.json({ error: 'invalid_invoice' }, { status: 415 });
    }
    if (Number(request.headers.get('content-length')) > 800_000) {
        return NextResponse.json({ error: 'file_too_large' }, { status: 413 });
    }
    const text = await request.text().catch(() => '');
    if (text.length > 800_000) return NextResponse.json({ error: 'file_too_large' }, { status: 413 });
    let payload: unknown;
    try {
        payload = JSON.parse(text);
    } catch {
        return NextResponse.json({ error: 'invalid_invoice' }, { status: 400 });
    }
    const checked = marginImportSchema.safeParse(payload);
    if (!checked.success) {
        return NextResponse.json({ error: 'invalid_invoice', row: checked.error.issues[0]?.path[1] }, { status: 400 });
    }
    try {
        const result = await prisma.$transaction(
            (tx) => importMarginCosts(tx, checked.data.entries, admin.user?.id ?? null),
            { timeout: 15_000 },
        );
        return NextResponse.json(result);
    } catch (error) {
        if (error instanceof MarginImportConflict) return NextResponse.json({ error: error.message }, { status: 409 });
        return NextResponse.json({ error: 'import_unavailable' }, { status: 503 });
    }
}
