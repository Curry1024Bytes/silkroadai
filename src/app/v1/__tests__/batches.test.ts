/**
 * /v1/files + /v1/batches HTTP 面测试(mock prisma + sk- 反查;store 走真逻辑)。
 * 断言:鉴权 401、文件上传(purpose/大小/happy)、IDOR 404、content 下载、
 * 批任务创建(端点白名单/文件校验/在途上限/信封形)、轮询、取消、未知路由 404。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockResolveUser = vi.fn();
vi.mock('@/lib/oss/store', () => ({
    resolveUserIdFromAuthHeader: (...a: unknown[]) => mockResolveUser(...a),
}));

const db = vi.hoisted(() => ({
    batchFile: { create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
    batch: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        updateMany: vi.fn(),
        update: vi.fn(),
        count: vi.fn(),
    },
    batchRequestResult: { create: vi.fn(), findMany: vi.fn() },
}));
vi.mock('@/lib/db', () => ({ prisma: db }));

import { handleBatchApi } from '../[...path]/batches';

const USER = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER = 'bbbbbbbb-0000-0000-0000-000000000002';
const AUTH = 'Bearer sk-' + 'a'.repeat(48);

function req(method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}) {
    return new NextRequest(`https://ai.silkroadai.io/v1${path}`, {
        method,
        headers: { authorization: AUTH, ...init.headers },
        body: init.body,
    });
}

const NOW = new Date('2026-08-29T00:00:00Z');
const fileRow = (over: Record<string, unknown> = {}) => ({
    id: 'file-abc',
    user_id: USER,
    purpose: 'batch',
    filename: 'in.jsonl',
    bytes: 10,
    content: Buffer.from('hello-jsonl', 'utf8'),
    created_at: NOW,
    ...over,
});
const batchRow = (over: Record<string, unknown> = {}) => ({
    id: 'batch_abc',
    user_id: USER,
    endpoint: '/v1/images/generations',
    input_file_id: 'file-abc',
    status: 'validating',
    output_file_id: null,
    error_file_id: null,
    total_count: 0,
    completed_count: 0,
    failed_count: 0,
    errors_json: null,
    metadata_json: null,
    cancel_requested: false,
    auth_header: AUTH,
    created_at: NOW,
    started_at: null,
    finished_at: null,
    ...over,
});

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveUser.mockResolvedValue(USER);
});
afterEach(() => {
    delete process.env.BATCH_MAX_INPUT_BYTES;
});

describe('鉴权', () => {
    it('key 反查不到 → 401 authentication_error', async () => {
        mockResolveUser.mockResolvedValue(null);
        const resp = await handleBatchApi(req('GET', '/batches'), '/batches', '');
        expect(resp.status).toBe(401);
        const j = await resp.json();
        expect(j.error.type).toBe('authentication_error');
    });

    it('反查抛错 → 500(可重试,不误判 401)', async () => {
        mockResolveUser.mockRejectedValue(new Error('db down'));
        const resp = await handleBatchApi(req('GET', '/batches'), '/batches', '');
        expect(resp.status).toBe(500);
    });
});

describe('POST /v1/files', () => {
    function upload(purpose: string | null, content: string | null, filename = 'in.jsonl') {
        const form = new FormData();
        if (purpose !== null) form.set('purpose', purpose);
        if (content !== null) form.set('file', new File([content], filename));
        return handleBatchApi(req('POST', '/files', { body: form }), '/files', '');
    }

    it('purpose 非 batch → 400', async () => {
        const resp = await upload('fine-tune', '{}');
        expect(resp.status).toBe(400);
        expect((await resp.json()).error.code).toBe('unsupported_purpose');
    });

    it('缺 file 字段 → 400', async () => {
        expect((await upload('batch', null)).status).toBe(400);
    });

    it('超大小上限 → 413', async () => {
        process.env.BATCH_MAX_INPUT_BYTES = '5';
        const resp = await upload('batch', '123456789');
        expect(resp.status).toBe(413);
    });

    it('happy → file 对象信封 + 内容落库', async () => {
        db.batchFile.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({ ...data, created_at: NOW }),
        );
        const resp = await upload('batch', '{"x":1}\n');
        expect(resp.status).toBe(200);
        const j = await resp.json();
        expect(j).toMatchObject({ object: 'file', purpose: 'batch', filename: 'in.jsonl', bytes: 8 });
        expect(String(j.id)).toMatch(/^file-[0-9a-f]{24}$/);
        const saved = db.batchFile.create.mock.calls[0][0].data;
        expect(Buffer.from(saved.content).toString('utf8')).toBe('{"x":1}\n');
        expect(saved.user_id).toBe(USER);
    });
});

describe('GET/DELETE /v1/files/*', () => {
    it('别人的文件 → 404(IDOR 不可区分)', async () => {
        db.batchFile.findUnique.mockResolvedValue(fileRow({ user_id: OTHER }));
        const resp = await handleBatchApi(req('GET', '/files/file-abc'), '/files/file-abc', '');
        expect(resp.status).toBe(404);
    });

    it('content 下载:原字节 + octet-stream', async () => {
        db.batchFile.findUnique.mockResolvedValue(fileRow());
        const resp = await handleBatchApi(req('GET', '/files/file-abc/content'), '/files/file-abc/content', '');
        expect(resp.status).toBe(200);
        expect(resp.headers.get('content-type')).toBe('application/octet-stream');
        expect(await resp.text()).toBe('hello-jsonl');
    });

    it('DELETE 幂等按归属:count=0 → 404,count=1 → deleted:true', async () => {
        db.batchFile.deleteMany.mockResolvedValue({ count: 0 });
        expect((await handleBatchApi(req('DELETE', '/files/file-x'), '/files/file-x', '')).status).toBe(404);
        db.batchFile.deleteMany.mockResolvedValue({ count: 1 });
        const j = await (await handleBatchApi(req('DELETE', '/files/file-x'), '/files/file-x', '')).json();
        expect(j.deleted).toBe(true);
    });

    it('GET /v1/files 列表', async () => {
        db.batchFile.findMany.mockResolvedValue([fileRow()]);
        const j = await (await handleBatchApi(req('GET', '/files'), '/files', '')).json();
        expect(j.object).toBe('list');
        expect(j.data[0].id).toBe('file-abc');
    });
});

describe('POST /v1/batches', () => {
    const create = (body: unknown) =>
        handleBatchApi(
            req('POST', '/batches', {
                body: JSON.stringify(body),
                headers: { 'content-type': 'application/json' },
            }),
            '/batches',
            '',
        );

    it('endpoint 不在白名单 → 400 unsupported_endpoint', async () => {
        const resp = await create({ input_file_id: 'file-abc', endpoint: '/v1/chat/completions' });
        expect(resp.status).toBe(400);
        expect((await resp.json()).error.code).toBe('unsupported_endpoint');
    });

    it('缺 input_file_id → 400;completion_window 非 24h → 400', async () => {
        expect((await create({ endpoint: '/v1/images/generations' })).status).toBe(400);
        expect(
            (
                await create({
                    input_file_id: 'file-abc',
                    endpoint: '/v1/images/generations',
                    completion_window: '48h',
                })
            ).status,
        ).toBe(400);
    });

    it('输入文件不存在/非本人 → 404', async () => {
        db.batchFile.findUnique.mockResolvedValue(null);
        const resp = await create({ input_file_id: 'file-abc', endpoint: '/v1/images/generations' });
        expect(resp.status).toBe(404);
    });

    it('在途批次达上限 → 429', async () => {
        db.batchFile.findUnique.mockResolvedValue(fileRow());
        db.batch.count.mockResolvedValue(5);
        const resp = await create({ input_file_id: 'file-abc', endpoint: '/v1/images/generations' });
        expect(resp.status).toBe(429);
        expect((await resp.json()).error.code).toBe('batch_limit_reached');
    });

    it('happy → batch 对象:validating + expires_at=+24h + auth 头落库', async () => {
        db.batchFile.findUnique.mockResolvedValue(fileRow());
        db.batch.count.mockResolvedValue(0);
        db.batch.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve(batchRow({ ...data })),
        );
        const resp = await create({
            input_file_id: 'file-abc',
            endpoint: '/v1/images/generations',
            completion_window: '24h',
            metadata: { job: 'nightly' },
        });
        expect(resp.status).toBe(200);
        const j = await resp.json();
        expect(j).toMatchObject({
            object: 'batch',
            status: 'validating',
            endpoint: '/v1/images/generations',
            input_file_id: 'file-abc',
            completion_window: '24h',
            metadata: { job: 'nightly' },
            request_counts: { total: 0, completed: 0, failed: 0 },
        });
        expect(j.expires_at - j.created_at).toBe(24 * 3600);
        expect(db.batch.create.mock.calls[0][0].data.auth_header).toBe(AUTH);
    });
});

describe('GET / cancel /v1/batches/*', () => {
    it('查不到/非本人 → 404;命中 → 信封', async () => {
        db.batch.findUnique.mockResolvedValue(null);
        expect((await handleBatchApi(req('GET', '/batches/batch_x'), '/batches/batch_x', '')).status).toBe(404);
        db.batch.findUnique.mockResolvedValue(batchRow({ status: 'in_progress', started_at: NOW, total_count: 3 }));
        const j = await (await handleBatchApi(req('GET', '/batches/batch_abc'), '/batches/batch_abc', '')).json();
        expect(j.status).toBe('in_progress');
        expect(j.in_progress_at).toBe(Math.floor(NOW.getTime() / 1000));
        expect(j.request_counts.total).toBe(3);
    });

    it('cancel:置 cancel_requested + 返回最新状态', async () => {
        db.batch.updateMany.mockResolvedValue({ count: 1 });
        db.batch.findUnique.mockResolvedValue(batchRow({ status: 'cancelling', cancel_requested: true }));
        const resp = await handleBatchApi(req('POST', '/batches/batch_abc/cancel'), '/batches/batch_abc/cancel', '');
        expect(resp.status).toBe(200);
        expect((await resp.json()).status).toBe('cancelling');
        expect(db.batch.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ id: 'batch_abc', user_id: USER }),
                data: { cancel_requested: true, status: 'cancelling' },
            }),
        );
    });

    it('列表信封带 first/last id', async () => {
        db.batch.findMany.mockResolvedValue([batchRow(), batchRow({ id: 'batch_def' })]);
        const j = await (await handleBatchApi(req('GET', '/batches'), '/batches', '')).json();
        expect(j.first_id).toBe('batch_abc');
        expect(j.last_id).toBe('batch_def');
    });

    it('未知子路由 → 404', async () => {
        const resp = await handleBatchApi(req('PUT', '/batches/batch_abc'), '/batches/batch_abc', '');
        expect(resp.status).toBe(404);
    });
});
