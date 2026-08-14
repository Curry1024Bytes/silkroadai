/**
 * Seedance 国内企业级端口 适配器单测(火山方舟 / token.xinhankr.com)。
 * 覆盖:档位→上游单模型+resolution 映射、参考模式门控(防串档)、data URL 转 R2、
 * duration/ratio 归一、提交/轮询信封、成片转存 R2、model/prompt 校验。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockUploadImage = vi.fn(
    async (key: string, _body?: Buffer, _ct?: string) => `https://images.silkroadai.io/${key}`,
);
vi.mock('@/lib/r2/client', () => ({
    uploadImage: (key: string, body: Buffer, ct?: string) => mockUploadImage(key, body, ct),
}));

import { submitVideo, pollVideo } from '../cn-adapter';

const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

const UP = 'https://token.xinhankr.com';
const INTL = 'https://ai.artsmcp.com';
const mockFetch = vi.fn();
beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        const u = String(url);
        const method = (init?.method || 'GET').toUpperCase();
        if ((u === `${UP}/v1/video/generations` || u === `${INTL}/v1/video/generations`) && method === 'POST') {
            return json({ id: 'cgt-test-1', task_id: 'cgt-test-1', object: 'video.generation', status: 'pending' });
        }
        if (/\/v1\/video\/generations\/[^/]+$/.test(u) && method === 'GET') {
            return json({
                id: 'cgt-test-1',
                status: 'completed',
                data: [{ url: `${UP}/out/generated.mp4?auth_key=xyz` }],
                usage: { completion_tokens: 108872, total_tokens: 108872 },
            });
        }
        // 其余(客户图床 / 成片下载)→ 返回字节
        return new Response(Buffer.from([0x00, 0x00, 0x00, 0x18]), {
            status: 200,
            headers: { 'content-type': /\.mp4/i.test(u) ? 'video/mp4' : 'image/jpeg' },
        });
    });
    global.fetch = mockFetch as typeof fetch;
});

function makeReq(body: unknown, auth = 'Bearer sk-9066test'): NextRequest {
    return new NextRequest('https://ai.silkroadai.io/seedance-cn-adapter/v1/videos', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth },
        body: JSON.stringify(body),
    });
}
function pollReq(auth = 'Bearer sk-9066test'): NextRequest {
    return new NextRequest('https://ai.silkroadai.io/seedance-cn-adapter/v1/videos/cgt-test-1', {
        method: 'GET',
        headers: { authorization: auth },
    });
}
/** 取打到上游 submit 的请求体。 */
function submitBody(): Record<string, unknown> {
    const call = mockFetch.mock.calls.find(
        (c) => String(c[0]) === `${UP}/v1/video/generations` && (c[1] as RequestInit)?.method === 'POST',
    );
    if (!call) throw new Error('no upstream submit call');
    return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
}

