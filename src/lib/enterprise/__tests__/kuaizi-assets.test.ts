/** 筷子开放平台素材库适配单测:Action 转发 + ApiKey 头 + 信封拆装 + 错误映射 + 开关。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    handleKuaiziAssetAction,
    kuaiziAssetsEnabled,
    shouldUseKuaiziAssets,
    KUAIZI_ASSET_ACTIONS,
} from '../kuaizi-assets';
import { RealPersonError } from '../real-person';
import { rememberVolcId, toUpstreamId, toVendorId } from '../volc-id-map';

// 组名所有权表:内存 mock(本文件验 Action 契约;持久化行为在 volc-group-meta 自身)。
const { groupMetaStore, saveGroupMeta, updateGroupMeta, getGroupMeta, deleteGroupMeta } = vi.hoisted(() => {
    const store = new Map<string, { name: string; description: string | null }>();
    return {
        groupMetaStore: store,
        saveGroupMeta: vi.fn(async (id: string, _u: string | undefined, name: string, description?: string) => {
            store.set(id, { name, description: description ?? null });
        }),
        updateGroupMeta: vi.fn(
            async (
                id: string,
                _u: string | undefined,
                patch: { name?: string; description?: string },
                fallbackName: string,
            ) => {
                const cur = store.get(id) ?? { name: fallbackName, description: null };
                store.set(id, {
                    name: patch.name ?? cur.name,
                    description: patch.description !== undefined ? patch.description : cur.description,
                });
            },
        ),
        getGroupMeta: vi.fn(async (id: string) => store.get(id) ?? null),
        deleteGroupMeta: vi.fn(async (id: string) => {
            store.delete(id);
        }),
    };
});
vi.mock('../volc-group-meta', () => ({ saveGroupMeta, updateGroupMeta, getGroupMeta, deleteGroupMeta }));

// 映射表是翻译层,单测里 stub 掉 —— 本文件验的是 Action 契约,不是持久化。
vi.mock('../volc-id-map', () => ({
    rememberVolcId: vi.fn(async () => {}),
    toUpstreamId: vi.fn(async (id: string) => id),
    toUpstreamIds: vi.fn(async (ids: string[]) => ids),
    toVendorId: vi.fn(async (id: string) => id),
}));

const BASE = 'http://kuaizi.test';
const KEY = 'kz-test-key';
const ENDPOINT = `${BASE}/ai-open-platform-api/api/support/v1/asset`;

const envelope = (result: unknown) => JSON.stringify({ ResponseMetadata: { RequestId: 'r1' }, Result: result });

beforeEach(() => {
    process.env.ENTERPRISE_KUAIZI_BASE_URL = BASE;
    process.env.ENTERPRISE_KUAIZI_KEY = KEY;
    vi.restoreAllMocks();
    vi.mocked(rememberVolcId).mockClear();
    vi.mocked(toUpstreamId)
        .mockReset()
        .mockImplementation(async (id: string) => id);
    vi.mocked(toVendorId)
        .mockReset()
        .mockImplementation(async (id: string) => id);
    groupMetaStore.clear();
    vi.mocked(saveGroupMeta).mockClear();
});
afterEach(() => {
    delete process.env.ENTERPRISE_KUAIZI_BASE_URL;
    delete process.env.ENTERPRISE_KUAIZI_KEY;
    delete process.env.ENTERPRISE_KUAIZI_ASSETS;
});

describe('kuaiziAssetsEnabled', () => {
    it('缺省开(火山渠道单客户专属);置 "0" 才回落平台库', () => {
        expect(kuaiziAssetsEnabled()).toBe(true);
        process.env.ENTERPRISE_KUAIZI_ASSETS = '0';
        expect(kuaiziAssetsEnabled()).toBe(false);
        process.env.ENTERPRISE_KUAIZI_ASSETS = '1';
        expect(kuaiziAssetsEnabled()).toBe(true);
    });
    it('接管 10 个火山素材 Action', () => {
        expect(KUAIZI_ASSET_ACTIONS.size).toBe(10);
        expect(KUAIZI_ASSET_ACTIONS.has('CreateAsset')).toBe(true);
        expect(KUAIZI_ASSET_ACTIONS.has('ListAssetGroups')).toBe(true);
        // 真人认证不归素材库接管
        expect(KUAIZI_ASSET_ACTIONS.has('CreateVisualValidateSession')).toBe(false);
    });
});

describe('shouldUseKuaiziAssets —— volc 客户的分流规则', () => {
    it('缺省(AIGC / 无 id)走筷子', () => {
        expect(shouldUseKuaiziAssets('ListAssets', {})).toBe(true);
        expect(shouldUseKuaiziAssets('CreateAssetGroup', { Name: 'g', GroupType: 'AIGC' })).toBe(true);
        expect(shouldUseKuaiziAssets('GetAsset', { Id: '1800657071180349888' })).toBe(true);
    });

    it('真人素材(LivenessFace)回落平台库 —— 四渠道通用 + 筷子只支持 AIGC,转过去必 400', () => {
        expect(shouldUseKuaiziAssets('CreateAssetGroup', { Name: 'g', GroupType: 'LivenessFace' })).toBe(false);
        expect(shouldUseKuaiziAssets('ListAssetGroups', { GroupType: 'LivenessFace' })).toBe(false);
        expect(shouldUseKuaiziAssets('ListAssets', { Filter: { GroupType: 'LivenessFace' } })).toBe(false);
    });

    it('平台形 id(asset-… / group-…)回落平台库,存量素材按 Id 仍可 CRUD', () => {
        // ⚠️ 平台形 = 6 位【十六进制】后缀(newAssetId: randomBytes(3))。
        // 旧用例这里写的 `asset-20260803095838-5n989` 其实是 5 位且含 'n' —— 那是
        // 筷子 vendor id 的形态,不是我们的;2026-08-19 收紧判据后已更正。
        expect(shouldUseKuaiziAssets('GetAsset', { Id: 'asset-20260803095838-5e9891' })).toBe(false);
        expect(shouldUseKuaiziAssets('DeleteAssetGroup', { Id: 'group-20260719153506-b945c6' })).toBe(false);
        // CreateAsset 指定平台形 GroupId → 跟着组走
        expect(
            shouldUseKuaiziAssets('CreateAsset', {
                GroupId: 'group-20260719153506-b945c6',
                URL: 'https://x/a.jpg',
                AssetType: 'Image',
            }),
        ).toBe(false);
    });

    it('非素材 Action(真人认证等)一律不接管', () => {
        expect(shouldUseKuaiziAssets('CreateVisualValidateSession', {})).toBe(false);
        expect(shouldUseKuaiziAssets('GetVisualValidateResult', { BytedToken: 'x' })).toBe(false);
    });
});

describe('handleKuaiziAssetAction', () => {
    it('CreateAsset:打 Action 单入口 + ApiKey 头(非 Bearer),AssetType 归一 Title-case,返【火山素材号】', async () => {
        // CreateAsset 后适配器会压着轮询 GetAsset 等火山素材号(实测 ~7.5s,Processing 期就有)
        const fetchMock = vi.spyOn(global, 'fetch').mockImplementation((_u, init) => {
            const action = String(_u).includes('Action=CreateAsset') ? 'create' : 'get';
            void init;
            return Promise.resolve(
                new Response(
                    envelope(
                        action === 'create'
                            ? { Id: '1800657071180349888' }
                            : {
                                  Id: '1800657071180349888',
                                  Status: 'Processing',
                                  VendorAssetId: 'asset-20260819105009-jvndn',
                              },
                    ),
                    { status: 200 },
                ),
            );
        });
        const r = await handleKuaiziAssetAction('CreateAsset', {
            GroupId: '1800657071180349525',
            URL: 'https://cdn.test/a.jpg',
            AssetType: 'image',
            Name: '封面图',
        });
        expect(r).toEqual({ Id: 'asset-20260819105009-jvndn' });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(`${ENDPOINT}?Action=CreateAsset&Version=2024-01-01`);
        expect((init as RequestInit).headers).toMatchObject({ ApiKey: KEY });
        expect((init as RequestInit).headers).not.toHaveProperty('Authorization');
        expect(JSON.parse((init as RequestInit).body as string)).toEqual({
            GroupId: '1800657071180349525',
            URL: 'https://cdn.test/a.jpg',
            AssetType: 'Image',
            Name: '封面图',
        });
    });

    it('ListAssets:平铺 GroupId 归一成 Filter.GroupIds;分页壳保持火山官方形 TotalCount', async () => {
        const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(envelope({ Items: [{ Id: '1' }], TotalCount: 1, PageNumber: 1, PageSize: 20 }), {
                status: 200,
            }),
        );
        const r = await handleKuaiziAssetAction('ListAssets', { GroupId: '1800657071180349525' });
        // volc = 原生火山:分页总数用上游的 TotalCount,不改名成平台库面的 Total
        expect(r).toEqual({ Items: [{ Id: '1' }], TotalCount: 1, PageNumber: 1, PageSize: 20 });
        const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(sent.Filter).toEqual({ GroupIds: ['1800657071180349525'] });
        expect(sent.PageNumber).toBe(1);
    });

    it('UpdateAsset / DeleteAsset:回 {Id} / {},转发对应 Action', async () => {
        // 每次调用给一个全新 Response(body 只能消费一次)
        const fetchMock = vi
            .spyOn(global, 'fetch')
            .mockImplementation(() => Promise.resolve(new Response(envelope({}), { status: 200 })));
        expect(await handleKuaiziAssetAction('UpdateAsset', { Id: '9', Name: '新名' })).toEqual({ Id: '9' });
        expect(await handleKuaiziAssetAction('DeleteAsset', { Id: '9' })).toEqual({});
        expect(fetchMock.mock.calls[0][0]).toContain('Action=UpdateAsset');
        expect(fetchMock.mock.calls[1][0]).toContain('Action=DeleteAsset');
    });

    // 上游的 not-found 错误码有好几种写法(ResourceNotFound / InternalError+rpc NotFound…)——
    // 一律归到平台素材库同款的 AssetNotFound / GroupNotFound,两套库对客一个口径。
    it('上游 Error 信封 → RealPersonError;not-found 类归一到 AssetNotFound', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    ResponseMetadata: { Error: { Code: 'ResourceNotFound', Message: '素材不存在' } },
                }),
                { status: 404 },
            ),
        );
        await expect(handleKuaiziAssetAction('GetAsset', { Id: '9' })).rejects.toMatchObject({
            status: 404,
            code: 'AssetNotFound',
            message: '素材不存在: 9',
        });
    });

    it('上游 401 = 平台凭证问题 → 502 且不把上游文案抛给客户', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({ ResponseMetadata: { Error: { Code: 'Unauthorized', Message: 'invalid ApiKey' } } }),
                {
                    status: 401,
                },
            ),
        );
        const e = await handleKuaiziAssetAction('ListAssets', {}).catch((x: RealPersonError) => x);
        expect((e as RealPersonError).status).toBe(502);
        expect((e as RealPersonError).message).not.toContain('ApiKey');
    });

    it('未配置 key → 503;上游不可达 → 503;非 JSON → 502', async () => {
        delete process.env.ENTERPRISE_KUAIZI_KEY;
        await expect(handleKuaiziAssetAction('ListAssets', {})).rejects.toMatchObject({ status: 503 });

        process.env.ENTERPRISE_KUAIZI_KEY = KEY;
        vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
        await expect(handleKuaiziAssetAction('ListAssets', {})).rejects.toMatchObject({ status: 503 });

        vi.restoreAllMocks();
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response('<html>502</html>', { status: 502 }));
        await expect(handleKuaiziAssetAction('ListAssets', {})).rejects.toMatchObject({ status: 502 });
    });

    it('参数非法 → 400 InvalidParameter,不打上游', async () => {
        const fetchMock = vi.spyOn(global, 'fetch');
        await expect(handleKuaiziAssetAction('CreateAsset', { URL: 'https://x/a.jpg' })).rejects.toMatchObject({
            status: 400,
            code: 'InvalidParameter',
        });
        // 上游仅支持 AIGC 组类型
        await expect(
            handleKuaiziAssetAction('CreateAssetGroup', { Name: 'g', GroupType: 'LivenessFace' }),
        ).rejects.toMatchObject({ status: 400 });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('未知 Action → 400 InvalidAction', async () => {
        await expect(handleKuaiziAssetAction('Nope', {})).rejects.toMatchObject({
            status: 400,
            code: 'InvalidAction',
        });
    });
});

describe('上游错误归一(2026-08-22 客户实测报障)', () => {
    // 客户测的是「删掉再查」,上游对不存在的资源返:
    //   HTTP 500  Code=InternalError
    //   Message="get asset failed: rpc error: code = NotFound desc = asset not found: id=192612151255367695"
    // 三处不合格:状态码该 404、错误码该是 NotFound 语义、且**泄露了上游内部十进制 id**。
    const upstreamErr = (status: number, code: string, message: string) =>
        new Response(
            JSON.stringify({ ResponseMetadata: { RequestId: 'r1', Error: { Code: code, Message: message } } }),
            {
                status,
            },
        );

    it('删掉的素材再查 → 404 AssetNotFound(不是 500),且回显【客户自己的号】', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            upstreamErr(
                500,
                'InternalError',
                'get asset failed: rpc error: code = NotFound desc = asset not found: id=192612151255367695',
            ),
        );
        await expect(handleKuaiziAssetAction('GetAsset', { Id: 'asset-20260822022949-s844p' })).rejects.toMatchObject({
            status: 404,
            code: 'AssetNotFound',
            message: '素材不存在: asset-20260822022949-s844p',
        });
    });

    it('删掉的素材组再查 → 404 GroupNotFound', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            upstreamErr(
                500,
                'InternalError',
                'get asset group failed: rpc error: code = NotFound desc = asset group not found: id=192612150533947407',
            ),
        );
        await expect(
            handleKuaiziAssetAction('GetAssetGroup', { Id: 'group-20260822022948-kbfr7' }),
        ).rejects.toMatchObject({ status: 404, code: 'GroupNotFound' });
    });

    it('绝不把上游内部 id / rpc 细节回显给客户(#271)', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            upstreamErr(
                500,
                'InternalError',
                'boom: rpc error: code = Internal desc = 内部依赖异常: id=192612151255367695',
            ),
        );
        let caught: RealPersonError | undefined;
        try {
            await handleKuaiziAssetAction('GetAsset', { Id: 'asset-x' });
        } catch (x) {
            caught = x as RealPersonError;
        }
        expect(caught?.status).toBe(502);
        expect(caught?.message).not.toContain('192612151255367695');
        expect(caught?.message).not.toContain('rpc error');
        expect(caught?.message).toContain('内部依赖异常');
    });

    it('非 NotFound 的 4xx 仍按原状态码 + 上游 code 透出(参数错还是要让客户看见)', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(upstreamErr(400, 'InvalidParameter', 'invalid Id: asset-x'));
        await expect(handleKuaiziAssetAction('GetAsset', { Id: 'asset-x' })).rejects.toMatchObject({
            status: 400,
            code: 'InvalidParameter',
        });
    });
});

describe('CreateAsset 压着等火山素材号(2026-08-19)', () => {
    const create = () => new Response(envelope({ Id: '1800657071180349888' }), { status: 200 });

    it('上游迟迟不给 VendorAssetId → 504,不吐一个非火山的号', async () => {
        process.env.ENTERPRISE_VOLC_VENDOR_WAIT_MS = '1';
        vi.spyOn(global, 'fetch').mockImplementation((u) =>
            Promise.resolve(
                String(u).includes('Action=CreateAsset')
                    ? create()
                    : new Response(envelope({ Id: '1800657071180349888', Status: 'Processing' }), { status: 200 }),
            ),
        );
        await expect(
            handleKuaiziAssetAction('CreateAsset', { GroupId: 'g', URL: 'https://x/a.jpg', AssetType: 'image' }),
        ).rejects.toMatchObject({ status: 504 });
        delete process.env.ENTERPRISE_VOLC_VENDOR_WAIT_MS;
    });

    it('素材已 Failed 却仍无火山号 → 立刻报错,不空等到超时', async () => {
        process.env.ENTERPRISE_VOLC_VENDOR_WAIT_MS = '60000';
        vi.spyOn(global, 'fetch').mockImplementation((u) =>
            Promise.resolve(
                String(u).includes('Action=CreateAsset')
                    ? create()
                    : new Response(envelope({ Id: '1800657071180349888', Status: 'Failed' }), { status: 200 }),
            ),
        );
        await expect(
            handleKuaiziAssetAction('CreateAsset', { GroupId: 'g', URL: 'https://x/a.jpg', AssetType: 'image' }),
        ).rejects.toMatchObject({ status: 502, code: 'AssetCreateFailed' });
        delete process.env.ENTERPRISE_VOLC_VENDOR_WAIT_MS;
    });
});

describe('火山原生 id / URL 归一(2026-08-19)+ id 判据收紧', () => {
    // volc 卖的是原生火山体验 → 对客只出火山自己的号和链接,Vendor* 三个键全部撤掉
    // (火山官方响应里根本没有这些键,留着反而不原生)。

    it('CreateAssetGroup:上游只收【机器名】,客户名落我们的表;返火山组号', async () => {
        const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(envelope({ Id: '191950112983875603', VendorGroupId: 'group-20260819085158-kkp5p' }), {
                status: 200,
            }),
        );
        expect(await handleKuaiziAssetAction('CreateAssetGroup', { Name: '我的素材组', Description: '备注' })).toEqual({
            Id: 'group-20260819085158-kkp5p',
        });
        const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(sent.Name).toMatch(/^g-[0-9a-f]{16}$/);
        expect(JSON.stringify(sent)).not.toContain('我的素材组');
        expect(saveGroupMeta).toHaveBeenCalledWith('group-20260819085158-kkp5p', undefined, '我的素材组', '备注');
        expect(rememberVolcId).toHaveBeenCalledWith(
            'group-20260819085158-kkp5p',
            '191950112983875603',
            'group',
            undefined,
        );
    });

    it('同名建组两次 → 都成功(火山官方允许重名;上游只见不重复的机器名)', async () => {
        let n = 0;
        vi.spyOn(global, 'fetch').mockImplementation(() => {
            n += 1;
            return Promise.resolve(
                new Response(
                    envelope({ Id: `19195011298387560${n}`, VendorGroupId: `group-2026083100000${n}-aaaa${n}` }),
                    { status: 200 },
                ),
            );
        });
        const r1 = (await handleKuaiziAssetAction('CreateAssetGroup', { Name: '重名组' })) as { Id: string };
        const r2 = (await handleKuaiziAssetAction('CreateAssetGroup', { Name: '重名组' })) as { Id: string };
        expect(r1.Id).not.toBe(r2.Id);
        expect(groupMetaStore.get(r1.Id)?.name).toBe('重名组');
        expect(groupMetaStore.get(r2.Id)?.name).toBe('重名组');
    });

    it('GetAssetGroup:名字/描述以我们的表覆盖;老组无表行回落上游名', async () => {
        groupMetaStore.set('group-20260831000001-aaaa1', { name: '客户名', description: '客户描述' });
        vi.spyOn(global, 'fetch').mockImplementation(() =>
            Promise.resolve(
                new Response(
                    envelope({
                        Id: '191950112983875603',
                        Name: 'g-0123456789abcdef',
                        Title: 'g-0123456789abcdef',
                        GroupType: 'AIGC',
                        VendorGroupId: 'group-20260831000001-aaaa1',
                    }),
                    { status: 200 },
                ),
            ),
        );
        const r = (await handleKuaiziAssetAction('GetAssetGroup', { Id: 'group-20260831000001-aaaa1' })) as Record<
            string,
            unknown
        >;
        expect(r.Name).toBe('客户名');
        expect(r.Title).toBe('客户名');
        expect(r.Description).toBe('客户描述');
        groupMetaStore.clear();
        const r2 = (await handleKuaiziAssetAction('GetAssetGroup', { Id: 'group-20260831000001-aaaa1' })) as Record<
            string,
            unknown
        >;
        expect(r2.Name).toBe('g-0123456789abcdef');
    });

    it('UpdateAssetGroup:只写我们的表,不 PUT 上游(先 Get 校验存在性)', async () => {
        const fetchMock = vi
            .spyOn(global, 'fetch')
            .mockResolvedValue(
                new Response(
                    envelope({ Id: '191950112983875603', Name: 'g-abc', VendorGroupId: 'group-20260831000001-aaaa1' }),
                    { status: 200 },
                ),
            );
        await handleKuaiziAssetAction('UpdateAssetGroup', { Id: 'group-20260831000001-aaaa1', Name: '新名字' });
        const actions = fetchMock.mock.calls.map((c) => String(c[0]));
        expect(actions.some((u) => u.includes('Action=GetAssetGroup'))).toBe(true);
        expect(actions.some((u) => u.includes('Action=UpdateAssetGroup'))).toBe(false);
        expect(groupMetaStore.get('group-20260831000001-aaaa1')?.name).toBe('新名字');
    });

    it('ListAssetGroups 带 Name 筛选 → 不转发上游,本地按覆盖后的名字过滤', async () => {
        groupMetaStore.set('group-20260831000001-aaaa1', { name: '产品图', description: null });
        groupMetaStore.set('group-20260831000002-aaaa2', { name: '头像', description: null });
        const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(
                envelope({
                    Items: [
                        { Id: '1', Name: 'g-x1', VendorGroupId: 'group-20260831000001-aaaa1' },
                        { Id: '2', Name: 'g-x2', VendorGroupId: 'group-20260831000002-aaaa2' },
                    ],
                    TotalCount: 2,
                    PageNumber: 1,
                    PageSize: 100,
                }),
                { status: 200 },
            ),
        );
        const r = (await handleKuaiziAssetAction('ListAssetGroups', {
            PageNumber: 1,
            PageSize: 20,
            Filter: { Name: '产品' },
        })) as { Items: Array<{ Name: string }>; TotalCount: number };
        expect(r.TotalCount).toBe(1);
        expect(r.Items[0].Name).toBe('产品图');
        const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(JSON.stringify(sent.Filter ?? {})).not.toContain('产品');
    });

    it('同名 1062 类 SQL 报错绝不对客裸奔', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    ResponseMetadata: {
                        RequestId: 'r1',
                        Error: {
                            Code: 'InternalError',
                            Message:
                                "create asset failed: rpc error: code = Internal desc = save asset record failed: Error 1062 (23000): Duplicate entry '1-open_platform_api-x-0' for key 'asset.uk_biz_ns_name'",
                        },
                    },
                }),
                { status: 500 },
            ),
        );
        let caught: RealPersonError | undefined;
        try {
            await handleKuaiziAssetAction('GetAsset', { Id: 'asset-x' });
        } catch (x) {
            caught = x as RealPersonError;
        }
        expect(caught?.message).toBe('名称已存在,请更换名称');
        for (const leak of ['1062', 'uk_biz_ns_name', 'open_platform_api', 'Duplicate entry']) {
            expect(caught?.message).not.toContain(leak);
        }
    });

    it('上游没给 VendorGroupId → 报错,不吐一个非火山的号', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(envelope({ Id: '1' }), { status: 200 }));
        await expect(handleKuaiziAssetAction('CreateAssetGroup', { Name: 'g' })).rejects.toMatchObject({
            status: 502,
        });
    });

    it('GetAsset:Id ← VendorAssetId、URL ← VendorAssetUrl,Vendor* 键全撤掉', async () => {
        // ⚠️ 上游的 URL 是【客户创建时传入链接的原样回显】,不指向素材本体 ——
        //    真正能取到素材的只有 VendorAssetUrl。所以换掉它不只是更原生,是修个残废字段。
        const upstream = {
            Id: '1800657071180349888',
            Status: 'Active',
            URL: 'https://picsum.photos/512/512.jpg',
            VendorAssetId: 'asset-20260819085202-247l9',
            VendorAssetUrl: 'https://ark-media-asset.tos-cn-beijing.volces.com/x?X-Tos-Signature=y',
        };
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(envelope(upstream), { status: 200 }));
        expect(await handleKuaiziAssetAction('GetAsset', { Id: 'asset-20260819085202-247l9' })).toEqual({
            Id: 'asset-20260819085202-247l9',
            Status: 'Active',
            URL: 'https://ark-media-asset.tos-cn-beijing.volces.com/x?X-Tos-Signature=y',
        });
    });

    it('打上游前把火山号换回上游号(上游不认火山号,实测 invalid Id)', async () => {
        vi.mocked(toUpstreamId).mockResolvedValueOnce('1800657071180349888');
        const fetchMock = vi
            .spyOn(global, 'fetch')
            .mockResolvedValue(new Response(envelope({ Id: '1800657071180349888' }), { status: 200 }));
        await handleKuaiziAssetAction('GetAsset', { Id: 'asset-20260819085202-247l9' });
        const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(sent.Id).toBe('1800657071180349888');
    });

    it('平台库 id 判据:只有【6 位十六进制】后缀算我们的,筷子 vendor id 不算', () => {
        // 我们平台库(newAssetId: randomBytes(3) → 6 hex)
        expect(shouldUseKuaiziAssets('GetAsset', { Id: 'asset-20260819085202-a1b2c3' })).toBe(false);
        expect(shouldUseKuaiziAssets('GetAssetGroup', { Id: 'group-20260819085158-0f9e8d' })).toBe(false);
        // 筷子 vendor id:同前缀但 5 位且含非 hex 字符 → 必须仍走筷子,不能误路由到平台库
        expect(shouldUseKuaiziAssets('GetAsset', { Id: 'asset-20260819085202-247l9' })).toBe(true);
        expect(shouldUseKuaiziAssets('GetAssetGroup', { Id: 'group-20260819085158-kkp5p' })).toBe(true);
        // 筷子平台 Id(纯十进制)照旧走筷子
        expect(shouldUseKuaiziAssets('GetAsset', { Id: '1800657071180349888' })).toBe(true);
    });
});
