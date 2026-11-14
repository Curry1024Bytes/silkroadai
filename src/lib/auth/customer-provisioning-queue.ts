import 'server-only';

import { Prisma, type CustomerProvisioningJob } from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

import { getEnv } from '@/lib/config';
import { prisma } from '@/lib/db';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import { loadChannelGroupTopology } from '@/lib/channel-group-topology';
import { NewApiError, provisionNewCustomerResumable, type ProvisionedCustomer } from '@/lib/newapi/client';

import {
    decryptCustomerProvisioningPassword,
    encryptCustomerProvisioningPassword,
} from './customer-provisioning-secret';

export const CUSTOMER_PROVISIONING_STATUSES = ['queued', 'running', 'retry_wait', 'completed', 'failed'] as const;
export type CustomerProvisioningJobStatus = (typeof CUSTOMER_PROVISIONING_STATUSES)[number];

export interface EnqueueCustomerProvisioningInput {
    userId: string;
    email: string;
    tierKey: string;
    newapiGroup: string;
    initialQuota?: number;
}

export interface ClaimedCustomerProvisioningJob {
    id: string;
    userId: string;
    email: string;
    tierKey: string;
    newapiGroup: string;
    tenantId: string | null;
    initialQuota: number;
    passwordCiphertext: string;
    attempts: number;
    maxAttempts: number;
    runnerToken: string;
}

type JobDb = Pick<Prisma.TransactionClient, 'customerProvisioningJob' | 'user' | 'newApiToken'>;

const PROVISIONING_MUTEX_MAX_WAIT_MS = 30_000;
const PROVISIONING_MUTEX_RETRY_MS = 50;

const globalForProvisioning = globalThis as unknown as { customerProvisioningMutexPool?: Pool };

function getCustomerProvisioningMutexPool(): Pool {
    if (!globalForProvisioning.customerProvisioningMutexPool) {
        globalForProvisioning.customerProvisioningMutexPool = new Pool({
            connectionString: getEnv().DATABASE_URL,
            max: 10,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: PROVISIONING_MUTEX_MAX_WAIT_MS,
        });
    }
    return globalForProvisioning.customerProvisioningMutexPool;
}

function normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

async function releaseProvisioningMutexClient(client: PoolClient, destroy?: Error): Promise<void> {
    client.release(destroy);
}

/**
 * Serialize all remote new-api work for one Portal user with a dedicated
 * PostgreSQL session. Prisma transactions are used only for short Portal
 * writes, so slow remote calls do not pin a Prisma connection or block the
 * queue lease heartbeat.
 */
async function withCustomerProvisioningMutex<T>(userId: string, work: () => Promise<T>): Promise<T> {
    const client = await getCustomerProvisioningMutexPool().connect();
    const lockKey = `customer-provisioning:${userId}`;
    const deadline = Date.now() + PROVISIONING_MUTEX_MAX_WAIT_MS;
    let acquired = false;
    let released = false;
    let destroyClient: Error | undefined;

    try {
        while (Date.now() < deadline) {
            let lockResult;
            try {
                lockResult = await client.query<{ locked: boolean }>(
                    'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
                    [lockKey],
                );
            } catch (error) {
                destroyClient = normalizeError(error);
                throw error;
            }
            if (lockResult.rows[0]?.locked === true) {
                acquired = true;
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, PROVISIONING_MUTEX_RETRY_MS));
        }
        if (!acquired) throw new Error('Timed out waiting for customer provisioning mutex');

        let value!: T;
        let workError: unknown;
        try {
            value = await work();
        } catch (error) {
            workError = error;
        }

        let unlockError: Error | undefined;
        try {
            const result = await client.query<{ unlocked: boolean }>(
                'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked',
                [lockKey],
            );
            if (result.rows[0]?.unlocked !== true) {
                unlockError = new Error('Customer provisioning mutex was not held at unlock');
                // A connection whose session lock state is uncertain must not
                // return to the pool, or a later borrower could inherit it.
                destroyClient = unlockError;
            }
        } catch (error) {
            unlockError = normalizeError(error);
            destroyClient = unlockError;
        }

        await releaseProvisioningMutexClient(client, destroyClient);
        released = true;
        if (workError !== undefined) throw workError;
        if (unlockError) throw new Error('Failed to release customer provisioning mutex', { cause: unlockError });
        return value;
    } finally {
        if (!released) await releaseProvisioningMutexClient(client, destroyClient);
    }
}

