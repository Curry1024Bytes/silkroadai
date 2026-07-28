/** 火山 SignerV4 验签单测(2026-07-28):客户端签名(照 cqxy_sign.py 算法)往返验证。 */
import { describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { parseVolcAuthorization, verifyVolcSignature, xDateWithinSkew } from '../signer-v4';

const AK = 'ak_ent_' + 'a'.repeat(24);
const SK = 'sk_ent_' + 'b'.repeat(48);
const REGION = 'cn-beijing';
const SERVICE = 'ark';

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d, 'utf8').digest();

/** 复刻客户 cqxy_sign.build_headers:对一次请求生成火山签名头。 */
function clientSign(method: string, path: string, query: URLSearchParams, body: string, xDate: string) {
    const shortDate = xDate.slice(0, 8);
    const xContent = sha256Hex(body);
    const signedHeaders = 'host;x-content-sha256;x-date';
    const host = 'internal';
    const canonicalHeaders = `host:${host}\nx-content-sha256:${xContent}\nx-date:${xDate}\n`;
    // canonical query:key 字典序 + encode
    const keys = [...new Set([...query.keys()])].sort();
    const cq = keys
        .flatMap((k) =>
            query
                .getAll(k)
                .sort()
                .map((v) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`),
        )
        .join('&');
    const canonicalRequest = [method.toUpperCase(), path, cq, canonicalHeaders, signedHeaders, xContent].join('\n');
    const scope = [shortDate, REGION, SERVICE, 'request'].join('/');
    const stringToSign = ['HMAC-SHA256', xDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const kDate = hmac(SK, shortDate);
    const kRegion = hmac(kDate, REGION);
    const kService = hmac(kRegion, SERVICE);
    const kSigning = hmac(kService, 'request');
    const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
    const authorization = `HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const headers = new Headers({ host, 'x-date': xDate, 'x-content-sha256': xContent, authorization });
    return { authorization, headers };
}

// 固定 X-Date + 对应 nowMs(避免时钟漂移;测试确定性)
const X_DATE = '20260728T142833Z';
const NOW = Date.UTC(2026, 6, 28, 14, 28, 40); // 距 xDate 7s

describe('parseVolcAuthorization', () => {
    it('解析 Credential/SignedHeaders/Signature', () => {
        const { authorization } = clientSign('POST', '/api', new URLSearchParams('Action=CreateAsset'), '{}', X_DATE);
        const p = parseVolcAuthorization(authorization);
        expect(p).not.toBeNull();
        expect(p!.accessKey).toBe(AK);
        expect(p!.region).toBe(REGION);
        expect(p!.service).toBe(SERVICE);
        expect(p!.signedHeaders).toEqual(['host', 'x-content-sha256', 'x-date']);
    });
    it('Bearer / 畸形 → null', () => {
        expect(parseVolcAuthorization('Bearer sk-ent-x')).toBeNull();
        expect(parseVolcAuthorization('HMAC-SHA256 Credential=x')).toBeNull();
        expect(parseVolcAuthorization(null)).toBeNull();
    });
});

describe('verifyVolcSignature', () => {
    it('客户端正确签名 → 验证通过', () => {
        const q = new URLSearchParams('Action=CreateAsset&Version=2024-01-01');
        const body = JSON.stringify({ GroupId: 'group-x', URL: 'https://x/a.png', AssetType: 'Image' });
        const { authorization, headers } = clientSign('POST', '/api', q, body, X_DATE);
        const parsed = parseVolcAuthorization(authorization)!;
        expect(
            verifyVolcSignature({
                method: 'POST',
                path: '/api',
                query: q,
                headers,
                rawBody: body,
                secretKey: SK,
                parsed,
                nowMs: NOW,
            }),
        ).toBe(true);
    });

    it('body 被篡改 → 验证失败', () => {
        const q = new URLSearchParams('Action=CreateAsset');
        const { authorization, headers } = clientSign('POST', '/api', q, '{"a":1}', X_DATE);
        const parsed = parseVolcAuthorization(authorization)!;
        expect(
            verifyVolcSignature({
                method: 'POST',
                path: '/api',
                query: q,
                headers,
                rawBody: '{"a":2}',
                secretKey: SK,
                parsed,
                nowMs: NOW,
            }),
        ).toBe(false);
    });

    it('SK 不对 → 验证失败', () => {
        const q = new URLSearchParams('Action=CreateAsset');
        const { authorization, headers } = clientSign('POST', '/api', q, '{}', X_DATE);
        const parsed = parseVolcAuthorization(authorization)!;
        expect(
            verifyVolcSignature({
                method: 'POST',
                path: '/api',
                query: q,
                headers,
                rawBody: '{}',
                secretKey: 'wrong-sk',
                parsed,
                nowMs: NOW,
            }),
        ).toBe(false);
    });

    it('X-Date 过期(超 900s)→ 验证失败', () => {
        const q = new URLSearchParams('Action=CreateAsset');
        const { authorization, headers } = clientSign('POST', '/api', q, '{}', X_DATE);
        const parsed = parseVolcAuthorization(authorization)!;
        const stale = Date.UTC(2026, 6, 28, 15, 0, 0); // 距 xDate ~31min
        expect(
            verifyVolcSignature({
                method: 'POST',
                path: '/api',
                query: q,
                headers,
                rawBody: '{}',
                secretKey: SK,
                parsed,
                nowMs: stale,
            }),
        ).toBe(false);
    });

    it('GET(空 body)+ 无 query → 验证通过', () => {
        const q = new URLSearchParams();
        const { authorization, headers } = clientSign('GET', '/api/v3/contents/generations/tasks/cgt-1', q, '', X_DATE);
        const parsed = parseVolcAuthorization(authorization)!;
        expect(
            verifyVolcSignature({
                method: 'GET',
                path: '/api/v3/contents/generations/tasks/cgt-1',
                query: q,
                headers,
                rawBody: '',
                secretKey: SK,
                parsed,
                nowMs: NOW,
            }),
        ).toBe(true);
    });
});

describe('xDateWithinSkew', () => {
    it('7s 内 true;31min true→false', () => {
        expect(xDateWithinSkew(X_DATE, NOW)).toBe(true);
        expect(xDateWithinSkew(X_DATE, Date.UTC(2026, 6, 28, 15, 0, 0))).toBe(false);
        expect(xDateWithinSkew('bad', NOW)).toBe(false);
    });
});
