/**
 * 按张计费图片上游 → azure gpt-image-2 伪装适配器(W10,设计见 image2-per-image-adapter-brief.md)。
 *
 * new-api 把 gpt-image-2 的请求(OpenAI Images 形)按渠道路由到这里,适配器:
 *  1. 【守门】只接盈利档 —— size=4K 全档、或 2K 且 quality=high(operator 2026-08-03 拍板)。
 *     其余(1k/2k-low/med、size 不明)→ 503,new-api RetryTimes failover 回 azure 渠道,
 *     客户无感;调上游【之前】拒,不花钱。4xx 会被 new-api 当终态甩给客户,所以守门必须 5xx。
 *  2. 调真实上游拿图(Authorization 透传 = 渠道 key 就是上游 key)。
 *  3. 【合成 usage】丢弃上游的假 token(ominiapi 恒报 1120,按现口径计费必亏),按请求参数
 *     查 OUT_TOKENS[size 档][quality] 合成 —— 与现有真 4K 渠道账单口径对齐(4k·medium≈3800
 *     校准到实测 avg_ct=3777 ≈ ¥0.25/张)。new-api 读 usage.input_tokens/output_tokens 计费。
 *  4. 上游任何失败(非 2xx / 无图 / 超时)→ 不合成 usage(不扣客户)+ 503 让 new-api 切渠道。
 *     上游是网关,按 memory failover-error-taxonomy:网关拒终态化零收益,一律让 azure 兜底。
 *
 * 图片存储 / C2PA 脱敏不在这层做 —— 客户代理回程(/v1 route reshape)已做,这层只返 b64+usage。
 */
import { NextRequest, NextResponse } from 'next/server';
import { IMAGE_PROVIDERS } from './providers';

export type ImageMode = 'generations' | 'edits';

const UPSTREAM_TIMEOUT_MS = 300_000; // 实测 ominiapi 4K 出图 54-92s,给足余量

// ============ token 合成表(核心计费杠杆)============
// 1k/1.5k 行 = OpenAI 官方 gpt-image 输出 token 表(azure 口径);2k/4k 行按 prod 实测校准:
// 4k·medium=3800 ≈ 真 4K 渠道 avg_ct 3777(售价 ~¥0.25/张);high=14000 对应实测图生图
// high 的上万 token 尾巴。守门放行的只有 4k 全档 + 2k-high,其余行留作后续放宽时的口径。
type Quality = 'low' | 'medium' | 'high';
type SizeTier = '1k' | '1.5k' | '2k' | '4k';
const OUT_TOKENS: Record<SizeTier, Record<Quality, number>> = {
    '1k': { low: 272, medium: 1056, high: 4160 },
    '1.5k': { low: 400, medium: 1568, high: 6208 },
    '2k': { low: 800, medium: 3000, high: 12000 },
    '4k': { low: 1000, medium: 3800, high: 14000 },
};
// 档位面积锚点(万像素):1024²=1.05M / 1536×1024=1.57M / 2048²=4.19M / 3840×2160=8.29M
const TIER_AREA: Array<{ tier: SizeTier; area: number }> = [
    { tier: '1k', area: 1024 * 1024 },
    { tier: '1.5k', area: 1536 * 1024 },
    { tier: '2k', area: 2048 * 2048 },
    { tier: '4k', area: 3840 * 2160 },
];

/** "3840x2160" → 就近档位;非 WxH(auto/缺省/比例串)→ null(守门按不明处理)。 */
export function sizeTier(size: string): SizeTier | null {
    const m = /^(\d{2,4})x(\d{2,4})$/.exec(size.trim());
    if (!m) return null;
    const area = Number(m[1]) * Number(m[2]);
    if (!(area > 0)) return null;
    let best: SizeTier = '1k';
    let bestDiff = Infinity;
    for (const { tier, area: a } of TIER_AREA) {
        const diff = Math.abs(area - a);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = tier;
        }
    }
    return best;
}

function normQuality(q: string): Quality {
    const s = q.trim().toLowerCase();
    return s === 'low' || s === 'high' ? s : 'medium'; // auto/缺省/未知 → medium(与 OpenAI 缺省一致)
}

