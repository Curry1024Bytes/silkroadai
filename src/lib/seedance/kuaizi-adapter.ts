/**
 * 筷子 AI 开放平台(aiopenapi.kuaizi.cn)视频 client —— 「火山」渠道的 provider 之一(2026-11-04 换回)。
 *
 * 历史:volc 渠道 2026-08-17 ~ 09-22 走筷子(本文件前身 kuaizi-adapter.ts,#484 删),09-22 ~ 11-04 走
 * service-inference.ai(svcinf-client.ts)。operator 2026-11-04 决定换回筷子,但 svcinf 代码保留 ——
 * volc-adapter.ts 按 env `ENTERPRISE_VOLC_PROVIDER` 选 provider 提交,轮询按映射表里的上游号前缀分流
 * (`kz-cgt-` → 这里;`mvt-` → svcinf),两边历史任务都能查,再切回去也只是改 env。
 *
 * 筷子对齐【火山方舟官方 contents/generations/tasks】契约(POST 建任务 → GET 轮询),我们对客的方舟形接口
 * 因此近乎直通,不做协议翻译:
 *   提交 POST {BASE}/ai-open-platform-api/api/v3/contents/generations/tasks   → { id: "kz-cgt-…", status }
 *   轮询 GET  {BASE}/ai-open-platform-api/api/v3/contents/generations/tasks/{id}
 *   鉴权 Authorization: Bearer <kz-…>
 *
 * 实测要点(2026-08 ~ 09 积累,换回时复核 key 仍有效):
 *  - 上游受理号 `kz-cgt-…`;轮询体里 `vendor_task_id` = 渠道侧原始任务号,落方舟时是火山官方 `cgt-…`,
 *    落别家时是 `tsk-…`(fast/mini 曾漂到非方舟,见 reference_kuaizi_tier_routing_not_ark)—— 只落日志
 *    (`ark:` 标志),不对客;对客 id 是 volc-adapter 自造的火山形号。
 *  - 成片两条:`content.video_url`(方舟原始 TOS 签名直链)与 `content.kz_video_url`(上游转存链,路径含
 *    `ai_openapi/` + 上游 task id,**泄露中间商**)→ 优先 video_url,缺失才兜底 kz_video_url。
 *  - 上游会用【非 2xx + body 带 status:failed】传递已失败任务(2026-09-11 实测,方舟 InternalServiceError)
 *    → 带 status 的 body 按任务态处理,不当不透明错误一直挂着。
 *  - 无取消端点。
 *  - 样片出正片(draft_task):方舟真号 = 轮询体 `vendor_task_id`(cgt-),见 fetchKuaiziVendorTaskId。
 *
 * env(lazy 读):ENTERPRISE_KUAIZI_BASE_URL(缺省 https://aiopenapi.kuaizi.cn)/ ENTERPRISE_KUAIZI_KEY(kz-…)。
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { passthroughUpstreamError, sanitizeUpstreamText } from './upstream-error';

export const KUAIZI_DEFAULT_BASE = 'https://aiopenapi.kuaizi.cn';
const TASKS_PATH = '/ai-open-platform-api/api/v3/contents/generations/tasks';

/** 筷子 key 前缀(平台 ApiKey / 客户自带 key 都是这个形态)。 */
export const KUAIZI_KEY_PREFIX = 'kz-';
/** 筷子受理号前缀(唯一可轮询句柄)。 */
export const KUAIZI_TASK_ID_PREFIX = 'kz-cgt-';

export interface KuaiziConfig {
    base: string;
    key: string;
}

export function getKuaiziConfig(overrideKey?: string): KuaiziConfig | null {
    const key = overrideKey || process.env.ENTERPRISE_KUAIZI_KEY;
    if (!key) return null;
    return { base: (process.env.ENTERPRISE_KUAIZI_BASE_URL || KUAIZI_DEFAULT_BASE).replace(/\/$/, ''), key };
}

export function isKuaiziKey(v: unknown): v is string {
    return typeof v === 'string' && v.startsWith(KUAIZI_KEY_PREFIX);
}

export function isKuaiziTaskId(v: unknown): v is string {
    return typeof v === 'string' && v.startsWith(KUAIZI_TASK_ID_PREFIX);
}

/** 火山原生任务号形态(方舟 id)。轮询侧用它判 vendor_task_id 落没落方舟。 */
function isArkTaskId(v: unknown): v is string {
    return typeof v === 'string' && v.startsWith('cgt-');
}

function errJson(type: string, status: number, code: string, message: string, category?: string) {
    return NextResponse.json({ error: { code, message, type, ...(category ? { category } : {}) } }, { status });
}

function mapStatus(s: unknown): 'queued' | 'in_progress' | 'completed' | 'failed' {
    const x = String(s || '').toLowerCase();
    if (['completed', 'success', 'succeeded'].includes(x)) return 'completed';
    if (['failed', 'error', 'cancelled', 'canceled', 'expired'].includes(x)) return 'failed';
    if (x === 'queued' || x === 'pending') return 'queued';
    return 'in_progress';
}

