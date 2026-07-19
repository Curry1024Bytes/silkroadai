/**
 * P3 素材库页:server 拉素材+素材组 → client island(上传/分组/改名/删除/复制 id)。
 * 素材存我们 R2;生成请求里直接写 asset-…/group-… id 即可引用(接入说明见页内)。
 */
import { prisma } from '@/lib/db';
import { getEnterpriseSessionUser } from '@/lib/enterprise/session';
import { AssetsManager } from './assets-manager';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Seedance 企业端口 · 素材库' };

export default async function EnterpriseAssetsPage() {
    const user = (await getEnterpriseSessionUser())!;
    const [assets, groups] = await Promise.all([
        prisma.enterpriseAsset.findMany({
            where: { user_id: user.id },
            orderBy: { created_at: 'desc' },
            take: 500,
        }),
        prisma.enterpriseAssetGroup.findMany({ where: { user_id: user.id }, orderBy: { created_at: 'asc' } }),
    ]);

    return (
        <AssetsManager
            initialAssets={assets.map((a) => ({
                id: a.id,
                name: a.name,
                asset_type: a.asset_type,
                group_id: a.group_id,
                url: a.public_url,
                bytes: a.bytes,
                created_at: a.created_at.toISOString(),
            }))}
            initialGroups={groups.map((g) => ({ id: g.id, name: g.name }))}
        />
    );
}
