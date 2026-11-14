import { NextRequest, NextResponse } from 'next/server';
import { resolveAdmin } from '@/lib/admin/auth';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';
const LIMIT = 100;

/** List only jobs that need manual review. Never return credentials or ciphertext. */
export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const rawLimit = Number(request.nextUrl.searchParams.get('limit') ?? LIMIT);
    const take = Number.isInteger(rawLimit) ? Math.min(LIMIT, Math.max(1, rawLimit)) : LIMIT;
    const jobs = await prisma.customerProvisioningJob.findMany({
        where: { status: 'failed', last_error_code: 'pat_outcome_unknown' },
        orderBy: { updated_at: 'desc' },
        take,
        select: {
            id: true,
            user_id: true,
            email: true,
            tier_key: true,
            newapi_group: true,
            status: true,
            attempts: true,
            max_attempts: true,
            last_error_code: true,
            last_error_message: true,
            created_at: true,
            updated_at: true,
            completed_at: true,
            user: { select: { newapi_user_id: true, newapi_username: true } },
        },
    });

    return NextResponse.json({
        jobs: jobs.map((job) => ({
            id: job.id,
            user_id: job.user_id,
            email: job.email,
            tier_key: job.tier_key,
            newapi_group: job.newapi_group,
            status: job.status,
            attempts: job.attempts,
            max_attempts: job.max_attempts,
            last_error_code: job.last_error_code,
            last_error_message: job.last_error_message,
            created_at: job.created_at,
            updated_at: job.updated_at,
            completed_at: job.completed_at,
            newapi_user_id: job.user.newapi_user_id,
            newapi_username: job.user.newapi_username,
        })),
    });
}
