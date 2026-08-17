/**
 * image2 错误统一分类器(第 2 步终态:错误体 + 状态码全对齐官方)。
 * fixture 全部取自 2026-08-11 ~ 08-17 生产日志真实文案(见 image2-error-code-unification-brief.md)。
 */
import { describe, it, expect } from 'vitest';
import { normalizeImageError, IMAGE_SAFETY_RE, IMAGE_SAFETY_BODY } from '../[...path]/error-normalize';

interface OfficialError {
    error: { message: string; type: string; param: string | null; code: string | null };
}

function parse(body: string): OfficialError['error'] {
    return (JSON.parse(body) as OfficialError).error;
}

/** 所有改写后的体都不许携带内部信息。 */
function expectNoLeak(body: string) {
    const low = body.toLowerCase();
    for (const leak of ['adobe', 'westus3', 'eastus2', 'distributor', 'read tcp', 'we-token', '分组', '渠道']) {
        expect(low).not.toContain(leak);
    }
}

describe('normalizeImageError — 内容审核(恒 400 统一体)', () => {
    const cases: Array<[string, number]> = [
        [
            'adobe content rejected: status 451 {"error_code":"image_unsafe","message":"The generated images appear to be unsafe. Try modifying the prompts or the seeds."}',
            400,
        ],
        ['adobe content rejected: status 451 {"error_code":"legal_error","message":"{}"}', 400],
        ['content rejected: the image was flagged as unsafe by the content safety system', 400],
        // azure 审核原文线上以 500 出现过 —— 也必须归审核 + 恒 400
        ['Your request was rejected by the safety system. If you believe this is an error, contact us', 500],
        ['Your request was rejected as a result of our safety system.', 400],
    ];
    it.each(cases)('%s → 400 moderation_blocked', (text, status) => {
        const r = normalizeImageError(text, status);
        expect(r.status).toBe(400);
        expect(r.body).toBe(IMAGE_SAFETY_BODY);
        const e = parse(r.body);
        expect(e.code).toBe('moderation_blocked');
        expect(e.type).toBe('user_error');
        expectNoLeak(r.body);
    });

    it('仅提到 adobe 的错误(如超时)不冒充审核', () => {
        expect(IMAGE_SAFETY_RE.test('adobe upstream timeout after 300s')).toBe(false);
    });
});

describe('normalizeImageError — 余额/鉴权', () => {
    it('quota is not enough → 429 insufficient_quota(官方计费语义,new-api 原生 403)', () => {
        const r = normalizeImageError('quota is not enough', 403);
        expect(r.status).toBe(429);
        const e = parse(r.body);
        expect(e.code).toBe('insufficient_quota');
        expect(e.type).toBe('insufficient_quota');
    });

    it.each([['Invalid token (request id: X)'], ['无效的令牌']])('%s → 401 invalid_api_key', (text) => {
        const r = normalizeImageError(text, 401);
        expect(r.status).toBe(401);
        const e = parse(r.body);
        expect(e.code).toBe('invalid_api_key');
        expect(e.type).toBe('invalid_request_error');
    });
});

describe('normalizeImageError — 限流(rate_limit_exceeded + Retry-After)', () => {
    it('we-token throttled retry-after=3s → 429 + 提取退避秒数(此前对客 408)', () => {
        const r = normalizeImageError('adobe throttled: status 429 retry-after=3s envoy=true', 408);
        expect(r.status).toBe(429);
        expect(r.retryAfter).toBe(3);
        const e = parse(r.body);
        expect(e.code).toBe('rate_limit_exceeded');
        expect(e.type).toBe('rate_limit_error');
        expect(e.message).toContain('3s');
        expectNoLeak(r.body);
    });

    const plain: Array<[string, number]> = [
        [
            'adobe throttled: status 408 retry-after=none envoy=false {"error_code":"timeout_error","message":"system under load"}',
            408,
        ],
        ['bad response status code 408', 408],
        ['Image generation concurrency limit exceeded, please retry later', 429],
        ['Your requests to gpt-image-2 for gpt-image-2 in westus3 have exceeded rate limit.', 429],
    ];
    it.each(plain)('%s → 429 rate_limit_exceeded,缺省退避 30', (text, status) => {
        const r = normalizeImageError(text, status);
        expect(r.status).toBe(429);
        expect(r.retryAfter).toBe(30);
        expect(parse(r.body).code).toBe('rate_limit_exceeded');
        expectNoLeak(r.body);
    });
});

