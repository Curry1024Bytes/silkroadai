/**
 * 主站火山方舟原生视频入口(/api/v3/contents/generations/tasks)→ new-api doubao 插件原生路由。
 *
 * 为什么走原生路由:doubao 插件的 openai_video 协议(POST /v1/videos)只从顶层取 model / prompt /
 * seconds / images,其余参数必须放在 metadata 里;顶层的 videos、resolution、ratio、duration 等会被
 * 静默丢掉,参考视频根本到不了上游。插件的原生路由 `/doubao/api/v3/contents/generations/tasks` 把
 * 整个火山方舟请求体原样交给上游,客户按火山官方格式(甚至官方 SDK)调用即可。
 *
 * 本模块只做转发:请求体和 Authorization 原样带过去,鉴权、限流、选渠道、按真实 usage 计费全在
 * new-api。唯一的改写是响应里的 `model`:new-api 轮询返回的是上游原始返回体,只替换了任务号,
 * `model` 会是上游模型名(artsdance-*,厂商标识,不对客)。按 UPSTREAM_TO_CLIENT_MODEL 改回对客名。
 *
 * 与火山官方的差异(见《视频模型兼容1.0》):
 *  - 任务号是 new-api 的 `task_` 加 32 位字符,不是火山的 `cgt-` 形。官方 SDK 不校验格式。
 *  - 插件只声明了提交和查询两条路由,取消、删除、列出任务一律 404。
 *
 * 部署配套:宿主机 Nginx 的 API 子域要把 `/api/v3/` 转到 portal;middleware.ts 的 matcher 已排除
 * `api/v3/`(带 base64 参考图的大请求体不会被 10MB 缓冲截断)。
 */
import { NextRequest, NextResponse } from 'next/server';
import { forwardHeaders, STRIP_RESPONSE_HEADERS } from '@/lib/proxy/forward';
import {
    beginCapture,
    captureJsonResponse,
    captureResponse,
    isMediaCaptureSkipped,
    parseModelAndStream,
    recordRequestBody,
} from '@/lib/reqlog/capture';

const NEWAPI_BASE_URL = process.env.NEWAPI_BASE_URL || 'http://localhost:3000';
const PLUGIN_TASKS_PATH = '/doubao/api/v3/contents/generations/tasks';
const TASKS_PATH = '/contents/generations/tasks';

/**
 * 上游模型名 → 对客模型名。必须与 new-api 渠道的模型重定向逐条互逆
 * (渠道里是 对客名 → 上游名);加模型时两处一起改。
 */
export const UPSTREAM_TO_CLIENT_MODEL: Readonly<Record<string, string>> = {
    'artsdance-2-5-pro-260801': 'doubao-seedance-2-5-260628',
    'artsdance-2-0-pro-260801': 'doubao-seedance-2-0-260128',
    'artsdance-2-0-fast-260801': 'doubao-seedance-2-0-fast-260128',
    'artsdance-2-0-mini-260801': 'doubao-seedance-2-0-mini-260615',
};

/** new-api 公开任务号是 `task_` 加随机字符;只放行安全字符,防止拼进上游路径时被改写。 */
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type ArkNativeVideoRoute = { kind: 'submit' } | { kind: 'query'; taskId: string };

/** path 是 /api/v3 之后的部分。只认提交与单任务查询,其余(取消、删除、列表)返回 null。 */
export function matchArkNativeVideoPath(method: string, path: string): ArkNativeVideoRoute | null {
    const p = path.replace(/\/+$/, '');
    if (method === 'POST' && p === TASKS_PATH) return { kind: 'submit' };
    if (method === 'GET' && p.startsWith(`${TASKS_PATH}/`)) {
        const taskId = p.slice(TASKS_PATH.length + 1);
        if (TASK_ID.test(taskId)) return { kind: 'query', taskId };
    }
    return null;
}

/** 响应体 `model` 是上游名时改回对客名;不是 JSON 对象或无需改写时返回 null(调用方原样返回)。 */
export function rewriteUpstreamModel(text: string): string | null {
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        return null;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const record = body as Record<string, unknown>;
    if (typeof record.model !== 'string') return null;
    const client = UPSTREAM_TO_CLIENT_MODEL[record.model];
    if (!client) {
        // 对应表漏了新模型时,上游名会漏给客户;日志里留个信号,不阻断客户。
        if (/artsdance/i.test(record.model))
            console.warn('[ark-native] upstream model has no client mapping', { model: record.model });
        return null;
    }
    return JSON.stringify({ ...record, model: client });
}

export async function handleArkNativeVideo(req: NextRequest, route: ArkNativeVideoRoute): Promise<NextResponse> {
    const clientPath = route.kind === 'submit' ? TASKS_PATH : `${TASKS_PATH}/${route.taskId}`;
    const upstreamUrl =
        route.kind === 'submit'
            ? `${NEWAPI_BASE_URL}${PLUGIN_TASKS_PATH}`
            : `${NEWAPI_BASE_URL}${PLUGIN_TASKS_PATH}/${route.taskId}`;

    // 与 /v1 同一开关:text-only 模式下视频不记。
    const cap = isMediaCaptureSkipped() ? null : beginCapture(req, `/api/v3${clientPath}`);

    let body: BodyInit | undefined;
    if (route.kind === 'submit') {
        if (cap) {
            const raw = await req.text();
            recordRequestBody(cap, raw, parseModelAndStream(raw).model, false);
            body = raw;
        } else {
            body = req.body as unknown as BodyInit; // 开关 off:流式直传,不把大请求体读进内存
        }
    }

    let upstream: Response;
    try {
        upstream = await fetch(upstreamUrl, {
            method: req.method,
            headers: forwardHeaders(req),
            body,
            duplex: 'half',
        } as RequestInit & { duplex: 'half' });
    } catch (err) {
        console.warn('[ark-native] new-api unreachable', { err: err instanceof Error ? err.message : String(err) });
        const errBody = {
            error: {
                code: 'upstream_unreachable',
                message: 'service temporarily unavailable, please retry',
                type: 'api_error',
            },
        };
        if (cap) captureJsonResponse(cap, 502, errBody);
        return NextResponse.json(errBody, { status: 502 });
    }

    const text = await upstream.text();
    const headers = new Headers();
    upstream.headers.forEach((value, key) => {
        if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) headers.set(key, value);
    });
    // 204/205/304 不允许带响应体,构造 Response 会抛错。
    const finalBody = NULL_BODY_STATUSES.has(upstream.status) ? null : (rewriteUpstreamModel(text) ?? text);
    if (cap) return captureResponse(cap, new Response(finalBody, { status: upstream.status, headers }));
    return new NextResponse(finalBody, { status: upstream.status, headers });
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);
