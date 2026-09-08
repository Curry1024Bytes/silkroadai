/**
 * OpenAI Batch API 兼容层 — HTTP 面(/v1/files + /v1/batches,portal 自答不打 new-api)。
 *
 * 路由(handleRequest 在透传兜底之前把两个前缀整体交给 handleBatchApi):
 *   POST   /v1/files                 上传 JSONL(multipart,purpose=batch)
 *   GET    /v1/files                 列表
 *   GET    /v1/files/{id}            文件对象
 *   GET    /v1/files/{id}/content    文件原文(输入 / 输出 / 错误文件通用)
 *   DELETE /v1/files/{id}            删除
 *   POST   /v1/batches               创建批任务(status=validating,worker 领走)
 *   GET    /v1/batches               列表
 *   GET    /v1/batches/{id}          轮询状态
 *   POST   /v1/batches/{id}/cancel   取消
 *
 * 鉴权同异步生图:sk- 反查 portal user(resolveUserIdFromAuthHeader),所有读取按
 * user_id 守 IDOR。执行与计费全在 worker(@/lib/batch/worker),本文件零上游调用。
 * 错误体用 OpenAI 形 { error: { message, type, code } },客户 SDK 能原生解析。
 */
import { NextRequest, NextResponse } from 'next/server';
import { resolveUserIdFromAuthHeader } from '@/lib/oss/store';
import { prisma } from '@/lib/db';
import {
    SUPPORTED_BATCH_ENDPOINTS,
    batchEnvelope,
    createBatch,
    createFile,
    deleteFile,
    fileEnvelope,
    getBatch,
    getFile,
    listBatches,
    listFiles,
    requestCancel,
} from '@/lib/batch/store';

/** 输入 JSONL 大小上限(默认 20MB;行数上限另见 validate.ts)。 */
function maxInputBytes(): number {
    const n = Number(process.env.BATCH_MAX_INPUT_BYTES || String(20 * 1024 * 1024));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20 * 1024 * 1024;
}

/** 每用户同时在途(非终态)批次上限 —— 队列是共享资源,防单客户囤积。 */
const MAX_ACTIVE_BATCHES_PER_USER = 5;

function err(status: number, message: string, type: string, code: string | null = null): NextResponse {
    return NextResponse.json({ error: { message, type, code, param: null } }, { status });
}

function parseLimit(search: string): number {
    const n = Number(new URLSearchParams(search).get('limit') || '20');
    return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 100) : 20;
}

async function handleFileUpload(req: NextRequest, userId: string): Promise<NextResponse> {
    let form: FormData;
    try {
        form = await req.formData();
    } catch {
        return err(400, 'expected multipart/form-data with "purpose" and "file" fields', 'invalid_request_error');
    }
    const purpose = form.get('purpose');
    if (purpose !== 'batch') {
        return err(400, 'only purpose "batch" is supported', 'invalid_request_error', 'unsupported_purpose');
    }
    const file = form.get('file');
    if (!(file instanceof File)) {
        return err(400, 'missing "file" field', 'invalid_request_error');
    }
    const cap = maxInputBytes();
    if (file.size > cap) {
        return err(413, `file too large (${file.size} bytes, max ${cap})`, 'invalid_request_error', 'file_too_large');
    }
    const content = Buffer.from(await file.arrayBuffer());
    const row = await createFile(userId, 'batch', file.name || 'batch.jsonl', content);
    return NextResponse.json(fileEnvelope(row), { status: 200 });
}

