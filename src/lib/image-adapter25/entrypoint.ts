import { NextRequest, NextResponse } from 'next/server';
import { handleAdapter25Image, type ImageMode } from './adapter';

/** Keep the unverified provider inaccessible until an operator explicitly enables it. */
export async function handleAdapter25Request(req: NextRequest, mode: ImageMode, provider: string) {
    if (process.env.PORTAL_IMAGE_ADAPTER25_ENABLED !== 'true') {
        return NextResponse.json(
            {
                error: {
                    message: 'The server is temporarily unable to process this request, please retry later.',
                    type: 'server_error',
                    param: null,
                    code: 'upstream_unavailable',
                },
            },
            { status: 503 },
        );
    }
    return handleAdapter25Image(req, mode, provider);
}
