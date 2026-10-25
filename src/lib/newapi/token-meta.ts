import 'server-only';
import { listTokensForCustomer } from './client';

/**
 * 读客户全部 token 的额度 / 到期元数据(2026-10-22,/keys 额度与到期功能)。
 *
 * 数据源只有 new-api(单一事实源,portal 不落库):一次 act-as 列表调用拿回
 * `remain_quota / unlimited_quota / expired_time`。失败返回 null,页面降级显示
 * "暂不可用",不影响 key 列表本身。客户 Key 无固定数量上限，完整分页后才展示元数据。
 */
export interface TokenMeta {
    /** Current new-api status: 1 active, 2 disabled, 3 expired, 4 exhausted. */
    status: 1 | 2 | 3 | 4;
    unlimited_quota: boolean;
    remain_quota: number;
    /** unix 秒,-1 = 永不过期。 */
    expired_time: number;
    used_quota: number;
}

export async function getTokenMetaForCustomer(customerAuth: {
    accessToken: string;
    userId: number;
}): Promise<Map<number, TokenMeta> | null> {
    try {
        const result = new Map<number, TokenMeta>();
        let expectedTotal: number | undefined;
        for (let page = 1; page <= 100; page++) {
            const { items, total } = await listTokensForCustomer(customerAuth, page, 100);
            if (
                !Array.isArray(items) ||
                !Number.isSafeInteger(total) ||
                total < 0 ||
                (expectedTotal !== undefined && total !== expectedTotal)
            )
                throw new Error('Token metadata pagination changed');
            expectedTotal = total;
            for (const token of items) {
                if (
                    !Number.isSafeInteger(token.id) ||
                    token.id <= 0 ||
                    token.user_id !== customerAuth.userId ||
                    result.has(token.id) ||
                    ![1, 2, 3, 4].includes(token.status) ||
                    typeof token.unlimited_quota !== 'boolean' ||
                    !Number.isSafeInteger(token.remain_quota) ||
                    !Number.isSafeInteger(token.used_quota) ||
                    token.used_quota < 0 ||
                    !Number.isSafeInteger(token.expired_time) ||
                    token.expired_time < -1
                )
                    throw new Error('Invalid customer token metadata');
                result.set(token.id, {
                    status: token.status,
                    unlimited_quota: token.unlimited_quota,
                    remain_quota: token.remain_quota,
                    expired_time: token.expired_time,
                    used_quota: token.used_quota,
                });
            }
            if (result.size === total) return result;
            if (result.size > total || items.length < 100) throw new Error('Incomplete token metadata');
        }
        throw new Error('Token metadata exceeds pagination limit');
    } catch (err) {
        console.warn(
            `[token-meta] metadata unavailable for newapi user ${customerAuth.userId}:`,
            err instanceof Error ? err.name : 'unknown error',
        );
        return null;
    }
}

export function expiredTimeToIso(expiredTime: number): string | null {
    return expiredTime > 0 ? new Date(expiredTime * 1000).toISOString() : null;
}

export function isoToExpiredTime(iso: string | null): number {
    return iso ? Math.floor(Date.parse(iso) / 1000) : -1;
}
