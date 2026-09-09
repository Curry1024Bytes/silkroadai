import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const adapter = vi.hoisted(() => vi.fn());
vi.mock('../adapter', () => ({ handleAdapter25Image: adapter }));

import { POST as generate } from '@/app/image-adapter25/[provider]/v1/images/generations/route';
import { POST as edit } from '@/app/image-adapter25/[provider]/v1/images/edits/route';

beforeEach(() => {
    adapter.mockReset();
    vi.stubEnv('PORTAL_IMAGE_ADAPTER25_ENABLED', undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe.each([
    ['generations', generate],
    ['edits', edit],
] as const)('Image 2.5 %s release gate', (mode, handler) => {
    const ctx = () => ({ params: Promise.resolve({ provider: 'wetokenasia25' }) });
    const request = () =>
        new NextRequest(`http://portal.test/image-adapter25/wetokenasia25/v1/images/${mode}`, {
            method: 'POST',
            headers: { authorization: 'Bearer provider-test-only', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-image-2.5-flare', prompt: 'test' }),
        });

    it.each([undefined, 'false', '1', 'TRUE'])(
        'setting %s rejects before processing the body or calling upstream',
        async (value) => {
            vi.stubEnv('PORTAL_IMAGE_ADAPTER25_ENABLED', value);
            const req = request();
            const response = await handler(req, ctx());
            expect(response.status).toBe(503);
            const body = await response.json();
            expect(body.error.code).toBe('upstream_unavailable');
            expect(body).not.toHaveProperty('usage');
            expect(req.bodyUsed).toBe(false);
            expect(adapter).not.toHaveBeenCalled();
        },
    );

    it('explicit true delegates the original request and response unchanged', async () => {
        vi.stubEnv('PORTAL_IMAGE_ADAPTER25_ENABLED', 'true');
        const expected = NextResponse.json({ data: [], marker: 'adapter response' });
        adapter.mockResolvedValue(expected);
        const req = request();
        expect(await handler(req, ctx())).toBe(expected);
        expect(adapter).toHaveBeenCalledExactlyOnceWith(req, mode, 'wetokenasia25');
    });
});
