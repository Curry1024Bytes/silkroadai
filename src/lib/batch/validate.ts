/**
 * Batch 输入 JSONL 校验(纯函数,零 IO)。
 *
 * 每行(对齐 OpenAI Batch 输入格式):
 *   { "custom_id": "req-1", "method": "POST", "url": "/v1/images/generations", "body": {...} }
 *
 * 规则:
 *  - 行数 ≤ maxRequests(默认 1000,env BATCH_MAX_REQUESTS;生图逐张真金白银,
 *    不照抄官方 50k —— 一批 5 万张图 24h 也跑不完)
 *  - custom_id 非空字符串且全文件唯一;method 只收 POST;url 必须等于 batch.endpoint
 *  - body 为对象且 model 是字符串(其余字段交给同步管线守门,这里不重复造校验)
 *  - `response_format:"b64_json"` 就地删掉 → 走管线默认(出图 URL 落图床)。
 *    不删的话 1000 行 base64 会把 output 文件撑到 GB 级;URL 形对齐官方
 *    「batch 里用远程引用控制体积」的建议。
 *
 * 失败信息包成 OpenAI batch.errors 形:{ object:'list', data:[{code,message,line,param}] }。
 */

export interface ParsedBatchLine {
    lineNo: number; // 0-based(错误信息对客展示时 +1)
    customId: string;
    body: Record<string, unknown>;
}

export interface BatchValidationError {
    code: string;
    message: string;
    line: number; // 1-based,对齐 OpenAI
    param: null;
}

export type BatchValidation =
    | { ok: true; lines: ParsedBatchLine[] }
    | { ok: false; errors: { object: 'list'; data: BatchValidationError[] } };

export function maxBatchRequests(): number {
    const n = Number(process.env.BATCH_MAX_REQUESTS || '1000');
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1000;
}

const MAX_REPORTED_ERRORS = 20; // 错误明细上限,别把一个全坏的文件的 1000 条错都回给客户

export function validateBatchInput(content: Buffer | Uint8Array, endpoint: string): BatchValidation {
    const text = Buffer.from(content).toString('utf8');
    // 只丢尾部空行;中间空行按行号计(客户能对上自己文件的行号)
    const rawLines = text.split(/\r?\n/);
    while (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() === '') rawLines.pop();

    const errors: BatchValidationError[] = [];
    const fail = (code: string, message: string, lineNo: number): void => {
        if (errors.length < MAX_REPORTED_ERRORS) errors.push({ code, message, line: lineNo + 1, param: null });
    };

    const cap = maxBatchRequests();
    if (rawLines.length === 0) fail('empty_batch', 'input file has no requests', 0);
    if (rawLines.length > cap) fail('batch_too_large', `batch has ${rawLines.length} requests, max is ${cap}`, 0);

    const lines: ParsedBatchLine[] = [];
    const seenIds = new Set<string>();
    if (errors.length === 0) {
        for (let i = 0; i < rawLines.length; i++) {
            const raw = rawLines[i].trim();
            if (raw === '') {
                fail('invalid_json_line', 'empty line', i);
                continue;
            }
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch {
                fail('invalid_json_line', 'line is not valid JSON', i);
                continue;
            }
            const obj = parsed as Record<string, unknown>;
            const customId = obj.custom_id;
            if (typeof customId !== 'string' || customId.trim() === '') {
                fail('missing_custom_id', 'each line must have a non-empty string custom_id', i);
                continue;
            }
            if (seenIds.has(customId)) {
                fail('duplicate_custom_id', `duplicate custom_id "${customId}"`, i);
                continue;
            }
            seenIds.add(customId);
            if (obj.method !== 'POST') {
                fail('invalid_method', 'method must be "POST"', i);
                continue;
            }
            if (obj.url !== endpoint) {
                fail('invalid_url', `url must be "${endpoint}" (the batch endpoint)`, i);
                continue;
            }
            const body = obj.body;
            if (typeof body !== 'object' || body === null || Array.isArray(body)) {
                fail('invalid_body', 'body must be a JSON object', i);
                continue;
            }
            const b = body as Record<string, unknown>;
            if (typeof b.model !== 'string' || b.model.trim() === '') {
                fail('missing_model', 'body.model must be a non-empty string', i);
                continue;
            }
            if (b.response_format === 'b64_json') delete b.response_format; // 见文件头
            lines.push({ lineNo: i, customId, body: b });
        }
    }

    if (errors.length > 0) return { ok: false, errors: { object: 'list', data: errors } };
    return { ok: true, lines };
}