/** 守门:只接「合成售价 > 上游单张成本」的档。operator 拍板 = 4K 全档 + 2K-high。 */
export function isProfitable(tier: SizeTier | null, quality: Quality): boolean {
    return tier === '4k' || (tier === '2k' && quality === 'high');
}

// ============ usage 合成 ============

/** prompt 文本 token 粗估(CJK ~1.5 tok/字,其余 ~1 tok/4 字符;同 /v1 route 口径)。 */
export function estimateTextTokens(s: string): number {
    if (!s) return 0;
    let cjk = 0;
    let other = 0;
    for (const ch of s) {
        const c = ch.codePointAt(0) ?? 0;
        if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff)) cjk++;
        else other++;
    }
    return Math.max(1, Math.ceil(cjk * 1.5 + other / 4));
}

/** dep-free 尺寸解析(PNG IHDR / JPEG SOF),读不出 → null(输入 token 按 1MP 兜底)。 */
function imageDimensions(buf: Buffer): { w: number; h: number } | null {
    if (
        buf.length >= 24 &&
        buf[0] === 0x89 &&
        buf[1] === 0x50 &&
        buf[2] === 0x4e &&
        buf[3] === 0x47 &&
        buf.toString('latin1', 12, 16) === 'IHDR'
    ) {
        const w = buf.readUInt32BE(16);
        const h = buf.readUInt32BE(20);
        return w > 0 && h > 0 ? { w, h } : null;
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
        let i = 2;
        while (i + 9 <= buf.length) {
            if (buf[i] !== 0xff) return null;
            const marker = buf[i + 1];
            if (marker === 0xff) {
                i += 1;
                continue;
            }
            if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
                i += 2;
                continue;
            }
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                const h = buf.readUInt16BE(i + 5);
                const w = buf.readUInt16BE(i + 7);
                return w > 0 && h > 0 ? { w, h } : null;
            }
            i += 2 + buf.readUInt16BE(i + 2);
        }
    }
    return null;
}

/** 单张输入图 token(edits 输入侧):85 + 每 MP 1500(校准到 prod edit avg pt≈1831)。 */
function inputImageTokens(dims: { w: number; h: number } | null): number {
    const mp = dims ? Math.max(1, Math.ceil((dims.w * dims.h) / 1_000_000)) : 1;
    return 85 + mp * 1500;
}

export interface SynthUsageInput {
    mode: ImageMode;
    tier: SizeTier;
    quality: Quality;
    prompt: string;
    /** edits 输入图的尺寸(读不出的项传 null,按 1MP 兜底)。 */
    inputImageDims: Array<{ w: number; h: number } | null>;
    /** 实际出图张数(按上游真实返回计,n>1 时按张累加)。 */
    imageCount: number;
}

/** 按请求参数合成 usage(彻底丢弃上游 token)。两套字段名都给:new-api openai_image 计费读
 *  input_tokens/output_tokens;中继型客户读 prompt_tokens/completion_tokens(同 /v1 route 先例)。 */
export function synthUsage(inp: SynthUsageInput): Record<string, unknown> {
    const perImage = OUT_TOKENS[inp.tier][inp.quality];
    const ct = perImage * Math.max(1, inp.imageCount);
    const textTokens = estimateTextTokens(inp.prompt);
    let imgTokens = 0;
    if (inp.mode === 'edits') for (const d of inp.inputImageDims) imgTokens += inputImageTokens(d);
    const pt = textTokens + imgTokens;
    return {
        input_tokens: pt,
        input_tokens_details: { text_tokens: textTokens, image_tokens: imgTokens },
        output_tokens: ct,
        output_tokens_details: { image_tokens: ct, text_tokens: 0 },
        total_tokens: pt + ct,
        prompt_tokens: pt,
        completion_tokens: ct,
    };
}

// ============ 错误与守门响应 ============

/** 5xx = 让 new-api 重试/failover 到其它 gpt-image-2 渠道(4xx 会被当终态甩给客户)。
 *  文案保持中性:所有渠道全挂时这段才会透出到客户。 */
function failover(code: string, detail: string): NextResponse {
    return NextResponse.json(
        {
            error: {
                message: 'The server is temporarily unable to process this request, please retry later.',
                type: 'server_error',
                code,
                detail,
            },
        },
        { status: 503 },
    );
}

