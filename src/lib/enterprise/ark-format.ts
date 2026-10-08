/**
 * 火山方舟(Ark)视频 API 形态翻译层(2026-07-26)。
 *
 * 目标:让企业门户 /api/v3/contents/generations/tasks 对客暴露与火山方舟官方
 * (docs.volcengine.com/docs/82379)逐字一致的请求/响应形态,内部照旧翻译成
 * 我们的 submit/poll 核心。纯函数,无 IO,好测。
 *
 * 对齐要点(官方权威):
 *  - 提交成功响应仅 `{ id }`(前缀 cgt-)。
 *  - 查询响应:status ∈ queued/running/succeeded/failed/expired/cancelled;
 *    video_url 与 last_frame_url **嵌套在 content 对象内**;usage.{completion,total}_tokens;
 *    created_at/updated_at unix 秒;平铺 model/resolution/duration 等元数据。
 *  - content 数组:{type:text|image_url|audio_url, ..._url:{url}, role};
 *    url 支持 asset://<asset_id> 前缀引用素材。
 *  - model 用火山 id(doubao-seedance-2-0-260128 等)。
 */

/** 火山 model id ↔ 我们内部归一短名。key 小写匹配。 */
const ARK_TO_INTERNAL: Record<string, string> = {
    'doubao-seedance-2-0-260128': 'seedance-2-0',
    'doubao-seedance-2-0-fast-260128': 'seedance-2-0-fast',
    'doubao-seedance-2-0-mini-260615': 'seedance-2-0-mini',
    // 国内版 seedance 2.5(2026-08-07)
    'doubao-seedance-2-5-260628': 'seedance-2-5',
    'doubao-seedance-2-5': 'seedance-2-5',
    'seedance-2.5': 'seedance-2-5',
    // 常见简写别名(客户可能直接传)
    seedance2: 'seedance-2-0',
    'seedance-2.0': 'seedance-2-0',
    'doubao-seedance-2-0': 'seedance-2-0',
    // BytePlus ModelArk 形别名(2026-08-06 客户样例:海外 promax 系 = byteplus/ 前缀)
    'byteplus/seedance-2.0': 'seedance-2-0-promax',
    'byteplus/seedance-2.0-fast': 'seedance-2-0-promax-fast',
    'byteplus/seedance-2.0-mini': 'seedance-2-0-promax-mini',
    'byteplus/seedance-2.5': 'seedance-2-5-promax',
};
/** 内部短名 → 回显给客户的火山 model id(查询响应 model 字段用火山名;
 *  promax 系回显 BytePlus ModelArk 形 byteplus/…,对齐客户样例)。 */
const INTERNAL_TO_ARK: Record<string, string> = {
    'seedance-2-0': 'doubao-seedance-2-0-260128',
    'seedance-2-0-fast': 'doubao-seedance-2-0-fast-260128',
    'seedance-2-0-mini': 'doubao-seedance-2-0-mini-260615',
    'seedance-2-5': 'doubao-seedance-2-5-260628',
    'seedance-2-0-promax': 'byteplus/seedance-2.0',
    'seedance-2-0-promax-fast': 'byteplus/seedance-2.0-fast',
    'seedance-2-0-promax-mini': 'byteplus/seedance-2.0-mini',
    'seedance-2-5-promax': 'byteplus/seedance-2.5',
    // volc 渠道:对客一律回显火山原生 id(该渠道的卖点就是原生形态)
    'doubao-seedance-2.0': 'doubao-seedance-2-0-260128',
    'doubao-seedance-2.0-fast': 'doubao-seedance-2-0-fast-260128',
    'doubao-seedance-2.0-mini': 'doubao-seedance-2-0-mini-260615',
    'doubao-seedance-2.5': 'doubao-seedance-2-5-260628',
};

/**
 * 火山原生 model id → **volc 渠道**对客名(2026-08-26)。
 *
 * 同一个 `doubao-seedance-2-5-260628`,cn 客户用它调国内版、volc 客户用它调火山渠道 ——
 * 靠调用方凭据区分(见 keys.ts 的 callerHasVolc)。volc 卖的是「原生火山」,
 * 客户本来就该能直接用上游原生名,不该被迫改成我们发明的点分名。
 */