const PAT_CREATION_STARTED_ERROR_CODE = 'pat_creation_started';
const PAT_OUTCOME_UNKNOWN_ERROR_CODE = 'pat_outcome_unknown';
const PAT_OUTCOME_UNKNOWN_MESSAGE = '开户凭据创建阶段未能安全完成，已停止自动重试，请联系支持。';

function assertQuota(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('initialQuota must be a non-negative integer');
    return value;
}

function provisioningIdempotencyKey(userId: string): string {
    return `customer-provisioning:${userId}`;
}

function generateProvisioningPassword(): string {
    return randomBytes(8).toString('hex');
}

function toStatus(value: string): CustomerProvisioningJobStatus {
    return (CUSTOMER_PROVISIONING_STATUSES as readonly string[]).includes(value)
        ? (value as CustomerProvisioningJobStatus)
        : 'failed';
}

/** Enqueue once per portal user; repeated registration/OAuth callbacks are safe. */
export async function enqueueCustomerProvisioningJob(
    tx: Prisma.TransactionClient,
    input: EnqueueCustomerProvisioningInput,
): Promise<{ id: string; status: CustomerProvisioningJobStatus }> {
    const userId = input.userId.trim();
    const email = input.email.trim();
    const tierKey = input.tierKey.trim();
    const newapiGroup = input.newapiGroup.trim();
    if (!userId || !email || !tierKey || !newapiGroup) throw new Error('Provisioning fields must not be empty');
    const initialQuota = assertQuota(input.initialQuota ?? 0);
    const idempotencyKey = provisioningIdempotencyKey(userId);
    const passwordCiphertext = encryptCustomerProvisioningPassword(generateProvisioningPassword());
    // user_id is unique and the idempotency key is deterministically derived
    // from it. A single upsert keeps concurrent register/OAuth callbacks in
    // one database statement; a failed INSERT never leaves the surrounding
    // transaction in PostgreSQL's aborted state.
    const job = await tx.customerProvisioningJob.upsert({
        where: { user_id: userId },
        create: {
            user_id: userId,
            idempotency_key: idempotencyKey,
            email,
            tier_key: tierKey,
            newapi_group: newapiGroup,
            initial_quota: initialQuota,
            password_ciphertext: passwordCiphertext,
        },
        update: {},
        select: { id: true, status: true },
    });
    return { id: job.id, status: toStatus(job.status) };
}

export const enqueueCustomerProvisioning = enqueueCustomerProvisioningJob;

function safeStatusMessage(status: CustomerProvisioningJobStatus): string {
    switch (status) {
        case 'queued':
            return '开户任务已排队。';
        case 'running':
            return '开户任务处理中。';
        case 'retry_wait':
            return '开户任务暂时未完成，将自动重试。';
        case 'completed':
            return '开户已完成。';
        case 'failed':
            return '开户暂未完成，请联系支持。';
    }
}

export async function getCustomerProvisioningStatus(userId: string): Promise<{
    status: CustomerProvisioningJobStatus;
    nextAttemptAt: Date | null;
    message: string;
} | null> {
    const job = await prisma.customerProvisioningJob.findUnique({
        where: { user_id: userId },
        select: { status: true, next_attempt_at: true },
    });
    if (!job) return null;
    const status = toStatus(job.status);
    return { status, nextAttemptAt: job.next_attempt_at, message: safeStatusMessage(status) };
}

async function recoverExpiredLeases(db: JobDb, now: Date): Promise<void> {
    const expired = await db.customerProvisioningJob.findMany({
        where: { status: 'running', lease_until: { lt: now } },
        select: { id: true, attempts: true, max_attempts: true, last_error_code: true },
        take: 100,
    });
    for (const job of expired) {
        await db.customerProvisioningJob.updateMany({
            where: { id: job.id, status: 'running', lease_until: { lt: now } },
            data:
                job.last_error_code === PAT_CREATION_STARTED_ERROR_CODE || job.attempts >= job.max_attempts
                    ? {
                          status: 'failed',
                          runner_token: null,
                          lease_until: null,
                          ...(job.last_error_code === PAT_CREATION_STARTED_ERROR_CODE
                              ? {}
                              : { password_ciphertext: '' }),
                          last_error_code:
                              job.last_error_code === PAT_CREATION_STARTED_ERROR_CODE
                                  ? PAT_OUTCOME_UNKNOWN_ERROR_CODE
                                  : 'lease_expired',
                          last_error_message:
                              job.last_error_code === PAT_CREATION_STARTED_ERROR_CODE
                                  ? PAT_OUTCOME_UNKNOWN_MESSAGE
                                  : '开户任务租约已过期。',
                          completed_at: null,
                      }
                    : {
                          status: 'retry_wait',
                          runner_token: null,
                          lease_until: null,
                          next_attempt_at: now,
                      },
        });
    }
}

