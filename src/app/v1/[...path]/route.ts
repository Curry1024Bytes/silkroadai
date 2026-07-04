/**
 * Portal /v1/* catch-all proxy (W9 D1, PR-A — task #33 Phase 1)
 *
 * 拦截所有 ai.silkroadai.io/v1/* 请求(Caddy 切流量到 portal :3002 后生效):
 *
 * 1. POST /v1/chat/completions + Gemini image 模型
 *    → 翻译到 new-api native `/v1beta/models/<model>:generateContent`
 *      并注入 `generationConfig.imageConfig.imageSize`(1K/2K/4K)。
 *      OpenAI SDK 客户端因此能拿到真 2K/4K(chat/completions 兼容层只出 1K,
 *      见 docs/W8-D8-DEPLOY-2026-06-04.md + Channel 17 fix PR #71)。
 *      响应转回 OpenAI chat.completion 格式。
 *      Phase 2(W9 D2,本版):
 *      - 入参支持 OpenAI 多模态 content array:`image_url` 项接受 data URL
 *        (直接解 base64)和外部 http(s) URL(portal fetch 后转 base64),
 *        翻译成 Gemini `inlineData`。外部 URL 有 SSRF 基础守门(协议白名单 +
 *        localhost/私网 IP 字面量拒绝;DNS rebinding 级别的防护留 Phase 3)
 *        + 20MB 大小上限。fetch 失败 → 400(OpenAI invalid_request_error 形)。
 *      - 出图改传 R2(复用 PR-T1 的 `src/lib/r2/client.ts` uploadImage,
 *        key = `gen/{uuid}.{ext}`),content 返 markdown 公网 URL。
 *        R2 不可用时降级回 data URL 内联 + `X-Silkroadai-R2-Fallback: yes`
 *        (客户请求不应因我们的存储故障而失败)。
 *      ⚠️ `gen/` 前缀不在 image-cleanup cron 的管辖内(那个按 ImageGeneration
 *        DB 行删 `image-gen/`),会累积 — operator 可在 R2 配 lifecycle rule。
 *
 * 2. POST /v1/chat/completions + claude-* 且 max_tokens > 4096
 *    → 钳到 4096 + 响应头 `X-Silkroadai-Clamped`(上游号池对超大
 *      max_tokens 限制,超了直接 4xx,钳掉对客户更友好)。
 *
 * 3. POST /v1/images/{edits,generations}(DALL·E 兼容层,W9 D4)
 *    + Gemini 生图模型 → 翻译到 native generateContent(注入 imageSize +
 *      aspect_ratio),响应包成 DALL·E 形 `{ created, data:[{url|b64_json}] }`。
 *      multipart/form-data(对标 gpt-best「Nano-banana」)与 JSON 两种 body 都收。
 *      非 Gemini model(gpt-image-2 等)→ 透传 new-api,成功时补顶层 size + 估算 usage,
 *      上游报错原样透传(详见 handleImagesDalle / reshapeOpenAiImageResponse)。
 *
 * 4. 其余一切(/messages、/models、/embeddings、其他模型的 /chat/completions…)
 *    → 原样透传 new-api,streaming SSE 不缓冲(直接 forward upstream ReadableStream)。
 *
 * 边界:
 * - 本文件不做鉴权 — Authorization 头原样透传,new-api 自己校验 sk-xxx。
 * - DB 访问仅限 Phase 3 的客户 OSS 查询(read-only,且任何 DB 故障都
 *   静默回退平台 R2,绝不阻断客户请求);其余路径不触 DB。
 * - 回滚 = Caddy reverse_proxy 切回 new-api :3000(见 handoff 1.3)。
 *
 * Phase 3(W9 D3):出图存储按优先级:
 *   1. 客户自定义 OSS(/settings/storage 配置,status='active')
 *   2. 失败 → 平台 R2 + `X-Silkroadai-Oss-Fallback: yes`
 *   3. R2 也失败 → data URL 内联 + `X-Silkroadai-R2-Fallback: yes`
 */
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';
import { getCustomerBalance, type CustomerBalance } from '@/lib/billing/customer-balance';
import { USD_TO_CNY_RATE } from '@/lib/newapi/quota-units';
import { uploadImage } from '@/lib/r2/client';
import { objectExistsInOss, ossPublicUrl, uploadToCustomerOss } from '@/lib/oss/client';
import { getOssConfig, resolveUserIdFromAuthHeader } from '@/lib/oss/store';
import {
    type CaptureCtx,
    beginCapture,
    isMediaCaptureSkipped,
    captureJsonResponse,
    captureResponse,
    parseModelAndStream,
    recordRequestBody,
} from '@/lib/reqlog/capture';
import {
    isCacheableClaudeChat,
    buildAnthropicRequest,
    anthropicToOpenAiChat,
    translateAnthropicSseToOpenAi,
} from './claude-chat-cache';
import { withKeepalive } from './keepalive';
import {
    newImageTaskId,
    createImageTask,
    markImageTaskStarted,
    saveImageTaskSuccess,
    saveImageTaskFailure,
    getImageTask,
    buildSubmitEnvelope,
    buildQueryEnvelope,
    notFoundEnvelope,
    buildWebhookForTask,
    type ImageTaskEndpoint,
} from './async-image';

// Next.js: 强制动态 + Node runtime(需要流式 fetch duplex)
export const dynamic = 'force-dynamic';

const NEWAPI_BASE_URL = process.env.NEWAPI_BASE_URL || 'http://localhost:3000';

/** 多图 img2img(≥2 输入图)时 Gemini 会忽略 `imageConfig.aspectRatio`、自行决定输出比例与
 *  构图(实测常出方图或跟随非首图,导致"出图尺寸跟原图不符")。追加这句文字强指令能压住它,
 *  锁定输出 = 第一张参考图的画幅比例与构图(实测 2026-06-24:imageConfig 无效、文字指令有效)。 */
const MULTI_IMAGE_ASPECT_INSTRUCTION =
    '[IMPORTANT] The generated image MUST have the exact same aspect ratio and framing as the FIRST reference image. Do not change the aspect ratio, do not output a square image, do not crop or zoom in. 输出图必须与第一张参考图保持完全相同的画幅比例和构图,不要改变比例、不要输出方图、不要裁剪放大。';

/** 多图 + 客户【显式选了比例】时:Gemini 同样忽略 imageConfig.aspectRatio,改用文字强指令锁定
 *  【客户选的】比例(而非跟随第一张图)—— 否则客户"可选输出比例"的场景会被首图指令误覆盖。
 *  ratio 已过 GEMINI_ASPECT_RATIOS 白名单校验(实测 2026-06-24:文字"必须 16:9"能逼出 16:9)。 */
const explicitAspectInstruction = (ratio: string) =>
    `[IMPORTANT] The generated image MUST have exactly a ${ratio} aspect ratio (width:height = ${ratio}). Do NOT output a square image unless ${ratio} is 1:1, and do NOT follow the reference images' aspect ratio. 输出图必须严格为 ${ratio} 的画幅比例,不要跟随参考图的比例,不要输出方图(除非比例本身就是 1:1)。`;

/** 逆向上游报错(非 2xx)→ 自动转这些非逆向备用 SKU 重试一次。
 *  ch45 逆向源故障形态杂(400 / 429 / 500 do_request_failed / 502 空响应 / 503 memory overloaded),
 *  且其 4xx 多为上游抽风而非真客户端错,故 operator 要求一律兜底 —— 唯一例外是
 *  isTerminalUpstreamError 判定的「重试注定无效」终态错(坏输入图),直接透传。备用 SKU 是独立模型名
 *  (专属非逆向渠道、单独计费)。gemini-3.1-flash-image-preview(ch45 逆向 ¥0.09)→ -hq(ch42 非逆向 ¥0.26)。 */
const FAILOVER_MODELS: Record<string, string> = {
    'gemini-3.1-flash-image-preview': 'gemini-3.1-flash-image-preview-hq',
};

/** flash 主请求超时(ms):逆向 flash 渠道(ch46 xyaigc / ch53 等)尾延迟可达数十分钟
 *  (实测 357413195 客户多条 41-43min 出图)。new-api 自身无 relay 超时,只能在 proxy 这层兜。
 *  到点 abort 当作失败 → 切候补 -hq/ch42(快且稳),客户最多等 ~80s + 候补一次。
 *  仅对有候补的 flash 生效;pro(4K 合法耗时长、无候补)不设超时。operator:80s 自动切。 */
const FLASH_TIMEOUT_MS = 80_000;

/** 主请求非 2xx 后读错误 body(做终态分类)的超时:逆向渠道可能 headers 到了、body 滴流不完,
 *  不设钟会把本该立即切候补的兜底卡死。到点 abort → 当读不出 → 照旧兜底。 */
const ERROR_BODY_TIMEOUT_MS = 5_000;

/** Gemini image 模型 → 注入的 native imageSize(客户没选 size 时的固定档) */
const GEMINI_IMAGE_MODELS: Record<string, '1K' | '2K' | '4K'> = {
    'gemini-2.5-flash-image': '1K',
    'gemini-3.1-flash-image-preview': '2K',
    'gemini-3-pro-image-preview': '4K',
    // 折扣 SKU:= pro 锁 2K(size 参数对它无效),new-api 单独计 ¥0.30(4K 原名仍 ¥0.50)。
    // model_mapping(ch#24/#17)把它翻回 gemini-3-pro-image-preview 给上游。见 configure-pro-2k-sku.mjs。
    'gemini-3-pro-image-preview-2k': '2K',
};

/** 仅这些模型允许客户用 `size` 选 imageSize(其余按 GEMINI_IMAGE_MODELS 固定档,size 被忽略)。
 *  pro 上限 4K → 1K/2K/4K 都合法。 */
const SIZE_SELECTABLE_MODELS = new Set<string>(['gemini-3-pro-image-preview']);

/** "2K"/"4K"/"2048x2048" 等 → 规范 imageSize;无法识别返 null(调用方据此 400)。 */
function normalizeImageSize(raw: string): '1K' | '2K' | '4K' | null {
    const s = raw.trim().toLowerCase();
    if (s === '1k' || s === '1024x1024') return '1K';
    if (s === '2k' || s === '2048x2048') return '2K';
    if (s === '4k' || s === '4096x4096') return '4K';
    return null;
}

/** 客户传的 size 非法时抛此错,调用方转 400 invalid_request_error。 */
class ImageSizeError extends Error {}

/** model + 客户传的 size 原始值 → 最终 imageSize。
 *  非 size-selectable 模型(或客户没传 size):忽略 size,返回该模型固定档。
 *  size-selectable 且传了无法识别的值:抛 ImageSizeError(调用方转 400)。 */
function resolveImageSize(model: string, sizeRaw: string): '1K' | '2K' | '4K' {
    const fixed = GEMINI_IMAGE_MODELS[model];
    if (!SIZE_SELECTABLE_MODELS.has(model) || !sizeRaw) return fixed;
    const norm = normalizeImageSize(sizeRaw);
    if (!norm) {
        throw new ImageSizeError(`unsupported size "${sizeRaw}". Use 2K / 4K (or 2048x2048 / 4096x4096).`);
    }
    return norm;
}

/** Gemini 官方支持的 aspect_ratio 白名单(按模型分档,key 与 GEMINI_IMAGE_MODELS 对齐)。
 *  来源:ai.google.dev image-generation 文档 + Vertex 3-pro-image 文档(2026-06 查证)。
 *  pro 档比 flash 多 1:4 / 1:8 / 8:1 三个极端比例。 */
const GEMINI_ASPECT_RATIOS: Record<string, ReadonlySet<string>> = {
    'gemini-2.5-flash-image': new Set(['21:9', '16:9', '4:3', '3:2', '1:1', '9:16', '3:4', '2:3', '5:4', '4:5']),
    'gemini-3.1-flash-image-preview': new Set([
        '21:9',
        '16:9',
        '4:3',
        '3:2',
        '1:1',
        '9:16',
        '3:4',
        '2:3',
        '5:4',
        '4:5',
    ]),
    'gemini-3-pro-image-preview': new Set([
        '1:1',
        '2:3',
        '3:2',
        '3:4',
        '4:3',
        '4:5',
        '5:4',
        '9:16',
        '16:9',
        '21:9',
        '1:4',
        '1:8',
        '8:1',
    ]),
};
// 折扣 SKU 与 pro 同源 → 复用 pro 档的 aspect_ratio 白名单(否则 allowed.has 会在 undefined 上抛)
GEMINI_ASPECT_RATIOS['gemini-3-pro-image-preview-2k'] = GEMINI_ASPECT_RATIOS['gemini-3-pro-image-preview'];

