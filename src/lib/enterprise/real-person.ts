/**
 * 真人视觉认证上游 client(2026-07-29,「火山」渠道)。
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

/** 创建真人认证会话(火山 Action: CreateVisualValidateSession)。 */
export async function createVisualValidateSession(): Promise<CreateSessionResult> {
    // provider /sessions 无入参(CallbackURL/ProjectName 客户端字段上游不消费,忽略)
    return callProvider<CreateSessionResult>('/api/v1/real-person-auth/sessions', {});
}

/** 用 bytedToken 换真人素材组 groupId(火山 Action: GetVisualValidateResult)。 */
export async function getVisualValidateGroupId(bytedToken: string): Promise<string> {
    // provider 接口 13:data 为 groupId 字符串
    return callProvider<string>('/api/v1/real-person-auth/asset-group/by-byted-token', { bytedToken });
}
