/**
 * volc 渠道「火山原生 id」↔「上游 id」映射(2026-08-19)。
 *
 * ## 为什么需要这一层
 *
 * volc 渠道的产品定义是「客户拿火山官方 SDK 零改动接入、拿到完全原生的火山体验」,
 * 所以对客暴露的 id 必须是**火山自己的号**:
 *   素材/组  `asset-20260819215920-b5sjp` / `group-20260819215915-j5dxc`
 *   任务     `cgt-20260819224039-bfjdv`
 * 而不是中间上游发的号(素材是十进制串 `192295008202653711`,任务是 `kz-cgt-…`)。
 *
 * 但**上游不认火山的号** —— 2026-08-19 实测:
 *   GetAsset({Id: 'asset-20260819215920-b5sjp'})      → InvalidParameter: invalid Id
 *   GetAssetGroup({Id: 'group-20260819215915-j5dxc'}) → InvalidParameter: invalid Id
 *   GetAsset({Id: '192295008202653711'})              → 认 ✅
 * 所以打上游之前必须换回上游 id。这个模块就是那次换算。
 *
 * ## 不是单点故障
 *
 * 上游 `ListAssets` / `ListAssetGroups` 的每一行都同时带 `Id` 与 `VendorAssetId`
 * /`VendorGroupId`,所以查询类响应流过时顺手 `remember()` 就能把表回填回来(自愈)。
 * 表整个丢了也能靠翻页重建 —— 不像"我们自己发号"那样丢了就永久失联。
 *
 * ## 宽进
 *
 * 存量客户(liyan / xzp)手里握的是**上游号**。`toUpstreamId()` 查不到映射时
 * **原样返回**,所以老号继续能用 —— 换 id 形态不是破坏性变更。
 */
import { prisma } from '@/lib/db';

export type VolcIdKind = 'asset' | 'group' | 'task';

/**
 * 记一条映射(幂等)。写失败**不抛** —— 映射表是加速/翻译层,不是事实源:
 * 上游响应里本来就带着两个号,下次查询流过时会自愈。为它把客户请求打挂不划算。
 */
export async function rememberVolcId(
    vendorId: string,
    upstreamId: string,
    kind: VolcIdKind,
    userId?: string,
): Promise<void> {
    if (!vendorId || !upstreamId || vendorId === upstreamId) return;
    try {
        await prisma.volcIdMap.upsert({
            where: { vendor_id: vendorId },
            create: { vendor_id: vendorId, upstream_id: upstreamId, kind, user_id: userId ?? null },
            update: { upstream_id: upstreamId },
        });
    } catch (e) {
        console.warn('[volc-id-map] remember failed', { vendorId, kind, err: String(e) });
    }
}

/**
 * 对客 id → 上游 id(打上游前调)。
 *
 * 查不到就**原样返回** —— 这就是「宽进」:存量客户手里的上游号照常可用,
 * 客户混着用两种号也不会炸。
 */
export async function toUpstreamId(clientId: string): Promise<string> {
    if (!clientId) return clientId;
    try {
        const row = await prisma.volcIdMap.findUnique({ where: { vendor_id: clientId } });
        return row?.upstream_id || clientId;
    } catch (e) {
        console.warn('[volc-id-map] lookup failed', { clientId, err: String(e) });
        return clientId;
    }
}

/** 批量:对客 id → 上游 id(保持顺序)。 */
export async function toUpstreamIds(clientIds: ReadonlyArray<string>): Promise<string[]> {
    return Promise.all(clientIds.map((id) => toUpstreamId(id)));
}

/**
 * 上游 id → 对客 id(回显响应里的关联 id 用,例如素材行上的 GroupId)。
 *
 * 查不到同样原样返回 —— 本次改动之前建的组没有映射行,回显上游号是它本来就
 * 认识的那个,不算倒退。
 */
export async function toVendorId(upstreamId: string): Promise<string> {
    if (!upstreamId) return upstreamId;
    try {
        const row = await prisma.volcIdMap.findFirst({
            where: { upstream_id: upstreamId },
            orderBy: { created_at: 'desc' },
        });
        return row?.vendor_id || upstreamId;
    } catch (e) {
        console.warn('[volc-id-map] reverse lookup failed', { upstreamId, err: String(e) });
        return upstreamId;
    }
}
