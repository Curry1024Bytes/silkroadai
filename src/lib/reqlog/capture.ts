/**
 * 请求/响应捕获管道(数据存储 Phase 1 第②步)。
 *
 * 在 portal `/v1/*` proxy(`src/app/v1/[...path]/route.ts`)单点把客户每次
 * 调用的请求体 + 响应体 + 元数据落库:元数据 → PG `RequestLog`;大体 → 私有
 * R2 log bucket(`src/lib/r2/log-store.ts`)。
 *
 * ── 最高约束(brief §6)──
 * 1. 开关 off:`shouldCapture()` 返 false → `beginCapture` 返 null → proxy 走
 *    与今天【字节级一致】的路径(不生成 request_id、不解析 user、不 buffer、不 tee)。
 * 2. best-effort:开关 on 时,捕获任何环节(身份解析 / tee / R2 put / PG insert)
 *    抛错 → catch + warn,客户请求【照常成功】。捕获绝不冒泡到客户路径。
 * 3. 不阻塞:写存一律 fire-and-forget(`after()`),不在客户响应关键路径 await。
 *
 * ── 流式 tee(brief §5.2)──
 * 用手写的 pull-based ReadableStream 包上游 body:每个 chunk 原样 enqueue 给客户
 * (零延迟、不改字节、不破坏 SSE 分块),同时累积到内存;流正常结束 / 客户端
 * cancel / 上游 read 错误都 resolve 一个 `done` promise,`after()` 回调 await 它
 * 后组装完整响应体异步写存。**不用 `ReadableStream.tee()`**(其两路 cancel 语义
 * 会让"客户断开"把上游也带断,丢失尾部 usage,brief §5.2 明确禁止)。
 *
 * Server-only + env 懒读(镜像 log-store.ts):module load 不读 env。
 */
import 'server-only';
import { randomUUID } from 'node:crypto';
import { after, NextResponse, type NextRequest } from 'next/server';
import { isLogStoreConfigured, putLogObject, reqlogInputKey, reqlogOutputKey } from '@/lib/r2/log-store';

// 注:`@/lib/db`(prisma)与 `./identity` 在 finalizeCapture 里【懒加载】,不在
// 模块顶层 import —— 这样 proxy route 引用本模块时不会把 prisma 拉进 off-path 的
// 模块图,捕获真正落盘时才加载(也让现有 proxy 测试 mock oss/store 的隔离不被打破)。

/** 本步捕获实现版本(第①步 schema 默认 0;第②步起写 1)。 */
export const CAPTURE_VERSION = 1;

/** 累积响应体的内存软上限(env `REQUEST_LOGGING_MAX_OUTPUT_BYTES` 可调)。
 *  超过则停止累积(仍原样转发给客户),out.json 记已累积部分 + error 标记 —
 *  防超大流式响应把内存撑爆。 */
const DEFAULT_MAX_ACCUM_BYTES = 25 * 1024 * 1024;

/** 保留【请求体】的内存上限(env `REQUEST_LOGGING_MAX_INPUT_BYTES` 可调)。
 *  超过则不攥住 body 字符串(不写 R2、in_r2_key=null),但 input_bytes / model /
 *  usage 等元数据照常入库 —— 日志少一份原文,服务不掉。
 *  2026-08-15 事故:客户把 /v1 打在 apex(Caddy 未分流)全落网站单实例,
 *  请求体实测到 18.6MB,而当时【请求侧完全没有上限】(只有响应侧的 25MB),
 *  背压上限 100 个在途 × 数 MB 就把 4GB 堆打满 → 每 ~10 分钟 OOM 一次。
 *  2MB 足够覆盖正常文本 LLM 调用;超过的基本是内联图/大附件,原文价值低。 */
const DEFAULT_MAX_INPUT_BYTES = 2 * 1024 * 1024;

/** 读一个"字节上限"类 env:未配 / 非法 / <1 → 回默认值。 */
function byteLimitFromEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw == null || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return Math.floor(n);
}

function maxAccumBytes(): number {
    return byteLimitFromEnv('REQUEST_LOGGING_MAX_OUTPUT_BYTES', DEFAULT_MAX_ACCUM_BYTES);
}

