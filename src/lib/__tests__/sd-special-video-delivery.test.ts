import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

const { findKey, findGroup, readOwner, readToken, query, fetchMedia } = vi.hoisted(() => ({
    findKey: vi.fn(),
    findGroup: vi.fn(),
    readOwner: vi.fn(),
    readToken: vi.fn(),
    query: vi.fn(),
    fetchMedia: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
    prisma: { newApiToken: { findUnique: findKey }, channelGroup: { findFirst: findGroup } },
}));
vi.mock('@/lib/newapi/client', () => ({
    getTokenRevocationCustomerIdentity: readOwner,
    getVideoDeliveryTokenForCustomer: readToken,
}));
vi.mock('pg', () => ({
    Pool: class {
        query = query;
    },
}));

import { deliverExhaustedSdVideo } from '@/lib/sd-special-video-delivery';

const path = `/videos/task_${'x'.repeat(32)}`;
const task = {
    sku: 'sd-2-mini-480-novideo',
    status: 'SUCCESS',
    progress: '100%',
    submit_time: 12,
    finish_time: 20,
    media_url: 'https://oss.aigasapi.com/path/clip.mp4?signature=test',
};
const nativeToken = {
    id: 15,
    user_id: 21,
    group: 'SD特惠',
    status: 1,
    remain_quota: 0,
    unlimited_quota: false,
    expired_time: -1,
    allow_ips: null,
};
function request(route = path, method = 'GET', key = 'sk-customerKey') {
    return new NextRequest(`https://api.llmroute.club/v1${route}`, {
        method,
        headers: { authorization: `Bearer ${key}`, range: 'bytes=0-1023', cookie: 'secret', 'x-api-key': 'ignored' },
    });
}

beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('NEWAPI_SD_VIDEO_DELIVERY_DATABASE_URL', 'postgres://reader@localhost/new-api');
    vi.stubGlobal('fetch', fetchMedia);
    findKey.mockResolvedValue({
        status: 'active',
        tier: 'sd',
        newapi_token_id: 15,
        user: { status: 'active', tenant_id: PLATFORM_TENANT_ID, newapi_user_id: 21, newapi_access_token: 'nap_test' },
    });
    findGroup.mockResolvedValue({ key: 'sd' });
    readOwner.mockResolvedValue({ id: 21, status: 1 });
    readToken.mockResolvedValue(nativeToken);
    query.mockResolvedValue({ rows: [task] });
});
afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

describe('SD特惠 exhausted-Key reads', () => {
    it('reads an already billed task through the public ID and returns a protected download URL', async () => {
        const result = await deliverExhaustedSdVideo(request(), path);
        expect(result?.status).toBe(200);
        const data = await result!.json();
        expect(data).toMatchObject({
            id: path.split('/').at(-1),
            object: 'video',
            model: 'sd-2-mini',
            status: 'completed',
            progress: 100,
        });
        expect(data.metadata.url).toMatch(/\/v1\/videos\/task_x{32}\/content$/);
        expect(JSON.stringify(data)).not.toContain('signature');
        expect(query).toHaveBeenCalledWith(expect.stringContaining('owner_id = $1 AND task_id = $2'), [
            21,
            path.split('/').at(-1),
        ]);
    });

    it('reports ongoing work without attempting download or generation', async () => {
        query.mockResolvedValue({
            rows: [{ ...task, status: 'IN_PROGRESS', progress: '50%', finish_time: 0, media_url: null }],
        });
        const result = await deliverExhaustedSdVideo(request(), path);
        expect(await result!.json()).toMatchObject({ status: 'in_progress', progress: 50 });
        expect((await deliverExhaustedSdVideo(request(`${path}/content`), `${path}/content`))?.status).toBe(400);
        expect(fetchMedia).not.toHaveBeenCalled();
    });

    it('streams a partial MP4 using only download headers', async () => {
        readToken.mockResolvedValue({ ...nativeToken, status: 4 });
        fetchMedia.mockResolvedValue(
            new Response('video bytes', {
                status: 206,
                headers: {
                    'content-range': 'bytes 0-1023/3000',
                    'content-type': 'video/mp4',
                    'set-cookie': 'internal',
                },
            }),
        );
        const route = `${path}/content`;
        const result = await deliverExhaustedSdVideo(request(route), route);
        expect(result?.status).toBe(206);
        expect(result?.headers.get('content-range')).toBe('bytes 0-1023/3000');
        expect(result?.headers.get('set-cookie')).toBeNull();
        expect(await result!.text()).toBe('video bytes');
        const [url, options] = fetchMedia.mock.calls[0];
        expect(String(url)).toBe(task.media_url);
        expect(options).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store' });
        expect([...options.headers]).toEqual([['range', 'bytes=0-1023']]);
    });

    it.each([
        { status: 2 },
        { status: 3 },
        { expired_time: 10 },
        { remain_quota: 1 },
        { unlimited_quota: true },
        { user_id: 22 },
        { id: 16 },
        { group: 'other' },
        { allow_ips: '203.0.113.5/32' },
    ])('keeps native denial for %j', async (change) => {
        readToken.mockResolvedValue({ ...nativeToken, ...change });
        expect(await deliverExhaustedSdVideo(request(), path)).toBeNull();
        expect(query).not.toHaveBeenCalled();
    });

    it('rejects an unknown key and a revoked key even if the task exists', async () => {
        findKey.mockResolvedValueOnce(null);
        expect(await deliverExhaustedSdVideo(request(), path)).toBeNull();
        readToken.mockRejectedValue(new Error('no such token'));
        expect(await deliverExhaustedSdVideo(request(), path)).toBeNull();
        expect(query).not.toHaveBeenCalled();
    });

    it('does not read another client’s task or submit a billable request', async () => {
        query.mockResolvedValue({ rows: [] });
        expect((await deliverExhaustedSdVideo(request(), path))?.status).toBe(404);
        expect(await deliverExhaustedSdVideo(request(path, 'POST'), path)).toBeNull();
        expect(query).toHaveBeenCalledTimes(1);
        expect(fetchMedia).not.toHaveBeenCalled();
    });

    it('serves an MP4 from the Seedance download origin recorded by AIGAS', async () => {
        query.mockResolvedValue({
            rows: [{ ...task, media_url: 'https://v26-octo-download.jianying.com/seedance/clip.mp4' }],
        });
        fetchMedia.mockResolvedValue(new Response('video bytes', { headers: { 'content-type': 'video/mp4' } }));
        const route = `${path}/content`;
        const result = await deliverExhaustedSdVideo(request(route), route);
        expect(result?.status).toBe(200);
        expect(await result!.text()).toBe('video bytes');
    });

    it('rejects an untrusted file address and does not publish it', async () => {
        query.mockResolvedValue({ rows: [{ ...task, media_url: 'http://localhost:3000/v1/videos/file/content' }] });
        const route = `${path}/content`;
        const result = await deliverExhaustedSdVideo(request(route), route);
        expect(result?.status).toBe(502);
        expect(JSON.stringify(await result!.json())).not.toContain('localhost');
        expect(fetchMedia).not.toHaveBeenCalled();
    });

    it('requires an explicitly configured read-only connection', async () => {
        vi.stubEnv('NEWAPI_SD_VIDEO_DELIVERY_DATABASE_URL', '');
        expect(await deliverExhaustedSdVideo(request(), path)).toBeNull();
        expect(findKey).not.toHaveBeenCalled();
    });
});
