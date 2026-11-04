import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { uploadImage } = vi.hoisted(() => ({ uploadImage: vi.fn() }));
vi.mock('@/lib/r2/client', () => ({ uploadImage }));

import { handleAdapterRequest, resetMirrorsForTest, resolveTask, type MjTask } from '@/lib/midjourney/adapter';

const UPSTREAM_IMAGE = 'https://platform.frimodel.com/mj/image/1';

function successTask(overrides: Partial<MjTask> = {}): MjTask {
    return {
        id: '1',
        action: 'IMAGINE',
        status: 'SUCCESS',
        progress: '100%',
        finishTime: Date.now(),
        imageUrl: UPSTREAM_IMAGE,
        imageUrls: [{ url: `${UPSTREAM_IMAGE}?index=0` }, { url: `${UPSTREAM_IMAGE}?index=1` }],
        buttons: [{ label: 'U1', customId: 'MJ::JOB::upsample::1::abc' }],
        ...overrides,
    };
}

function imageResponse(contentType = 'image/png', status = 200): Response {
    return new Response(new Uint8Array([1, 2, 3]), { status, headers: { 'content-type': contentType } });
}

function adapterRequest(path: string, init: { method?: string; body?: string; secret?: string } = {}): NextRequest {
    const { method = 'POST', body, secret = 'sk-upstream' } = init;
    return new NextRequest(`http://localhost:3010/mj-adapter/mj/${path}`, {
        method,
        body,
        headers: secret ? { 'mj-api-secret': secret } : {},
    });
}

