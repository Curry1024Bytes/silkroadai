/**
 * Seedream 5.0 Pro 图片适配器(service-inference.ai · `dola-seedream-5-0-pro-260628-ep`,2026-09-06)。
 *
 * 走 image-adapter / minimax 同款「portal 适配器 + new-api 渠道」模式:new-api 渠道(type=1 OpenAI,
 * base_url 指向本适配器,渠道 key = 上游 key,portal 不存 key)把客户的 OpenAI Images 形 JSON 请求
 * 打到这里。**渠道必须开 `pass_through_body_enabled`** —— 关着时 new-api 按自家 ImageRequest 结构
 * 重组 body,`layer_decomposition` / `image` / `watermark` 等字段到不了这里(2026-09-06 echo 探测:
 * 开了之后原始 JSON 逐字节到达,响应里的 z_index / bounding_box 等扩展字段也原样穿回客户)。
 *
 * 本适配器只做四件事:
 *  1. 对客模型名 `seedream-5-0-pro` → 上游 `dola-seedream-5-0-pro-260628-ep`;归一输入图字段
 *     (image / images / image_url / image_urls,URL 或 base64 data URL 都收,上游两种都吃,实测);
 *     恒向上游要 `b64_json` —— 上游 url 是火山 TOS 24h 签名链接、且暴露上游域名,绝不外泄。
 *  2. `n>1` 由本层并发扇出(上游忽略 n:2026-09-06 直连 n=2 只回 1 张);图层拆分固定单次。
 *  3. 【合成 usage = 我们的售价,单位 quota】:new-api 该模型 ModelRatio=1 / CompletionRatio=1,
 *     quota = input_tokens + output_tokens 逐 quota 精确。售价表见下,按【返回图实际尺寸】分档。
 *  4. 上游 4xx → 400 终态(脱敏:不透上游品牌 / 内部错误码);5xx / 超时 / 无图 → 502
 *     (不合成 usage,new-api 不扣客户)。
 *
 * 图片转存(客户 OSS / 平台 R2)不在这层 —— 代理回程(/v1 route reshape,response_format 缺省 = url)
 * 做;这层只返 b64 + usage。
 *
 * === 售价(2026-09-06 operator 拍板:官方 USD 牌价 × 0.55 折 × 汇率 6.8;500,000 quota = ¥1)===
 *   输入参考图:第 1 张免费,第 2 张起 $0.003/张                    → ¥0.01122/张 = 5,610 quota
 *   普通生图  ≤2.36MP(1.5K 及以下)$0.045 / >2.36MP(2K)$0.09     → ¥0.1683 / ¥0.3366 每张
 *   图层拆分  ≤2.36MP $0.0225 / >2.36MP $0.045                     → ¥0.0842 / ¥0.1683 每张
 *            (底图 + 每个图层各算一张,与上游 usage.generated_images 口径一致)
 *   像素分档阈值取上游计费元数据 `pixel_tier: le_236w`(2,360,000;1.5K = 1536² = 2,359,296 恰在线内)。
 *   官方页面写的 2.61M 与上游实际计费阈值不一致,按上游(我们被扣的那条线)走,不留亏损区。
 *   上游给我们的成本 = 官方 × 0.45(/v1/models pricing 元数据),毛利 ≈ 售价的 18%。
 *
 * === 上游契约(2026-09-06 直连实测)===
 *   POST /v1/images/generations,Bearer 上游 key;`size` 收 1K / 1.5K / 2K / WxH(面积 ≤ 4,624,220 px,
 *   3K/4K 会被拒);`image` 收 string 或 string[](URL / data URL);`layer_decomposition:true` 返底图
 *   (z_index 0)+ 图层(z_index≥1,带 bounding_box / name / description,透明 PNG),prompt 可空;
 *   `background:"transparent"` 要求恰好 1 张【PNG】输入图;usage 带 input_images / generated_images。
 */
import { NextRequest, NextResponse } from 'next/server';
import { imageDimensions, parseSize } from '@/lib/image-adapter/adapter';

const SI_BASE = process.env.SEEDREAM_INF_BASE_URL || 'https://model.service-inference.ai';

/** 对客模型名(new-api 渠道 models 只挂这个)。 */
export const SEEDREAM_MODEL = 'seedream-5-0-pro';
/** 上游模型名(service-inference.ai 上架名)。 */
export const SEEDREAM_UPSTREAM_MODEL = 'dola-seedream-5-0-pro-260628-ep';

