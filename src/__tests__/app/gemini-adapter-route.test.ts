import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const handle = vi.fn();
vi.mock('@/lib/gemini-adapter/adapter', () => ({ handleGeminiAdapter: (...args: unknown[]) => handle(...args) }));
import { POST } from '@/app/gemini-adapter/[provider]/[...path]/route';

beforeEach(() => {
    handle.mockReset().mockResolvedValue(NextResponse.json({ ok: true }));
    vi.stubEnv('PORTAL_GEMINI_ADAPTER_ENABLED', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('internal Gemini adapter rollout boundary', () => {
    function request(path = ['v1beta', 'models', 'gemini-3-pro-image:generateContent']) {
        const req = new NextRequest('http://portal.test/gemini-adapter/yobox/' + path.join('/'), {
            method: 'POST',
            body: '{invalid',
        });
        const read = vi.spyOn(req, 'text');
        return { req, read, ctx: { params: Promise.resolve({ provider: 'yobox', path }) } };
    }

    it.each(['', 'false', 'TRUE'])('disabled value %s rejects before reading or forwarding the body', async (value) => {
        vi.stubEnv('PORTAL_GEMINI_ADAPTER_ENABLED', value);
        const { req, read, ctx } = request();
        expect((await POST(req, ctx)).status).toBe(503);
        expect(read).not.toHaveBeenCalled();
        expect(handle).not.toHaveBeenCalled();
    });

    it('explicit opt-in dispatches the validated route once', async () => {
        vi.stubEnv('PORTAL_GEMINI_ADAPTER_ENABLED', 'true');
        const { req, ctx } = request();
        expect((await POST(req, ctx)).status).toBe(200);
        expect(handle).toHaveBeenCalledExactlyOnceWith(req, 'yobox', 'gemini-3-pro-image', 'generateContent');
    });

    it.each([
        ['v1', 'models', 'gemini-3-pro-image:generateContent'],
        ['v1beta', 'models', '%ZZ:generateContent'],
    ])('rejects malformed route %j without forwarding', async (...path) => {
        vi.stubEnv('PORTAL_GEMINI_ADAPTER_ENABLED', 'true');
        const { req, ctx } = request(path);
        expect([400, 404]).toContain((await POST(req, ctx)).status);
        expect(handle).not.toHaveBeenCalled();
    });
});
