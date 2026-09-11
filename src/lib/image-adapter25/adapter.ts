/**
 * gpt-image-2.5(flare / sunburst)按张计费上游 → 伪装官方 gpt-image-2.5 的适配器。
 *
 * 与 @/lib/image-adapter(gpt-image-2)【完全独立】:不 import 它的任何逻辑、不改它一行
 * (operator 2026-09-09 拍板)。只复用纯字节工具 stripAdobeImageMetadataB64(内容自定向 C2PA 剥离)。
 *
 * 2.5 与 2.0 的本质差异,全部在这里重新设计:
 *  1. quality 5 档:low/medium/high/xhigh/max(+auto→low)。官方 patch 公式不变,网格从 3 档扩成
 *     5 档 {16,24,48,64,96}。⚠️ 2.0 的 normQuality 会把 xhigh/max 归一成 low(35 倍少收),
 *     这正是不能混改 2.0 的原因之一。
 *  2. 一渠道承两模型:按客户请求的 model 透传(白名单),不写死。
 *  3. 输入图 token 对齐官方 2.5 口径:32px patch、上限 1536 patch、超限等比缩小取 floor
 *     (5 个尺寸实测逐点命中,含 3840×2160 超顶非方图 1508)—— 不再用 2.0 的 85+MP×1500 估算。
 *  4. n 原生 honor(上游实测返 n 张),不扇出;按【实际返回张数】计费。
 *  5. 不发 response_format:官方 gpt-image 默认返 b64 且【拒收】该参数(viper3 官 key 实测 400),
 *     上游若返 url 则拉回转 b64 兜底,绝不外泄上游 url。
 *  6. output_format 透传给上游(官方原生支持 png/jpeg/webp);交付前按字节 sniff,请求 jpeg 而
 *     上游未兑现时服务端转码兜底。
 *
 * 与 2.0 相同的守则(重新实现,不共享代码):守门/失败一律 503 中性体让 new-api failover
 * (4xx 会被当终态甩给客户);内容安全 / 请求本身错终态化为官方形;错误体品牌脱敏;计费按
 * 【返回图实际尺寸】合成官方 usage(防上游静默降级超收);透明请求校验真 alpha;C2PA 按内容剥
 * (OpenAI 原生签名原样保留 = 客户可验官方凭证);响应带官方枚举 echo(直连 :3000 绕过 portal
 * 的客户也拿合规响应)。
 */
import { NextRequest, NextResponse } from 'next/server';
import { stripAdobeImageMetadataB64 } from '@/lib/proxy/image-metadata';
import { IMAGE_PROVIDERS_25, type ImageProvider25 } from './providers';

export type ImageMode = 'generations' | 'edits';

/** 与链路其余各层对齐(Caddy 3010 response_header_timeout 600s、undici dispatcher 600s)。 */
const UPSTREAM_TIMEOUT_MS = 600_000;
/** 对齐 OpenAI images 的 n≤10;超出只钳制不报错。 */
const MAX_N = 10;

// ============ 官方 token 公式(5 档网格)============
// 2026-09-09 用 viper3 官 key 交叉验证:1024² low 196 / medium 439 / high 1756 / xhigh 3122 / max 7024,
// 1536×1024 high 1372、2048² high 3568、2880² high 5930、3840×2160 high 3336 —— 与 gpt-image-2 的
// 官方计算器公式同源:长边固定 grid 个 patch,短边按长短比取整,token = ceil(patch 数 × (2e6 + w·h) / 4e6)。
export type Quality25 = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const QUALITY_GRID_25: Record<Quality25, number> = { low: 16, medium: 24, high: 48, xhigh: 64, max: 96 };
const QUALITY_25_SET = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max']);

export function officialOutputTokens25(w: number, h: number, quality: Quality25): number {
    const long = Math.max(w, h);
    const short = Math.min(w, h);
    const grid = QUALITY_GRID_25[quality];
    const patches = grid * Math.round((grid * short) / long);
    return Math.ceil((patches * (2_000_000 + w * h)) / 4_000_000);
}

