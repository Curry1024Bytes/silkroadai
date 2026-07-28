/**
 * 火山引擎 SignerV4(HMAC-SHA256)服务端验签(2026-07-28)。
 *
 * 客户用火山官方 SDK / 我们兼容脚本(cqxy_sign.py / createAsset.py)以 AK/SK 签名:
 *   Authorization: HMAC-SHA256 Credential=<AK>/<yyyymmdd>/<region>/<service>/request,
 *                  SignedHeaders=<h1;h2;…>, Signature=<hex>
 *   X-Date: 20260728T142833Z
 *   X-Content-Sha256: <sha256(body) hex>
 * 本模块按同一算法重算签名比对,验证请求确由持 SK 的客户发出。纯函数 + node:crypto,好测。
 *
 * 算法(与客户脚本逐字一致):
 *  1. CanonicalRequest = METHOD\nPATH\nCANONICAL_QUERY\nCANONICAL_HEADERS\n\nSIGNED_HEADERS\nX_CONTENT_SHA256
 *     - CANONICAL_QUERY:key 字典序,quote(key)=quote(val),'&' 连接,+→%20
 *     - CANONICAL_HEADERS:每个 signed header "name:value\n"(name 小写,按 signed 顺序)
 *  2. StringToSign = "HMAC-SHA256\n"+X_DATE+"\n"+CREDENTIAL_SCOPE+"\n"+sha256(CanonicalRequest)
 *  3. kSigning = HMAC(HMAC(HMAC(HMAC(SK, shortDate), region), service), "request")
 *  4. Signature = HMAC(kSigning, StringToSign) hex
 */
import 'server-only';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const CLOCK_SKEW_SEC = 900; // X-Date 与服务器时间容差(客户脚本文档写 300s,放宽到 900s 防时钟漂移)

export interface ParsedAuth {
    accessKey: string;
    shortDate: string; // yyyymmdd
    region: string;
    service: string;
    signedHeaders: string[]; // 小写,按签名顺序
    signature: string; // hex
}

/** 解析 Authorization 头。非 HMAC-SHA256 形态返回 null。 */
export function parseVolcAuthorization(header: string | null): ParsedAuth | null {
    if (!header || !header.startsWith('HMAC-SHA256')) return null;
    const cred = /Credential=([^,\s]+)/.exec(header)?.[1];
    const signed = /SignedHeaders=([^,\s]+)/.exec(header)?.[1];
    const sig = /Signature=([0-9a-fA-F]+)/.exec(header)?.[1];
    if (!cred || !signed || !sig) return null;
    // Credential = AK/yyyymmdd/region/service/request
    const parts = cred.split('/');
    if (parts.length !== 5 || parts[4] !== 'request') return null;
    const [accessKey, shortDate, region, service] = parts;
    if (!/^\d{8}$/.test(shortDate)) return null;
    return {
        accessKey,
        shortDate,
        region,
        service,
        signedHeaders: signed.split(';').map((h) => h.toLowerCase()),
        signature: sig.toLowerCase(),
    };
}

function sha256Hex(s: string): string {
    return createHash('sha256').update(s, 'utf8').digest('hex');
}
function hmac(key: Buffer | string, data: string): Buffer {
    return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** 规范化 query(与客户 norm_query 一致:key 字典序 + quote + %20)。 */
function canonicalQuery(params: URLSearchParams): string {
    const enc = (s: string) =>
        encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    const pairs: string[] = [];
    const keys = [...new Set([...params.keys()])].sort();
    for (const k of keys) {
        for (const v of params.getAll(k).sort()) pairs.push(`${enc(k)}=${enc(v)}`);
    }
    return pairs.join('&');
}

/** X-Date(20260728T142833Z)距今是否在容差内。 */
export function xDateWithinSkew(xDate: string, nowMs = Date.now()): boolean {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(xDate);
    if (!m) return false;
    const [, y, mo, d, h, mi, s] = m;
    const t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
    return Math.abs(nowMs - t) <= CLOCK_SKEW_SEC * 1000;
}

export interface VerifyInput {
    method: string;
    path: string; // REQUEST_PATH,如 /api
    query: URLSearchParams; // 不含 '?'
    /** 请求头(原样,用于取 signed headers 的值 + x-date/x-content-sha256)。 */
    headers: Headers;
    /** 原始请求体字符串(空则空串)。 */
    rawBody: string;
    /** 该 AK 对应的 SK 明文(调用方按 accessKey 查库解密后传入)。 */
    secretKey: string;
    parsed: ParsedAuth;
    nowMs?: number;
}

/** 重算签名并常量时间比对。签名正确且 X-Date 未过期 → true。 */
export function verifyVolcSignature(inp: VerifyInput): boolean {
    const { parsed, headers } = inp;
    const xDate = headers.get('x-date') || '';
    if (!xDateWithinSkew(xDate, inp.nowMs)) return false;

    // X-Content-Sha256:优先用头里的值(客户已算);否则按 body 现算并要求匹配
    const bodyHash = sha256Hex(inp.rawBody);
    const headerContentHash = (headers.get('x-content-sha256') || '').toLowerCase();
    if (headerContentHash && headerContentHash !== bodyHash) return false;
    const xContentSha256 = headerContentHash || bodyHash;

    const canonicalHeaders = parsed.signedHeaders
        .map((h) => {
            if (h === 'x-content-sha256') return `x-content-sha256:${xContentSha256}`;
            if (h === 'x-date') return `x-date:${xDate}`;
            if (h === 'host') return `host:${headers.get('host') ?? ''}`;
            return `${h}:${headers.get(h) ?? ''}`;
        })
        .join('\n');

    const canonicalRequest = [
        inp.method.toUpperCase(),
        inp.path,
        canonicalQuery(inp.query),
        canonicalHeaders,
        '',
        parsed.signedHeaders.join(';'),
        xContentSha256,
    ].join('\n');

    const credentialScope = [parsed.shortDate, parsed.region, parsed.service, 'request'].join('/');
    const stringToSign = ['HMAC-SHA256', xDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

    const kDate = hmac(inp.secretKey, parsed.shortDate);
    const kRegion = hmac(kDate, parsed.region);
    const kService = hmac(kRegion, parsed.service);
    const kSigning = hmac(kService, 'request');
    const expected = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(parsed.signature, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
}
