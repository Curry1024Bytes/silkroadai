/** 「火山」渠道【筷子 provider】单测(2026-11-04 换回筷子;2026-08-17 ~ 09-22 第一期的用例移植):
 *  方舟原生提交/轮询 + kz-cgt- ↔ cgt- id 映射 + 成片直链优先级 + 按上游号前缀分流 + 未配置降级 + 契约守护。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    customerVolcUpstreamKey,
    submitVolcVideo,
    pollVolcVideo,
    cancelVolcVideo,
    volcProvider,
    VOLC_MODELS,
} from '../volc-adapter';
import { rememberVolcId, toUpstreamTask } from '@/lib/enterprise/volc-id-map';

vi.mock('@/lib/enterprise/volc-id-map', () => ({
    rememberVolcId: vi.fn(async () => {}),
    toUpstreamTask: vi.fn(async (id: string) => ({ upstreamId: id, apiVersion: null })),
}));

const BASE = 'http://kuaizi.test';
const KEY = 'kz-test-key';
const TASKS = `${BASE}/ai-open-platform-api/api/v3/contents/generations/tasks`;
const SVC = 'http://svcinf.test';

beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv('ENTERPRISE_KUAIZI_BASE_URL', BASE);
    vi.stubEnv('ENTERPRISE_KUAIZI_KEY', KEY);
    vi.stubEnv('ENTERPRISE_VOLC_UPSTREAM_BASE_URL', SVC);
    vi.stubEnv('ENTERPRISE_VOLC_UPSTREAM_KEY', 'sk-inf-v1-test');
    vi.mocked(toUpstreamTask).mockImplementation(async (id: string) => ({ upstreamId: id, apiVersion: null }));
});
afterEach(() => vi.unstubAllEnvs());

const opts = (over: Partial<Parameters<typeof submitVolcVideo>[1]> = {}) => ({
    clientModel: 'doubao-seedance-2.0',
    resolution: '720p' as const,
    duration: 5,
    ...over,
});

/** 筷子提交响应:{ id: "kz-cgt-…", status } */
function mockSubmit(upstreamId = 'kz-cgt-abc') {
    return vi
        .spyOn(global, 'fetch')
        .mockImplementation(
            async () => new Response(JSON.stringify({ id: upstreamId, status: 'queued' }), { status: 200 }),
        );
}
const taskBody = (extra: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify({ id: 'kz-cgt-abc', ...extra }), { status });

describe('provider 开关', () => {
    it('缺省 = 筷子;ENTERPRISE_VOLC_PROVIDER=svcinf 切 service-inference.ai;其它值回落筷子', () => {
        expect(volcProvider()).toBe('kuaizi');
        vi.stubEnv('ENTERPRISE_VOLC_PROVIDER', 'svcinf');
        expect(volcProvider()).toBe('svcinf');
        vi.stubEnv('ENTERPRISE_VOLC_PROVIDER', 'SVCINF');
        expect(volcProvider()).toBe('svcinf');
        vi.stubEnv('ENTERPRISE_VOLC_PROVIDER', 'whatever');
        expect(volcProvider()).toBe('kuaizi');
    });
});

