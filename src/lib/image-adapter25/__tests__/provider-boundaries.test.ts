import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { handleAdapter25Image, type ImageMode } from '../adapter';
import { handleAdapter25Request } from '../entrypoint';

const fetchMock = vi.fn();
beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

function png() {
    const buffer = Buffer.alloc(26);
    buffer.set([0x89, 0x50, 0x4e, 0x47]);
    buffer.write('IHDR', 12, 'latin1');
    buffer.writeUInt32BE(1024, 16);
    buffer.writeUInt32BE(1024, 20);
    buffer[24] = 8;
    buffer[25] = 6;
    return buffer;
}

function request(provider: string, mode: ImageMode, quality: string) {
    const body = new FormData();
    for (const [key, value] of Object.entries({
        model: 'gpt-image-2.5-sunburst',
        prompt: 'fixture',
        size: '1024x1024',
        quality,
    }))
        body.set(key, value);
    if (mode === 'edits') body.set('image', new Blob([new Uint8Array(png())], { type: 'image/png' }), 'fixture.png');
    return new NextRequest(`http://portal.test/image-adapter25/${provider}/v1/images/${mode}`, {
        method: 'POST',
        headers: { authorization: 'Bearer provider-fixture-only' },
        body,
    });
}

describe.each(['llmway25', 'ominiapi25'])('%s release gate', (provider) => {
    it.each([
        ['generations', undefined],
        ['generations', 'false'],
        ['generations', '1'],
        ['generations', 'TRUE'],
        ['edits', undefined],
        ['edits', 'false'],
        ['edits', '1'],
        ['edits', 'TRUE'],
    ] as const)('%s with setting %s rejects before body processing or fetch', async (mode, setting) => {
        vi.stubEnv('PORTAL_IMAGE_ADAPTER25_ENABLED', setting);
        const req = request(provider, mode, 'max');
        const response = await handleAdapter25Request(req, mode, provider);
        expect(response.status).toBe(503);
        const body = await response.json();
        expect(body.error.code).toBe('upstream_unavailable');
        expect(body).not.toHaveProperty('usage');
        expect(body).not.toHaveProperty('data');
        expect(req.bodyUsed).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('Image 2.5 multipart provider quality boundaries', () => {
    it.each([
        ['llmway25', 'generations', ' XHIGH '],
        ['llmway25', 'edits', ' MAX '],
    ] as const)('%s / %s rejects unserved quality %s without calling upstream', async (provider, mode, quality) => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: png().toString('base64') }] })));
        const response = await handleAdapter25Image(request(provider, mode, quality), mode, provider);
        expect(response.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
        const body = await response.json();
        expect(body.error.code).toBe('upstream_unavailable');
        expect(body).not.toHaveProperty('usage');
        expect(body).not.toHaveProperty('data');
        expect(body.error.message).not.toMatch(/llmway|omini|quality/i);
    });

    it.each([
        ['generations', 'auto'],
        ['edits', ' AUTO '],
        ['generations', ''],
        ['edits', ''],
    ] as const)('ominiapi25 / %s accepts multipart quality %s and bills normalized low', async (mode, quality) => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: png().toString('base64') }] })));
        const response = await handleAdapter25Image(request('ominiapi25', mode, quality), mode, 'ominiapi25');
        expect(response.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`https://www.ominiapi.com/v1/images/${mode}`);
        if (mode === 'edits') {
            const sent = init.body as FormData;
            expect(sent).toBeInstanceOf(FormData);
            expect(sent.get('model')).toBe('gpt-image-2.5-sunburst');
            if (quality.trim()) expect(sent.get('quality')).toBe('auto');
            else expect(sent.has('quality')).toBe(false);
            expect(sent.getAll('image')).toHaveLength(1);
            expect(Buffer.from(await (sent.get('image') as Blob).arrayBuffer())).toEqual(png());
        } else {
            const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
            expect(sent.model).toBe('gpt-image-2.5-sunburst');
            if (quality.trim()) expect(sent.quality).toBe('auto');
            else expect(sent).not.toHaveProperty('quality');
            expect(sent).not.toHaveProperty('image');
        }
        expect(await response.json()).toMatchObject({ quality: 'low', usage: { output_tokens: 196 } });
    });

    it.each(['llmway25', 'ominiapi25'])(
        '%s keeps malformed quality a terminal 400 before provider fallback',
        async (provider) => {
            const response = await handleAdapter25Image(request(provider, 'edits', ' ULTRA '), 'edits', provider);
            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({ error: { code: 'invalid_request', param: 'quality' } });
            expect(fetchMock).not.toHaveBeenCalled();
        },
    );

    it.each([
        ['llmway25', ' HIGH ', 'https://llmway.ai/v1/images/edits', 1756],
        ['ominiapi25', ' MAX ', 'https://www.ominiapi.com/v1/images/edits', 7024],
    ] as const)(
        '%s accepts multipart edits quality %s and preserves the upload',
        async (provider, quality, url, tokens) => {
            fetchMock.mockResolvedValue(
                new Response(JSON.stringify({ data: [{ b64_json: png().toString('base64') }] })),
            );
            const response = await handleAdapter25Image(request(provider, 'edits', quality), 'edits', provider);
            expect(response.status).toBe(200);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [actualUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
            expect(actualUrl).toBe(url);
            const sent = init.body as FormData;
            expect(sent.get('quality')).toBe(quality.trim().toLowerCase());
            expect(sent.get('model')).toBe('gpt-image-2.5-sunburst');
            expect(sent.getAll('image')).toHaveLength(1);
            expect(Buffer.from(await (sent.get('image') as Blob).arrayBuffer())).toEqual(png());
            expect(await response.json()).toMatchObject({
                quality: quality.trim().toLowerCase(),
                usage: { output_tokens: tokens },
            });
        },
    );
});
