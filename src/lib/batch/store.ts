/**
 * OpenAI Batch API 兼容 — DB 访问层 + 对客对象信封(纯数据,不 import route/worker)。
 *
 * 契约(对齐 OpenAI 官方 Batch API,客户 SDK `client.batches.*` / `client.files.*` 直接可用):
 *   POST /v1/files (purpose=batch, JSONL)      → file 对象
 *   POST /v1/batches {input_file_id, endpoint} → batch 对象(status=validating)
 *   GET  /v1/batches/{id}                      → 轮询状态(→ in_progress → completed)
 *   GET  /v1/files/{output_file_id}/content    → 结果 JSONL
 *
 * 文件内容存 PG(公开读的 image bucket 放不得客户 prompt);执行/计费在 worker.ts
 * (逐行重放现有 /v1/images/* 同步管线,new-api 照常按请求扣费 —— 本层零计费逻辑)。
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';

/** batch 从创建起最长存活窗口(对齐 OpenAI completion_window=24h;超时未完 → expired)。 */
export const BATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

/** MVP 支持进 batch 的端点(其余 400;body 校验见 validate.ts)。 */
export const SUPPORTED_BATCH_ENDPOINTS = new Set(['/v1/images/generations', '/v1/images/edits']);

const hex24 = (): string => randomUUID().replace(/-/g, '').slice(0, 24);
export const newFileId = (): string => `file-${hex24()}`;
export const newBatchId = (): string => `batch_${hex24()}`;

export interface BatchFileRow {
    id: string;
    user_id: string;
    purpose: string;
    filename: string;
    bytes: number;
    content: Uint8Array;
    created_at: Date;
}

export interface BatchRow {
    id: string;
    user_id: string;
    endpoint: string;
    input_file_id: string;
    status: string;
    output_file_id: string | null;
    error_file_id: string | null;
    total_count: number;
    completed_count: number;
    failed_count: number;
    errors_json: unknown;
    metadata_json: unknown;
    cancel_requested: boolean;
    auth_header: string;
    created_at: Date;
    started_at: Date | null;
    finished_at: Date | null;
}

export interface BatchLineResultRow {
    batch_id: string;
    line_no: number;
    custom_id: string;
    status_code: number;
    response_json: unknown;
    error_json: unknown;
}

// ── files ──

export async function createFile(
    userId: string,
    purpose: string,
    filename: string,
    content: Buffer,
): Promise<BatchFileRow> {
    return (await prisma.batchFile.create({
        data: {
            id: newFileId(),
            user_id: userId,
            purpose,
            filename,
            bytes: content.length,
            // Buffer 的 .buffer 可能是 SharedArrayBuffer 型签名,Prisma Bytes 只收
            // Uint8Array<ArrayBuffer> → 拷一份定型(批文件 ≤20MB,拷贝可忽略)
            content: new Uint8Array(content),
        },
    })) as BatchFileRow;
}

/** IDOR:非本人 = 当作不存在。 */
export async function getFile(fileId: string, userId: string): Promise<BatchFileRow | null> {
    const row = (await prisma.batchFile.findUnique({ where: { id: fileId } })) as BatchFileRow | null;
    return row && row.user_id === userId ? row : null;
}

/** worker 内部读(无 IDOR — 调用方已持有 batch 行)。 */
export async function getFileInternal(fileId: string): Promise<BatchFileRow | null> {
    return (await prisma.batchFile.findUnique({ where: { id: fileId } })) as BatchFileRow | null;
}

export async function listFiles(userId: string, limit: number): Promise<BatchFileRow[]> {
    return (await prisma.batchFile.findMany({
        where: { user_id: userId },
        orderBy: { created_at: 'desc' },
        take: limit,
    })) as BatchFileRow[];
}

/** 幂等删除。返回是否真删了(IDOR:非本人 count=0)。 */
export async function deleteFile(fileId: string, userId: string): Promise<boolean> {
    const r = await prisma.batchFile.deleteMany({ where: { id: fileId, user_id: userId } });
    return r.count > 0;
}

// ── batches ──

export async function createBatch(args: {
    userId: string;
    endpoint: string;
    inputFileId: string;
    metadata: unknown;
    authHeader: string;
}): Promise<BatchRow> {
    return (await prisma.batch.create({
        data: {
            id: newBatchId(),
            user_id: args.userId,
            endpoint: args.endpoint,
            input_file_id: args.inputFileId,
            metadata_json: args.metadata as never,
            auth_header: args.authHeader,
        },
    })) as BatchRow;
}

export async function getBatch(batchId: string, userId: string): Promise<BatchRow | null> {
    const row = (await prisma.batch.findUnique({ where: { id: batchId } })) as BatchRow | null;
    return row && row.user_id === userId ? row : null;
}

export async function listBatches(userId: string, limit: number): Promise<BatchRow[]> {
    return (await prisma.batch.findMany({
        where: { user_id: userId },
        orderBy: { created_at: 'desc' },
        take: limit,
    })) as BatchRow[];
}

/** 请求取消。validating 阶段(worker 还没领)直接置 cancelling 也没问题 —— worker
 *  两个阶段都会看 cancel_requested。终态 batch 不动(幂等返回现状)。 */
