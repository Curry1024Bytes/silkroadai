/**
 * /api/v3 路由分流测试:企业门户实例走 handleEnterpriseArkV3(行为不变);主站只放行视频任务
 * 提交与查询,交给 handleArkNativeVideo,其余一律 404。转发细节见 lib/seedance/__tests__/ark-native.test.ts。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockIsEnterpriseFlavor = vi.fn(() => false);
const mockHandleEnterpriseArkV3 = vi.fn<(...args: unknown[]) => Promise<NextResponse>>(async () =>
    NextResponse.json({ via: 'enterprise' }),
);
vi.mock('@/lib/enterprise/proxy', () => ({
    isEnterpriseFlavor: () => mockIsEnterpriseFlavor(),
    handleEnterpriseArkV3: (...a: unknown[]) => mockHandleEnterpriseArkV3(...a),
}));

const mockHandleArkNativeVideo = vi.fn<(...args: unknown[]) => Promise<NextResponse>>(async () =>
    NextResponse.json({ via: 'native' }),
);
vi.mock('@/lib/seedance/ark-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/seedance/ark-native')>();
    return { ...actual, handleArkNativeVideo: (...a: unknown[]) => mockHandleArkNativeVideo(...a) };
});

import { DELETE, GET, POST } from '../[...path]/route';

beforeEach(() => {
    vi.clearAllMocks();
    mockIsEnterpriseFlavor.mockReturnValue(false);
});

function call(handler: typeof GET, method: string, ...segments: string[]) {
    const req = new NextRequest(`https://api.llmroute.club/api/v3/${segments.join('/')}`, {
        method,
        headers: { authorization: 'Bearer sk-cust', 'content-type': 'application/json' },
        body: method === 'POST' ? '{}' : undefined,
    });
    return handler(req, { params: Promise.resolve({ path: segments }) });
}

describe('/api/v3 主站', () => {
    it('视频任务提交和查询交给原生转发', async () => {
        const r1 = await call(POST, 'POST', 'contents', 'generations', 'tasks');
        expect(await r1.json()).toEqual({ via: 'native' });
        expect(mockHandleArkNativeVideo.mock.calls[0][1]).toEqual({ kind: 'submit' });

        const r2 = await call(GET, 'GET', 'contents', 'generations', 'tasks', 'task_abc');
        expect(await r2.json()).toEqual({ via: 'native' });
        expect(mockHandleArkNativeVideo.mock.calls[1][1]).toEqual({ kind: 'query', taskId: 'task_abc' });
        expect(mockHandleEnterpriseArkV3).not.toHaveBeenCalled();
    });

    it('其余路径 404,不转发', async () => {
        for (const [handler, method, segments] of [
            [POST, 'POST', ['images', 'generations']],
            [GET, 'GET', ['models']],
            [GET, 'GET', ['contents', 'generations', 'tasks']],
            [DELETE, 'DELETE', ['contents', 'generations', 'tasks', 'task_abc']],
        ] as const) {
            const res = await call(handler, method, ...segments);
            expect(res.status).toBe(404);
        }
        expect(mockHandleArkNativeVideo).not.toHaveBeenCalled();
        expect(mockHandleEnterpriseArkV3).not.toHaveBeenCalled();
    });
});

describe('/api/v3 企业门户', () => {
    it('照旧交给 handleEnterpriseArkV3,不走主站转发', async () => {
        mockIsEnterpriseFlavor.mockReturnValue(true);
        const res = await call(POST, 'POST', 'contents', 'generations', 'tasks');
        expect(await res.json()).toEqual({ via: 'enterprise' });
        expect(mockHandleEnterpriseArkV3.mock.calls[0][1]).toBe('/contents/generations/tasks');

        await call(GET, 'GET', 'models');
        expect(mockHandleEnterpriseArkV3.mock.calls[1][1]).toBe('/models');
        expect(mockHandleArkNativeVideo).not.toHaveBeenCalled();
    });
});
