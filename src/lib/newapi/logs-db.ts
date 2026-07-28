/**
 * new-api 日志库只读直连(admin 日志导出专用)。
 *
 * 为什么绕过 Admin API:`/api/log/` 的 page_size 被服务端钳在 100,重度客户
 * 单月几十万行日志走分页 API 会撞 GLOBAL_API_RATE_LIMIT 且慢到不可用;
 * `/api/data/` 只有按天×模型的预聚合,出不了逐条明细。只读 SELECT 不碰
 * new-api 源码(AGPL 边界不变),也不写它的库。
 *
 * 连接串来自 `NEWAPI_LOGS_DATABASE_URL`(建议用只读 role,见 .env.example)。
 * 未配置时返回 null,上层端点降级为 503 —— 功能对未配置环境(本地 dev)静默关闭。
 */
import 'server-only';
import { Pool } from 'pg';

let pool: Pool | null = null;

export function getNewapiLogsPool(): Pool | null {
    const url = process.env.NEWAPI_LOGS_DATABASE_URL;
    if (!url) return null;
    if (!pool) {
        pool = new Pool({
            connectionString: url,
            max: 3,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 10_000,
        });
    }
    return pool;
}

/** 仅测试用:重置 singleton,让不同 env 组合可独立验证。 */
export function __resetNewapiLogsPoolForTest(): void {
    pool = null;
}
