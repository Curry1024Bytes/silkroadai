/**
 * Portal /v1/* catch-all proxy (W9 D1, PR-A — task #33 Phase 1)
 *
 * 拦截所有 api.llmroute.club/v1/* 请求(宿主机 Nginx 转到 portal :3002):
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
 *        key = `gen/{YYYY-MM-DD}/{uuid}.{ext}`,日期取北京时间,方便客户
 *        按日期目录整删过期图),content 返 markdown 公网 URL。
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
 * 4. 其余一切(/messages、/embeddings、其他模型的 /chat/completions…)
 *    → 原样透传 new-api,streaming SSE 不缓冲(forward upstream ReadableStream,外面
 *    包一层 stream-guard:静默期 keep-alive 注释 + 流中断错误尾帧,见 @/lib/sse/stream-guard)。
 *    例外:GET /models 透传之上逐条附加 `silkroadai` 元数据(机器可读目录,
 *    见 @/lib/models/machine-catalog;best-effort,失败原样透传)。
 *
 * 边界:
 * - 本文件不做鉴权 — Authorization 头原样透传,new-api 自己校验 sk-xxx。
 * - DB 访问仅限 Phase 3 的客户 OSS 查询(read-only,且任何 DB 故障都
 *   静默回退平台 R2,绝不阻断客户请求);其余路径不触 DB。
 * - 回滚 = Nginx 临时把 /v1/* 切回 new-api :3000;会失去本文件全部增强能力。
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
import { REAL_USD_TO_CNY, quotaToCny } from '@/lib/newapi/quota-units';
import { listEnabledChannelGroups } from '@/lib/channel-group';
import { getTokenUsageWithCache } from '@/lib/newapi/token-usage';
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
import { handleAnthropicMessages } from './messages-stream-hold';
import { handleUsageQuery } from './usage';
import {
    isSeedanceCnModel,
    isSeedanceCnTask,
    handleSeedanceVideoSubmit,
    handleSeedanceVideoPoll,
} from '@/lib/seedance/cn-proxy';
import { isKlingVideoModel, isKlingVideoTask, handleKlingVideoSubmit, handleKlingVideoPoll } from '@/lib/kling/proxy';
import { isEnterpriseFlavor, handleEnterpriseV1 } from '@/lib/enterprise/proxy';
import { guardSseResponse, guardSseStream, type SseErrorShape } from '@/lib/sse/stream-guard';
import { forwardHeaders, passthroughResponse, STRIP_RESPONSE_HEADERS } from '@/lib/proxy/forward';
import { CHAT_SPEC, RESPONSES_SPEC, coerceAndValidate, guardRawBody, violationBody } from '@/lib/proxy/body-guard';
import { stripAdobeImageMetadataB64 } from '@/lib/proxy/image-metadata';
import { normalizeOpenAiResponse, normalizeChoices } from '@/lib/proxy/finish-reason';
import { loadCatalogMeta, resolveTierFromAuthHeader, enrichModelList } from '@/lib/models/machine-catalog';
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
// portal → new-api 图片上游 fetch 的超时,与 Nginx `api.llmroute.club` 的 proxy_read_timeout 650s 对齐。
// 不显式设的话吃 undici 默认 headersTimeout 300s:new-api 对图片 relay 无超时,会等满上游(慢渠道
// 300-600s)出图【并计费】,但 portal 的 fetch 300s 就 abort → 客户「扣了费却拿到 fetch failed 没有图」
// (见 2026-07-12 lkl1131888403 案例:ch83 大图 377/423s,new-api 计费、portal 300s 掐断)。
const UPSTREAM_IMAGE_TIMEOUT_MS = 600_000;
/** 与现有 Gemini images fan-out 一致:单个客户请求最多放大为 4 个独立计费请求。 */
const FIXED_GPT_IMAGE_MAX_N = 4;

/** 主请求非 2xx 后读错误 body(做终态分类)的超时:逆向渠道可能 headers 到了、body 滴流不完,
 *  不设钟会把本该立即切候补的兜底卡死。到点 abort → 当读不出 → 照旧兜底。 */
const ERROR_BODY_TIMEOUT_MS = 5_000;

