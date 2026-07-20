/**
 * /tools/seedance 三个同源转发路由的守护测试(2026-07-20):
 * 必须转发到 portal 自身 /v1 代理(127.0.0.1:3002),【绝不能】直连 new-api ——
 * seedance-cn 模型的拦截/档次门控/适配器自扣计费都在代理层,直连会绕过计费并触发
 * 无价模型默认预扣(见 tools-proxy-base.ts)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { POST as SUBMIT } from '@/app/api/tools/seedance/submit/route';
import { GET as POLL } from '@/app/api/tools/seedance/poll/[id]/route';
import { GET as MODELS } from '@/app/api/tools/seedance/models/route';

const mockFetch = vi.fn();

beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

const AUTH = { Authorization: 'Bearer sk-test' };

describe('tools/seedance 转发目标 = portal /v1 代理(不是 new-api)', () => {
    it('submit → POST http://127.0.0.1:3002/v1/video/generations', async () => {
        const req = new NextRequest('https://x/api/tools/seedance/submit', {
            method: 'POST',
            headers: { ...AUTH, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'seedance2.0-fast-1080p-ref', prompt: 'p' }),
        });
        const res = await SUBMIT(req);
        expect(res.status).toBe(200);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch.mock.calls[0][0]).toBe('http://127.0.0.1:3002/v1/video/generations');
    });

    it('poll → GET http://127.0.0.1:3002/v1/video/generations/{id}', async () => {
        const req = new NextRequest('https://x/api/tools/seedance/poll/task-1', { headers: AUTH });
        const res = await POLL(req, { params: Promise.resolve({ id: 'task-1' }) });
        expect(res.status).toBe(200);
        expect(mockFetch.mock.calls[0][0]).toBe('http://127.0.0.1:3002/v1/video/generations/task-1');
    });

    it('models → GET http://127.0.0.1:3002/v1/models', async () => {
        mockFetch.mockResolvedValue(
            new Response(JSON.stringify({ data: [{ id: 'seedance2.0-pro-720p' }] }), { status: 200 }),
        );
        const req = new NextRequest('https://x/api/tools/seedance/models', { headers: AUTH });
        const res = await MODELS(req);
        expect(res.status).toBe(200);
        expect(mockFetch.mock.calls[0][0]).toBe('http://127.0.0.1:3002/v1/models');
        expect(await res.json()).toEqual({ models: ['seedance2.0-pro-720p'] });
    });

    it('无 Authorization → 401,不发任何上游请求', async () => {
        const req = new NextRequest('https://x/api/tools/seedance/submit', { method: 'POST', body: '{}' });
        expect((await SUBMIT(req)).status).toBe(401);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
