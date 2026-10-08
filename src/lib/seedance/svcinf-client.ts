/**
 * service-inference.ai 视频线共用 client(2026-09-22 抽出)。
 *
 * 两条线共用同一套上游协议:
 *  - 「火山」渠道(volc-adapter.ts):`/v2/video/generate` + `/v2/video/tasks/{id}`,四档 doubao-seedance
 *  - 国内版 seedance-2-5 的 480p 单档(cn-adapter.ts):`/v1/video/generate` + `/v1/video/tasks/{id}`
 *    (operator 指定 /v1;实测 /v1 与 /v2 信封一致,/v1 直传 URL 参考图也可用,只是不经 `preparing`)
 * 两者只差 base / key / API 版本 / 模型名,提交与轮询的信封、错误拆包、失败原因脱敏完全一样 ——
 * 抽到这里,volc / cn 两个适配器各自只做「对客 body ↔ 上游 body」的翻译。
 *
 * 上游契约实测要点(2026-09-22,详见 volc-adapter.ts 头注):
 *  - 提交 `{ task: { id: "mvt-…", status } }`;轮询 `{ task: { …, metadata: <火山方舟原生任务体> } }`
 *  - 状态 preparing / pending / processing / completed / failed;失败原因 `task.error` 是字符串
 *  - 错误信封 `{error:{message,type:'proxy_error'},request_id}`,方舟原错以**转义且常被截断**的 JSON 嵌在 message 里
 *  - 无取消端点
 */
import 'server-only';
import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { passthroughUpstreamError, sanitizeUpstreamText } from './upstream-error';

export type SvcinfApiVersion = 'v1' | 'v2';

export interface SvcinfConfig {
    base: string;
    key: string;
    /** `/v1` 或 `/v2`(路径前缀;信封相同)。 */
    api: SvcinfApiVersion;
}

export const SVCINF_DEFAULT_BASE = 'https://model.service-inference.ai';

/** 上游 key 前缀(service-inference.ai 发的 key 形态)。 */
export const SVCINF_KEY_PREFIX = 'sk-inf-';

function errJson(type: string, status: number, code: string, message: string, category?: string) {
    return NextResponse.json({ error: { code, message, type, ...(category ? { category } : {}) } }, { status });
}

/** 对客用的火山方舟形任务号前缀。 */
export const ARK_TASK_ID_PREFIX = 'cgt-';

/**
 * 自造一个火山方舟形任务号 `cgt-YYYYMMDDHHMMSS-xxxxx`(北京时钟 + 5 位小写字母数字),
 * 形态与火山官方一致(cgt- 前缀 + 14 位时间戳 + 5 位后缀),按完整正则校验也过。
 * 与上游任何号无关联(不带上游号后缀,不泄露上游身份)。碰撞概率可忽略(秒级 + 36^5)。
 */
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export function makeArkTaskId(): string {
    const d = new Date(Date.now() + 8 * 3600 * 1000); // 北京时钟(火山号用北京时间)
    const p = (n: number) => String(n).padStart(2, '0');
    const ts = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
    const suffix = Array.from(randomBytes(5), (b) => ID_ALPHABET[b % 36]).join('');
    return `${ARK_TASK_ID_PREFIX}${ts}-${suffix}`;
}

/** 上游受理号形态(唯一可轮询句柄)。 */
export function isSvcinfTaskId(v: unknown): v is string {
    return typeof v === 'string' && v.startsWith('mvt-');
}

/** 火山原生任务号的形态(方舟 id)。轮询侧用它判日志里的 metadata.id 落没落方舟。 */
function isArkTaskId(v: unknown): v is string {
    return typeof v === 'string' && v.startsWith(ARK_TASK_ID_PREFIX);
}