export interface KuaiziSubmitResult {
    ok: true;
    /** 上游受理号(kz-cgt-…)。 */
    taskId: string;
}
export interface KuaiziSubmitFailure {
    ok: false;
    res: NextResponse;
}

/** 提交(上游 body 已由调用方翻译好;model 必须是火山方舟官方 Model ID)。 */
export async function submitKuaiziTask(
    cfg: KuaiziConfig,
    upstreamBody: Record<string, unknown>,
    tag: { log: string; errType: string; model?: string },
): Promise<KuaiziSubmitResult | KuaiziSubmitFailure> {
    const fail = (status: number, code: string, message: string, category?: string): KuaiziSubmitFailure => ({
        ok: false,
        res: errJson(tag.errType, status, code, message, category),
    });
    let upstream: Response;
    try {
        upstream = await fetch(`${cfg.base}${TASKS_PATH}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(upstreamBody),
            signal: AbortSignal.timeout(30000),
        });
    } catch (e) {
        console.warn(`[${tag.log}] kuaizi submit unreachable`, { err: String(e) });
        return fail(502, 'upstream_unreachable', 'upstream temporarily unavailable, please retry');
    }
    const text = await upstream.text();
    let j: { id?: string; task_id?: string } | null;
    try {
        j = JSON.parse(text) as { id?: string; task_id?: string };
    } catch {
        j = null;
    }
    const taskId = j?.task_id || j?.id;
    if (!upstream.ok || !taskId) {
        // 上游原始报错体(含 request_id / 上游域名)只落日志;对客【透传原文】(仅剥身份标记,#271)。
        const cls = passthroughUpstreamError(text, upstream.status);
        console.warn(`[${tag.log}] kuaizi submit failed`, {
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

async function fetchTask(cfg: KuaiziConfig, upstreamId: string): Promise<{ http: number; text: string }> {
    const r = await fetch(`${cfg.base}${TASKS_PATH}/${encodeURIComponent(upstreamId)}`, {
        headers: { Authorization: `Bearer ${cfg.key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
    });
    return { http: r.status, text: await r.text() };
}

/**
 * 取上游任务的方舟真号(`vendor_task_id`,cgt-)+ 状态 —— 样片出正片用(draft_task.id 必须是方舟真号)。
 * 落非方舟渠道(tsk-)时 arkId 为 null。网络 / 解析失败 → ok:false。
 */
export async function fetchKuaiziVendorTaskId(
    cfg: KuaiziConfig,
    upstreamId: string,
    log: string,
): Promise<{ ok: true; status: string; arkId: string | null } | { ok: false }> {
    let fetched: { http: number; text: string };
    try {
        fetched = await fetchTask(cfg, upstreamId);
    } catch (e) {
        console.warn(`[${log}] kuaizi draft task lookup unreachable`, { upstreamId, err: String(e) });
        return { ok: false };
    }
    let j: Record<string, unknown> | null;
    try {
        j = JSON.parse(fetched.text) as Record<string, unknown>;
    } catch {
        j = null;
    }
    if (!j || typeof j.status !== 'string') {
        console.warn(`[${log}] kuaizi draft task lookup failed`, { upstreamId, http: fetched.http });
        return { ok: false };
    }
    const vendor = j.vendor_task_id;
    return { ok: true, status: mapStatus(j.status), arkId: isArkTaskId(vendor) ? vendor : null };
}

/**
 * 轮询:GET 上游任务 → 归一形 {status, video_url, last_frame_url, usage, …火山官方字段}
 * (与 svcinf-client.pollSvcinfTask 同一归一形,proxy / 对账器不区分 provider)。
 * @param clientId   对客号(回显用)
 * @param upstreamId 上游受理号 kz-cgt-(调用方已做映射)
 */
export async function pollKuaiziTask(
    cfg: KuaiziConfig,
    clientId: string,
    upstreamId: string,
    tag: { log: string; errType: string },
): Promise<NextResponse> {
    const err = (status: number, code: string, message: string, category?: string) =>
        errJson(tag.errType, status, code, message, category);
    let fetched: { http: number; text: string };
    try {
        fetched = await fetchTask(cfg, upstreamId);
    } catch (e) {
        console.warn(`[${tag.log}] kuaizi poll unreachable`, { id: clientId, err: String(e) });
        return err(502, 'upstream_unreachable', 'upstream temporarily unavailable, please retry');
    }
    const { http, text } = fetched;
    let j: Record<string, unknown> | null;
    try {
        j = JSON.parse(text) as Record<string, unknown>;
    } catch {
        j = null;
    }
    // 带 status 的 body = 真·任务态(即使 HTTP 非 2xx 也按任务态处理 —— 2026-09-11 实测筷子对一条
    // 方舟 InternalServiceError 的任务持续返 400 + {status:"failed"},当不透明错误会让任务永停 queued);
    // 只有【没有可用 status 的纯错误体】(任务不存在 / 限流 / 5xx 无 body)才走报错分支。
    const bodyStatus = j && typeof j.status === 'string' && j.status ? j.status : '';
    if (http >= 400 && !bodyStatus) {
        const cls = passthroughUpstreamError(text, http);
        console.warn(`[${tag.log}] kuaizi poll failed`, {
            id: clientId,
            status: http,
            category: cls.category,
            body: text.slice(0, 2000),
        });
        return err(http >= 400 ? http : 502, 'upstream_error', cls.message, cls.category);
    }
    if (!j || !bodyStatus) {
        console.warn(`[${tag.log}] kuaizi poll 2xx 但 body 非任务体`, { id: clientId, body: text.slice(0, 500) });
        return err(502, 'upstream_unreachable', 'upstream temporarily unavailable, please retry');
    }
    if (http >= 400) {
        console.warn(`[${tag.log}] kuaizi poll 非2xx 但 body 带 status,按任务态处理`, {
            id: clientId,
            http,
            taskStatus: bodyStatus,
        });
    }
    const status = mapStatus(bodyStatus);
    const contentObj = (j.content ?? undefined) as
        | { video_url?: unknown; kz_video_url?: unknown; last_frame_url?: unknown }
        | undefined;
    // 优先方舟原始直链(客户只看到火山官方 TOS 域名);缺失才兜底上游转存链。
    const videoUrl =
        typeof contentObj?.video_url === 'string'
            ? contentObj.video_url
            : typeof contentObj?.kz_video_url === 'string'
              ? contentObj.kz_video_url
              : undefined;
    // 火山成功态 content 恒有 last_frame_url(无尾帧为空串)—— 上游给了就跟随,成功态没给补空串;
    // 「键缺失」和「值为空」对客户的契约校验是两回事。
    const lastFrameUrl =
        typeof contentObj?.last_frame_url === 'string'
            ? contentObj.last_frame_url
            : status === 'completed'
              ? ''
              : undefined;
    // 生成失败原因【透传原文】(仅按 #271 剥身份标记:request_id / 域名 / kz-·tsk- 任务号)。
    const rawFail =
        status === 'failed' ? String((j.error as { message?: string } | undefined)?.message || j.message || '') : '';
    const failReason =
        status === 'failed' ? sanitizeUpstreamText(rawFail, { keepOpaqueIds: true }) || 'generation failed' : '';
    if (failReason) console.warn(`[${tag.log}] kuaizi task failed upstream`, { id: clientId, fail_reason: failReason });
    const usage = (j.usage ?? undefined) as Record<string, unknown> | undefined;
    // vendor_task_id 不对客(客户的 id 本身就是火山型号);只落日志供内部对账 + 判落没落方舟。
    const vendorRaw = j.vendor_task_id;
    if (typeof vendorRaw === 'string' && vendorRaw) {
        console.log(`[${tag.log}] kuaizi vendor task id`, {
            id: clientId,
            vendor_task_id: vendorRaw,
            ark: isArkTaskId(vendorRaw),
        });
    }
    // 上游【已推导】的元数据优先于库里的提交参数(duration=-1 完成后给真实秒数;ratio 同理)。
    const upstreamMeta: Record<string, unknown> = {};
    if (typeof j.duration === 'number') upstreamMeta.duration = j.duration;
    if (typeof j.ratio === 'string' && j.ratio) upstreamMeta.ratio = j.ratio;
    if (typeof j.resolution === 'string' && j.resolution) upstreamMeta.resolution = j.resolution;
    if (typeof j.framespersecond === 'number') upstreamMeta.framespersecond = j.framespersecond;
    if (typeof j.generate_audio === 'boolean') upstreamMeta.generate_audio = j.generate_audio;
    if (typeof j.execution_expires_after === 'number') upstreamMeta.execution_expires_after = j.execution_expires_after;
    if (typeof j.seed === 'number') upstreamMeta.seed = j.seed;
    if (Array.isArray(j.tools)) upstreamMeta.tools = j.tools;
    // 2026-09 官方新增回显字段:筷子给了就透(多半不给 → 上层走落库值 / 官方默认)
    if (typeof j.output_format === 'string' && j.output_format) upstreamMeta.output_format = j.output_format;
    if (typeof j.safety_identifier === 'string' && j.safety_identifier)
        upstreamMeta.safety_identifier = j.safety_identifier;
    if (typeof j.service_tier === 'string' && j.service_tier) upstreamMeta.service_tier = j.service_tier;
    if (typeof j.frames === 'number') upstreamMeta.frames = j.frames;
    // 时间戳以上游为准(上游未受理时返 0,上层据此回落库值)。
    if (typeof j.created_at === 'number') upstreamMeta.upstream_created_at = j.created_at;
    if (typeof j.updated_at === 'number') upstreamMeta.upstream_updated_at = j.updated_at;
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
