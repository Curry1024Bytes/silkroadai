/**
 * 按客户填的 request_id 定位那一次调用(best-effort)。
 *
 * 走 new-api `GET /api/log/`(queryLogs 支持精确 request_id 过滤),再按
 * `log.user_id === user.newapi_user_id` 二次校验 —— 防止客户拿别人的 request_id
 * 来套信息。任何失败(new-api 不可达 / 无命中)返回 null,不阻断提单。
 */
import { queryLogs, type NewApiUsageLog } from '@/lib/newapi/client';
import { quotaToCny } from '@/lib/newapi/quota-units';

export interface LocatedRequest {
    requestId: string;
    model: string;
    /** new-api token id(int);portal NewApiToken.newapi_token_id 可反查。 */
    newapiTokenId: number;
    quota: number;
    costCny: number;
    /** unix 秒 */
    createdAt: number;
    /** type=5 错误行(失败调用)。 */
    failed: boolean;
    content: string;
}

export function pickLogRow(items: NewApiUsageLog[], newapiUserId: number, requestId: string): NewApiUsageLog | null {
    const mine = items.filter((l) => l.user_id === newapiUserId && l.request_id === requestId);
    // 同一 request_id 可能有 failover 的失败行 + 最终成功行,优先成功(2)其次失败(5)
    return mine.find((l) => l.type === 2) ?? mine.find((l) => l.type === 5) ?? null;
}

export function toLocated(log: NewApiUsageLog): LocatedRequest {
    return {
        requestId: log.request_id,
        model: log.model_name,
        newapiTokenId: log.token_id,
        quota: log.quota,
        costCny: quotaToCny(log.quota),
        createdAt: log.created_at,
        failed: log.type === 5,
        content: log.content,
    };
}

export async function locateRequest(
    user: { newapi_user_id: number | null; newapi_username: string | null },
    requestId: string,
): Promise<LocatedRequest | null> {
    if (user.newapi_user_id == null || user.newapi_username == null) return null;
    try {
        const res = await queryLogs({
            username: user.newapi_username,
            user_id: user.newapi_user_id,
            request_id: requestId,
            type: 0,
            page: 1,
            page_size: 20,
        });
        const row = pickLogRow(res.items, user.newapi_user_id, requestId);
        return row ? toLocated(row) : null;
    } catch (e) {
        console.warn(`[tickets/lookup] queryLogs failed for request_id ${requestId}:`, e);
        return null;
    }
}
