/** 「火山」渠道视频适配器单测(上游 = service-inference.ai /v2 doubao-sd-max,2026-09-22 换上游):
 *  方舟原生提交/轮询 + mvt- ↔ cgt- id 映射 + metadata(方舟原生体)透出 + 错误拆包脱敏 + 未配置降级。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    customerVolcUpstreamKey,
    submitVolcVideo,
    pollVolcVideo,
    cancelVolcVideo,
    isVolcModelWithdrawn,
    upstreamModelName,
    unwrapUpstreamError,
    VOLC_MODELS,
    VOLC_RESOLUTIONS,
} from '../volc-adapter';
import { rememberVolcId, toUpstreamId } from '@/lib/enterprise/volc-id-map';

// 映射表只是翻译层,单测里 stub 掉 —— 本文件验的是适配器契约,不是持久化。
vi.mock('@/lib/enterprise/volc-id-map', () => ({
    rememberVolcId: vi.fn(async () => {}),
    toUpstreamId: vi.fn(async (id: string) => id),
}));

const BASE = 'http://svcinf.test';
const KEY = 'sk-inf-v1-test-key';
const GENERATE = `${BASE}/v2/video/generate`;
const TASKS = `${BASE}/v2/video/tasks`;

beforeEach(() => {
    process.env.ENTERPRISE_VOLC_UPSTREAM_BASE_URL = BASE;
    process.env.ENTERPRISE_VOLC_UPSTREAM_KEY = KEY;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});
afterEach(() => {
    delete process.env.ENTERPRISE_VOLC_UPSTREAM_BASE_URL;
    delete process.env.ENTERPRISE_VOLC_UPSTREAM_KEY;
});

const opts = (over: Partial<Parameters<typeof submitVolcVideo>[1]> = {}) => ({
    clientModel: 'doubao-seedance-2.0',
    resolution: '720p' as const,
    duration: 5,
    ...over,
});

/** 上游提交响应:{ task: { id: "mvt-…", status: "pending" } } */
function mockSubmit(upstreamId = 'mvt-2c22c91015664736') {
    // 每次调用新建 Response(body 只能读一次;同一测试内多次提交要各自可读)
    return vi.spyOn(global, 'fetch').mockImplementation(
        async () =>
            new Response(JSON.stringify({ task: { id: upstreamId, status: 'pending', outputs: [], error: null } }), {
                status: 200,
            }),
    );
}

/** 上游轮询响应信封。 */
const taskEnvelope = (task: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify({ task: { id: 'mvt-abc', ...task } }), { status });