/** 上游单次生成实测 20–100s(图生图 1.5K 曾 97s);与链路其余各层(Caddy 3010 / undici)对齐 600s。 */
const UPSTREAM_TIMEOUT_MS = 600_000;
/** n>1 扇出上限(对齐 OpenAI images n≤10);超出只钳制不报错。 */
const MAX_FANOUT = 10;
/** Pro 参考图上限(上游文档:最多 10 张)。 */
export const MAX_INPUT_IMAGES = 10;

/** 是否本适配器负责的模型(大小写宽容)。 */
export function isSeedreamModel(model: string): boolean {
    return (
        String(model || '')
            .trim()
            .toLowerCase() === SEEDREAM_MODEL
    );
}

// ============ 定价(改这里即可)============

export const SEEDREAM_PRICING = {
    /** 官方 USD 牌价(service-inference.ai 定价页,2026-09-06)。 */
    officialUsd: {
        single: { low: 0.045, high: 0.09 },
        layer: { low: 0.0225, high: 0.045 },
        inputImage: 0.003,
    },
    /** 我们对客 = 官方 × 0.55(5.5 折)。 */
    sellDiscount: 0.55,
    /** 换算汇率(operator 指定)。 */
    usdToCny: 6.8,
    /** 2026-07-19 计价单位迁移后:500,000 quota = ¥1。 */
    quotaPerCny: 500_000,
    /** 输入参考图免费张数(官方:第 1 张免费)。 */
    freeInputImages: 1,
    /** 像素分档阈值(含):≤ 走 low 档,> 走 high 档。 */
    pixelTierThreshold: 2_360_000,
} as const;

export type PixelTier = 'low' | 'high';

/** 官方 USD 单价 → 我们的售价(quota)。 */
export function sellQuota(officialUsd: number): number {
    const p = SEEDREAM_PRICING;
    return Math.round(officialUsd * p.sellDiscount * p.usdToCny * p.quotaPerCny);
}

export function pixelTier(w: number, h: number): PixelTier {
    return w * h <= SEEDREAM_PRICING.pixelTierThreshold ? 'low' : 'high';
}

/** 一张输出图的售价(quota):普通生图 / 图层拆分两张表,按该图自身像素分档。 */
export function outputImageQuota(w: number, h: number, layer: boolean): number {
    const table = layer ? SEEDREAM_PRICING.officialUsd.layer : SEEDREAM_PRICING.officialUsd.single;
    return sellQuota(table[pixelTier(w, h)]);
}

/** 输入参考图售价(quota):第 1 张免费,其余按张。 */
export function inputImagesQuota(count: number): number {
    const paid = Math.max(0, Math.floor(count) - SEEDREAM_PRICING.freeInputImages);
    return paid * sellQuota(SEEDREAM_PRICING.officialUsd.inputImage);
}

export interface SeedreamUsageInput {
    /** 实际返回的每张图尺寸(底图 + 图层各一项)。 */
    outputs: Array<{ w: number; h: number }>;
    layer: boolean;
    inputImages: number;
}

/** 合成 usage:input_tokens / output_tokens 直接就是 quota(ModelRatio=1 · CompletionRatio=1 下
 *  new-api 扣 quota = 两者之和,逐 quota 精确)。额外带 input_images / generated_images 供客户对账
 *  (与上游口径一致)。只发 OpenAI images 官方字段名,不带 prompt_tokens/completion_tokens 别名
 *  (中继型客户会把两套相加导致账面翻倍,见 image-adapter synthUsage 注释)。 */
export function synthSeedreamUsage(inp: SeedreamUsageInput): Record<string, number> {
    const output = inp.outputs.reduce((sum, o) => sum + outputImageQuota(o.w, o.h, inp.layer), 0);
    const input = inputImagesQuota(inp.inputImages);
    return {
        input_tokens: input,
        output_tokens: output,
        total_tokens: input + output,
        input_images: inp.inputImages,
        generated_images: inp.outputs.length,
    };
}

// ============ 错误 ============

function err(status: number, code: string, message: string, param: string | null = null): NextResponse {
    return NextResponse.json(
        {
            error: {
                message,
                type: status >= 500 ? 'server_error' : 'invalid_request_error',
                param,
                code,
            },
        },
        { status },
    );
}