function maxInputBytes(): number {
    return byteLimitFromEnv('REQUEST_LOGGING_MAX_INPUT_BYTES', DEFAULT_MAX_INPUT_BYTES);
}

/** 在途写存(finalize)背压上限的默认值(env `REQUEST_LOGGING_MAX_PENDING`
 *  可调)。R2 变慢 / 断线时 finalize 会堆积,每个都攥着完整请求+响应体 —
 *  2026-07-28 事故:单客户 opus-5 洪峰(45k 请求/20min,请求体数 MB)把
 *  smithy put 队列堆到 2,700+,portal 进程 4.5G RES + GC 打满 → 全站超时。
 *  超上限时 beginCapture 直接返 null(不 buffer、不排队),丢日志保服务。 */
const DEFAULT_MAX_PENDING_FINALIZE = 100;

function maxPendingFinalize(): number {
    const raw = process.env.REQUEST_LOGGING_MAX_PENDING;
    if (raw == null || raw === '') return DEFAULT_MAX_PENDING_FINALIZE;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_PENDING_FINALIZE;
    return Math.floor(n);
}

let __droppedCaptures = 0;

/** 丢弃计一次数 + 限频 warn(首个 + 每 500 个),不刷爆日志。 */
function noteDroppedCapture(): void {
    __droppedCaptures++;
    if (__droppedCaptures === 1 || __droppedCaptures % 500 === 0) {
        console.warn(
            `[reqlog] finalize backlog full (${__pending.size} pending, limit ${maxPendingFinalize()}) — ` +
                `dropping capture, request unaffected (total dropped: ${__droppedCaptures})`,
        );
    }
}

/** 不往客户端回传的响应头(body 已被重新分块时这些头会撒谎,与 route.ts 对齐)。 */
const STRIP_RESPONSE_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection']);

function envOn(): boolean {
    return process.env.REQUEST_LOGGING === 'on';
}

function sampleRate(): number {
    const raw = process.env.REQUEST_LOGGING_SAMPLE_RATE;
    if (raw == null || raw === '') return 1;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 1;
    return Math.min(1, Math.max(0, n));
}

/**
 * 总开关(brief §7,语义锁死):
 *   REQUEST_LOGGING==='on'  &&  isLogStoreConfigured()  &&  Math.random() < sampleRate
 * env 未配 = off(fail-closed);log bucket 未配 = 视为 off;采样未命中 = 完全不捕获。
 * 短路顺序保证 off 时不触 isLogStoreConfigured / random。
 */
export function shouldCapture(): boolean {
    if (!envOn()) return false;
    if (!isLogStoreConfigured()) return false;
    return Math.random() < sampleRate();
}

/**
 * 媒体生成(生图 / 生视频)捕获跳过开关(2026-06-15)。
 * `REQUEST_LOGGING_SKIP_MEDIA` 真值 → 只捕获文本 LLM 请求,跳过生图/生视频
 * (它们体积大、噪声多、b64 响应撑存储)。默认未配 = 不跳(捕获全部,向后兼容)。
 * operator "看时机再开图片" = 删掉该 env / 设 off 即可,无需改代码。
 */
export function isMediaCaptureSkipped(): boolean {
    const v = (process.env.REQUEST_LOGGING_SKIP_MEDIA || '').toLowerCase();
    return v === 'on' || v === 'true' || v === '1' || v === 'yes';
}

/** 路径属于媒体生成(生图 / 生视频)—— DALL·E 图片接口 + 视频生成。chat 形态的
 *  Gemini 生图模型按 model 判定(在 route.ts,那里才有 model),不在此。 */
export function isMediaGenPath(path: string): boolean {
    return path === '/images' || path === '/video' || path.startsWith('/images/') || path.startsWith('/video/');
}

export interface CaptureCtx {
    id: string;
    startedAt: number;
    createdAt: Date;
    method: string;
    path: string;
    authHeader: string | null;
    // 请求(call site 填)
    requestBody: string | null;
    inputBytes: number;
    model: string | null;
    streamedRequested: boolean;
    // 响应
    statusCode: number | null;
    responseContentType: string | null;
    chunks: Uint8Array[]; // 流式累积
    accumBytes: number;
    truncated: boolean;
    responseBodyString: string | null; // 非流式(C/D)直填
    imageRefs: string[]; // output_image_refs(生图响应的公网 URL)
    incomplete: boolean;
    errorParts: string[];
    finalized: boolean;
}