describe('submitVolcVideo(筷子 provider)', () => {
    it('打筷子方舟端点 + Bearer kz- key,model = 火山方舟官方 Model ID(不带 -max),对客 id = 自造 cgt- 形', async () => {
        const fetchMock = mockSubmit();
        const res = await submitVolcVideo({ prompt: '一只猫', ratio: '16:9' }, opts({ resolution: '1080p' }));
        expect(res.status).toBe(200);
        const j = (await res.json()) as { id: string; task_id: string; status: string; model: string };
        expect(j.id).toMatch(/^cgt-\d{14}-[a-z0-9]{5}$/);
        expect(j.id).not.toContain('kz-');
        expect(j.task_id).toBe(j.id);
        expect(j.status).toBe('queued');
        expect(j.model).toBe('doubao-seedance-2.0');

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(TASKS);
        expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
        const sent = JSON.parse((init as RequestInit).body as string);
        expect(sent.model).toBe('doubao-seedance-2-0-260128');
        expect(sent.resolution).toBe('1080p');
        expect(sent.duration).toBe(5);
        expect(sent.ratio).toBe('16:9');
        expect(sent.content).toEqual([{ type: 'text', text: '一只猫' }]);
        // 一个字节都不打 service-inference.ai
        expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith(SVC))).toBe(false);
    });

    it('四档各自映射到方舟官方 Model ID(筷子收方舟 id,不是 svcinf 的 -max 名)', async () => {
        for (const [clientModel, spec] of Object.entries(VOLC_MODELS)) {
            const fetchMock = mockSubmit();
            await submitVolcVideo({ prompt: 'x' }, opts({ clientModel }));
            const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
            expect(sent.model).toBe(spec.upstream);
            expect(String(sent.model)).not.toContain('-max');
            vi.restoreAllMocks();
        }
    });

    it('客户不传 ratio → 不注入;火山官方字段反向白名单透传;callback_url 不透传', async () => {
        const fetchMock = mockSubmit();
        await submitVolcVideo(
            { prompt: 'x', bitrate_mode: 'vbr', camera_fixed: true, priority: 1, callback_url: 'https://客户/cb' },
            opts({ clientModel: 'doubao-seedance-2.5' }),
        );
        const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(sent).not.toHaveProperty('ratio');
        expect(sent.bitrate_mode).toBe('vbr');
        expect(sent.camera_fixed).toBe(true);
        expect(sent.priority).toBe(1);
        expect(sent).not.toHaveProperty('callback_url');
    });

    it('写映射表:自造对客号 → 筷子受理号 kz-cgt-,不带 API 版本(筷子无此概念)', async () => {
        vi.mocked(rememberVolcId).mockClear();
        mockSubmit('kz-cgt-xyz');
        await submitVolcVideo({ prompt: 'x' }, opts());
        expect(rememberVolcId).toHaveBeenCalledTimes(1);
        const [clientId, upstreamId, kind, , api] = vi.mocked(rememberVolcId).mock.calls[0];
        expect(clientId).toMatch(/^cgt-\d{14}-[a-z0-9]{5}$/);
        expect(upstreamId).toBe('kz-cgt-xyz');
        expect(kind).toBe('task');
        expect(api).toBeUndefined();
    });

    it('客户自带 kz- key 优先;自带 sk-inf- key 在筷子 provider 下不用(回落平台 kz env key)', async () => {
        let fetchMock = mockSubmit();
        await submitVolcVideo({ prompt: 'x' }, opts({ upstreamKey: 'kz-customer-own' }));
        expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
            Authorization: 'Bearer kz-customer-own',
        });
        vi.restoreAllMocks();
        fetchMock = mockSubmit();
        await submitVolcVideo({ prompt: 'x' }, opts({ upstreamKey: 'sk-inf-v1-customer-own' }));
        expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
        expect(customerVolcUpstreamKey('kz-customer-own')).toBe('kz-customer-own');
    });

    it('上游报错 → 透传状态码 + 脱敏原文,绝不回显 request_id / 上游域名(#271)', async () => {
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
        const body = await res.text();
        expect(body).toContain('sensitive content in image');
        expect(body).not.toContain('7f9a72b7');
        expect(body).not.toContain('kuaizi');
    });

    it('筷子 key 未配置 → 503,不打上游(即使 svcinf 配了也不串线)', async () => {
        vi.stubEnv('ENTERPRISE_KUAIZI_KEY', '');
        const fetchMock = vi.spyOn(global, 'fetch');
        const res = await submitVolcVideo({ prompt: 'x' }, opts());
        expect(res.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('样片出正片:客户样片号映射到 kz-cgt- → 取筷子 vendor_task_id(方舟真号)写进 draft_task.id', async () => {
        vi.mocked(toUpstreamTask).mockImplementation(async (id: string) =>
            id === 'cgt-draft1'
                ? { upstreamId: 'kz-cgt-draft1', apiVersion: null }
                : { upstreamId: id, apiVersion: null },
        );
        const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
            const u = String(input);
            if ((init?.method || 'GET') === 'GET' && u.endsWith('/kz-cgt-draft1'))
                return taskBody({ status: 'succeeded', vendor_task_id: 'cgt-20260819224039-bfjdv' });
            return new Response(JSON.stringify({ id: 'kz-cgt-final', status: 'queued' }), { status: 200 });
        });
        const res = await submitVolcVideo(
            { content: [{ type: 'draft_task', draft_task: { id: 'cgt-draft1' } }] },
            opts({ clientModel: 'doubao-seedance-2.5' }),
        );
        expect(res.status).toBe(200);
        const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'POST');
        const sent = JSON.parse((post![1] as RequestInit).body as string);
        expect(sent.content).toEqual([{ type: 'draft_task', draft_task: { id: 'cgt-20260819224039-bfjdv' } }]);
    });

    it('样片出正片:样片建在 svcinf(mvt-)→ 400 指引重出样片,不打上游', async () => {
        vi.mocked(toUpstreamTask).mockResolvedValue({ upstreamId: 'mvt-old', apiVersion: 'v2' });
        const fetchMock = vi.spyOn(global, 'fetch');
        const res = await submitVolcVideo(
            { content: [{ type: 'draft_task', draft_task: { id: 'cgt-draft-svc' } }] },
            opts({ clientModel: 'doubao-seedance-2.5' }),
        );
        expect(res.status).toBe(400);
        expect((await res.json()).error.message).toContain('重新生成样片');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('pollVolcVideo —— 按上游号前缀分流(不看 provider 开关)', () => {
    it('映射到 kz-cgt- → 打筷子;完成态取 content.video_url(方舟 TOS)+ usage,kz_video_url 绝不外泄', async () => {
        vi.mocked(toUpstreamTask).mockResolvedValue({ upstreamId: 'kz-cgt-abc', apiVersion: null });
        const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
            taskBody({
                status: 'succeeded',
                content: {
                    video_url: 'https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/out.mp4',
                    kz_video_url: 'https://bk-hs-p-bj-lizhen.tos-cn-beijing.volces.com/ai_openapi/kz-cgt-abc.mp4',
                    last_frame_url: '',
                },
                usage: { completion_tokens: 108900, total_tokens: 108900 },
                vendor_task_id: 'cgt-20260827005028-fdwbz',
            }),
        );
        const res = await pollVolcVideo('cgt-20260827005028-aaaaa');
        expect(fetchMock.mock.calls[0][0]).toBe(`${TASKS}/kz-cgt-abc`);
        expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
        const text = await res.text();
        const j = JSON.parse(text) as Record<string, unknown>;
        expect(j.id).toBe('cgt-20260827005028-aaaaa');
        expect(j.status).toBe('completed');
        expect(j.video_url).toBe('https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/out.mp4');
        expect(j.last_frame_url).toBe('');
        expect((j.usage as { completion_tokens: number }).completion_tokens).toBe(108900);
        expect(text).not.toContain('kz_video_url');
        expect(text).not.toContain('bk-hs-p-bj-lizhen');
        expect(text).not.toContain('vendor_task_id');
    });

    it('映射到 mvt-(svcinf 时代的历史任务)→ 打 service-inference.ai,即使当前 provider 是筷子', async () => {
        vi.mocked(toUpstreamTask).mockResolvedValue({ upstreamId: 'mvt-old1', apiVersion: 'v2' });
        const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    task: { id: 'mvt-old1', status: 'completed', outputs: ['https://x.volces.com/v.mp4'] },
                }),
                { status: 200 },
            ),
        );
        const res = await pollVolcVideo('cgt-old');
        expect(String(fetchMock.mock.calls[0][0])).toBe(`${SVC}/v2/video/tasks/mvt-old1`);
        expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
            Authorization: 'Bearer sk-inf-v1-test',
        });
        expect(((await res.json()) as { status: string }).status).toBe('completed');
    });

    it('映射查不到的远古任务(cgt-X)→ 按 kz-cgt-X 打筷子兜底', async () => {
        const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(taskBody({ status: 'running' }));
        const j = (await (await pollVolcVideo('cgt-ancient')).json()) as { status: string };
        expect(fetchMock.mock.calls[0][0]).toBe(`${TASKS}/kz-cgt-ancient`);
        expect(j.status).toBe('in_progress');
    });

    it('只给 kz_video_url 时兜底用它;失败带脱敏 fail_reason 且无 usage', async () => {
        vi.mocked(toUpstreamTask).mockResolvedValue({ upstreamId: 'kz-cgt-b', apiVersion: null });
        vi.spyOn(global, 'fetch').mockResolvedValueOnce(
            taskBody({
                status: 'succeeded',
                content: { kz_video_url: 'https://example.tos-cn-beijing.volces.com/v.mp4' },
            }),
        );
        const j1 = (await (await pollVolcVideo('cgt-b')).json()) as { video_url: string };
        expect(j1.video_url).toBe('https://example.tos-cn-beijing.volces.com/v.mp4');

        vi.spyOn(global, 'fetch').mockResolvedValueOnce(
            taskBody({ status: 'failed', error: { message: '生成失败:输入内容未通过审核 Request id: 0217abc' } }),
        );
        const j2 = (await (await pollVolcVideo('cgt-b')).json()) as {
            status: string;
            fail_reason: string;
            usage?: unknown;
        };
        expect(j2.status).toBe('failed');
        expect(j2.fail_reason).toContain('未通过审核');
        expect(j2.usage).toBeUndefined();
    });

    it('非2xx 但 body 带 status:failed → 按失败终态处理(2026-09-11 筷子 InternalServiceError 实测)', async () => {
        vi.mocked(toUpstreamTask).mockResolvedValue({ upstreamId: 'kz-cgt-z', apiVersion: null });
        vi.spyOn(global, 'fetch').mockResolvedValue(
            taskBody(
                { status: 'failed', error: { code: 'InternalServiceError', message: 'unexpected internal error.' } },
                400,
            ),
        );
        const res = await pollVolcVideo('cgt-z');
        expect(res.status).toBe(200);
        const j = (await res.json()) as { status: string; fail_reason: string };
        expect(j.status).toBe('failed');
        expect(j.fail_reason).toContain('internal error');
    });

    it('非2xx 且 body 是纯错误体(任务不存在)→ 透传状态码', async () => {
        vi.mocked(toUpstreamTask).mockResolvedValue({ upstreamId: 'kz-cgt-y', apiVersion: null });
        vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ code: 'InternalServiceError', message: '未找到该任务: record not found' }), {
                status: 500,
            }),
        );
        expect((await pollVolcVideo('cgt-y')).status).toBe(500);
    });

    it('筷子 key 未配置 → 503', async () => {
        vi.stubEnv('ENTERPRISE_KUAIZI_KEY', '');
        expect((await pollVolcVideo('cgt-x')).status).toBe(503);
    });

    it('cancel:两家都无取消端点 → null', async () => {
        const fetchMock = vi.spyOn(global, 'fetch');
        expect(await cancelVolcVideo('cgt-x')).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

/**
 * 【契约守护】筷子完成态真实响应 fixture(2026-08-27 直连抓的原文)。
 * 上游字段没被透出、又不在明示丢弃名单里 → CI 红。
 */
const UPSTREAM_DONE_SAMPLE = {
    content: {
        kz_video_url: 'https://bk-hs-p-bj-lizhen.tos-cn-beijing.volces.com/x.mp4?sig=1',
        last_frame_url: '',
        video_url: 'https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/y.mp4?sig=2',
    },
    created_at: 1787763028,
    duration: 4,
    execution_expires_after: 172800,
    framespersecond: 24,
    generate_audio: true,
    id: 'kz-cgt-abc',
    model: 'doubao-seedance-2-0-260128',
    ratio: '16:9',
    resolution: '480p',
    seed: 12345,
    status: 'succeeded',
    tools: [],
    updated_at: 1787763201,
    usage: { completion_tokens: 40594, total_tokens: 40594 },
    vendor_task_id: 'cgt-20260827005028-fdwbz',
};
const INTENTIONALLY_NOT_PASSED: Record<string, string> = {
    id: '上游受理号 kz-cgt-,换成我们的对客任务号(客户拿到的是火山型号,见 volc-id-map)',
    vendor_task_id: '对客不暴露 —— 客户的 id 是我们自造的火山型号;火山官方响应也没这个字段(#271)',
    status: '经我们的状态机归一后再翻回火山态(queued/running/succeeded/failed)',
    model: '回显客户调用的名字(ark 面回显火山原生 id)',
    usage: '按我们的计费口径归一(completion/total_tokens)',
    content: '逐键处理:video_url 可能换客户 OSS;kz_video_url 是上游转存域名,绝不外泄(#271)',
};

describe('筷子上游字段契约守护', () => {
    it('上游响应的每个字段,要么被透出,要么在明示丢弃名单里', async () => {
        vi.mocked(toUpstreamTask).mockResolvedValue({ upstreamId: 'kz-cgt-abc', apiVersion: null });
        vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(JSON.stringify(UPSTREAM_DONE_SAMPLE), { status: 200 }),
        );
        const out = (await (await pollVolcVideo('cgt-abc')).json()) as Record<string, unknown>;
        const surfaced = new Set(Object.keys(out).map((k) => k.replace(/^upstream_/, '')));
        const missing = Object.keys(UPSTREAM_DONE_SAMPLE).filter(
            (k) => !surfaced.has(k) && !(k in INTENTIONALLY_NOT_PASSED),
        );
        expect(missing).toEqual([]);
        expect(out.upstream_created_at).toBe(1787763028);
        expect(out.upstream_updated_at).toBe(1787763201);
        expect(out.last_frame_url).toBe('');
        expect(out.tools).toEqual([]);
    });
});