/** 客户可见错误体脱敏:抹上游品牌名(provider brand + 常见来源词)。 */
export function sanitizeAdapterError(text: string, brand: RegExp): string {
    return text.replace(brand, 'the provider').replace(/\badobe\b/gi, 'the provider');
}

// ============ 入参解析 ============

interface ParsedRequest {
    prompt: string;
    size: string;
    quality: string;
    n: number;
    /** edits 的输入图(原始文件,透传给上游 + 量尺寸)。 */
    images: Array<{ buf: Buffer; type: string; name: string }>;
    /** 透传给上游的其余标量字段(model 强制 gpt-image-2,见 buildUpstreamBody)。 */
    extras: Record<string, string>;
}

const FORWARD_EXTRAS = new Set(['output_format', 'output_compression', 'background', 'user']);

async function parseIncoming(req: NextRequest, mode: ImageMode): Promise<ParsedRequest | null> {
    const ct = (req.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('multipart/form-data')) {
        const form = await req.formData().catch(() => null);
        if (!form) return null;
        const images: ParsedRequest['images'] = [];
        for (const key of ['image', 'image[]']) {
            for (const v of form.getAll(key)) {
                if (v instanceof File) {
                    images.push({
                        buf: Buffer.from(await v.arrayBuffer()),
                        type: v.type || 'image/png',
                        name: v.name || 'image.png',
                    });
                }
            }
        }
        const extras: Record<string, string> = {};
        for (const k of FORWARD_EXTRAS) {
            const v = form.get(k);
            if (typeof v === 'string' && v) extras[k] = v;
        }
        return {
            prompt: String(form.get('prompt') ?? ''),
            size: String(form.get('size') ?? ''),
            quality: String(form.get('quality') ?? ''),
            n: Math.max(1, Number(form.get('n')) || 1),
            images,
            extras,
        };
    }
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return null;
    const extras: Record<string, string> = {};
    for (const k of FORWARD_EXTRAS) {
        const v = body[k];
        if (typeof v === 'string' && v) extras[k] = v;
        else if (typeof v === 'number') extras[k] = String(v);
    }
    void mode;
    return {
        prompt: typeof body.prompt === 'string' ? body.prompt : '',
        size: typeof body.size === 'string' ? body.size : '',
        quality: typeof body.quality === 'string' ? body.quality : '',
        n: Math.max(1, Number(body.n) || 1),
        images: [],
        extras,
    };
}

/** 拉上游图 URL 转 b64(60s 超时 + 50MB 上限;4K PNG 实测 8-14MB)。失败返 null。 */
async function fetchImageAsB64(url: string): Promise<string | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) return null;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length === 0 || buf.length > 50 * 1024 * 1024) return null;
        return buf.toString('base64');
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// ============ 主流程 ============

