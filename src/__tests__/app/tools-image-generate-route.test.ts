import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/tools/image/generate/route';

const mockFetch = vi.fn();
const TASK_ID = 'a'.repeat(32);

beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch as typeof fetch;
});

function postReq(body: Record<string, unknown>, withKey = true): NextRequest {
    return new NextRequest('https://llmroute.club/api/tools/image/generate', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...(withKey ? { authorization: 'Bearer sk-test' } : {}),
        },
        body: JSON.stringify(body),
    });
}

function queryReq(taskId: string, withKey = true): NextRequest {
    return new NextRequest(`https://llmroute.club/api/tools/image/generate?task_id=${taskId}`, {
        headers: withKey ? { authorization: 'Bearer sk-test' } : {},
    });
}

describe('/api/tools/image/generate', () => {
    it('requires a key before submitting or querying a paid task', async () => {
        expect((await POST(postReq({ model: 'gpt-image-2', prompt: 'cat' }, false))).status).toBe(401);
        expect((await GET(queryReq(TASK_ID, false))).status).toBe(401);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('submits generations asynchronously and returns the task id without waiting for an image', async () => {
        mockFetch.mockResolvedValueOnce(
            Response.json({ code: 'success', data: { task_id: TASK_ID, status: 'IN_PROGRESS' } }),
        );
        const body = { model: 'gpt-image-2.5-sunburst', prompt: '小猫吃鱼' };
        const res = await POST(postReq(body));
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.json()).toMatchObject({ data: { task_id: TASK_ID, status: 'IN_PROGRESS' } });
        expect(mockFetch).toHaveBeenCalledWith('http://127.0.0.1:3002/v1/images/generations?async=true', {
            method: 'POST',
            headers: { Authorization: 'Bearer sk-test', 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    });

    it('submits image edits to the asynchronous edits endpoint', async () => {
        mockFetch.mockResolvedValueOnce(
            Response.json({ code: 'success', data: { task_id: TASK_ID, status: 'IN_PROGRESS' } }),
        );
        await POST(postReq({ model: 'gpt-image-2', prompt: 'edit', image: 'data:image/png;base64,QUJD' }));
        expect(mockFetch.mock.calls[0][0]).toBe('http://127.0.0.1:3002/v1/images/edits?async=true');
    });

    it('rejects malformed task ids without calling the backend', async () => {
        expect((await GET(queryReq('../other'))).status).toBe(400);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('queries the same user task and preserves an inline image fallback', async () => {
        const result = {
            code: 'success',
            data: { status: 'SUCCESS', data: { data: [{ url: 'data:image/png;base64,QUJD' }] } },
        };
        mockFetch.mockResolvedValueOnce(Response.json(result));
        const res = await GET(queryReq(TASK_ID));
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.json()).toEqual(result);
        expect(mockFetch).toHaveBeenCalledWith(`http://127.0.0.1:3002/v1/images/tasks/${TASK_ID}`, {
            headers: { Authorization: 'Bearer sk-test' },
            cache: 'no-store',
        });
    });

    it('preserves backend authorization errors on result lookup', async () => {
        mockFetch.mockResolvedValueOnce(Response.json({ code: 'unauthorized' }, { status: 401 }));
        const res = await GET(queryReq(TASK_ID));
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ code: 'unauthorized' });
    });
});
