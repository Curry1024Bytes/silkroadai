/**
 * 按张计费图片上游 → azure gpt-image-2 伪装适配器(W10,设计见 image2-per-image-adapter-brief.md)。
 *
 * new-api 把 gpt-image-2 的请求(OpenAI Images 形)按渠道路由到这里,适配器:
 *  1. 【守门】只接盈利档 —— 合成售价 ≥ 守门线(≈¥0.15,高于上游按张成本 ¥0.1;operator
 *     2026-08-11 拍板售价制,档位随官方公式自动划分:high 各尺寸都过线,low/auto/standard
 *     与小尺寸 medium 全在线下)。线下的 + size 不明的 → 503,new-api RetryTimes failover
 *     回 adobe 渠道,客户无感;调上游【之前】拒,不花钱。4xx 会被 new-api 当终态甩给客户,
 *     所以守门必须 5xx。
 *  2. 调真实上游拿图(Authorization 透传 = 渠道 key 就是上游 key)。
 *  3. 【合成 usage】丢弃上游的假 token(ominiapi 恒报 1120,按现口径计费必亏),按
 *     officialOutputTokens(官方计算器逐 token 精确公式)合成 —— 客户拿官方文档的
 *     计算器核对分毫不差(2026-08-11 之前是 4 档打平表,4K 恒 14000 被客户识破)。
 *     new-api 读 usage.input_tokens/output_tokens 计费。
 *  4. 上游任何失败(非 2xx / 无图 / 超时)→ 不合成 usage(不扣客户)+ 503 让 new-api 切渠道。
 *     上游是网关,按 memory failover-error-taxonomy:网关拒终态化零收益,一律让 azure 兜底。
 *
 * 图片存储 / C2PA 脱敏不在这层做 —— 客户代理回程(/v1 route reshape)已做,这层只返 b64+usage。
 */
import { NextRequest, NextResponse } from 'next/server';
import { IMAGE_PROVIDERS, type ImageProvider } from './providers';

export type ImageMode = 'generations' | 'edits';

const UPSTREAM_TIMEOUT_MS = 300_000; // 实测 ominiapi 4K 出图 54-92s,给足余量
/** n>1 扇出的上限(对齐 OpenAI images 的 n≤10)。超出只钳制不报错 —— 客户仍拿到 10 张,
 *  也挡住 n=100 这种把单请求内存推到 GB 级(4K 单张 b64 ~12-17MB)的用法。 */
const MAX_FANOUT = 10;

// ============ 官方 token 公式(核心计费杠杆)============
// 2026-08-11 从官方计算器组件源码提取(developers.openai.com 的
// GptImage2TokenCalculator.react.*.js),226 个采样点(含 16px 细步长扫描)逐 token 一致:
// 长边固定 16/48/96 个 patch(按 quality),短边按长短比取整,token = ceil(patch 数 ×
// (2e6 + w·h) / 4e6)。任意合法尺寸都适用(官方约束:16 整除、边 ≤3840、比例 ≤3:1、
// 总像素 65.5 万~829.4 万);约束外的尺寸上游本来就会拒,这里不重复校验。
// adobe 链路在 ≤1.5K 尺寸与此公式逐点相等,2K+ 才是它自己的刻度(4K-high 19,755 vs 官方 13,342)。
type Quality = 'low' | 'medium' | 'high';
const QUALITY_GRID: Record<Quality, number> = { low: 16, medium: 48, high: 96 };

export function officialOutputTokens(w: number, h: number, quality: Quality): number {
    const long = Math.max(w, h);
    const short = Math.min(w, h);
    const grid = QUALITY_GRID[quality];
    const patches = grid * Math.round((grid * short) / long);
    return Math.ceil((patches * (2_000_000 + w * h)) / 4_000_000);
}