const ARK_TO_VOLC: Record<string, string> = {
    'doubao-seedance-2-0-260128': 'doubao-seedance-2.0',
    'doubao-seedance-2-0-fast-260128': 'doubao-seedance-2.0-fast',
    'doubao-seedance-2-0-mini-260615': 'doubao-seedance-2.0-mini',
    'doubao-seedance-2-5-260628': 'doubao-seedance-2.5',
};

/** 火山/别名 model → 内部归一名;认不出的原样返回(交给后续 model_not_found)。
 *  `callerIsVolc` 时优先按火山渠道解释(原生 id 直接可用)。 */
export function normalizeArkModel(model: string, callerIsVolc = false): string {
    const lower = String(model || '').toLowerCase();
    if (callerIsVolc && ARK_TO_VOLC[lower]) return ARK_TO_VOLC[lower];
    return ARK_TO_INTERNAL[lower] ?? model;
}

/** 内部名 → 火山 model id 回显;非映射项(如 -global/-promax)原样回显。 */
export function arkModelEcho(internal: string): string {
    return INTERNAL_TO_ARK[internal] ?? internal;
}

/** 我们内部状态 → 火山状态(queued/running/succeeded/failed)。 */
export function arkStatus(our: string): string {
    switch (our) {
        case 'completed':
            return 'succeeded';
        case 'in_progress':
            return 'running';
        case 'queued':
            return 'queued';
        case 'failed':
            return 'failed';
        default:
            return our;
    }
}

/** 深遍历把 body 里所有 "asset://<id>" 前缀剥成裸 <id>(resolveAssetRefs 认裸 asset-…)。
 *  火山用 asset://asset-xxx 引用素材;我们内部认 asset-xxx。返回新对象(不改原 body)。
 *  ⚠️ 前缀大小写不敏感:客户偶发传 `Asset://`(上游只认 `asset://`),这里一并剥掉。 */
export function stripAssetUri<T>(v: T): T {
    if (typeof v === 'string') {
        const m = /^asset:\/\//i.exec(v);
        return (m ? v.slice(m[0].length) : v) as unknown as T;
    }
    if (Array.isArray(v)) return v.map((x) => stripAssetUri(x)) as unknown as T;
    if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = stripAssetUri(val);
        return out as unknown as T;
    }
    return v;
}

/** fail_reason → 火山错误对象 {code,message,type}。审核类映射到火山 SensitiveContentDetected 家族。 */
export function arkFailError(reason: string | null | undefined): { code: string; message: string; type: string } {
    const r = String(reason || '').toLowerCase();
    if (r.includes('copyright') || r.includes('版权')) {
        // 版权审核拒绝(火山 output/input 版权限制),对齐火山 CopyrightViolationDetected 家族
        return {
            code: 'CopyrightViolationDetected',
            message: reason || 'The request failed because the content may be related to copyright restrictions.',
            type: 'BadRequest',
        };
    }
    if (r.includes('sensitive') || r.includes('审核') || r.includes('violat')) {
        // 无法从上游文案精确还原火山子码,统一归到 SensitiveContentDetected(HTTP 400 BadRequest)
        return {
            code: 'SensitiveContentDetected',
            message: reason || 'The request failed because the content may contain sensitive information.',
            type: 'BadRequest',
        };
    }
    return {
        code: 'InternalServiceError',
        message: reason || 'The service encountered an unexpected internal error. Please retry later.',
        type: 'InternalServerError',
    };
}