/** 上游品牌 / 内部错误码脱敏(客户可见错误体里不出现 service-inference / dola / 火山 / ERR_XXX_nnn)。 */
const BRAND_RE =
    /service-?inference(?:\.ai)?|\bdola\b|\bvolc(?:engine|es)?\b|\bbytedance\b|\bdoubao\b|\bERR_[A-Z]+_\d+\b/gi;
export function sanitizeUpstreamMessage(msg: string): string {
    return msg
        .split(SEEDREAM_UPSTREAM_MODEL)
        .join(SEEDREAM_MODEL)
        .replace(BRAND_RE, 'the provider')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/** 上游内容审核类拒绝(提示词 / 输入图 / 输出图被判敏感)。命中 → 对客 400 + 「content rejected」
 *  文案,代理层 IMAGE_SAFETY_RE 会再改写成统一 moderation_blocked 体。 */
const MODERATION_RE = /sensitive|unsafe|moderation|content.?(?:policy|risk|safety)|违规|敏感|审核|不合规/i;

/** 上游 URL → b64(上游返 url 而非 b64 时兜底;60s + 50MB)。失败返 null。 */
async function fetchImageAsB64(url: string): Promise<string | null> {
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!r.ok) return null;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length === 0 || buf.length > 50 * 1024 * 1024) return null;
        return buf.toString('base64');
    } catch {
        return null;
    }
}

function isAuthorized(auth: string): boolean {
    const key = auth.replace(/^Bearer\s+/i, '').trim();
    // 渠道 key(= 上游 key)。设了 SEEDREAM_INF_KEY 就精确校验(防公网路径被外部直打);
    // 未设时放行 sk- 前缀 —— 即便被外部直打,鉴权头原样转发上游,错 key 上游 401,无泄露面。
    const configured = process.env.SEEDREAM_INF_KEY || '';
    if (configured) return key === configured;
    return /^sk-/.test(key);
}

// ============ 入参 ============

interface ParsedRequest {
    prompt: string;
    /** 归一后的 size(1K / 1.5K / 2K / WxH);'' = 不传,上游默认 2K。 */
    size: string;
    n: number;
    layer: boolean;
    /** 输入参考图(URL 或 data URL),已归一为字符串数组。 */
    images: string[];
    /** 透传上游的其余参数(白名单)。 */
    extras: Record<string, unknown>;
}

/** 透传上游的参数白名单(OpenAI 标准的 quality / style / user 上游不认,丢弃)。 */
const FORWARD_EXTRAS = [
    'background',
    'output_format',
    'watermark',
    'web_search',
    'seed',
    'guidance_scale',
    'sequential_image_generation',
    'sequential_image_generation_options',
] as const;

/** 收集输入图:image / images / image_url / image_urls 四个字段,string 或 {url} 两形,顺序保留。 */
export function collectInputImages(body: Record<string, unknown>): string[] {
    const out: string[] = [];
    const push = (v: unknown) => {
        if (typeof v === 'string') {
            if (v.trim()) out.push(v.trim());
        } else if (v && typeof v === 'object') {
            const u = (v as { url?: unknown }).url;
            if (typeof u === 'string' && u.trim()) out.push(u.trim());
        }
    };
    for (const k of ['image', 'images', 'image_url', 'image_urls']) {
        const v = body[k];
        if (Array.isArray(v)) v.forEach(push);
        else if (v != null) push(v);
    }
    return out;
}

/** size / resolution 归一:`1k` → `1K`,`1536x1536` 原样,其余原样交上游校验。 */
export function normalizeSize(v: unknown): string {
    const s = typeof v === 'string' ? v.trim() : '';
    const m = /^(\d(?:\.\d)?)\s*k$/i.exec(s);
    return m ? `${m[1]}K` : s;
}

/** 请求档位 → 像素(仅在返回图尺寸读不出时兜底计费用;读得出一律按实际)。缺省 2K = 上游默认。 */
function fallbackDims(size: string): { w: number; h: number } {
    const p = parseSize(size);
    if (p) return p;
    const m = /^(\d(?:\.\d)?)K$/.exec(size);
    if (m) {
        const px = Math.round(Number(m[1]) * 1024);
        return { w: px, h: px };
    }
    return { w: 2048, h: 2048 };
}

