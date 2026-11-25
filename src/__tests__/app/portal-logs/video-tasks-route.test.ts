import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { session, query, fetchMedia } = vi.hoisted(() => ({ session: vi.fn(), query: vi.fn(), fetchMedia: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: session }));
vi.mock('@/lib/sd-special-video-delivery', () => ({ getSdVideoDeliveryPool: () => ({ query }) }));

import { GET, HEAD } from '@/app/api/portal/video-tasks/[taskId]/[[...content]]/route';

const taskId = `task_${'s'.repeat(32)}`;
const path = `https://llmroute.club/api/portal/video-tasks/${taskId}`;
const taskRow = {
    task_id: taskId,
    owner_id: 21,
    model: 'sd-2-mini-480-novideo',
    status: 'SUCCESS',
    progress: '100%',
    submit_time: 100,
    finish_time: 131,
    output_seconds: null,
    output_resolution: null,
    output_ratio: null,
    request_summary: { duration: 4, ratio: '16:9', has_video: false, prompt: 'private', url: 'secret' },
    result_url: `http://localhost:3000/v1/videos/${taskId}/content`,
    media_url: 'https://oss.aigasapi.com/video.mp4?private=signature',
};

function context(content?: string[], id = taskId) {
    return { params: Promise.resolve({ taskId: id, content }) };
}

function fileRequest(method = 'GET') {
    return new NextRequest(`${path}/content?download=1`, {
        method,
        headers: { Range: 'bytes=0-2', Cookie: 'test-session', Authorization: 'Bearer omit-me' },
    });
}

beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('fetch', fetchMedia);
    vi.stubEnv('NEWAPI_BASE_URL', 'http://new-api:3000');
    session.mockResolvedValue({ status: 'active', newapi_user_id: 21 });
    query.mockResolvedValue({ rows: [taskRow] });
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('owned video task detail and playback', () => {
    it('rejects missing or inactive sessions before looking up the file', async () => {
        session.mockResolvedValueOnce(null).mockResolvedValueOnce({ status: 'disabled', newapi_user_id: 21 });
        expect((await GET(fileRequest(), context(['content']))).status).toBe(401);
        expect((await GET(fileRequest(), context(['content']))).status).toBe(401);
        expect(query).not.toHaveBeenCalled();
        expect(fetchMedia).not.toHaveBeenCalled();
    });

    it('requires owned and unambiguous tasks', async () => {
        query
            .mockResolvedValueOnce({ rows: [{ ...taskRow, owner_id: 22 }] })
            .mockResolvedValueOnce({ rows: [taskRow, taskRow] });
        expect((await GET(fileRequest(), context(['content']))).status).toBe(404);
        expect((await GET(fileRequest(), context(['content']))).status).toBe(404);
        expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE owner_id = $1'), [21, [taskId]]);
        expect(fetchMedia).not.toHaveBeenCalled();
    });

    it('reports in-progress work without treating billing seconds as a finished file', async () => {
        query.mockResolvedValue({
            rows: [{ ...taskRow, status: 'IN_PROGRESS', progress: '42%', output_seconds: '4' }],
        });
        const response = await GET(new NextRequest(path), context());
        expect(await response.json()).toEqual({
            task: {
                status: 'in_progress',
                progress: 42,
                submittedAt: 100,
                finishedAt: null,
                elapsedSec: null,
                outputSeconds: null,
                outputResolution: null,
                outputRatio: null,
                mediaAvailable: false,
                request: { duration: 4, ratio: '16:9', hasVideo: false },
            },
        });
        expect((await GET(fileRequest(), context(['content']))).status).toBe(409);
        expect(fetchMedia).not.toHaveBeenCalled();
    });

    it('reads actual MP4 duration and returns only public fields', async () => {
        const mp4 = Buffer.alloc(36);
        mp4.writeUInt32BE(36, 0);
        mp4.write('moov', 4);
        mp4.writeUInt32BE(28, 8);
        mp4.write('mvhd', 12);
        mp4.writeUInt32BE(1000, 28);
        mp4.writeUInt32BE(4125, 32);
        fetchMedia.mockResolvedValue(
            new Response(new Uint8Array(mp4), {
                status: 206,
                headers: { 'Content-Type': 'video/mp4' },
            }),
        );
        const result = await GET(new NextRequest(path), context());
        const json = await result.text();
        expect(JSON.parse(json)).toMatchObject({ task: { status: 'completed', elapsedSec: 31, outputSeconds: 4.125 } });
        expect(json).not.toMatch(/prompt|signature|secret|oss\.aigas/);
        expect(fetchMedia).toHaveBeenCalledWith(
            expect.stringContaining('https://oss.aigasapi.com/'),
            expect.objectContaining({ redirect: 'error', headers: { Range: 'bytes=0-262143' } }),
        );
    });

    it('streams partial content and strips credentials, origin URLs and upstream headers', async () => {
        fetchMedia.mockResolvedValue(
            new Response('mp4', {
                status: 206,
                headers: {
                    'Content-Type': 'video/mp4',
                    'Content-Range': 'bytes 0-2/80',
                    'Set-Cookie': 'upstream=ignored',
                },
            }),
        );
        const response = await GET(fileRequest(), context(['content']));
        expect(response.status).toBe(206);
        expect(await response.text()).toBe('mp4');
        expect(response.headers.get('Content-Range')).toBe('bytes 0-2/80');
        expect(response.headers.get('Content-Disposition')).toBe(`attachment; filename="${taskId}.mp4"`);
        expect(response.headers.get('Set-Cookie')).toBeNull();
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        const [url, options] = fetchMedia.mock.calls[0];
        expect(url.origin).toBe('https://oss.aigasapi.com');
        expect(Object.fromEntries(options.headers)).toEqual({ range: 'bytes=0-2' });
        expect(options.redirect).toBe('error');
    });

    it.each(['http://127.0.0.1:3000/admin', 'https://oss.aigasapi.com.evil.invalid/clip', 'file:///clip.mp4'])(
        'rejects untrusted result location %s',
        async (url) => {
            query.mockResolvedValue({ rows: [{ ...taskRow, media_url: url }] });
            expect((await GET(fileRequest(), context(['content']))).status).toBe(410);
            expect(fetchMedia).not.toHaveBeenCalled();
        },
    );

    it('supports HEAD, expiry and invalid media ranges', async () => {
        fetchMedia
            .mockResolvedValueOnce(new Response(null, { headers: { 'Content-Type': 'video/mp4' } }))
            .mockResolvedValueOnce(new Response(null, { status: 403 }))
            .mockResolvedValueOnce(new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */80' } }));
        const head = await HEAD(fileRequest('HEAD'), context(['content']));
        expect(head.status).toBe(200);
        expect(head.body).toBeNull();
        expect((await GET(fileRequest(), context(['content']))).status).toBe(410);
        const range = await GET(fileRequest(), context(['content']));
        expect(range.status).toBe(416);
        expect(range.headers.get('Content-Range')).toBe('bytes */80');
    });
});