/** 输入图 token(edits 输入侧)—— 官方 2.5 口径:32px patch,总 patch 上限 1536,超限按 √(1536/n)
 *  等比缩小、两轴各取 floor。实测(asian-acc 官方直通 usage.input_tokens_details.image_tokens):
 *  1024²→1024、1536×1024→1536(恰触顶)、1280×720→920、2048²→1521(39²)、3840×2160→1508(52×29,
 *  round 会得 1560 → 坐实 floor)。读不出尺寸 → 按 1024²(1024)兜底。 */
export function officialInputImageTokens25(dims: { w: number; h: number } | null): number {
    if (!dims) return 1024;
    let pw = Math.ceil(dims.w / 32);
    let ph = Math.ceil(dims.h / 32);
    const n = pw * ph;
    if (n > 1536) {
        const s = Math.sqrt(1536 / n);
        pw = Math.floor(pw * s);
        ph = Math.floor(ph * s);
    }
    return Math.max(1, pw * ph);
}

/** 归一 quality:5 档原样;auto / 缺省 / 未知 → low(上游对 auto 实测按 low 刻度 196 计)。 */
export function normQuality25(q: string): Quality25 {
    const s = q.trim().toLowerCase();
    return QUALITY_25_SET.has(s) ? (s as Quality25) : 'low';
}

/** "3840x2160" → {w,h};非 WxH(auto/缺省/比例串)→ null(交由上游默认,按返回图实际尺寸计费)。 */
export function parseSize(size: string): { w: number; h: number } | null {
    const m = /^(\d{2,4})x(\d{2,4})$/.exec(size.trim());
    if (!m) return null;
    const w = Number(m[1]);
    const h = Number(m[2]);
    return w > 0 && h > 0 ? { w, h } : null;
}

/** prompt 文本 token 粗估(CJK ~1.5 tok/字,其余 ~1 tok/4 字符;同 2.0 / proxy 口径)。 */
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

// ============ 字节工具(独立实现,不从 2.0 适配器 import)============

/** dep-free 尺寸解析(PNG IHDR / JPEG SOF),读不出 → null。 */
export function imageDimensions(buf: Buffer): { w: number; h: number } | null {
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

/** 返图是否带真 alpha 通道:PNG colortype 6/4 → true;PNG 其他 / JPEG → false;识别不出 → null(存疑放行)。 */
export function imageHasAlpha(buf: Buffer): boolean | null {
    if (buf.length >= 26 && buf[0] === 0x89 && buf[1] === 0x50 && buf.toString('latin1', 12, 16) === 'IHDR') {
        const ctype = buf[25];
        return ctype === 6 || ctype === 4;
    }
    if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) return false;
    return null;
}

/** 按首字节魔数判 output_format(png/jpeg/webp);读不出 → ''。 */
export function sniffOutputFormat(buf: Buffer): string {
    if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
    if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP')
        return 'webp';
    return '';
}

/** png/webp base64 → jpeg base64(jimp,失败回退原图,永不抛)。仅在上游未兑现 output_format=jpeg 时兜底。 */
async function toJpegB64(b64: string): Promise<string> {
    try {
        const { Jimp } = await import('jimp');
        const img = await Jimp.read(Buffer.from(b64, 'base64'));
        const jpeg = await img.getBuffer('image/jpeg', { quality: 92 });
        return Buffer.from(jpeg).toString('base64');
    } catch (e) {
        console.warn('[image-adapter25] jpeg transcode failed, keeping original:', e instanceof Error ? e.message : e);
        return b64;
    }
}

// ============ usage 合成 ============

export interface SynthUsageInput25 {
    mode: ImageMode;
    w: number;
    h: number;
    quality: Quality25;
    prompt: string;
    /** edits 输入图尺寸(读不出的项传 null → 按 1024² 兜底)。 */
    inputImageDims: Array<{ w: number; h: number } | null>;
    /** 实际出图张数(按上游真实返回计)。 */
    imageCount: number;
}