export async function claimCustomerProvisioningJob(
    options: {
        now?: Date;
        leaseMs?: number;
    } = {},
): Promise<ClaimedCustomerProvisioningJob | null> {
    const now = options.now ?? new Date();
    const leaseMs = options.leaseMs ?? 120_000;
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be positive');
    return prisma.$transaction(async (tx) => {
        await recoverExpiredLeases(tx, now);
        const candidates = await tx.customerProvisioningJob.findMany({
            where: {
                status: { in: ['queued', 'retry_wait'] },
                next_attempt_at: { lte: now },
            },
            orderBy: [{ next_attempt_at: 'asc' }, { created_at: 'asc' }],
            take: 100,
            include: { user: { select: { tenant_id: true } } },
        });
        const candidate = candidates.find((job) => job.attempts < job.max_attempts);
        if (!candidate) return null;
        const runnerToken = randomUUID();
        const claimed = await tx.customerProvisioningJob.updateMany({
            where: {
                id: candidate.id,
                status: candidate.status,
                attempts: candidate.attempts,
                next_attempt_at: { lte: now },
            },
            data: {
                status: 'running',
                attempts: { increment: 1 },
                runner_token: runnerToken,
                lease_until: new Date(now.getTime() + leaseMs),
            },
        });
        if (claimed.count !== 1) return null;
        return {
            id: candidate.id,
            userId: candidate.user_id,
            email: candidate.email,
            tierKey: candidate.tier_key,
            newapiGroup: candidate.newapi_group,
            tenantId: candidate.user.tenant_id,
            initialQuota: candidate.initial_quota,
            passwordCiphertext: candidate.password_ciphertext,
            attempts: candidate.attempts + 1,
            maxAttempts: candidate.max_attempts,
            runnerToken,
        };
    });
}

function retryDelayMs(error: unknown, attempts: number): number {
    if (error instanceof NewApiError && error.retryAfterMs !== undefined) {
        return Math.min(Math.max(error.retryAfterMs, 0), 60 * 60_000);
    }
    return Math.min(60 * 60_000, Math.max(1000, 2 ** Math.min(attempts, 10) * 1000));
}

function isRetryable(error: unknown): boolean {
    if (!(error instanceof NewApiError)) return true;
    if (error.ambiguousSideEffect) return false;
    return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
}

function safeError(error: unknown): { code: string; message: string } {
    if (error instanceof NewApiError) {
        if (error.ambiguousSideEffect)
            return { code: PAT_OUTCOME_UNKNOWN_ERROR_CODE, message: PAT_OUTCOME_UNKNOWN_MESSAGE };
        return { code: `newapi_${error.status}`, message: `new-api 请求失败（HTTP ${error.status}）。` };
    }
    return { code: 'provisioning_error', message: '开户任务处理失败。' };
}

class ProvisioningLeaseLostError extends Error {
    constructor() {
        super('Provisioning lease was lost before commit');
        this.name = 'ProvisioningLeaseLostError';
    }
}