const CLAUDE_MAX_TOKENS_CAP = 4096;

/** 外部 image_url fetch 的大小上限(Gemini inline 也有自己的上限,先在我们这层挡) */
const IMAGE_FETCH_MAX_BYTES = 20 * 1024 * 1024;

/** 不往上游转发的请求头(host/content-length 由 fetch 重算) */
const HOP_BY_HOP_REQUEST_HEADERS = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding']);

/** 不往客户端回传的响应头(body 已被改写/重新分块时这些头会撒谎) */
const STRIP_RESPONSE_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection']);

type JsonRecord = Record<string, unknown>;

/** 运行时可配置的额外剥离请求头(env `PROXY_STRIP_REQUEST_HEADERS`,逗号分隔,小写比较)。
 *  挡掉客户端注入、会干扰上游的头(如 kiro/Bedrock 上游因客户端带 profileArn 相关头而报
 *  "profileArn is required")。动态读 env → 改 .env + 重启即生效,无需重构建。 */
function extraStripRequestHeaders(): Set<string> {
    return new Set(
        (process.env.PROXY_STRIP_REQUEST_HEADERS || '')
            .split(',')
            .map((h) => h.trim().toLowerCase())
            .filter(Boolean),
    );
}

function forwardHeaders(req: NextRequest): Headers {
    const extra = extraStripRequestHeaders();
    const headers = new Headers();
    req.headers.forEach((value, key) => {
        const lk = key.toLowerCase();
        if (!HOP_BY_HOP_REQUEST_HEADERS.has(lk) && !extra.has(lk)) headers.set(key, value);
    });
    return headers;
}

/** 翻译到 native generateContent 时用:复用鉴权头但强制 JSON Content-Type。
 *  原请求可能是 multipart/form-data,若把那个 Content-Type 带给 JSON body,
 *  new-api 会把 JSON 当 multipart 解析 → `bufio: buffer full` / `NextPart: EOF`。 */
function jsonForwardHeaders(req: NextRequest): Headers {
    const h = forwardHeaders(req);
    h.set('content-type', 'application/json');
    return h;
}

/** 错误分类:候补重试【注定无效】的「终态错误」→ 不烧候补调用,原样(且更快)透传给客户。
 *  当前只收一类高置信模式,其余一律维持 operator 决定「任何非 2xx 都兜底」(ch45 逆向源 4xx 多为上游抽风):
 *  —— Gemini 对输入图字节的确定性拒绝(Unable to process input image):候补同为 Gemini,
 *     同一份 inlineData 发过去必然同拒;终态化省一次真实候补上游调用,客户更快拿到同样的 400。
 *     实测已知案例均为客户字节真坏(坏 base64 / 不支持的格式);残余风险是逆向 relay 自己
 *     压/裁图导致同文案(此时候补本可救),靠下方 warn 日志观察反例,有了再收窄。
 *  【特意不收】三类同样"看起来终态"的错 —— 共同原因:若是我方 new-api 网关拒的(鉴权/额度在
 *  relay 之前检查),候补重试只是一次本地空转、连上游都不触,客户结局不变;而同样的文案若来自
 *  上游经销商转发(上游多半也是 new-api 实例,错误文案一模一样),换渠道【能】救 —— 终态化
 *  几乎无收益,误判却会杀掉救援:
 *  - 401 无效令牌(另:新建 key 有 1-2 分钟 token-cache 延迟会误 401,见 memory);
 *  - 403 无权访问 X 分组(我方网关授权拒跟 token.group 走、与模型无关,候补同 token 必同拒);
 *  - insufficient_user_quota(客户真没钱时,候补在网关同样被拒)。 */
function isTerminalUpstreamError(bodyText: string): boolean {
    return /unable to process input image/i.test(bodyText);
}

/** Gemini 生图 native 转发:主模型上游报错(非 2xx)【或超时】时,自动用同一个已翻译好的 body
 *  (contents + imageConfig)转到非逆向备用 SKU 重试一次,仅换 URL 里的模型名(故计费切到备用 SKU)。
 *  flash 非 2xx 视作主渠道挂了 → 兜底转 -hq/ch42(operator:45 所有报错都转 42),
 *  【唯一例外】isTerminalUpstreamError 判定的终态错(坏输入图,重试注定同拒)直接透传不重试。
 *  另:逆向 flash 渠道会出现数十分钟才出图的慢尾(见 FLASH_TIMEOUT_MS),new-api 无 relay 超时,
 *  故主请求挂 80s AbortController,到点 abort 当失败一样切候补 → 客户不会再被卡几十分钟。
 *  只重试一次:备用也报错则原样透传其错,不无限重试。成功(2xx)不转,省一次 ch42 调用。见 FAILOVER_MODELS。 */
async function geminiGenerateWithFailover(req: NextRequest, model: string, requestBody: string): Promise<Response> {
    const url = (m: string) => `${NEWAPI_BASE_URL}/v1beta/models/${m}:generateContent`;
    const send = (m: string, signal?: AbortSignal) =>
        fetch(url(m), { method: 'POST', headers: jsonForwardHeaders(req), body: requestBody, signal });
    const backup = FAILOVER_MODELS[model];
    if (!backup) return send(model); // 无候补(pro 4K 等合法耗时长)→ 不设超时,原样透传
    // flash:主请求 80s 超时,慢渠道到点 abort 当失败、连同非 2xx 一并切候补 -hq/ch42
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FLASH_TIMEOUT_MS);
    let upstream: Response;
    try {
        upstream = await send(model, ctrl.signal);
    } catch {
        console.warn('[proxy/failover] primary timed out or network error, retrying backup', { model, backup });
        return send(backup); // 超时(AbortError)/网络错 → 切候补
    } finally {
        clearTimeout(timer);
    }
    if (upstream.ok) return upstream;
    // 分类需要读错误 body,但必须带钟:ch45 类渠道存在「headers 到了、body 滴流不完」的形态
    // (此时 80s 主钟已在 finally 清掉),无界 text() 会把本该立即触发的兜底卡死。
    // 到点用同一个 ctrl abort 掉 body 流 → errText 留空 → 必然判非终态 → 照旧兜底。
    const readTimer = setTimeout(() => ctrl.abort(), ERROR_BODY_TIMEOUT_MS);
    let errText = '';
    try {
        errText = await upstream.text();
    } catch {
        // body 读挂 / 被 abort → 当读不出,走兜底
    } finally {
        clearTimeout(readTimer);
    }
    // 消费 body 后按原 status/headers 重建响应(content-length/encoding 已随重建失真,
    // 剥掉让下游按新 body 重算;passthroughResponse 本来也剥,这里防走到别的出口)。
    if (isTerminalUpstreamError(errText)) {
        console.warn('[proxy/failover] terminal error, skip backup', {
            model,
            status: upstream.status,
            snippet: errText.slice(0, 200),
        });
        const headers = new Headers(upstream.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');
        headers.set('X-Silkroadai-Failover', 'skipped-terminal');
        return new Response(errText, { status: upstream.status, statusText: upstream.statusText, headers });
    }
    console.warn('[proxy/failover] primary failed, retrying backup', {
        model,
        backup,
        status: upstream.status,
        snippet: errText.slice(0, 200),
    });
    return send(backup); // 其余非 2xx → 切候补
}

function passthroughResponse(upstream: Response): NextResponse {
    const headers = new Headers();
    upstream.headers.forEach((value, key) => {
        if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) headers.set(key, value);
    });
    return new NextResponse(upstream.body, { status: upstream.status, headers });
}

async function forwardToNewApi(
    req: NextRequest,
    bodyOverride: JsonRecord | null,
    path: string,
    search: string,
    cap: CaptureCtx | null = null,
): Promise<NextResponse> {
    const url = `${NEWAPI_BASE_URL}/v1${path}${search}`;
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';

    // 出口体决定:
    // - bodyOverride 在手(A:chat clamp/透传、D 的 JSON 透传)→ 序列化它;
    //   请求体捕获由 call site 用【原始】body 记(clamp 分支要存未钳的),这里不记。
    // - bodyOverride null(出口 B:messages/responses/embeddings…)→ 默认 req.body
    //   stream 直传(**开关 off 字节级不变**);仅捕获激活时才 buffer 出来记 + 转发该串。
    // 兼容:部分客户端(图片生成 SDK 等)把 `n`(生成数量)发成字符串 "1" 而非数字。
    // new-api 的图片/chat 请求结构体要 uint,会报 400/500
    // `json: cannot unmarshal string into Go struct field Alias.n of type uint`。
    // 这里把纯数字字符串的 n 转成数字再转发(只在已解析出 body 的 JSON 透传路径生效)。
    if (bodyOverride && typeof bodyOverride.n === 'string' && /^\d+$/.test(bodyOverride.n.trim())) {
        bodyOverride = { ...bodyOverride, n: parseInt(bodyOverride.n.trim(), 10) };
    }

    let outgoingBody: BodyInit | undefined;
    if (bodyOverride) {
        outgoingBody = JSON.stringify(bodyOverride);
    } else if (hasBody) {
        if (cap) {
            const raw = await req.text();
            const pm = parseModelAndStream(raw);
            recordRequestBody(cap, raw, pm.model, pm.streamed);
            outgoingBody = raw;
        } else {
            outgoingBody = req.body as unknown as BodyInit;
        }
    }

    const init: RequestInit & { duplex?: 'half' } = {
        method: req.method,
        headers: forwardHeaders(req),
        body: outgoingBody,
        duplex: 'half',
    };
    const upstream = await fetch(url, init);
    // 临时诊断(HDR_CAPTURE=1):记上游错误响应,与 [HDRCAP] 请求头按 tokFp+时间对应,
    // 用于坐实客户报的 profileArn 到底哪些请求触发。查完撤。
    if (process.env.HDR_CAPTURE === '1' && upstream.status >= 400) {
        try {
            const tokFp = (req.headers.get('authorization') || req.headers.get('x-api-key') || '')
                .replace(/^Bearer\s+/i, '')
                .slice(-4);
            const errBody = (await upstream.clone().text()).slice(0, 400);
            console.log('[HDRCAP-RESP]', JSON.stringify({ tokFp, status: upstream.status, body: errBody }));
        } catch {
            /* diagnostic only */
        }
    }
    return cap ? captureResponse(cap, upstream) : passthroughResponse(upstream);
}

/** image_url 解析失败 → 客户侧 400(OpenAI invalid_request_error 形) */
class ImageUrlError extends Error {}

/** SSRF 基础守门:只放 http(s) + 拒 localhost / 私网 IPv4 字面量 / IPv6 字面量。
 *  DNS 解析到私网的域名(rebinding)不在本层防护范围 — Phase 3 hardening。 */
function isDisallowedImageUrl(raw: string): boolean {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return true;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
    if (h.includes(':') || h.startsWith('[')) return true; // IPv6 literal
    const ipv4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4) {
        const a = Number(ipv4[1]);
        const b = Number(ipv4[2]);
        if (
            a === 0 ||
            a === 10 ||
            a === 127 ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168)
        )
            return true;
    }
    return false;
}

type GeminiInputPart = { text: string } | { inlineData: { mimeType: string; data: string } };

