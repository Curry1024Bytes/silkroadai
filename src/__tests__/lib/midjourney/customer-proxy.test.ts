import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { handleCustomerRequest } from '@/lib/midjourney/customer-proxy';

const R2 = 'https://images.silkroadai.io/mj/1';

function customerRequest(path: string, method = 'GET', body?: string): NextRequest {
    return new NextRequest(`https://ai.silkroadai.io/mj/${path}`, {
        method,
        body,
        headers: { Authorization: 'Bearer sk-customer', 'Content-Type': 'application/json' },
    });
}

describe('midjourney customer proxy', () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('restores imageUrls from videoUrls on task fetch', async () => {
        const task = {
            id: '1',
            status: 'SUCCESS',
            imageUrl: `${R2}/grid.webp`,
            videoUrls: [{ url: `${R2}/0.png` }, { url: `${R2}/1.png` }],
        };
        fetchMock.mockResolvedValue(new Response(JSON.stringify(task), { status: 200 }));

        const res = await handleCustomerRequest(customerRequest('task/1/fetch'), ['task', '1', 'fetch']);

        expect(await res.json()).toEqual({
            id: '1',
            status: 'SUCCESS',
            imageUrl: `${R2}/grid.webp`,
            imageUrls: [
                { url: `${R2}/0.png`, thumbnailUrl: `${R2}/0.png` },
                { url: `${R2}/1.png`, thumbnailUrl: `${R2}/1.png` },
            ],
            videoUrls: null,
        });
    });

    it('rewrites every task in list-by-condition', async () => {
        const tasks = [
            { id: '1', videoUrls: [{ url: `${R2}/0.png` }] },
            { id: '2', videoUrls: null },
        ];
        fetchMock.mockResolvedValue(new Response(JSON.stringify(tasks), { status: 200 }));

        const res = await handleCustomerRequest(
            customerRequest('task/list-by-condition', 'POST', '{"ids":["1","2"]}'),
            ['task', 'list-by-condition'],
        );

        const out = (await res.json()) as Array<{ imageUrls: unknown }>;
        expect(out[0].imageUrls).toEqual([{ url: `${R2}/0.png`, thumbnailUrl: `${R2}/0.png` }]);
        expect(out[1].imageUrls).toBeNull();
    });

    it('leaves new-api error bodies intact', async () => {
        const error = { code: 4, description: 'task_no_found' };
        fetchMock.mockResolvedValue(new Response(JSON.stringify(error), { status: 200 }));

        const res = await handleCustomerRequest(customerRequest('task/9/fetch'), ['task', '9', 'fetch']);

        expect(await res.json()).toEqual(error);
    });

    it('passes non-2xx task queries through untouched', async () => {
        fetchMock.mockResolvedValue(new Response('{"error":"invalid token"}', { status: 401 }));

        const res = await handleCustomerRequest(customerRequest('task/1/fetch'), ['task', '1', 'fetch']);

        expect(res.status).toBe(401);
        expect(await res.text()).toBe('{"error":"invalid token"}');
    });

    it('forwards submissions to new-api with the customer key and body', async () => {
        const body = '{"botType":"MID_JOURNEY","prompt":"a boat"}';
        const reply = '{"code":1,"description":"提交成功","result":"42"}';
        fetchMock.mockResolvedValue(new Response(reply, { status: 200 }));

        const res = await handleCustomerRequest(customerRequest('submit/imagine', 'POST', body), ['submit', 'imagine']);

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://localhost:3000/mj/submit/imagine');
        expect(init.method).toBe('POST');
        expect(new TextDecoder().decode(init.body)).toBe(body);
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-customer');
        expect(await res.text()).toBe(reply);
    });
});