async function persistProvisioningSuccessInTransaction(
    tx: JobDb,
    job: ClaimedCustomerProvisioningJob,
    result: ProvisionedCustomer,
): Promise<void> {
    const current = await tx.customerProvisioningJob.findUnique({ where: { id: job.id } });
    if (
        !current ||
        current.status !== 'running' ||
        current.runner_token !== job.runnerToken ||
        !current.lease_until ||
        current.lease_until <= new Date()
    ) {
        throw new ProvisioningLeaseLostError();
    }
    const user = await tx.user.findUnique({
        where: { id: job.userId },
        select: { newapi_user_id: true, newapi_username: true, newapi_access_token: true },
    });
    if (!user) throw new Error('Provisioning portal user no longer exists');
    if (
        (user.newapi_user_id != null && user.newapi_user_id !== result.newapi_user_id) ||
        (user.newapi_username != null && user.newapi_username !== result.newapi_username) ||
        (user.newapi_access_token != null && user.newapi_access_token !== result.newapi_access_token)
    ) {
        throw new Error('Provisioning portal linkage mismatch');
    }

    const existingToken = await tx.newApiToken.findUnique({ where: { newapi_token_id: result.newapi_token_id } });
    if (existingToken && existingToken.user_id !== job.userId) {
        throw new Error('Provisioning token belongs to another portal user');
    }
    const keyAlias = `default-${job.userId.slice(0, 8)}`;
    if (existingToken) {
        await tx.newApiToken.update({
            where: { id: existingToken.id },
            data: {
                newapi_token_value: result.newapi_token_value,
                key_alias: keyAlias,
                tier: job.tierKey,
                status: 'active',
            },
        });
    } else {
        await tx.newApiToken.create({
            data: {
                user_id: job.userId,
                newapi_token_id: result.newapi_token_id,
                newapi_token_value: result.newapi_token_value,
                key_alias: keyAlias,
                tier: job.tierKey,
            },
        });
    }
    await tx.user.update({
        where: { id: job.userId },
        data: {
            newapi_user_id: result.newapi_user_id,
            newapi_username: result.newapi_username,
            newapi_access_token: result.newapi_access_token,
        },
    });
    const completed = await tx.customerProvisioningJob.updateMany({
        where: { id: job.id, status: 'running', runner_token: job.runnerToken, lease_until: { gt: new Date() } },
        data: {
            status: 'completed',
            runner_token: null,
            lease_until: null,
            password_ciphertext: '',
            result: {
                newapi_user_id: result.newapi_user_id,
                newapi_username: result.newapi_username,
                newapi_token_id: result.newapi_token_id,
            },
            completed_at: new Date(),
            last_error_code: null,
            last_error_message: null,
        },
    });
    if (completed.count !== 1) throw new ProvisioningLeaseLostError();
}

/** Fence a claimed job while holding the per-user mutex before any remote call. */
async function renewAndFenceProvisioningLease(job: ClaimedCustomerProvisioningJob, leaseMs: number): Promise<void> {
    // This update deliberately uses the root Prisma client rather than the
    // advisory-lock transaction. Keeping the row lock in a short committed
    // statement lets the heartbeat renew the lease during slow new-api calls.
    const renewed = await prisma.customerProvisioningJob.updateMany({
        where: {
            id: job.id,
            status: 'running',
            runner_token: job.runnerToken,
            lease_until: { gt: new Date() },
        },
        data: { lease_until: new Date(Date.now() + leaseMs) },
    });
    if (renewed.count !== 1) throw new ProvisioningLeaseLostError();
}

async function renewCustomerProvisioningLease(job: ClaimedCustomerProvisioningJob, leaseMs: number): Promise<boolean> {
    const renewed = await prisma.customerProvisioningJob.updateMany({
        where: {
            id: job.id,
            status: 'running',
            runner_token: job.runnerToken,
            lease_until: { gt: new Date() },
        },
        data: { lease_until: new Date(Date.now() + leaseMs) },
    });
    return renewed.count === 1;
}

function startCustomerProvisioningLeaseHeartbeat(job: ClaimedCustomerProvisioningJob, leaseMs: number): () => void {
    const intervalMs = Math.max(10, Math.min(30_000, Math.floor(leaseMs / 3)));
    let renewalInProgress = false;
    const timer = setInterval(() => {
        if (renewalInProgress) return;
        renewalInProgress = true;
        void renewCustomerProvisioningLease(job, leaseMs)
            .catch(() => false)
            .finally(() => {
                renewalInProgress = false;
            });
    }, intervalMs);
    return () => clearInterval(timer);
}

async function persistProvisioningFailure(
    job: ClaimedCustomerProvisioningJob,
    error: unknown,
    patCreationStarted = false,
): Promise<void> {
    const retry = !patCreationStarted && isRetryable(error) && job.attempts < job.maxAttempts;
    const { code, message } = patCreationStarted
        ? { code: PAT_OUTCOME_UNKNOWN_ERROR_CODE, message: PAT_OUTCOME_UNKNOWN_MESSAGE }
        : safeError(error);
    const nextAttemptAt = new Date(Date.now() + retryDelayMs(error, job.attempts));
    const updated = await prisma.customerProvisioningJob.updateMany({
        where: {
            id: job.id,
            status: 'running',
            runner_token: job.runnerToken,
            lease_until: { gt: new Date() },
        },
        data: {
            status: retry ? 'retry_wait' : 'failed',
            next_attempt_at: nextAttemptAt,
            runner_token: null,
            lease_until: null,
            ...(retry || code === PAT_OUTCOME_UNKNOWN_ERROR_CODE ? {} : { password_ciphertext: '' }),
            last_error_code: code,
            last_error_message: message,
        },
    });
    if (updated.count !== 1) throw new ProvisioningLeaseLostError();
}