/** 单个 OpenAI image_url → Gemini inlineData(data URL 直解;外部 URL fetch)。 */
async function imageUrlToInlinePart(url: string): Promise<GeminiInputPart> {
    // 注:JSON string 里不会有裸换行,无需 dotAll(tsconfig target 限制 /s flag)
    const dataUrl = url.match(/^data:([^;,]+);base64,([\s\S]+)$/);
    if (dataUrl) {
        return { inlineData: { mimeType: dataUrl[1], data: dataUrl[2] } };
    }
    if (url.startsWith('data:')) {
        throw new ImageUrlError('image_url data URL must be base64-encoded');
    }
    if (isDisallowedImageUrl(url)) {
        throw new ImageUrlError(`image_url not allowed: ${url.slice(0, 200)}`);
    }
    let resp: Response;
    try {
        resp = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    } catch {
        throw new ImageUrlError(`image_url fetch failed: network error for ${url.slice(0, 200)}`);
    }
    if (!resp.ok) {
        throw new ImageUrlError(`image_url fetch failed: ${resp.status}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength > IMAGE_FETCH_MAX_BYTES) {
        throw new ImageUrlError(`image_url too large: ${buf.byteLength} bytes (max ${IMAGE_FETCH_MAX_BYTES})`);
    }
    const mimeType = resp.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
    return { inlineData: { mimeType, data: buf.toString('base64') } };
}

/** OpenAI message content(string 或 multimodal array)→ Gemini parts。
 *  Phase 2:支持 image_url(data URL / 外部 URL)。解析失败抛 ImageUrlError → 400。 */
async function toGeminiContents(messages: unknown): Promise<Array<{ role: string; parts: GeminiInputPart[] }>> {
    if (!Array.isArray(messages)) return [];
    return Promise.all(
        messages.map(async (m) => {
            const msg = (m ?? {}) as JsonRecord;
            const content = msg.content;
            const parts: GeminiInputPart[] = [];
            if (typeof content === 'string') {
                parts.push({ text: content });
            } else if (Array.isArray(content)) {
                for (const item of content) {
                    const it = (item ?? {}) as JsonRecord;
                    if (it.type === 'text' && typeof it.text === 'string') {
                        parts.push({ text: it.text });
                    } else if (it.type === 'image_url') {
                        const imageUrl = (it.image_url ?? {}) as JsonRecord;
                        if (typeof imageUrl.url !== 'string') {
                            throw new ImageUrlError('image_url.url must be a string');
                        }
                        parts.push(await imageUrlToInlinePart(imageUrl.url));
                    }
                }
            }
            if (parts.length === 0) parts.push({ text: '' });
            return {
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts,
            };
        }),
    );
}

/** 读 JPEG 的 EXIF Orientation(1-8;无 / 读不出 → 1),dep-free 字节解析。
 *  5-8 = 旋转 90°/270°,显示时宽高对调 —— 手机竖拍照片几乎都是 6 或 8
 *  (横像素 + EXIF 转正)。不处理它会把 aspectRatio 注反 → 出图尺寸不符。 */
function jpegExifOrientation(buf: Buffer): number {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return 1;
    let i = 2;
    while (i + 4 <= buf.length) {
        if (buf[i] !== 0xff) return 1;
        const marker = buf[i + 1];
        if (marker === 0xff) {
            i += 1; // padding fill byte
            continue;
        }
        if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
            i += 2; // standalone marker
            continue;
        }
        if (marker === 0xda) return 1; // SOS:图像数据开始,EXIF 必在此前
        const len = buf.readUInt16BE(i + 2);
        if (marker === 0xe1 && i + 10 <= buf.length && buf.toString('latin1', i + 4, i + 10) === 'Exif\x00\x00') {
            const tiff = i + 10; // TIFF header 起点
            if (tiff + 8 > buf.length) return 1;
            const le = buf.toString('latin1', tiff, tiff + 2) === 'II';
            const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
            const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
            const ifd0 = tiff + u32(tiff + 4);
            if (ifd0 + 2 > buf.length) return 1;
            const n = u16(ifd0);
            for (let e = 0; e < n; e++) {
                const entry = ifd0 + 2 + e * 12;
                if (entry + 12 > buf.length) break;
                if (u16(entry) === 0x0112) {
                    const v = u16(entry + 8); // Orientation: SHORT,值内联在 value 字段
                    return v >= 1 && v <= 8 ? v : 1;
                }
            }
            return 1;
        }
        i += 2 + len;
    }
    return 1;
}

/** 从图片字节头读宽高(dep-free,只认 PNG / JPEG / WebP 三种主流格式)。
 *  JPEG 额外读 EXIF Orientation,旋转 90°/270° 时返回【显示】宽高(对调)。
 *  读不出(其他格式 / 截断 / 坏数据)→ null,调用方按"不注入 aspectRatio"降级。 */
function imageDimensions(buf: Buffer): { w: number; h: number } | null {
    // PNG:8 字节签名 + IHDR chunk,width / height 大端在 offset 16 / 20
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
    // JPEG:FF D8 起,顺序扫 segment 找 SOF(C0-CF 除 DHT C4 / JPG C8 / DAC CC),
    // SOF payload = [precision(1)][height(2)][width(2)],大端
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
        let i = 2;
        while (i + 9 <= buf.length) {
            if (buf[i] !== 0xff) return null;
            const marker = buf[i + 1];
            if (marker === 0xff) {
                i += 1; // padding fill byte
                continue;
            }
            if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
                i += 2; // standalone marker(RST/SOI/EOI/TEM)无 length 段
                continue;
            }
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                const h = buf.readUInt16BE(i + 5);
                const w = buf.readUInt16BE(i + 7);
                if (!(w > 0 && h > 0)) return null;
                // EXIF 旋转 90°/270°(orient 5-8)→ 返回显示宽高(对调),否则手机竖拍图被注反比例。
                const o = jpegExifOrientation(buf);
                return o >= 5 && o <= 8 ? { w: h, h: w } : { w, h };
            }
            i += 2 + buf.readUInt16BE(i + 2);
        }
        return null;
    }
    // WebP:RIFF container,VP8(lossy)/ VP8L(lossless)/ VP8X(extended)三种 chunk
    if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
        const chunk = buf.toString('latin1', 12, 16);
        if (chunk === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
            // payload = 3 字节 frame tag + sync code 9D 01 2A + 14-bit 宽 / 高(小端)
            const w = buf.readUInt16LE(26) & 0x3fff;
            const h = buf.readUInt16LE(28) & 0x3fff;
            return w > 0 && h > 0 ? { w, h } : null;
        }
        if (chunk === 'VP8L' && buf[20] === 0x2f) {
            // 签名 0x2F 后 28 bit 打包:14-bit (width-1) + 14-bit (height-1),LSB-first
            const w = 1 + (((buf[22] & 0x3f) << 8) | buf[21]);
            const h = 1 + (((buf[24] & 0x0f) << 10) | (buf[23] << 2) | (buf[22] >> 6));
            return { w, h };
        }
        if (chunk === 'VP8X') {
            // flags(1) + reserved(3) 后 24-bit (canvasWidth-1) / (canvasHeight-1),小端
            const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
            const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
            return { w, h };
        }
        return null;
    }
    return null;
}

/** 在该 model 的官方白名单里找与 w/h 线性距离最近的 aspectRatio(精确比例必命中;
 *  并列时取白名单先出现者)。 */
function closestAspectRatio(w: number, h: number, model: string): string | null {
    const allowed = GEMINI_ASPECT_RATIOS[model];
    if (!allowed) return null;
    const target = w / h;
    let best: string | null = null;
    let bestDiff = Infinity;
    for (const candidate of allowed) {
        const [cw, ch] = candidate.split(':');
        const diff = Math.abs(Number(cw) / Number(ch) - target);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = candidate;
        }
    }
    return best;
}

/** 图生图 auto 语义:Gemini 不给 aspectRatio 时默认 1:1,【不会】自动跟随输入图
 *  (实测纠正 D4-hotfix 的"跟随输入图"假设 — 16:9 输入曾被出成方图)。
 *  所以从第一张输入图(主图;多参考图时取第一张)的字节头读宽高,
 *  映射到该 model 白名单里最接近的比例,由调用方注入。
 *  读不出尺寸 → null,调用方维持"不注入"现状 — 出图绝不因读比例失败而失败。 */
function aspectRatioFromInput(parts: GeminiInputPart[], model: string): string | null {
    const image = parts.find((p): p is { inlineData: { mimeType: string; data: string } } => 'inlineData' in p);
    if (!image) return null;
    const dims = imageDimensions(Buffer.from(image.inlineData.data, 'base64'));
    return dims ? closestAspectRatio(dims.w, dims.h, model) : null;
}

interface GeminiPart {
    text?: string;
    inlineData?: { mimeType: string; data: string };
}

interface StoredImage {
    /** url 模式用:公网 URL(客户 OSS / 平台 R2)或降级时的 data URL */
    url: string;
    ossFallback: boolean;
    r2Fallback: boolean;
}

/** 生成的 base64 图 → 客户 OSS / 平台 R2 / data URL 内联,三级降级。
 *  任何故障(DB / OSS / R2)都不抛 — 客户请求绝不因我们的存储故障而失败。
 *  chat(handleGeminiImage)与 images(handleImagesDalle)两条路复用此函数。 */
async function storeGeneratedImage(
    req: NextRequest,
    buffer: Buffer,
    mimeType: string,
    base64: string,
): Promise<StoredImage> {
    const ext = mimeType.includes('jpeg') ? 'jpg' : mimeType.includes('webp') ? 'webp' : 'png';
    const key = `gen/${randomUUID()}.${ext}`;
    let ossFallback = false;

    // Phase 3:sk-xxx 反查 portal user → 客户 OSS 配置(查询失败一律回平台 R2)
    let customerUrl: string | null = null;
    try {
        const userId = await resolveUserIdFromAuthHeader(req.headers.get('authorization'));
        const ossConfig = userId ? await getOssConfig(userId) : null;
        if (ossConfig && ossConfig.status === 'active') {
            try {
                customerUrl = await uploadToCustomerOss(ossConfig, buffer, key, mimeType);
            } catch (e) {
                console.warn('[v1-proxy] customer OSS upload failed, falling back to platform R2', e);
                ossFallback = true;
            }
        }
    } catch (e) {
        // DB 故障等(resolve 重试一次后仍失败才会到这)— 走平台 R2 不阻断请求,
        // 但要打日志 + 带 X-Silkroadai-Oss-Fallback 头,让配了 OSS 的客户可检测
        // (2026-06-12 教训:此前 resolve 内部静默吞错,客户图无声落平台 R2 零痕迹)
        console.warn('[v1-proxy] customer OSS lookup failed, using platform R2', e);
        ossFallback = true;
    }

    if (customerUrl) return { url: customerUrl, ossFallback, r2Fallback: false };

    try {
        const url = await uploadImage(key, buffer, mimeType);
        return { url, ossFallback, r2Fallback: false };
    } catch (e) {
        console.warn('[v1-proxy] R2 upload failed, falling back to inline data URL', e);
        return { url: `data:${mimeType};base64,${base64}`, ossFallback, r2Fallback: true };
    }
}

async function handleGeminiImage(
    req: NextRequest,
    body: JsonRecord,
    model: string,
    cap: CaptureCtx | null = null,
): Promise<NextResponse> {
    // size:仅 pro 可选 1K/2K/4K(默认 4K),其余模型忽略;非法值 → 400。
    let imageSize: '1K' | '2K' | '4K';
    try {
        imageSize = resolveImageSize(model, String(body.size ?? ''));
    } catch (e) {
        if (e instanceof ImageSizeError) return imageError(e.message, 400, cap);
        throw e;
    }
    let contents: Array<{ role: string; parts: GeminiInputPart[] }>;
    try {
        contents = await toGeminiContents(body.messages);
    } catch (e) {
        if (e instanceof ImageUrlError) {
            const err = { error: { message: e.message, type: 'invalid_request_error' } };
            if (cap) captureJsonResponse(cap, 400, err);
            return NextResponse.json(err, { status: 400 });
        }
        throw e;
    }

    // chat 形态没有 aspect_ratio 参数,等同 auto:文生图不注入(走 Gemini 默认);
    // 图生图(image_url 入参)读输入图尺寸注入最近的合法比例 — Gemini 默认 1:1
    // 不跟随输入图(见 aspectRatioFromInput)。与 /v1/images/* 的 auto 行为一致。
    const imageConfig: Record<string, string> = { imageSize };
    const inputAspect = aspectRatioFromInput(
        contents.flatMap((c) => c.parts),
        model,
    );
    if (inputAspect) imageConfig.aspectRatio = inputAspect;

    // 多图(≥2 输入图)时 Gemini 忽略 imageConfig.aspectRatio,改用文字强指令锁定首图画幅。
    if (contents.flatMap((c) => c.parts).filter((p) => 'inlineData' in p).length >= 2) {
        contents[contents.length - 1].parts.push({ text: MULTI_IMAGE_ASPECT_INSTRUCTION });
    }

    const upstream = await geminiGenerateWithFailover(
        req,
        model,
        JSON.stringify({ contents, generationConfig: { imageConfig } }),
    );

    if (!upstream.ok) {
        // 上游错误(401 / 429 / 5xx)原样透传 status + body,客户端能看到 new-api 的错误信息
        return cap ? captureResponse(cap, upstream) : passthroughResponse(upstream);
    }

    const upstreamData = (await upstream.json()) as {
        candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
    };
    const parts: GeminiPart[] = upstreamData.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find((p) => p.inlineData);

    let content: string;
    let stored: StoredImage | null = null;
    if (imagePart?.inlineData) {
        // Phase 2/3:客户 OSS → 平台 R2 → data URL 内联,三级降级(请求不失败)
        const { mimeType, data } = imagePart.inlineData;
        stored = await storeGeneratedImage(req, Buffer.from(data, 'base64'), mimeType, data);
        content = `![image](${stored.url})`;
    } else {
        content = parts.find((p) => typeof p.text === 'string')?.text ?? 'No image generated';
    }

    const openaiResp = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: {
            prompt_tokens: upstreamData.usageMetadata?.promptTokenCount ?? 0,
            completion_tokens: upstreamData.usageMetadata?.candidatesTokenCount ?? 0,
            total_tokens: upstreamData.usageMetadata?.totalTokenCount ?? 0,
        },
    };

    const respHeaders: Record<string, string> = { 'X-Silkroadai-Translated': 'gemini-native' };
    if (stored?.ossFallback) respHeaders['X-Silkroadai-Oss-Fallback'] = 'yes';
    if (stored?.r2Fallback) respHeaders['X-Silkroadai-R2-Fallback'] = 'yes';
    // 出图引用:仅记真实公网 URL(data URL 降级时是内联 base64,不当 ref 存)
    if (cap) captureJsonResponse(cap, 200, openaiResp, hostedRefs(stored));
    return NextResponse.json(openaiResp, { status: 200, headers: respHeaders });
}

/** stored 是真实公网 URL(非 data URL 降级)→ [url],否则 []。供 output_image_refs。 */
function hostedRefs(stored: StoredImage | null): string[] {
    return stored && /^https?:\/\//.test(stored.url) ? [stored.url] : [];
}

/** DALL·E 形错误(默认 400 invalid_request_error)。cap 在手时一并捕获。 */
function imageError(message: string, status = 400, cap: CaptureCtx | null = null): NextResponse {
    const obj = { error: { message, type: 'invalid_request_error' } };
    if (cap) captureJsonResponse(cap, status, obj);
    return NextResponse.json(obj, { status });
}

/** gpt-image-2 是图片模型,zhiyunai/Azure 只支持 Images 接口 —— 客户用 /v1/chat/completions
 *  调它会被上游 400「The requested operation is unsupported」。这里把 chat 请求翻成
 *  /v1/images/{generations,edits}(messages 带 image_url → edits,否则 generations),出图存图床
 *  后包成 chat.completion 回复(content = markdown 图 url),与 Gemini 生图(handleGeminiImage)一致。
 *  计费照常由 new-api 按该 images 调用扣(token 计费)。stream:true 同 Gemini 返回非流 JSON。 */
async function handleGptImageChat(
    req: NextRequest,
    body: JsonRecord,
    model: string,
    cap: CaptureCtx | null = null,
): Promise<NextResponse> {
    let contents: Array<{ role: string; parts: GeminiInputPart[] }>;
    try {
        contents = await toGeminiContents(body.messages);
    } catch (e) {
        if (e instanceof ImageUrlError) return imageError(e.message, 400, cap);
        throw e;
    }
    const parts = contents.flatMap((c) => c.parts);
    const prompt = parts
        .map((p) => ('text' in p ? p.text : ''))
        .filter(Boolean)
        .join(' ')
        .trim();
    const inputImages = parts.flatMap((p) => ('inlineData' in p ? [p.inlineData] : []));
    if (!prompt && inputImages.length === 0) {
        return imageError('messages 里需要文字 prompt 或图片', 400, cap);
    }

    // 旧变体名(gpt-image-2-4k 等)→ gpt-image-2 + 对应像素 size(未显式给 size 时)
    const variant = gptImageVariant(model);
    const effModel = variant ? variant.base : model;
    // chat 形态一般不带 size;带了就认像素 size,或把比例("16:9")翻成像素,其余走变体 / 上游默认。
    const sizeRaw = (typeof body.size === 'string' ? body.size : '').trim();
    let size: string | undefined;
    if (/^\d{2,4}x\d{2,4}$/.test(sizeRaw)) size = sizeRaw;
    else if (ASPECT_RATIO_RE.test(sizeRaw)) size = aspectToPixelSize(sizeRaw) ?? undefined;
    if (!size && variant) size = variant.size;
    const quality = typeof body.quality === 'string' ? body.quality : undefined;

    let upstream: Response;
    if (inputImages.length > 0) {
        // messages 带 image_url → 图生图 edits(multipart)
        const form = new FormData();
        form.append('model', effModel);
        form.append('prompt', prompt || 'edit the image');
        if (size) form.append('size', size);
        if (quality) form.append('quality', quality);
        for (const img of inputImages) {
            form.append(
                'image',
                new Blob([Buffer.from(img.data, 'base64')], { type: img.mimeType || 'image/png' }),
                'image.png',
            );
        }
        upstream = await fetchUpstreamMultipart(req, form, '/images/edits', '');
    } else {
        // 纯文字 → 文生图 generations(JSON)
        const genBody: JsonRecord = { model: effModel, prompt };
        if (size) genBody.size = size;
        if (quality) genBody.quality = quality;
        upstream = await fetchUpstreamJson(req, genBody, '/images/generations', '');
    }

    if (!upstream.ok) {
        // 上游错误原样透传 status + body(客户能看到真实错误信息)
        return cap ? captureResponse(cap, upstream) : passthroughResponse(upstream);
    }
    const data = (await upstream.json().catch(() => null)) as {
        data?: Array<{ b64_json?: string; url?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
    } | null;
    const item = data?.data?.[0];

    let content: string;
    let stored: StoredImage | null = null;
    if (item?.b64_json) {
        // 客户 OSS → 平台 R2 → data URL 三级降级(同 handleGeminiImage)
        stored = await storeGeneratedImage(req, Buffer.from(item.b64_json, 'base64'), 'image/png', item.b64_json);
        content = `![image](${stored.url})`;
    } else if (item?.url) {
        content = `![image](${item.url})`;
    } else {
        return imageError('上游未返回图片', 502, cap);
    }

    const usage = data?.usage ?? {};
    const openaiResp = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: {
            prompt_tokens: usage.input_tokens ?? 0,
            completion_tokens: usage.output_tokens ?? 0,
            total_tokens: usage.total_tokens ?? 0,
        },
    };
    const respHeaders: Record<string, string> = { 'X-Silkroadai-Translated': 'gpt-image-chat' };
    if (stored?.ossFallback) respHeaders['X-Silkroadai-Oss-Fallback'] = 'yes';
    if (stored?.r2Fallback) respHeaders['X-Silkroadai-R2-Fallback'] = 'yes';
    if (cap) captureJsonResponse(cap, 200, openaiResp, hostedRefs(stored));
    return NextResponse.json(openaiResp, { status: 200, headers: respHeaders });
}

/** gpt-4o-image(zhiyunai chat 生图)返回 markdown 里的 `pro.filesystem.site` CDN 链接(会过期)。
 *  这里强制非流拿到完整响应 → 把图转存到客户 OSS / 平台 R2(复用 storeGeneratedImage)→ 把内容里所有
 *  CDN 链接换成我们的稳定 url。取图失败则保留原链接(客户仍拿得到图,不阻断)。计费不变(new-api 按
 *  chat token 扣)。stream:true 合成单 chunk SSE 返回。 */
async function handleGpt4oImageChat(
    req: NextRequest,
    body: JsonRecord,
    model: string,
    cap: CaptureCtx | null = null,
): Promise<NextResponse> {
    const wantStream = body.stream === true;
    let upstream: Response;
    try {
        upstream = await fetch(`${NEWAPI_BASE_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: jsonForwardHeaders(req),
            body: JSON.stringify({ ...body, stream: false }), // 非流才能取出 url 转存
        });
    } catch (e) {
        return imageError(`upstream request failed: ${e instanceof Error ? e.message : String(e)}`, 502, cap);
    }
    if (!upstream.ok) return cap ? captureResponse(cap, upstream) : passthroughResponse(upstream);

    const data = (await upstream.json().catch(() => null)) as JsonRecord | null;
    const msg = (data?.choices as Array<{ message?: { content?: unknown } }> | undefined)?.[0]?.message;
    const content = typeof msg?.content === 'string' ? msg.content : '';

    const urls = [...content.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]);
    let newContent = content;
    let refs: string[] = [];
    const respHeaders: Record<string, string> = { 'X-Silkroadai-Translated': 'gpt-4o-image-rehost' };
    if (urls.length > 0) {
        try {
            const imgResp = await fetch(urls[0], { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
            if (imgResp.ok) {
                const buf = Buffer.from(await imgResp.arrayBuffer());
                const mime = imgResp.headers.get('content-type')?.split(';')[0] || 'image/png';
                const stored = await storeGeneratedImage(req, buf, mime, buf.toString('base64'));
                // 内容里所有 pro.filesystem.site 链接(图片 + 下载)统一换成我们的稳定 url
                newContent = content.replace(/https?:\/\/pro\.filesystem\.site\/[^)\s"'\]]+/g, stored.url);
                refs = hostedRefs(stored);
                if (stored.ossFallback) respHeaders['X-Silkroadai-Oss-Fallback'] = 'yes';
                if (stored.r2Fallback) respHeaders['X-Silkroadai-R2-Fallback'] = 'yes';
            } else {
                respHeaders['X-Silkroadai-Rehost'] = `skipped-${imgResp.status}`; // 保留原链接
            }
        } catch {
            respHeaders['X-Silkroadai-Rehost'] = 'failed'; // 取图失败 → 保留原链接,不阻断
        }
    }
    if (msg) msg.content = newContent;

    if (cap) captureJsonResponse(cap, 200, (data ?? {}) as JsonRecord, refs);
    if (wantStream) {
        const chunk = {
            id: (data?.id as string) ?? `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: (data?.created as number) ?? Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { role: 'assistant', content: newContent }, finish_reason: 'stop' }],
        };
        respHeaders['content-type'] = 'text/event-stream';
        return new NextResponse(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
            status: 200,
            headers: respHeaders,
        });
    }
    return NextResponse.json(data ?? {}, { status: 200, headers: respHeaders });
}

/** 非 Gemini 图片(gpt-image-2 等)multipart 转发 → 返回【原始】响应供 reshape。
 *  req.body 已被 formData() 消费,转发已解析的 FormData;删原 content-type 让 fetch
 *  按重建 FormData 重生 boundary。 */
function fetchUpstreamMultipart(req: NextRequest, form: FormData, path: string, search: string): Promise<Response> {
    const headers = forwardHeaders(req);
    headers.delete('content-type');
    return fetch(`${NEWAPI_BASE_URL}/v1${path}${search}`, { method: 'POST', headers, body: form });
}

/** 非 Gemini 图片 JSON 转发 → 返回【原始】响应供 reshape(CT 强制 json)。 */
function fetchUpstreamJson(req: NextRequest, body: JsonRecord, path: string, search: string): Promise<Response> {
    return fetch(`${NEWAPI_BASE_URL}/v1${path}${search}`, {
        method: 'POST',
        headers: jsonForwardHeaders(req),
        body: JSON.stringify(body),
    });
}

/** 从 JSON body 的 image / image_url(字符串或数组:data URL / 外部 http URL)解出输入图字节。
 *  复用 imageUrlToInlinePart(data URL 直解 / http URL fetch→base64 + SSRF 守门)。 */
async function extractJsonInputImages(body: JsonRecord): Promise<Array<{ mimeType: string; data: string }>> {
    const field = body.image ?? body.image_url;
    const urls = Array.isArray(field) ? field : field ? [field] : [];
    const out: Array<{ mimeType: string; data: string }> = [];
    for (const u of urls) {
        if (typeof u === 'string' && u.trim()) {
            const part = await imageUrlToInlinePart(u);
            if ('inlineData' in part) out.push(part.inlineData);
        }
    }
    return out;
}

/** 收集 multipart 里的所有输入图文件 —— 按【是不是文件】而不是【字段名】判定。
 *  历史上只认 `image`,后来加了 `image[]`/`image[N]`(#192→#198,客户各种 SDK 的多图约定各不相同,
 *  漏一个就把参考图当文生图重画、客户报「不识图」)。字段名黑名单永远追不完,直接收所有文件部件:
 *  images 接口里带文件 = 必然是要改图(edits),不存在「传了文件却当文生图忽略」的合法场景。
 *  gpt-image 分支照常把整个 form 原样转发给 /images/edits(字段名不变,上游自己认 image/mask 等)。 */
function formImageFiles(form: FormData): File[] {
    const files: File[] = [];
    for (const v of form.values()) {
        if (v instanceof File && v.size > 0) files.push(v);
    }
    return files;
}

/** gpt-image 统一分流:按【有无输入图】把请求路由到上游 /images/edits(有图,multipart)或
 *  /images/generations(无图,JSON),与客户调用的 path 无关 —— 文生图 / 图生图可发同一路径,
 *  代理据输入图分流,并按需在 JSON↔multipart 间转换(保留 n / quality / output_format 等透传字段)。
 *  两条入口:multipart 传 form、JSON 传 body(另一个传 null)。现有单独接口不受影响:
 *  文生图(JSON 无图)→ generations、图生图(multipart 有图)→ edits,与今天行为一致。 */
async function gptImageUpstream(
    req: NextRequest,
    form: FormData | null,
    body: JsonRecord | null,
    search: string,
): Promise<Response> {
    if (form) {
        const hasImage = formImageFiles(form).length > 0;
        if (hasImage) return fetchUpstreamMultipart(req, form, '/images/edits', search);
        // 无图 → 文生图 generations(上游要 JSON):把 form 文本字段搬进 JSON
        const j: JsonRecord = {};
        for (const [k, v] of form.entries()) if (typeof v === 'string') j[k] = v;
        coerceImageIntFields(j);
        return fetchUpstreamJson(req, j, '/images/generations', search);
    }
    const b = body ?? {};
    const imgs = await extractJsonInputImages(b);
    if (imgs.length === 0) return fetchUpstreamJson(req, b, '/images/generations', search);
    // 有图 → 图生图 edits(上游要 multipart):JSON 标量字段搬进 form + 图片作为文件部件
    const f = new FormData();
    for (const [k, v] of Object.entries(b)) {
        if (k === 'image' || k === 'image_url') continue;
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') f.append(k, String(v));
    }
    for (const img of imgs) {
        f.append(
            'image',
            new Blob([Buffer.from(img.data, 'base64')], { type: img.mimeType || 'image/png' }),
            'image.png',
        );
    }
    return fetchUpstreamMultipart(req, f, '/images/edits', search);
}

/** OpenAI gpt-image 用像素 size,不认 aspect_ratio / 比例串("16:9")—— 客户传比例时上游静默
 *  出方图(实测 aspect_ratio:"16:9" → 1254×1254 方图;size:"16:9" → 400)。把常见比例折成
 *  ~1MP 像素 size(zhiyunai 接受任意 WxH);表外比例按 1MP 等比折算、取整到 16。 */
const GPT_IMAGE_ASPECT_SIZE: Record<string, string> = {
    '1:1': '1024x1024',
    '3:2': '1536x1024',
    '2:3': '1024x1536',
    '4:3': '1152x896',
    '3:4': '896x1152',
    '5:4': '1120x896',
    '4:5': '896x1120',
    '16:9': '1536x864',
    '9:16': '864x1536',
    '21:9': '1536x672',
    '9:21': '672x1536',
    '2:1': '1408x704',
    '1:2': '704x1408',
};
const ASPECT_RATIO_RE = /^(\d{1,2}):(\d{1,2})$/;
function aspectToPixelSize(ratio: string): string | null {
    const fixed = GPT_IMAGE_ASPECT_SIZE[ratio];
    if (fixed) return fixed;
    const m = ASPECT_RATIO_RE.exec(ratio);
    if (!m) return null;
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (!w || !h) return null;
    const k = Math.sqrt((1024 * 1024) / (w * h));
    const px = (x: number) => Math.min(2048, Math.max(512, Math.round((x * k) / 16) * 16));
    return `${px(w)}x${px(h)}`;
}
/** 从 aspect_ratio 或比例形态的 size 取出比例 → 对应像素 size;无比例 → null。 */
function ratioToSize(aspectRatio: string, size: string): string | null {
    const ar = aspectRatio.trim();
    const sz = size.trim();
    const ratio = ASPECT_RATIO_RE.test(ar) ? ar : ASPECT_RATIO_RE.test(sz) ? sz : '';
    return ratio ? aspectToPixelSize(ratio) : null;
}
/** 走 gpt-image(OpenAI Images 契约、zhiyunai 上游)那套适配的模型:官方 `gpt-image*` +
 *  我们自设的 `az-gpt-image*` 别名(如 az-gpt-image-2 ¥2.2,new-api model_mapping 翻成 gpt-image-2 发上游)。
 *  这些都要在代理层做同样的适配(剥 response_format / 比例转 size / n 强转 / image[] / 图床 / chat 翻译)。 */
function isGptImageModel(model: string): boolean {
    return model.startsWith('gpt-image') || model.startsWith('az-gpt-image');
}
/** 旧 czeq SKU 名 gpt-image-2-{1,2,4}k 只是别名(zhiyunai 上游只有 gpt-image-2 一个模型,分辨率靠
 *  size 像素控制)→ 翻成 gpt-image-2 + 对应像素 size(1k→1024² / 2k→2048² / 4k→3840x2160)。
 *  返回 null = 非变体名。 */
function gptImageVariant(model: string): { base: string; size: string } | null {
    const m = /^(gpt-image-2)-([124])[kK]$/.exec(model);
    if (!m) return null;
    const size = m[2] === '1' ? '1024x1024' : m[2] === '2' ? '2048x2048' : '3840x2160';
    return { base: m[1], size };
}
/** OpenAI images 的整型字段(n / output_compression)—— 客户端可能发成字符串(`"n":"1"`),
 *  或 multipart→JSON 转换把 form 值(恒字符串)搬进 JSON —— new-api 按 uint 解析 JSON 会 500
 *  `cannot unmarshal string into Go struct field Alias.n of type uint`。就地把纯数字字符串强转成数字。 */
function coerceImageIntFields(obj: JsonRecord): void {
    for (const k of ['n', 'output_compression']) {
        const v = obj[k];
        if (typeof v === 'string' && /^\d+$/.test(v.trim())) obj[k] = Number(v.trim());
    }
}
/** gpt-image JSON 规整:剥 response_format(zhiyunai 拒收 →400)+ 比例→像素 size(默认出方图)。 */
function normalizeGptImageJson(body: JsonRecord): void {
    delete body.response_format;
    const vm = typeof body.model === 'string' ? gptImageVariant(body.model) : null;
    if (vm) {
        body.model = vm.base;
        const s = typeof body.size === 'string' ? body.size.trim() : '';
        if (!s || s.toLowerCase() === 'auto') body.size = vm.size; // 未显式给 size → 用变体默认
    }
    const ar = typeof body.aspect_ratio === 'string' ? body.aspect_ratio : '';
    const sz = typeof body.size === 'string' ? body.size : '';
    if (ASPECT_RATIO_RE.test(ar.trim()) || ASPECT_RATIO_RE.test(sz.trim())) {
        const px = ratioToSize(ar, sz);
        if (px) body.size = px;
        else delete body.size;
    }
    delete body.aspect_ratio;
    coerceImageIntFields(body);
}
/** gpt-image multipart 规整(同 normalizeGptImageJson,作用于 FormData)。 */
function normalizeGptImageForm(form: FormData): void {
    form.delete('response_format');
    const vm = gptImageVariant(String(form.get('model') ?? ''));
    if (vm) {
        form.set('model', vm.base);
        const s = String(form.get('size') ?? '').trim();
        if (!s || s.toLowerCase() === 'auto') form.set('size', vm.size);
    }
    const ar = String(form.get('aspect_ratio') ?? '');
    const sz = String(form.get('size') ?? '');
    if (ASPECT_RATIO_RE.test(ar.trim()) || ASPECT_RATIO_RE.test(sz.trim())) {
        const px = ratioToSize(ar, sz);
        if (px) form.set('size', px);
        else form.delete('size');
    }
    form.delete('aspect_ratio');
}

/** OpenAI gpt-image 图片输出 token 估算系数:~703 tok/百万像素(校准到 1536×1024≈1106,
 *  贴近客户参考样例 1105)。号池/new-api 不回真实 usage,这是【估算值】,不等于官方计费 token。 */
const OPENAI_IMAGE_OUTPUT_TOKENS_PER_MP = 703;

/** prompt 文本 token 粗估(无官方 tokenizer 的近似):CJK ~1.5 tok/字,其余 ~1 tok/4 字符。 */
function estimateTextTokens(s: string): number {
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

/** "1536x1024" → 估算输出图 token(按像素面积);无法解析返 0。 */
function estimateImageTokens(sizeStr: string): number {
    const m = /^(\d+)x(\d+)$/.exec(sizeStr.trim());
    if (!m) return 0;
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (!(w > 0 && h > 0)) return 0;
    return Math.round(((w * h) / 1_000_000) * OPENAI_IMAGE_OUTPUT_TOKENS_PER_MP);
}

/** 估算 OpenAI gpt-image `usage`(号池不回真实值)。输入只算 prompt 文本;输入图(edits)
 *  token 不估、记 0(估算局限)。
 *
 *  两套字段都给:
 *   - gpt-image-1 形 `input_tokens` / `output_tokens` / `*_details`(客户端 SDK / 展示读这套);
 *   - chat-completions 形 `prompt_tokens` / `completion_tokens`(**new-api 等中继按这套字段
 *     记 token** —— 客户把我们的 key 接进自己的 new-api 当上游时,它的调用日志读
 *     prompt/completion_tokens,缺了就显示 0,见客户反馈)。
 *  两套共用 `total_tokens`。 */
function buildEstimatedUsage(prompt: string, outSize: string): JsonRecord {
    const textTokens = estimateTextTokens(prompt);
    const outImageTokens = estimateImageTokens(outSize);
    return {
        // gpt-image-1 形
        input_tokens: textTokens,
        input_tokens_details: { image_tokens: 0, text_tokens: textTokens },
        output_tokens: outImageTokens,
        output_tokens_details: { image_tokens: outImageTokens, text_tokens: 0 },
        total_tokens: textTokens + outImageTokens,
        // chat-completions 形别名(中继/new-api 记 token 用)
        prompt_tokens: textTokens,
        completion_tokens: outImageTokens,
    };
}

/** 非 Gemini 图片模型(gpt-image-2 等)透传 + 响应整形:
 *  - 上游报错(非 2xx)/ 非预期形态 → 原样透传 status+体(**绝不隐藏报错**,客户要求)。
 *  - 成功 → 补 OpenAI gpt-image 形的顶层 `size` + 估算 `usage`(上游不回 usage;若上游
 *    已带则保留不覆盖)。data[].b64_json 等字段原样保留。 */
async function reshapeOpenAiImageResponse(
    upstream: Response,
    prompt: string,
    requestedSize: string,
    cap: CaptureCtx | null,
    req: NextRequest | null = null,
    storeToUrl = false,
): Promise<NextResponse> {
    const text = await upstream.text();
    const headers = new Headers();
    upstream.headers.forEach((v, k) => {
        if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) headers.set(k, v);
    });

    let json: JsonRecord | null = null;
    try {
        json = JSON.parse(text) as JsonRecord;
    } catch {
        json = null;
    }
    const data = json && Array.isArray((json as { data?: unknown }).data) ? (json.data as JsonRecord[]) : null;

    // 上游报错 / 形态非预期(非 JSON、无 data)→ 原样透传,不加 usage、不改体。
    if (!upstream.ok || !data) {
        if (cap) captureJsonResponse(cap, upstream.status, (json ?? { _raw: text.slice(0, 500) }) as JsonRecord);
        return new NextResponse(text, { status: upstream.status, headers });
    }

    // 成功:补顶层 size + 估算 usage(保留上游已有的)。
    const j = json as JsonRecord; // data 非空 ⇒ json 非空
    const firstSize = typeof data[0]?.size === 'string' ? (data[0].size as string) : '';
    const outSize = (typeof j.size === 'string' && j.size) || firstSize || requestedSize || '';
    const out: JsonRecord = { ...j };
    if (out.size === undefined && outSize) out.size = outSize;
    if (out.usage === undefined) out.usage = buildEstimatedUsage(prompt, outSize);

    // opt-in(response_format:url):把 b64_json 存客户 OSS→平台 R2,响应改回 url(镜像 Gemini 生图)。
    // 默认(无 response_format / b64_json)保持 b64_json 原样 —— OpenAI gpt-image 契约,不破坏现有客户。
    let refs: string[] = [];
    if (storeToUrl && req) {
        const newData: JsonRecord[] = [];
        for (const item of data) {
            const b64 = typeof item.b64_json === 'string' ? item.b64_json : null;
            if (!b64) {
                newData.push(item);
                continue;
            }
            const stored = await storeGeneratedImage(req, Buffer.from(b64, 'base64'), 'image/png', b64);
            const d: JsonRecord = { ...item, url: stored.url };
            delete d.b64_json;
            newData.push(d);
            if (stored.ossFallback) headers.set('X-Silkroadai-Oss-Fallback', 'yes');
            if (stored.r2Fallback) headers.set('X-Silkroadai-R2-Fallback', 'yes');
            refs = hostedRefs(stored);
        }
        out.data = newData;
    }

    headers.set('content-type', 'application/json');
    if (cap) captureJsonResponse(cap, 200, out, refs);
    return new NextResponse(JSON.stringify(out), { status: 200, headers });
}

/**
 * /v1/images/edits + /v1/images/generations 的 DALL·E 兼容入口(W9 D4)。
 *
 * model 命中 GEMINI_IMAGE_MODELS → 翻译到 Gemini native generateContent
 * 注入 imageSize(1K/2K/4K)、按需注入 aspectRatio,响应包成 DALL·E 形
 * `{ created, data: [{ url | b64_json }] }`;否则(gpt-image-2 等)透传 new-api 并整形:
 * 成功补 OpenAI gpt-image 形的顶层 `size` + 估算 `usage`(上游不回 usage),上游报错原样透传。
 *
 * 边界与已知取舍(对照官方 DALL·E 的有意差异):
 * - `n`(多图):不支持,固定返 1 张(Gemini generateContent 单次出 1 图)。
 *   客户传 n>1 我们忽略。需多图后续迭代。
 * - `size`:仅 `gemini-3-pro-image-preview` 可选(`2K`/`4K`,或 `2048x2048`/`4096x4096`,
 *   默认 4K),其余模型忽略 size 维持固定档(2.5→1K / 3.1-flash→2K);
 *   pro 传无法识别的 size → 400。比例仍由 aspect_ratio 决定。
 * - `aspect_ratio` 缺省 / `""` / `auto`(大小写不限)= "不指定" → 文生图不注入 aspectRatio
 *   (走 Gemini 默认);图生图读输入主图尺寸注入白名单里最近的比例(Gemini 不注入时
 *   默认 1:1、不跟随输入图);非空、非 auto 且不在该 model 官方白名单 → 400。
 * - 多参考图:`image` 字段可重复(multipart form.getAll('image') / JSON 数组),
 *   全部按顺序转 inlineData 塞进 parts。
 * - 鉴权不在本层 —— Authorization 透传,new-api 校验 sk-xxx。
 */
async function handleImagesDalle(
    req: NextRequest,
    path: string,
    search: string,
    cap: CaptureCtx | null = null,
): Promise<NextResponse> {
    const contentType = req.headers.get('content-type') || '';
    const isMultipart = contentType.includes('multipart/form-data');

    // ---- 解析入参(multipart 或 JSON)----
    let model = '';
    let prompt = '';
    let responseFormat = 'url';
    let aspectRatio = '';
    let sizeRaw = '';
    // gpt-image 默认返回 b64_json(OpenAI 契约);仅当客户显式 response_format:url 才存图床返 URL(opt-in)。
    let wantHostedUrl = false;
    const inputParts: GeminiInputPart[] = [];

    try {
        if (isMultipart) {
            const form = await req.formData();
            model = String(form.get('model') ?? '');
            prompt = String(form.get('prompt') ?? '');
            responseFormat = String(form.get('response_format') ?? 'url') || 'url';
            wantHostedUrl = String(form.get('response_format') ?? '').toLowerCase() === 'url';
            aspectRatio = String(form.get('aspect_ratio') ?? '');
            sizeRaw = String(form.get('size') ?? '');
            // model 非我们的 Gemini 生图 → 重建 FormData 透传(保留 gpt-image-2 等)
            if (!(model in GEMINI_IMAGE_MODELS)) {
                // gpt-image:剥 response_format + 把比例(aspect_ratio / "16:9" 形态 size)翻成像素 size
                if (isGptImageModel(model)) {
                    normalizeGptImageForm(form);
                    sizeRaw = String(form.get('size') ?? '');
                }
                // multipart 入参不拆图字节(brief §3 Out),只记文本字段摘要
                if (cap)
                    recordRequestBody(
                        cap,
                        JSON.stringify({ model, prompt, response_format: responseFormat, _multipart: true }),
                        model,
                        false,
                    );
                try {
                    // 统一入口:gpt-image 按有无输入图分流到上游 edits/generations(与调用 path 无关);
                    // 其余非 Gemini 图片模型仍按调用 path 原样透传 multipart。
                    const upstream = isGptImageModel(model)
                        ? await gptImageUpstream(req, form, null, search)
                        : await fetchUpstreamMultipart(req, form, path, search);
                    return await reshapeOpenAiImageResponse(
                        upstream,
                        prompt,
                        sizeRaw,
                        cap,
                        req,
                        isGptImageModel(model) && wantHostedUrl,
                    );
                } catch (e) {
                    if (e instanceof ImageUrlError) return imageError(e.message, 400, cap);
                    // 连不上 new-api 等网络异常:透出真实原因(不被外层 catch 兜底成笼统 400)
                    return imageError(
                        `upstream request failed: ${e instanceof Error ? e.message : String(e)}`,
                        502,
                        cap,
                    );
                }
            }
            for (const file of formImageFiles(form)) {
                if (file instanceof File && file.size > 0) {
                    const buf = Buffer.from(await file.arrayBuffer());
                    if (buf.byteLength > IMAGE_FETCH_MAX_BYTES) {
                        return imageError(
                            `image too large: ${buf.byteLength} bytes (max ${IMAGE_FETCH_MAX_BYTES})`,
                            400,
                            cap,
                        );
                    }
                    inputParts.push({
                        inlineData: { mimeType: file.type || 'image/png', data: buf.toString('base64') },
                    });
                }
            }
            // multipart Gemini 入参摘要(不含图字节,brief §3 Out)
            if (cap)
                recordRequestBody(
                    cap,
                    JSON.stringify({
                        model,
                        prompt,
                        response_format: responseFormat,
                        aspect_ratio: aspectRatio,
                        images: inputParts.length,
                        _multipart: true,
                    }),
                    model,
                    false,
                );
        } else {
            const body = (await req.json()) as JsonRecord;
            model = String(body.model ?? '');
            prompt = String(body.prompt ?? '');
            responseFormat = String(body.response_format ?? 'url') || 'url';
            wantHostedUrl = String(body.response_format ?? '').toLowerCase() === 'url';
            aspectRatio = String(body.aspect_ratio ?? '');
            sizeRaw = String(body.size ?? '');
            if (cap) recordRequestBody(cap, JSON.stringify(body), model, false);
            if (!(model in GEMINI_IMAGE_MODELS)) {
                // gpt-image:剥 response_format(zhiyunai 拒收 →400)+ 比例→像素 size(zhiyunai 不认
                // aspect_ratio / "16:9" 形态 size,默认出方图)。见 normalizeGptImageJson。
                if (isGptImageModel(model)) {
                    normalizeGptImageJson(body);
                    sizeRaw = typeof body.size === 'string' ? body.size : '';
                }
                try {
                    // 统一入口:gpt-image body 里带 image/image_url → 图生图 edits;否则文生图 generations。
                    const upstream = isGptImageModel(model)
                        ? await gptImageUpstream(req, null, body, search)
                        : await fetchUpstreamJson(req, body, path, search);
                    return await reshapeOpenAiImageResponse(
                        upstream,
                        prompt,
                        sizeRaw,
                        cap,
                        req,
                        isGptImageModel(model) && wantHostedUrl,
                    );
                } catch (e) {
                    if (e instanceof ImageUrlError) return imageError(e.message, 400, cap);
                    return imageError(
                        `upstream request failed: ${e instanceof Error ? e.message : String(e)}`,
                        502,
                        cap,
                    );
                }
            }
            // JSON 形态的 image 可能是 data URL / 外部 URL 字符串或其数组(复用现有 helper)
            const imageField = body.image;
            const urls = Array.isArray(imageField) ? imageField : imageField ? [imageField] : [];
            for (const u of urls) {
                if (typeof u === 'string') inputParts.push(await imageUrlToInlinePart(u));
            }
        }
    } catch (e) {
        if (e instanceof ImageUrlError) return imageError(e.message, 400, cap);
        return imageError('invalid request body', 400, cap);
    }

    // ---- aspect_ratio 校验 ----
    // "" 和 "auto"(大小写不限)= "不指定"。业界客户端(OpenAI gpt-image size:"auto" 等)
    // 常默认发 auto,不能当非法值拒。
    const wantsAuto = aspectRatio === '' || aspectRatio.toLowerCase() === 'auto';
    const allowed = GEMINI_ASPECT_RATIOS[model];
    if (aspectRatio && !wantsAuto && !allowed.has(aspectRatio)) {
        return imageError(`unsupported aspect_ratio "${aspectRatio}" for ${model}`, 400, cap);
    }

    // size:仅 pro 可选 1K/2K/4K(默认 4K),其余模型忽略;非法值 → 400。
    let imageSize: '1K' | '2K' | '4K';
    try {
        imageSize = resolveImageSize(model, sizeRaw);
    } catch (e) {
        if (e instanceof ImageSizeError) return imageError(e.message, 400, cap);
        throw e;
    }

    // 显式合法比例 → 按显式注入;auto/空 + 有输入图(图生图)→ 读主图尺寸注入
    // 最近的合法比例(Gemini 默认 1:1 不跟随输入图,见 aspectRatioFromInput);
    // auto/空 + 无输入图(文生图)/ 尺寸读不出 → 不注入,走 Gemini 默认。
    const imageConfig: Record<string, string> = { imageSize };
    if (!wantsAuto) {
        imageConfig.aspectRatio = aspectRatio;
    } else {
        const inputAspect = aspectRatioFromInput(inputParts, model);
        if (inputAspect) imageConfig.aspectRatio = inputAspect;
    }

    // ---- 拼 Gemini contents:prompt 文本 + 参考图 inlineData ----
    const parts: GeminiInputPart[] = [{ text: prompt }, ...inputParts];
    // 多图:Gemini 忽略 imageConfig.aspectRatio,必须用文字强指令锁定画幅(imageConfig 对多图无效)。
    // 客户没选比例(auto)→ 跟随第一张参考图(配饰上身);选了比例 → 锁定客户选的比例(可选比例场景)。
    if (inputParts.length >= 2) {
        parts.push({ text: wantsAuto ? MULTI_IMAGE_ASPECT_INSTRUCTION : explicitAspectInstruction(aspectRatio) });
    }
    const upstream = await geminiGenerateWithFailover(
        req,
        model,
        JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { imageConfig } }),
    );
    if (!upstream.ok) return cap ? captureResponse(cap, upstream) : passthroughResponse(upstream);

    const upstreamData = (await upstream.json()) as {
        candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
    };
    const inlineData = (upstreamData.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData)?.inlineData;
    if (!inlineData) {
        return imageError('no image generated', 502, cap);
    }

    // ---- 包成 DALL·E 响应 ----
    const { mimeType, data: b64 } = inlineData;
    const respHeaders: Record<string, string> = { 'X-Silkroadai-Translated': 'gemini-native' };
    let datum: JsonRecord;

    let refs: string[] = [];
    if (responseFormat === 'b64_json') {
        datum = { b64_json: b64 };
    } else {
        const stored = await storeGeneratedImage(req, Buffer.from(b64, 'base64'), mimeType, b64);
        datum = { url: stored.url };
        if (stored.ossFallback) respHeaders['X-Silkroadai-Oss-Fallback'] = 'yes';
        if (stored.r2Fallback) respHeaders['X-Silkroadai-R2-Fallback'] = 'yes';
        refs = hostedRefs(stored);
    }

    const dalleResp = { created: Math.floor(Date.now() / 1000), data: [datum] };
    if (cap) captureJsonResponse(cap, 200, dalleResp, refs);
    return NextResponse.json(dalleResp, { status: 200, headers: respHeaders });
}

/**
 * 视频轮询(GET /video/generations/{id}):转发 new-api,若任务已完成且 video_url 是我们平台 R2、
 * 且该客户配了自定义 OSS,则把成片转存到客户 bucket 并改写 video_url 为客户域名。
 * 这是视频版的「自定义对象存储」——镜像生图的 storeGeneratedImage,但生图在生成时存(代理里有客户 key),
 * 视频成片是 new-api 异步轮询时由适配器落到平台 R2(那一步没有客户身份),所以放到客户【轮询】这步做
 * (轮询请求带客户 sk-xxx → 能反查 user → OSS 配置)。HEAD 幂等:重复轮询不重复下载+上传。
 * 任何故障一律保持平台 R2 直链 —— 绝不因客户 OSS 转存失败而让客户拿不到片。
 */
async function handleVideoPoll(req: NextRequest, path: string, search: string): Promise<NextResponse> {
    const upstream = await fetch(`${NEWAPI_BASE_URL}/v1${path}${search}`, {
        method: 'GET',
        headers: forwardHeaders(req),
    });
    const text = await upstream.text();
    if (!upstream.ok) {
        return new NextResponse(text, { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
    }
    let body: JsonRecord;
    try {
        body = JSON.parse(text) as JsonRecord;
    } catch {
        return new NextResponse(text, { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
    }

    try {
        const data = body.data as JsonRecord | undefined;
        const inner = data?.data as JsonRecord | undefined;
        const status = String(data?.status ?? '').toUpperCase();
        const videoUrl = typeof inner?.video_url === 'string' ? (inner.video_url as string) : null;
        const r2Base = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
        if (status === 'SUCCESS' && videoUrl && r2Base && videoUrl.startsWith(r2Base + '/') && inner) {
            const userId = await resolveUserIdFromAuthHeader(req.headers.get('authorization'));
            const ossConfig = userId ? await getOssConfig(userId) : null;
            if (ossConfig && ossConfig.status === 'active') {
                const key = videoUrl.slice(r2Base.length + 1);
                let ossUrl: string | null = null;
                if (await objectExistsInOss(ossConfig, key)) {
                    ossUrl = ossPublicUrl(ossConfig, key);
                } else {
                    const vid = await fetch(videoUrl);
                    if (vid.ok) {
                        const buf = Buffer.from(await vid.arrayBuffer());
                        const ct = vid.headers.get('content-type') || 'video/mp4';
                        ossUrl = await uploadToCustomerOss(ossConfig, buf, key, ct);
                    }
                }
                if (ossUrl) {
                    inner.video_url = ossUrl;
                    inner.url = ossUrl;
                    if (Array.isArray(inner.urls)) inner.urls = [ossUrl];
                }
            }
        }
    } catch (e) {
        // DB / OSS / R2 任一故障都不阻断:保持平台 R2 直链返回(客户照样拿得到片)
        console.warn('[v1-proxy] video customer-OSS rehost failed, keeping platform R2', e);
    }
    return NextResponse.json(body, { status: upstream.status });
}

/**
 * Claude prompt-cache 透明增强:把可缓存的 OpenAI 格式 Claude 请求翻译成原生
 * /v1/messages(注入 cache_control)发给 new-api,响应翻回 OpenAI 形。
 *
 * 安全:翻译请求被上游拒(网络异常 / 非 2xx)→ 回退原透传(翻译请求未计费,
 * 重发原 body 安全),零回归。响应翻译(含流式)失败也不重发(已计费),返错误形。
 * 详见 ./claude-chat-cache.ts。
 */
async function handleClaudeCachedChat(
    req: NextRequest,
    originalBody: JsonRecord,
    anthropicBody: JsonRecord,
    path: string,
    search: string,
    cap: CaptureCtx | null,
): Promise<NextResponse> {
    const model = String(originalBody.model ?? '');
    const wantStream = anthropicBody.stream === true;

    let upstream: Response;
    try {
        upstream = await fetch(`${NEWAPI_BASE_URL}/v1/messages`, {
            method: 'POST',
            headers: jsonForwardHeaders(req),
            body: JSON.stringify(anthropicBody),
        });
    } catch {
        return forwardToNewApi(req, originalBody, path, search, cap); // 网络异常 → 回退透传
    }

    // 上游拒(4xx/5xx):翻译请求未产生计费,重发原始请求安全 → 回退透传(零回归)
    if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {});
        return forwardToNewApi(req, originalBody, path, search, cap);
    }

    // 流式:逐事件翻 Anthropic SSE → OpenAI chunk
    if (wantStream) {
        if (!upstream.body) return forwardToNewApi(req, originalBody, path, search, cap);
        const translated = translateAnthropicSseToOpenAi(upstream.body, model);
        const headers = new Headers({
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
        });
        const resp = cap
            ? captureResponse(cap, new Response(translated, { status: 200, headers }))
            : new NextResponse(translated, { status: 200, headers });
        resp.headers.set('X-Silkroadai-Cache-Injected', 'claude');
        return resp;
    }

    // 非流式:Anthropic message → OpenAI chat.completion
    let anthropicJson: JsonRecord;
    try {
        anthropicJson = (await upstream.json()) as JsonRecord;
    } catch {
        const err = { error: { message: 'upstream returned non-JSON', type: 'api_error' } };
        if (cap) captureJsonResponse(cap, 502, err);
        return NextResponse.json(err, { status: 502 });
    }
    const openai = anthropicToOpenAiChat(anthropicJson, model);
    if (cap) captureJsonResponse(cap, 200, openai);
    const resp = NextResponse.json(openai);
    resp.headers.set('X-Silkroadai-Cache-Injected', 'claude');
    return resp;
}

const BALANCE_PATHS = new Set(['/dashboard/billing/subscription', '/dashboard/billing/usage', '/balance']);

/** OpenAI 形错误(与 new-api 一致,客户端余额工具能识别)。 */
function billingError(message: string, status: number): NextResponse {
    return NextResponse.json({ error: { message, type: 'new_api_error', code: '' } }, { status });
}

/**
 * 余额查询(portal 自答,不透传 new-api)。
 *
 * portal 给客户的 key 是 unlimited_quota(预算在账户级 user.quota,gotcha #12),new-api 的
 * 标准 /v1/dashboard/billing/* 只看 key 层 → 占位无限额度 + 0 用量,查不到真实余额。这里用
 * sk- 反查账户(NewApiToken.newapi_token_value 存 48 字符【无 sk- 前缀】,token-format.ts),
 * getCustomerBalance 拿真实 ¥(已扣视频失败退款),按端点形态返回:
 *   - /dashboard/billing/subscription → OpenAI 形,hard_limit_usd = 总额度(余+耗) USD
 *   - /dashboard/billing/usage        → OpenAI 形,total_usage = 已用美分(cents)
 *   - /balance                        → 直观 ¥ 形(portal 自有,脚本监控友好)
 */
async function handleBalanceQuery(req: NextRequest, path: string): Promise<NextResponse> {
    const auth = req.headers.get('authorization') || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return billingError('Missing bearer token', 401);
    const raw = m[1].trim();
    const stored = raw.startsWith('sk-') ? raw.slice(3) : raw; // DB 存无 sk- 前缀

    const token = await prisma.newApiToken.findUnique({
        where: { newapi_token_value: stored },
        select: { user_id: true, status: true },
    });
    if (!token || token.status !== 'active') return billingError('Invalid token', 401);

    let bal: CustomerBalance;
    try {
        bal = await getCustomerBalance(token.user_id);
    } catch {
        return billingError('balance temporarily unavailable', 503);
    }

    const toUsd = (cny: number) => cny / USD_TO_CNY_RATE;

    if (path === '/dashboard/billing/usage') {
        // OpenAI 兼容:total_usage 单位 = 美分(cents)。
        return NextResponse.json({ object: 'list', total_usage: Math.round(toUsd(bal.spentCny) * 100) });
    }
    if (path === '/dashboard/billing/subscription') {
        const limitUsd = toUsd(bal.balanceCny + bal.spentCny); // 总额度 = 余额 + 已用
        return NextResponse.json({
            object: 'billing_subscription',
            has_payment_method: true,
            soft_limit_usd: limitUsd,
            hard_limit_usd: limitUsd,
            system_hard_limit_usd: limitUsd,
            access_until: 0,
        });
    }
    // /balance — portal 自有直观形(¥ 余额直接给,脚本监控友好)
    return NextResponse.json({
        object: 'balance',
        currency: 'CNY',
        balance_cny: Number(bal.balanceCny.toFixed(4)),
        used_cny: Number(bal.spentCny.toFixed(4)),
        balance_usd: Number(toUsd(bal.balanceCny).toFixed(4)),
        stale: bal.stale,
    });
}

// ============================ 异步生图(opt-in ?async=true)============================
// DB + 信封在 ./async-image;这里做「提交(秒回 task_id)」「后台跑生图」「结果查询」三件。
// 后台执行放这里(不放 async-image)是因为要调本文件的 handleImagesDalle / storeGeneratedImage,
// 反过来 import 会成循环依赖。计费不变:后台真调 new-api,成功才扣 token。

/** 尽力从请求体嗅 model(仅 task 行展示;成功后 result_json 里有权威 model)。 */
function sniffModel(contentType: string, bodyBuf: ArrayBuffer): string | null {
    try {
        const text = Buffer.from(bodyBuf).toString('utf8');
        if (contentType.includes('application/json')) {
            const m = JSON.parse(text) as { model?: unknown };
            return typeof m.model === 'string' ? m.model : null;
        }
        const mm = text.match(/name="model"\r?\n\r?\n([^\r\n]+)/); // multipart 轻量取
        return mm ? mm[1].trim() : null;
    } catch {
        return null;
    }
}

function sniffImageMime(buf: Buffer): string {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')
        return 'image/webp';
    return 'image/png';
}

/** 后台跑生图:用捕获的请求重建 Request → handleImagesDalle → 确保出图床 URL(b64 转存)→ 落库。 */
/** Phase 2:任务终态回调。POST `{ topic, data }` 到客户 webhook,best-effort,3 次重试,永不抛。 */
async function sendTaskWebhook(webhookUrl: string, body: unknown): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const r = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(10_000),
            });
            if (r.ok) return;
        } catch {
            /* 网络失败 → 重试 */
        }
        if (attempt < 2) await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
    }
    console.warn('[async-image] webhook delivery failed after retries:', webhookUrl.slice(0, 80));
}

async function runAsyncImageTask(
    taskId: string,
    webhookUrl: string | null,
    url: string,
    headers: Headers,
    bodyBuf: ArrayBuffer,
    path: string,
    search: string,
): Promise<void> {
    await markImageTaskStarted(taskId);
    try {
        const bgReq = new NextRequest(url, { method: 'POST', headers, body: bodyBuf });
        const resp = await handleImagesDalle(bgReq, path, search, null);
        const bodyText = await resp.text();
        let json: JsonRecord | null = null;
        try {
            json = bodyText ? (JSON.parse(bodyText) as JsonRecord) : null;
        } catch {
            json = null;
        }
        if (resp.status < 200 || resp.status >= 300 || !json) {
            await saveImageTaskFailure(taskId, `upstream ${resp.status}: ${bodyText.slice(0, 1000)}`);
            return;
        }
        // 确保每个 data 项都有图床 url(任何内联 b64_json → 转存换成稳定 url)
        const data = Array.isArray(json.data) ? (json.data as Array<Record<string, unknown>>) : [];
        for (const item of data) {
            if (!item.url && typeof item.b64_json === 'string' && item.b64_json) {
                const buf = Buffer.from(item.b64_json, 'base64');
                const stored = await storeGeneratedImage(bgReq, buf, sniffImageMime(buf), item.b64_json);
                item.url = stored.url;
                item.b64_json = '';
            }
        }
        await saveImageTaskSuccess(taskId, json);
    } catch (e) {
        await saveImageTaskFailure(taskId, e instanceof Error ? e.message : String(e));
    } finally {
        // 终态已落库(SUCCESS/FAILURE 任一路径都到这)→ 回调客户 webhook,带最终 status + url
        if (webhookUrl) {
            const body = await buildWebhookForTask(taskId).catch(() => null);
            if (body) await sendTaskWebhook(webhookUrl, body);
        }
    }
}

/** 提交:opt-in `?async=true`。秒回 task_id,后台异步生图。 */
async function handleAsyncImageSubmit(req: NextRequest, path: string, search: string): Promise<NextResponse> {
    let userId: string | null;
    try {
        userId = await resolveUserIdFromAuthHeader(req.headers.get('authorization'));
    } catch {
        return NextResponse.json({ code: 'error', message: 'auth lookup failed', data: null }, { status: 500 });
    }
    if (!userId)
        return NextResponse.json({ code: 'unauthorized', message: 'invalid api key', data: null }, { status: 401 });

    // Phase 2:可选 webhook 回调 URL(SSRF 守门:只放公网 http(s),拒 localhost/私网字面量)
    const webhookUrl = new URLSearchParams(search).get('webhook');
    if (webhookUrl && isDisallowedImageUrl(webhookUrl)) {
        return NextResponse.json(
            { code: 'invalid_webhook', message: 'webhook must be a public http(s) URL', data: null },
            { status: 400 },
        );
    }

    const bodyBuf = await req.arrayBuffer();
    const headers = new Headers(req.headers);
    const endpoint: ImageTaskEndpoint = path === '/images/edits' ? 'edits' : 'generations';
    const model = sniffModel(req.headers.get('content-type') || '', bodyBuf);
    const taskId = newImageTaskId();
    const submitTime = new Date();
    try {
        await createImageTask(taskId, userId, model, endpoint);
    } catch (e) {
        console.error('[async-image] createTask failed', e);
        return NextResponse.json({ code: 'error', message: 'failed to create task', data: null }, { status: 500 });
    }
    // 去掉 async/webhook,后台按普通同步生图跑
    const sp = new URLSearchParams(search);
    sp.delete('async');
    sp.delete('webhook');
    const cleanSearch = sp.toString() ? `?${sp.toString()}` : '';
    const cleanUrl = req.url.split('?')[0] + cleanSearch;
    void runAsyncImageTask(taskId, webhookUrl, cleanUrl, headers, bodyBuf, path, cleanSearch);
    return NextResponse.json(buildSubmitEnvelope(taskId, submitTime), { status: 200 });
}

/** 查询:GET /v1/images/tasks/{task_id}。IDOR 按 user_id 守门。 */
async function handleAsyncImageQuery(req: NextRequest, path: string): Promise<NextResponse> {
    let userId: string | null;
    try {
        userId = await resolveUserIdFromAuthHeader(req.headers.get('authorization'));
    } catch {
        return NextResponse.json({ code: 'error', message: 'auth lookup failed', data: null }, { status: 500 });
    }
    if (!userId)
        return NextResponse.json({ code: 'unauthorized', message: 'invalid api key', data: null }, { status: 401 });
    const taskId = path.split('/').pop() || '';
    let row;
    try {
        row = await getImageTask(taskId, userId);
    } catch {
        return NextResponse.json({ code: 'error', message: 'lookup failed', data: null }, { status: 500 });
    }
    if (!row) return NextResponse.json(notFoundEnvelope(), { status: 200 });
    return NextResponse.json(buildQueryEnvelope(row), { status: 200 });
}

async function handleRequest(req: NextRequest, params: Promise<{ path: string[] }>): Promise<NextResponse> {
    const { path: segments } = await params;
    const path = '/' + (segments ?? []).join('/');
    const search = req.nextUrl.search || '';

    // 临时诊断(env HDR_CAPTURE=1,默认关):记 /messages + /chat/completions POST 的请求头
    // 名+值(脱敏 auth),带账户 id + token 尾 4 位精确定位。用于抓客户端注入的异常头
    // (如 kiro profileArn)。查完把 HDR_CAPTURE 撤掉。
    if (
        process.env.HDR_CAPTURE === '1' &&
        req.method === 'POST' &&
        (path === '/messages' || path === '/chat/completions')
    ) {
        const auth = req.headers.get('authorization') || req.headers.get('x-api-key') || '';
        const tokFp = auth.replace(/^Bearer\s+/i, '').slice(-4);
        const hdrs: Record<string, string> = {};
        req.headers.forEach((v, k) => {
            hdrs[k] = /^(authorization|x-api-key|cookie|proxy-authorization)$/i.test(k) ? '***' : v;
        });
        let uid: string | null = null;
        try {
            uid = await resolveUserIdFromAuthHeader(auth || null); // 尽力而为,失败不影响记头
        } catch {
            /* 头才是重点 */
        }
        // body 形状(护栏:content-length < 15MB 才解析,避免 OOM);区分失败 vs 成功请求的差异
        let bodyInfo: Record<string, unknown>;
        const clen = Number(req.headers.get('content-length') || '0');
        if (clen > 0 && clen < 15_000_000) {
            try {
                const b = (await req.clone().json()) as Record<string, unknown>;
                const msgs = Array.isArray(b.messages) ? (b.messages as unknown[]) : [];
                const hasToolResult = msgs.some((m) => {
                    const c = (m as Record<string, unknown>)?.content;
                    return Array.isArray(c) && c.some((x) => (x as Record<string, unknown>)?.type === 'tool_result');
                });
                bodyInfo = {
                    model: b.model,
                    hasTools: Array.isArray(b.tools) && b.tools.length > 0,
                    hasToolResult,
                    numMsgs: msgs.length,
                    beta: hdrs['anthropic-beta'] ?? null,
                };
            } catch {
                bodyInfo = { parseErr: true };
            }
        } else {
            bodyInfo = { skipped: `clen=${clen}` };
        }
        console.log('[HDRCAP]', JSON.stringify({ uid, tokFp, path, hdrs, bodyInfo }));
    }

    // 余额查询拦截(在 capture 之前 return:GET 余额查询无需记录)。portal 给客户的 key 是
    // unlimited_quota(预算在账户级 user.quota,gotcha #12),new-api 标准 billing 端点只看
    // key 层 → 返回占位无限额度;故在代理层用 sk- 反查账户、自答真实余额。
    if (req.method === 'GET' && BALANCE_PATHS.has(path)) {
        return handleBalanceQuery(req, path);
    }

    // 请求日志捕获(数据存储 Phase 1 第②步)。开关 off → null → 下面全程与今天
    // 字节级一致;on → 旁路捕获,best-effort,绝不影响客户请求(见 capture.ts)。
    const cap = beginCapture(req, path);

    if (path === '/chat/completions' && req.method === 'POST') {
        let body: JsonRecord;
        try {
            body = (await req.json()) as JsonRecord;
        } catch {
            return NextResponse.json(
                { error: { message: 'invalid JSON body', type: 'invalid_request_error' } },
                { status: 400 },
            );
        }
        const model = String(body.model ?? '');

        // Branch 1: Gemini image → native endpoint 翻译。
        // text-only 模式(REQUEST_LOGGING_SKIP_MEDIA)下生图不捕获 → imgCap=null(请求体也不记);
        // 否则用 cap 并先记请求体(handleGeminiImage 只捕响应侧)。
        if (model in GEMINI_IMAGE_MODELS) {
            const imgCap = isMediaCaptureSkipped() ? null : cap;
            if (imgCap) recordRequestBody(imgCap, JSON.stringify(body), model, body.stream === true);
            return withKeepalive(handleGeminiImage(req, body, model, imgCap));
        }

        // Branch 1.1: gpt-image-2(图片模型)被当 chat 模型调 → 翻译到 Images 接口(否则上游
        // 400「The requested operation is unsupported」)。同 Gemini,出图包成 chat.completion 回复。
        if (isGptImageModel(model)) {
            const imgCap = isMediaCaptureSkipped() ? null : cap;
            if (imgCap) recordRequestBody(imgCap, JSON.stringify(body), model, body.stream === true);
            return withKeepalive(handleGptImageChat(req, body, model, imgCap));
        }

        // Branch 1.2: gpt-4o-image(zhiyunai chat 生图)→ 透传对话,但把返回的 CDN 图片 url 转存图床/客户 OSS,
        // 返回我们的稳定 url(pro.filesystem.site 链接会过期)。计费不变(new-api 按 chat token 扣)。
        if (model.startsWith('gpt-4o-image')) {
            const imgCap = isMediaCaptureSkipped() ? null : cap;
            if (imgCap) recordRequestBody(imgCap, JSON.stringify(body), model, body.stream === true);
            return withKeepalive(handleGpt4oImageChat(req, body, model, imgCap), { sse: body.stream === true });
        }

        // 捕获【原始】请求体(文本路径;clamp 分支也存未钳的,记录客户真实输入,brief §4)
        if (cap) recordRequestBody(cap, JSON.stringify(body), model, body.stream === true);

        // Branch 1.5: 可缓存的纯文本 Claude 请求 → 翻译到原生 /v1/messages 注入 cache_control。
        // new-api 的 OpenAI→Claude 转换会丢弃 cache_control,故用 OpenAI 格式调 Claude 拿不到
        // prompt 缓存、大上下文每轮全价重发。这里透明补上(gate 保守,带 tools/多模态/过小的请求
        // 不命中 → 落到下面的 clamp/透传,零回归)。max_tokens 钳在 build 内一并处理。
        if (model.startsWith('claude-') && isCacheableClaudeChat(body)) {
            const anthropicBody = buildAnthropicRequest(body);
            if (anthropicBody) {
                return handleClaudeCachedChat(req, body, anthropicBody, path, search, cap);
            }
            // null(结构无法干净翻译,如首条非 system 消息不是 user)→ 落到下面透传
        }

        // Branch 2: Claude max_tokens clamp
        const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : 0;
        if (model.startsWith('claude-') && maxTokens > CLAUDE_MAX_TOKENS_CAP) {
            const clamped = { ...body, max_tokens: CLAUDE_MAX_TOKENS_CAP };
            const resp = await forwardToNewApi(req, clamped, path, search, cap);
            resp.headers.set('X-Silkroadai-Clamped', `max_tokens=${CLAUDE_MAX_TOKENS_CAP}-was-${maxTokens}`);
            return resp;
        }

        // Branch 3: 其他模型透传(body 已消费,重新序列化)
        return forwardToNewApi(req, body, path, search, cap);
    }

    // DALL·E 兼容图像接口:Gemini 生图模型翻译,其余(gpt-image-2 等)透传
    if ((path === '/images/edits' || path === '/images/generations') && req.method === 'POST') {
        // opt-in 异步:?async=true → 秒回 task_id,后台生图。不带 async 完全走原同步路径(字节不变)。
        if (new URLSearchParams(search).get('async') === 'true') {
            return handleAsyncImageSubmit(req, path, search);
        }
        return withKeepalive(handleImagesDalle(req, path, search, cap));
    }

    // 异步生图结果查询:GET /v1/images/tasks/{task_id}
    if (req.method === 'GET' && /^\/images\/tasks\/[^/]+$/.test(path)) {
        return handleAsyncImageQuery(req, path);
    }

    // 视频轮询完成后:按客户自定义 OSS 转存(详见 handleVideoPoll)
    if (req.method === 'GET' && /^\/video\/generations\/[^/]+$/.test(path)) {
        return handleVideoPoll(req, path, search);
    }

    // 其他路径(/messages /models /embeddings …)全部透传
    return forwardToNewApi(req, null, path, search, cap);
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: RouteContext) {
    return handleRequest(req, ctx.params);
}
export async function POST(req: NextRequest, ctx: RouteContext) {
    return handleRequest(req, ctx.params);
}
export async function PUT(req: NextRequest, ctx: RouteContext) {
    return handleRequest(req, ctx.params);
}
export async function DELETE(req: NextRequest, ctx: RouteContext) {
    return handleRequest(req, ctx.params);
}