describe('submitVolcVideo', () => {
    it('打 /v2/video/generate + Bearer key,model 换成上游 -max 名,对客 id = 即时自造的火山方舟形号', async () => {
        const fetchMock = mockSubmit();
        const res = await submitVolcVideo({ prompt: '一只猫', ratio: '16:9' }, opts({ resolution: '1080p' }));
        expect(res.status).toBe(200);
        const j = (await res.json()) as { id: string; task_id: string; status: string; model: string };
        expect(j.id).toMatch(/^cgt-\d{14}-[a-z0-9]{5}$/);
        expect(j.id).not.toContain('mvt-');
        expect(j.task_id).toBe(j.id);
        expect(j.status).toBe('queued');
        expect(j.model).toBe('doubao-seedance-2.0'); // 回显客户调用的名字,不泄露上游模型名

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(GENERATE);
        expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
        const sent = JSON.parse((init as RequestInit).body as string);
        expect(sent.model).toBe('doubao-seedance-2-0-260128-max');
        expect(sent.resolution).toBe('1080p');
        expect(sent.duration).toBe(5);
        expect(sent.generate_audio).toBe(true);
        expect(sent.content).toEqual([{ type: 'text', text: '一只猫' }]);
    });

    // 2026-10-08 样片出正片(draft_task):客户样片号 → mvt- → GET 上游任务 metadata.id(方舟真号)→ 替换。
    it('draft_task:先 GET 样片任务拿方舟真号再提交,content 里的 id 已换成方舟真号,没传时长/音频不注入默认值', async () => {
        vi.mocked(toUpstreamId).mockResolvedValueOnce('mvt-draft1');
        const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
            if (String(url) === `${TASKS}/mvt-draft1` && (init?.method ?? 'GET') === 'GET') {
                return taskEnvelope({ status: 'completed', metadata: { id: 'cgt-20261008150000-arkid', draft: true } });
            }
            return new Response(JSON.stringify({ task: { id: 'mvt-final1', status: 'pending' } }), { status: 200 });
        });
        const res = await submitVolcVideo(
            { content: [{ type: 'draft_task', draft_task: { id: 'cgt-client-draft' } }] },
            opts({ clientModel: 'doubao-seedance-2.5', resolution: '1080p' }),
        );
        expect(res.status).toBe(200);
        const submit = fetchMock.mock.calls.find((c) => String(c[0]) === GENERATE);
        expect(submit).toBeDefined();
        const sent = JSON.parse((submit![1] as RequestInit).body as string);
        expect(sent.content).toEqual([{ type: 'draft_task', draft_task: { id: 'cgt-20261008150000-arkid' } }]);
        expect(sent.resolution).toBe('1080p');
        expect('duration' in sent).toBe(false);
        expect('generate_audio' in sent).toBe(false);
    });

    it('draft_task 样片未完成 → 400 不提交', async () => {
        vi.mocked(toUpstreamId).mockResolvedValueOnce('mvt-draft1');
        const fetchMock = vi
            .spyOn(global, 'fetch')
            .mockImplementation(async () => taskEnvelope({ status: 'processing', metadata: {} }));
        const res = await submitVolcVideo(
            { content: [{ type: 'draft_task', draft_task: { id: 'cgt-client-draft' } }] },
            opts({ clientModel: 'doubao-seedance-2.5' }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { message: string } }).error.message).toContain('尚未完成');
        expect(fetchMock.mock.calls.some((c) => String(c[0]) === GENERATE)).toBe(false);
    });

    it('四档全部在售,各自映射到 方舟 id + -max 的上游模型名', async () => {
        expect(Object.keys(VOLC_MODELS).filter(isVolcModelWithdrawn)).toEqual([]);
        for (const [clientModel, spec] of Object.entries(VOLC_MODELS)) {
            const fetchMock = mockSubmit();
            await submitVolcVideo({ prompt: 'x' }, opts({ clientModel }));
            const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
            expect(sent.model).toBe(`${spec.upstream}-max`);
            expect(upstreamModelName(clientModel)).toBe(`${spec.upstream}-max`);
            vi.restoreAllMocks();
        }
    });

    it('上游模型名可按档位 env 覆盖(套餐名不带 -max 时用)', async () => {
        vi.stubEnv('ENTERPRISE_VOLC_MODEL_25', 'doubao-seedance-2-5-260628');
        const fetchMock = mockSubmit();
        await submitVolcVideo({ prompt: 'x' }, opts({ clientModel: 'doubao-seedance-2.5' }));
        expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).model).toBe(
            'doubao-seedance-2-5-260628',
        );
        expect(upstreamModelName('doubao-seedance-2.0')).toBe('doubao-seedance-2-0-260128-max'); // 其它档不受影响
    });

    it('env 下架名单 → 400 model_unavailable,且【一个字节都不发上游】', async () => {
        vi.stubEnv('ENTERPRISE_VOLC_WITHDRAWN_MODELS', 'doubao-seedance-2.0-fast, Doubao-Seedance-2.0-MINI');
        expect(isVolcModelWithdrawn('doubao-seedance-2.0-fast')).toBe(true);
        expect(isVolcModelWithdrawn('doubao-seedance-2.0-mini')).toBe(true);
        expect(isVolcModelWithdrawn('doubao-seedance-2.0')).toBe(false);
        const fetchMock = vi.spyOn(global, 'fetch');
        const res = await submitVolcVideo({ prompt: 'x' }, opts({ clientModel: 'doubao-seedance-2.0-fast' }));
        expect(res.status).toBe(400);
        expect((await res.json()).error.code).toBe('model_unavailable');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('客户不传 ratio → 【不注入】,由上游按任务类型自己定(视频续写必须这样)', async () => {
        const fetchMock = mockSubmit();
        await submitVolcVideo({ prompt: '续写结尾后的场景' }, opts({ clientModel: 'doubao-seedance-2.5' }));
        const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(sent).not.toHaveProperty('ratio');
    });

    it('客户显式传 ratio → 照常注入', async () => {
        const fetchMock = mockSubmit();
        await submitVolcVideo({ prompt: 'x', ratio: 'adaptive' }, opts());
        expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).ratio).toBe('adaptive');
    });

    it('火山官方字段一律透传(上游实测会原样转给方舟,由方舟判)', async () => {
        const fetchMock = mockSubmit();
        await submitVolcVideo(
            { prompt: 'x', bitrate_mode: 'vbr', camera_fixed: true, service_tier: 'default', priority: 1 },
            opts(),
        );
        const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(sent.bitrate_mode).toBe('vbr');
        expect(sent.camera_fixed).toBe(true);
        expect(sent.service_tier).toBe('default');
        expect(sent.priority).toBe(1);
    });

    it('我们消费/翻译掉的键不重复透传(prompt / first_frame 等已并进 content)', async () => {
        const fetchMock = mockSubmit();
        await submitVolcVideo({ prompt: 'x', first_frame: 'https://a/1.jpg', seconds: 8 }, opts());
        const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        for (const k of ['prompt', 'first_frame', 'seconds']) expect(sent).not.toHaveProperty(k);
    });

    it('callback_url 不透传 —— 上游会直接回调客户并带上游任务对象(#271)', async () => {
        const fetchMock = mockSubmit();
        await submitVolcVideo({ prompt: 'x', callback_url: 'https://客户/cb' }, opts());
        expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).not.toHaveProperty(
            'callback_url',
        );
    });

    it('提交即返回:全程只打一次上游 POST', async () => {
        const fetchMock = mockSubmit();
        const res = await submitVolcVideo({ prompt: 'x' }, opts());
        expect(res.status).toBe(200);
        expect(fetchMock.mock.calls.length).toBe(1);
        expect(String(fetchMock.mock.calls[0][0])).toBe(GENERATE);
    });

    it('透传客户 content 数组(多模态)+ 火山官方可选字段', async () => {
        const fetchMock = mockSubmit();
        const content = [
            { type: 'text', text: '让她跳舞' },
            { type: 'image_url', image_url: { url: 'https://images.example/a.png' }, role: 'first_frame' },
        ];
        await submitVolcVideo(
            {
                content,
                seed: 42,
                watermark: true,
                return_last_frame: true,
                safety_identifier: 'end-user-001',
                omni_reference_task_type: 'reference',
                moderation_options: { ips: ['ip-1'], ip_mode: 'custom' },
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
        expect(sent.moderation_options).toEqual({ ips: ['ip-1'] });
    });

    it('duration=-1(智能时长)原样透传上游', async () => {
        const fetchMock = mockSubmit();
        await submitVolcVideo({ prompt: 'x' }, opts({ duration: -1 }));
        expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).duration).toBe(-1);
    });

    it('未配置 env → 503,不打上游', async () => {
        delete process.env.ENTERPRISE_VOLC_UPSTREAM_KEY;
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

    // 2026-09-22 实测原文:方舟原错以【转义 + 截断】的 JSON 嵌在 message 里
    const NESTED_400 =
        '{"error":{"message":"Failed to submit video generation job: Upstream submit failed (400): {\\"code\\":\\"fail_to_fetch_task\\",\\"message\\":\\"{\\\\\\"error\\\\\\":{\\\\\\"code\\\\\\":\\\\\\"InvalidParameter\\\\\\",\\\\\\"message\\\\\\":\\\\\\"the parameter duration specified in the request is not valid for model doubao--2-0-fast in t2v","type":"proxy_error"},"request_id":"01a0c977-9f51-76d9-8c7f-04ef4ee1ad73"}';

    it('上游嵌套报错 → 拆出方舟原文 + 分类,透传状态码;外壳码/request_id/域名不对客(#271)', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(NESTED_400, { status: 400 }));
        const res = await submitVolcVideo({ prompt: 'x' }, opts({ clientModel: 'doubao-seedance-2.0-fast' }));
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { message: string; category?: string } };
        expect(body.error.message).toContain('the parameter duration specified in the request is not valid');
        expect(body.error.message).toContain('InvalidParameter');
        expect(body.error.category).toBe('duration');
        const s = JSON.stringify(body);
        expect(s).not.toContain('fail_to_fetch_task');
        expect(s).not.toContain('Failed to submit video generation job');
        expect(s).not.toContain('01a0c977');
        expect(s).not.toContain('\\"'); // 转义残渣不能漏出去
    });

    it('unwrapUpstreamError:非嵌套的普通报错原样返回;模型不在套餐 403 文案可读', () => {
        const plain = '{"error":{"message":"Model \'x\' is not available to your account","type":"proxy_error"}}';
        expect(unwrapUpstreamError(plain)).toBe(plain);
        expect(unwrapUpstreamError('not json')).toBe('not json');
        const un = JSON.parse(unwrapUpstreamError(NESTED_400)) as { error: { code: string; message: string } };
        expect(un.error.code).toBe('InvalidParameter');
        expect(un.error.message).toBe(
            'InvalidParameter: the parameter duration specified in the request is not valid for model doubao--2-0-fast in t2v',
        );
    });

    it('opts.upstreamKey 覆盖平台 env key(Bearer 头用客户自己的 sk-inf- key)', async () => {
        const fetchMock = mockSubmit();
        await submitVolcVideo({ prompt: 'x' }, opts({ upstreamKey: 'sk-inf-v1-customer-own' }));
        expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
            Authorization: 'Bearer sk-inf-v1-customer-own',
        });
    });

    it('customerVolcUpstreamKey:sk-inf- 前缀才算客户真 key,占位符 / 旧筷子 kz- key 一律 undefined(回落 env)', () => {
        expect(customerVolcUpstreamKey('sk-inf-v1-real')).toBe('sk-inf-v1-real');
        for (const v of ['kz-old-kuaizi-key', 'platform-env-key', 'placeholder-volc', '', null, undefined]) {
            expect(customerVolcUpstreamKey(v)).toBeUndefined();
        }
    });

    it('写映射表:自造对客号 → 上游 mvt- 受理号(轮询时换回打上游)', async () => {
        vi.mocked(rememberVolcId).mockClear();
        mockSubmit('mvt-52ebaff9b448402a');
        await submitVolcVideo({ prompt: 'x' }, opts());
        expect(rememberVolcId).toHaveBeenCalledTimes(1);
        const [clientId, upstreamId, kind] = vi.mocked(rememberVolcId).mock.calls[0];
        expect(clientId).toMatch(/^cgt-\d{14}-[a-z0-9]{5}$/);
        expect(upstreamId).toBe('mvt-52ebaff9b448402a');
        expect(kind).toBe('task');
    });

    it('每次自造号唯一(同参数两次提交不同 id)', async () => {
        mockSubmit();
        const id1 = ((await (await submitVolcVideo({ prompt: 'x' }, opts())).json()) as { id: string }).id;
        const id2 = ((await (await submitVolcVideo({ prompt: 'x' }, opts())).json()) as { id: string }).id;
        expect(id1).not.toBe(id2);
    });
});