/**
 * 上游错误体 → 拆出方舟原始报错后再交 passthroughUpstreamError 脱敏 + 分类。
 *
 * 上游把方舟原错层层包进 message(实测原文):
 *   {"error":{"message":"Failed to submit video generation job: Upstream submit failed (400):
 *     {\"code\":\"fail_to_fetch_task\",\"message\":\"{\\\"error\\\":{\\\"code\\\":\\\"InvalidParameter\\\",
 *     \\\"message\\\":\\\"the parameter duration specified in the request is not valid …","type":"proxy_error"},…}
 * 且**内层常被截断**(没有闭合引号/括号)→ 不能靠 JSON.parse 逐层解;改为取最内一个
 * `"message":"` 之后的文本 + 最内一个非外壳的 `"code"`,再去转义、去尾部残渣。
 * 解不出(非嵌套的普通报错,如 `Task not found` / `Model 'x' is not available …`)则原样返回。
 */
export function unwrapUpstreamError(text: string): string {
    let j: Record<string, unknown> | null;
    try {
        j = JSON.parse(text) as Record<string, unknown>;
    } catch {
        return text;
    }
    const errObj = j?.error as Record<string, unknown> | string | undefined;
    const msg =
        typeof errObj === 'object' && errObj && typeof errObj.message === 'string'
            ? errObj.message
            : typeof errObj === 'string'
              ? errObj
              : typeof j?.message === 'string'
                ? j.message
                : '';
    if (!msg) return text;
    // 只有内嵌了 JSON 的才需要拆;普通一句话原样交给脱敏
    if (!/\\*"message\\*"\s*:/.test(msg)) return text;

    let inner = msg;
    const msgRe = /\\*"message\\*"\s*:\s*\\*"/g;
    let last: RegExpExecArray | null = null;
    for (let m = msgRe.exec(inner); m; m = msgRe.exec(inner)) last = m;
    if (last) inner = inner.slice(last.index + last[0].length);
    inner = inner
        .replace(/\\\\"/g, '"')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .replace(/[\\"}\]\s]+$/, '')
        .trim();

    let code = '';
    const codeRe = /\\*"code\\*"\s*:\s*\\*"([A-Za-z0-9_.]+)\\*"/g;
    for (let m = codeRe.exec(msg); m; m = codeRe.exec(msg)) {
        if (m[1] !== 'fail_to_fetch_task') code = m[1];
    }
    // 方舟错误码并进 message(passthroughUpstreamError 只透 message):客户看到 `InvalidParameter: …` 与火山官方一致。
    return JSON.stringify({ error: { code: code || undefined, message: code ? `${code}: ${inner}` : inner } });
}

/**
 * 失败任务的 `task.error` 字符串 → 对客文案。
 * 实测原文形如:
 *   `Reference material @Image1 could not be prepared: [Failed to download media from the provided URL.
 *    Please check if the link is accessible.] tos: request error: Message=fetch object return,
 *    RequestID=c9a5…, EC=`
 * 剥掉 TOS 内部残渣(`tos: request error: …` 整段)、方括号包装,再走 #271 通用脱敏(保留素材编号
 * `@Image1` 这类客户自己写的定位信息 —— 那不是泄露,是可操作细节)。
 */
function cleanTaskError(raw: string): string {
    const s = raw
        .replace(/\s*tos:\s*request error:.*$/i, '')
        .replace(/\bRequestID=\S+/gi, '')
        .replace(/\bEC=\S*/g, '')
        .replace(/\[([^\]]*)\]/g, '$1')
        .replace(/[\s,]+$/, '')
        .trim();
    return sanitizeUpstreamText(s, { keepOpaqueIds: true });
}

function mapStatus(s: unknown): 'queued' | 'in_progress' | 'completed' | 'failed' {
    const x = String(s || '').toLowerCase();
    if (['completed', 'success', 'succeeded'].includes(x)) return 'completed';
    if (['failed', 'error', 'cancelled', 'canceled', 'expired'].includes(x)) return 'failed';
    // preparing = 素材上传中(上游任务还没建);pending = 已提交排队。两者对客都是「排队中」。
    if (['preparing', 'pending', 'queued'].includes(x)) return 'queued';
    return 'in_progress';
}

export interface SvcinfSubmitResult {
    ok: true;
    /** 上游受理号(mvt-…)。 */
    taskId: string;
}
export interface SvcinfSubmitFailure {
    ok: false;
    /** 已构造好的对客错误响应(状态码 / 分类 / 脱敏文案)。 */
    res: NextResponse;
}

