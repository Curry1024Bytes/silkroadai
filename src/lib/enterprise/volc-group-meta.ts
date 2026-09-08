/**
 * volc 素材组「名字所有权」(2026-08-31)。
 *
 * 上游对组名建了唯一索引(`uk_biz_ns_name`),同名建组直接 MySQL 1062;火山官方却允许
 * 重名(客户拿官方契约测试暴露)。与其求上游改表,不如把「名字」这个属性收归我们:
 *
 *   建组发给上游的 Name = 机器名(g-{随机},永不重复)
 *   客户设的名字 / 描述  = 存本表(vendor_id = 对客组号,火山形)
 *   读回来时             = 用本表覆盖上游的机器名
 *
 * 重名问题在结构上消失(不是被绕过);顺带上游侧不再看到客户的业务命名。
 * 老组(本表无行)读取时回落上游名字 —— 它们本就不重名,零迁移。
 *
 * 读路径 fail-open(查不到/查失败 → 回落上游名),写路径 fail-closed(名字现在是
 * 我们的权威数据,写失败必须让客户知道,不能静默变成机器名)。
 */
import { prisma } from '@/lib/db';
import { RealPersonError } from './real-person';

export interface GroupMeta {
    name: string;
    description: string | null;
}

/** 建组时落名字。写失败抛 503 —— 上游那条组已建好(机器名孤儿),客户重试会再建一条,
 *  但这比「组建成功却叫 g-a1b2c3」诚实。 */
export async function saveGroupMeta(
    vendorId: string,
    userId: string | undefined,
    name: string,
    description?: string,
): Promise<void> {
    try {
        await prisma.volcGroupMeta.upsert({
            where: { vendor_id: vendorId },
            create: { vendor_id: vendorId, user_id: userId ?? null, name, description: description ?? null },
            update: { name, description: description ?? null },
        });
    } catch (e) {
        console.error('[volc-group-meta] save failed', { vendorId, err: String(e) });
        throw new RealPersonError(503, 'ServiceUnavailable', '素材组名称保存失败,请重试');
    }
}

/** 改名 / 改描述。只更新显式传入的字段;行不存在时用 fallbackName 建行(老组首次改名)。 */
export async function updateGroupMeta(
    vendorId: string,
    userId: string | undefined,
    patch: { name?: string; description?: string },
    fallbackName: string,
): Promise<void> {
    try {
        await prisma.volcGroupMeta.upsert({
            where: { vendor_id: vendorId },
            create: {
                vendor_id: vendorId,
                user_id: userId ?? null,
                name: patch.name ?? fallbackName,
                description: patch.description ?? null,
            },
            update: {
                ...(patch.name !== undefined ? { name: patch.name } : {}),
                ...(patch.description !== undefined ? { description: patch.description } : {}),
            },
        });
    } catch (e) {
        console.error('[volc-group-meta] update failed', { vendorId, err: String(e) });
        throw new RealPersonError(503, 'ServiceUnavailable', '素材组信息保存失败,请重试');
    }
}

/** 读一条(fail-open:查失败当没有,回落上游名)。 */
export async function getGroupMeta(vendorId: string): Promise<GroupMeta | null> {
    try {
        const row = await prisma.volcGroupMeta.findUnique({ where: { vendor_id: vendorId } });
        return row ? { name: row.name, description: row.description } : null;
    } catch (e) {
        console.warn('[volc-group-meta] lookup failed', { vendorId, err: String(e) });
        return null;
    }
}

/** 删组时清行(best-effort:组在上游已删,行残留无害)。 */
export async function deleteGroupMeta(vendorId: string): Promise<void> {
    try {
        await prisma.volcGroupMeta.deleteMany({ where: { vendor_id: vendorId } });
    } catch (e) {
        console.warn('[volc-group-meta] delete failed', { vendorId, err: String(e) });
    }
}
