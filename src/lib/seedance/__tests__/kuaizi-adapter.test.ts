/** 「火山」渠道视频适配器单测(上游 = 筷子开放平台,2026-08-17 换上游):
 *  方舟原生提交/轮询 + kz-cgt- ↔ cgt- id 伪装 + 成片直链优先级 + 未配置降级。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    submitVolcVideo,
    pollVolcVideo,
    cancelVolcVideo,
    isVolcModelWithdrawn,
    VOLC_MODELS,
    VOLC_RESOLUTIONS,
} from '../kuaizi-adapter';
import { rememberVolcId } from '@/lib/enterprise/volc-id-map';

// 映射表只是翻译层,单测里 stub 掉 —— 本文件验的是适配器契约,不是持久化。
vi.mock('@/lib/enterprise/volc-id-map', () => ({
    rememberVolcId: vi.fn(async () => {}),
    toUpstreamId: vi.fn(async (id: string) => id),
}));

const BASE = 'http://kuaizi.test';
const KEY = 'kz-test-key';
const TASKS = `${BASE}/ai-open-platform-api/api/v3/contents/generations/tasks`;

beforeEach(() => {
    process.env.ENTERPRISE_KUAIZI_BASE_URL = BASE;
    process.env.ENTERPRISE_KUAIZI_KEY = KEY;
    vi.restoreAllMocks();
});
afterEach(() => {
    delete process.env.ENTERPRISE_KUAIZI_BASE_URL;
    delete process.env.ENTERPRISE_KUAIZI_KEY;
});

const opts = (over: Partial<Parameters<typeof submitVolcVideo>[1]> = {}) => ({
    clientModel: 'doubao-seedance-2.0',
    resolution: '720p' as const,
    duration: 5,
    ...over,
});

/**
 * 提交后适配器会【压着轮询】等火山任务号(waitForVendorTaskId),所以要给两段响应:
 *   POST …/tasks      → 上游受理,返上游 id
 *   GET  …/tasks/{id} → 返 vendor_task_id(火山官方任务号)
 */
function mockSubmitThenVendor(upstreamId = 'kz-cgt-abc', vendorId = 'cgt-20260819224039-bfjdv') {
    return vi
        .spyOn(global, 'fetch')
        .mockImplementation((input) =>
            Promise.resolve(
                String(input).endsWith('/tasks')
                    ? new Response(JSON.stringify({ id: upstreamId, status: 'queued' }), { status: 200 })
                    : new Response(JSON.stringify({ vendor_task_id: vendorId, status: 'running' }), { status: 200 }),
            ),
        );
}

