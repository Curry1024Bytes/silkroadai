import 'server-only';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { pricingPublishErrorResponse } from './pricing-publish';
import { PricingPublishError } from './pricing-publish-lock';

export async function readCostBody(request: Request) {
    const body = await request.text();
    if (body.length > 256_000) throw new PricingPublishError('invalid_input', '成本资料过大，请分批提交。', 413);
    try {
        return JSON.parse(body) as unknown;
    } catch {
        throw new PricingPublishError('invalid_input', '请求格式无效。', 400);
    }
}

export function costErrorResponse(error: unknown) {
    if (error instanceof ZodError)
        return NextResponse.json(
            { error: 'invalid_input', message: error.issues[0]?.message ?? '请检查成本资料。' },
            { status: 400 },
        );
    const response = pricingPublishErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
}
