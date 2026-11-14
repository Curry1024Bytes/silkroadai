import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';

import { resolveAdmin } from '@/lib/admin/auth';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { prisma } from '@/lib/db';
import { decryptCustomerProvisioningPassword } from '@/lib/auth/customer-provisioning-secret';
import {
    customerProvisioningUsername,
    getTokenForCustomer,
    getTokenKey,
    getTokenRevocationCustomerIdentity,
    getUser,
} from '@/lib/newapi/client';

export const runtime = 'nodejs';

const resolveSchema = z
    .object({
        action: z.enum(['link_existing', 'retry_after_confirmed_absent', 'keep_failed']),
        // The access token is accepted only to verify an already-existing
        // remote record. It is never returned or logged by this API.
        newapi_user_id: z.number().int().positive().optional(),
        newapi_access_token: z.string().trim().min(1).max(4096).optional(),
        newapi_token_id: z.number().int().positive().optional(),
    })
    .strict();

function redactError(error: unknown): NextResponse {
    // Error messages from ORM/network failures can contain request arguments.
    // Record only the error class so PATs, access tokens, and customer data
    // cannot reach production logs.
    console.error(
        '[customer-provisioning] manual resolve failed',
        error instanceof Error ? error.name : 'UnknownError',
    );
    return NextResponse.json(
        { error: 'resolve_failed', message: '无法完成人工恢复，请检查任务状态后重试。' },
        { status: 500 },
    );
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const { id } = await params;
    const parsed = resolveSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten() }, { status: 400 });
    }
    const input = parsed.data;

    if (
        input.action === 'link_existing' &&
        (!input.newapi_user_id || !input.newapi_access_token || !input.newapi_token_id)
    ) {
        return NextResponse.json(
            {
                error: 'invalid_input',
                message: 'link_existing 需要 newapi_user_id、newapi_access_token 和 newapi_token_id。',
            },
            { status: 400 },
        );
    }
    if (input.action === 'link_existing' && input.newapi_access_token?.split('.').length === 3) {
        return NextResponse.json(
            { error: 'invalid_input', message: 'newapi_access_token 必须是可持久化的用户访问令牌。' },
            { status: 400 },
        );
    }
    if (input.action !== 'link_existing') {
        const secretFields = [input.newapi_user_id, input.newapi_access_token, input.newapi_token_id];
        if (secretFields.some((value) => value !== undefined)) {
            return NextResponse.json({ error: 'invalid_input', message: '该操作不接受远端凭据。' }, { status: 400 });
        }
    }

    try {
        if (input.action === 'keep_failed') {
            const result = await prisma.customerProvisioningJob.updateMany({
                where: { id, status: 'failed', last_error_code: 'pat_outcome_unknown' },
                data: {
                    password_ciphertext: '',
                    last_error_code: 'pat_outcome_unknown_kept',
                    last_error_message: '人工选择保留失败；加密临时密码已清除。',
                    updated_at: new Date(),
                },
            });
            if (result.count !== 1) return NextResponse.json({ error: 'job_not_resolvable' }, { status: 409 });
            return NextResponse.json({ ok: true, action: input.action, status: 'failed' });
        }

        if (input.action === 'retry_after_confirmed_absent') {
            const job = await prisma.customerProvisioningJob.findFirst({
                where: { id, status: 'failed', last_error_code: 'pat_outcome_unknown' },
                select: { email: true, tier_key: true, newapi_group: true, password_ciphertext: true },
            });
            if (!job) return NextResponse.json({ error: 'job_not_resolvable' }, { status: 409 });
            if (!job.password_ciphertext) {
                return NextResponse.json({ error: 'provisioning_password_unavailable' }, { status: 409 });
            }
            try {
                decryptCustomerProvisioningPassword(job.password_ciphertext);
            } catch {
                return NextResponse.json({ error: 'provisioning_password_unavailable' }, { status: 409 });
            }
            const result = await prisma.customerProvisioningJob.updateMany({
                where: { id, status: 'failed', last_error_code: 'pat_outcome_unknown' },
                data: {
                    status: 'queued',
                    attempts: 0,
                    next_attempt_at: new Date(),
                    runner_token: null,
                    lease_until: null,
                    completed_at: null,
                    result: Prisma.JsonNull,
                    last_error_code: null,
                    last_error_message: null,
                },
            });
            if (result.count !== 1) return NextResponse.json({ error: 'job_not_resolvable' }, { status: 409 });
            return NextResponse.json({ ok: true, action: input.action, status: 'queued' });
        }

        const job = await prisma.customerProvisioningJob.findFirst({
            where: { id, status: 'failed', last_error_code: 'pat_outcome_unknown' },
            select: { user_id: true, email: true, tier_key: true, newapi_group: true },
        });
        if (!job) return NextResponse.json({ error: 'job_not_resolvable' }, { status: 409 });

        const expectedUsername = customerProvisioningUsername(job.user_id);
        const legacyUsername = `c-${job.user_id.slice(0, 8)}`;
        const remoteUser = await getUser(input.newapi_user_id!);
        if (
            remoteUser.id !== input.newapi_user_id ||
            remoteUser.email.trim().toLowerCase() !== job.email.trim().toLowerCase() ||
            (remoteUser.username !== expectedUsername && remoteUser.username !== legacyUsername)
        ) {
            return NextResponse.json({ error: 'remote_identity_mismatch' }, { status: 409 });
        }
        const customerAuth = { accessToken: input.newapi_access_token!, userId: input.newapi_user_id! };
        const identity = await getTokenRevocationCustomerIdentity(customerAuth);
        if (identity.id !== input.newapi_user_id || identity.status !== 1) {
            return NextResponse.json({ error: 'remote_identity_mismatch' }, { status: 409 });
        }
        const remoteToken = await getTokenForCustomer(customerAuth, input.newapi_token_id!);
        if (
            remoteToken.id !== input.newapi_token_id ||
            remoteToken.user_id !== input.newapi_user_id ||
            remoteToken.name !== `default-${job.user_id.slice(0, 8)}` ||
            remoteToken.status !== 1 ||
            !remoteToken.unlimited_quota ||
            remoteToken.expired_time !== -1 ||
            remoteToken.model_limits_enabled ||
            remoteToken.model_limits !== '' ||
            remoteToken.group !== job.newapi_group
        ) {
            return NextResponse.json({ error: 'remote_token_mismatch' }, { status: 409 });
        }
        // The key is read only after strict ownership/configuration checks.
        // It is persisted inside Portal and never included in the response.
        const tokenValue = await getTokenKey(customerAuth, remoteToken.id);

        const result = await prisma.$transaction(async (tx) => {
            const token = await tx.newApiToken.findUnique({ where: { newapi_token_id: remoteToken.id } });
            if (token && token.user_id !== job.user_id) throw new Error('token_owned_by_another_user');

            const user = await tx.user.findUnique({
                where: { id: job.user_id },
                select: { newapi_user_id: true, newapi_username: true, newapi_access_token: true },
            });
            if (!user) throw new Error('user_not_found');
            if (
                (user.newapi_user_id != null && user.newapi_user_id !== input.newapi_user_id) ||
                (user.newapi_access_token != null && user.newapi_access_token !== input.newapi_access_token)
            )
                throw new Error('portal_linkage_conflict');

            if (token) {
                await tx.newApiToken.update({
                    where: { id: token.id },
                    data: {
                        newapi_token_value: tokenValue,
                        key_alias: `default-${job.user_id.slice(0, 8)}`,
                        tier: job.tier_key,
                        status: 'active',
                    },
                });
            } else {
                await tx.newApiToken.create({
                    data: {
                        user_id: job.user_id,
                        newapi_token_id: remoteToken.id,
                        newapi_token_value: tokenValue,
                        key_alias: `default-${job.user_id.slice(0, 8)}`,
                        tier: job.tier_key,
                    },
                });
            }
            await tx.user.update({
                where: { id: job.user_id },
                data: {
                    newapi_user_id: input.newapi_user_id,
                    newapi_username: remoteUser.username,
                    newapi_access_token: input.newapi_access_token,
                },
            });
            const updated = await tx.customerProvisioningJob.updateMany({
                where: { id, status: 'failed', last_error_code: 'pat_outcome_unknown' },
                data: {
                    status: 'completed',
                    runner_token: null,
                    lease_until: null,
                    password_ciphertext: '',
                    result: {
                        newapi_user_id: input.newapi_user_id,
                        newapi_username: remoteUser.username,
                        newapi_token_id: remoteToken.id,
                        manual_resolution: 'link_existing',
                    },
                    completed_at: new Date(),
                    last_error_code: null,
                    last_error_message: null,
                },
            });
            if (updated.count !== 1) throw new Error('job_not_resolvable');
            return updated.count;
        });

        return NextResponse.json({ ok: result === 1, action: input.action, status: 'completed' });
    } catch (error) {
        if (error instanceof Error) {
            if (error.message === 'job_not_resolvable')
                return NextResponse.json({ error: 'job_not_resolvable' }, { status: 409 });
            if (error.message === 'token_owned_by_another_user')
                return NextResponse.json({ error: 'token_owned_by_another_user' }, { status: 409 });
            if (error.message === 'portal_linkage_conflict')
                return NextResponse.json({ error: 'portal_linkage_conflict' }, { status: 409 });
            if (error.message === 'user_not_found')
                return NextResponse.json({ error: 'user_not_found' }, { status: 404 });
        }
        return redactError(error);
    }
}