/** Gemini image 模型 → 注入的 native imageSize(客户没选 size 时的固定档) */
const GEMINI_IMAGE_MODELS: Record<string, '1K' | '2K' | '4K'> = {
    'gemini-2.5-flash-image': '1K',
    'gemini-3.1-flash-image-preview': '2K',
    // -hq 原是 flash 的候补 SKU(FAILOVER_MODELS 目标,走 premium 渠道 ch42/ch67);也让客户直接点名调用。
    // 与 flash 同底模同档(2K)。不在此表时 → passthrough → 返回内联 base64、无 imageSize,客户 pipeline 走不通;
    // 加进来后 proxy 同样翻译到 native + 注入 imageSize + 落图床返托管 URL。它自身无候补(FAILOVER_MODELS 无此 key)。
    'gemini-3.1-flash-image-preview-hq': '2K',
    'gemini-3-pro-image-preview': '4K',
    // 折扣 SKU:= pro 锁 2K(size 参数对它无效),new-api 单独计 ¥0.30(4K 原名仍 ¥0.50)。
    // model_mapping(ch#24/#17)把它翻回 gemini-3-pro-image-preview 给上游。见 configure-pro-2k-sku.mjs。
    'gemini-3-pro-image-preview-2k': '2K',
    // ch96(adobe 逆向 we-token.cc)上新的两款,客户走 /v1/images/edits。不在此表时 → passthrough →
    // new-api 把 images/edits 当 Imagen 形态请求发上游 → 上游报 "only imagen models supported" 500。
    // 加进来后 proxy 翻译到 native generateContent(输入图转 inlineData + 注入 imageSize)→ 上游正常出图 + 落图床。
    'gemini-3.1-flash-image-adobe': '2K',
    'gemini-3-pro-image-adobe': '4K',
    // 4K SKU(2026-07-27):ch67(amutes)上游支持 flash/pro 真 4K 出图。锁 4K(size 参数对它们无效),
    // new-api 按别名单独计价(flash-4k ¥0.35 / pro-4k ¥0.55);ch67 model_mapping 翻回真名给上游。
    // 见 configure-gemini-4k-skus.mjs。两者自身无候补(FAILOVER_MODELS 无此 key)。
    'gemini-3.1-flash-image-preview-4k': '4K',
    'gemini-3-pro-image-preview-4k': '4K',
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

/** 固定价图片档的 n 非法时抛此错,调用方转 400 invalid_request_error。 */
class ImageCountError extends Error {}

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
    // -hq 与 flash 同底模,共用 flash 的比例白名单。
    'gemini-3.1-flash-image-preview-hq': new Set([
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
// ch96 adobe 逆向两款与 flash/pro 同底模 → 复用对应档白名单。
GEMINI_ASPECT_RATIOS['gemini-3.1-flash-image-adobe'] = GEMINI_ASPECT_RATIOS['gemini-3.1-flash-image-preview'];
GEMINI_ASPECT_RATIOS['gemini-3-pro-image-adobe'] = GEMINI_ASPECT_RATIOS['gemini-3-pro-image-preview'];
// 4K SKU 与 flash/pro 同底模 → 复用对应档白名单。
GEMINI_ASPECT_RATIOS['gemini-3.1-flash-image-preview-4k'] = GEMINI_ASPECT_RATIOS['gemini-3.1-flash-image-preview'];
GEMINI_ASPECT_RATIOS['gemini-3-pro-image-preview-4k'] = GEMINI_ASPECT_RATIOS['gemini-3-pro-image-preview'];

const CLAUDE_MAX_TOKENS_CAP = 4096;

/** 外部 image_url fetch 的大小上限(Gemini inline 也有自己的上限,先在我们这层挡) */
const IMAGE_FETCH_MAX_BYTES = 20 * 1024 * 1024;

/** 不往上游转发的请求头(host/content-length 由 fetch 重算) */
// 转发助手(forwardHeaders / passthroughResponse / 头剥离集)抽到 @/lib/proxy/forward
// 与 /v1beta 原生透传路由共用,行为零改动。
type JsonRecord = Record<string, unknown>;

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

/** SSE 流中断时该注入哪种格式的错误事件(见 stream-guard.ts):
 *  /chat/completions = OpenAI chunk 形;/messages = Anthropic 原生形;其余 SSE 路径
 *  (legacy /completions 是 choices[].text 形、/responses 是 Responses 事件流)格式
 *  各异 → null,只做 keep-alive、错误照旧传播(不注入不一定能解析的事件)。 */
function sseShapeForPath(path: string): SseErrorShape {
    if (path === '/chat/completions') return 'openai';
    if (path === '/messages') return 'anthropic';
    return null;
}

async function forwardToNewApi(
    req: NextRequest,
    bodyOverride: JsonRecord | null,
    path: string,
    search: string,
    cap: CaptureCtx | null = null,
    /** 出口 C:调用方已读过体(如 /responses 守门),直接给出口串 —— 不再读 req,也不重复记 capture。 */
    rawOverride?: string,
    /** 同组 failover:上游 ≥500 时重 POST 一次(new-api 重新走渠道选择)。仅在出口体
     *  是字符串(可重发)时生效;目前只有 /responses 打开。 */
    failoverOn5xx = false,
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
    if (rawOverride !== undefined) {
        outgoingBody = rawOverride;
    } else if (bodyOverride) {
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
    let upstream = await fetch(url, init);
    // /responses 同组 failover(2026-08-06 luwei Codex 502 诊断):new-api 收到上游
    // 5xx 不重试不换渠道(亲和钉渠道),号池网关瞬断(502 HTML 页 / 524 CF 超时)直接
    // 透传给客户。这里在体可重发(字符串)时重 POST 一次让 new-api 重新选渠道,仍败
    // 透传第二次的真实错误码。429 不重试(限流下立刻重发只会加剧);非 2xx new-api
    // 不记消费日志,重试无重复计费风险。SSE 假 200 后死流不在本层(/messages 有持头
    // 转发覆盖,Responses 面观测到的失败全是干净 5xx)。
    if (failoverOn5xx && typeof outgoingBody === 'string' && upstream.status >= 500) {
        console.warn(`[proxy${path}] upstream 5xx, same-group failover retry`, {
            status: upstream.status,
            requestId: upstream.headers.get('x-oneapi-request-id'),
        });
        void upstream.body?.cancel().catch(() => {});
        upstream = await fetch(url, init);
        const h = new Headers(upstream.headers);
        h.set('X-Silkroadai-Failover', upstream.status < 500 ? 'attempt=2' : 'exhausted=2');
        upstream = new Response(upstream.body, { status: upstream.status, headers: h });
    }
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
    // finish_reason 归一(只对 OpenAI 兼容面):逆向/经销商渠道漏出的非标 stop reason
    // (end_turn / STOP / MAX_TOKENS / SAFETY…)映射成 OpenAI 标准集;/messages、
    // /v1beta 等 native 面不动。放在 guard 之前:guard 的 error 尾帧本就是标准值。
    if (path === '/chat/completions') upstream = await normalizeOpenAiResponse(upstream);

    // SSE 流式两件套:静默期 keep-alive 注释 + 流中断错误事件(guard 在 capture 之前,
    // 请求日志记到的 = 客户实际收到的字节,含错误尾帧)。非 SSE / 非 2xx 原样返回。
    // onInterrupted:守卫把上游死转成尾帧 + 干净收流后,tee 只看到正常 done —— 不回填
    // 的话中断流在请求日志的结构化字段(incomplete/errorParts)里会隐身。
    const guarded = guardSseResponse(upstream, {
        shape: sseShapeForPath(path),
        label: `proxy${path}`,
        model: typeof bodyOverride?.model === 'string' ? bodyOverride.model : undefined,
        onInterrupted: cap
            ? (err) => {
                  cap.incomplete = true;
                  cap.errorParts.push('upstream-read:' + (err instanceof Error ? err.message : String(err)));
              }
            : undefined,
    });
    return cap ? captureResponse(cap, guarded) : passthroughResponse(guarded);
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
    // 上游 mimeType 不可信(Gemini 3.1 image 约 1/3 把 JPEG 字节标成 image/png → 存成 .png 后
    // Photoshop 按扩展名/CT 用 PNG 解码器解 JPEG 失败)→ 嗅探真实字节定扩展名 + Content-Type + data URL。
    const realMime = sniffImageMime(buffer);
    const ext = realMime.includes('jpeg') ? 'jpg' : realMime.includes('webp') ? 'webp' : 'png';
    // 按日期分子目录(客户诉求 2026-07-21):客户清理 OSS 时可整删过期日期目录。
    // 日期取北京时间(gotcha #20:容器 TZ=UTC,不显式指定会差 8h);en-CA locale = YYYY-MM-DD。
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const key = `gen/${day}/${randomUUID()}.${ext}`;
    let ossFallback = false;

    // Phase 3:sk-xxx 反查 portal user → 客户 OSS 配置(查询失败一律回平台 R2)
    let customerUrl: string | null = null;
    try {
        const userId = await resolveUserIdFromAuthHeader(req.headers.get('authorization'));
        const ossConfig = userId ? await getOssConfig(userId) : null;
        if (ossConfig && ossConfig.status === 'active') {
            try {
                customerUrl = await uploadToCustomerOss(ossConfig, buffer, key, realMime);
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
        const url = await uploadImage(key, buffer, realMime);
        return { url, ossFallback, r2Fallback: false };
    } catch (e) {
        console.warn('[v1-proxy] R2 upload failed, falling back to inline data URL', e);
        return { url: `data:${realMime};base64,${base64}`, ossFallback, r2Fallback: true };
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

/** 真·内容审核拒绝的标记(上游确定性输入拒)。⚠️ 不含 `adobe` —— 仅提到品牌名的错误
 *  (如 adobe 线路超时)不是审核拒绝,冒充审核文案会误导客户排查方向(2026-08-05 错误
 *  报告 F 项:超时被误显示成审核文案)。 */
const IMAGE_SAFETY_RE = /image_unsafe|content rejected|appear to be unsafe/i;

const IMAGE_SAFETY_BODY = JSON.stringify({
    error: {
        message:
            'Your request was rejected by the content safety system. The generated image may not comply with the content policy — please modify your prompt and try again.',
        type: 'invalid_request_error',
        code: 'content_policy_violation',
    },
});

/** 转发上游图片错误给客户前脱敏:候补源(Adobe/we-token 等)的内容安全拒绝会带上来源名
 *  (如 `adobe content rejected: ... image_unsafe`),不能暴露给客户。命中内容安全类 → 统一改写成
 *  中性的 content_policy_violation + **status 恒 400**(号池个别成员把拒绝包在 HTTP 200 体里,
 *  透传上游 status 会变成「200 + 审核报错」,客户网关按成功入账 —— 2026-08-08 客户反馈实例);
 *  其余错误只抹上游品牌名、status 沿用上游。仅作用于图片错误【响应体】,内部 reqlog 仍记原文。 */
function sanitizeImageError(text: string, upstreamStatus: number): { body: string; status: number } {
    if (IMAGE_SAFETY_RE.test(text)) return { body: IMAGE_SAFETY_BODY, status: 400 };
    return { body: text.replace(/\badobe\b/gi, 'the provider'), status: upstreamStatus };
}

/** gpt-image-2 是图片模型,zhiyunai/Azure 只支持 Images 接口 —— 客户用 /v1/chat/completions
 *  调它会被上游 400「The requested operation is unsupported」。这里把 chat 请求翻成
 *  /v1/images/{generations,edits}(messages 带 image_url → edits,否则 generations),出图存图床
 *  后包成 chat.completion 回复(content = markdown 图 url),与 Gemini 生图(handleGeminiImage)一致。
 *  计费照常由 new-api 按该 images 调用扣。固定价别名必须原样传到 new-api,
 *  否则 ModelPrice 会丢失分辨率档位。固定价别名不支持 stream:true。 */
async function handleGptImageChat(
    req: NextRequest,
    body: JsonRecord,
    model: string,
    cap: CaptureCtx | null = null,
): Promise<NextResponse> {
    // 先校验计费档位,再解析 messages。toGeminiContents 可能下载外部 image_url,
    // 尺寸冲突必须在任何出站请求之前返回 400。
    const variant = gptImageVariant(model);
    if (variant && body.stream === true) {
        return imageError('stream=true is not supported for fixed-price gpt-image-2 variants', 400, cap);
    }
    if (variant) {
        try {
            if (fixedImageCount(body.n) !== 1) {
                return imageError(
                    'n greater than 1 is not supported for fixed-price images on chat/completions; use images/generations',
                    400,
                    cap,
                );
            }
        } catch (e) {
            if (e instanceof ImageCountError) return imageError(e.message, 400, cap);
            throw e;
        }
    }
    const sizeRaw = (typeof body.size === 'string' ? body.size : '').trim();
    let size: string | undefined;
    if (variant) {
        try {
            size = resolveGptImageVariantSize(
                model,
                sizeRaw,
                typeof body.aspect_ratio === 'string' ? body.aspect_ratio : '',
            );
        } catch (e) {
            if (e instanceof ImageSizeError) return imageError(e.message, 400, cap);
            throw e;
        }
    } else if (/^\d{2,4}x\d{2,4}$/.test(sizeRaw)) size = sizeRaw;
    else if (ASPECT_RATIO_RE.test(sizeRaw)) size = aspectToPixelSize(sizeRaw) ?? undefined;

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

    // 固定价别名同时是 new-api 的计费 key:只注入对应像素 size,不能改回真模型名。
    const effModel = variant?.alias ?? model;
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
        upstream = await gptImageUpstreamWithSizeRetry(req, form, null, '');
    } else {
        // 纯文字 → 文生图 generations(JSON)
        const genBody: JsonRecord = { model: effModel, prompt };
        if (size) genBody.size = size;
        if (quality) genBody.quality = quality;
        upstream = await gptImageUpstreamWithSizeRetry(req, null, genBody, '');
    }

    if (!upstream.ok) {
        // 上游错误:脱敏(隐藏 adobe 等来源)后透传 status(审核类恒 400);内部 reqlog 记原文
        const errText = await upstream.text();
        let errJson: JsonRecord | null = null;
        try {
            errJson = JSON.parse(errText) as JsonRecord;
        } catch {
            errJson = null;
        }
        if (cap) captureJsonResponse(cap, upstream.status, errJson ?? { _raw: errText.slice(0, 500) });
        const sanitized = sanitizeImageError(errText, upstream.status);
        return new NextResponse(sanitized.body, {
            status: sanitized.status,
            headers: { 'content-type': 'application/json' },
        });
    }
    const data = (await upstream.json().catch(() => null)) as {
        data?: Array<{ b64_json?: string; url?: string; size?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
    } | null;
    let fixedResizeWarning: string | null = null;
    if (data?.data) {
        for (const image of data.data) {
            if (image.b64_json) image.b64_json = stripAdobeImageMetadataB64(image.b64_json);
        }
        if (variant) {
            try {
                const result = await enforceFixedVariantImageOutput(data.data, variant);
                if (result.fallbacks.length > 0) {
                    fixedResizeWarning = result.unverified
                        ? 'unverified-original-returned'
                        : 'failed-original-returned';
                }
            } catch (e) {
                return imageError(e instanceof Error ? e.message : String(e), 502, cap);
            }
        }
    }
    const item = data?.data?.[0];

    let content: string;
    let stored: StoredImage | null = null;
    if (item?.b64_json) {
        // adobe(Firefly)C2PA 已在上方剥离;固定价 SKU 也已校正真实像素。再走
        // 客户 OSS → 平台 R2 → data URL 三级降级(同 handleGeminiImage)。
        const rawB64 = item.b64_json;
        const bytes = Buffer.from(rawB64, 'base64');
        const mime = imageFormatMime(detectImageOutputFormat(bytes), 'image/png');
        stored = await storeGeneratedImage(req, bytes, mime, rawB64);
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
    if (fixedResizeWarning) respHeaders['X-Silkroadai-Image-Resize'] = fixedResizeWarning;
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
    // 非流式:zhiyunai 逆向上游的 finish_reason 可能漏非标值,归一后再返
    // (本分支不走 forwardToNewApi,归一入口覆盖不到,这里自己补)
    if (data) normalizeChoices(data);
    return NextResponse.json(data ?? {}, { status: 200, headers: respHeaders });
}

/** 非 Gemini 图片(gpt-image-2 等)multipart 转发 → 返回【原始】响应供 reshape。
 *  req.body 已被 formData() 消费,转发已解析的 FormData;删原 content-type 让 fetch
 *  按重建 FormData 重生 boundary。 */
function fetchUpstreamMultipart(req: NextRequest, form: FormData, path: string, search: string): Promise<Response> {
    const headers = forwardHeaders(req);
    headers.delete('content-type');
    return fetch(`${NEWAPI_BASE_URL}/v1${path}${search}`, {
        method: 'POST',
        headers,
        body: form,
        signal: AbortSignal.timeout(UPSTREAM_IMAGE_TIMEOUT_MS), // 600s,对齐 Caddy(否则 undici 默认 300s → 扣费无图)
    });
}

/** 非 Gemini 图片 JSON 转发 → 返回【原始】响应供 reshape(CT 强制 json)。 */
function fetchUpstreamJson(req: NextRequest, body: JsonRecord, path: string, search: string): Promise<Response> {
    return fetch(`${NEWAPI_BASE_URL}/v1${path}${search}`, {
        method: 'POST',
        headers: jsonForwardHeaders(req),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(UPSTREAM_IMAGE_TIMEOUT_MS), // 600s,对齐 Caddy(否则 undici 默认 300s → 扣费无图)
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

/** 输入图尺寸 → 最近的合法 gpt-image 像素 size(从 GPT_IMAGE_ASPECT_SIZE 表按宽高比挑最近的)。 */
function gptImageSizeFromInput(w: number, h: number): string {
    if (!(w > 0 && h > 0)) return DEFAULT_GPT_IMAGE_SIZE;
    const target = w / h;
    let best = DEFAULT_GPT_IMAGE_SIZE;
    let bestDiff = Infinity;
    for (const px of Object.values(GPT_IMAGE_ASPECT_SIZE)) {
        const m = /^(\d+)x(\d+)$/.exec(px);
        if (!m) continue;
        const diff = Math.abs(Number(m[1]) / Number(m[2]) - target);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = px;
        }
    }
    return best;
}

/** 尺寸重试用的明确 size:有输入图(图生图)→ 读第一张输入图尺寸选最近合法 WxH(改竖图出竖图,
 *  不强行方图);无输入图(文生图)/ 读不出尺寸 → 1024²。 */
async function gptImageFallbackSize(form: FormData | null, body: JsonRecord | null): Promise<string> {
    let dims: { w: number; h: number } | null = null;
    if (form) {
        const files = formImageFiles(form);
        if (files.length) dims = imageDimensions(Buffer.from(await files[0].arrayBuffer()));
    } else if (body) {
        const imgs = await extractJsonInputImages(body);
        if (imgs.length) dims = imageDimensions(Buffer.from(imgs[0].data, 'base64'));
    }
    return dims ? gptImageSizeFromInput(dims.w, dims.h) : DEFAULT_GPT_IMAGE_SIZE;
}

/** gpt-image 上游调用 + 尺寸重试:先按客户【原始】size(可能是 auto / 缺省)发上游 —— 直签渠道
 *  (zhiyunai/ch44)收 auto 照旧,体验完全不变。仅当上游回 "size must use <width>x<height>"
 *  (只有候补 Adobe/ch83 这样)→ 补一个明确 size 重试一次(edits 跟随输入图、文生图 1024²)。
 *  内容安全 / 上游饱和等其它错误不重试 —— 归一化只在 adobe 那条路发生。 */
async function gptImageUpstreamWithSizeRetry(
    req: NextRequest,
    form: FormData | null,
    body: JsonRecord | null,
    search: string,
): Promise<Response> {
    const first = await gptImageUpstream(req, form, body, search);
    if (first.ok) return first;
    // 付费档位已绑定固定尺寸;不得在重试时降到 1K,否则请求模型名与实际图像不一致。
    const requestModel = String(form?.get('model') ?? body?.model ?? '');
    if (gptImageVariant(requestModel)) return first;
    const errText = await first.text();
    if (!/size must use/i.test(errText)) {
        // 非尺寸格式错(含内容安全 / 上游饱和)→ 不重试,重建 Response 供上层 reshape/脱敏读取。
        // 保留原响应头(x-new-api-version 等),仅剥 content-encoding/length —— text() 已解压,原值会失配。
        const h = new Headers(first.headers);
        h.delete('content-encoding');
        h.delete('content-length');
        return new Response(errText, { status: first.status, headers: h });
    }
    const explicit = await gptImageFallbackSize(form, body);
    if (form) form.set('size', explicit);
    else if (body) body.size = explicit;
    return gptImageUpstream(req, form, body, search);
}

function cloneImageFormData(form: FormData): FormData {
    const clone = new FormData();
    for (const [key, value] of form.entries()) clone.append(key, value);
    return clone;
}

function fixedImageCount(raw: unknown): number {
    if (raw === undefined || raw === null || raw === '') return 1;
    const value = typeof raw === 'string' ? raw.trim() : String(raw);
    const parsed = Number(value);
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed) || parsed > FIXED_GPT_IMAGE_MAX_N) {
        throw new ImageCountError(`n must be an integer between 1 and ${FIXED_GPT_IMAGE_MAX_N}`);
    }
    return parsed;
}

function sumImageUsage(records: JsonRecord[]): JsonRecord {
    const sum = (values: unknown[]): unknown => {
        if (values.every((value) => typeof value === 'number')) {
            return (values as number[]).reduce((total, value) => total + value, 0);
        }
        if (values.every((value) => value && typeof value === 'object' && !Array.isArray(value))) {
            const objects = values as JsonRecord[];
            const keys = [...new Set(objects.flatMap((value) => Object.keys(value)))];
            return Object.fromEntries(keys.map((key) => [key, sum(objects.map((value) => value[key] ?? 0))]));
        }
        return values[0];
    };
    return sum(records) as JsonRecord;
}

type FixedVariantFanoutResult = { response: Response; successfulRequests: number };

/** 固定价别名的 n 必须拆成独立 new-api 请求,否则部分上游会静默只出 1 图且只扣 1 次。
 * 每路强制 n=1,最多 4 路并发(与 Gemini images 现有上限一致)。部分失败保留成功子集并带
 * 失败数头;全失败透传首个非 2xx,没有可透传响应时合成 502。若上游违反 n=1 契约返回
 * 多张,new-api 会按实际 data 数计费,所以必须全部交付,不能静默丢掉已收费图片。 */
async function fixedVariantImageFanout(
    req: NextRequest,
    form: FormData | null,
    body: JsonRecord | null,
    search: string,
    n: number,
): Promise<FixedVariantFanoutResult> {
    const settled = await Promise.allSettled(
        Array.from({ length: n }, () => {
            if (form) {
                const child = cloneImageFormData(form);
                child.set('n', '1');
                return gptImageUpstreamWithSizeRetry(req, child, null, search);
            }
            return gptImageUpstreamWithSizeRetry(req, null, { ...(body ?? {}), n: 1 }, search);
        }),
    );

    const images: JsonRecord[] = [];
    const successBodies: JsonRecord[] = [];
    let firstSuccessHeaders: Headers | null = null;
    const errorResponses: Response[] = [];
    let firstClassifiableFailure: Response | null = null;
    let firstFailureMessage = '';
    let failedCount = 0;

    for (const result of settled) {
        if (result.status === 'rejected') {
            failedCount++;
            if (!firstFailureMessage) {
                firstFailureMessage = result.reason instanceof Error ? result.reason.message : String(result.reason);
            }
            continue;
        }
        const response = result.value;
        if (!response.ok) {
            failedCount++;
            errorResponses.push(response);
            if (!firstClassifiableFailure) firstClassifiableFailure = response;
            continue;
        }
        const responseText = await response.text();
        let parsed: JsonRecord | null = null;
        try {
            parsed = JSON.parse(responseText) as JsonRecord;
        } catch {
            parsed = null;
        }
        const payload = parsed && Array.isArray(parsed.data) ? (parsed.data as JsonRecord[]) : [];
        const childImages = payload.filter(
            (item) =>
                item &&
                ((typeof item.b64_json === 'string' && item.b64_json) || (typeof item.url === 'string' && item.url)),
        );
        if (!parsed || childImages.length === 0) {
            failedCount++;
            if (!firstFailureMessage) firstFailureMessage = 'upstream returned no image payload';
            if (
                !firstClassifiableFailure &&
                ((parsed && Boolean(parsed.error)) || IMAGE_SAFETY_RE.test(responseText))
            ) {
                const headers = new Headers(response.headers);
                headers.delete('content-encoding');
                headers.delete('content-length');
                firstClassifiableFailure = new Response(responseText, { status: response.status, headers });
            }
            continue;
        }
        if (!firstSuccessHeaders) firstSuccessHeaders = new Headers(response.headers);
        images.push(...childImages);
        successBodies.push(parsed);
    }

    if (images.length === 0) {
        if (firstClassifiableFailure) {
            await Promise.all(
                errorResponses
                    .filter((response) => response !== firstClassifiableFailure)
                    .map(async (response) => {
                        try {
                            await response.body?.cancel();
                        } catch {
                            // best-effort:the selected response remains intact for passthrough below
                        }
                    }),
            );
            return { response: firstClassifiableFailure, successfulRequests: 0 };
        }
        return {
            response: new Response(
                JSON.stringify({
                    error: {
                        message: firstFailureMessage || 'all fixed-price image requests failed',
                        type: 'upstream_error',
                    },
                }),
                { status: 502, headers: { 'content-type': 'application/json' } },
            ),
            successfulRequests: 0,
        };
    }

    await Promise.all(
        errorResponses.map(async (response) => {
            try {
                await response.body?.cancel();
            } catch {
                // Partial success has a usable payload; an unused error body must not hold the connection.
            }
        }),
    );

    const aggregate: JsonRecord = { ...successBodies[0], data: images };
    const usages = successBodies
        .map((value) => value.usage)
        .filter((value): value is JsonRecord => Boolean(value && typeof value === 'object' && !Array.isArray(value)));
    if (usages.length === successBodies.length) aggregate.usage = sumImageUsage(usages);
    else delete aggregate.usage;

    const headers = firstSuccessHeaders ?? new Headers();
    headers.delete('content-encoding');
    headers.delete('content-length');
    headers.set('content-type', 'application/json');
    if (failedCount > 0) headers.set('X-Silkroadai-Images-Failed', String(failedCount));
    return {
        response: new Response(JSON.stringify(aggregate), { status: 200, headers }),
        successfulRequests: successBodies.length,
    };
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
/** gpt-image 尺寸重试的兜底默认(文生图、或读不出输入图尺寸时用)。 */
const DEFAULT_GPT_IMAGE_SIZE = '1024x1024';
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
/** gpt-image-2-{1,2,4}k 是客户可见的固定价 SKU。new-api 先按这个原始名查 ModelPrice,
 *  再通过渠道 model_mapping 翻成 gpt-image-2 发给上游;因此 Portal 只能注入尺寸,
 *  绝不能在进入 new-api 前改掉模型名。返回 null = 非固定价别名。 */
type GptImageVariant = { alias: string; size: string; width: number; height: number };

function gptImageVariant(model: string): GptImageVariant | null {
    const m = /^gpt-image-2-([124])[kK]$/.exec(model);
    if (!m) return null;
    const [width, height] = m[1] === '1' ? [1024, 1024] : m[1] === '2' ? [2048, 2048] : [3840, 2160];
    return { alias: `gpt-image-2-${m[1]}k`, size: `${width}x${height}`, width, height };
}

/** 固定价 SKU 的尺寸守门。size 缺省/auto 会注入固定尺寸;
 *  aspect_ratio 不适用于已绑定像素尺寸的 SKU,只要显式传入就拒绝。 */
function resolveGptImageVariantSize(model: string, sizeRaw: string, aspectRatioRaw: string): string {
    const variant = gptImageVariant(model);
    if (!variant) return sizeRaw;
    const aspectRatio = aspectRatioRaw.trim();
    if (aspectRatio) {
        throw new ImageSizeError(
            `model "${model}" has fixed size "${variant.size}"; omit aspect_ratio and size, or use that exact size.`,
        );
    }
    const size = sizeRaw.trim();
    if (size && size.toLowerCase() !== 'auto' && size.toLowerCase() !== variant.size.toLowerCase()) {
        throw new ImageSizeError(
            `model "${model}" has fixed size "${variant.size}"; omit size or use that exact size.`,
        );
    }
    return variant.size;
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
    const model = typeof body.model === 'string' ? body.model : '';
    const vm = gptImageVariant(model);
    if (vm) {
        body.model = vm.alias;
        body.size = resolveGptImageVariantSize(
            model,
            typeof body.size === 'string' ? body.size : '',
            typeof body.aspect_ratio === 'string' ? body.aspect_ratio : '',
        );
    } else {
        const ar = typeof body.aspect_ratio === 'string' ? body.aspect_ratio : '';
        const sz = typeof body.size === 'string' ? body.size : '';
        if (ASPECT_RATIO_RE.test(ar.trim()) || ASPECT_RATIO_RE.test(sz.trim())) {
            const px = ratioToSize(ar, sz);
            if (px) body.size = px;
            else delete body.size;
        }
    }
    delete body.aspect_ratio;
    coerceImageIntFields(body);
}
/** gpt-image multipart 规整(同 normalizeGptImageJson,作用于 FormData)。 */
function normalizeGptImageForm(form: FormData): void {
    form.delete('response_format');
    const model = String(form.get('model') ?? '');
    const vm = gptImageVariant(model);
    if (vm) {
        form.set('model', vm.alias);
        form.set(
            'size',
            resolveGptImageVariantSize(model, String(form.get('size') ?? ''), String(form.get('aspect_ratio') ?? '')),
        );
    } else {
        const ar = String(form.get('aspect_ratio') ?? '');
        const sz = String(form.get('size') ?? '');
        if (ASPECT_RATIO_RE.test(ar.trim()) || ASPECT_RATIO_RE.test(sz.trim())) {
            const px = ratioToSize(ar, sz);
            if (px) form.set('size', px);
            else form.delete('size');
        }
    }
    form.delete('aspect_ratio');
}

// ============ 严格模式(opt-in,对标 Azure gpt-image 契约)============
// zhiyunai(渠道 44)对不支持的参数「静默忽略 / 静默改尺寸」而非按 Azure 那样 400。客户可发
// `X-Silkroadai-Strict: true`(或 `?strict=true`)让代理层先按 Azure 标准校验:webp/transparent/
// 非法尺寸 → 400;`output_format=jpeg` → 服务端 png→jpeg 转码(zhiyunai 恒返 png)。非严格模式
// 行为完全不变(不带开关 = 现状)。

/** 严格模式开关:请求头 `X-Silkroadai-Strict: true` 或 query `?strict=true`。 */
function isStrictImageMode(req: NextRequest, search: string): boolean {
    if ((req.headers.get('x-silkroadai-strict') || '').toLowerCase() === 'true') return true;
    return new URLSearchParams(search).get('strict') === 'true';
}

/** gpt-image 尺寸校验(逆向 ch44 zhiyunai 实测规则)。仅校验显式 WxH 像素尺寸(auto / 比例串
 *  交给 normalize)。合规 = 两边都是 16 的倍数、1024 ≤ 长边 ≤ 3840、短边 ≤ 2160、长/短 ≤ 3:1。
 *  返回 400 错误文案或 null(合规)。 */
function gptImageSizeError(size: string): string | null {
    if (!size) return null;
    const m = size.match(/^(\d+)x(\d+)$/);
    if (!m) return null; // 非 WxH(auto / "16:9" 等)→ 不在此校验
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (w % 16 !== 0 || h % 16 !== 0) return `invalid size '${size}': width and height must be multiples of 16`;
    const long = Math.max(w, h);
    const short = Math.min(w, h);
    if (long < 1024) return `invalid size '${size}': minimum long edge is 1024`;
    if (long > 3840 || short > 2160)
        return `invalid size '${size}': maximum is 3840x2160 (long edge ≤ 3840, short edge ≤ 2160)`;
    if (long / short > 3) return `invalid size '${size}': aspect ratio must be within 3:1`;
    return null;
}

/** 严格模式下校验 gpt-image 入参(output_format / background / size)。返回 400 文案或 null。 */
function strictGptImageError(outputFormat: string, background: string, size: string): string | null {
    const of = outputFormat.toLowerCase();
    if (of && of !== 'png' && of !== 'jpeg') return `output_format '${outputFormat}' not supported (only png / jpeg)`;
    if (background.toLowerCase() === 'transparent') return `background 'transparent' not supported`;
    return gptImageSizeError(size);
}

type ImageOutputFormat = 'png' | 'jpeg' | 'webp';

function detectImageOutputFormat(buf: Buffer): ImageOutputFormat | null {
    if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
        return 'png';
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
    if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP')
        return 'webp';
    return null;
}

function imageFormatMime(format: ImageOutputFormat | null, fallback = 'application/octet-stream'): string {
    return format ? `image/${format}` : fallback;
}

/** png base64 → jpeg base64(jimp,纯 JS 无 native 依赖,失败回退原字节并显式报告)。 */
async function pngToJpegB64(pngB64: string): Promise<{ b64: string; converted: boolean }> {
    try {
        const { Jimp } = await import('jimp');
        const img = await Jimp.read(Buffer.from(pngB64, 'base64'));
        const jpegBuf = await img.getBuffer('image/jpeg', { quality: 92 });
        return { b64: Buffer.from(jpegBuf).toString('base64'), converted: true };
    } catch (e) {
        console.warn('[gpt-image] png→jpeg transcode failed, keeping png:', e instanceof Error ? e.message : e);
        return { b64: pngB64, converted: false };
    }
}

type FixedVariantImageItem = { b64_json?: unknown; url?: unknown; size?: unknown };
type FixedVariantEnforcement = { sizes: Array<string | null>; fallbacks: string[]; unverified: boolean };

/** 固定价 SKU 的响应像素守门。上游会静默忽略 1K size(实测返 1254x1254),因此不能只
 * 回显请求尺寸。能从字节头确认已精确命中时不解码、不重编码,保留原 b64 字节;只有尺寸
 * 不符时才用 Jimp resize。URL 响应先经现有 SSRF/大小守门下载,再进入同一校验路径。
 * 已知真实尺寸但本地缩放失败时返回原图和真实 size;格式无法识别时也返回原图但删除 size。
 * 两者都带 warning header,避免上游已扣费后再返回 502 诱发重复扣费。只有完全没有图片载荷
 * 才抛错,且任何失败都不会把错误或未知尺寸伪装成目标尺寸。 */
async function enforceFixedVariantImageOutput(
    items: FixedVariantImageItem[],
    variant: GptImageVariant,
): Promise<FixedVariantEnforcement> {
    if (items.length === 0) throw new Error(`model "${variant.alias}" upstream returned no images`);
    const sizes: Array<string | null> = [];
    const fallbacks: string[] = [];
    let unverified = false;
    const usableItems: FixedVariantImageItem[] = [];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        let b64 = typeof item.b64_json === 'string' && item.b64_json ? stripAdobeImageMetadataB64(item.b64_json) : '';

        if (!b64 && typeof item.url === 'string' && item.url) {
            try {
                const part = await imageUrlToInlinePart(item.url);
                if (!('inlineData' in part)) throw new Error('download did not produce image bytes');
                b64 = stripAdobeImageMetadataB64(part.inlineData.data);
            } catch (e) {
                const reason = e instanceof Error ? e.message : String(e);
                console.error('[gpt-image] fixed variant URL could not be verified; returning original URL', {
                    model: variant.alias,
                    item: i + 1,
                    targetSize: variant.size,
                    error: reason,
                });
                delete item.size;
                sizes.push(null);
                fallbacks.push(`${i + 1}:unverified-url`);
                unverified = true;
                usableItems.push(item);
                continue;
            }
        }
        if (!b64) {
            console.error('[gpt-image] fixed variant item has no image payload; dropping item', {
                model: variant.alias,
                item: i + 1,
                targetSize: variant.size,
            });
            fallbacks.push(`${i + 1}:missing`);
            unverified = true;
            continue;
        }

        const input = Buffer.from(b64, 'base64');
        const headerDims = imageDimensions(input);
        if (headerDims?.w === variant.width && headerDims.h === variant.height) {
            item.b64_json = b64;
            delete item.url;
            item.size = variant.size;
            sizes.push(variant.size);
            usableItems.push(item);
            continue;
        }

        let decodedDims: { w: number; h: number } | null = null;
        try {
            const { Jimp } = await import('jimp');
            const image = await Jimp.read(input);
            decodedDims = { w: image.width, h: image.height };
            // imageDimensions intentionally recognizes only PNG/JPEG/WebP. Jimp may recognize another
            // format; if it is already exact, keep its original bytes too.
            if (image.width !== variant.width || image.height !== variant.height) {
                image.resize({ w: variant.width, h: variant.height });
                const resized = await image.getBuffer('image/png');
                const resizedDims = imageDimensions(Buffer.from(resized));
                if (resizedDims?.w !== variant.width || resizedDims.h !== variant.height) {
                    throw new Error(`resize produced ${resizedDims?.w ?? '?'}x${resizedDims?.h ?? '?'}`);
                }
                b64 = Buffer.from(resized).toString('base64');
            }
        } catch (e) {
            const actual = decodedDims ?? headerDims;
            if (actual) {
                const actualSize = `${actual.w}x${actual.h}`;
                const reason = e instanceof Error ? e.message : String(e);
                console.error('[gpt-image] fixed variant resize failed; returning original image', {
                    model: variant.alias,
                    item: i + 1,
                    actualSize,
                    targetSize: variant.size,
                    error: reason,
                });
                item.b64_json = b64;
                delete item.url;
                item.size = actualSize;
                sizes.push(actualSize);
                fallbacks.push(`${i + 1}:${actualSize}`);
                usableItems.push(item);
                continue;
            }
            const reason = e instanceof Error ? e.message : String(e);
            console.error('[gpt-image] fixed variant image could not be verified; returning original image', {
                model: variant.alias,
                item: i + 1,
                targetSize: variant.size,
                error: reason,
            });
            item.b64_json = b64;
            delete item.url;
            delete item.size;
            sizes.push(null);
            fallbacks.push(`${i + 1}:unverified`);
            unverified = true;
            usableItems.push(item);
            continue;
        }

        item.b64_json = b64;
        delete item.url;
        item.size = variant.size;
        sizes.push(variant.size);
        usableItems.push(item);
    }
    if (usableItems.length === 0) throw new Error(`model "${variant.alias}" upstream returned no usable images`);
    items.splice(0, items.length, ...usableItems);
    return { sizes, fallbacks, unverified };
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
function buildEstimatedUsage(prompt: string, outSize: string, imageCount = 1, promptCount = 1): JsonRecord {
    const textTokens = estimateTextTokens(prompt) * Math.max(1, promptCount);
    const outImageTokens = estimateImageTokens(outSize) * Math.max(1, imageCount);
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

/** 请求侧待回显的 images 顶层字段(OpenAI gpt-image 官方响应形:quality/background/output_format)。
 *  gptDefaults=true(gpt-image 系)时客户没传也按官方缺省补齐;否则只回显客户显式传的值。 */
type ImageEchoFields = { quality: string; background: string; outputFormat: string; gptDefaults: boolean };

/** 非 Gemini 图片模型(gpt-image-2 等)透传 + 响应整形:
 *  - 上游报错(非 2xx)/ 非预期形态 → 透传 status+体(**绝不隐藏报错**,客户要求),
 *    仅两个例外:审核拒绝统一文案 + 恒 400;上游 200 包 error 体 → 502(见分支内注释)。
 *  - 成功 → 补 OpenAI gpt-image 形的顶层 `size` + 估算 `usage` + 回显 `quality` /
 *    `background` / `output_format`(上游已带则保留不覆盖)。data[].b64_json 等字段原样保留。 */
async function reshapeOpenAiImageResponse(
    upstream: Response,
    prompt: string,
    requestedSize: string,
    cap: CaptureCtx | null,
    req: NextRequest | null = null,
    storeToUrl = false,
    transcodeJpeg = false,
    echo: ImageEchoFields | null = null,
    fixedVariant: GptImageVariant | null = null,
    estimatedPromptCount = 1,
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

    // 上游报错 / 形态非预期(非 JSON、无 data)→ 透传为主,例外见下。
    if (!upstream.ok || !data) {
        if (cap) captureJsonResponse(cap, upstream.status, (json ?? { _raw: text.slice(0, 500) }) as JsonRecord);
        if (upstream.ok) {
            // 上游 200 但体不是标准图片 JSON,三分:
            // - 含审核标记(号池个别成员把拒绝包在 HTTP 200 体里)→ 统一审核文案 + 400,
            //   绝不让「200 + 错误体」出门 —— 客户网关会按成功入账(2026-08-08 客户反馈实例);
            // - 体带 error 字段(200 假成功,非审核类)→ 502,客户按失败重试;
            // - 其余(stream:true 的 SSE 成功体等)原样透传 200,连品牌替换都不做
            //   (\badobe\b 的 \b 会命中 b64 里 `/adobe+` 这类片段,替换会写坏图)。
            if (IMAGE_SAFETY_RE.test(text)) {
                headers.set('content-type', 'application/json');
                return new NextResponse(IMAGE_SAFETY_BODY, { status: 400, headers });
            }
            if (json && (json as { error?: unknown }).error) {
                headers.set('content-type', 'application/json');
                return new NextResponse(text.replace(/\badobe\b/gi, 'the provider'), { status: 502, headers });
            }
            return new NextResponse(text, { status: 200, headers });
        }
        const sanitized = sanitizeImageError(text, upstream.status);
        if (sanitized.body !== text) headers.set('content-type', 'application/json');
        return new NextResponse(sanitized.body, { status: sanitized.status, headers });
    }

    // 成功:补顶层 size + 估算 usage(保留上游已有的)。
    const j = json as JsonRecord; // data 非空 ⇒ json 非空
    const firstSize = typeof data[0]?.size === 'string' ? (data[0].size as string) : '';
    const outSize = fixedVariant?.size || (typeof j.size === 'string' && j.size) || firstSize || requestedSize || '';
    const out: JsonRecord = { ...j };
    if (fixedVariant) out.size = fixedVariant.size;
    else if (out.size === undefined && outSize) out.size = outSize;

    // 回显 quality / background / output_format(官方 gpt-image 响应顶层字段)。链路上没有一层会带:
    // ch154 适配器只合成 {created,data,usage},new-api 重组体只加 request_id/size —— 客户的官方
    // 兼容测试校验响应回显 quality,2026-08-11 反馈缺失。上游已带则不覆盖。
    if (echo) {
        const fields: Array<['quality' | 'background' | 'output_format', string, string]> = [
            ['quality', echo.quality, 'auto'],
            ['background', echo.background, 'opaque'],
            ['output_format', echo.outputFormat, 'png'],
        ];
        for (const [key, requested, dflt] of fields) {
            const v = requested.trim().toLowerCase() || (echo.gptDefaults ? dflt : '');
            if (out[key] === undefined && v) out[key] = v;
        }
    }

    // 候补 adobe(Firefly)出图内嵌 C2PA 会暴露真实上游 → 剥离图内元数据(自定向:仅命中 adobe/
    // firefly 标识的图才剥,azure/gemini 出图不含该标识 → 字节原样)。放在 transcode/存图/返回之前,
    // 三条出图路径(内联 b64 / jpeg 转码 / 转存 url)统一干净。out.data 与 data 同引用,就地改即生效。
    for (const it of data) {
        if (typeof it.b64_json === 'string' && it.b64_json) it.b64_json = stripAdobeImageMetadataB64(it.b64_json);
    }

    if (fixedVariant) {
        try {
            const result = await enforceFixedVariantImageOutput(data, fixedVariant);
            if (result.fallbacks.length > 0) {
                headers.set(
                    'X-Silkroadai-Image-Resize',
                    result.unverified ? 'unverified-original-returned' : 'failed-original-returned',
                );
                const knownSizes = result.sizes.filter((size): size is string => size !== null);
                const uniqueSizes = [...new Set(knownSizes)];
                if (knownSizes.length === data.length && uniqueSizes.length === 1) out.size = uniqueSizes[0];
                else delete out.size;
            }
        } catch (e) {
            return imageError(e instanceof Error ? e.message : String(e), 502, cap);
        }
    }

    const usageSize = typeof out.size === 'string' ? out.size : fixedVariant ? '' : outSize;
    if (out.usage === undefined) {
        out.usage = buildEstimatedUsage(prompt, usageSize, data.length, estimatedPromptCount);
    }

    // 严格模式 output_format=jpeg:zhiyunai 恒返 png,服务端 png→jpeg 转码(就地改 data[].b64_json,
    // out.data 同一引用会一并反映)。失败回退原 png(pngToJpegB64 永不抛)。
    const imgMime = transcodeJpeg ? 'image/jpeg' : 'image/png';
    if (transcodeJpeg) {
        for (const item of data) {
            if (typeof item.b64_json === 'string' && item.b64_json) {
                const converted = await pngToJpegB64(item.b64_json);
                item.b64_json = converted.b64;
                if (!converted.converted) {
                    headers.set('X-Silkroadai-Image-Format', 'conversion-failed-original-returned');
                }
            }
        }
    }

    if (fixedVariant) {
        const formats = data.map((item) => {
            if (typeof item.b64_json !== 'string' || !item.b64_json) return null;
            return detectImageOutputFormat(Buffer.from(item.b64_json, 'base64'));
        });
        const knownFormats = formats.filter((format): format is ImageOutputFormat => format !== null);
        const uniqueFormats = [...new Set(knownFormats)];
        if (knownFormats.length === data.length && uniqueFormats.length === 1) out.output_format = uniqueFormats[0];
        else delete out.output_format;
    }

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
            const bytes = Buffer.from(b64, 'base64');
            const actualMime = imageFormatMime(detectImageOutputFormat(bytes), imgMime);
            const stored = await storeGeneratedImage(req, bytes, actualMime, b64);
            const d: JsonRecord = { ...item, url: stored.url };
            delete d.b64_json;
            newData.push(d);
            if (stored.ossFallback) headers.set('X-Silkroadai-Oss-Fallback', 'yes');
            if (stored.r2Fallback) headers.set('X-Silkroadai-R2-Fallback', 'yes');
            refs = refs.concat(hostedRefs(stored));
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
 * - `n`(多图):Gemini generateContent 单次只出 1 图(candidateCount 对生图不生效),
 *   proxy 层 fan-out n 个并行请求实现。clamp 1-4;每个请求独立过 new-api 计费,
 *   n 张 = n 次扣费。部分失败返成功子集(200 + X-Silkroadai-Images-Failed 头),
 *   全失败沿用单张语义(上游错误原样透传)。非 Gemini 模型的 n 原样透传上游。
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
    let nRaw = '';
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
            nRaw = String(form.get('n') ?? '');
            // model 非我们的 Gemini 生图 → 重建 FormData 透传(保留 gpt-image-2 等)
            if (!(model in GEMINI_IMAGE_MODELS)) {
                // gpt-image:剥 response_format + 把比例(aspect_ratio / "16:9" 形态 size)翻成像素 size
                let wantJpeg = false;
                const fixedVariant = gptImageVariant(model);
                let fixedN = 1;
                if (isGptImageModel(model)) {
                    if (fixedVariant && String(form.get('stream') ?? '').toLowerCase() === 'true') {
                        return imageError(
                            'stream=true is not supported for fixed-price gpt-image-2 variants',
                            400,
                            cap,
                        );
                    }
                    if (fixedVariant) {
                        try {
                            fixedN = fixedImageCount(nRaw);
                        } catch (e) {
                            if (e instanceof ImageCountError) return imageError(e.message, 400, cap);
                            throw e;
                        }
                    }
                    // 严格模式(opt-in):先按 Azure 标准校验 output_format/background/size,不合规 → 400
                    if (isStrictImageMode(req, search)) {
                        const err = strictGptImageError(
                            String(form.get('output_format') ?? ''),
                            String(form.get('background') ?? ''),
                            sizeRaw,
                        );
                        if (err) return imageError(err, 400, cap);
                        wantJpeg = String(form.get('output_format') ?? '').toLowerCase() === 'jpeg';
                    }
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
                const echo: ImageEchoFields = {
                    quality: String(form.get('quality') ?? ''),
                    background: String(form.get('background') ?? ''),
                    outputFormat: String(form.get('output_format') ?? ''),
                    gptDefaults: isGptImageModel(model),
                };
                try {
                    // 统一入口:gpt-image 按有无输入图分流到上游 edits/generations(与调用 path 无关);
                    // 其余非 Gemini 图片模型仍按调用 path 原样透传 multipart。
                    let upstream: Response;
                    let estimatedPromptCount = 1;
                    if (isGptImageModel(model)) {
                        if (fixedVariant && fixedN > 1) {
                            const fanout = await fixedVariantImageFanout(req, form, null, search, fixedN);
                            upstream = fanout.response;
                            estimatedPromptCount = fanout.successfulRequests;
                        } else {
                            upstream = await gptImageUpstreamWithSizeRetry(req, form, null, search);
                        }
                    } else {
                        upstream = await fetchUpstreamMultipart(req, form, path, search);
                    }
                    return await reshapeOpenAiImageResponse(
                        upstream,
                        prompt,
                        sizeRaw,
                        cap,
                        req,
                        isGptImageModel(model) && wantHostedUrl,
                        wantJpeg,
                        echo,
                        fixedVariant,
                        estimatedPromptCount,
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
            nRaw = String(body.n ?? '');
            if (cap) recordRequestBody(cap, JSON.stringify(body), model, false);
            if (!(model in GEMINI_IMAGE_MODELS)) {
                // gpt-image:剥 response_format(zhiyunai 拒收 →400)+ 比例→像素 size(zhiyunai 不认
                // aspect_ratio / "16:9" 形态 size,默认出方图)。见 normalizeGptImageJson。
                let wantJpeg = false;
                const fixedVariant = gptImageVariant(model);
                let fixedN = 1;
                if (isGptImageModel(model)) {
                    if (fixedVariant && body.stream === true) {
                        return imageError(
                            'stream=true is not supported for fixed-price gpt-image-2 variants',
                            400,
                            cap,
                        );
                    }
                    if (fixedVariant) {
                        try {
                            fixedN = fixedImageCount(nRaw);
                        } catch (e) {
                            if (e instanceof ImageCountError) return imageError(e.message, 400, cap);
                            throw e;
                        }
                    }
                    // 严格模式(opt-in):先按 Azure 标准校验 output_format/background/size,不合规 → 400
                    if (isStrictImageMode(req, search)) {
                        const err = strictGptImageError(
                            typeof body.output_format === 'string' ? body.output_format : '',
                            typeof body.background === 'string' ? body.background : '',
                            sizeRaw,
                        );
                        if (err) return imageError(err, 400, cap);
                        wantJpeg =
                            (typeof body.output_format === 'string' ? body.output_format : '').toLowerCase() === 'jpeg';
                    }
                    normalizeGptImageJson(body);
                    sizeRaw = typeof body.size === 'string' ? body.size : '';
                }
                const echo: ImageEchoFields = {
                    quality: typeof body.quality === 'string' ? body.quality : '',
                    background: typeof body.background === 'string' ? body.background : '',
                    outputFormat: typeof body.output_format === 'string' ? body.output_format : '',
                    gptDefaults: isGptImageModel(model),
                };
                try {
                    // 统一入口:gpt-image body 里带 image/image_url → 图生图 edits;否则文生图 generations。
                    let upstream: Response;
                    let estimatedPromptCount = 1;
                    if (isGptImageModel(model)) {
                        if (fixedVariant && fixedN > 1) {
                            const fanout = await fixedVariantImageFanout(req, null, body, search, fixedN);
                            upstream = fanout.response;
                            estimatedPromptCount = fanout.successfulRequests;
                        } else {
                            upstream = await gptImageUpstreamWithSizeRetry(req, null, body, search);
                        }
                    } else {
                        upstream = await fetchUpstreamJson(req, body, path, search);
                    }
                    return await reshapeOpenAiImageResponse(
                        upstream,
                        prompt,
                        sizeRaw,
                        cap,
                        req,
                        isGptImageModel(model) && wantHostedUrl,
                        wantJpeg,
                        echo,
                        fixedVariant,
                        estimatedPromptCount,
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
        if (e instanceof ImageSizeError || e instanceof ImageCountError) return imageError(e.message, 400, cap);
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
    // n(多图):Gemini 单次只出 1 图 → fan-out n 个并行请求(clamp 1-4,防大 n 打爆并发/账单;
    // 非整数 / 缺省 / 非法值一律按 1)。每个请求独立过 new-api 计费,n 张 = n 次扣费。
    const nParsed = Number(nRaw);
    const n = Number.isFinite(nParsed) && nParsed >= 1 ? Math.min(4, Math.trunc(nParsed)) : 1;

    const requestBody = JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { imageConfig } });
    const settled = await Promise.allSettled(
        Array.from({ length: n }, () => geminiGenerateWithFailover(req, model, requestBody)),
    );

    // 汇总:成功的收图;失败的记数,留第一个非 2xx 响应做「全失败」时的透传载体
    // (n=1 时与旧单张行为逐字节一致:上游错误原样透传,含 status/body)。
    const images: Array<{ mimeType: string; data: string }> = [];
    let firstErrorResponse: Response | null = null;
    let failedCount = 0;
    for (const s of settled) {
        if (s.status === 'rejected') {
            failedCount++;
            continue;
        }
        const upstream = s.value;
        if (!upstream.ok) {
            failedCount++;
            if (!firstErrorResponse) firstErrorResponse = upstream;
            continue;
        }
        try {
            const upstreamData = (await upstream.json()) as {
                candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
            };
            const inlineData = (upstreamData.candidates?.[0]?.content?.parts ?? []).find(
                (p) => p.inlineData,
            )?.inlineData;
            if (inlineData) images.push(inlineData);
            else failedCount++;
        } catch {
            failedCount++;
        }
    }

    if (images.length === 0) {
        if (firstErrorResponse) {
            return cap ? captureResponse(cap, firstErrorResponse) : passthroughResponse(firstErrorResponse);
        }
        return imageError('no image generated', 502, cap);
    }

    // ---- 包成 DALL·E 响应(部分失败 → 返成功子集 200 + 头标失败数)----
    const respHeaders: Record<string, string> = { 'X-Silkroadai-Translated': 'gemini-native' };
    if (failedCount > 0) respHeaders['X-Silkroadai-Images-Failed'] = String(failedCount);
    const data: JsonRecord[] = [];
    let refs: string[] = [];
    for (const { mimeType, data: b64 } of images) {
        if (responseFormat === 'b64_json') {
            data.push({ b64_json: b64 });
        } else {
            const stored = await storeGeneratedImage(req, Buffer.from(b64, 'base64'), mimeType, b64);
            data.push({ url: stored.url });
            if (stored.ossFallback) respHeaders['X-Silkroadai-Oss-Fallback'] = 'yes';
            if (stored.r2Fallback) respHeaders['X-Silkroadai-R2-Fallback'] = 'yes';
            refs = refs.concat(hostedRefs(stored));
        }
    }

    const dalleResp = { created: Math.floor(Date.now() / 1000), data };
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

        // result_url 重写:new-api 生成的 result_url 是「内容代理」(…/v1/videos/{id}/content),需带 key
        // 且靠 new-api 从渠道 base_url 回抓视频;2026-07-04 把 ch41 base_url 内网化(修 CF 502/524)后
        // 回抓失效 → 401/403(客户反馈「result_url 不是视频地址」)。这里把它改写成 inner 里可播的直链
        // (客户 OSS 优先,否则平台 R2 —— 即上面同一份 video_url),让仍在用 result_url 的老客户自动恢复。
        // data.data.video_url 一直是对的直链,不受影响;失败/未完成任务不改写(finalVideoUrl 为空)。
        const finalVideoUrl = typeof inner?.video_url === 'string' ? (inner.video_url as string) : null;
        if (status === 'SUCCESS' && data && finalVideoUrl && /^https?:\/\//.test(finalVideoUrl)) {
            data.result_url = finalVideoUrl;
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
        // 守卫在这条路径上只负责 keep-alive:翻译器内部把上游读错/无 message_stop 的
        // 提前收流都转成 finish_reason:"error" 尾帧后【干净 close】(它拿得到 id/model,
        // 尾帧形状更完整),错误不会传播到这里;shape 仅作防御性兜底。
        const translated = guardSseStream(translateAnthropicSseToOpenAi(upstream.body, model), {
            shape: 'openai',
            model,
            label: 'proxy/chat/completions#cache-injected',
        });
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

/**
 * GET /v1/key — key 自查端点(借鉴 OpenRouter `GET /api/v1/key`)。
 * 客户拿 sk- 编程自查:别名 / 状态 / 档次 / 账户余额 / 本 key 累计用量,不用登后台。
 * new-api 没有这个端点(纯透传时代这里是 404)→ 拦截是纯增量,零兼容风险。
 *
 * 语义:
 * - 预算在【账户级】(gotcha #12:token 恒 unlimited_quota),余额字段叫
 *   account_balance 明示"这是账户的、不是本 key 的";key 级只有累计消费
 *   (60s 行缓存,best-effort);
 * - 余额是本端点的主用途(脚本监控),拿不到就 503(与 /dashboard/billing/* 一致,
 *   不给 null 让脚本误判);档次显示名 / key 用量是次要信息,失败给 null 不拖垮响应;
 * - 撤销/未知 key 一律 401(与余额查询一致,revoked key 不该在任何端点可用);
 * - 与余额查询同样在 beginCapture 之前拦截,不记请求日志。
 */
async function handleKeySelfInspect(req: NextRequest): Promise<NextResponse> {
    const auth = req.headers.get('authorization') || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return billingError('Missing bearer token', 401);
    const raw = m[1].trim();
    const stored = raw.startsWith('sk-') ? raw.slice(3) : raw; // DB 存无 sk- 前缀

    const token = await prisma.newApiToken.findUnique({
        where: { newapi_token_value: stored },
        select: {
            id: true,
            user_id: true,
            key_alias: true,
            status: true,
            tier: true,
            created_at: true,
            model_limits_enabled: true,
            model_limits: true,
            newapi_token_id: true,
            user: { select: { newapi_user_id: true, tenant_id: true } },
        },
    });
    if (!token || token.status !== 'active') return billingError('Invalid token', 401);

    let bal: CustomerBalance;
    try {
        bal = await getCustomerBalance(token.user_id);
    } catch (err) {
        console.warn('[key-inspect] balance unavailable', {
            err: err instanceof Error ? err.message : String(err),
        });
        return billingError('balance temporarily unavailable', 503);
    }

    // 档次显示名按 key 主人的 tenant 解析(与 /keys 页、建 key POST 同标准)——
    // 白标 tenant 客户不能看到平台的牌子(ChannelGroup 是 @@unique([tenant_id, key]))
    let tierDisplayName: string | null = null;
    try {
        const groups = await listEnabledChannelGroups(token.user.tenant_id ?? null);
        tierDisplayName = groups.find((g) => g.key === token.tier)?.display_name ?? null;
    } catch (err) {
        console.warn('[key-inspect] tier display name unavailable', {
            err: err instanceof Error ? err.message : String(err),
        });
    }

    // 本 key 用量(60s 行缓存,best-effort):
    // - recent_used_cny 是【近 1000 条消费日志的毛和】(token-usage.ts 的 at-a-glance
    //   近似,不含退款、超窗即截断)—— 命名带 recent,不冒充对账口径的累计消费;
    // - last_used_at 只在 source==='live' 时给(缓存命中时 helper 返回的是缓存写入
    //   时间,不是真实最后使用时间 —— 机读端点不能给撒谎数据):字段省略 = 本次未知,
    //   null = 确认从未使用。
    let keyUsage: { recent_used_cny: number; last_used_at?: string | null; source: string } | null = null;
    try {
        if (token.user.newapi_user_id != null) {
            const snap = await getTokenUsageWithCache({
                prismaTokenId: token.id,
                newapiUserId: token.user.newapi_user_id,
                newapiTokenId: token.newapi_token_id,
            });
            keyUsage = {
                recent_used_cny: quotaToCny(Number(snap.used_quota)),
                ...(snap.source === 'live'
                    ? { last_used_at: snap.last_used_at ? snap.last_used_at.toISOString() : null }
                    : {}),
                source: snap.source,
            };
        }
    } catch (err) {
        console.warn('[key-inspect] key usage unavailable', {
            err: err instanceof Error ? err.message : String(err),
        });
    }

    const round4 = (n: number) => Number(n.toFixed(4)); // 与 /v1/balance 同舍入,不漏浮点噪音
    return NextResponse.json({
        data: {
            key_alias: token.key_alias,
            status: token.status,
            tier: token.tier,
            tier_display_name: tierDisplayName,
            created_at: token.created_at.toISOString(),
            model_limits_enabled: token.model_limits_enabled,
            model_limits: token.model_limits,
            account_balance: {
                balance_cny: round4(bal.balanceCny),
                spent_cny: round4(bal.spentCny),
                currency: 'CNY',
                // 监控脚本必须能分辨"新鲜余额"和"new-api 不可达时的陈旧兜底值"
                stale: bal.stale,
            },
            key_usage: keyUsage,
        },
    });
}

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

    // 真实汇率折 $(客户监控脚本看的是真美元)— 不能用 USD_TO_CNY_RATE(那是
    // quota 换算因子,计价单位迁移后 =1,不是汇率)。
    const toUsd = (cny: number) => cny / REAL_USD_TO_CNY;

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

/** 异步提交在建任务前执行固定价 SKU 守门。后台才发现尺寸冲突会让客户先收到 200/task_id,
 *  随后任务失败;这与同步接口的 400 契约不一致,也会制造无意义任务。 */
async function validateAsyncFixedPriceImage(contentType: string, bodyBuf: ArrayBuffer): Promise<string | null> {
    try {
        let model = '';
        let size = '';
        let aspectRatio = '';
        let stream = false;
        let n: unknown = '';
        const parsed = new Request('http://internal/async-image-preflight', {
            method: 'POST',
            headers: { 'content-type': contentType },
            body: bodyBuf.slice(0),
        });
        if (contentType.includes('multipart/form-data')) {
            const form = await parsed.formData();
            model = String(form.get('model') ?? '');
            size = String(form.get('size') ?? '');
            aspectRatio = String(form.get('aspect_ratio') ?? '');
            stream = String(form.get('stream') ?? '').toLowerCase() === 'true';
            n = String(form.get('n') ?? '');
        } else if (contentType.includes('application/json')) {
            const body = (await parsed.json()) as JsonRecord;
            model = typeof body.model === 'string' ? body.model : '';
            size = typeof body.size === 'string' ? body.size : '';
            aspectRatio = typeof body.aspect_ratio === 'string' ? body.aspect_ratio : '';
            stream = body.stream === true;
            n = body.n;
        }
        if (!gptImageVariant(model)) return null;
        if (stream) return 'stream=true is not supported for fixed-price gpt-image-2 variants';
        fixedImageCount(n);
        resolveGptImageVariantSize(model, size, aspectRatio);
        return null;
    } catch (e) {
        return e instanceof ImageSizeError || e instanceof ImageCountError ? e.message : null;
    }
}

function sniffImageMime(buf: Buffer): string {
    return imageFormatMime(detectImageOutputFormat(buf), 'image/png');
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
        const failedImages = Number(resp.headers.get('X-Silkroadai-Images-Failed'));
        if (Number.isInteger(failedImages) && failedImages > 0) json.failed_images = failedImages;
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
    const fixedPriceError = await validateAsyncFixedPriceImage(req.headers.get('content-type') || '', bodyBuf);
    if (fixedPriceError) return imageError(fixedPriceError, 400);
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

    // 独立门户形态(PORTAL_FLAVOR=seedance-enterprise 实例):/v1 只服务 seedance 视频
    // 端点(sk-ent- key + 每客户独立上游 key + ¥账本自扣),其余路径 404。主站实例不受影响。
    if (isEnterpriseFlavor()) return handleEnterpriseV1(req, path);

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

    // key 自查(OpenRouter GET /api/v1/key 模式)。同余额查询:capture 之前拦截,不记日志。
    if (req.method === 'GET' && path === '/key') {
        return handleKeySelfInspect(req);
    }

    // 逐请求用量 + 实际扣费查询(sk- 鉴权机读版,见 ./usage)。同上:capture 之前拦截。
    if (req.method === 'GET' && path === '/usage') {
        return handleUsageQuery(req);
    }

    // 请求日志捕获(数据存储 Phase 1 第②步)。开关 off → null → 下面全程与今天
    // 字节级一致;on → 旁路捕获,best-effort,绝不影响客户请求(见 capture.ts)。
    // OPTIONS 只是浏览器 CORS 预检,没有业务语义,不写请求日志。
    const cap = req.method === 'OPTIONS' ? null : beginCapture(req, path);

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

        // 请求体守门:先就地强转无歧义的字符串标量,再把仍会让 new-api 500 的输入挡成 400。
        // 见 @/lib/proxy/body-guard(三条面共用同一引擎,按面用不同 spec)。
        const { violation } = coerceAndValidate(body, CHAT_SPEC);
        if (violation) return NextResponse.json(violationBody(violation), { status: 400 });

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

    // DALL·E 兼容图像接口:Gemini 生图模型翻译,其余(gpt-image-2 等)透传。
    // next.config 关闭了尾斜杠重定向,所以这里显式规范化图片接口,避免 `/generations/`
    // 落到通用透传后绕过固定价尺寸守门。
    const imagePath = path.length > 1 ? path.replace(/\/+$/, '') : path;
    if ((imagePath === '/images/edits' || imagePath === '/images/generations') && req.method === 'POST') {
        // opt-in 异步:?async=true → 秒回 task_id,后台生图。不带 async 完全走原同步路径(字节不变)。
        if (new URLSearchParams(search).get('async') === 'true') {
            return handleAsyncImageSubmit(req, imagePath, search);
        }
        return withKeepalive(handleImagesDalle(req, imagePath, search, cap));
    }

    // 异步生图结果查询:GET /v1/images/tasks/{task_id}
    if (req.method === 'GET' && /^\/images\/tasks\/[^/]+$/.test(path)) {
        return handleAsyncImageQuery(req, path);
    }

    // seedance-cn 视频【提交】:端到端自扣(绕 new-api:门控 + 记录归属 + 轮询按真 usage 扣)。
    // 非 seedance-cn 的视频提交原样透传 new-api(现有 seedance 逆向/海外档等)。
    if (req.method === 'POST' && (path === '/video/generations' || path === '/videos')) {
        let vbody: JsonRecord;
        try {
            vbody = (await req.json()) as JsonRecord;
        } catch {
            return NextResponse.json(
                { error: { message: 'invalid JSON body', type: 'invalid_request_error' } },
                { status: 400 },
            );
        }
        if (isSeedanceCnModel(String(vbody.model ?? ''))) {
            return handleSeedanceVideoSubmit(req, vbody);
        }
        // kling 视频:同款端到端自扣,直连 token.xinhankr.com(new-api 无法中继该上游,
        // 格式恰为统一视频格式 → 纯转发;见 @/lib/kling/proxy 文件头)。
        if (isKlingVideoModel(String(vbody.model ?? ''))) {
            return handleKlingVideoSubmit(req, vbody);
        }
        return forwardToNewApi(req, vbody, path, search, cap);
    }

    // 视频轮询:seedance-cn 任务(我们记录过的)走端到端自扣轮询 + 扣费;其余走 new-api + 客户 OSS 转存。
    if (req.method === 'GET' && /^\/video\/generations\/[^/]+$/.test(path)) {
        const taskId = path.slice(path.lastIndexOf('/') + 1);
        if (await isSeedanceCnTask(taskId)) return handleSeedanceVideoPoll(req, taskId);
        if (await isKlingVideoTask(taskId)) return handleKlingVideoPoll(req, taskId);
        return handleVideoPoll(req, path, search);
    }

    // 任务查询别名:GET /v1/tasks/{id}(kling 上游文档提供的第二条轮询路径)。
    // 只拦我们记录过的 kling 任务;其余原样透传 new-api(维持既有行为)。
    if (req.method === 'GET' && /^\/tasks\/[^/]+$/.test(path)) {
        const taskId = path.slice(path.lastIndexOf('/') + 1);
        if (await isKlingVideoTask(taskId)) return handleKlingVideoPoll(req, taskId);
    }

    // 机器可读模型目录(OpenRouter /api/v1/models 模式):GET /models 的上游列表
    // (per-token 过滤)每条追加 `silkroadai` 命名空间元数据(价格/模态/厂商)。
    // OpenAI SDK 忽略未知字段;增强 best-effort,任何失败原样透传。
    if (path === '/models' && req.method === 'GET') {
        return handleModelsEnriched(req, search, cap);
    }

    // Anthropic 原生 /messages POST:流式走「持头转发」(假 200 → 真错误码 + failover
    // 重试 + 失败流自动退款,2026-07-29 根治件①②);非流式在 handler 内与原透传等价。
    if (path === '/messages' && req.method === 'POST') {
        return handleAnthropicMessages(req, path, search, cap);
    }

    // Responses 面 POST:请求体守门(OpenAIResponsesRequest 同样会对负数 uint 抛 500,
    // 实测 `max_output_tokens:-1` → 500 unmarshal)。守门要先读体 —— capture 打开时
    // forwardToNewApi 的透传分支本来就 buffer,这里读完直接把串交给它,不重复读。
    if (path === '/responses' && req.method === 'POST') {
        const raw = await req.text();
        const g = guardRawBody(raw, RESPONSES_SPEC);
        if (g.violation) return NextResponse.json(violationBody(g.violation), { status: 400 });
        if (cap) recordRequestBody(cap, raw, g.model, g.streamed); // 记【原始】输入
        return forwardToNewApi(req, null, path, search, cap, g.body, /* failoverOn5xx */ true);
    }

    // 其他路径(/embeddings …)全部透传
    return forwardToNewApi(req, null, path, search, cap);
}

/** GET /v1/models 拦截:透传上游列表 + 逐条附加 silkroadai 元数据(见 machine-catalog.ts)。
 *  上游非 2xx / 非 JSON → 原样透传;增强链(目录 DB / 档次解析 / 形状)任何失败 →
 *  原字节回退,绝不打断请求。 */
async function handleModelsEnriched(req: NextRequest, search: string, cap: CaptureCtx | null): Promise<NextResponse> {
    const upstream = await fetch(`${NEWAPI_BASE_URL}/v1/models${search}`, {
        method: 'GET',
        headers: forwardHeaders(req),
    });
    const ct = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !ct.includes('application/json')) {
        return cap ? captureResponse(cap, upstream) : passthroughResponse(upstream);
    }
    const text = await upstream.text();
    let json: JsonRecord | null = null;
    try {
        json = JSON.parse(text) as JsonRecord;
    } catch {
        /* content-type 撒谎(非 JSON 实体)→ 下面重建原响应走标准 capture/passthrough */
    }
    if (!json) {
        const rebuilt = new Response(text, { status: upstream.status, headers: upstream.headers });
        return cap ? captureResponse(cap, rebuilt) : passthroughResponse(rebuilt);
    }
    // 上游头逐条保留(x-oneapi-request-id 是排查链路的关键头,不能只在回退路径有),
    // strip 集剥掉会撒谎的;两条出口(增强/回退)头行为一致。
    const headers = new Headers();
    upstream.headers.forEach((v, k) => {
        if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) headers.set(k, v);
    });
    try {
        // 2.5s 钟:portal DB 慢/挂时别让 /models(纯透传时代零 DB)跟着 Prisma
        // 连接超时陪跑十几秒 —— 到点放弃增强走回退。
        const [meta, tier] = await withDeadline(
            Promise.all([loadCatalogMeta(), resolveTierFromAuthHeader(req.headers.get('authorization'))]),
            MODELS_ENRICH_DEADLINE_MS,
        );
        const enriched = enrichModelList(json, tier, meta);
        if (cap) captureJsonResponse(cap, 200, enriched);
        headers.set('content-type', 'application/json');
        headers.set('X-Silkroadai-Enriched', 'models');
        return new NextResponse(JSON.stringify(enriched), { status: upstream.status, headers });
    } catch (err) {
        console.warn('[models-enrich] enrichment failed, passthrough', {
            err: err instanceof Error ? err.message : String(err),
        });
        if (cap) captureJsonResponse(cap, upstream.status, json); // 回退也记日志(与纯透传时代等价)
        return new NextResponse(text, { status: upstream.status, headers });
    }
}

/** 目录增强的整体截止钟(loadCatalogMeta + 档次反查合起来)。 */
const MODELS_ENRICH_DEADLINE_MS = 2_500;

async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            p,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`deadline ${ms}ms exceeded`)), ms);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
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
/** 浏览器直连 OpenAI 兼容接口时会先发 CORS 预检。透传给 new-api,
 * 复用它现有的 Access-Control-* 策略,与 /v1beta/* 保持一致。 */
export async function OPTIONS(req: NextRequest, ctx: RouteContext) {
    return handleRequest(req, ctx.params);
}
