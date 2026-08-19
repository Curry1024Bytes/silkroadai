/**
 * 真人视觉认证上游 client(「火山」渠道)。
 *
 * 【2026-08-19 起默认走筷子开放平台】(operator 拍板:并到筷子这一家)。
 * 之前走 727 provider(`ENTERPRISE_REALPERSON_*`),但那是个**断掉的链路** ——
 * 认证产出的 GroupId 挂在 727 账号里,而 volc 生成早已换成筷子上游,
 * 拿 727 的 group id 去 `asset://` 引用筷子根本不认。并到筷子后自洽。
 * 逃生阀:`ENTERPRISE_REALPERSON_PROVIDER=727` 切回旧 provider。
 *
 * 筷子契约(文档只列了 Action 名、无字段定义,以下为 2026-08-19 实测):
 *   CreateVisualValidateSession ← { CallbackURL }(**必填**;上游报错文案是
 *     「URL is required」,有误导性)→ { BytedToken, H5Link, CallbackURL }
 *   GetVisualValidateResult     ← { BytedToken } → 建组结果
 *     ⚠️ 活体未完成时上游返 **HTTP 500 + rpc error**(不是干净的 404/未完成语义),
 *        我们统一映射成「认证未完成」,不把 rpc 内部串抛给客户。
 *
 * ── 以下为 727 provider 的历史说明(逃生阀仍走它)──
 *
 * 客户用火山 AK/SK Action 风格调 `POST /api?Action=CreateVisualValidateSession`
 * / `GetVisualValidateResult`(见 src/app/api/route.ts)。本模块把请求翻译到
 * 新 provider 的 REST Bearer 接口(operator 提供的资产库网关,自带真人认证):
 *   POST {base}/api/v1/real-person-auth/sessions              → 建会话,返 bytedToken + h5Link
 *   POST {base}/api/v1/real-person-auth/asset-group/by-byted-token → 换真人素材组 groupId
 *
 * 上游是【平台级共享凭证】(env,非按客户),因为真人认证产出的 GroupId/asset
 * 绑定在【做认证时的上游账号】里 —— 全平台走同一个上游账号(operator 决策)。
 * 认证调用【不计费】(前置步骤,不生成内容)。
 *
 * env(lazy 读,import 不读):
 *   ENTERPRISE_REALPERSON_BASE_URL  例 http://36.111.35.200:3000
 *   ENTERPRISE_REALPERSON_KEY       例 ak-xxxx(Bearer)
 */
import 'server-only';

export class RealPersonError extends Error {
    constructor(
        public status: number,
        public code: string,
        message: string,
    ) {
        super(message);
        this.name = 'RealPersonError';
    }
}

interface RealPersonConfig {
    base: string;
    key: string;
}

/** 读上游配置;未配置抛 503(fail-closed,不静默走空)。 */
function getConfig(): RealPersonConfig {
    const base = process.env.ENTERPRISE_REALPERSON_BASE_URL;
    const key = process.env.ENTERPRISE_REALPERSON_KEY;
    if (!base || !key) {
        throw new RealPersonError(503, 'ServiceUnavailable', '真人认证渠道未配置,请联系服务方');
    }
    return { base: base.replace(/\/$/, ''), key };
}

/** provider 统一响应包:{ requestId, code, message, data }。code=0 成功。 */
interface ProviderEnvelope<T> {
    requestId?: string;
    code?: number;
    message?: string;
    data?: T;
}

