import { NextResponse } from 'next/server';

// Seedream 图生图走 JSON /v1/images/generations 的 `image` 字段(URL / base64);multipart edits 在
// portal /v1 代理层已转成 JSON,这里只会被绕过代理直打 new-api 的调用命中 → 明确提示,不静默 404。
export async function POST() {
    return NextResponse.json(
        {
            error: {
                message:
                    'seedream-5-0-pro does not accept multipart /v1/images/edits here; send JSON to /v1/images/generations with an `image` field (URL or base64 data URL)',
                type: 'invalid_request_error',
                param: null,
                code: 'unsupported_endpoint',
            },
        },
        { status: 400 },
    );
}