export function parseIncoming(body: Record<string, unknown>): ParsedRequest {
    const layer = body.layer_decomposition === true || body.layer_decomposition === 'true';
    const nRaw = Math.floor(Number(body.n));
    const n = Number.isFinite(nRaw) && nRaw > 0 ? nRaw : 1;
    const extras: Record<string, unknown> = {};
    for (const k of FORWARD_EXTRAS) {
        const v = body[k];
        if (v !== undefined && v !== null && v !== '') extras[k] = v;
    }
    // 水印缺省关(火山官方缺省 true 会在右下角压「AI生成」字样;付费 API 客户默认不要,显式传 true 才加)
    if (!('watermark' in extras)) extras.watermark = false;
    return {
        prompt: typeof body.prompt === 'string' ? body.prompt.trim() : '',
        size: normalizeSize(body.size ?? body.resolution),
        n,
        layer,
        images: collectInputImages(body),
        extras,
    };
}

// ============ 上游调用 ============

interface OutItem {
    b64_json: string;
    size?: string;
    output_format?: string;
    z_index?: number;
    bounding_box?: unknown;
    name?: string;
    description?: string;
}

type CallResult =
    | { ok: true; items: Array<OutItem & { w: number; h: number }>; inputImages: number | null }
    | { ok: false; status: number; code: string; message: string; param: string | null };

function buildUpstreamBody(parsed: ParsedRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
        model: SEEDREAM_UPSTREAM_MODEL,
        prompt: parsed.prompt,
        response_format: 'b64_json',
        ...parsed.extras,
    };
    if (parsed.size) body.size = parsed.size;
    if (parsed.images.length > 0) body.image = parsed.layer ? parsed.images[0] : parsed.images;
    if (parsed.layer) body.layer_decomposition = true;
    return body;
}

/** 上游错误体 → 对客错误(脱敏 + 分类)。4xx 终态 400;5xx / 网络 → 502。 */
function classifyUpstreamError(status: number, text: string): Extract<CallResult, { ok: false }> {
    let message = '';
    let param: string | null = null;
    try {
        const j = JSON.parse(text) as { error?: { message?: unknown; param?: unknown }; message?: unknown };
        const e = j.error ?? j;
        if (typeof e?.message === 'string') message = e.message;
        if (typeof (e as { param?: unknown })?.param === 'string') param = (e as { param: string }).param;
    } catch {
        message = text.slice(0, 300);
    }
    if (status >= 500 || status === 429) {
        return {
            ok: false,
            status: 502,
            code: 'upstream_error',
            message: 'The image provider is temporarily unavailable, please retry later.',
            param: null,
        };
    }
    if (MODERATION_RE.test(message)) {
        return {
            ok: false,
            status: 400,
            code: 'moderation_blocked',
            message: 'content rejected: the prompt or image was flagged by the content safety system',
            param,
        };
    }
    return {
        ok: false,
        status: 400,
        code: 'invalid_request',
        message: sanitizeUpstreamMessage(message) || 'invalid request: the prompt, image, or parameters were rejected',
        param,
    };
}

