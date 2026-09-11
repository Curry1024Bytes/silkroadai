import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Mapping = { vendor_id: string; upstream_id: string; kind: string; user_id: string | null };
const { rows, lookup, create, upsert, transaction, fetchMock } = vi.hoisted(() => ({
    rows: new Map<string, Mapping>(),
    lookup: vi.fn(),
    create: vi.fn(),
    upsert: vi.fn(),
    transaction: vi.fn(),
    fetchMock: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
    prisma: { $transaction: transaction, volcIdMap: { findUnique: lookup, create, upsert } },
}));

import { rememberVolcId, toUpstreamId } from '@/lib/enterprise/volc-id-map';
import { pollVolcVideo, submitVolcVideo } from '../kuaizi-adapter';
import { isTerminalTaskFailure, type UpstreamErrorCategory } from '../upstream-error';

const TASKS = 'https://provider.test/ai-open-platform-api/api/v3/contents/generations/tasks';
const CLIENT_ID = 'cgt-20260911093000-abc12';
const UPSTREAM_ID = 'kz-cgt-accepted-once';
const opts = { clientModel: 'doubao-seedance-2.5', resolution: '720p', duration: 5 } as const;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
async function terminal(res: Response): Promise<boolean> {
    const body = (await res.json()) as { error: { category: UpstreamErrorCategory } };
    return isTerminalTaskFailure(body.error.category, res.status);
}