describe('submitVolcVideo', () => {
    it('打筷子方舟端点 + Bearer key,model 换成上游方舟 Model ID,对客 id = 火山官方任务号', async () => {
        const fetchMock = mockSubmitThenVendor();
        const res = await submitVolcVideo({ prompt: '一只猫', ratio: '16:9' }, opts({ resolution: '1080p' }));
        expect(res.status).toBe(200);
        const j = (await res.json()) as { id: string; task_id: string; status: string; model: string };
        // 对客 id = 火山官方任务号(压着等来的),不是上游发的 kz-cgt-
        expect(j.id).toBe('cgt-20260819224039-bfjdv');
        expect(j.task_id).toBe('cgt-20260819224039-bfjdv');
        expect(j.status).toBe('queued');
        // 对客回显客户调用的名字,不泄露上游 Model ID
        expect(j.model).toBe('doubao-seedance-2.0');

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(TASKS);
        expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
        const sent = JSON.parse((init as RequestInit).body as string);
        expect(sent.model).toBe('doubao-seedance-2-0-260128');
        expect(sent.resolution).toBe('1080p');
        expect(sent.duration).toBe(5);
        expect(sent.content).toEqual([{ type: 'text', text: '一只猫' }]);
    });

    it('在售档位各自映射到对应上游 Model ID', async () => {
        const onSale = Object.entries(VOLC_MODELS).filter(([m]) => !isVolcModelWithdrawn(m));
        expect(onSale.map(([m]) => m)).toEqual(['doubao-seedance-2.0', 'doubao-seedance-2.5']);
        for (const [clientModel, spec] of onSale) {
            const fetchMock = mockSubmitThenVendor();
            await submitVolcVideo({ prompt: 'x' }, opts({ clientModel }));
            const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
            expect(sent.model).toBe(spec.upstream);
            vi.restoreAllMocks();
        }
    });

    // 2026-08-19:fast/mini 实测不落方舟(vendor_task_id 返 tsk-),与「原生火山」定位不符 → 下架。
    it.each(['doubao-seedance-2.0-fast', 'doubao-seedance-2.0-mini'])(
        '下架档位 %s → 400 model_unavailable,且【一个字节都不发上游】',
        async (clientModel) => {
            const fetchMock = vi.spyOn(global, 'fetch');
            const res = await submitVolcVideo({ prompt: 'x' }, opts({ clientModel }));
            expect(res.status).toBe(400);
            expect((await res.json()).error.code).toBe('model_unavailable');
            expect(fetchMock).not.toHaveBeenCalled();
        },
    );

    it('逃生阀 ENTERPRISE_VOLC_ALLOW_LOW_TIERS=1 → 下架档位恢复可用(上游锁方舟后用它验证)', async () => {
        vi.stubEnv('ENTERPRISE_VOLC_ALLOW_LOW_TIERS', '1');
        const fetchMock = mockSubmitThenVendor();
        const res = await submitVolcVideo({ prompt: 'x' }, opts({ clientModel: 'doubao-seedance-2.0-mini' }));
        expect(res.status).toBe(200);
        expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).model).toBe(
            'doubao-seedance-2-0-mini-260615',
        );
    });

    it('透传客户 content 数组(多模态)+ 火山官方可选字段', async () => {
        const fetchMock = mockSubmitThenVendor();
        const content = [
            { type: 'text', text: '让她跳舞' },
            { type: 'image_url', image_url: { url: 'asset://1800657071180349888' }, role: 'first_frame' },
        ];
        await submitVolcVideo(
            {
                content,
                seed: 42,
                watermark: true,
                return_last_frame: true,
                safety_identifier: 'end-user-001',
                omni_reference_task_type: 'reference',
                moderation_options: { ips: ['kz-ip-1'], ip_mode: 'custom' },
            },
            opts(),
        );
        const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(sent.content).toEqual(content);
        expect(sent.seed).toBe(42);
        expect(sent.watermark).toBe(true);
        expect(sent.return_last_frame).toBe(true);
        expect(sent.safety_identifier).toBe('end-user-001');
        expect(sent.omni_reference_task_type).toBe('reference');
        // 上游【不接受】ip_mode(平台统一控制)→ 只透传 ips
        expect(sent.moderation_options).toEqual({ ips: ['kz-ip-1'] });
    });

    it('duration=-1(智能时长)原样透传上游', async () => {
        const fetchMock = mockSubmitThenVendor();
        await submitVolcVideo({ prompt: 'x' }, opts({ duration: -1 }));
        const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(sent.duration).toBe(-1);
    });

    it('未配置 env → 503,不打上游', async () => {
        delete process.env.ENTERPRISE_KUAIZI_KEY;
        const fetchMock = vi.spyOn(global, 'fetch');
        const res = await submitVolcVideo({ prompt: 'x' }, opts());
        expect(res.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('无 prompt/content → 400,不打上游', async () => {
        const fetchMock = vi.spyOn(global, 'fetch');
        const res = await submitVolcVideo({}, opts());
        expect(res.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('上游报错 → 透传状态码 + 分类文案,绝不回显上游原始 body/域名(#271)', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    code: 'InputImageSensitiveContentDetected',
                    message: 'sensitive content in image',
                    request_id: '7f9a72b7476bc7838a470c3df57258da',
                    type: 'BadRequest',
                }),
                { status: 400 },
            ),
        );
        const res = await submitVolcVideo({ prompt: 'x' }, opts());
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { message: string } };
        expect(body.error.message).toContain('安全审核');
        expect(JSON.stringify(body)).not.toContain('request_id');
        expect(JSON.stringify(body)).not.toContain('7f9a72b7');
    });

    // ── 对客 id = 火山官方任务号(2026-08-19)──────────────────────────────────
    // volc 卖的是原生火山体验,所以 id 必须是火山自己的号。上游受理后才给得出
    // (实测 ~10.5s),这段等待消不掉,只能我们压着;拿不到就报错,不吐非火山的号。

    it('落到非方舟(vendor 非 cgt- 形)→ 502 non_ark_route,不把非火山任务交给客户', async () => {
        vi.spyOn(global, 'fetch').mockImplementation((input) =>
            Promise.resolve(
                String(input).endsWith('/tasks')
                    ? new Response(JSON.stringify({ id: 'kz-cgt-x' }), { status: 200 })
                    : new Response(JSON.stringify({ vendor_task_id: 'tsk-ghuya22ne4tyq74q' }), { status: 200 }),
            ),
        );
        const res = await submitVolcVideo({ prompt: 'x' }, opts());
        expect(res.status).toBe(502);
        const b = (await res.json()) as { error: { category?: string; message: string } };
        expect(b.error.category).toBe('non_ark_route');
        // 上游的号不能回显给客户(#271)
        expect(JSON.stringify(b)).not.toContain('tsk-ghuya22ne4tyq74q');
    });

    it('上游迟迟不给任务号 → 504,不吐一个非火山的号', async () => {
        process.env.ENTERPRISE_VOLC_VENDOR_WAIT_MS = '1';
        vi.spyOn(global, 'fetch').mockImplementation((input) =>
            Promise.resolve(
                String(input).endsWith('/tasks')
                    ? new Response(JSON.stringify({ id: 'kz-cgt-x' }), { status: 200 })
                    : new Response(JSON.stringify({ status: 'queued' }), { status: 200 }),
            ),
        );
        const res = await submitVolcVideo({ prompt: 'x' }, opts());
        expect(res.status).toBe(504);
        delete process.env.ENTERPRISE_VOLC_VENDOR_WAIT_MS;
    });

    it('拿到火山号后写映射表(轮询时要换回上游号)', async () => {
        mockSubmitThenVendor('kz-cgt-abc', 'cgt-20260819224039-bfjdv');
        await submitVolcVideo({ prompt: 'x' }, opts());
        expect(rememberVolcId).toHaveBeenCalledWith('cgt-20260819224039-bfjdv', 'cgt-abc', 'task');
    });
});