export interface ArkTaskResponseInput {
    taskId: string;
    /** 内部短名(task.model),回显时转火山名。 */
    internalModel: string;
    /** 火山状态(已翻译)。 */
    status: string;
    videoUrl?: string | null;
    lastFrameUrl?: string | null;
    usage?: { completion_tokens?: number; total_tokens?: number } | null;
    failReason?: string | null;
    /** task 行元数据(best-effort 回填火山响应)。 */
    createdAt: Date;
    resolution?: string | null;
    duration?: number | null;
    /** 提交参数回显(task 行新列,2026-08-06;存量行 NULL → 缺省)。 */
    ratio?: string | null;
    seed?: number | bigint | null;
    generateAudio?: boolean | null;
    /** BytePlus ModelArk 形(global/promax,#326 客户样例)带扩展字段;火山方舟官方形
     *  (cn,docs.volcengine.com/82379)只出官方声明字段。缺省 false = 官方形。 */
    extended?: boolean;
    /**
     * volc 渠道:上游(= 火山方舟本身)返回的**真实**元数据,原样带给客户。
     *
     * 2026-08-27 客户契约测试报障:期望 framespersecond=24 / generate_audio=true /
     * execution_expires_after=172800 / draft=false / service_tier='default',我们一个没给 ——
     * 这批字段被关在 `extended` 分支里,而 extended 只对 global/promax 为真。
     * 实测上游完成态确实返回 framespersecond / generate_audio / execution_expires_after /
     * seed / tools,是我们在出口砍掉的。
     *
     * ⚠️ 不能简单改成让 volc 也走 `extended` —— 那个分支里的值是**硬编码占位**
     * (framespersecond: 0、execution_expires_after: 0、service_tier: ''),打开了也对不上基准。
     * 必须用上游真值,上游没给的项才走火山官方默认值。
     */
    volcMeta?: VolcArkMeta | null;
    /**
     * 非 volc 渠道上游(能)带出来的元数据(2026-09-23):国内版 2.5 480p 走 service-inference.ai,
     * 它回显方舟原生体;xinhankr / intl 上游什么都不回显 → 传 null,一律走落库值 / 官方默认值。
     */
    upstreamMeta?: VolcArkMeta | null;
    /**
     * 提交时落库的回显参数(2026-09-23,火山官方查询响应新增字段):
     * 上游不回显时用它;客户没传的项(safety_identifier / tools)响应里省略,对齐官方语义。
     */
    submitted?: ArkSubmittedParams | null;
}

/** 提交参数(task 行新列,存量行 NULL)。 */
export interface ArkSubmittedParams {
    safetyIdentifier?: string | null;
    outputFormat?: string | null;
    tools?: unknown;
    /** 官方创建参数(任务超时阈值秒);客户传了就回显,否则官方默认 172800。 */
    executionExpiresAfter?: number | null;
    /** 样片模式(2026-10-08):创建时传的 draft 布尔(没传 → false);正片引用的客户样片号(没有 → 省略)。 */
    draft?: boolean | null;
    draftTaskId?: string | null;
}

/** 上游(火山方舟原生体)带出来的元数据(上游未给的项走火山官方默认值)。 */
export interface VolcArkMeta {
    framespersecond?: number | null;
    generateAudio?: boolean | null;
    executionExpiresAfter?: number | null;
    seed?: number | null;
    tools?: unknown;
    /** 上游的任务创建/更新时间(unix 秒)。上游未受理时为 0 → 回落我们的库值。 */
    createdAt?: number | null;
    updatedAt?: number | null;
    /** 上游给了就跟随(火山成功态恒有该键,无尾帧时为空串)。 */
    lastFrameUrl?: string | null;
    // 2026-09 官方新增回显字段(service-inference.ai metadata 实测有前三项;frames 暂未见)
    outputFormat?: string | null;
    safetyIdentifier?: string | null;
    serviceTier?: string | null;
    frames?: number | null;
    /** 样片模式:上游(方舟原生体)回显的 draft 布尔。 */
    draft?: boolean | null;
}

/** 火山官方默认值 —— 任务未完成时上游不返回这几项,但客户契约要求字段恒在。 */
const VOLC_DEFAULT_FPS = 24;
const VOLC_DEFAULT_EXPIRES_AFTER = 172800; // 48h
const VOLC_DEFAULT_SERVICE_TIER = 'default';
const VOLC_DEFAULT_OUTPUT_FORMAT = 'mp4';

/** 官方 `frames`(视频帧数):上游给了用上游;否则按 Seedance 惯例 24fps × 秒 + 1(1.0 时代 5s=121 / 10s=241)。
 *  时长未定(-1 智能时长且上游尚未推导)→ 省略。 */
function arkFrames(m: VolcArkMeta | null | undefined, fps: number, duration: number | null | undefined): number | null {
    if (typeof m?.frames === 'number' && m.frames > 0) return m.frames;
    if (typeof duration === 'number' && duration > 0) return fps * duration + 1;
    return null;
}