/**
 * 提交(上游 body 已由调用方翻译好)。上游原始报错体只落日志;对客透传方舟原文(仅剥身份标记,#271)。
 * @param tag  日志前缀 + 错误 type(如 'volc-adapter' / 'seedance-cn-adapter')
 */
export async function submitSvcinfTask(
    cfg: SvcinfConfig,
    upstreamBody: Record<string, unknown>,
    tag: { log: string; errType: string; model?: string },
): Promise<SvcinfSubmitResult | SvcinfSubmitFailure> {
    const fail = (status: number, code: string, message: string, category?: string): SvcinfSubmitFailure => ({
        ok: false,
        res: errJson(tag.errType, status, code, message, category),
    });
    let upstream: Response;
    try {
        upstream = await fetch(`${cfg.base}/${cfg.api}/video/generate`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(upstreamBody),
            signal: AbortSignal.timeout(30000),
        });
    } catch (e) {
        console.warn(`[${tag.log}] submit unreachable`, { err: String(e) });
        return fail(502, 'upstream_unreachable', 'upstream temporarily unavailable, please retry');
    }
    const text = await upstream.text();
    let j: { task?: { id?: string }; id?: string } | null;
    try {
        j = JSON.parse(text) as { task?: { id?: string }; id?: string };
    } catch {
        j = null;
    }
    const taskId = j?.task?.id ?? j?.id;
    if (!upstream.ok || !taskId) {
        const cls = passthroughUpstreamError(unwrapUpstreamError(text), upstream.status);
        console.warn(`[${tag.log}] submit failed`, {
            model: tag.model,
            upstream_model: upstreamBody.model,
            status: upstream.status,
            category: cls.category,
            body: text.slice(0, 2000),
        });
        return fail(upstream.status >= 400 ? upstream.status : 502, 'upstream_error', cls.message, cls.category);
    }
    return { ok: true, taskId };
}

/**
 * 取上游任务的方舟真号(metadata.id,cgt-)+ 状态 —— 样片出正片用(draft_task.id 必须是方舟真号,
 * 上游不翻译 mvt- 号,2026-10-08 实测)。网络 / 解析失败 → ok:false。
 */