export async function requestCancel(batchId: string, userId: string): Promise<BatchRow | null> {
    await prisma.batch.updateMany({
        where: { id: batchId, user_id: userId, status: { in: ['validating', 'in_progress'] } },
        data: { cancel_requested: true, status: 'cancelling' },
    });
    return getBatch(batchId, userId);
}

// ── worker 侧状态推进(全部 updateMany 带前置状态 → CAS,幂等/防并发)──

export async function claimValidating(): Promise<BatchRow | null> {
    return (await prisma.batch.findFirst({
        where: { status: 'validating' },
        orderBy: { created_at: 'asc' },
    })) as BatchRow | null;
}

export async function markValidationFailed(batchId: string, errors: unknown): Promise<void> {
    await prisma.batch.updateMany({
        where: { id: batchId, status: 'validating' },
        data: { status: 'failed', errors_json: errors as never, finished_at: new Date() },
    });
}

export async function markInProgress(batchId: string, totalCount: number): Promise<void> {
    await prisma.batch.updateMany({
        where: { id: batchId, status: 'validating' },
        data: { status: 'in_progress', total_count: totalCount, started_at: new Date() },
    });
}

/** 逐行结果落库(重启续跑依据)。幂等:同 (batch_id, line_no) 已存在则跳过不重计数。 */
export async function saveLineResult(row: BatchLineResultRow): Promise<void> {
    try {
        await prisma.batchRequestResult.create({
            data: {
                batch_id: row.batch_id,
                line_no: row.line_no,
                custom_id: row.custom_id,
                status_code: row.status_code,
                response_json: row.response_json as never,
                error_json: row.error_json as never,
            },
        });
    } catch {
        return; // unique 冲突 = 该行已有结果(重启重放)→ 保留旧的
    }
    const ok = row.status_code >= 200 && row.status_code < 300;
    await prisma.batch.update({
        where: { id: row.batch_id },
        data: ok ? { completed_count: { increment: 1 } } : { failed_count: { increment: 1 } },
    });
}

export async function listLineResults(batchId: string): Promise<BatchLineResultRow[]> {
    return (await prisma.batchRequestResult.findMany({
        where: { batch_id: batchId },
        orderBy: { line_no: 'asc' },
    })) as BatchLineResultRow[];
}

export async function refreshBatch(batchId: string): Promise<BatchRow | null> {
    return (await prisma.batch.findUnique({ where: { id: batchId } })) as BatchRow | null;
}

export async function finalizeBatch(
    batchId: string,
    status: 'completed' | 'expired' | 'cancelled',
    outputFileId: string | null,
    errorFileId: string | null,
): Promise<void> {
    await prisma.batch.updateMany({
        where: { id: batchId, status: { in: ['in_progress', 'cancelling', 'validating'] } },
        data: { status, output_file_id: outputFileId, error_file_id: errorFileId, finished_at: new Date() },
    });
}

/** 领一个可跑的 batch(最老优先)。in_progress = 正常推进;cancelling = 去 finalize。 */
export async function nextRunnableBatch(): Promise<BatchRow | null> {
    return (await prisma.batch.findFirst({
        where: { status: { in: ['in_progress', 'cancelling'] } },
        orderBy: { created_at: 'asc' },
    })) as BatchRow | null;
}

/** 超窗批次(created_at + 24h < now 且未终态)。 */
export async function listExpiredBatches(now: Date): Promise<BatchRow[]> {
    return (await prisma.batch.findMany({
        where: {
            status: { in: ['validating', 'in_progress', 'cancelling'] },
            created_at: { lt: new Date(now.getTime() - BATCH_WINDOW_MS) },
        },
        take: 10,
    })) as BatchRow[];
}

// ── 对客信封 ──

const unix = (d: Date | null): number | null => (d ? Math.floor(d.getTime() / 1000) : null);

export function fileEnvelope(row: BatchFileRow): Record<string, unknown> {
    return {
        id: row.id,
        object: 'file',
        bytes: row.bytes,
        created_at: unix(row.created_at),
        filename: row.filename,
        purpose: row.purpose,
    };
}

export function batchEnvelope(row: BatchRow): Record<string, unknown> {
    return {
        id: row.id,
        object: 'batch',
        endpoint: row.endpoint,
        errors: (row.errors_json as Record<string, unknown> | null) ?? null,
        input_file_id: row.input_file_id,
        completion_window: '24h',
        status: row.status,
        output_file_id: row.output_file_id,
        error_file_id: row.error_file_id,
        created_at: unix(row.created_at),
        in_progress_at: unix(row.started_at),
        expires_at: unix(new Date(row.created_at.getTime() + BATCH_WINDOW_MS)),
        finalizing_at: null,
        completed_at: row.status === 'completed' ? unix(row.finished_at) : null,
        failed_at: row.status === 'failed' ? unix(row.finished_at) : null,
        expired_at: row.status === 'expired' ? unix(row.finished_at) : null,
        cancelling_at: null,
        cancelled_at: row.status === 'cancelled' ? unix(row.finished_at) : null,
        request_counts: {
            total: row.total_count,
            completed: row.completed_count,
            failed: row.failed_count,
        },
        metadata: (row.metadata_json as Record<string, unknown> | null) ?? null,
    };
}