/** 只发 OpenAI images 官方那套字段(input/output/total + *_details),不送 chat 形别名(2.0 教训:中继客户会加两遍)。 */
export function synthUsage25(inp: SynthUsageInput25): Record<string, unknown> {
    const perImage = officialOutputTokens25(inp.w, inp.h, inp.quality);
    const ct = perImage * Math.max(1, inp.imageCount);
    const textTokens = estimateTextTokens(inp.prompt);
    let imgTokens = 0;
    if (inp.mode === 'edits') for (const d of inp.inputImageDims) imgTokens += officialInputImageTokens25(d);
    const pt = textTokens + imgTokens;
    return {
        input_tokens: pt,
        input_tokens_details: { text_tokens: textTokens, image_tokens: imgTokens },
        output_tokens: ct,
        output_tokens_details: { image_tokens: ct, text_tokens: 0 },
        total_tokens: pt + ct,
    };
}

// ============ 错误与让路响应 ============

/** 5xx 让 new-api 重试/failover。响应体恒定中性,分类码与原因只进服务端日志(new-api 会把上游 body 原文
 *  嵌进自己的错误,全渠道挂时客户能读到 → 不能泄内部结构)。 */
function failover(code: string, reason: string): NextResponse {
    console.warn('[image-adapter25] failover', { code, reason });
    return NextResponse.json(
        {
            error: {
                message: 'The server is temporarily unable to process this request, please retry later.',
                type: 'server_error',
                param: null,
                code: 'upstream_unavailable',
            },
        },
        { status: 503 },
    );
}

/** 客户可见错误体脱敏:抹上游品牌名 + 常见来源词。 */
export function sanitizeAdapterError25(text: string, brand: RegExp): string {
    return text.replace(brand, 'the provider').replace(/\badobe\b/gi, 'the provider');
}

const UPSTREAM_SAFETY_RE = /image_unsafe|content rejected|appear to be unsafe|safety system|moderation_blocked/i;
const UPSTREAM_BADREQ_RE =
    /prompt is required|invalid image|bad_request|validation_error|invalid image size|total pixels must|quality for .* must be|invalid value/i;
const UPSTREAM_CHANNEL_RE = /no available channel|model_not_found|channel_circuit_open|no active tokens/i;

type TerminalReject = { terminal: 'safety' } | { terminal: 'bad_request'; detail?: string; param?: string | null };
function isTerminalReject(x: string[] | TerminalReject | null): x is TerminalReject {
    return x !== null && !Array.isArray(x);
}

/** 从上游错误体提取【可直接展示的具体原因】(脱敏后)—— 客户报"非法 size 未拦截",其实是拦了但
 *  文案笼统看不出哪错。这里把上游 `error.message`(如 "invalid image size: edges must be
 *  multiples of 16 (got 1024x641)")透出来,让客户能定位。仅用于 bad_request 桶(参数校验类,
 *  本就不含品牌/内部结构);仍过 brand 脱敏防御。提不出干净原因 → 返 ''(退回笼统文案)。 */
function extractBadRequestDetail(text: string, brand: RegExp): { detail: string; param: string | null } {
    let msg = '';
    try {
        const j = JSON.parse(text) as { error?: { message?: unknown } };
        if (typeof j.error?.message === 'string') msg = j.error.message;
    } catch {
        msg = '';
    }
    if (!msg) return { detail: '', param: null };
    const clean = sanitizeAdapterError25(msg, brand).slice(0, 200);
    // 参数归属(官方 error.param 便于 SDK 定位):按关键词判
    const lc = clean.toLowerCase();
    const param = /image size|\bsize\b|edges|pixels|aspect ratio/.test(lc)
        ? 'size'
        : /\bquality\b/.test(lc)
          ? 'quality'
          : /\bprompt\b/.test(lc)
            ? 'prompt'
            : /\bimage\b/.test(lc)
              ? 'image'
              : null;
    return { detail: clean, param };
}

/** 上游 4xx → 是否终态化 + 归类;5xx / 渠道特定 → null(failover)。不确定的 4xx 保守 failover。 */
function classifyUpstreamError(status: number, text: string, brand: RegExp): TerminalReject | null {
    if (status >= 500) return null;
    if (UPSTREAM_CHANNEL_RE.test(text)) return null;
    if (UPSTREAM_SAFETY_RE.test(text)) return { terminal: 'safety' };
    if (UPSTREAM_BADREQ_RE.test(text)) {
        const { detail, param } = extractBadRequestDetail(text, brand);
        return { terminal: 'bad_request', detail, param };
    }
    return null;
}