async function assertProvisioningTopology(job: ClaimedCustomerProvisioningJob): Promise<void> {
    const topology = await loadChannelGroupTopology(job.tenantId);
    if (topology.defaultGroup.key !== job.tierKey || topology.defaultGroup.newapi_group !== job.newapiGroup) {
        throw new NewApiError(
            409,
            'Portal channel-group topology',
            null,
            'Provisioning tier is no longer the active default',
        );
    }
    const tenantId = job.tenantId ?? PLATFORM_TENANT_ID;
    const retirement = await prisma.channelGroupRetirementJob.findFirst({
        where: {
            OR: [{ tenant_id: tenantId }, ...(tenantId === PLATFORM_TENANT_ID ? [{ tenant_id: null }] : [])],
            tier_key: job.tierKey,
            status: { notIn: ['succeeded', 'cancelled'] },
        },
        select: { id: true },
    });
    if (retirement) {
        throw new NewApiError(409, 'Portal channel-group retirement', null, 'Provisioning tier is being retired');
    }
}

export async function processNextCustomerProvisioningJob(
    options: {
        now?: Date;
        leaseMs?: number;
    } = {},
): Promise<'idle' | 'processed'> {
    const job = await claimCustomerProvisioningJob(options);
    if (!job) return 'idle';
    const leaseMs = options.leaseMs ?? 120_000;
    const stopHeartbeat = startCustomerProvisioningLeaseHeartbeat(job, leaseMs);
    let patCreationStarted = false;
    try {
        const password = decryptCustomerProvisioningPassword(job.passwordCiphertext);
        await withCustomerProvisioningMutex(job.userId, async () => {
            // A worker may have waited on the mutex after its queue lease was
            // replaced by another claim. Fence it before login/token rotation
            // or any other remote side effect.
            await renewAndFenceProvisioningLease(job, leaseMs);
            await assertProvisioningTopology(job);
            const result = await provisionNewCustomerResumable({
                portal_user_id: job.userId,
                email: job.email,
                newapi_group: job.newapiGroup,
                initial_quota: job.initialQuota,
                password,
                onPatCreationStarted: async () => {
                    // Commit this marker before the PAT mutation is sent. If
                    // the process dies after the request leaves Portal, lease
                    // recovery must fail closed instead of retrying an unknown
                    // token creation.
                    const started = await prisma.customerProvisioningJob.updateMany({
                        where: {
                            id: job.id,
                            status: 'running',
                            runner_token: job.runnerToken,
                            lease_until: { gt: new Date() },
                        },
                        data: {
                            lease_until: new Date(Date.now() + leaseMs),
                            last_error_code: PAT_CREATION_STARTED_ERROR_CODE,
                            last_error_message: '开户凭据创建即将发送，结果待确认。',
                        },
                    });
                    if (started.count !== 1) throw new ProvisioningLeaseLostError();
                    patCreationStarted = true;
                },
                onPatCreationDefinitiveFailure: async () => {
                    const cleared = await prisma.customerProvisioningJob.updateMany({
                        where: {
                            id: job.id,
                            status: 'running',
                            runner_token: job.runnerToken,
                            lease_until: { gt: new Date() },
                        },
                        data: { last_error_code: null, last_error_message: null },
                    });
                    if (cleared.count !== 1) throw new ProvisioningLeaseLostError();
                    patCreationStarted = false;
                },
            });
            // Renew once immediately before the short Portal commit so a slow
            // final API call cannot leave the transaction racing recovery.
            await renewAndFenceProvisioningLease(job, leaseMs);
            await prisma.$transaction((tx) => persistProvisioningSuccessInTransaction(tx, job, result));
        });
    } catch (error) {
        if (!(error instanceof ProvisioningLeaseLostError))
            await persistProvisioningFailure(job, error, patCreationStarted);
    } finally {
        stopHeartbeat();
    }
    return 'processed';
}

export async function runCustomerProvisioningWorker(
    options: {
        batchSize?: number;
        leaseMs?: number;
    } = {},
): Promise<number> {
    const batchSize = options.batchSize ?? 10;
    if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error('batchSize must be positive');
    let processed = 0;
    while (processed < batchSize) {
        const result = await processNextCustomerProvisioningJob({ leaseMs: options.leaseMs });
        if (result === 'idle') break;
        processed += 1;
    }
    return processed;
}

export type CustomerProvisioningJobRecord = CustomerProvisioningJob;
