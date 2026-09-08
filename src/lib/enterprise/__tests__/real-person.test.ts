/**
 * 真人活体检测(2026-08-19 并到筷子)。契约来自实测 —— 文档只列了 Action 名、无字段定义。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealPersonError, createVisualValidateSession, getVisualValidateGroupId } from '../real-person';

const KEY = 'kz-test';
const env = (o: Record<string, string | undefined>) =>
    Object.entries(o).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));

beforeEach(() => {
    vi.restoreAllMocks();
    env({ ENTERPRISE_KUAIZI_KEY: KEY, ENTERPRISE_KUAIZI_BASE_URL: 'http://kz.test' });
});
afterEach(() =>
    env({
        ENTERPRISE_KUAIZI_KEY: undefined,
        ENTERPRISE_KUAIZI_BASE_URL: undefined,
        ENTERPRISE_REALPERSON_PROVIDER: undefined,
    }),
);

const okBody = (result: unknown) =>
    new Response(JSON.stringify({ ResponseMetadata: {}, Result: result }), { status: 200 });

describe('createVisualValidateSession', () => {
    it('打筷子 Action 端点 + ApiKey 头,CallbackURL 必传', async () => {
        const f = vi.spyOn(global, 'fetch').mockResolvedValue(okBody({ BytedToken: 'tok1', H5Link: 'https://ark/x' }));
        const r = await createVisualValidateSession('https://cust.example/done');
        expect(r).toEqual({ bytedToken: 'tok1', h5Link: 'https://ark/x' });
        const [url, init] = f.mock.calls[0];
        expect(String(url)).toContain('Action=CreateVisualValidateSession');
        expect((init as RequestInit).headers).toMatchObject({ ApiKey: KEY });
        expect(JSON.parse((init as RequestInit).body as string)).toEqual({ CallbackURL: 'https://cust.example/done' });
    });

    it('客户没传 CallbackURL → 用门户域名兜底(上游必填,不能空着)', async () => {
        process.env.ENTERPRISE_BASE_URL = 'https://galaxytoken.ai';
        const f = vi.spyOn(global, 'fetch').mockResolvedValue(okBody({ BytedToken: 't', H5Link: 'https://ark/y' }));
        await createVisualValidateSession();
        expect(JSON.parse((f.mock.calls[0][1] as RequestInit).body as string).CallbackURL).toBe(
            'https://galaxytoken.ai',
        );
        delete process.env.ENTERPRISE_BASE_URL;
    });

    it('上游少给字段 → 502,不返半个会话', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(okBody({ BytedToken: 'only-token' }));
        await expect(createVisualValidateSession('https://x/y')).rejects.toMatchObject({ status: 502 });
    });

    it('未配 key → 503', async () => {
        delete process.env.ENTERPRISE_KUAIZI_KEY;
        await expect(createVisualValidateSession('https://x/y')).rejects.toMatchObject({ status: 503 });
    });
});

describe('getVisualValidateGroupId', () => {
    it('Result 三种形态都认:裸字符串 / {GroupId} / {Id}', async () => {
        for (const [result, want] of [
            ['group-abc', 'group-abc'],
            [{ GroupId: 'group-def' }, 'group-def'],
            [{ Id: 'group-ghi' }, 'group-ghi'],
        ] as const) {
            vi.restoreAllMocks();
            vi.spyOn(global, 'fetch').mockResolvedValue(okBody(result));
            expect(await getVisualValidateGroupId('tok')).toBe(want);
        }
    });

    it('活体未完成(上游 500 + rpc 内部串)→ 404 可操作文案,不外泄 rpc 细节', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    ResponseMetadata: {
                        Error: { Code: 'InternalError', Message: 'rpc error: code = Internal desc = DoCall ...' },
                    },
                }),
                { status: 500 },
            ),
        );
        const e = await getVisualValidateGroupId('tok').catch((x: RealPersonError) => x);
        expect((e as RealPersonError).status).toBe(404);
        expect((e as RealPersonError).message).toContain('尚未完成');
        expect((e as RealPersonError).message).not.toContain('rpc');
    });

    it('Result 形态完全认不出 → 502 而不是崩', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(okBody({ Weird: 1 }));
        await expect(getVisualValidateGroupId('tok')).rejects.toMatchObject({ status: 502 });
    });

    it('逃生阀 ENTERPRISE_REALPERSON_PROVIDER=727 → 走旧 provider(不打筷子端点)', async () => {
        process.env.ENTERPRISE_REALPERSON_PROVIDER = '727';
        process.env.ENTERPRISE_REALPERSON_BASE_URL = 'http://old.test';
        process.env.ENTERPRISE_REALPERSON_KEY = 'ak-old';
        const f = vi
            .spyOn(global, 'fetch')
            .mockResolvedValue(new Response(JSON.stringify({ code: 0, data: 'grp-old' }), { status: 200 }));
        expect(await getVisualValidateGroupId('tok')).toBe('grp-old');
        expect(String(f.mock.calls[0][0])).toContain('/api/v1/real-person-auth/asset-group/by-byted-token');
        delete process.env.ENTERPRISE_REALPERSON_BASE_URL;
        delete process.env.ENTERPRISE_REALPERSON_KEY;
    });
});
