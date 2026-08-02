/** 「火山」渠道视频适配器单测(2026-07-29):火山方舟原生提交/轮询 + 火山直链透传 + 未配置降级。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { submitVolcVideo, pollVolcVideo } from '../volc-adapter';

const BASE = 'http://provider.test';
const KEY = 'sk-volc-test';

beforeEach(() => {
    process.env.ENTERPRISE_VOLC_VIDEO_BASE_URL = BASE;
    process.env.ENTERPRISE_VOLC_VIDEO_KEY = KEY;
    vi.restoreAllMocks();
});
afterEach(() => {
    delete process.env.ENTERPRISE_VOLC_VIDEO_BASE_URL;
    delete process.env.ENTERPRISE_VOLC_VIDEO_KEY;
});

describe('submitVolcVideo', () => {
    it('提交火山方舟形 body 到 provider,返归一 {id,status:queued},task_ id 伪装成 cgt-', async () => {
        const fetchMock = vi
            .spyOn(global, 'fetch')
            .mockResolvedValue(new Response(JSON.stringify({ id: 'task_abc', status: 'queued' }), { status: 200 }));
        const res = await submitVolcVideo({ prompt: '一只猫', ratio: '16:9' }, '1080p', 5);
        expect(res.status).toBe(200);
        const j = (await res.json()) as { id: string; task_id: string; status: string; model: string };
        expect(j.id).toBe('cgt-abc');
        expect(j.task_id).toBe('cgt-abc');
        expect(j.status).toBe('queued');
        expect(j.model).toBe('doubao-seedance-2.0');
        // 打的是 provider 火山方舟原生端点 + Bearer 平台 key + body 含 model/content/resolution
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(`${BASE}/doubao/api/v3/contents/generations/tasks`);
        const sent = JSON.parse((init as RequestInit).body as string);
        expect(sent.model).toBe('doubao-seedance-2.0');
        expect(sent.resolution).toBe('1080p');
        expect(sent.content).toEqual([{ type: 'text', text: '一只猫' }]);
        expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
    });

    it('透传客户 content 数组(多模态)', async () => {
        const fetchMock = vi
            .spyOn(global, 'fetch')
            .mockResolvedValue(new Response(JSON.stringify({ id: 'task_x' }), { status: 200 }));
        const content = [
            { type: 'text', text: '让她跳舞' },
            { type: 'image_url', image_url: { url: 'asset://asset-1' }, role: 'first_frame' },
        ];
        await submitVolcVideo({ content }, '720p', 5);
        const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(sent.content).toEqual(content);
    });

    it('未配置 env → 503', async () => {
        delete process.env.ENTERPRISE_VOLC_VIDEO_KEY;
        const res = await submitVolcVideo({ prompt: 'x' }, '720p', 5);
        expect(res.status).toBe(503);
    });

    it('无 prompt/content → 400,不打上游', async () => {
        const fetchMock = vi.spyOn(global, 'fetch');
        const res = await submitVolcVideo({}, '720p', 5);
        expect(res.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('上游报错 → 透传状态码 + 通用文案', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'bad' }), { status: 400 }));
        const res = await submitVolcVideo({ prompt: 'x' }, '720p', 5);
        expect(res.status).toBe(400);
    });

    it('return_last_frame 透传上游;非 task_ 形上游 id 原样返回', async () => {
        const fetchMock = vi
            .spyOn(global, 'fetch')
            .mockResolvedValue(new Response(JSON.stringify({ id: 'cgt-native-1' }), { status: 200 }));
        const res = await submitVolcVideo({ prompt: 'x', return_last_frame: true }, '720p', 5);
        const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(sent.return_last_frame).toBe(true);
        const j = (await res.json()) as { id: string };
        expect(j.id).toBe('cgt-native-1');
    });
});

describe('pollVolcVideo', () => {
    it('完成 → 归一 status:completed + 火山直链原样透传 + usage;cgt- 形还原 task_ 打上游、回显 cgt-', async () => {
        const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    id: 'task_abc',
                    status: 'succeeded',
                    content: { video_url: 'https://volc-cdn/out.mp4', last_frame_url: 'https://volc-cdn/last.png' },
                    usage: { completion_tokens: 191254, total_tokens: 191254 },
                }),
                { status: 200 },
            ),
        );
        const res = await pollVolcVideo('cgt-abc');
        expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/doubao/api/v3/contents/generations/tasks/task_abc`);
        const j = (await res.json()) as {
            id: string;
            task_id: string;
            status: string;
            video_url: string;
            last_frame_url: string;
            usage: { completion_tokens: number };
        };
        expect(j.id).toBe('cgt-abc');
        expect(j.task_id).toBe('cgt-abc');
        expect(j.status).toBe('completed');
        expect(j.video_url).toBe('https://volc-cdn/out.mp4');
        expect(j.last_frame_url).toBe('https://volc-cdn/last.png');
        expect(j.usage.completion_tokens).toBe(191254);
    });

    it('历史 task_ 形 id 不转换,原样打上游(老任务兼容)', async () => {
        const fetchMock = vi
            .spyOn(global, 'fetch')
            .mockResolvedValue(new Response(JSON.stringify({ id: 'task_old', status: 'queued' }), { status: 200 }));
        const res = await pollVolcVideo('task_old');
        expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/doubao/api/v3/contents/generations/tasks/task_old`);
        expect(((await res.json()) as { id: string }).id).toBe('task_old');
    });

    it('还原后 404 → 用原始 cgt- id 回退一次(上游原生 cgt- id 兜底)', async () => {
        const fetchMock = vi
            .spyOn(global, 'fetch')
            .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }))
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ id: 'cgt-native-1', status: 'running' }), { status: 200 }),
            );
        const res = await pollVolcVideo('cgt-native-1');
        expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/doubao/api/v3/contents/generations/tasks/task_native-1`);
        expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/doubao/api/v3/contents/generations/tasks/cgt-native-1`);
        expect(res.status).toBe(200);
        const j = (await res.json()) as { id: string; status: string };
        expect(j.id).toBe('cgt-native-1');
        expect(j.status).toBe('in_progress');
    });

    it('失败 → status:failed + fail_reason,无 usage', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ id: 't', status: 'failed', error: { message: '内容审核未通过' } }), {
                status: 200,
            }),
        );
        const res = await pollVolcVideo('t');
        const j = (await res.json()) as { status: string; fail_reason: string; usage?: unknown };
        expect(j.status).toBe('failed');
        expect(j.fail_reason).toBe('内容审核未通过');
        expect(j.usage).toBeUndefined();
    });

    it('未配置 env → 503', async () => {
        delete process.env.ENTERPRISE_VOLC_VIDEO_BASE_URL;
        const res = await pollVolcVideo('t');
        expect(res.status).toBe(503);
    });
});
