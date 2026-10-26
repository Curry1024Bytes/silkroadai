/**
 * 火山方舟(Ark)形态视频 API 入口:/api/v3/*(2026-07-26)。
 *
 * 仅在企业门户实例(PORTAL_FLAVOR=seedance-enterprise)启用,对齐火山方舟官方契约
 * (docs.volcengine.com/docs/82379):
 *   GET  /api/v3/models
 *   POST /api/v3/contents/generations/tasks
 *   GET  /api/v3/contents/generations/tasks/{task_id}
 * 内部复用 handleEnterpriseArkV3 → handleSubmit/handlePoll 核心(计费/鉴权/记账不变)。
 *
 * 主站实例(env 未设)只开一条:`POST /api/v3/images/generations` = Seedream 5.0 方舟原生生图路径
 * (2026-10-26,见 src/lib/seedream/ark-native.ts),内部改写到主站 /v1/images/generations;其余 404。
 */
import { NextRequest, NextResponse } from 'next/server';
import { isEnterpriseFlavor, handleEnterpriseArkV3 } from '@/lib/enterprise/proxy';
import { handleArkSeedreamImages, isArkImagesPath } from '@/lib/seedream/ark-native';
import { POST as v1Post } from '@/app/v1/[...path]/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(req: NextRequest, params: Promise<{ path: string[] }>): Promise<NextResponse> {
    if (!isEnterpriseFlavor()) {
        const { path: segments } = await params;
        if (isArkImagesPath(req.method, '/' + (segments ?? []).join('/')))
            return handleArkSeedreamImages(req, (r) =>
                v1Post(r, { params: Promise.resolve({ path: ['images', 'generations'] }) }),
            );
        return NextResponse.json(
            { error: { code: 'not_found', message: 'not found', type: 'not_found' } },
            { status: 404 },
        );
    }
    const { path: segments } = await params;
    const path = '/' + (segments ?? []).join('/');
    return handleEnterpriseArkV3(req, path);
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: RouteContext) {
    return handle(req, ctx.params);
}
export async function POST(req: NextRequest, ctx: RouteContext) {
    return handle(req, ctx.params);
}
export async function DELETE(req: NextRequest, ctx: RouteContext) {
    return handle(req, ctx.params);
}