describe('normalizeImageError — 请求本身错(不再透传嵌套 JSON)', () => {
    it('Invalid image file for image 2 → invalid_image + 保留第几张', () => {
        const r = normalizeImageError(
            'adobe bad request: status 400 {"error_code":"bad_request","message":"Bad request to openai: Invalid image file or mode for image 2, please check your request"}',
            400,
        );
        expect(r.status).toBe(400);
        const e = parse(r.body);
        expect(e.code).toBe('invalid_image');
        expect(e.param).toBe('image');
        expect(e.message).toContain('image 2');
        expect(r.body).not.toContain('error_code'); // 嵌套 JSON 不出门
        expectNoLeak(r.body);
    });

    it('prompt is required → param=prompt', () => {
        const e = parse(normalizeImageError('prompt is required', 400).body);
        expect(e.param).toBe('prompt');
        expect(e.type).toBe('invalid_request_error');
    });

    it('validation_error(undefined mention)→ invalid_request 兜底', () => {
        const r = normalizeImageError(
            'adobe bad request: status 422 {"error_code":"validation_error","message":"Undefined mention(s) in prompt: screenshot-2026-08-10."}',
            400,
        );
        expect(parse(r.body).code).toBe('invalid_request');
        expectNoLeak(r.body);
    });
});

describe('normalizeImageError — 容量(overloaded)', () => {
    const cases: Array<[string, number]> = [
        ['分组 default 下模型 gpt-image-2 无可用渠道（distributor） (request id: X)', 429],
        ['The server is temporarily unable to process this request, please retry later.', 503],
        ['Service temporarily unavailable', 503],
    ];
    it.each(cases)('%s → 503 server_error overloaded', (text, status) => {
        const r = normalizeImageError(text, status);
        expect(r.status).toBe(503);
        const e = parse(r.body);
        expect(e.type).toBe('server_error');
        expect(e.code).toBeNull();
        expect(e.message).toContain('overloaded');
        expectNoLeak(r.body);
    });
});

describe('normalizeImageError — 上游临时错(server_error,raw 原文不出门)', () => {
    const cases: Array<[string, number]> = [
        ['adobe temporary error: Post "https://x.we-token.cc/v1/images/edits": unexpected EOF', 400],
        ['adobe temporary error: Post "https://x.we-token.cc/v1/images/edits": context deadline exceeded', 400],
        ['bad response status code 404', 404],
        ['bad response status code 504', 504],
        ['upstream error: do request failed', 500],
        ['read tcp 10.0.0.1:35870->1.2.3.4:443: read: connection reset by peer', 500],
        ['some never-seen-before upstream failure', 502], // 未识别 5xx 也进 server_error 桶
    ];
    it.each(cases)('%s → 500 server_error', (text, status) => {
        const r = normalizeImageError(text, status);
        expect(r.status).toBe(500);
        const e = parse(r.body);
        expect(e.type).toBe('server_error');
        expect(e.code).toBeNull();
        expectNoLeak(r.body);
    });
});

describe('normalizeImageError — default 桶(未识别 4xx 原样透传,仅抹品牌)', () => {
    it('未识别 400 文案不改写,只做品牌脱敏', () => {
        const r = normalizeImageError('adobe said something novel', 400);
        expect(r.status).toBe(400);
        expect(r.body).toBe('the provider said something novel');
        expect(r.retryAfter).toBeUndefined();
    });

    it('已是官方形的上游错误体原样透传', () => {
        const body = JSON.stringify({ error: { message: 'blocked', type: 'invalid_request_error', code: 'x_custom' } });
        expect(normalizeImageError(body, 400).body).toBe(body);
    });
});
