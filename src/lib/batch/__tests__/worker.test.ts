/**
 * Batch worker(sweepBatches)单测 — mock store 层 + global fetch。
 * 断言:validating 校验分流(in_progress / failed)、行执行走 self-fetch(auth 头 +
 * JSON body)、结果落库与终态组装(output/error 文件)、取消、过期、重启续跑(已有
 * 行跳过)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
    claimValidating: vi.fn(),
    createFile: vi.fn(),
    finalizeBatch: vi.fn(),
    getFileInternal: vi.fn(),
    listExpiredBatches: vi.fn(),
    listLineResults: vi.fn(),
    markInProgress: vi.fn(),
    markValidationFailed: vi.fn(),
    nextRunnableBatch: vi.fn(),
    refreshBatch: vi.fn(),
    saveLineResult: vi.fn(),
}));
vi.mock('../store', () => store);
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { sweepBatches } from '../worker';

const AUTH = 'Bearer sk-' + 'a'.repeat(48);
const EP = '/v1/images/generations';

const batch = (over: Record<string, unknown> = {}) => ({
    id: 'batch_abc',
    user_id: 'u1',
    endpoint: EP,
    input_file_id: 'file-in',
    status: 'in_progress',
    output_file_id: null,
    error_file_id: null,
    total_count: 2,
    completed_count: 0,
    failed_count: 0,
    errors_json: null,
    metadata_json: null,
    cancel_requested: false,
    auth_header: AUTH,
    created_at: new Date('2026-08-29T00:00:00Z'),
    started_at: null,
    finished_at: null,
    ...over,
});

const inputJsonl = Buffer.from(
    [
        JSON.stringify({ custom_id: 'r1', method: 'POST', url: EP, body: { model: 'gpt-image-2', prompt: 'a' } }),
        JSON.stringify({ custom_id: 'r2', method: 'POST', url: EP, body: { model: 'gpt-image-2', prompt: 'b' } }),
    ].join('\n') + '\n',
    'utf8',
);
const fileRow = { id: 'file-in', user_id: 'u1', purpose: 'batch', filename: 'in.jsonl', bytes: 1, content: inputJsonl };

const mockFetch = vi.fn();

/** 有状态的行结果存储:saveLineResult 落进数组,listLineResults 回放 —— 模拟真 DB。 */
let savedResults: Array<Record<string, unknown>>;

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    savedResults = [];
    store.listExpiredBatches.mockResolvedValue([]);
    store.claimValidating.mockResolvedValue(null);
    store.nextRunnableBatch.mockResolvedValue(null);
    store.getFileInternal.mockResolvedValue(fileRow);
    store.listLineResults.mockImplementation(() => Promise.resolve([...savedResults]));
    store.saveLineResult.mockImplementation((r: Record<string, unknown>) => {
        savedResults.push(r);
        return Promise.resolve();
    });
    store.refreshBatch.mockImplementation(() => Promise.resolve(batch()));
    store.createFile.mockImplementation((_u: string, purpose: string) =>
        Promise.resolve({ id: purpose === 'batch_output' ? 'file-out' : 'file-err' }),
    );
    store.finalizeBatch.mockResolvedValue(undefined);
});
afterEach(() => {
    vi.unstubAllGlobals();
});