/** "3840x2160" → {w,h};非 WxH(auto/缺省/比例串)→ null(守门按不明处理)。 */
export function parseSize(size: string): { w: number; h: number } | null {
    const m = /^(\d{2,4})x(\d{2,4})$/.exec(size.trim());
    if (!m) return null;
    const w = Number(m[1]);
    const h = Number(m[2]);
    return w > 0 && h > 0 ? { w, h } : null;
}

function normQuality(q: string): Quality {
    const s = q.trim().toLowerCase();
    // auto/standard/缺省/未知 → low:上游对 auto 实测按 low 刻度计费(2026-08-06 发现按 medium
    // 归档时同请求价差 6.9×)。low 必在守门线下 → 这类请求全部交 failover 渠道,适配器不再超收。
    return s === 'medium' || s === 'high' ? s : 'low';
}

/** 守门线:合成售价必须显著高于上游按张成本(¥0.1/张)。
 *  售价 ≈ ct × CompletionRatio(6) × ModelRatio(2.5) × GroupRatio(≈1.3) / 500k(500k quota=¥1),
 *  ¥0.15 ⇒ 3,846 token。线下:low/auto/standard 全族(≤659)、小尺寸 medium(1K=1,756、
 *  4K=3,336);线上:high 常用尺寸全部(1024²=7,024 起)、大方图 medium(2560²=4,927 起)。
 *  调价只动这一个数,档位随官方公式自动跟着走。 */
const MIN_SYNTH_CT = 3_846;

export function isProfitable(perImageCt: number): boolean {
    return perImageCt >= MIN_SYNTH_CT;
}

/** 长图阈值:长/短边比 > 1.5 视为"狭长"(16:9=1.778 命中;3:2=1.5 及方图不命中)。
 *  依据:azure 按面积计费、官方按 patch 网格(长边罚 patch),两者在方图/3:2 逐点吻合,
 *  从比 3:2 更狭长起 azure 明显偏高(16:9 高 48~86%)。狭长图恰是"客户对不上官方账单"的重灾区。 */
const ELONGATED_RATIO = 1.5;

/** 狭长形(长/短 > 1.5)→ 该走适配器拿【官方合成账单】,不论盈利档。
 *  方图/3:2 与 azure 本就吻合,无账单收益 → 仍按盈利档守门(isProfitable)。 */
export function isElongated(w: number, h: number): boolean {
    return Math.max(w, h) / Math.min(w, h) > ELONGATED_RATIO;
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

/** 单张输入图 token(edits 输入侧):85 + 每 MP 1500(校准到 prod edit avg pt≈1831),
 *  MP 封顶 2 —— azure 真实口径会把大输入图降采样,pt 很少超 5k;不封顶时 4K 输入图会算到
 *  1.3万 token/张,多图 edits 合成 pt 5.8万、比 azure 贵近一倍(2026-08-04 首灰实测,
 *  c-ff22024e 2K-high 多图单次 ¥1.08 vs azure 同类 ~¥0.59)。 */
function inputImageTokens(dims: { w: number; h: number } | null): number {
    const mp = dims ? Math.min(2, Math.max(1, Math.ceil((dims.w * dims.h) / 1_000_000))) : 1;
    return 85 + mp * 1500;
}

export interface SynthUsageInput {
    mode: ImageMode;
    /** 请求的输出尺寸(已通过 parseSize 解析;守门保证到这里必有值)。 */
    w: number;
    h: number;
    quality: Quality;
    prompt: string;
    /** edits 输入图的尺寸(读不出的项传 null,按 1MP 兜底)。 */
    inputImageDims: Array<{ w: number; h: number } | null>;
    /** 实际出图张数(按上游真实返回计,n>1 时按张累加)。 */
    imageCount: number;
}

/** 按请求参数合成 usage(彻底丢弃上游 token)。
 *
 *  【只发 OpenAI images 官方那套字段】—— `input_tokens` / `output_tokens` / `total_tokens` / `*_details`。
 *  曾经额外附送 chat 形别名 `prompt_tokens` / `completion_tokens`(照搬 /v1 route 的
 *  `buildEstimatedUsage` 先例),结果中继型客户把 images 家族【加】进 chat 家族做归一化 → 两套同值
 *  相加 → 客户账面 token 翻倍(2026-08-04 实测:input 709/output 14000 被报成 prompt 1418/
 *  completion 28000,而 total 仍是单份 14709 —— 正是"加了两遍"的签名)。我方计费不受影响
 *  (new-api 从 input/output 取值),但客户侧统计虚高。
 *
 *  别名也没有存在的必要:azure 渠道(ch83/ch153)上游自带 usage → `buildEstimatedUsage` 不触发 →
 *  它们本来就只返回官方字段。适配器多送一套反而让【同一个模型不同渠道 usage 形状不一致】。
 *  `buildEstimatedUsage` 那处保持不动 —— 它只在上游完全不回 usage 时兜底,是另一个场景(PR #134)。 */
export function synthUsage(inp: SynthUsageInput): Record<string, unknown> {
    const perImage = officialOutputTokens(inp.w, inp.h, inp.quality);
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
    };
}