describe('pollVolcVideo', () => {
    it('完成 → 对客号经映射换成 mvt- 打上游、回显对客号;取 metadata.content.video_url + usage', async () => {
        vi.mocked(toUpstreamId).mockResolvedValueOnce('mvt-abc');
        const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
            taskEnvelope({
                status: 'completed',
                outputs: ['https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/out.mp4?sig=1'],
                usage: { completion_tokens: 108900, total_tokens: 108900 },
                metadata: {
                    id: 'cgt-20260922221328-vtg7d',
                    status: 'succeeded',
                    content: {
                        video_url: 'https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/out.mp4?sig=1',
                        last_frame_url: 'https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/last.png',
                    },
                },
            }),
        );
        const res = await pollVolcVideo('cgt-20260922221328-aaaaa');
        expect(fetchMock.mock.calls[0][0]).toBe(`${TASKS}/mvt-abc`);
        expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
        const j = (await res.json()) as Record<string, unknown>;
        expect(j.id).toBe('cgt-20260922221328-aaaaa');
        expect(j.status).toBe('completed');
        expect(j.video_url).toBe('https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/out.mp4?sig=1');
        expect(j.last_frame_url).toBe('https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/last.png');
        expect((j.usage as { completion_tokens: number }).completion_tokens).toBe(108900);
    });

    it('metadata 还没有 content 时兜底 outputs[0]', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            taskEnvelope({ status: 'completed', outputs: ['https://x.volces.com/v.mp4'], metadata: {} }),
        );
        const j = (await (await pollVolcVideo('cgt-b')).json()) as { video_url: string };
        expect(j.video_url).toBe('https://x.volces.com/v.mp4');
    });

    it.each([
        ['preparing', 'queued'],
        ['pending', 'queued'],
        ['processing', 'in_progress'],
        ['completed', 'completed'],
        ['failed', 'failed'],
    ])('上游 %s → 对客 %s', async (up, ours) => {
        vi.spyOn(global, 'fetch').mockResolvedValue(taskEnvelope({ status: up, outputs: [], error: null }));
        const j = (await (await pollVolcVideo('cgt-s')).json()) as { status: string };
        expect(j.status).toBe(ours);
    });

    it('失败:task.error 字符串 → fail_reason 剥掉 TOS 内部残渣与 RequestID,保留客户自己的素材编号;无 usage', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            taskEnvelope({
                status: 'failed',
                outputs: [],
                error: 'Reference material @Image1 could not be prepared: [Failed to download media from the provided URL. Please check if the link is accessible.] tos: request error: Message=fetch object return, RequestID=c9a507b28ddd21856ab28ddd-bff8576-1x91Ir-FO-cb-tos-3az-front-azd-7, EC=',
            }),
        );
        const j = (await (await pollVolcVideo('cgt-f')).json()) as {
            status: string;
            fail_reason: string;
            usage?: unknown;
        };
        expect(j.status).toBe('failed');
        // 通用脱敏会吃掉句尾标点,原因文本本身完整即可
        expect(j.fail_reason).toBe(
            'Reference material @Image1 could not be prepared: Failed to download media from the provided URL. Please check if the link is accessible',
        );
        expect(j.usage).toBeUndefined();
    });

    it('失败原因也可能落在 metadata.error{code,message}(方舟侧失败)', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            taskEnvelope({
                status: 'failed',
                error: null,
                metadata: {
                    id: 'cgt-x',
                    status: 'failed',
                    error: {
                        code: 'InternalServiceError',
                        message: 'The service encountered an unexpected internal error.',
                    },
                },
            }),
        );
        const j = (await (await pollVolcVideo('cgt-f2')).json()) as { fail_reason: string };
        expect(j.fail_reason).toContain('InternalServiceError');
        expect(j.fail_reason).toContain('internal error');
    });

    it('非2xx 但 body 带 status:failed → 按失败终态处理,不当不透明错误', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            taskEnvelope({ status: 'failed', error: 'generation failed upstream' }, 400),
        );
        const res = await pollVolcVideo('cgt-z');
        expect(res.status).toBe(200);
        const j = (await res.json()) as { status: string; fail_reason: string };
        expect(j.status).toBe('failed');
        expect(j.fail_reason).toBe('generation failed upstream');
    });

    it('非2xx 且 body 是纯错误体(任务不存在 404)→ 透传状态码,category task_gone(不终态化,交对账器)', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({ error: { message: 'Task not found', type: 'proxy_error' }, request_id: 'r-1' }),
                { status: 404 },
            ),
        );
        const res = await pollVolcVideo('cgt-y');
        expect(res.status).toBe(404);
        const j = (await res.json()) as { error: { category: string; message: string } };
        expect(j.error.category).toBe('task_gone');
        expect(JSON.stringify(j)).not.toContain('r-1');
    });

    it('未配置 env → 503', async () => {
        delete process.env.ENTERPRISE_VOLC_UPSTREAM_KEY;
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

describe('上游已推导的元数据优先(metadata = 方舟原生体)', () => {
    it('完成态 metadata 里的 duration/ratio/resolution 透出来(客户传 -1,模型实选 5)', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            taskEnvelope({ status: 'completed', metadata: { duration: 5, ratio: '16:9', resolution: '480p' } }),
        );
        const j = (await (await pollVolcVideo('cgt-abc')).json()) as Record<string, unknown>;
        expect(j.duration).toBe(5);
        expect(j.ratio).toBe('16:9');
        expect(j.resolution).toBe('480p');
    });

    it('火山官方字段集从 metadata 透出来(客户契约校验用)', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            taskEnvelope({
                status: 'completed',
                metadata: {
                    framespersecond: 24,
                    generate_audio: true,
                    execution_expires_after: 172800,
                    seed: 26206,
                    created_at: 1790086408,
                    updated_at: 1790086490,
                },
            }),
        );
        const j = (await (await pollVolcVideo('cgt-abc')).json()) as Record<string, unknown>;
        expect(j.framespersecond).toBe(24);
        expect(j.generate_audio).toBe(true);
        expect(j.execution_expires_after).toBe(172800);
        expect(j.seed).toBe(26206);
        expect(j.upstream_created_at).toBe(1790086408);
        expect(j.upstream_updated_at).toBe(1790086490);
    });

    it('preparing(还没 metadata)→ 不带这些键,交给上层回落库值', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            taskEnvelope({ status: 'preparing', prep: { total: 1, active: 0, failed: 0, attempt: 1 } }),
        );
        const j = (await (await pollVolcVideo('cgt-abc')).json()) as Record<string, unknown>;
        for (const k of ['duration', 'ratio', 'resolution', 'upstream_created_at', 'last_frame_url'])
            expect(j).not.toHaveProperty(k);
        expect(j.status).toBe('queued');
    });
});