/** 开关激活才创建 ctx;off 返 null(零成本:不生成 request_id、不查 DB)。
 *  text-only 模式(REQUEST_LOGGING_SKIP_MEDIA)下,生图/生视频路径直接不捕获;
 *  chat 形态的 Gemini 生图(/chat/completions + 图片模型)由 route.ts 按 model 跳过。 */
export function beginCapture(req: NextRequest, path: string): CaptureCtx | null {
    if (!shouldCapture()) return null;
    if (isMediaCaptureSkipped() && isMediaGenPath(path)) return null;
    // 背压:在途写存堆积(R2 慢 / 断)时丢弃本次捕获 — 零 buffer、零排队,
    // 客户请求走与开关 off 一致的 passthrough 路径。
    if (__pending.size >= maxPendingFinalize()) {
        noteDroppedCapture();
        return null;
    }
    const startedAt = Date.now();
    return {
        id: randomUUID(),
        startedAt,
        createdAt: new Date(startedAt),
        method: req.method,
        path,
        authHeader: req.headers.get('authorization'),
        requestBody: null,
        inputBytes: 0,
        model: null,
        streamedRequested: false,
        statusCode: null,
        responseContentType: null,
        chunks: [],
        accumBytes: 0,
        truncated: false,
        responseBodyString: null,
        imageRefs: [],
        incomplete: false,
        errorParts: [],
        finalized: false,
    };
}

/** 记请求体(原始字符串)+ model + 是否流式请求。
 *  超 `maxInputBytes()` 的大体【不保留原文】(requestBody=null → 不写 R2、
 *  in_r2_key 落 null),只留真实字节数 + `in-too-large` 标记 —— 元数据行照常入库,
 *  背压队列里每个 ctx 攥住的内存因此有确定上界。见 DEFAULT_MAX_INPUT_BYTES 注释。 */
export function recordRequestBody(cap: CaptureCtx, raw: string, model: string | null, streamed: boolean): void {
    const bytes = Buffer.byteLength(raw);
    const limit = maxInputBytes();
    if (bytes > limit) {
        cap.requestBody = null;
        cap.errorParts.push(`in-too-large:${bytes}>${limit}`);
    } else {
        cap.requestBody = raw;
    }
    cap.inputBytes = bytes;
    if (model) cap.model = model;
    cap.streamedRequested = streamed;
}

/** 从原始 JSON 请求体(出口 B buffer 后)best-effort 解出 model + stream 标志。 */
export function parseModelAndStream(raw: string): { model: string | null; streamed: boolean } {
    try {
        const o = JSON.parse(raw) as Record<string, unknown>;
        return {
            model: typeof o.model === 'string' ? o.model : null,
            streamed: o.stream === true,
        };
    } catch {
        return { model: null, streamed: false };
    }
}

function responseHeaders(upstream: Response): Headers {
    const headers = new Headers();
    upstream.headers.forEach((value, key) => {
        if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) headers.set(key, value);
    });
    return headers;
}

function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/**
 * 捕获 A/B passthrough 响应(流式 + 非流式统一):tee upstream.body 给客户,
 * 累积到 ctx,流结束后 after() 异步写存。替代 route.ts 的 passthroughResponse
 * (仅在捕获激活时)。
 */
export function captureResponse(cap: CaptureCtx, upstream: Response): NextResponse {
    const headers = responseHeaders(upstream);
    cap.statusCode = upstream.status;
    cap.responseContentType = upstream.headers.get('content-type');

    if (!upstream.body) {
        // 无 body(204 等):立即写存(out 空)
        scheduleFinalize(cap);
        return new NextResponse(null, { status: upstream.status, headers });
    }

    const { stream, done } = teeStream(cap, upstream.body);
    scheduleFinalize(cap, done);
    return new NextResponse(stream, { status: upstream.status, headers });
}

/** 捕获 C/D 自组装的非流式 JSON 响应:直填完整响应体,立即调度写存。 */
export function captureJsonResponse(cap: CaptureCtx, status: number, bodyObj: unknown, imageRefs: string[] = []): void {
    cap.statusCode = status;
    cap.responseContentType = 'application/json';
    cap.responseBodyString = JSON.stringify(bodyObj);
    cap.imageRefs = imageRefs;
    scheduleFinalize(cap);
}

