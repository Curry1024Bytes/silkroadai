/** volc 素材库翻译单测(2026-07-29):火山 Action → provider REST + 响应映射 + 火山直链透传 + 错误。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleVolcAssetAction } from '../volc-assets';
import { RealPersonError } from '../real-person';

const BASE = 'http://provider.test';

beforeEach(() => {
    process.env.ENTERPRISE_REALPERSON_BASE_URL = BASE;
    process.env.ENTERPRISE_REALPERSON_KEY = 'ak-test';
    vi.restoreAllMocks();
});
afterEach(() => {
    delete process.env.ENTERPRISE_REALPERSON_BASE_URL;
    delete process.env.ENTERPRISE_REALPERSON_KEY;
});

const okResp = (data: unknown) => new Response(JSON.stringify({ code: 0, message: 'success', data }), { status: 200 });

describe('CreateAsset', () => {
    it('翻译到 POST /api/v1/asset + Result 仅含 Id(对齐火山官方,不带 Status)', async () => {
        const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(okResp('asset-20260729-xyz'));
        const r = (await handleVolcAssetAction('CreateAsset', {
            GroupId: 'group-1',
            URL: 'https://x/a.png',
            AssetType: 'Image',
            Name: 'face.png',
        })) as { Id: string };
        expect(r).toEqual({ Id: 'asset-20260729-xyz' }); // 仅 Id,无 Status/URL 等额外字段
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(`${BASE}/api/v1/asset`);
        const sent = JSON.parse((init as RequestInit).body as string);
        expect(sent).toEqual({
            groupId: 'group-1',
            assetUrl: 'https://x/a.png',
            assetType: 'Image',
            assetName: 'face.png',
        });
        expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer ak-test' });
    });

    it('不传 Name → 从 URL 文件名派生 assetName(火山官方 Name 可选)', async () => {
        const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(okResp('asset-1'));
        const r = (await handleVolcAssetAction('CreateAsset', {
            GroupId: 'group-1',
            URL: 'https://bk.tos-cn-beijing.volces.com/ai/111/5197975902814d19b23d9449483b1fac.jpg',
            AssetType: 'Image',
        })) as { Id: string };
        expect(r).toEqual({ Id: 'asset-1' });
        const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(sent.assetName).toBe('5197975902814d19b23d9449483b1fac.jpg');
    });

    it('缺 GroupId → 400 InvalidParameter,不打上游', async () => {
        const fetchMock = vi.spyOn(global, 'fetch');
        await expect(
            handleVolcAssetAction('CreateAsset', { URL: 'https://x/a.png', AssetType: 'Image', Name: 'x' }),
        ).rejects.toMatchObject({ status: 400, code: 'InvalidParameter' });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('GetAsset', () => {
    it('映射 provider 字段 → 火山 Result,assetUrl(火山直链)原样透传', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            okResp({
                assetId: 'asset-1',
                groupId: 'group-1',
                assetName: 'face.png',
                assetType: 'Image',
                assetUrl: 'https://eos-wuxi/real-volc-signed-url.png?sig=x',
                status: 'ACTIVE',
                createdTime: '2026-07-29 10:00:00',
            }),
        );
        const r = (await handleVolcAssetAction('GetAsset', { Id: 'asset-1' })) as Record<string, string>;
        expect(r).toEqual({
            Id: 'asset-1',
            GroupId: 'group-1',
            Name: 'face.png',
            AssetType: 'Image',
            URL: 'https://eos-wuxi/real-volc-signed-url.png?sig=x',
            Status: 'ACTIVE',
            CreatedAt: '2026-07-29 10:00:00',
        });
    });
});

describe('ListAssets', () => {
    it('火山 Filter{GroupIds,GroupType,Statuses} → provider 平铺,Items 映射', async () => {
        const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
            okResp({
                result: [
                    {
                        assetId: 'asset-1',
                        groupId: 'g1',
                        assetName: 'a',
                        assetType: 'Image',
                        assetUrl: 'https://volc/a.png',
                        status: 'ACTIVE',
                    },
                ],
                total: 1,
                pageNo: 1,
                pageSize: 20,
            }),
        );
        const r = (await handleVolcAssetAction('ListAssets', {
            Filter: { GroupIds: ['g1'], GroupType: 'LivenessFace', Statuses: ['ACTIVE'] },
            PageNumber: 1,
            PageSize: 20,
        })) as { Items: unknown[]; Total: number };
        expect(r.Total).toBe(1);
        expect(r.Items).toHaveLength(1);
        const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(sent).toEqual({
            pageNo: 1,
            pageSize: 20,
            groupIds: ['g1'],
            groupType: 'LivenessFace',
            statuses: ['ACTIVE'],
        });
    });

    it('Statuses Title-case(Active)→ 归一大写转发 provider(免 400)', async () => {
        const fetchMock = vi
            .spyOn(global, 'fetch')
            .mockResolvedValue(okResp({ result: [], total: 0, pageNo: 1, pageSize: 5 }));
        await handleVolcAssetAction('ListAssets', {
            Filter: { GroupIds: ['g1'], GroupType: 'AIGC', Statuses: ['Active'] },
            PageNumber: 1,
            PageSize: 5,
        });
        const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(sent.statuses).toEqual(['ACTIVE']);
    });

    it('Filter.Name → provider assetName(模糊搜索过滤)', async () => {
        const fetchMock = vi
            .spyOn(global, 'fetch')
            .mockResolvedValue(okResp({ result: [], total: 0, pageNo: 1, pageSize: 5 }));
        await handleVolcAssetAction('ListAssets', {
            Filter: { GroupIds: ['g1'], GroupType: 'AIGC', Name: 'flow-asset-updated-x' },
            PageNumber: 1,
            PageSize: 5,
        });
        const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(sent.assetName).toBe('flow-asset-updated-x');
        expect(sent.groupName).toBeUndefined();
    });

    it('ListAssetGroups Filter.Name → provider groupName(模糊搜索过滤)', async () => {
        const fetchMock = vi
            .spyOn(global, 'fetch')
            .mockResolvedValue(okResp({ result: [], total: 0, pageNo: 1, pageSize: 5 }));
        await handleVolcAssetAction('ListAssetGroups', {
            Filter: { GroupIds: ['g1'], GroupType: 'AIGC', Name: 'flow-group-updated-x' },
            PageNumber: 1,
            PageSize: 5,
        });
        const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(sent.groupName).toBe('flow-group-updated-x');
        expect(sent.assetName).toBeUndefined();
    });
});

describe('Update 响应回 Id(对齐火山官方,客户脚本据此确认更新对象)', () => {
    it('UpdateAsset → Result.Id == 被更新素材 Id', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(okResp(true));
        const r = await handleVolcAssetAction('UpdateAsset', { Id: 'asset-9', Name: '新名' });
        expect(r).toEqual({ Id: 'asset-9' });
    });

    it('UpdateAssetGroup → Result.Id == 被更新组 Id', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(okResp(true));
        const r = await handleVolcAssetAction('UpdateAssetGroup', { Id: 'group-9', Name: '新组名' });
        expect(r).toEqual({ Id: 'group-9' });
    });
});

describe('CreateAssetGroup + 错误', () => {
    it('CreateAssetGroup → POST /api/v1/asset-group,返 {Id: groupId}', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(okResp({ groupId: 'group-new', groupName: 'demo' }));
        const r = (await handleVolcAssetAction('CreateAssetGroup', { Name: 'demo' })) as { Id: string };
        expect(r.Id).toBe('group-new');
    });

    it('provider code=1 业务错误 → RealPersonError 透传 message', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ code: 1, message: '资产组不存在' }), { status: 200 }),
        );
        await expect(handleVolcAssetAction('GetAsset', { Id: 'asset-x' })).rejects.toMatchObject({
            code: 'AssetOperationFailed',
            message: '资产组不存在',
        });
    });

    it('未配置 env → 503', async () => {
        delete process.env.ENTERPRISE_REALPERSON_KEY;
        await expect(handleVolcAssetAction('ListAssets', {})).rejects.toBeInstanceOf(RealPersonError);
    });

    it('DeleteAsset → DELETE /api/v1/asset/{id},返 {}', async () => {
        const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(okResp(true));
        const r = await handleVolcAssetAction('DeleteAsset', { Id: 'asset-1' });
        expect(r).toEqual({});
        expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/v1/asset/asset-1`);
        expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
    });
});