/**
 * 【契约守护】上游真实响应 fixture —— 2026-09-22 直连 service-inference.ai 抓的完成态原文
 * (fast 480p 4s,return_last_frame=true;签名串已缩短)。
 *
 * 客户对 volc 做响应基准比对,已经多轮报障,根子都是同一个:**我们逐字段重建响应,上游加一个
 * 字段我们就漏一个**。这条测试把「上游有什么」钉死 —— 上游字段没被透出,又不在明示丢弃名单里,
 * CI 直接红。上游将来加字段时,更新 fixture 就会自动暴露我们没适配。
 */
const UPSTREAM_DONE_SAMPLE = {
    id: 'mvt-57bce9f3462447fd',
    status: 'completed',
    model: 'doubao-seedance-2-0-fast-260128-max',
    duration_seconds: 4,
    outputs: [
        'https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/doubao-seedance-2-0-fast/x.mp4?X-Tos-Expires=86400',
    ],
    error: null,
    created_at: '2026-09-22T14:19:16.208Z',
    completed_at: '2026-09-22T14:20:37.000Z',
    usage: { completion_tokens: 40594, total_tokens: 40594 },
    last_frame_url: 'https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/doubao-seedance-2-0-fast/x.png',
    metadata: {
        content: {
            video_url:
                'https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/doubao-seedance-2-0-fast/x.mp4?X-Tos-Expires=86400',
            last_frame_url: 'https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/doubao-seedance-2-0-fast/x.png',
        },
        created_at: 1790086756,
        draft: false,
        duration: 4,
        execution_expires_after: 172800,
        framespersecond: 24,
        generate_audio: true,
        id: 'cgt-20260922221916-c9sxq',
        model: 'doubao-seedance-2-0-fast-260128-max',
        output_format: 'mp4',
        priority: 0,
        ratio: '16:9',
        resolution: '480p',
        seed: 42,
        service_tier: 'default',
        status: 'succeeded',
        updated_at: 1790086837,
        usage: { completion_tokens: 40594, total_tokens: 40594 },
    },
};