export async function handleAdapterImage(
    req: NextRequest,
    mode: ImageMode,
    providerName: string,
): Promise<NextResponse> {
    const provider = IMAGE_PROVIDERS[providerName];
    if (!provider) return failover('unknown_provider', `image-adapter provider '${providerName}' not registered`);
    const auth = req.headers.get('authorization');
    if (!auth)
        return NextResponse.json(
            { error: { message: 'missing Authorization', type: 'invalid_request_error' } },
            { status: 401 },
        );

    const parsed = await parseIncoming(req, mode);
    if (!parsed) return failover('bad_request_body', 'unparseable request body');

    // ---- 守门(调上游之前,不花钱)----
    const tier = sizeTier(parsed.size);
    const quality = normQuality(parsed.quality);
    if (!tier || !isProfitable(tier, quality)) {
        console.log('[image-adapter] gate reject', { provider: providerName, mode, size: parsed.size, tier, quality });
        return failover(
            'size_not_served',
            `size tier ${tier ?? 'unknown'} / quality ${quality} not served on this channel`,
        );
    }

    // ---- 调真实上游 ----
    const url = `${provider.baseUrl}/v1/images/${mode}`;
    let upstreamBody: BodyInit;
    const headers: Record<string, string> = { authorization: auth };
    if (mode === 'edits') {
        const f = new FormData();
        f.append('model', 'gpt-image-2');
        f.append('prompt', parsed.prompt);
        f.append('size', parsed.size.trim());
        f.append('response_format', 'b64_json'); // 不带时 ominiapi 返自家 OSS url(上游身份泄漏),显式要 b64
        if (parsed.quality) f.append('quality', normQuality(parsed.quality));
        if (parsed.n > 1) f.append('n', String(parsed.n));
        for (const [k, v] of Object.entries(parsed.extras)) f.append(k, v);
        for (const img of parsed.images)
            f.append('image', new Blob([new Uint8Array(img.buf)], { type: img.type }), img.name);
        upstreamBody = f; // fetch 自动生成 multipart boundary(不能手写 content-type,gotcha #21)
    } else {
        const j: Record<string, unknown> = {
            model: 'gpt-image-2',
            prompt: parsed.prompt,
            size: parsed.size.trim(),
            response_format: 'b64_json', // 同上:2026-08-04 smoke 实测缺省返 url
        };
        if (parsed.quality) j.quality = normQuality(parsed.quality);
        if (parsed.n > 1) j.n = parsed.n;
        Object.assign(j, parsed.extras);
        upstreamBody = JSON.stringify(j);
        headers['content-type'] = 'application/json';
    }

    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    let upstream: Response;
    try {
        upstream = await fetch(url, { method: 'POST', headers, body: upstreamBody, signal: ctrl.signal });
    } catch (e) {
        console.warn('[image-adapter] upstream fetch failed', {
            provider: providerName,
            mode,
            ms: Date.now() - started,
            err: e instanceof Error ? e.message : String(e),
        });
        return failover('upstream_unreachable', 'upstream fetch failed or timed out');
    } finally {
        clearTimeout(timer);
    }

    if (!upstream.ok) {
        // 上游是网关:它的 4xx/5xx 一律 503 让 new-api 切别的渠道兜底(不合成 usage = 不扣费)。
        const errText = await upstream.text().catch(() => '');
        console.warn('[image-adapter] upstream error', {
            provider: providerName,
            mode,
            status: upstream.status,
            ms: Date.now() - started,
            body: errText.slice(0, 500),
        });
        return failover('upstream_error', sanitizeAdapterError(errText.slice(0, 300), provider.brand));
    }

    const data = (await upstream.json().catch(() => null)) as {
        created?: number;
        data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
    } | null;
    const rawItems = Array.isArray(data?.data) ? data.data.filter((it) => it && (it.b64_json || it.url)) : [];
    if (rawItems.length === 0) {
        console.warn('[image-adapter] upstream returned no image', {
            provider: providerName,
            mode,
            ms: Date.now() - started,
        });
        return failover('upstream_no_image', 'upstream returned no image');
    }

    // 上游 URL 一律不外泄(response_format 被无视时仍可能返 url —— 它指向上游自家 OSS,
    // 直接透传 = azure 伪装穿帮 + cache 链接会过期)→ 这里拉下来转 b64;拉不动 → 503 failover。
    const items: Array<{ b64_json: string }> = [];
    for (const it of rawItems) {
        if (it.b64_json) {
            items.push({ b64_json: it.b64_json });
            continue;
        }
        const b64 = await fetchImageAsB64(it.url as string);
        if (!b64) {
            console.warn('[image-adapter] url→b64 fetch failed', { provider: providerName, mode });
            return failover('upstream_image_unreachable', 'failed to retrieve generated image');
        }
        items.push({ b64_json: b64 });
    }

    // ---- 合成 usage(丢弃上游假 token)----
    const usage = synthUsage({
        mode,
        tier,
        quality,
        prompt: parsed.prompt,
        inputImageDims: parsed.images.map((img) => imageDimensions(img.buf)),
        imageCount: items.length,
    });
    console.log('[image-adapter] ok', {
        provider: providerName,
        mode,
        size: parsed.size,
        tier,
        quality,
        images: items.length,
        pt: usage.input_tokens,
        ct: usage.output_tokens,
        ms: Date.now() - started,
    });
    return NextResponse.json({ created: data?.created ?? Math.floor(Date.now() / 1000), data: items, usage });
}