/** 终态错误(4xx,new-api 不 failover),直接发官方形 —— 直连 :3000 绕过 portal 的客户也拿官方形;
 *  官方 message 含 "safety system" 仍命中 portal 的 IMAGE_SAFETY_RE → portal 再归一幂等。 */
function terminalReject(reject: TerminalReject): NextResponse {
    console.warn('[image-adapter25] terminal reject (no failover)', reject);
    if (reject.terminal === 'safety') {
        return NextResponse.json(
            {
                error: {
                    message:
                        'Your request was rejected as a result of our safety system. Your request may contain content that is not allowed by our safety system.',
                    type: 'user_error',
                    param: null,
                    code: 'moderation_blocked',
                },
            },
            { status: 400 },
        );
    }
    return NextResponse.json(
        {
            error: {
                // 有上游具体原因就透出来(客户能定位到 size/quality),否则退回笼统文案
                message:
                    reject.detail ||
                    'Invalid request: the prompt, image, or parameters were rejected — please check your request.',
                type: 'invalid_request_error',
                param: reject.param ?? null,
                code: 'invalid_request',
            },
        },
        { status: 400 },
    );
}

// ============ 入参解析 ============

interface ParsedRequest {
    model: string;
    prompt: string;
    size: string;
    quality: string;
    n: number;
    images: Array<{ buf: Buffer; type: string; name: string }>;
    /** 透传给上游的其余标量字段。 */
    extras: Record<string, string>;
}

const FORWARD_EXTRAS = new Set(['output_format', 'output_compression', 'background', 'user']);
/** JSON 路径必须是整数的字段(客户常传字符串;multipart 无类型不受影响)。 */
const INT_EXTRAS = new Set(['output_compression']);
/** 透传给上游的 quality 合法值(含 auto,上游原生认;非法值不透传,由上游默认 = auto)。 */
const FORWARD_QUALITY_SET = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'auto']);

async function parseIncoming(req: NextRequest): Promise<ParsedRequest | null> {
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
            model: String(form.get('model') ?? ''),
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
    return {
        model: typeof body.model === 'string' ? body.model : '',
        prompt: typeof body.prompt === 'string' ? body.prompt : '',
        size: typeof body.size === 'string' ? body.size : '',
        quality: typeof body.quality === 'string' ? body.quality : '',
        n: Math.max(1, Number(body.n) || 1),
        images: [],
        extras,
    };
}

/** 拉上游图 URL 转 b64(60s 超时 + 50MB 上限)。失败返 null。 */
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