describe('pollVolcVideo', () => {
    it('完成 → cgt- 还原成 kz-cgt- 打上游、回显 cgt-;取 content.video_url + usage', async () => {
        const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    id: 'kz-cgt-abc',
                    status: 'succeeded',
                    content: {
                        video_url: 'https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/out.mp4',
                        kz_video_url: 'https://example.tos-cn-beijing.volces.com/ai_openapi/video_kz-cgt-abc.mp4',
                        last_frame_url: 'https://volc-cdn/last.png',
                    },
                    usage: { completion_tokens: 108900, total_tokens: 108900 },
                }),
                { status: 200 },
            ),
        );
        const res = await pollVolcVideo('cgt-abc');
        expect(fetchMock.mock.calls[0][0]).toBe(`${TASKS}/kz-cgt-abc`);
        const j = (await res.json()) as {
            id: string;
            status: string;
            video_url: string;
            last_frame_url: string;
            usage: { completion_tokens: number };
        };
        expect(j.id).toBe('cgt-abc');
        expect(j.status).toBe('completed');
        // 优先方舟原始直链(客户只看到火山官方 TOS 域名);kz_video_url 会泄露上游身份,不用
        expect(j.video_url).toBe('https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/out.mp4');
        expect(j.last_frame_url).toBe('https://volc-cdn/last.png');
        expect(j.usage.completion_tokens).toBe(108900);
    });

    it('上游只给 kz_video_url 时兜底用它', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    id: 'kz-cgt-b',
                    status: 'succeeded',
                    content: { kz_video_url: 'https://example.tos-cn-beijing.volces.com/v.mp4' },
                }),
                { status: 200 },
            ),
        );
        const j = (await (await pollVolcVideo('cgt-b')).json()) as { video_url: string };
        expect(j.video_url).toBe('https://example.tos-cn-beijing.volces.com/v.mp4');
    });

    it('还原后 404 → 用原始 id 回退一次(上一版 provider 遗留 id 兜底)', async () => {
        const fetchMock = vi
            .spyOn(global, 'fetch')
            .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'cgt-old', status: 'running' }), { status: 200 }));
        const res = await pollVolcVideo('cgt-old');
        expect(fetchMock.mock.calls[0][0]).toBe(`${TASKS}/kz-cgt-old`);
        expect(fetchMock.mock.calls[1][0]).toBe(`${TASKS}/cgt-old`);
        const j = (await res.json()) as { id: string; status: string };
        expect(j.id).toBe('cgt-old');
        expect(j.status).toBe('in_progress');
    });

    it('expired 视为失败终态(超时);失败带 fail_reason 且无 usage', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ id: 'kz-cgt-e', status: 'expired' }), { status: 200 }),
        );
        const j1 = (await (await pollVolcVideo('cgt-e')).json()) as { status: string };
        expect(j1.status).toBe('failed');

        vi.restoreAllMocks();
        vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({ id: 'kz-cgt-f', status: 'failed', error: { message: '生成失败:输入内容未通过审核' } }),
                { status: 200 },
            ),
        );
        const j2 = (await (await pollVolcVideo('cgt-f')).json()) as {
            status: string;
            fail_reason: string;
            usage?: unknown;
        };
        expect(j2.status).toBe('failed');
        expect(j2.fail_reason).toBe('生成失败:输入内容未通过审核');
        expect(j2.usage).toBeUndefined();
    });

    it('未配置 env → 503', async () => {
        delete process.env.ENTERPRISE_KUAIZI_KEY;
        expect((await pollVolcVideo('cgt-x')).status).toBe(503);
    });
});

