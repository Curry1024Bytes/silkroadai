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
 * ## 素材映射可重建，平台任务号必须持久保存
 *
 * 上游 `ListAssets` / `ListAssetGroups` 的每一行都同时带 `Id` 与 `VendorAssetId`
 * /`VendorGroupId`,所以查询类响应流过时顺手 `remember()` 就能把表回填回来(自愈)。
 * 素材映射可通过翻页重建。平台自己生成的任务号没有这种恢复来源：写入失败必须交给
 * 提交方使用可还原的任务号回退；碰撞不能覆盖旧任务。查询临时失败也不能冒充“没有映射”。
 *
 * ## 宽进
 *
 * 存量客户(liyan / xzp)手里握的是**上游号**。`toUpstreamId()` 查不到映射时
 * **原样返回**,所以老号继续能用 —— 换 id 形态不是破坏性变更。
 */
import { prisma } from '@/lib/db';

export type VolcIdKind = 'asset' | 'group' | 'task';

export class VolcIdMappingError extends Error {
    readonly status = 503;

    constructor(message: string, cause?: unknown) {
        super(message, { cause });
        this.name = 'VolcIdMappingError';
    }
}

/** svcinf 的 v1/v2 任务互不可见；创建版本随任务映射保存，NULL 老行只做 GET 回退。 */
export type SvcinfTaskApiVersion = 'v1' | 'v2';

/** 素材映射 best-effort；任务映射事务写入、防碰撞，失败抛出，创建版本不能被后续配置覆盖。 */
export async function rememberVolcId(
    vendorId: string,
    upstreamId: string,
    kind: VolcIdKind,
    userId?: string,
    apiVersion?: SvcinfTaskApiVersion,
): Promise<void> {
    if (!vendorId || !upstreamId || vendorId === upstreamId) return;
    if (kind === 'task') {
        try {
            await prisma.$transaction(async (tx) => {
                const existing = await tx.volcIdMap.findUnique({ where: { vendor_id: vendorId } });
                if (existing) {
                    if (existing.kind === kind && existing.upstream_id === upstreamId) {
                        if (apiVersion && existing.api_version && existing.api_version !== apiVersion)
                            throw new VolcIdMappingError('task API version does not match its creation version');
                        if (apiVersion && !existing.api_version)
                            await tx.volcIdMap.update({
                                where: { vendor_id: vendorId },
                                data: { api_version: apiVersion },
                            });
                        return;
                    }
                    throw new VolcIdMappingError('task id already belongs to another mapping');
                }
                // 数据库主键兜住并发碰撞。失败交回调用方，不能 upsert 覆盖旧映射。
                await tx.volcIdMap.create({
                    data: {
                        vendor_id: vendorId,
                        upstream_id: upstreamId,
                        kind,
                        user_id: userId ?? null,
                        ...(apiVersion ? { api_version: apiVersion } : {}),
                    },
                });
            });
        } catch (cause) {
            throw new VolcIdMappingError('task mapping could not be saved', cause);
        }
        return;
    }
    try {
        await prisma.volcIdMap.upsert({
            where: { vendor_id: vendorId },
            create: {
                vendor_id: vendorId,
                upstream_id: upstreamId,
                kind,
                user_id: userId ?? null,
                api_version: apiVersion ?? null,
            },
            update: { upstream_id: upstreamId, ...(apiVersion ? { api_version: apiVersion } : {}) },
        });
    } catch (e) {
        console.warn('[volc-id-map] remember failed', { vendorId, kind, err: String(e) });
    }
}

/** Mapping persistence can fail after a paid submission was accepted. This recovery handle
 * retains the upstream identifier and API version without sending the generation a second time.
 * Portal ownership checks still apply to the complete client ID before polling. */
function decodeSvcinfRecoveryId(id: string): { upstreamId: string; apiVersion: SvcinfTaskApiVersion } | null {
    const match = /^cgt-svc-recovery-(v1|v2)-([A-Za-z0-9_-]+)$/.exec(id);
    if (!match) return null;
    const upstreamId = Buffer.from(match[2], 'base64url').toString('utf8');
    if (!/^mvt-[A-Za-z0-9_-]+$/.test(upstreamId) || Buffer.from(upstreamId).toString('base64url') !== match[2])
        return null;
    return { upstreamId, apiVersion: match[1] as SvcinfTaskApiVersion };
}

export interface UpstreamTaskRef {
    /** 上游号;查不到映射时 = 入参(宽进,同 toUpstreamId)。 */
    upstreamId: string;
    /** 创建该任务用的 API 版本;存量行 / 查不到映射 → null。 */
    apiVersion: SvcinfTaskApiVersion | null;
}

/**
 * 对客任务号 → 上游号 + 创建时的 API 版本(轮询 / 出正片前调)。
 * 查不到就**原样返回**(宽进),版本 null 由调用方按配置版打并在 404 时回退另一版。
 */
export async function toUpstreamTask(clientId: string): Promise<UpstreamTaskRef> {
    if (!clientId) return { upstreamId: clientId, apiVersion: null };
    const recovered = decodeSvcinfRecoveryId(clientId);
    if (recovered) return recovered;
    try {
        const row = await prisma.volcIdMap.findUnique({ where: { vendor_id: clientId } });
        const v = row?.api_version;
        return {
            upstreamId: row?.upstream_id || clientId,
            apiVersion: v === 'v1' || v === 'v2' ? v : null,
        };
    } catch (e) {
        console.warn('[volc-id-map] lookup failed', { clientId, err: String(e) });
        throw new VolcIdMappingError('task mapping could not be read', e);
    }
}

/**
 * 对客 id → 上游 id(打上游前调)。
 *
 * 查不到就**原样返回** —— 这就是「宽进」:存量客户手里的上游号照常可用,
 * 客户混着用两种号也不会炸。
 */
export async function toUpstreamId(clientId: string, opts?: { failOnError?: boolean }): Promise<string> {
    if (!clientId) return clientId;
    const recovered = decodeSvcinfRecoveryId(clientId);
    if (recovered) return recovered.upstreamId;
    try {
        const row = await prisma.volcIdMap.findUnique({ where: { vendor_id: clientId } });
        return row?.upstream_id || clientId;
    } catch (e) {
        console.warn('[volc-id-map] lookup failed', { clientId, err: String(e) });
        if (opts?.failOnError) throw new VolcIdMappingError('task mapping could not be read', e);
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