export async function fetchSvcinfArkTaskId(
    cfg: SvcinfConfig,
    upstreamId: string,
    log: string,
): Promise<{ ok: true; status: string; arkId: string | null } | { ok: false }> {
    let upstream: Response;
    try {
        upstream = await fetch(`${cfg.base}/${cfg.api}/video/tasks/${encodeURIComponent(upstreamId)}`, {
            headers: { Authorization: `Bearer ${cfg.key}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(20000),
        });
    } catch (e) {
        console.warn(`[${log}] draft task lookup unreachable`, { upstreamId, err: String(e) });
        return { ok: false };
    }
    let j: Record<string, unknown> | null;
    try {
        j = JSON.parse(await upstream.text()) as Record<string, unknown>;
    } catch {
        j = null;
    }
    const task = ((j?.task && typeof j.task === 'object' ? j.task : j) ?? null) as UpstreamTask | null;
    if (!upstream.ok || !task || typeof task.status !== 'string') {
        console.warn(`[${log}] draft task lookup failed`, { upstreamId, http: upstream.status });
        return { ok: false };
    }
    const meta = (task.metadata && typeof task.metadata === 'object' ? task.metadata : {}) as Record<string, unknown>;
    const arkId = typeof meta.id === 'string' && isArkTaskId(meta.id) ? meta.id : null;
    return { ok: true, status: mapStatus(task.status), arkId };
}

/** 上游任务对象(`{task:{…}}` 信封内)。metadata = 火山方舟原生任务体(受理后才有)。 */
interface UpstreamTask {
    id?: unknown;
    status?: unknown;
    outputs?: unknown;
    error?: unknown;
    usage?: unknown;
    last_frame_url?: unknown;
    metadata?: Record<string, unknown> | null;
}

/**
 * 轮询:GET 上游任务 → 归一形 {status, video_url, last_frame_url, usage, …火山官方字段}。
 * @param clientId   对客号(回显用)
 * @param upstreamId 上游受理号 mvt-(调用方已做映射)
 */
export async function pollSvcinfTask(
    cfg: SvcinfConfig,
    clientId: string,
    upstreamId: string,
    tag: { log: string; errType: string },
): Promise<NextResponse> {
    const err = (status: number, code: string, message: string, category?: string) =>
        errJson(tag.errType, status, code, message, category);
    let upstream: Response;
    try {
        upstream = await fetch(`${cfg.base}/${cfg.api}/video/tasks/${encodeURIComponent(upstreamId)}`, {
            headers: { Authorization: `Bearer ${cfg.key}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(20000),
        });
    } catch (e) {
        console.warn(`[${tag.log}] poll unreachable`, { id: clientId, err: String(e) });
        return err(502, 'upstream_unreachable', 'upstream temporarily unavailable, please retry');
    }
    const text = await upstream.text();
    let j: Record<string, unknown> | null;
    try {
        j = JSON.parse(text) as Record<string, unknown>;
    } catch {
        j = null;
    }
    // 信封:正常是 {task:{…}};防御性也认裸任务体。
    const task = ((j?.task && typeof j.task === 'object' ? j.task : j) ?? null) as UpstreamTask | null;
    // 带 status 的任务体 = 真·任务态(即使 HTTP 非 2xx 也按任务态处理,不当不透明错误一直挂着);
    // 只有【没有可用 status 的纯错误体】(任务不存在 / 限流 / 5xx 无 body)才走报错分支。
    const bodyStatus = task && typeof task.status === 'string' && task.status ? task.status : '';
    if (!upstream.ok && !bodyStatus) {
        const cls = passthroughUpstreamError(unwrapUpstreamError(text), upstream.status);
        console.warn(`[${tag.log}] poll failed`, {
            id: clientId,
            status: upstream.status,
            category: cls.category,
            body: text.slice(0, 2000),
        });
        return err(upstream.status >= 400 ? upstream.status : 502, 'upstream_error', cls.message, cls.category);
    }
    if (!task || !bodyStatus) {
        // 2xx 但 body 解析不出 / 没有 status(不该发生)—— 当上游暂不可用,交上层降级/重试,别当成功。
        console.warn(`[${tag.log}] poll 2xx 但 body 非任务体`, { id: clientId, body: text.slice(0, 500) });
        return err(502, 'upstream_unreachable', 'upstream temporarily unavailable, please retry');
    }
    if (!upstream.ok) {
        console.warn(`[${tag.log}] poll 非2xx 但 body 带 status,按任务态处理`, {
            id: clientId,
            http: upstream.status,
            taskStatus: bodyStatus,
        });
    }
    const status = mapStatus(bodyStatus);
    const meta = (task.metadata && typeof task.metadata === 'object' ? task.metadata : {}) as Record<string, unknown>;
    const contentObj = (meta.content ?? undefined) as { video_url?: unknown; last_frame_url?: unknown } | undefined;
    // 成片:方舟原生 content.video_url(火山官方 TOS 域名)优先;缺失才兜底上游 outputs[0](同一条链)。
    const outputs = Array.isArray(task.outputs) ? task.outputs : [];
    const videoUrl =
        typeof contentObj?.video_url === 'string'
            ? contentObj.video_url
            : typeof outputs[0] === 'string'
              ? outputs[0]
              : undefined;
    const lastFrameRaw =
        typeof contentObj?.last_frame_url === 'string'
            ? contentObj.last_frame_url
            : typeof task.last_frame_url === 'string'
              ? task.last_frame_url
              : undefined;
    // 火山成功态 content 恒有 last_frame_url(无尾帧为空串)—— 上游没要尾帧时该键缺失,由我们补空串,
    // 「键缺失」和「值为空」对客户的契约校验是两回事。
    const lastFrameUrl = lastFrameRaw ?? (status === 'completed' ? '' : undefined);

    // 失败原因:task.error 是字符串(素材准备失败等);方舟侧失败也可能落在 metadata.error{code,message}。
    let rawFail = '';
    if (status === 'failed') {
        const e = task.error;
        const me = meta.error as { message?: unknown; code?: unknown } | undefined;
        if (typeof e === 'string') rawFail = e;
        else if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string')
            rawFail = (e as { message: string }).message;
        else if (me && typeof me.message === 'string')
            rawFail = typeof me.code === 'string' && me.code ? `${me.code}: ${me.message}` : me.message;
    }
    const failReason = status === 'failed' ? cleanTaskError(rawFail) || 'generation failed' : '';
    if (failReason)
        console.warn(`[${tag.log}] task failed upstream`, { id: clientId, fail_reason: failReason, raw: rawFail });

    const usage = (task.usage ?? meta.usage ?? undefined) as Record<string, unknown> | undefined;
    // 方舟真号(metadata.id)不对客 —— 客户拿到的 `id` 是我们自造的火山方舟形号;只落日志供内部对账。
    if (typeof meta.id === 'string' && meta.id) {
        console.log(`[${tag.log}] vendor task id`, {
            id: clientId,
            vendor_task_id: meta.id,
            ark: isArkTaskId(meta.id),
        });
    }
    // 上游【已推导】的元数据(metadata = 方舟原生体)—— 必须优先于我们库里存的提交参数:
    // 客户传 duration=-1(智能时长)时完成态会给模型真正选的秒数;ratio 同理。
    const upstreamMeta: Record<string, unknown> = {};
    if (typeof meta.duration === 'number') upstreamMeta.duration = meta.duration;
    if (typeof meta.ratio === 'string' && meta.ratio) upstreamMeta.ratio = meta.ratio;
    if (typeof meta.resolution === 'string' && meta.resolution) upstreamMeta.resolution = meta.resolution;
    // 火山官方字段集里客户会做契约校验的几项。
    if (typeof meta.framespersecond === 'number') upstreamMeta.framespersecond = meta.framespersecond;
    if (typeof meta.generate_audio === 'boolean') upstreamMeta.generate_audio = meta.generate_audio;
    if (typeof meta.execution_expires_after === 'number')
        upstreamMeta.execution_expires_after = meta.execution_expires_after;
    if (typeof meta.seed === 'number') upstreamMeta.seed = meta.seed;
    if (Array.isArray(meta.tools)) upstreamMeta.tools = meta.tools;
    // 样片模式(2026-10-08):上游回显 draft 布尔(方舟原生体恒有);draft_task_id 是方舟真号【不透】,
    // 对客回显用我们库里存的客户样片号(proxy submitted.draftTaskId)。
    if (typeof meta.draft === 'boolean') upstreamMeta.draft = meta.draft;
    // 2026-09 火山官方新增回显字段(实测 metadata 回显前三项;frames 上游暂未见,有则透)
    if (typeof meta.output_format === 'string' && meta.output_format) upstreamMeta.output_format = meta.output_format;
    if (typeof meta.safety_identifier === 'string' && meta.safety_identifier)
        upstreamMeta.safety_identifier = meta.safety_identifier;
    if (typeof meta.service_tier === 'string' && meta.service_tier) upstreamMeta.service_tier = meta.service_tier;
    if (typeof meta.frames === 'number') upstreamMeta.frames = meta.frames;
    // 时间戳以上游为准(受理前无 metadata → 不带,上层据此回落库值)。
    if (typeof meta.created_at === 'number') upstreamMeta.upstream_created_at = meta.created_at;
    if (typeof meta.updated_at === 'number') upstreamMeta.upstream_updated_at = meta.updated_at;
    if (lastFrameUrl !== undefined) upstreamMeta.last_frame_url = lastFrameUrl;

    return NextResponse.json(
        {
            id: clientId,
            task_id: clientId,
            object: 'video',
            status,
            progress: status === 'completed' || status === 'failed' ? 100 : 50,
            video_url: videoUrl,
            url: videoUrl,
            fail_reason: failReason || undefined,
            usage: status === 'completed' ? usage : undefined,
            ...upstreamMeta,
        },
        { status: 200 },
    );
}
