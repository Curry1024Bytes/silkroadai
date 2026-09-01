/** 筷子开放平台素材库适配单测:Action 转发 + ApiKey 头 + 信封拆装 + 错误映射 + 开关。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    handleKuaiziAssetAction,
    kuaiziAssetsEnabled,
    shouldUseKuaiziAssets,
    KUAIZI_ASSET_ACTIONS,
} from '../kuaizi-assets';
import { RealPersonError } from '../real-person';

const BASE = 'http://kuaizi.test';
const KEY = 'kz-test-key';
const ENDPOINT = `${BASE}/ai-open-platform-api/api/support/v1/asset`;

const envelope = (result: unknown) => JSON.stringify({ ResponseMetadata: { RequestId: 'r1' }, Result: result });

beforeEach(() => {
    process.env.ENTERPRISE_KUAIZI_BASE_URL = BASE;
    process.env.ENTERPRISE_KUAIZI_KEY = KEY;
    vi.restoreAllMocks();
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
        expect(shouldUseKuaiziAssets('GetAsset', { Id: 'asset-20260803095838-5n989' })).toBe(false);
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
    it('CreateAsset:打 Action 单入口 + ApiKey 头(非 Bearer),AssetType 归一 Title-case,只返 Id', async () => {
        const fetchMock = vi
            .spyOn(global, 'fetch')
            .mockResolvedValue(new Response(envelope({ Id: '1800657071180349888' }), { status: 200 }));
        const r = await handleKuaiziAssetAction('CreateAsset', {
            GroupId: '1800657071180349525',
            URL: 'https://cdn.test/a.jpg',
            AssetType: 'image',
            Name: '封面图',
        });
        expect(r).toEqual({ Id: '1800657071180349888' });
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

    it('ListAssets:平铺 GroupId 归一成 Filter.GroupIds;TotalCount → Total', async () => {
        const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(envelope({ Items: [{ Id: '1' }], TotalCount: 1, PageNumber: 1, PageSize: 20 }), {
                status: 200,
            }),
        );
        const r = await handleKuaiziAssetAction('ListAssets', { GroupId: '1800657071180349525' });
        expect(r).toEqual({ Items: [{ Id: '1' }], Total: 1, PageNumber: 1, PageSize: 20 });
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

    it('上游 Error 信封 → RealPersonError(code/message 透传给客户)', async () => {
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
            code: 'ResourceNotFound',
            message: '素材不存在',
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