async function callProvider<T>(path: string, body: Record<string, unknown> | null): Promise<T> {
    const { base, key } = getConfig();
    let res: Response;
    try {
        res = await fetch(`${base}${path}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body ?? {}),
            signal: AbortSignal.timeout(20000),
        });
    } catch (e) {
        throw new RealPersonError(503, 'ServiceUnavailable', `真人认证上游不可达: ${String(e)}`);
    }
    let j: ProviderEnvelope<T>;
    try {
        j = (await res.json()) as ProviderEnvelope<T>;
    } catch {
        throw new RealPersonError(502, 'UpstreamError', `真人认证上游返回非 JSON(HTTP ${res.status})`);
    }
    // provider 语义:判断成败以 code 为准(0=成功),HTTP 401 = key 无效
    if (res.status === 401) {
        throw new RealPersonError(502, 'UpstreamError', '真人认证上游鉴权失败(平台凭证问题)');
    }
    if (j.code !== 0) {
        // code=1:业务错误(会话未完成 / token 无效或过期等),原样透传 message
        throw new RealPersonError(
            res.status === 200 ? 404 : res.status,
            'ValidateNotReady',
            j.message || '真人认证未完成或已过期',
        );
    }
    if (j.data === undefined) {
        throw new RealPersonError(502, 'UpstreamError', '真人认证上游返回缺少 data');
    }
    return j.data;
}

export interface CreateSessionResult {
    bytedToken: string;
    h5Link: string;
    expiresIn?: number;
}

/** 是否走筷子(缺省是);`ENTERPRISE_REALPERSON_PROVIDER=727` 切回旧 provider。
 *  ⚠️ 别叫 useXxx —— eslint 的 react-hooks/rules-of-hooks 会把它当成 React Hook 报错。 */
function kuaiziLiveness(): boolean {
    return process.env.ENTERPRISE_REALPERSON_PROVIDER !== '727';
}

/** 筷子活体检测:与素材库同一个 Action 端点 + ApiKey 头。 */
async function callKuaiziLiveness<T>(action: string, body: Record<string, unknown>): Promise<T> {
    const key = process.env.ENTERPRISE_KUAIZI_KEY;
    if (!key) throw new RealPersonError(503, 'ServiceUnavailable', '真人认证渠道未配置,请联系服务方');
    const base = (process.env.ENTERPRISE_KUAIZI_BASE_URL || 'https://aiopenapi.kuaizi.cn').replace(/\/$/, '');
    const url = `${base}/ai-open-platform-api/api/support/v1/asset?Action=${action}&Version=2024-01-01`;
    let res: Response;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { ApiKey: key, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(20000),
        });
    } catch (e) {
        console.warn('[real-person/kuaizi] unreachable', { action, err: String(e) });
        throw new RealPersonError(503, 'ServiceUnavailable', '真人认证上游暂时不可达,请稍后重试');
    }
    let j: { ResponseMetadata?: { Error?: { Code?: string; Message?: string } }; Result?: T };
    try {
        j = (await res.json()) as typeof j;
    } catch {
        throw new RealPersonError(502, 'UpstreamError', `真人认证上游返回非 JSON(HTTP ${res.status})`);
    }
    const e = j.ResponseMetadata?.Error;
    if (e?.Code || !res.ok) {
        console.warn('[real-person/kuaizi] failed', { action, status: res.status, code: e?.Code });
        if (res.status === 401) {
            throw new RealPersonError(502, 'UpstreamError', '真人认证上游鉴权失败(平台凭证问题),请联系服务方');
        }
        // 活体未完成 → 上游是 500 + rpc 内部串。别把它抛给客户,统一成可操作文案。
        if (action === 'GetVisualValidateResult') {
            throw new RealPersonError(404, 'ValidateNotReady', '真人认证尚未完成 —— 请在手机上完成活体后重试');
        }
        throw new RealPersonError(
            res.status >= 400 ? res.status : 400,
            e?.Code || 'UpstreamError',
            e?.Message || '真人认证失败',
        );
    }
    return (j.Result ?? {}) as T;
}

/** 创建真人认证会话(火山 Action: CreateVisualValidateSession)。 */
export async function createVisualValidateSession(callbackUrl?: string): Promise<CreateSessionResult> {
    if (!kuaiziLiveness()) {
        // 727 provider:/sessions 无入参(CallbackURL/ProjectName 上游不消费,忽略)
        return callProvider<CreateSessionResult>('/api/v1/real-person-auth/sessions', {});
    }
    // 筷子必填 CallbackURL:客户没传就用门户自身域名兜底(该地址只是活体完成后的跳转目标)
    const cb = callbackUrl || process.env.ENTERPRISE_BASE_URL || 'https://galaxytoken.ai';
    const r = await callKuaiziLiveness<{ BytedToken?: string; H5Link?: string }>('CreateVisualValidateSession', {
        CallbackURL: cb,
    });
    if (!r.BytedToken || !r.H5Link) {
        throw new RealPersonError(502, 'UpstreamError', '真人认证上游未返回会话信息,请稍后重试');
    }
    return { bytedToken: r.BytedToken, h5Link: r.H5Link };
}

/** 用 bytedToken 换真人素材组 groupId(火山 Action: GetVisualValidateResult)。 */
export async function getVisualValidateGroupId(bytedToken: string): Promise<string> {
    if (!kuaiziLiveness()) {
        // 727 provider 接口 13:data 为 groupId 字符串
        return callProvider<string>('/api/v1/real-person-auth/asset-group/by-byted-token', { bytedToken });
    }
    // ⚠️ 成功形态未经真人实测(需要真人在手机上做完活体才能验)。上游 Result 可能是
    // 裸字符串,也可能是 { GroupId } / { Id } —— 三种都认,拿不到就报可操作错误而不是崩。
    const r = await callKuaiziLiveness<unknown>('GetVisualValidateResult', { BytedToken: bytedToken });
    if (typeof r === 'string' && r) return r;
    const o = (r ?? {}) as { GroupId?: unknown; Id?: unknown };
    const gid = typeof o.GroupId === 'string' ? o.GroupId : typeof o.Id === 'string' ? o.Id : '';
    if (!gid) {
        console.warn('[real-person/kuaizi] unexpected result shape', { result: JSON.stringify(r).slice(0, 300) });
        throw new RealPersonError(502, 'UpstreamError', '真人认证结果格式异常,请联系服务方');
    }
    return gid;
}
