/**
 * gemini-adapter —— 站在 new-api 和 Gemini 生图上游之间,把上游回包的 usageMetadata 重写成
 * 【官方固定 token 常数】,让 new-api 的 billing-usage-gemini 按官方口径扣费,与上游是谁无关。
 *
 * 链路:new-api(type=24 渠道,base_url 指本适配器)→ 本适配器 → 真实上游(provider.baseUrl)
 *
 * 1. 鉴权透传:new-api 把渠道 key 以 `x-goog-api-key`(或 Authorization / ?key=)带来,原样作
 *    `x-goog-api-key` 发给上游;portal 不存上游凭据。缺 key → 401。
 * 2. 请求体原样透传(不改 contents / generationConfig);只记下 imageConfig.imageSize(缺省 1K)
 *    作读不出返回图尺寸时的计费兜底。
 * 3. 响应 2xx:按【返回图实际像素】分档(0.5K / 1K / 2K / 4K,像素预算不是边长)查官方表重写
 *    `candidatesTokensDetails[IMAGE]` / `candidatesTokenCount`;输入图按官方 560 tok/张重写
 *    `promptTokensDetails[IMAGE]`;TEXT / thoughts 沿用上游;totalTokenCount 重算。
 *    无图 → IMAGE 0(没交付不收图钱,也堵住「流式回空图仍计费」)。未知模型 → 原样透传不重写。
 * 4. `:streamGenerateContent`:上游走非流式 `:generateContent`(yobox 流式回空图),重写后包成
 *    单条 `data: {...}` SSE 回给 new-api。
 * 5. 上游非 2xx → 原状态码 + 脱敏 body 透传(new-api 自己决定 failover);连不上 / 超时 → 503。
 *
 * 官方表(ai.google.dev pricing + image-generation 文档 2026-10-22 实读,所有比例同一常数):
 *   gemini-nano-banana-2.1:1K 1120 / 2K 1680 / 4K 3780(定价页;生图文档表写 2520,两页自相矛盾,
 *                           取定价页 = Google 实际开票口径,ch198 we-token 实测亦回 3780)
 *   gemini-3.1-flash-image:0.5K 747 / 1K 1120 / 2K 1680 / 4K 2520
 *   gemini-3-pro-image:    1K 1120 / 2K 1120 / 4K 2000
 *   gemini-2.5-flash-image:1290 单档
 *   输入图:560 tok/张(pro 定价页脚注;与尺寸无关)
 */
import { NextRequest, NextResponse } from 'next/server';
import { imageDimensions, sanitizeAdapterError } from '@/lib/image-adapter/adapter';
import { GEMINI_PROVIDERS, type GeminiProvider } from './providers';

const DEFAULT_UPSTREAM_TIMEOUT_MS = 600_000;

export type ImageTier = '0.5K' | '1K' | '2K' | '4K';

/** 官方出图 token 表(按模型族 × 档位)。-preview 名与裸名同底模共用。 */
const OFFICIAL_OUTPUT_TOKENS: Record<string, Partial<Record<ImageTier, number>>> = {
    'gemini-nano-banana-2.1': { '1K': 1120, '2K': 1680, '4K': 3780 },
    'gemini-3.1-flash-image': { '0.5K': 747, '1K': 1120, '2K': 1680, '4K': 2520 },
    'gemini-3-pro-image': { '1K': 1120, '2K': 1120, '4K': 2000 },
    'gemini-2.5-flash-image': { '0.5K': 1290, '1K': 1290, '2K': 1290, '4K': 1290 },
};
export const OFFICIAL_INPUT_IMAGE_TOKENS = 560;

/** 模型名 → 官方表的族名(剥 -preview / 我们自家的别名后缀)。不认识返 null(→ 透传不重写)。 */
export function officialFamily(model: string): string | null {
    const m = model.trim().toLowerCase();
    if (m in OFFICIAL_OUTPUT_TOKENS) return m;
    for (const fam of Object.keys(OFFICIAL_OUTPUT_TOKENS)) {
        if (m.startsWith(fam + '-')) return fam;
    }
    return null;
}

/** 返回图实际像素 → 档位。官方档位是像素预算(1K≈1MP / 2K≈4.2MP / 4K≈17MP,0.5K≈0.26MP),
 *  不是边长:1K 21:9 = 1584×672(1.06MP)、1K 8:1 = 3072×384(1.18MP)、0.5K 21:9 = 792×168(0.13MP)。
 *  阈值取相邻档位几何中点附近,任何官方比例都落对档。 */