/** 客户传了的 tools 数组才回显(官方:未使用工具时不返回)。 */
function submittedTools(
    m: VolcArkMeta | null | undefined,
    sub: ArkSubmittedParams | null | undefined,
): unknown[] | null {
    if (Array.isArray(m?.tools) && m.tools.length) return m.tools;
    if (Array.isArray(sub?.tools) && sub.tools.length) return sub.tools;
    return null;
}

/** 组装查询任务响应体 —— 按渠道分形(2026-08-12):
 *  - 火山方舟官方形(cn/volc,extended=false):只出 docs.volcengine.com/82379 声明的字段集。
 *    2026-09 官方扩到 {id, model, status, content, error, created_at, updated_at, resolution, ratio, duration,
 *    usage, execution_expires_after, frames, framespersecond, generate_audio, output_format, safety_identifier,
 *    seed, service_tier, tools}(后两者客户传了才出)+ draft(官方 SDK 任务体字段,2026-10-08 起三形都出)。
 *  - BytePlus ModelArk 形(global/promax,extended=true,#326 客户样例):额外常驻
 *    draft/execution_expires_after/framespersecond/service_tier/tools/seed/generate_audio + usage.tool_usage。
 *  两形共有:error 恒为 {code,message} 对象(成功/进行中 = 空串,非 null);ratio 从 task 行回显。 */
