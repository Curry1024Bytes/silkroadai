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
};

/** 火山/别名 model → 内部归一名;认不出的原样返回(交给后续 model_not_found)。 */
export function normalizeArkModel(model: string): string {
    return ARK_TO_INTERNAL[String(model || '').toLowerCase()] ?? model;
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
 *  火山用 asset://asset-xxx 引用素材;我们内部认 asset-xxx。返回新对象(不改原 body)。 */
export function stripAssetUri<T>(v: T): T {
    if (typeof v === 'string') {
        return (v.startsWith('asset://') ? v.slice('asset://'.length) : v) as unknown as T;
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
}

/** 组装火山方舟查询任务响应体。2026-08-06 逐字段对齐客户样例(BytePlus ModelArk 形):
 *  全字段常驻(draft/execution_expires_after/framespersecond/service_tier/tools/tool_usage),
 *  error 恒为 {code,message} 对象(成功/进行中 = 空串,非 null —— 客户解析器按对象取值);
 *  ratio/seed/generate_audio 从 task 行回显,存量 NULL 行用缺省(16:9 / 0 / true)。 */
export function buildArkTaskResponse(inp: ArkTaskResponseInput): Record<string, unknown> {
    const nowSec = Math.floor(Date.now() / 1000);
    const base: Record<string, unknown> = {
        id: inp.taskId,
        model: arkModelEcho(inp.internalModel),
        status: inp.status,
        created_at: Math.floor(inp.createdAt.getTime() / 1000),
        updated_at: nowSec,
        draft: false,
        execution_expires_after: 0,
        framespersecond: 0,
        service_tier: '',
        tools: null,
        ratio: inp.ratio || '16:9',
        seed: inp.seed != null ? Number(inp.seed) : 0,
        generate_audio: inp.generateAudio ?? true,
    };
    if (inp.resolution) base.resolution = inp.resolution;
    if (inp.duration != null) base.duration = inp.duration;

    if (inp.status === 'succeeded') {
        const content: Record<string, unknown> = {};
        if (inp.videoUrl) content.video_url = inp.videoUrl;
        if (inp.lastFrameUrl) content.last_frame_url = inp.lastFrameUrl;
        base.content = content;
        if (inp.usage) {
            base.usage = {
                completion_tokens: inp.usage.completion_tokens ?? inp.usage.total_tokens ?? 0,
                tool_usage: { web_search: 0 },
                total_tokens: inp.usage.total_tokens ?? inp.usage.completion_tokens ?? 0,
            };
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
