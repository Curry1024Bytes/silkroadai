import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock, uploadImage } = vi.hoisted(() => ({ fetchMock: vi.fn(), uploadImage: vi.fn() }));
vi.mock('@/lib/r2/client', () => ({ uploadImage }));

const regions = [
    {
        region: 'cn',
        model: 'seedance2.5-720p-ref',
        url: 'https://cn.provider.test',
        upstream: 'artsdance-2-5-pro-260801',
    },
    {
        region: 'global',
        model: 'seedance2.5-global-720p-ref',
        url: 'https://intl.provider.test',
        upstream: 'artsdance2-5-intl-260628',
    },
    {
        region: 'promax',
        model: 'seedance2.5-promax-720p-ref',
        url: 'https://intl.provider.test',
        upstream: 'artsdance2-5-intl-260628',
    },
];
const ratioCases: Array<{ label: string; input: Record<string, unknown>; expected: string | undefined }> = [
    { label: '省略 ratio', input: {}, expected: undefined },
    { label: 'null ratio', input: { ratio: null }, expected: undefined },
    { label: '空 ratio', input: { ratio: '' }, expected: undefined },
    { label: 'aspect_ratio 别名', input: { aspect_ratio: '9:16' }, expected: '9:16' },
    { label: 'null ratio 使用别名', input: { ratio: null, aspect_ratio: '9:16' }, expected: '9:16' },
    { label: '空 ratio 明确省略而不读取别名', input: { ratio: '', aspect_ratio: '9:16' }, expected: undefined },
    { label: '显式 adaptive 优先于别名', input: { ratio: 'adaptive', aspect_ratio: '9:16' }, expected: 'adaptive' },
    { label: '非法显式比例保留宽松回退', input: { ratio: '99:99' }, expected: '16:9' },
];

let submitVideoWithKey: typeof import('../cn-adapter').submitVideoWithKey;
beforeEach(async () => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.stubEnv('SEEDANCE_XHK_BASE_URL', 'https://cn.provider.test');
    vi.stubEnv('SEEDANCE_INTL_BASE_URL', 'https://intl.provider.test');
    vi.stubEnv('SEEDANCE_XHK_MODEL_25', 'artsdance-2-5-pro-260801');
    vi.stubEnv('SEEDANCE_PROMAX_MODEL_25', 'artsdance2-5-intl-260628');
    vi.stubEnv('SEEDANCE_GLOBAL_MODEL_25', 'artsdance2-5-intl-260628');
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    uploadImage
        .mockResolvedValueOnce('https://media.test/first.png')
        .mockResolvedValueOnce('https://media.test/last.png');
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
        if (!/^https:\/\/(cn|intl)\.provider\.test\/v1\/video\/generations$/.test(url) || init.method !== 'POST')
            throw new Error('unexpected network request in fixture');
        return new Response(JSON.stringify({ id: 'cgt-ratio-fixture', status: 'pending' }));
    });
    ({ submitVideoWithKey } = await import('../cn-adapter'));
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe.each(regions)('$region 首尾帧任务实际序列化 JSON', ({ model, url, upstream }) => {
    it.each(ratioCases)('$label', async ({ input, expected }) => {
        const res = await submitVideoWithKey(
            {
                model,
                prompt: 'fixture',
                first_frame: 'data:image/png;base64,Zmlyc3Q=',
                last_frame: 'data:image/png;base64,bGFzdA==',
                duration: -1,
                generate_audio: false,
                ...input,
            },
            'Bearer fixture-only',
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ id: 'cgt-ratio-fixture', model, status: 'queued' });
        expect(fetchMock).toHaveBeenCalledOnce();
        const [requestUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(requestUrl).toBe(`${url}/v1/video/generations`);
        expect(init.method).toBe('POST');
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fixture-only');
        expect(typeof init.body).toBe('string');
        const serialized = JSON.parse(init.body as string);
        expect(serialized).toEqual({
            model: upstream,
            prompt: 'fixture',
            resolution: '720p',
            duration: -1,
            generate_audio: false,
            images: [
                { url: 'https://media.test/first.png', role: 'first_frame' },
                { url: 'https://media.test/last.png', role: 'last_frame' },
            ],
            ...(expected === undefined ? {} : { ratio: expected }),
        });
        expect(serialized).not.toHaveProperty('aspect_ratio');
        if (expected === undefined) expect(serialized).not.toHaveProperty('ratio');
        expect(uploadImage).toHaveBeenCalledTimes(2);
    });
});