/** 明示【不】原样透出的上游字段,每条都要有理由。 */
const INTENTIONALLY_NOT_PASSED: Record<string, string> = {
    // task 顶层
    id: '上游受理号 mvt-,换成我们的对客任务号(客户拿到的是火山型号,见 volc-id-map)',
    status: '经我们的状态机归一后再翻回火山态(queued/running/succeeded/failed)',
    model: '回显客户调用的名字(ark 面回显火山原生 id);上游 -max 名不对客',
    duration_seconds: '与 metadata.duration 重复,取后者(方舟原生键名)',
    outputs: '与 metadata.content.video_url 同一条链,取后者;缺 metadata 时兜底',
    error: '失败时经 cleanTaskError 脱敏后作 fail_reason 透出;成功态 null 无意义',
    created_at: 'ISO 串是上游平台受理时间;对客时间戳取 metadata.created_at(方舟)',
    completed_at: '火山官方响应没有该字段;完成时间由 metadata.updated_at 表达',
    usage: '按我们的计费口径归一(completion/total_tokens),完成态才带',
    metadata: '方舟原生任务体,逐键透出(见下一组)',
    // metadata 内
    'metadata.id': '方舟真号只落日志供内部对账;客户的 id 本身就是火山型号(#271)',
    'metadata.status': '同顶层 status,经状态机归一',
    'metadata.model': '同顶层 model',
    'metadata.usage': '同顶层 usage',
    'metadata.content': '逐键处理:video_url 可能换客户 OSS;last_frame_url 透出',
    'metadata.draft': 'ark-format 固定合成 draft:false(火山官方形要求恒在)',
    'metadata.priority': '火山官方查询响应无此字段,不透',
    // output_format / service_tier / safety_identifier 自 2026-09-23 起透出(火山官方查询响应新增字段)
};

