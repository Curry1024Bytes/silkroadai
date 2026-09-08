/**
 * Batch 输入 JSONL 校验(纯函数)单测。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { validateBatchInput, maxBatchRequests } from '../validate';

const EP = '/v1/images/generations';

function jsonl(...lines: unknown[]): Buffer {
    return Buffer.from(lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n', 'utf8');
}

function line(overrides: Record<string, unknown> = {}, bodyOverrides: Record<string, unknown> = {}) {
    return {
        custom_id: 'req-1',
        method: 'POST',
        url: EP,
        body: { model: 'gpt-image-2', prompt: 'a cat', ...bodyOverrides },
        ...overrides,
    };
}

afterEach(() => {
    delete process.env.BATCH_MAX_REQUESTS;
});

describe('validateBatchInput', () => {
    it('happy path:两行合法 → ok + 行序/内容保留', () => {
        const v = validateBatchInput(jsonl(line(), line({ custom_id: 'req-2' })), EP);
        expect(v.ok).toBe(true);
        if (!v.ok) return;
        expect(v.lines).toHaveLength(2);
        expect(v.lines[0]).toMatchObject({ lineNo: 0, customId: 'req-1' });
        expect(v.lines[1]).toMatchObject({ lineNo: 1, customId: 'req-2' });
        expect(v.lines[0].body.model).toBe('gpt-image-2');
    });

    it('CRLF 换行 + 尾部空行都容忍', () => {
        const text = JSON.stringify(line()) + '\r\n' + JSON.stringify(line({ custom_id: 'r2' })) + '\r\n\r\n';
        const v = validateBatchInput(Buffer.from(text, 'utf8'), EP);
        expect(v.ok).toBe(true);
        if (v.ok) expect(v.lines).toHaveLength(2);
    });

    it('空文件 → empty_batch', () => {
        const v = validateBatchInput(Buffer.from('', 'utf8'), EP);
        expect(v.ok).toBe(false);
        if (v.ok) return;
        expect(v.errors.data[0].code).toBe('empty_batch');
    });

    it('超行数上限 → batch_too_large(env 可调)', () => {
        process.env.BATCH_MAX_REQUESTS = '2';
        expect(maxBatchRequests()).toBe(2);
        const v = validateBatchInput(jsonl(line(), line({ custom_id: 'r2' }), line({ custom_id: 'r3' })), EP);
        expect(v.ok).toBe(false);
        if (v.ok) return;
        expect(v.errors.data[0].code).toBe('batch_too_large');
    });

    it('坏 JSON 行 → invalid_json_line,line 号是 1-based', () => {
        const v = validateBatchInput(jsonl(line(), 'not-json{'), EP);
        expect(v.ok).toBe(false);
        if (v.ok) return;
        expect(v.errors.data[0]).toMatchObject({ code: 'invalid_json_line', line: 2 });
    });

    it('缺/空 custom_id → missing_custom_id;重复 → duplicate_custom_id', () => {
        const v1 = validateBatchInput(jsonl(line({ custom_id: '' })), EP);
        expect(!v1.ok && v1.errors.data[0].code).toBe('missing_custom_id');
        const v2 = validateBatchInput(jsonl(line(), line()), EP);
        expect(!v2.ok && v2.errors.data[0].code).toBe('duplicate_custom_id');
    });

    it('method 非 POST / url 不等于 batch endpoint → 拒', () => {
        const v1 = validateBatchInput(jsonl(line({ method: 'GET' })), EP);
        expect(!v1.ok && v1.errors.data[0].code).toBe('invalid_method');
        const v2 = validateBatchInput(jsonl(line({ url: '/v1/chat/completions' })), EP);
        expect(!v2.ok && v2.errors.data[0].code).toBe('invalid_url');
    });

    it('body 非对象 / 缺 model → 拒', () => {
        const v1 = validateBatchInput(jsonl(line({ body: 'x' })), EP);
        expect(!v1.ok && v1.errors.data[0].code).toBe('invalid_body');
        const v2 = validateBatchInput(jsonl(line({}, { model: undefined })), EP);
        expect(!v2.ok && v2.errors.data[0].code).toBe('missing_model');
    });

    it('response_format=b64_json 被就地删掉(输出走图床 URL);url 形保留', () => {
        const v = validateBatchInput(
            jsonl(line({}, { response_format: 'b64_json' }), line({ custom_id: 'r2' }, { response_format: 'url' })),
            EP,
        );
        expect(v.ok).toBe(true);
        if (!v.ok) return;
        expect(v.lines[0].body.response_format).toBeUndefined();
        expect(v.lines[1].body.response_format).toBe('url');
    });

    it('一行坏不吞整文件的错误明细:多错并报(≤20 条)', () => {
        const v = validateBatchInput(jsonl('bad1{', 'bad2{', line()), EP);
        expect(v.ok).toBe(false);
        if (v.ok) return;
        expect(v.errors.data).toHaveLength(2);
        expect(v.errors.data.map((e) => e.line)).toEqual([1, 2]);
    });
});
