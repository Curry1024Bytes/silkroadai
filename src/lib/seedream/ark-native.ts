/**
 * Seedream 火山方舟(Ark)原生路径:`POST /api/v3/images/generations`(2026-10-26)。
 *
 * 客户用火山方舟 / BytePlus ModelArk 官方 SDK 或官方文档的 curl,只改 base_url
 * (`https://ark.cn-beijing.volces.com/api/v3` → `https://ai.silkroadai.io/api/v3`)就能调。
 * 官方契约与 OpenAI Images 几乎同形(model / prompt / image / size / response_format / watermark /
 * seed / sequential_image_generation …,响应 `{ model, created, data:[{url|b64_json, size}], usage }`),
 * 所以这里不另起一套:把请求原样改写到主站 `/v1/images/generations`,复用其全部逻辑
 * (new-api 鉴权扣费 → seedream 适配器 → 图床转存 / 客户 OSS → 错误统一),回程只把 `model`
 * 回显成客户传入的名字。
 *
 * 只认 Seedream 5.0 两个模型(含官方模型 ID 别名);其余模型 404。官方的 `stream`(组图流式)
 * 我们不支持 → 400 明确报错,免得客户端等 SSE 等到超时。
 */
import { NextRequest, NextResponse } from 'next/server';
import { SEEDREAM_FLASH_MODEL, SEEDREAM_MODEL, type SeedreamModel } from '@/lib/seedream/adapter';

/** 官方模型 ID / 我们的对客名(小写)→ 对客规范名。 */
const ARK_MODEL_ALIASES: Record<string, SeedreamModel> = {
    [SEEDREAM_MODEL]: SEEDREAM_MODEL,
    'doubao-seedream-5-0-pro-260628': SEEDREAM_MODEL,
    'dola-seedream-5-0-pro-260628': SEEDREAM_MODEL,
    'dola-seedream-5-0-pro-260628-ep': SEEDREAM_MODEL,
    [SEEDREAM_FLASH_MODEL]: SEEDREAM_FLASH_MODEL,
    'doubao-seedream-5-0-flash-260915': SEEDREAM_FLASH_MODEL,
    'dola-seedream-5-0-flash-260915': SEEDREAM_FLASH_MODEL,
};

export function resolveArkSeedreamModel(model: unknown): SeedreamModel | null {
    return (
        ARK_MODEL_ALIASES[
            String(model ?? '')
                .trim()
                .toLowerCase()
        ] ?? null
    );
}

/** 本入口只服务这一条路径(相对 /api/v3)。 */
export function isArkImagesPath(method: string, path: string): boolean {
    return method === 'POST' && path.replace(/\/+$/, '') === '/images/generations';
}

function arkError(status: number, code: string, message: string, param: string | null = null): NextResponse {
    return NextResponse.json(
        { error: { code, message, param, type: status >= 500 ? 'server_error' : 'invalid_request_error' } },
        { status },
    );
}

/** 主站 /v1 处理器(由路由注入,避免 lib 反向依赖 app 路由模块)。 */
export type V1ImagesHandler = (req: NextRequest) => Promise<NextResponse>;

export async function handleArkSeedreamImages(req: NextRequest, v1: V1ImagesHandler): Promise<NextResponse> {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body))
        return arkError(400, 'InvalidParameter', 'request body must be a JSON object');

    const requested = String(body.model ?? '').trim();
    const model = resolveArkSeedreamModel(requested);
    if (!model)
        return arkError(
            404,
            'InvalidEndpointOrModel.NotFound',
            `The model ${requested || '(empty)'} does not exist or you do not have access to it. ` +
                `Supported: ${SEEDREAM_MODEL}, ${SEEDREAM_FLASH_MODEL}.`,
            'model',
        );
    if (body.stream === true || body.stream === 'true')
        return arkError(400, 'InvalidParameter', 'stream is not supported, please set stream to false', 'stream');

    const forwardBody: Record<string, unknown> = { ...body, model };
    delete forwardBody.stream;

    const headers = new Headers(req.headers);
    headers.delete('content-length');
    headers.set('content-type', 'application/json');
    const url = new URL('/v1/images/generations', req.nextUrl.origin);
    url.search = req.nextUrl.search;
    const res = await v1(new NextRequest(url, { method: 'POST', headers, body: JSON.stringify(forwardBody) }));

    if (!res.ok || !(res.headers.get('content-type') || '').includes('application/json')) return res;
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json) return res;
    const out = NextResponse.json({ ...json, model: requested }, { status: res.status });
    res.headers.forEach((v, k) => {
        if (k !== 'content-type' && k !== 'content-length' && k !== 'content-encoding') out.headers.set(k, v);
    });
    return out;
}