function okImageResponse() {
    return new Response(JSON.stringify({ created: 1, data: [{ url: 'https://images.silkroadai.io/gen/x.png' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

describe('validating 阶段', () => {
    it('合法输入 → markInProgress(带行数)', async () => {
        store.claimValidating.mockResolvedValueOnce(batch({ status: 'validating' })).mockResolvedValue(null);
        const r = await sweepBatches();
        expect(store.markInProgress).toHaveBeenCalledWith('batch_abc', 2);
        expect(r.validated).toBe(1);
    });

    it('坏输入 → markValidationFailed(errors 形)', async () => {
        store.claimValidating.mockResolvedValueOnce(batch({ status: 'validating' })).mockResolvedValue(null);
        store.getFileInternal.mockResolvedValue({ ...fileRow, content: Buffer.from('not-json{\n', 'utf8') });
        await sweepBatches();
        expect(store.markValidationFailed).toHaveBeenCalledWith(
            'batch_abc',
            expect.objectContaining({ object: 'list' }),
        );
        expect(store.markInProgress).not.toHaveBeenCalled();
    });

    it('输入文件已删 → failed(file_not_found)', async () => {
        store.claimValidating.mockResolvedValueOnce(batch({ status: 'validating' })).mockResolvedValue(null);
        store.getFileInternal.mockResolvedValue(null);
        await sweepBatches();
        const errs = store.markValidationFailed.mock.calls[0][1] as { data: Array<{ code: string }> };
        expect(errs.data[0].code).toBe('file_not_found');
    });
});

describe('执行阶段', () => {
    it('逐行 self-fetch 重放(auth 头 + JSON body)→ 全 2xx → completed + output 文件', async () => {
        store.nextRunnableBatch.mockResolvedValue(batch());
        mockFetch.mockImplementation(() => Promise.resolve(okImageResponse()));
        const r = await sweepBatches();

        expect(r.linesRun).toBe(2);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toMatch(/\/v1\/images\/generations$/);
        expect((init.headers as Record<string, string>).authorization).toBe(AUTH);
        expect(JSON.parse(String(init.body)).model).toBe('gpt-image-2');

        // 终态:output 文件建了、error 文件没建、completed
        expect(store.createFile).toHaveBeenCalledTimes(1);
        const [, purpose, filename, buf] = store.createFile.mock.calls[0] as [string, string, string, Buffer];
        expect(purpose).toBe('batch_output');
        expect(filename).toBe('batch_abc_output.jsonl');
        const lines = buf
            .toString('utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l));
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatchObject({ custom_id: 'r1', error: null });
        expect(lines[0].response.status_code).toBe(200);
        expect(store.finalizeBatch).toHaveBeenCalledWith('batch_abc', 'completed', 'file-out', null);
        expect(r.finalized).toBe(1);
    });

    it('行失败(非 2xx)→ error_json 落库 + error 文件', async () => {
        store.nextRunnableBatch.mockResolvedValue(batch());
        mockFetch
            .mockResolvedValueOnce(okImageResponse())
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ error: { message: 'boom', type: 'api_error' } }), { status: 502 }),
            );
        await sweepBatches();
        expect(store.createFile).toHaveBeenCalledTimes(2);
        expect(store.finalizeBatch).toHaveBeenCalledWith('batch_abc', 'completed', 'file-out', 'file-err');
        const errRow = savedResults.find((r) => r.status_code === 502);
        expect(errRow?.custom_id).toBeDefined();
        expect((errRow?.error_json as Record<string, unknown>).error).toBeDefined();
    });

    it('fetch 抛错(超时/网络)→ 合成 500 结果,不炸 sweep', async () => {
        store.nextRunnableBatch.mockResolvedValue(batch());
        mockFetch.mockRejectedValue(new Error('timeout'));
        const r = await sweepBatches();
        expect(r.linesRun).toBe(2);
        expect(savedResults.every((x) => x.status_code === 500)).toBe(true);
    });

    it('重启续跑:已有结果的行跳过,只补缺的', async () => {
        store.nextRunnableBatch.mockResolvedValue(batch());
        savedResults.push({
            batch_id: 'batch_abc',
            line_no: 0,
            custom_id: 'r1',
            status_code: 200,
            response_json: { data: [] },
            error_json: null,
        });
        mockFetch.mockImplementation(() => Promise.resolve(okImageResponse()));
        const r = await sweepBatches();
        expect(r.linesRun).toBe(1);
        expect(JSON.parse(String((mockFetch.mock.calls[0] as [string, RequestInit])[1].body)).prompt).toBe('b');
    });

    it('cancelling → 不执行行,按已有结果收尾成 cancelled', async () => {
        store.nextRunnableBatch.mockResolvedValue(batch({ status: 'cancelling', cancel_requested: true }));
        await sweepBatches();
        expect(mockFetch).not.toHaveBeenCalled();
        expect(store.finalizeBatch).toHaveBeenCalledWith('batch_abc', 'cancelled', null, null);
    });

    it('全部行已有结果(上轮跑完崩在 finalize 前)→ 直接 completed', async () => {
        store.nextRunnableBatch.mockResolvedValue(batch());
        savedResults.push(
            {
                batch_id: 'batch_abc',
                line_no: 0,
                custom_id: 'r1',
                status_code: 200,
                response_json: {},
                error_json: null,
            },
            {
                batch_id: 'batch_abc',
                line_no: 1,
                custom_id: 'r2',
                status_code: 200,
                response_json: {},
                error_json: null,
            },
        );
        const r = await sweepBatches();
        expect(mockFetch).not.toHaveBeenCalled();
        expect(store.finalizeBatch).toHaveBeenCalledWith('batch_abc', 'completed', 'file-out', null);
        expect(r.finalized).toBe(1);
    });
});

describe('过期', () => {
    it('超窗批次 → expired(带已有部分结果)', async () => {
        store.listExpiredBatches.mockResolvedValue([batch()]);
        savedResults.push({
            batch_id: 'batch_abc',
            line_no: 0,
            custom_id: 'r1',
            status_code: 200,
            response_json: {},
            error_json: null,
        });
        const r = await sweepBatches();
        expect(store.finalizeBatch).toHaveBeenCalledWith('batch_abc', 'expired', 'file-out', null);
        expect(r.expired).toBe(1);
    });
});
