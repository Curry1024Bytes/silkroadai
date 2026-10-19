/**
 * Public video-cache delivery for new-api's random task IDs. The task ID is
 * the share capability; new-api also verifies success and the 48-hour TTL.
 * Only a fixed internal path is fetched, so result URLs cannot act as proxies.
 */
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ filename: string }> };
const FILENAME_RE = /^task_[A-Za-z0-9]{32}\.mp4$/;
const RESPONSE_HEADERS = [
    'accept-ranges',
    'content-length',
    'content-range',
    'content-type',
    'last-modified',
    'etag',
    'content-disposition',
] as const;
const PUBLIC_HEADERS = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'Accept-Ranges, Content-Length, Content-Range',
};

async function serveVideo(req: NextRequest, context: Context): Promise<NextResponse> {
    const { filename } = await context.params;
    if (!FILENAME_RE.test(filename)) return new NextResponse(null, { status: 404, headers: PUBLIC_HEADERS });

    const base = (process.env.NEWAPI_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const headers = new Headers();
    for (const name of ['range', 'if-range']) {
        const value = req.headers.get(name);
        if (value) headers.set(name, value);
    }

    let upstream: Response;
    try {
        upstream = await fetch(`${base}/video-cache/${filename}`, {
            method: req.method,
            headers,
            redirect: 'manual',
        });
    } catch {
        return new NextResponse(null, { status: 502, headers: PUBLIC_HEADERS });
    }

    if (upstream.status === 404 || upstream.status === 400 || upstream.status === 410) {
        void upstream.body?.cancel().catch(() => {});
        return new NextResponse(null, { status: 404, headers: PUBLIC_HEADERS });
    }
    if (upstream.status === 416) {
        const contentRange = upstream.headers.get('content-range');
        void upstream.body?.cancel().catch(() => {});
        return new NextResponse(null, {
            status: 416,
            headers: { ...PUBLIC_HEADERS, ...(contentRange ? { 'content-range': contentRange } : {}) },
        });
    }
    if (
        (upstream.status !== 200 && upstream.status !== 206) ||
        !upstream.headers.get('content-type')?.toLowerCase().startsWith('video/mp4')
    ) {
        void upstream.body?.cancel().catch(() => {});
        return new NextResponse(null, { status: 502, headers: PUBLIC_HEADERS });
    }

    const responseHeaders = new Headers(PUBLIC_HEADERS);
    for (const name of RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders.set(name, value);
    }
    return new NextResponse(req.method === 'HEAD' ? null : upstream.body, {
        status: upstream.status,
        headers: responseHeaders,
    });
}

export async function GET(req: NextRequest, context: Context): Promise<NextResponse> {
    return serveVideo(req, context);
}

export async function HEAD(req: NextRequest, context: Context): Promise<NextResponse> {
    return serveVideo(req, context);
}

export async function OPTIONS(): Promise<NextResponse> {
    return new NextResponse(null, {
        status: 204,
        headers: {
            ...PUBLIC_HEADERS,
            'access-control-allow-methods': 'GET, HEAD, OPTIONS',
            'access-control-allow-headers': 'range, if-range',
            'access-control-max-age': '86400',
        },
    });
}