/** 单次上游调用(n 原生透传,一次拿 n 张)→ b64 数组;终态错返 TerminalReject;其余失败 null(failover)。 */
async function callUpstream(
    provider: ImageProvider25,
    providerName: string,
    mode: ImageMode,
    parsed: ParsedRequest,
    n: number,
    auth: string,
): Promise<string[] | TerminalReject | null> {
    const url = `${provider.baseUrl}/v1/images/${mode}`;
    const headers: Record<string, string> = { authorization: auth };
    const q = parsed.quality.trim().toLowerCase();
    let upstreamBody: BodyInit;
    if (mode === 'edits') {
        const f = new FormData();
        f.append('model', parsed.model);
        f.append('prompt', parsed.prompt);
        if (parsed.size.trim()) f.append('size', parsed.size.trim());
        if (FORWARD_QUALITY_SET.has(q)) f.append('quality', q);
        if (n > 1) f.append('n', String(n));
        for (const [k, v] of Object.entries(parsed.extras)) f.append(k, v);
        for (const img of parsed.images)
            f.append('image', new Blob([new Uint8Array(img.buf)], { type: img.type }), img.name);
        upstreamBody = f; // fetch 自动生成 boundary(不能手写 content-type)
    } else {
        const j: Record<string, unknown> = { model: parsed.model, prompt: parsed.prompt };
        if (parsed.size.trim()) j.size = parsed.size.trim();
        if (FORWARD_QUALITY_SET.has(q)) j.quality = q;
        if (n > 1) j.n = n;
        for (const [k, v] of Object.entries(parsed.extras)) {
            j[k] = INT_EXTRAS.has(k) && /^\d+$/.test(v) ? Number(v) : v;
        }
        // 不发 response_format:官方 gpt-image 默认返 b64 且拒收该参数(viper3 官 key 实测 400)
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
        console.warn('[image-adapter25] upstream fetch failed', {
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
        const errText = await upstream.text().catch(() => '');
        console.warn('[image-adapter25] upstream error', {
            provider: providerName,
            mode,
            status: upstream.status,
            ms: Date.now() - started,
            body: sanitizeAdapterError25(errText.slice(0, 500), provider.brand),
        });
        return classifyUpstreamError(upstream.status, errText, provider.brand);
    }

    const data = (await upstream.json().catch(() => null)) as {
        data?: Array<{ b64_json?: string; url?: string }>;
    } | null;
    const rawItems = Array.isArray(data?.data) ? data.data.filter((it) => it && (it.b64_json || it.url)) : [];
    if (rawItems.length === 0) {
        console.warn('[image-adapter25] upstream returned no image', {
            provider: providerName,
            mode,
            ms: Date.now() - started,
        });
        return null;
    }
    const out: string[] = [];
    for (const it of rawItems) {
        if (it.b64_json) {
            out.push(it.b64_json);
            continue;
        }
        // 上游 url 一律不外泄(指向上游自家 OSS = 伪装穿帮 + 会过期)→ 拉回转 b64;拉不动算失败
        const b64 = await fetchImageAsB64(it.url as string);
        if (!b64) {
            console.warn('[image-adapter25] url→b64 fetch failed', { provider: providerName, mode });
            return null;
        }
        out.push(b64);
    }
    return out;
}

// ============ 主流程 ============

export async function handleAdapter25Image(
    req: NextRequest,
    mode: ImageMode,
    providerName: string,
): Promise<NextResponse> {
    const provider = IMAGE_PROVIDERS_25[providerName];
    if (!provider) return failover('unknown_provider', `image-adapter25 provider '${providerName}' not registered`);
    const auth = req.headers.get('authorization');
    if (!auth)
        return NextResponse.json(
            { error: { message: 'missing Authorization', type: 'invalid_request_error', param: null, code: null } },
            { status: 401 },
        );

    const parsed = await parseIncoming(req);
    if (!parsed) return failover('bad_request_body', 'unparseable request body');

    // ---- 模型白名单:一渠道承两模型,只透传我们认的 2.5 名;不认 = 渠道 models 配错 → 让路 ----
    if (!provider.models.includes(parsed.model)) {
        console.warn('[image-adapter25] model not in provider allowlist', {
            provider: providerName,
            model: parsed.model,
        });
        return failover('model_not_served', `model '${parsed.model}' not served by provider '${providerName}'`);
    }

    // ---- 非法 quality 入口拦截(客户反馈:传 ultra 我们静默按 low 出图 + 计费)----
    // normQuality25 把未知值归一 low 是给 auto/缺省用的;但客户【显式】传了一个非法档位(如 ultra),
    // 应像官方/上游一样明确 400 拒,而不是静默降成 low 出张图还收费。空/缺省不拦(走 auto→low)。
    const rawQ = parsed.quality.trim().toLowerCase();
    if (rawQ && !FORWARD_QUALITY_SET.has(rawQ)) {
        console.warn('[image-adapter25] invalid quality rejected', { provider: providerName, quality: parsed.quality });
        return terminalReject({
            terminal: 'bad_request',
            detail: 'Invalid value for quality. Supported values are: low, medium, high, xhigh, max, auto.',
            param: 'quality',
        });
    }

    const dims = parseSize(parsed.size);
    const quality = normQuality25(parsed.quality);
    const wantsTransparent = (parsed.extras.background || '').trim().toLowerCase() === 'transparent';
    const wantJpeg = (parsed.extras.output_format || '').trim().toLowerCase() === 'jpeg';
    const n = Math.min(parsed.n, MAX_N);
    if (parsed.n > MAX_N)
        console.warn('[image-adapter25] n clamped', { provider: providerName, requested: parsed.n, used: MAX_N });

    // ---- 调上游(n 原生透传,一次拿 n 张)----
    const started = Date.now();
    const result = await callUpstream(provider, providerName, mode, parsed, n, auth);
    if (isTerminalReject(result)) return terminalReject(result);
    let items = (result ?? []).map((b64_json) => ({ b64_json }));
    if (items.length === 0) return failover('upstream_error', 'upstream call failed');
    if (items.length < n) {
        console.warn('[image-adapter25] upstream returned fewer than n', {
            provider: providerName,
            mode,
            requested: n,
            got: items.length,
        });
    }

    // ---- 透明校验:只把真带 alpha 的图交给客户,全丢 → 让路换渠道 ----
    if (wantsTransparent) {
        const kept = items.filter((it) => imageHasAlpha(Buffer.from(it.b64_json, 'base64')) !== false);
        if (kept.length < items.length) {
            console.warn('[image-adapter25] transparent verify dropped opaque image(s)', {
                provider: providerName,
                mode,
                dropped: items.length - kept.length,
                kept: kept.length,
            });
        }
        if (kept.length === 0)
            return failover('transparent_not_delivered', 'upstream returned image(s) without alpha channel');
        items = kept;
    }

    // ---- 计费尺寸:优先【返回图实际尺寸】(防上游静默降级超收);读不出 → 请求值;auto 且读不出 → 让路 ----
    const out0 = items[0]?.b64_json;
    const actualDims = out0 ? imageDimensions(Buffer.from(out0, 'base64')) : null;
    let billW: number;
    let billH: number;
    if (actualDims) {
        billW = actualDims.w;
        billH = actualDims.h;
        if (dims && (dims.w !== actualDims.w || dims.h !== actualDims.h)) {
            console.warn('[image-adapter25] upstream size differs from request, billing by actual', {
                provider: providerName,
                mode,
                requested: parsed.size,
                actual: `${actualDims.w}x${actualDims.h}`,
            });
        }
    } else if (dims) {
        billW = dims.w;
        billH = dims.h;
    } else {
        return failover('unbillable_auto', 'auto size but output image dimensions unreadable');
    }

    // ---- 合成 usage(官方 5 档公式 + 官方输入图口径)----
    const usage = synthUsage25({
        mode,
        w: billW,
        h: billH,
        quality,
        prompt: parsed.prompt,
        inputImageDims: parsed.images.map((img) => imageDimensions(img.buf)),
        imageCount: items.length,
    });

    // ---- output_format=jpeg:官方原生支持已透传;上游未兑现(sniff 非 jpeg)才服务端转码兜底 ----
    if (wantJpeg) {
        for (const it of items) {
            if (sniffOutputFormat(Buffer.from(it.b64_json, 'base64')) !== 'jpeg')
                it.b64_json = await toJpegB64(it.b64_json);
        }
    }

    // ---- C2PA 剥离(内容自定向:仅 adobe/firefly 才剥;OpenAI 原生签名原样保留 = 客户可验官方凭证)----
    for (const it of items) it.b64_json = stripAdobeImageMetadataB64(it.b64_json);

    // ---- 官方枚举 echo(直连 :3000 绕过 portal 的客户也拿合规响应)----
    const outFmt = sniffOutputFormat(Buffer.from(items[0]?.b64_json ?? '', 'base64')) || (wantJpeg ? 'jpeg' : 'png');
    const outBackground = wantsTransparent ? 'transparent' : 'opaque';
    const respSize = `${billW}x${billH}`;
    console.log('[image-adapter25] ok', {
        provider: providerName,
        model: parsed.model,
        mode,
        size: dims && dims.w === billW && dims.h === billH ? parsed.size : `${parsed.size || 'auto'}→${respSize}`,
        quality,
        n,
        images: items.length,
        pt: usage.input_tokens,
        ct: usage.output_tokens,
        ms: Date.now() - started,
    });
    return NextResponse.json({
        created: Math.floor(Date.now() / 1000),
        data: items,
        usage,
        size: respSize,
        quality,
        background: outBackground,
        output_format: outFmt,
    });
}
