/**
 * 未知模型错误码对齐官方(new-api 503 `model_not_found` → 404)。
 *
 * new-api 对「分组内没有渠道能服务该模型」固定返 **503** + `{"error":{"code":"model_not_found",
 * "message":"分组 X 下模型 Y 无可用渠道(distributor) ..."}}`,而 Anthropic / OpenAI 官方对
 * 未知模型都是 **404**(Anthropic `not_found_error`、OpenAI `model_not_found`)。5xx 会让客户
 * SDK 与网关按「服务端错误」退避重试,一个永远不可能成功的请求被反复重打;客户对标官方的
 * 契约测试也把它判成 server error(2026-09-18 客户反馈)。原文还把内部分组名泄给了客户。
 *
 * 歧义:同一段文案在「已知模型但渠道全挂/被自动禁用」时字面相同,那种情形该保持 503
 * (可重试的容量问题)。这里用 new-api 自己的 `GET /v1/models`(按该 key 的分组/令牌限制
 * 返回可调模型)做确定性判别:模型不在该 key 的可调清单里 → 404;在清单里 → 原 503 原样
 * 透传。判别链任何一环失败(网络 / 超时 / 非 JSON)→ **fail-open 原样透传 503**。
 *
 * 只在上游 status === 503 时读体,非 503 零成本直返,不影响热路径。
 */
import type { NextRequest } from 'next/server';
import { forwardHeaders, STRIP_RESPONSE_HEADERS } from '@/lib/proxy/forward';

const NEWAPI_BASE_URL = process.env.NEWAPI_BASE_URL || 'http://localhost:3000';

/** `/v1/models` 判别调用的截止钟:错误路径上的附加调用,不能拖成第二个故障点。 */
const MODELS_LOOKUP_TIMEOUT_MS = 3_000;

export type ErrorShape = 'anthropic' | 'openai';

/** 官方错误体。Anthropic 原文就是 `model: <name>`;OpenAI 原文是 does not exist / no access。
 *  两者都附一句指向 `GET /v1/models` 的提示(不影响 SDK 解析,客户能自助定位)。 */
export function modelNotFoundBody(shape: ErrorShape, model: string): Record<string, unknown> {
    if (shape === 'anthropic') {
        return {
            type: 'error',
            error: {
                type: 'not_found_error',
                message: `model: ${model} (not available for this API key; GET /v1/models lists the models you can call)`,
            },
        };
    }
    return {
        error: {
            message: `The model \`${model}\` does not exist or you do not have access to it. GET /v1/models lists the models you can call.`,
            type: 'invalid_request_error',
            param: 'model',
            code: 'model_not_found',
        },
    };
}

/** 从 new-api 错误体判是否 model_not_found,并尽力提取模型名(调用方已知时优先用已知值)。 */
export function detectModelNotFound(text: string): { modelFromText: string | null } | null {
    let code = '';
    let message = '';
    try {
        const j = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
        code = typeof j?.error?.code === 'string' ? j.error.code : '';
        message = typeof j?.error?.message === 'string' ? j.error.message : '';
    } catch {
        return null;
    }
    const isNoChannel = /无可用渠道|no available channel/i.test(message);
    if (code !== 'model_not_found' && !isNoChannel) return null;
    const m = /模型\s+(\S+?)\s+无可用渠道/.exec(message) || /for model\s+(\S+?)\s+under/i.exec(message);
    return { modelFromText: m ? m[1] : null };
}

/** 按同一把 key 查 new-api 可调模型清单。`null` = 查不到(判别放弃,调用方 fail-open)。 */
async function listCallableModels(req: NextRequest): Promise<Set<string> | null> {
    const headers = forwardHeaders(req);
    headers.delete('content-type');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), MODELS_LOOKUP_TIMEOUT_MS);
    try {
        const r = await fetch(`${NEWAPI_BASE_URL}/v1/models`, { method: 'GET', headers, signal: ac.signal });
        if (!r.ok) return null;
        const j = (await r.json()) as { data?: Array<{ id?: unknown }> };
        if (!Array.isArray(j?.data)) return null;
        const ids = new Set<string>();
        for (const m of j.data) if (typeof m?.id === 'string') ids.add(m.id);
        return ids;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** 重建一个与上游等价的 Response(体已被读成文本)。 */
function rebuild(upstream: Response, text: string): Response {
    return new Response(text, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
}

/**
 * 上游 503 `model_not_found` 且模型确不在该 key 可调清单 → 404 官方形;其余原样返回。
 * 永不抛异常。返回的 Response 由调用方照常走 capture / passthrough 尾部。
 */
export async function remapModelNotFound(
    upstream: Response,
    req: NextRequest,
    shape: ErrorShape,
    knownModel: string | null,
): Promise<Response> {
    if (upstream.status !== 503) return upstream;
    let text: string;
    try {
        text = await upstream.text();
    } catch {
        return upstream;
    }
    try {
        const hit = detectModelNotFound(text);
        const model = knownModel || hit?.modelFromText || null;
        if (!hit || !model) return rebuild(upstream, text);

        const callable = await listCallableModels(req);
        if (!callable || callable.has(model)) return rebuild(upstream, text); // 查不到 / 已知模型容量耗尽 → 保持 503

        const headers = new Headers();
        upstream.headers.forEach((v, k) => {
            if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) headers.set(k, v);
        });
        headers.set('content-type', 'application/json');
        headers.set('X-Silkroadai-Error-Remap', 'model_not_found');
        return new Response(JSON.stringify(modelNotFoundBody(shape, model)), { status: 404, headers });
    } catch {
        return rebuild(upstream, text);
    }
}