beforeEach(() => {
    vi.resetAllMocks();
    rows.clear();
    vi.stubEnv('ENTERPRISE_KUAIZI_BASE_URL', 'https://provider.test');
    vi.stubEnv('ENTERPRISE_KUAIZI_KEY', 'kz-fixture-only');
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    lookup.mockImplementation(async ({ where }: { where: { vendor_id: string } }) => rows.get(where.vendor_id) ?? null);
    create.mockImplementation(async ({ data }: { data: Mapping }) => {
        if (rows.has(data.vendor_id)) throw Object.assign(new Error('unique violation'), { code: 'P2002' });
        rows.set(data.vendor_id, data);
        return data;
    });
    transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ volcIdMap: { findUnique: lookup, create } }),
    );
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('平台视频任务号的持久化与失败时序', () => {
    it('持久化完成前不返回随机号；重新加载模块后仍可轮询排队与完成，不重复提交', async () => {
        let release: () => void = () => {};
        const pendingWrite = new Promise<void>((resolve) => {
            release = resolve;
        });
        create.mockImplementationOnce(async ({ data }: { data: Mapping }) => {
            await pendingWrite;
            rows.set(data.vendor_id, data);
            return data;
        });
        fetchMock.mockResolvedValueOnce(response({ id: UPSTREAM_ID }));
        let returned = false;
        const submit = submitVolcVideo({ prompt: 'fixture' }, opts).then((res) => {
            returned = true;
            return res;
        });
        await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
        expect(returned).toBe(false);
        expect(fetchMock).toHaveBeenCalledOnce();
        release();
        const { id } = (await (await submit).json()) as { id: string };
        expect(id).toMatch(/^cgt-\d{14}-[a-z0-9]{5}$/);
        expect(rows.get(id)?.upstream_id).toBe(UPSTREAM_ID);

        vi.resetModules();
        const restarted = await import('../kuaizi-adapter');
        fetchMock.mockResolvedValueOnce(response({ status: 'running' }));
        expect(await (await restarted.pollVolcVideo(id)).json()).toMatchObject({ id, status: 'in_progress' });
        fetchMock.mockResolvedValueOnce(response({ status: 'succeeded', usage: { completion_tokens: 100 } }));
        expect(await (await restarted.pollVolcVideo(id)).json()).toMatchObject({
            id,
            status: 'completed',
            usage: { completion_tokens: 100 },
        });
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
            TASKS,
            `${TASKS}/${UPSTREAM_ID}`,
            `${TASKS}/${UPSTREAM_ID}`,
        ]);
        expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit).method === 'POST')).toHaveLength(1);
    });

    it.each(['kz-cgt-accepted-once', 'cgt-provider-native', 'other-opaque-123'])(
        '映射写入失败仍返回可查询句柄，不重发收费 POST：%s',
        async (upstreamId) => {
            transaction.mockRejectedValueOnce(new Error('write unavailable'));
            fetchMock.mockResolvedValueOnce(response({ id: upstreamId }));
            const res = await submitVolcVideo({ prompt: 'fixture' }, opts);
            const { id } = (await res.json()) as { id: string };
            expect(res.status).toBe(200);
            expect(id).toMatch(/^cgt-recovery-/);
            expect(fetchMock).toHaveBeenCalledOnce();
            expect(rows.size).toBe(0);

            lookup.mockRejectedValue(new Error('mapping database still unavailable'));
            fetchMock.mockResolvedValueOnce(response({ status: 'running' }));
            const polled = await pollVolcVideo(id);
            expect(await polled.json()).toMatchObject({ id, status: 'in_progress' });
            expect(fetchMock.mock.calls[1][0]).toBe(`${TASKS}/${upstreamId}`);
            expect(lookup).not.toHaveBeenCalled();
        },
    );

    it('随机号碰撞不覆盖旧任务映射，同一映射可幂等保存', async () => {
        const original: Mapping = { vendor_id: CLIENT_ID, upstream_id: 'kz-cgt-old', kind: 'task', user_id: null };
        rows.set(CLIENT_ID, original);
        await expect(rememberVolcId(CLIENT_ID, 'kz-cgt-new', 'task')).rejects.toMatchObject({ status: 503 });
        expect(rows.get(CLIENT_ID)).toEqual(original);
        await expect(rememberVolcId(CLIENT_ID, 'kz-cgt-old', 'task')).resolves.toBeUndefined();
        expect(create).not.toHaveBeenCalled();
        expect(upsert).not.toHaveBeenCalled();
    });

    it('并发主键碰撞走可恢复句柄，旧任务不被覆盖', async () => {
        create.mockImplementationOnce(async ({ data }: { data: Mapping }) => {
            rows.set(data.vendor_id, { ...data, upstream_id: 'kz-cgt-other-task' });
            throw Object.assign(new Error('concurrent unique violation'), { code: 'P2002' });
        });
        fetchMock.mockResolvedValueOnce(response({ id: UPSTREAM_ID }));
        const { id } = (await (await submitVolcVideo({ prompt: 'fixture' }, opts)).json()) as { id: string };
        expect(id).toMatch(/^cgt-recovery-/);
        expect([...rows.values()][0].upstream_id).toBe('kz-cgt-other-task');
        fetchMock.mockResolvedValueOnce(response({ status: 'running' }));
        await pollVolcVideo(id);
        expect(fetchMock.mock.calls[1][0]).toBe(`${TASKS}/${UPSTREAM_ID}`);
    });

    it('临时查库失败返回可重试 503，不查询错误任务；恢复后继续完成', async () => {
        rows.set(CLIENT_ID, { vendor_id: CLIENT_ID, upstream_id: UPSTREAM_ID, kind: 'task', user_id: null });
        lookup.mockRejectedValueOnce(new Error('read unavailable'));
        const res = await pollVolcVideo(CLIENT_ID);
        expect(res.status).toBe(503);
        expect(res.headers.get('Retry-After')).toBe('5');
        expect(await terminal(res)).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
        fetchMock.mockResolvedValueOnce(response({ status: 'succeeded', usage: { completion_tokens: 100 } }));
        expect(await (await pollVolcVideo(CLIENT_ID)).json()).toMatchObject({ id: CLIENT_ID, status: 'completed' });
        expect(fetchMock.mock.calls[0][0]).toBe(`${TASKS}/${UPSTREAM_ID}`);
    });

    it('随机号映射丢失且回退查询全部 404 时不误判终态；恢复映射后可查', async () => {
        fetchMock.mockImplementation(async () =>
            response({ error: { code: 'TaskNotFound', message: 'task not found' } }, 404),
        );
        const res = await pollVolcVideo(CLIENT_ID);
        expect(res.status).toBe(503);
        expect(await terminal(res)).toBe(false);
        rows.set(CLIENT_ID, { vendor_id: CLIENT_ID, upstream_id: UPSTREAM_ID, kind: 'task', user_id: null });
        fetchMock.mockResolvedValueOnce(response({ status: 'running' }));
        expect(await (await pollVolcVideo(CLIENT_ID)).json()).toMatchObject({ status: 'in_progress' });
        expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(`${TASKS}/${UPSTREAM_ID}`);
    });

    it('有映射的任务查不到时保留 404/task_gone，沿用延迟对账而非立即终态化', async () => {
        rows.set(CLIENT_ID, { vendor_id: CLIENT_ID, upstream_id: UPSTREAM_ID, kind: 'task', user_id: null });
        fetchMock.mockImplementation(async () =>
            response({ error: { code: 'TaskNotFound', message: 'task not found' } }, 404),
        );
        const res = await pollVolcVideo(CLIENT_ID);
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { category: UpstreamErrorCategory } };
        expect(body.error.category).toBe('task_gone');
        expect(isTerminalTaskFailure(body.error.category, res.status)).toBe(false);
    });

    it('素材映射继续 best-effort，不受任务严格写入影响', async () => {
        upsert.mockRejectedValueOnce(new Error('asset write unavailable'));
        await expect(rememberVolcId('asset-fixture', '123', 'asset')).resolves.toBeUndefined();
        expect(transaction).not.toHaveBeenCalled();
        lookup.mockRejectedValueOnce(new Error('asset read unavailable'));
        await expect(toUpstreamId('asset-fixture')).resolves.toBe('asset-fixture');
    });
});