export function tierFromPixels(w: number, h: number): ImageTier {
    const mp = (w * h) / 1_000_000;
    if (mp < 0.6) return '0.5K';
    if (mp < 2.4) return '1K';
    if (mp < 9) return '2K';
    return '4K';
}

/** 请求里的 imageConfig.imageSize(1K/2K/4K/512)→ 档位;缺省 1K(官方默认)。 */
export function requestedTier(body: unknown): ImageTier {
    const raw = (body as { generationConfig?: { imageConfig?: { imageSize?: unknown } } })?.generationConfig
        ?.imageConfig?.imageSize;
    const s = String(raw ?? '')
        .trim()
        .toUpperCase();
    if (s === '512' || s === '0.5K') return '0.5K';
    if (s === '2K') return '2K';
    if (s === '4K') return '4K';
    return '1K';
}

export function officialOutputTokens(family: string, tier: ImageTier): number {
    const table = OFFICIAL_OUTPUT_TOKENS[family];
    // 该族没有此档(pro 无 0.5K)→ 取最近的更高档,别少收
    return table[tier] ?? table['1K'] ?? 0;
}

type JsonRecord = Record<string, unknown>;
type Part = { inlineData?: { mimeType?: string; data?: string }; fileData?: unknown; text?: string };
type ModalityCount = { modality?: string; tokenCount?: number };

/** 统计请求 contents 里的输入图张数(inlineData / fileData 都算)。 */
export function countInputImages(body: unknown): number {
    const contents = (body as { contents?: Array<{ parts?: Part[] }> })?.contents;
    if (!Array.isArray(contents)) return 0;
    let n = 0;
    for (const c of contents) for (const p of c?.parts ?? []) if (p && (p.inlineData || p.fileData)) n++;
    return n;
}

function modalityCount(list: unknown, modality: string): number {
    if (!Array.isArray(list)) return 0;
    let n = 0;
    for (const x of list as ModalityCount[]) if (x?.modality === modality) n += Number(x.tokenCount ?? 0) || 0;
    return n;
}

export interface RewriteResult {
    usage: JsonRecord;
    images: number;
    tiers: ImageTier[];
    outputImageTokens: number;
}

/** 把上游 usageMetadata 重写成官方口径。纯函数,便于测。 */
export function rewriteUsage(
    upstream: JsonRecord,
    family: string,
    fallbackTier: ImageTier,
    inputImages: number,
): RewriteResult {
    const u = (upstream.usageMetadata as JsonRecord | undefined) ?? {};
    const candidates = (upstream.candidates as Array<{ content?: { parts?: Part[] } }> | undefined) ?? [];
    const tiers: ImageTier[] = [];
    for (const cand of candidates) {
        for (const p of cand?.content?.parts ?? []) {
            if (!p?.inlineData?.data) continue;
            let tier = fallbackTier;
            try {
                const dims = imageDimensions(Buffer.from(p.inlineData.data, 'base64'));
                if (dims) tier = tierFromPixels(dims.w, dims.h);
            } catch {
                /* 读不出尺寸 → 用请求档 */
            }
            tiers.push(tier);
        }
    }
    const outputImageTokens = tiers.reduce((s, t) => s + officialOutputTokens(family, t), 0);
    const outputText = modalityCount(u.candidatesTokensDetails, 'TEXT');
    const promptText = modalityCount(u.promptTokensDetails, 'TEXT') || Number(u.promptTokenCount ?? 0) || 0;
    const promptImage = inputImages * OFFICIAL_INPUT_IMAGE_TOKENS;
    const thoughts = Number(u.thoughtsTokenCount ?? 0) || 0;

    const candidatesTokensDetails: ModalityCount[] = [];
    if (outputText > 0) candidatesTokensDetails.push({ modality: 'TEXT', tokenCount: outputText });
    candidatesTokensDetails.push({ modality: 'IMAGE', tokenCount: outputImageTokens });
    const promptTokensDetails: ModalityCount[] = [{ modality: 'TEXT', tokenCount: promptText }];
    if (promptImage > 0) promptTokensDetails.push({ modality: 'IMAGE', tokenCount: promptImage });

    const promptTokenCount = promptText + promptImage;
    const candidatesTokenCount = outputText + outputImageTokens;
    const usage: JsonRecord = {
        ...u,
        promptTokenCount,
        candidatesTokenCount,
        totalTokenCount: promptTokenCount + candidatesTokenCount + thoughts,
        promptTokensDetails,
        candidatesTokensDetails,
    };
    if (thoughts > 0) usage.thoughtsTokenCount = thoughts;
    return { usage, images: tiers.length, tiers, outputImageTokens };
}