// ============ 错误与守门响应 ============

/** 5xx = 让 new-api 重试/failover 到其它 gpt-image-2 渠道(4xx 会被当终态甩给客户)。
 *
 *  【响应体恒定中性,分类码与原因串只进服务端日志】—— new-api 在自己的错误里会把上游 body 原文
 *  嵌进去(建渠道时测试按钮把整页 404 HTML 塞进 message 即实证),所以 gpt-image-2 全部渠道同时
 *  挂时,这里写进 body 的任何内容都可能被客户读到:`size_not_served` 这类分类码会泄漏"按尺寸分档
 *  路由"的内部结构,原因串还可能带出上游错误原文里 sanitizeAdapterError 正则没覆盖到的字眼。 */
function failover(code: string, reason: string): NextResponse {
    console.warn('[image-adapter] failover', { code, reason });
    return NextResponse.json(
        {
            error: {
                message: 'The server is temporarily unable to process this request, please retry later.',
                type: 'server_error',
                code: 'upstream_unavailable',
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

/**
 * 单次上游调用 → 返回该次拿到的图片 b64 数组;任何失败返 null(原因已记日志,调用方决定是否 failover)。
 *
 * 【为什么每次只要 1 张】ominiapi 实测**完全忽略 `n`**(传 n=2 仍只回 1 张,2026-08-04 直连验证),
 * 而 azure 渠道是支持 n 的 —— 适配器 prio 25 截走 4K/2K-high 后,客户的多图请求只能拿到 1 张
 * (今天 71 条请求 / 4 个客户中招)。所以 n>1 由适配器【并发扇出 n 次单图请求】自己实现。
 * 同 prompt 重复调用返回的图确实不同(实测两次字节与 hash 均不同),扇出有意义。
 * 计费天然正确:synthUsage 按【实际拿到的张数】算,部分失败就按少的张数收。
 */
async function callUpstreamOnce(
    provider: ImageProvider,
    providerName: string,
    mode: ImageMode,
    parsed: ParsedRequest,
    auth: string,
): Promise<string[] | null> {
    const url = `${provider.baseUrl}/v1/images/${mode}`;
    // body 每次重建(FormData 一次性语义),且【不传 n】—— 每次调用只取 1 张
    let upstreamBody: BodyInit;
    const headers: Record<string, string> = { authorization: auth };
    if (mode === 'edits') {
        const f = new FormData();
        f.append('model', 'gpt-image-2');
        f.append('prompt', parsed.prompt);
        f.append('size', parsed.size.trim());
        f.append('response_format', 'b64_json'); // 不带时 ominiapi 返自家 OSS url(上游身份泄漏),显式要 b64
        if (parsed.quality) f.append('quality', normQuality(parsed.quality));
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
        return null;
    } finally {
        clearTimeout(timer);
    }

    if (!upstream.ok) {
        // 上游是网关:它的 4xx/5xx 不终态化,交由调用方 503 让 new-api 切别的渠道兜底。
        const errText = await upstream.text().catch(() => '');
        console.warn('[image-adapter] upstream error', {
            provider: providerName,
            mode,
            status: upstream.status,
            ms: Date.now() - started,
            body: sanitizeAdapterError(errText.slice(0, 500), provider.brand),
        });
        return null;
    }

    const data = (await upstream.json().catch(() => null)) as {
        data?: Array<{ b64_json?: string; url?: string }>;
    } | null;
    const rawItems = Array.isArray(data?.data) ? data.data.filter((it) => it && (it.b64_json || it.url)) : [];
    if (rawItems.length === 0) {
        console.warn('[image-adapter] upstream returned no image', {
            provider: providerName,
            mode,
            ms: Date.now() - started,
        });
        return null;
    }

    // 上游 URL 一律不外泄(response_format 被无视时仍可能返 url —— 它指向上游自家 OSS,
    // 直接透传 = azure 伪装穿帮 + cache 链接会过期)→ 这里拉下来转 b64;拉不动 → 本次算失败。
    const out: string[] = [];
    for (const it of rawItems) {
        if (it.b64_json) {
            out.push(it.b64_json);
            continue;
        }
        const b64 = await fetchImageAsB64(it.url as string);
        if (!b64) {
            console.warn('[image-adapter] url→b64 fetch failed', { provider: providerName, mode });
            return null;
        }
        out.push(b64);
    }
    return out;
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
    // 狭长形(16:9 类,长/短 > 1.5)不论盈利档一律放行 → 走适配器拿官方合成账单
    // (azure 面积刻度对狭长图高收 48~86%,客户对不上官方计算器;方图/3:2 仍按盈利档守门)。
    const dims = parseSize(parsed.size);
    const quality = normQuality(parsed.quality);
    const perImageCt = dims ? officialOutputTokens(dims.w, dims.h, quality) : 0;
    const elongated = dims ? isElongated(dims.w, dims.h) : false;
    if (!dims || (!elongated && !isProfitable(perImageCt))) {
        console.log('[image-adapter] gate reject', {
            provider: providerName,
            mode,
            size: parsed.size,
            quality,
            perImageCt,
        });
        return failover(
            'below_gate',
            `size ${parsed.size || 'unknown'} / quality ${quality} (ct ${perImageCt}) below sell-price gate`,
        );
    }

    // ---- 调真实上游(n>1 时并发扇出,见 callUpstreamOnce 头部注释)----
    const started = Date.now();
    const fanout = Math.min(parsed.n, MAX_FANOUT);
    if (parsed.n > MAX_FANOUT) {
        console.warn('[image-adapter] n clamped', { provider: providerName, requested: parsed.n, used: MAX_FANOUT });
    }
    const results = await Promise.all(
        Array.from({ length: fanout }, () => callUpstreamOnce(provider, providerName, mode, parsed, auth)),
    );
    const items = results.flatMap((b64s) => (b64s ?? []).map((b64_json) => ({ b64_json })));
    if (items.length === 0) {
        // 全军覆没才 failover(部分成功 → 返回拿到的那几张,按张计费)
        return failover('upstream_error', `all ${fanout} upstream call(s) failed`);
    }
    if (items.length < fanout) {
        console.warn('[image-adapter] partial fanout', {
            provider: providerName,
            mode,
            requested: fanout,
            got: items.length,
        });
    }

    // ---- 合成 usage(丢弃上游假 token)----
    const usage = synthUsage({
        mode,
        w: dims.w,
        h: dims.h,
        quality,
        prompt: parsed.prompt,
        inputImageDims: parsed.images.map((img) => imageDimensions(img.buf)),
        imageCount: items.length,
    });
    console.log('[image-adapter] ok', {
        provider: providerName,
        mode,
        size: parsed.size,
        quality,
        nRequested: parsed.n,
        images: items.length,
        pt: usage.input_tokens,
        ct: usage.output_tokens,
        ms: Date.now() - started,
    });
    return NextResponse.json({ created: Math.floor(Date.now() / 1000), data: items, usage });
}