describe('seedance-cn adapter submit', () => {
    it('文生(无参考档):映射到上游单模型 + resolution,不带 images', async () => {
        const res = await submitVideo(makeReq({ model: 'seedance2.0-pro-1080p', prompt: '一只猫在雪地里' }));
        expect(res.status).toBe(200);
        const j = (await res.json()) as Record<string, unknown>;
        expect(j.task_id).toBe('cgt-test-1');
        expect(j.model).toBe('seedance2.0-pro-1080p');
        const b = submitBody();
        expect(b.model).toBe('artsdance-2-0-pro-260801');
        expect(b.resolution).toBe('1080p');
        expect(b.images).toBeUndefined();
        expect(b.generate_audio).toBe(true);
    });

    it('未知模型 → 400 model_not_found', async () => {
        const res = await submitVideo(makeReq({ model: 'seedance2.0-pro-8k', prompt: 'x' }));
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('model_not_found');
    });

    it('fast/mini 变体(2026-07-19):按档映射到各自上游模型 id', async () => {
        let res = await submitVideo(makeReq({ model: 'seedance2.0-fast-720p', prompt: '一只猫' }));
        expect(res.status).toBe(200);
        expect(submitBody().model).toBe('artsdance-2-0-fast-260801');
        expect(submitBody().resolution).toBe('720p');

        mockFetch.mockClear(); // 只清调用记录,mockImplementation 仍在
        res = await submitVideo(makeReq({ model: 'seedance2.0-mini-1080p', prompt: '一只猫' }));
        expect(res.status).toBe(200);
        expect(submitBody().model).toBe('artsdance-2-0-mini-260801');
        expect(submitBody().resolution).toBe('1080p');
    });

    it('fast/mini 无 4k 档:seedance2.0-fast-4k → 400', async () => {
        const res = await submitVideo(makeReq({ model: 'seedance2.0-fast-4k', prompt: 'x' }));
        expect(res.status).toBe(400);
    });

    it('缺 prompt → 400', async () => {
        const res = await submitVideo(makeReq({ model: 'seedance2.0-pro-720p' }));
        expect(res.status).toBe(400);
    });

    it('无参考档带图 → 400 text-only(防串便宜档)', async () => {
        const res = await submitVideo(
            makeReq({ model: 'seedance2.0-pro-720p', prompt: 'x', image: 'https://img/a.png' }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/text-only/);
    });

    it('参考档不带任何输入 → 400 requires reference', async () => {
        const res = await submitVideo(makeReq({ model: 'seedance2.0-pro-720p-ref', prompt: 'x' }));
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/requires a reference/);
    });

    it('参考档 data URL 图 → 转存 R2 + role=reference_image', async () => {
        const dataUrl = 'data:image/png;base64,aGVsbG8=';
        const res = await submitVideo(
            makeReq({ model: 'seedance2.0-pro-4k-ref', prompt: '参考图生视频', image_url: dataUrl }),
        );
        expect(res.status).toBe(200);
        expect(mockUploadImage).toHaveBeenCalled();
        const b = submitBody();
        expect(b.resolution).toBe('4k');
        const images = b.images as Array<{ url: string; role: string }>;
        expect(images).toHaveLength(1);
        expect(images[0].role).toBe('reference_image');
        expect(images[0].url).toMatch(/^https:\/\/images\.silkroadai\.io\/seedance-cn-ref\//);
    });

    it('参考档 http 图直链 → 国内档原样透传上游(不转存)', async () => {
        const res = await submitVideo(
            makeReq({ model: 'seedance2.0-pro-720p-ref', prompt: 'x', image: 'https://cdn/a.png' }),
        );
        expect(res.status).toBe(200);
        const images = submitBody().images as Array<{ url: string; role: string }>;
        expect(images[0].url).toBe('https://cdn/a.png');
        expect(mockUploadImage).not.toHaveBeenCalled(); // 国内档不转存
    });

    it('海外档(promax)http 输入图 → 转存 Cloudflare R2(避免海外上游跨境拉国内图超时)', async () => {
        // submitBody 取 INTL base 的 submit;为此 promax 用的是 ai.artsmcp.com
        const res = await submitVideo(
            makeReq({ model: 'seedance2.0-promax-720p-ref', prompt: 'x', image: 'https://res.popreels.cn/a/b/c.png' }),
        );
        expect(res.status).toBe(200);
        // 转存到 R2(seedance-input/ 前缀)
        expect(mockUploadImage).toHaveBeenCalledWith(
            expect.stringMatching(/^seedance-input\//),
            expect.any(Buffer),
            expect.any(String),
        );
        // 上游拿到的是我们 R2 URL,不是原国内 CDN
        const call = mockFetch.mock.calls.find(
            (c) => String(c[0]) === `${INTL}/v1/video/generations` && (c[1] as RequestInit)?.method === 'POST',
        );
        const b = JSON.parse(String((call![1] as RequestInit).body)) as {
            images: Array<{ url: string }>;
        };
        expect(b.images[0].url).toMatch(/^https:\/\/images\.silkroadai\.io\/seedance-input\//);
        expect(b.images[0].url).not.toMatch(/popreels/);
    });

    it('reference_mode start_end → 首尾帧角色', async () => {
        const res = await submitVideo(
            makeReq({
                model: 'seedance2.0-pro-720p-ref',
                prompt: 'x',
                images: ['https://cdn/1.png', 'https://cdn/2.png'],
                video_config: { reference_mode: 'start_end' },
            }),
        );
        expect(res.status).toBe(200);
        const images = submitBody().images as Array<{ url: string; role: string }>;
        expect(images.map((i) => i.role)).toEqual(['first_frame', 'last_frame']);
    });

    it('参考音频:ref 档 + 图 + audio_url → 上游带 audios', async () => {
        const res = await submitVideo(
            makeReq({
                model: 'seedance2.0-pro-720p-ref',
                prompt: '让画中人跟着音乐节奏点头',
                image: 'https://cdn/a.png',
                audio_url: 'https://cdn/track.mp3',
            }),
        );
        expect(res.status).toBe(200);
        const b = submitBody();
        expect((b.images as unknown[]).length).toBe(1);
        expect(b.audios).toEqual(['https://cdn/track.mp3']);
    });

    it('音频但没图 → 400(音频需配 ≥1 图)', async () => {
        const res = await submitVideo(
            makeReq({ model: 'seedance2.0-pro-720p-ref', prompt: 'x', audio_url: 'https://cdn/track.mp3' }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/audio requires/);
    });

    it('duration 合法值透传;ratio 白名单外回落 16:9;generate_audio:false 关', async () => {
        await submitVideo(
            makeReq({
                model: 'seedance2.0-pro-720p',
                prompt: 'x',
                duration: 10,
                ratio: '7:3',
                generate_audio: false,
            }),
        );
        const b = submitBody();
        expect(b.duration).toBe(10);
        expect(b.ratio).toBe('16:9');
        expect(b.generate_audio).toBe(false);
    });

    it('global 长名 → 打海外 base(ai.artsmcp.com)+ 上游 intl 模型名', async () => {
        const res = await submitVideo(makeReq({ model: 'seedance2.0-global-mini-720p', prompt: 'x', duration: 5 }));
        expect(res.status).toBe(200);
        const call = mockFetch.mock.calls.find((c) => String(c[0]).startsWith(INTL));
        expect(call).toBeTruthy();
        const b = JSON.parse(String((call![1] as RequestInit).body)) as Record<string, unknown>;
        expect(b.model).toBe('artsdance2-0-mini-intl-260701');
        expect(b.resolution).toBe('720p');
        // 国内 base 未被打
        expect(mockFetch.mock.calls.every((c) => !String(c[0]).startsWith(`${UP}/v1/video/generations`))).toBe(true);
    });

    it('promax 长名 → 海外 base + 上游模型名(fast/mini 走 artsdance intl,2026-08-08);variantForModel promax 系判序正确', async () => {
        const res = await submitVideo(makeReq({ model: 'seedance2.0-promax-mini-720p', prompt: 'x', duration: 5 }));
        expect(res.status).toBe(200);
        const call = mockFetch.mock.calls.find((c) => String(c[0]).startsWith(INTL));
        expect(call).toBeTruthy();
        const b = JSON.parse(String((call![1] as RequestInit).body)) as Record<string, unknown>;
        expect(b.model).toBe('artsdance2-0-mini-intl-260701');
    });

    it('duration 4-15 整数透传(2026-08-03 探测放开);范围外(3/16/7.5)回落 5', async () => {
        for (const [input, expected] of [
            [15, 15],
            [4, 4],
            [7, 7],
            [3, 5],
            [16, 5],
            [7.5, 5],
        ] as Array<[number, number]>) {
            mockFetch.mockClear(); // submitBody 取首个 submit 调用,读下一次前先清
            await submitVideo(makeReq({ model: 'seedance2.0-pro-720p', prompt: 'x', duration: input }));
            expect(submitBody().duration).toBe(expected);
        }
    });

    it('seedance 2.5 系 duration 上限 30(4-30):16/30 透传,31/3 回落 5', async () => {
        for (const [input, expected] of [
            [30, 30],
            [16, 16],
            [4, 4],
            [31, 5],
            [3, 5],
        ] as Array<[number, number]>) {
            mockFetch.mockClear();
            await submitVideo(makeReq({ model: 'seedance2.5-720p', prompt: 'x', duration: input }));
            expect(submitBody().duration).toBe(expected);
        }
    });

    it('duration=-1(智能时长)原样透传上游', async () => {
        mockFetch.mockClear();
        await submitVideo(makeReq({ model: 'seedance2.5-720p', prompt: 'x', duration: -1 }));
        expect(submitBody().duration).toBe(-1);
    });

    it('ratio=adaptive 透传(不再被强制成 16:9);非法比例仍回落 16:9', async () => {
        mockFetch.mockClear();
        await submitVideo(makeReq({ model: 'seedance2.5-720p', prompt: 'x', ratio: 'adaptive' }));
        expect(submitBody().ratio).toBe('adaptive');
        mockFetch.mockClear();
        await submitVideo(makeReq({ model: 'seedance2.5-720p', prompt: 'x', ratio: '99:99' }));
        expect(submitBody().ratio).toBe('16:9');
    });

    it('omni_reference_task_type + output_format 透传(白名单外忽略)', async () => {
        mockFetch.mockClear();
        await submitVideo(
            makeReq({ model: 'seedance2.5-720p', prompt: 'x', omni_reference_task_type: 'edit', output_format: 'mov' }),
        );
        let b = submitBody();
        expect(b.omni_reference_task_type).toBe('edit');
        expect(b.output_format).toBe('mov');
        mockFetch.mockClear();
        await submitVideo(
            makeReq({
                model: 'seedance2.5-720p',
                prompt: 'x',
                omni_reference_task_type: 'bogus',
                output_format: 'avi',
            }),
        );
        b = submitBody();
        expect(b.omni_reference_task_type).toBeUndefined();
        expect(b.output_format).toBeUndefined();
    });

    it('content-item 显式 role(first_frame/last_frame)原样保留;无 role 时按 reference_image', async () => {
        mockFetch.mockClear();
        await submitVideo(
            makeReq({
                model: 'seedance2.5-720p-ref',
                content: [
                    { type: 'text', text: 'x' },
                    { type: 'image_url', image_url: { url: 'https://x/a.jpg' }, role: 'first_frame' },
                    { type: 'image_url', image_url: { url: 'https://x/b.jpg' }, role: 'last_frame' },
                ],
            }),
        );
        const imgs = submitBody().images as Array<{ url: string; role: string }>;
        expect(imgs.map((i) => i.role)).toEqual(['first_frame', 'last_frame']);
        // 无 role → 智能模式仍按 reference_image(存量行为不变)
        mockFetch.mockClear();
        await submitVideo(
            makeReq({
                model: 'seedance2.5-720p-ref',
                content: [
                    { type: 'text', text: 'x' },
                    { type: 'image_url', image_url: { url: 'https://x/a.jpg' } },
                ],
            }),
        );
        const imgs2 = submitBody().images as Array<{ url: string; role: string }>;
        expect(imgs2.map((i) => i.role)).toEqual(['reference_image']);
    });

    it('XHK_KEY 配置时精确校验:错 key → 401', async () => {
        const prev = process.env.SEEDANCE_XHK_KEY;
        process.env.SEEDANCE_XHK_KEY = 'sk-correct';
        try {
            const res = await submitVideo(makeReq({ model: 'seedance2.0-pro-720p', prompt: 'x' }, 'Bearer sk-wrong'));
            expect(res.status).toBe(401);
        } finally {
            if (prev === undefined) delete process.env.SEEDANCE_XHK_KEY;
            else process.env.SEEDANCE_XHK_KEY = prev;
        }
    });
});

describe('seedance-cn adapter poll', () => {
    it('完成 → 直接返回火山原始直链(不转存 R2)', async () => {
        const res = await pollVideo(pollReq(), 'cgt-test-1');
        expect(res.status).toBe(200);
        const j = (await res.json()) as Record<string, unknown>;
        expect(j.status).toBe('completed');
        // 成片不落 R2:video_url = 上游火山直链原样
        expect(mockUploadImage).not.toHaveBeenCalled();
        expect(j.video_url).toBe(`${UP}/out/generated.mp4?auth_key=xyz`);
        expect(j.url).toBe(j.video_url);
        // 完成时透传上游 usage(供按 token 量计费)
        expect(j.usage).toEqual({ completion_tokens: 108872, total_tokens: 108872 });
    });

    it('未知/已下线模型(2k)→ 400 model_not_found', async () => {
        const res = await submitVideo(makeReq({ model: 'seedance2.0-pro-2k', prompt: 'x' }));
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('model_not_found');
    });
});

describe('安全:上游信息不外泄(2026-07-24)', () => {
    it('上游不可达 → message 不含 base URL(xinhankr/artsmcp),只通用文案', async () => {
        mockFetch.mockReset();
        mockFetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED token.xinhankr.com:443'));
        const res = await submitVideo(makeReq({ model: 'seedance2.0-pro-720p', prompt: 'x' }));
        const j = (await res.json()) as { error: { message: string } };
        expect(res.status).toBe(502);
        expect(j.error.message).toBe('upstream temporarily unavailable, please retry');
        expect(j.error.message).not.toMatch(/xinhankr|artsmcp|http/i);
    });

    it('上游返回非 2xx(含内部标识)→ 不透传上游 body,只通用文案', async () => {
        mockFetch.mockReset();
        mockFetch.mockResolvedValueOnce(
            json({ error: { message: 'nginx/1.25 upstream token.xinhankr.com internal fault' } }, 500),
        );
        const res = await submitVideo(makeReq({ model: 'seedance2.0-pro-720p', prompt: 'x' }));
        const j = (await res.json()) as { error: { message: string } };
        // 上游 5xx = 瞬时,给可重试文案(不再泛化成 rejected);仍不泄露上游身份
        expect(j.error.message).toBe('上游暂时不可用,请稍后重试');
        expect(j.error.message).not.toMatch(/xinhankr|nginx|artsmcp/i);
    });

    it('轮询上游不可达 / 非 2xx → 同样不外泄', async () => {
        mockFetch.mockReset();
        mockFetch.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND ai.artsmcp.com'));
        let res = await pollVideo(pollReq(), 'cgt-x');
        let j = (await res.json()) as { error: { message: string } };
        expect(j.error.message).not.toMatch(/artsmcp|ENOTFOUND/i);

        mockFetch.mockReset();
        mockFetch.mockResolvedValueOnce(json({ error: { message: 'artsmcp gateway 502' } }, 502));
        res = await pollVideo(pollReq(), 'cgt-x');
        j = (await res.json()) as { error: { message: string } };
        // 上游 5xx = 瞬时可重试文案;仍不泄露上游身份
        expect(j.error.message).toBe('上游暂时不可用,请稍后重试');
        expect(j.error.message).not.toMatch(/artsmcp/i);
    });
});

describe('promax 判定(2026-07-23)', () => {
    it('variantForModel:promax 系先于 -fast/-mini;regionForModel:-promax → promax', async () => {
        const { variantForModel, regionForModel } = await import('../cn-adapter');
        expect(variantForModel('seedance-2-0-promax')).toBe('promax');
        expect(variantForModel('seedance-2-0-promax-fast')).toBe('promax-fast');
        expect(variantForModel('seedance-2-0-promax-mini')).toBe('promax-mini');
        expect(variantForModel('seedance-2-0-global-fast')).toBe('fast');
        expect(regionForModel('seedance-2-0-promax-mini')).toBe('promax');
        expect(regionForModel('seedance-2-0-global')).toBe('global');
        expect(regionForModel('seedance-2-0')).toBe('cn');
    });
});

describe('proMax 2.5 判定(2026-08-08)', () => {
    it('variantForModel:promax-2.5 先于纯 2.5 与 promax(短名/长名/上游名);regionForModel → promax', async () => {
        const { variantForModel, regionForModel, MODEL_MAP } = await import('../cn-adapter');
        expect(variantForModel('seedance-2-5-promax')).toBe('promax-2.5'); // 客户短名(任务行存这个)
        expect(variantForModel('seedance2.5-promax-1080p')).toBe('promax-2.5'); // 内部长名
        // 不误伤:cn 2.5 仍 '2.5',promax pro 仍 'promax'
        expect(variantForModel('seedance-2-5')).toBe('2.5');
        expect(variantForModel('seedance-2-0-promax')).toBe('promax');
        expect(regionForModel('seedance-2-5-promax')).toBe('promax');
        // MODEL_MAP:仅 720p/1080p × {无ref,-ref},上游 artsdance2-5-intl-260628,region promax
        for (const n of ['seedance2.5-promax-720p', 'seedance2.5-promax-1080p-ref']) {
            expect(MODEL_MAP[n].variant).toBe('promax-2.5');
            expect(MODEL_MAP[n].upstream).toBe('artsdance2-5-intl-260628');
            expect(MODEL_MAP[n].region).toBe('promax');
        }
        expect(MODEL_MAP['seedance2.5-promax-480p']).toBeUndefined();
        expect(MODEL_MAP['seedance2.5-promax-4k']).toBeUndefined();
    });
});

describe('seedance 2.5 判定(2026-08-07,国内版新代)', () => {
    it('variantForModel:短名/长名/上游名都 → 2.5(不落 pro 兜底);regionForModel → cn', async () => {
        const { variantForModel, regionForModel } = await import('../cn-adapter');
        expect(variantForModel('seedance-2-5')).toBe('2.5'); // 客户短名(任务行存这个)
        expect(variantForModel('seedance2.5-720p')).toBe('2.5'); // 内部长名
        expect(variantForModel('seedance2.5-1080p-ref')).toBe('2.5');
        expect(variantForModel('artsdance-2-5-pro-260801')).toBe('2.5'); // 上游名
        // 不误伤既有 2.0 系
        expect(variantForModel('seedance-2-0')).toBe('pro');
        expect(regionForModel('seedance-2-5')).toBe('cn');
    });

    it('MODEL_MAP:仅 720p/1080p × {无ref,-ref} 四档,上游 = artsdance-2-5-pro-260801,region 缺省 cn', async () => {
        const { MODEL_MAP } = await import('../cn-adapter');
        for (const name of ['seedance2.5-720p', 'seedance2.5-720p-ref', 'seedance2.5-1080p', 'seedance2.5-1080p-ref']) {
            expect(MODEL_MAP[name]).toBeTruthy();
            expect(MODEL_MAP[name].variant).toBe('2.5');
            expect(MODEL_MAP[name].upstream).toBe('artsdance-2-5-pro-260801');
            expect(MODEL_MAP[name].region).toBeUndefined(); // 缺省 = cn base
        }
        expect(MODEL_MAP['seedance2.5-480p']).toBeUndefined(); // 上游不支持 480p
        expect(MODEL_MAP['seedance2.5-4k']).toBeUndefined(); // 无 4k
    });
});

describe('单次输入上限(按变体,2026-08-07)', () => {
    const urls = (n: number, p: string) => Array.from({ length: n }, (_, i) => `https://cdn/${p}${i}.jpg`);

    it('seedance 2.5:30 图 + 10 视频 放行(旧档 9/3 会拒的量)', async () => {
        const res = await submitVideo(
            makeReq({
                model: 'seedance2.5-720p-ref',
                prompt: 'x',
                images: urls(30, 'img'),
                reference_videos: urls(10, 'vid'),
            }),
        );
        expect(res.status).toBe(200);
        const b = submitBody();
        expect((b.images as unknown[]).length).toBe(30);
        expect((b.videos as unknown[]).length).toBe(10);
    });

    it('seedance 2.5:超 30 图 → 400 at most 30 images', async () => {
        const res = await submitVideo(makeReq({ model: 'seedance2.5-720p-ref', prompt: 'x', images: urls(31, 'img') }));
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/at most 30 images/);
    });

    it('seedance 2.5:超 10 视频 → 400;超 10 音频 → 400', async () => {
        let res = await submitVideo(
            makeReq({ model: 'seedance2.5-720p-ref', prompt: 'x', reference_videos: urls(11, 'v') }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/at most 10 videos/);
        mockFetch.mockClear();
        res = await submitVideo(
            makeReq({ model: 'seedance2.5-720p-ref', prompt: 'x', image: 'https://cdn/a.jpg', audios: urls(11, 'a') }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/at most 10 audios/);
    });

    it('旧档(pro)仍 9 图 / 3 视频上限,不被放开:pro -ref 10 图 → 400 at most 9 images', async () => {
        const res = await submitVideo(
            makeReq({ model: 'seedance2.0-pro-720p-ref', prompt: 'x', images: urls(10, 'img') }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/at most 9 images/);
    });
});

describe('上游报错友好化(2026-08-11):审核类给可操作提示,且不泄露上游身份', () => {
    const submitWith400 = async (upstreamBody: unknown) => {
        mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
            const u = String(url);
            if (u.endsWith('/v1/video/generations') && (init?.method || '').toUpperCase() === 'POST') {
                return json(upstreamBody, 400);
            }
            return new Response('', { status: 200 });
        });
        // 文生(无参考)避免 media fetch;上游 400 → 走 submit failed 分支
        return submitVideo(makeReq({ model: 'seedance2.0-pro-720p', prompt: '一只猫' }));
    };

    it('版权类(copyright)→ 提示更换参考图,状态 400', async () => {
        const res = await submitWith400({
            error: { message: '素材处理失败: input image may be related to copyright restrictions' },
        });
        expect(res.status).toBe(400);
        const m = ((await res.json()) as { error: { message: string } }).error.message;
        expect(m).toMatch(/版权/);
        expect(m).toMatch(/更换参考图|重试/);
    });

    it('敏感类(sensitive)→ 提示调整提示词/素材', async () => {
        const res = await submitWith400({ error: { message: 'the input may contain sensitive information' } });
        const m = ((await res.json()) as { error: { message: string } }).error.message;
        expect(m).toMatch(/敏感/);
    });

    it('其它上游错误 → 通用文案(不分类)', async () => {
        const res = await submitWith400({ error: { message: 'internal upstream failure xyz' } });
        expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
            'upstream rejected the request',
        );
    });

    it('任务不存在(上游清任务)→ 任务已失效提示(不再泛化 rejected)', async () => {
        const res = await submitWith400({ error: { code: '400', message: '任务不存在' } });
        expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/任务已失效|不存在/);
    });

    it('素材下载失败 → 提示链接不可达/换国内版(不泛化 rejected)', async () => {
        const res = await submitWith400({
            error: {
                code: '400',
                message: '素材转换失败: Failed to download media from the provided URL. Gateway Time-out',
            },
        });
        expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/素材下载失败|不可达/);
    });

    it('上游 5xx → 可重试文案(不是 rejected)', async () => {
        mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
            const u = String(url);
            if (u.endsWith('/v1/video/generations') && (init?.method || '').toUpperCase() === 'POST') {
                return json({ error: { message: 'boom' } }, 503);
            }
            return new Response('', { status: 200 });
        });
        const res = await submitVideo(makeReq({ model: 'seedance2.0-pro-720p', prompt: 'x' }));
        expect(((await res.json()) as { error: { message: string } }).error.message).toBe('上游暂时不可用,请稍后重试');
    });

    it('安全:分类文案不泄露上游身份(不含 xinhankr/artsmcp/域名/原始 body)', async () => {
        const res = await submitWith400({
            error: { message: 'copyright restriction at token.xinhankr.com Request ID: abc123 nginx' },
        });
        const m = ((await res.json()) as { error: { message: string } }).error.message;
        expect(m).not.toMatch(/xinhankr|artsmcp|nginx|Request ID|abc123|\.com/);
    });
});