/** pull-based tee:enqueue 给客户 + 累积;done 在 close/cancel/error 各 resolve 一次。 */
function teeStream(cap: CaptureCtx, body: ReadableStream<Uint8Array>): { stream: ReadableStream; done: Promise<void> } {
    const reader = body.getReader();
    const accumLimit = maxAccumBytes(); // 每条流读一次 env,不在 per-chunk 热路径上读
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => {
        resolveDone = r;
    });

    const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
            let res: ReadableStreamReadResult<Uint8Array>;
            try {
                res = await reader.read();
            } catch (e) {
                // 上游读错:把已收到部分当 incomplete,error 给客户(它本来就该断)
                cap.incomplete = true;
                cap.errorParts.push('upstream-read:' + errMsg(e));
                controller.error(e);
                resolveDone();
                return;
            }
            if (res.done) {
                controller.close();
                resolveDone();
                return;
            }
            // 先累积(best-effort,带软上限),再原样转发 — 累积异常绝不影响出流
            try {
                if (!cap.truncated) {
                    cap.accumBytes += res.value.byteLength;
                    if (cap.accumBytes > accumLimit) {
                        cap.truncated = true;
                        cap.errorParts.push('out-truncated');
                    } else {
                        cap.chunks.push(res.value);
                    }
                }
            } catch (e) {
                cap.errorParts.push('accum:' + errMsg(e));
            }
            controller.enqueue(res.value);
        },
        async cancel(reason) {
            // 客户端断开:存已收到部分 + incomplete;释放上游流不泄漏
            cap.incomplete = true;
            try {
                await reader.cancel(reason);
            } catch {
                /* 上游 cancel 失败无所谓,已尽力释放 */
            }
            resolveDone();
        },
    });

    return { stream, done };
}

// ── 异步写存调度(fire-and-forget,测试可 flush)──
//
// 用 `after()`(next/server,App Router 推荐):响应发完后跑回调。流式场景
// 回调内 await `done`(此时累积已完整)。`after()` 在无请求上下文(单测直调
// route handler)会抛 → catch 后直接 fire,两条路都把 promise 进 __pending
// 供测试 flush。
const __pending = new Set<Promise<unknown>>();

function track<T>(p: Promise<T>): Promise<T> {
    __pending.add(p);
    void p.finally(() => __pending.delete(p));
    return p;
}

function scheduleFinalize(cap: CaptureCtx, doneP?: Promise<void>): void {
    const run = async (): Promise<void> => {
        try {
            if (doneP) await doneP;
            if (cap.finalized) return;
            cap.finalized = true;
            await finalizeCapture(cap);
        } catch (e) {
            console.warn('[reqlog] capture schedule failed', e);
        }
    };
    try {
        after(() => track(run()));
    } catch {
        track(run());
    }
}

/** 测试钩子:await 所有在途写存。NOT 走 index 导出,只在 vitest 里全路径引用。 */
export async function __flushReqlogForTest(): Promise<void> {
    // finalize 不会再产生新 pending(无嵌套调度),一轮 settle 即清空
    while (__pending.size > 0) {
        await Promise.allSettled([...__pending]);
    }
}

/** 测试钩子:重置背压丢弃计数(warn 限频依赖它)。 */
export function __resetReqlogBackpressureForTest(): void {
    __droppedCaptures = 0;
}