async function handleBatchCreate(req: NextRequest, userId: string): Promise<NextResponse> {
    let body: Record<string, unknown>;
    try {
        body = (await req.json()) as Record<string, unknown>;
    } catch {
        return err(400, 'invalid JSON body', 'invalid_request_error');
    }
    const inputFileId = body.input_file_id;
    if (typeof inputFileId !== 'string' || inputFileId === '') {
        return err(400, 'input_file_id is required', 'invalid_request_error');
    }
    const endpoint = body.endpoint;
    if (typeof endpoint !== 'string' || !SUPPORTED_BATCH_ENDPOINTS.has(endpoint)) {
        return err(
            400,
            `unsupported endpoint; supported: ${[...SUPPORTED_BATCH_ENDPOINTS].join(', ')}`,
            'invalid_request_error',
            'unsupported_endpoint',
        );
    }
    const cw = body.completion_window;
    if (cw !== undefined && cw !== '24h') {
        return err(400, 'completion_window must be "24h"', 'invalid_request_error');
    }
    const metadata = body.metadata;
    if (metadata !== undefined && (typeof metadata !== 'object' || Array.isArray(metadata))) {
        return err(400, 'metadata must be an object', 'invalid_request_error');
    }

    const file = await getFile(inputFileId, userId);
    if (!file) return err(404, `no such file: ${inputFileId}`, 'invalid_request_error', 'not_found');
    if (file.purpose !== 'batch') {
        return err(400, 'input file must have purpose "batch"', 'invalid_request_error');
    }

    const active = await prisma.batch.count({
        where: { user_id: userId, status: { in: ['validating', 'in_progress', 'cancelling'] } },
    });
    if (active >= MAX_ACTIVE_BATCHES_PER_USER) {
        return err(
            429,
            `too many active batches (max ${MAX_ACTIVE_BATCHES_PER_USER}); wait for one to finish`,
            'invalid_request_error',
            'batch_limit_reached',
        );
    }

    const row = await createBatch({
        userId,
        endpoint,
        inputFileId,
        metadata: metadata ?? null,
        authHeader: req.headers.get('authorization') || '',
    });
    return NextResponse.json(batchEnvelope(row), { status: 200 });
}

/** 入口:path 是去掉 /v1 前缀的形态(如 '/batches'、'/files/file-xxx/content')。 */
export async function handleBatchApi(req: NextRequest, path: string, search: string): Promise<NextResponse> {
    let userId: string | null;
    try {
        userId = await resolveUserIdFromAuthHeader(req.headers.get('authorization'));
    } catch {
        return err(500, 'auth lookup failed, please retry', 'api_error');
    }
    if (!userId) return err(401, 'invalid api key', 'authentication_error', 'invalid_api_key');

    const m = req.method;

    if (path === '/files') {
        if (m === 'POST') return handleFileUpload(req, userId);
        if (m === 'GET') {
            const rows = await listFiles(userId, parseLimit(search));
            return NextResponse.json({ object: 'list', data: rows.map(fileEnvelope), has_more: false });
        }
    }

    let mm = path.match(/^\/files\/([^/]+)\/content$/);
    if (mm && m === 'GET') {
        const file = await getFile(mm[1], userId);
        if (!file) return err(404, `no such file: ${mm[1]}`, 'invalid_request_error', 'not_found');
        return new NextResponse(Buffer.from(file.content), {
            status: 200,
            headers: {
                'content-type': 'application/octet-stream',
                'content-disposition': `attachment; filename="${file.filename.replace(/["\\\r\n]/g, '_')}"`,
            },
        });
    }

    mm = path.match(/^\/files\/([^/]+)$/);
    if (mm) {
        if (m === 'GET') {
            const file = await getFile(mm[1], userId);
            if (!file) return err(404, `no such file: ${mm[1]}`, 'invalid_request_error', 'not_found');
            return NextResponse.json(fileEnvelope(file));
        }
        if (m === 'DELETE') {
            const deleted = await deleteFile(mm[1], userId);
            if (!deleted) return err(404, `no such file: ${mm[1]}`, 'invalid_request_error', 'not_found');
            return NextResponse.json({ id: mm[1], object: 'file', deleted: true });
        }
    }

    if (path === '/batches') {
        if (m === 'POST') return handleBatchCreate(req, userId);
        if (m === 'GET') {
            const rows = await listBatches(userId, parseLimit(search));
            return NextResponse.json({
                object: 'list',
                data: rows.map(batchEnvelope),
                first_id: rows[0]?.id ?? null,
                last_id: rows[rows.length - 1]?.id ?? null,
                has_more: false,
            });
        }
    }

    mm = path.match(/^\/batches\/([^/]+)\/cancel$/);
    if (mm && m === 'POST') {
        const row = await requestCancel(mm[1], userId);
        if (!row) return err(404, `no such batch: ${mm[1]}`, 'invalid_request_error', 'not_found');
        return NextResponse.json(batchEnvelope(row));
    }

    mm = path.match(/^\/batches\/([^/]+)$/);
    if (mm && m === 'GET') {
        const row = await getBatch(mm[1], userId);
        if (!row) return err(404, `no such batch: ${mm[1]}`, 'invalid_request_error', 'not_found');
        return NextResponse.json(batchEnvelope(row));
    }

    return err(404, `unknown batch API route: ${m} /v1${path}`, 'invalid_request_error', 'not_found');
}