describe('cancelVolcVideo', () => {
    it('上游无取消端点 → 返 null(proxy best-effort,不阻断删除)', async () => {
        const fetchMock = vi.spyOn(global, 'fetch');
        expect(await cancelVolcVideo('cgt-x')).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('vendor_task_id 不再对客暴露(2026-08-19 原生化)', () => {
    const poll = (extra: Record<string, unknown>) =>
        new Response(JSON.stringify({ id: 'kz-cgt-abc', status: 'running', ...extra }), { status: 200 });

    // 客户拿到的 `id` 本身就是火山官方任务号了(提交时压着等来的),再多一个
    // vendor_task_id 键反而不原生 —— 火山官方响应里根本没有这个字段。
    it.each([['cgt-20260817125256-tfv79'], ['tsk-ghubt0mgm8impt83']])(
        '上游给 %s → 响应体里【没有】 vendor_task_id 键',
        async (vendor) => {
            vi.spyOn(global, 'fetch').mockResolvedValue(poll({ vendor_task_id: vendor }));
            const body = await (await pollVolcVideo('cgt-abc')).text();
            expect(JSON.parse(body).vendor_task_id).toBeUndefined();
            expect(body).not.toContain('vendor_task_id');
        },
    );

    it('上游根本不给该字段 → 照常返回,不报错', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(poll({}));
        const j = (await (await pollVolcVideo('cgt-abc')).json()) as { status: string };
        expect(j.status).toBe('in_progress');
    });
});

describe('seedance 2.5 放开 1080p(上游文档 v1.2,实测确认)', () => {
    it('2.5 档位表 = 480p / 720p / 1080p,仍无 4k', () => {
        expect(VOLC_RESOLUTIONS['2.5']).toEqual(['480p', '720p', '1080p']);
        expect(VOLC_RESOLUTIONS['2.5']).not.toContain('4k');
    });
});