export function buildArkTaskResponse(inp: ArkTaskResponseInput): Record<string, unknown> {
    const nowSec = Math.floor(Date.now() / 1000);
    const base: Record<string, unknown> = {
        id: inp.taskId,
        // volc:客户的契约脚本从查询响应里读 upstream_id 做「火山官方任务号格式」校验
        //(^cgt-\d{14}-[A-Za-z0-9]+$),缺了就判整轮失败(2026-08-27 客户实测反馈)。
        //
        // 值就是 inp.taskId ——#398 起对客 id 本身就是火山官方任务号,这个字段纯粹是
        // 给客户脚本的**别名**,不引入第二套号。⚠️ 绝不能填上游的 vendor_task_id:
        // 落非方舟时那是 tsk-… 形,既过不了客户正则,又泄露中间层(#271)。
        ...(inp.volcMeta ? { upstream_id: inp.taskId } : {}),
        model: arkModelEcho(inp.internalModel),
        status: inp.status,
        created_at: Math.floor(inp.createdAt.getTime() / 1000),
        updated_at: nowSec,
        ratio: inp.ratio || '16:9',
    };
    const sub = inp.submitted ?? null;
    const meta = inp.volcMeta ?? inp.upstreamMeta ?? null;
    // 2026-09 火山官方查询响应新增字段(output_format / safety_identifier / frames / tools 等):
    // 值优先级 = 上游真值 > 落库的提交参数 > 官方默认值;客户没传的 safety_identifier / tools 省略。
    const outputFormat = meta?.outputFormat || sub?.outputFormat || VOLC_DEFAULT_OUTPUT_FORMAT;
    const safetyIdentifier = meta?.safetyIdentifier || sub?.safetyIdentifier || null;
    const fps = meta?.framespersecond ?? VOLC_DEFAULT_FPS;
    const frames = arkFrames(meta, fps, inp.duration);
    const toolsEcho = submittedTools(meta, sub);
    const expiresAfter = meta?.executionExpiresAfter ?? sub?.executionExpiresAfter ?? VOLC_DEFAULT_EXPIRES_AFTER;

    // BytePlus 形专属扩展字段(火山官方形不带,否则客户白名单校验拒)。
    // 样片模式(2026-10-08,官方 SDK 任务体含 draft + draft_task_id):三形都出 draft(上游真值 > 落库 > false),
    // draft_task_id 只在正片任务上出(客户样片号,方舟真号不对客)。
    const draftEcho = meta?.draft ?? sub?.draft ?? false;
    const draftTaskId = sub?.draftTaskId || null;
    if (inp.extended) {
        base.draft = draftEcho;
        if (draftTaskId) base.draft_task_id = draftTaskId;
        base.execution_expires_after = 0;
        base.framespersecond = 0;
        base.service_tier = '';
        base.tools = toolsEcho;
        base.seed = inp.seed != null ? Number(inp.seed) : 0;
        base.generate_audio = inp.generateAudio ?? true;
        base.output_format = outputFormat;
        if (safetyIdentifier) base.safety_identifier = safetyIdentifier;
        if (frames != null) base.frames = frames;
    }
    // volc:火山官方字段集(值优先取上游真值,上游未给的走火山官方默认值)。
    if (inp.volcMeta) {
        const m = inp.volcMeta;
        base.draft = draftEcho;
        if (draftTaskId) base.draft_task_id = draftTaskId;
        base.service_tier = m.serviceTier || VOLC_DEFAULT_SERVICE_TIER;
        base.framespersecond = fps;
        base.execution_expires_after = expiresAfter;
        base.generate_audio = m.generateAudio ?? inp.generateAudio ?? true;
        base.seed = m.seed ?? (inp.seed != null ? Number(inp.seed) : 0);
        base.tools = toolsEcho ?? m.tools ?? [];
        base.output_format = outputFormat;
        if (safetyIdentifier) base.safety_identifier = safetyIdentifier;
        if (frames != null) base.frames = frames;
        // 时间戳以**上游**为准。此前用的是我们库行的 created_at + Date.now():
        //  - created_at 与上游差几秒(我们落库晚于上游受理)
        //  - updated_at 是 Date.now() → **客户每查一次就变一次**,根本不是"任务更新时间"
        // 上游未受理时返 0(running 早期),那时才回落库值。
        if (m.createdAt) base.created_at = m.createdAt;
        if (m.updatedAt) base.updated_at = m.updatedAt;
    }
    // 火山方舟官方形(cn):2026-09 官方文档把 execution_expires_after / frames / framespersecond /
    // generate_audio / output_format / safety_identifier / seed / service_tier / tools 都列进了查询响应
    // (此前我们按旧文档只出 11 个字段,客户按新文档校验就缺项)。不带 upstream_id(官方无)。
    if (!inp.extended && !inp.volcMeta) {
        const m = inp.upstreamMeta ?? null;
        base.execution_expires_after = expiresAfter;
        base.framespersecond = fps;
        base.generate_audio = m?.generateAudio ?? inp.generateAudio ?? true;
        base.seed = m?.seed ?? (inp.seed != null ? Number(inp.seed) : 0);
        base.service_tier = m?.serviceTier || VOLC_DEFAULT_SERVICE_TIER;
        base.output_format = outputFormat;
        base.draft = draftEcho;
        if (draftTaskId) base.draft_task_id = draftTaskId;
        if (safetyIdentifier) base.safety_identifier = safetyIdentifier;
        if (frames != null) base.frames = frames;
        if (toolsEcho) base.tools = toolsEcho;
        if (m?.createdAt) base.created_at = m.createdAt;
        if (m?.updatedAt) base.updated_at = m.updatedAt;
    }
    if (inp.resolution) base.resolution = inp.resolution;
    if (inp.duration != null) base.duration = inp.duration;

    if (inp.status === 'succeeded') {
        const content: Record<string, unknown> = {};
        if (inp.videoUrl) content.video_url = inp.videoUrl;
        if (inp.lastFrameUrl) content.last_frame_url = inp.lastFrameUrl;
        // volc:火山成功态 content 恒有 last_frame_url 键(无尾帧时为空串)——
        // 客户按基准比对时"键缺失"和"值为空"是两回事。
        else if (meta && meta.lastFrameUrl != null) {
            content.last_frame_url = meta.lastFrameUrl;
        }
        base.content = content;
        if (inp.usage) {
            const completion = inp.usage.completion_tokens ?? inp.usage.total_tokens ?? 0;
            const total = inp.usage.total_tokens ?? inp.usage.completion_tokens ?? 0;
            // tool_usage 是 BytePlus 形专属子字段;火山官方形只出 completion/total_tokens。
            base.usage = inp.extended
                ? { completion_tokens: completion, tool_usage: { web_search: 0 }, total_tokens: total }
                : { completion_tokens: completion, total_tokens: total };
        }
        base.error = { code: '', message: '' };
    } else if (inp.status === 'failed') {
        base.content = {};
        const e = arkFailError(inp.failReason);
        base.error = { code: e.code, message: e.message };
    } else {
        // queued / running
        base.content = {};
        base.error = { code: '', message: '' };
    }
    return base;
}

/** 火山形错误响应体(提交/参数错误用)。 */
export function arkErrorBody(code: string, message: string, type = 'invalid_request_error'): Record<string, unknown> {
    return { error: { code, message, type } };
}