async function callUpstreamOnce(parsed: ParsedRequest, auth: string): Promise<CallResult> {
    const started = Date.now();
    let upstream: Response;
    try {
        upstream = await fetch(`${SI_BASE}/v1/images/generations`, {
            method: 'POST',
            headers: { authorization: auth, 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(buildUpstreamBody(parsed)),
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
    } catch (e) {
        console.warn('[seedream-adapter] upstream fetch failed', {
            ms: Date.now() - started,
            err: e instanceof Error ? e.message : String(e),
        });
        return {
            ok: false,
            status: 502,
            code: 'upstream_error',
            message: 'The image provider is temporarily unavailable, please retry later.',
            param: null,
        };
    }

    if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        const cls = classifyUpstreamError(upstream.status, text);
        console.warn('[seedream-adapter] upstream error', {
            status: upstream.status,
            ms: Date.now() - started,
            code: cls.code,
            body: text.slice(0, 300),
        });
        return cls;
    }

    const json = (await upstream.json().catch(() => null)) as {
        data?: Array<Partial<OutItem> & { url?: string }>;
        usage?: { input_images?: unknown };
    } | null;
    const raw = Array.isArray(json?.data) ? json.data : [];
    const items: Array<OutItem & { w: number; h: number }> = [];
    for (const it of raw) {
        if (!it || typeof it !== 'object') continue;
        let b64 = typeof it.b64_json === 'string' && it.b64_json ? it.b64_json : null;
        if (!b64 && typeof it.url === 'string' && it.url) b64 = await fetchImageAsB64(it.url);
        if (!b64) continue;
        // 计费尺寸:上游 size 字段 → 图字节头(PNG IHDR / JPEG SOF)→ 请求档位兜底
        const dims =
            (typeof it.size === 'string' ? parseSize(it.size) : null) ??
            imageDimensions(Buffer.from(b64, 'base64')) ??
            fallbackDims(parsed.size);
        const out: OutItem & { w: number; h: number } = { b64_json: b64, w: dims.w, h: dims.h };
        out.size = typeof it.size === 'string' && it.size ? it.size : `${dims.w}x${dims.h}`;
        if (typeof it.output_format === 'string') out.output_format = it.output_format;
        if (typeof it.z_index === 'number') out.z_index = it.z_index;
        if (it.bounding_box !== undefined) out.bounding_box = it.bounding_box;
        if (typeof it.name === 'string') out.name = it.name;
        if (typeof it.description === 'string') out.description = it.description;
        items.push(out);
    }
    if (items.length === 0) {
        console.warn('[seedream-adapter] upstream returned no image', { ms: Date.now() - started });
        return {
            ok: false,
            status: 502,
            code: 'upstream_error',
            message: 'The image provider returned no image, please retry later.',
            param: null,
        };
    }
    const inputImages = typeof json?.usage?.input_images === 'number' ? json.usage.input_images : null;
    return { ok: true, items, inputImages };
}

// ============ 主流程 ============

export async function handleSeedreamImage(req: NextRequest): Promise<NextResponse> {
    const auth = req.headers.get('authorization') || '';
    if (!isAuthorized(auth)) return err(401, 'unauthorized', 'missing or invalid credentials for seedream adapter');

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return err(400, 'invalid_json', 'request body must be JSON');
    const model = String(body.model || '');
    if (!isSeedreamModel(model)) return err(400, 'model_not_found', `model '${model}' is not served here`, 'model');

    const parsed = parseIncoming(body);
    if (parsed.images.length > MAX_INPUT_IMAGES)
        return err(400, 'invalid_value', `at most ${MAX_INPUT_IMAGES} input images are allowed`, 'image');
    if (parsed.layer && parsed.images.length !== 1)
        return err(400, 'invalid_value', 'layer_decomposition requires exactly one input image', 'image');
    if (!parsed.prompt && !parsed.layer && parsed.images.length === 0)
        return err(400, 'invalid_value', 'prompt is required', 'prompt');

    // 图层拆分固定单次(上游按输入图拆,n 无意义);其余按 n 扇出(上游忽略 n)。
    const fanout = parsed.layer ? 1 : Math.min(parsed.n, MAX_FANOUT);
    if (!parsed.layer && parsed.n > MAX_FANOUT) {
        console.warn('[seedream-adapter] n clamped', { requested: parsed.n, used: MAX_FANOUT });
    }
    const started = Date.now();
    const results = await Promise.all(Array.from({ length: fanout }, () => callUpstreamOnce(parsed, auth)));
    const oks = results.filter((r): r is Extract<CallResult, { ok: true }> => r.ok);
    if (oks.length === 0) {
        // 全军覆没:优先报终态 4xx(换渠道 / 重试都没用),否则 502
        const fails = results.filter((r): r is Extract<CallResult, { ok: false }> => !r.ok);
        const f = fails.find((x) => x.status < 500) ?? fails[0];
        return err(f.status, f.code, f.message, f.param);
    }
    if (oks.length < fanout) {
        console.warn('[seedream-adapter] partial fanout', { requested: fanout, got: oks.length });
    }
    const items = oks.flatMap((r) => r.items);
    const inputImages = oks[0].inputImages ?? parsed.images.length;
    const usage = synthSeedreamUsage({
        outputs: items.map((it) => ({ w: it.w, h: it.h })),
        layer: parsed.layer,
        inputImages,
    });
    const data = items.map((it) => {
        const rest: Record<string, unknown> = { ...it };
        delete rest.w;
        delete rest.h;
        return rest;
    });
    console.log('[seedream-adapter] ok', {
        size: parsed.size || 'default',
        layer: parsed.layer,
        nRequested: parsed.n,
        images: data.length,
        inputImages,
        quota: usage.total_tokens,
        ms: Date.now() - started,
    });
    return NextResponse.json({ created: Math.floor(Date.now() / 1000), model: SEEDREAM_MODEL, data, usage });
}