/** new-api 发来的渠道 key:x-goog-api-key > Authorization(Bearer 可选)> ?key=。 */
export function extractApiKey(req: NextRequest): string | null {
    const h = req.headers.get('x-goog-api-key');
    if (h) return h.trim();
    const auth = req.headers.get('authorization');
    if (auth) return auth.replace(/^Bearer\s+/i, '').trim();
    const q = req.nextUrl.searchParams.get('key');
    return q ? q.trim() : null;
}

function errorJson(status: number, message: string, type = 'upstream_error'): NextResponse {
    return NextResponse.json(
        { error: { code: status, message, status: type } },
        { status, headers: { 'X-Silkroadai-Gemini-Adapter': 'error' } },
    );
}

/**
 * 入口:POST /gemini-adapter/{provider}/v1beta/models/{model}:{action}
 * action ∈ generateContent | streamGenerateContent;其余 404。
 */
export async function handleGeminiAdapter(
    req: NextRequest,
    providerName: string,
    model: string,
    action: string,
): Promise<NextResponse> {
    const provider: GeminiProvider | undefined = GEMINI_PROVIDERS[providerName];
    if (!provider) return errorJson(404, `unknown gemini-adapter provider: ${providerName}`, 'not_found');
    if (action !== 'generateContent' && action !== 'streamGenerateContent') {
        return errorJson(404, `unsupported action: ${action}`, 'not_found');
    }
    const apiKey = extractApiKey(req);
    if (!apiKey) return errorJson(401, 'missing API key', 'unauthenticated');

    let rawBody: string;
    let body: JsonRecord;
    try {
        rawBody = await req.text();
        body = JSON.parse(rawBody) as JsonRecord;
    } catch {
        return errorJson(400, 'invalid JSON body', 'invalid_argument');
    }

    const wantStream = action === 'streamGenerateContent';
    const family = officialFamily(model);
    const fallbackTier = requestedTier(body);
    const inputImages = countInputImages(body);
    const t0 = Date.now();

    // 上游永远走非流式(yobox :streamGenerateContent 回空图;单图请求也没有增量可言)
    const url = `${provider.baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    let upstream: Response;
    try {
        upstream = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
            body: rawBody,
            signal: AbortSignal.timeout(provider.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS),
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[gemini-adapter] ${providerName} ${model} upstream fetch failed: ${msg}`);
        return errorJson(503, `upstream request failed: ${sanitizeAdapterError(msg, provider.brand)}`);
    }

    if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        console.warn(
            `[gemini-adapter] ${providerName} ${model} upstream ${upstream.status} ${Date.now() - t0}ms ${text.slice(0, 200)}`,
        );
        return new NextResponse(sanitizeAdapterError(text, provider.brand), {
            status: upstream.status,
            headers: {
                'content-type': upstream.headers.get('content-type') ?? 'application/json',
                'X-Silkroadai-Gemini-Adapter': 'upstream-error',
            },
        });
    }

    let data: JsonRecord;
    try {
        data = (await upstream.json()) as JsonRecord;
    } catch {
        return errorJson(502, 'upstream returned non-JSON body');
    }

    let mode = 'passthrough';
    if (family) {
        const r = rewriteUsage(data, family, fallbackTier, inputImages);
        data.usageMetadata = r.usage;
        mode = 'rewritten';
        console.log(
            `[gemini-adapter] ${providerName} ${model} ${action} images=${r.images} tiers=${r.tiers.join(',') || '-'} ` +
                `out_img_tok=${r.outputImageTokens} in_img=${inputImages} ${Date.now() - t0}ms`,
        );
    } else {
        console.log(`[gemini-adapter] ${providerName} ${model} ${action} unknown family → usage passthrough`);
    }

    const headers: Record<string, string> = { 'X-Silkroadai-Gemini-Adapter': mode };
    if (wantStream) {
        headers['content-type'] = 'text/event-stream';
        headers['cache-control'] = 'no-cache';
        return new NextResponse(`data: ${JSON.stringify(data)}\n\n`, { status: 200, headers });
    }
    return NextResponse.json(data, { status: 200, headers });
}