function decodeChunks(chunks: Uint8Array[]): string {
    if (chunks.length === 0) return '';
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * 从响应体 best-effort 解 usage(brief §5.2):
 * - 非流式 JSON:`usage.{prompt_tokens|input_tokens, completion_tokens|output_tokens}`
 * - SSE(OpenAI chat 末尾 chunk / responses `response.completed` / Anthropic
 *   `message_start`+`message_delta`):逐行扫 `data:` JSON,取见过的最大 input/output。
 * 解不出 → null(不阻断、不报错)。
 */
export function parseUsage(
    body: string,
    contentType: string | null,
): { inputTokens: number | null; outputTokens: number | null } {
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    const setMax = (cur: number | null, v: unknown): number | null => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return cur;
        return cur == null ? v : Math.max(cur, v);
    };

    const isSse = (contentType ?? '').includes('text/event-stream') || /(^|\n)\s*data:/.test(body);
    const objs: Array<Record<string, unknown>> = [];
    if (isSse) {
        for (const line of body.split('\n')) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const payload = t.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
                objs.push(JSON.parse(payload) as Record<string, unknown>);
            } catch {
                /* 非 JSON data 行跳过 */
            }
        }
    } else {
        try {
            objs.push(JSON.parse(body) as Record<string, unknown>);
        } catch {
            /* 非 JSON 响应(可能是错误页 / 二进制)→ 无 usage */
        }
    }

    for (const o of objs) {
        // openai chat / 非流式;responses 在 .response.usage;anthropic message_start 在 .message.usage
        const resp = o.response as Record<string, unknown> | undefined;
        const msg = o.message as Record<string, unknown> | undefined;
        const u = (o.usage ?? resp?.usage ?? msg?.usage) as Record<string, unknown> | undefined;
        if (u) {
            inputTokens = setMax(inputTokens, u.prompt_tokens ?? u.input_tokens);
            outputTokens = setMax(outputTokens, u.completion_tokens ?? u.output_tokens);
        }
    }
    return { inputTokens, outputTokens };
}

/** 写 R2(in/out)+ PG(RequestLog 一行)。永不抛(全程 try/catch + warn)。 */
async function finalizeCapture(cap: CaptureCtx): Promise<void> {
    try {
        // 懒加载 prisma + identity(见文件头注释:off-path 不拉 prisma)
        const [{ prisma }, { resolveLogIdentity }] = await Promise.all([import('@/lib/db'), import('./identity')]);

        const outBody = cap.responseBodyString ?? decodeChunks(cap.chunks);
        cap.chunks = []; // 解码完立刻放掉原始 chunk 引用,排队等 R2 时少攥一份内存
        const outBytes = cap.responseBodyString != null ? Buffer.byteLength(cap.responseBodyString) : cap.accumBytes;
        const usage = parseUsage(outBody, cap.responseContentType);
        const ident = await resolveLogIdentity(cap.authHeader);

        let inKeyW: string | null = null;
        let outKeyW: string | null = null;
        if (cap.requestBody != null) {
            try {
                const k = reqlogInputKey(cap.id, cap.createdAt);
                await putLogObject(k, cap.requestBody);
                inKeyW = k;
            } catch (e) {
                cap.errorParts.push('r2-in:' + errMsg(e));
            }
        }
        try {
            const k = reqlogOutputKey(cap.id, cap.createdAt);
            await putLogObject(k, outBody);
            outKeyW = k;
        } catch (e) {
            cap.errorParts.push('r2-out:' + errMsg(e));
        }

        const statusOk = cap.statusCode != null && cap.statusCode >= 200 && cap.statusCode < 300;
        const streamed = cap.streamedRequested || (cap.responseContentType ?? '').includes('text/event-stream');
        const error = cap.errorParts.length ? cap.errorParts.join('; ').slice(0, 2000) : null;

        await prisma.requestLog.create({
            data: {
                id: cap.id,
                tenant_id: ident.tenant_id,
                user_id: ident.user_id,
                token_id: ident.token_id,
                newapi_token_hash: ident.newapi_token_hash,
                path: cap.path,
                method: cap.method,
                model: cap.model,
                status_code: cap.statusCode,
                success: statusOk && !cap.incomplete,
                duration_ms: Date.now() - cap.startedAt,
                streamed,
                incomplete: cap.incomplete,
                error,
                input_tokens: usage.inputTokens,
                output_tokens: usage.outputTokens,
                input_r2_key: inKeyW,
                output_r2_key: outKeyW,
                input_bytes: cap.inputBytes,
                output_bytes: outBytes,
                input_image_r2_keys: [], // 输入图字节单独拆存留后续步(brief §3 Out)
                output_image_refs: cap.imageRefs,
                retention_expires_at: null, // 永久(operator 2026-06-13)
                capture_version: CAPTURE_VERSION,
                created_at: cap.createdAt, // 与 R2 键日期同源
            },
        });
    } catch (e) {
        console.warn('[reqlog] finalize failed', e);
    }
}