describe('midjourney adapter', () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
        fetchMock.mockReset();
        uploadImage.mockReset();
        uploadImage.mockImplementation(async (key: string) => `https://images.silkroadai.io/${key}`);
        vi.stubGlobal('fetch', fetchMock);
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        resetMirrorsForTest();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    describe('resolveTask', () => {
        it('passes through tasks without finished images', async () => {
            const running = { id: '1', status: 'IN_PROGRESS', progress: '40%', imageUrl: '' };
            const failed = { id: '2', status: 'FAILURE', failReason: '执行报错', imageUrl: '' };
            const described = { id: '3', status: 'SUCCESS', imageUrl: '', promptEn: 'a boat' };

            expect(await resolveTask(running)).toBe(running);
            expect(await resolveTask(failed)).toBe(failed);
            expect(await resolveTask(described)).toBe(described);
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('mirrors the grid and singles to R2 and carries singles in videoUrls', async () => {
            fetchMock.mockImplementation(async (url: string) =>
                url === UPSTREAM_IMAGE ? imageResponse('image/webp') : imageResponse('image/png'),
            );

            const out = await resolveTask(successTask());

            expect(out.status).toBe('SUCCESS');
            expect(out.imageUrl).toBe('https://images.silkroadai.io/mj/1/grid.webp');
            expect(out.imageUrls).toBeNull();
            expect(out.videoUrls).toEqual([
                { url: 'https://images.silkroadai.io/mj/1/0.png' },
                { url: 'https://images.silkroadai.io/mj/1/1.png' },
            ]);
            expect(out.buttons).toEqual(successTask().buttons);
        });

        it('handles upscale tasks that only have imageUrl', async () => {
            fetchMock.mockResolvedValue(imageResponse());

            const out = await resolveTask(successTask({ imageUrls: null }));

            expect(out.imageUrl).toBe('https://images.silkroadai.io/mj/1/grid.png');
            expect(out.videoUrls).toBeNull();
        });

        it('does not re-download a task it already mirrored', async () => {
            fetchMock.mockImplementation(async () => imageResponse());

            await resolveTask(successTask());
            const calls = fetchMock.mock.calls.length;
            await resolveTask(successTask());

            expect(fetchMock).toHaveBeenCalledTimes(calls);
        });

        it('holds the task in progress while a mirror failure can still recover', async () => {
            fetchMock.mockResolvedValue(imageResponse('image/png', 403));

            const out = await resolveTask(successTask());

            expect(out).toMatchObject({
                status: 'IN_PROGRESS',
                progress: '99%',
                finishTime: 0,
                imageUrl: '',
                imageUrls: null,
                buttons: [],
            });
        });

        it('retries a failed mirror on the next poll', async () => {
            fetchMock.mockResolvedValueOnce(imageResponse('image/png', 500));
            fetchMock.mockImplementation(async () => imageResponse());

            expect((await resolveTask(successTask({ imageUrls: null }))).status).toBe('IN_PROGRESS');
            expect((await resolveTask(successTask({ imageUrls: null }))).status).toBe('SUCCESS');
        });

        it('rejects non-image upstream responses instead of storing them', async () => {
            fetchMock.mockResolvedValue(imageResponse('text/html'));

            expect((await resolveTask(successTask())).status).toBe('IN_PROGRESS');
            expect(uploadImage).not.toHaveBeenCalled();
        });

        it('falls back to upstream urls once the mirror has failed for too long', async () => {
            uploadImage.mockRejectedValue(new Error('r2 down'));
            fetchMock.mockImplementation(async () => imageResponse());

            const out = await resolveTask(successTask({ finishTime: Date.now() - 4 * 60_000 }));

            expect(out.status).toBe('SUCCESS');
            expect(out.imageUrl).toBe(UPSTREAM_IMAGE);
            expect(out.videoUrls).toEqual([{ url: `${UPSTREAM_IMAGE}?index=0` }, { url: `${UPSTREAM_IMAGE}?index=1` }]);
        });

        it('stops waiting before the new-api poll timeout when a mirror is slow', async () => {
            vi.useFakeTimers();
            fetchMock.mockReturnValue(new Promise(() => {}));

            const pending = resolveTask(successTask());
            await vi.advanceTimersByTimeAsync(10_000);

            expect((await pending).status).toBe('IN_PROGRESS');
        });
    });

    describe('handleAdapterRequest', () => {
        it('rejects requests without a channel key', async () => {
            const res = await handleAdapterRequest(adapterRequest('submit/imagine', { secret: '' }), [
                'submit',
                'imagine',
            ]);

            expect(res.status).toBe(401);
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('forwards submissions verbatim with the channel key as a bearer token', async () => {
            const body = JSON.stringify({ botType: 'MID_JOURNEY', prompt: 'a boat' });
            const reply = JSON.stringify({ code: 1, description: '提交成功', result: '42' });
            fetchMock.mockResolvedValue(new Response(reply, { status: 200 }));

            const res = await handleAdapterRequest(adapterRequest('submit/imagine', { body }), ['submit', 'imagine']);

            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toBe('https://api.frimodel.com/mj/submit/imagine');
            expect(init.method).toBe('POST');
            expect(init.body).toBe(body);
            expect(init.headers.Authorization).toBe('Bearer sk-upstream');
            expect(await res.text()).toBe(reply);
        });

        it('preserves upstream error statuses on submissions', async () => {
            fetchMock.mockResolvedValue(new Response('{"code":4,"description":"quota_not_enough"}', { status: 403 }));

            const res = await handleAdapterRequest(adapterRequest('submit/imagine', { body: '{}' }), [
                'submit',
                'imagine',
            ]);

            expect(res.status).toBe(403);
        });

        it('maps upstream network failures to 502', async () => {
            vi.spyOn(console, 'error').mockImplementation(() => {});
            fetchMock.mockRejectedValue(new Error('socket hang up'));

            const res = await handleAdapterRequest(adapterRequest('submit/imagine', { body: '{}' }), [
                'submit',
                'imagine',
            ]);

            expect(res.status).toBe(502);
        });

        it('rewrites finished tasks on the new-api poll path', async () => {
            const tasks = [{ id: '7', status: 'IN_PROGRESS', progress: '40%', imageUrl: '' }, successTask()];
            fetchMock.mockImplementation(async (url: string) =>
                url.endsWith('/list-by-condition')
                    ? new Response(JSON.stringify(tasks), { status: 200 })
                    : imageResponse(),
            );

            const res = await handleAdapterRequest(
                adapterRequest('task/list-by-condition', { body: '{"ids":["7","1"]}' }),
                ['task', 'list-by-condition'],
            );

            const out = (await res.json()) as MjTask[];
            expect(out[0].status).toBe('IN_PROGRESS');
            expect(out[1].imageUrl).toBe('https://images.silkroadai.io/mj/1/grid.png');
        });

        it('surfaces upstream poll failures so new-api retries', async () => {
            fetchMock.mockResolvedValue(new Response('{"message":"invalid key"}', { status: 401 }));

            const res = await handleAdapterRequest(adapterRequest('task/list-by-condition', { body: '{"ids":[]}' }), [
                'task',
                'list-by-condition',
            ]);

            expect(res.status).toBe(401);
        });

        it('fails the poll on a malformed upstream body rather than guessing', async () => {
            vi.spyOn(console, 'error').mockImplementation(() => {});
            fetchMock.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 200 }));

            const res = await handleAdapterRequest(adapterRequest('task/list-by-condition', { body: '{"ids":[]}' }), [
                'task',
                'list-by-condition',
            ]);

            expect(res.status).toBe(502);
        });
    });
});
