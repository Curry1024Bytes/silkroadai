/** 「火山」渠道视频适配器单测(上游 = 筷子开放平台,2026-08-17 换上游):
 *  方舟原生提交/轮询 + kz-cgt- ↔ cgt- id 伪装 + 成片直链优先级 + 未配置降级。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { submitVolcVideo, pollVolcVideo, cancelVolcVideo, VOLC_MODELS, VOLC_RESOLUTIONS } from '../kuaizi-adapter';

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

describe('submitVolcVideo', () => {
    it('打筷子方舟端点 + Bearer key,model 换成上游方舟 Model ID,kz-cgt- id 伪装成 cgt-', async () => {
        const fetchMock = vi
            .spyOn(global, 'fetch')
            .mockResolvedValue(new Response(JSON.stringify({ id: 'kz-cgt-abc', status: 'queued' }), { status: 200 }));
        const res = await submitVolcVideo({ prompt: '一只猫', ratio: '16:9' }, opts({ resolution: '1080p' }));
        expect(res.status).toBe(200);
        const j = (await res.json()) as { id: string; task_id: string; status: string; model: string };
        expect(j.id).toBe('cgt-abc');
        expect(j.task_id).toBe('cgt-abc');
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

    it('四档模型各自映射到对应上游 Model ID', async () => {
        for (const [clientModel, spec] of Object.entries(VOLC_MODELS)) {
            const fetchMock = vi
                .spyOn(global, 'fetch')
                .mockResolvedValue(new Response(JSON.stringify({ id: 'kz-cgt-x' }), { status: 200 }));
            await submitVolcVideo({ prompt: 'x' }, opts({ clientModel }));
            const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
            expect(sent.model).toBe(spec.upstream);
            vi.restoreAllMocks();
        }
    });

    it('透传客户 content 数组(多模态)+ 火山官方可选字段', async () => {
        const fetchMock = vi
            .spyOn(global, 'fetch')
            .mockResolvedValue(new Response(JSON.stringify({ id: 'kz-cgt-x' }), { status: 200 }));
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
        const fetchMock = vi
            .spyOn(global, 'fetch')
            .mockResolvedValue(new Response(JSON.stringify({ id: 'kz-cgt-x' }), { status: 200 }));
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

    it('非 kz-cgt- 形上游 id 原样返回', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ id: 'cgt-native-1' }), { status: 200 }),
        );
        const res = await submitVolcVideo({ prompt: 'x' }, opts());
        expect(((await res.json()) as { id: string }).id).toBe('cgt-native-1');
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

describe('vendor_task_id 透传(上游文档 v1.3,2026-08-19)', () => {
    const poll = (extra: Record<string, unknown>) =>
        new Response(JSON.stringify({ id: 'kz-cgt-abc', status: 'running', ...extra }), { status: 200 });

    afterEach(() => delete process.env.ENTERPRISE_VENDOR_TASK_ID_ARK_ONLY);

    it('火山原生形(cgt-)→ 透传', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(poll({ vendor_task_id: 'cgt-20260817125256-tfv79' }));
        const j = (await (await pollVolcVideo('cgt-abc')).json()) as { vendor_task_id?: string };
        expect(j.vendor_task_id).toBe('cgt-20260817125256-tfv79');
    });

    it('三方渠道形(tsk-)→ 默认也透传(operator 拍板:下游就是要这个号)', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(poll({ vendor_task_id: 'tsk-ghubt0mgm8impt83' }));
        const j = (await (await pollVolcVideo('cgt-abc')).json()) as { vendor_task_id?: string };
        expect(j.vendor_task_id).toBe('tsk-ghubt0mgm8impt83');
    });

    it('逃生阀 ENTERPRISE_VENDOR_TASK_ID_ARK_ONLY=1 → 只透 cgt-,tsk- 连响应体都不含', async () => {
        process.env.ENTERPRISE_VENDOR_TASK_ID_ARK_ONLY = '1';
        vi.spyOn(global, 'fetch').mockResolvedValue(poll({ vendor_task_id: 'tsk-ghubt0mgm8impt83' }));
        const body = await (await pollVolcVideo('cgt-abc')).text();
        expect(JSON.parse(body).vendor_task_id).toBeUndefined();
        expect(body).not.toContain('tsk-ghubt0mgm8impt83');

        vi.restoreAllMocks();
        vi.spyOn(global, 'fetch').mockResolvedValue(poll({ vendor_task_id: 'cgt-x1' }));
        const j = (await (await pollVolcVideo('cgt-abc')).json()) as { vendor_task_id?: string };
        expect(j.vendor_task_id).toBe('cgt-x1'); // 开关只挡非 cgt- 形
    });

    it('未开通 / running 早期上游不给该字段 → 不报错,响应里也没有', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(poll({}));
        const j = (await (await pollVolcVideo('cgt-abc')).json()) as { vendor_task_id?: string };
        expect(j.vendor_task_id).toBeUndefined();
    });
});

describe('seedance 2.5 放开 1080p(上游文档 v1.2,实测确认)', () => {
    it('2.5 档位表 = 480p / 720p / 1080p,仍无 4k', () => {
        expect(VOLC_RESOLUTIONS['2.5']).toEqual(['480p', '720p', '1080p']);
        expect(VOLC_RESOLUTIONS['2.5']).not.toContain('4k');
    });
});