describe('上游字段契约守护(2026-09-22 换上游后重钉 fixture)', () => {
    it('上游响应的每个字段(含 metadata 内层),要么被透出,要么在明示丢弃名单里', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ task: UPSTREAM_DONE_SAMPLE }), { status: 200 }),
        );
        const out = (await (await pollVolcVideo('cgt-abc')).json()) as Record<string, unknown>;
        const surfaced = new Set(Object.keys(out).map((k) => k.replace(/^upstream_/, '')));
        const missing: string[] = [];
        for (const k of Object.keys(UPSTREAM_DONE_SAMPLE)) {
            if (!surfaced.has(k) && !(k in INTENTIONALLY_NOT_PASSED)) missing.push(k);
        }
        for (const k of Object.keys(UPSTREAM_DONE_SAMPLE.metadata)) {
            if (!surfaced.has(k) && !(`metadata.${k}` in INTENTIONALLY_NOT_PASSED)) missing.push(`metadata.${k}`);
        }
        expect(missing).toEqual([]);
    });

    it('成片用火山官方 TOS 直链;上游受理号 mvt- 与 -max 模型名绝不外泄', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ task: UPSTREAM_DONE_SAMPLE }), { status: 200 }),
        );
        const body = await (await pollVolcVideo('cgt-abc')).text();
        expect(body).not.toContain('mvt-');
        expect(body).not.toContain('-max');
        expect(JSON.parse(body).video_url).toContain('ark-acg-cn-beijing');
    });

    it('时间戳取 metadata 真值(方舟受理/更新时间)', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ task: UPSTREAM_DONE_SAMPLE }), { status: 200 }),
        );
        const out = (await (await pollVolcVideo('cgt-abc')).json()) as Record<string, unknown>;
        expect(out.upstream_created_at).toBe(1790086756);
        expect(out.upstream_updated_at).toBe(1790086837);
    });

    it('未要尾帧时成功态 last_frame_url 是空串而非缺键(基准比对里两者不等价)', async () => {
        const sample = {
            ...UPSTREAM_DONE_SAMPLE,
            last_frame_url: undefined,
            metadata: { ...UPSTREAM_DONE_SAMPLE.metadata, content: { video_url: 'https://x.volces.com/v.mp4' } },
        };
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ task: sample }), { status: 200 }));
        const out = (await (await pollVolcVideo('cgt-abc')).json()) as Record<string, unknown>;
        expect(out.last_frame_url).toBe('');
    });
});

describe('档位 / 分辨率表(上游模型表实测)', () => {
    it('pro 四档含 4k;fast / mini 仅 480p/720p(1080p 实测 400);2.5 = 480p/720p/1080p 无 4k', () => {
        expect(VOLC_RESOLUTIONS.pro).toEqual(['480p', '720p', '1080p', '4k']);
        expect(VOLC_RESOLUTIONS.fast).toEqual(['480p', '720p']);
        expect(VOLC_RESOLUTIONS.mini).toEqual(['480p', '720p']);
        expect(VOLC_RESOLUTIONS['2.5']).toEqual(['480p', '720p', '1080p']);
    });
});
