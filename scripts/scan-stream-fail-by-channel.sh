#!/usr/bin/env bash
# 渠道 mid-stream 失败率统计(2026-07-29 根治件③ — 渠道治理用)。
#
# 在【生产 VPS】上跑(直读 new-api Postgres 容器 new-api-db):
#   ./scripts/scan-stream-fail-by-channel.sh [天数,默认 7]
#
# 输出每渠道:
#   - consume_total:   type=2 消费行总数
#   - input_only:      消费行里 completion=0 且 prompt>0(≈ 流中途失败被计输入费 +
#                      少量客户主动断流,是【代理指标】,精确判定看 portal request_logs)
#   - err_rows:        type=5 错误行数
#   - input_only_rate: input_only / consume_total
# 按 input_only_rate 降序 —— 排最前的池子成员优先踢/降权。
set -euo pipefail

DAYS="${1:-7}"

docker exec new-api-db psql -U newapi -d newapi -c "
WITH win AS (SELECT extract(epoch from now())::bigint - ${DAYS}*86400 AS since),
consume AS (
  SELECT channel_id,
         COUNT(*) AS consume_total,
         SUM(CASE WHEN completion_tokens = 0 AND prompt_tokens > 0 THEN 1 ELSE 0 END) AS input_only,
         SUM(CASE WHEN completion_tokens = 0 AND prompt_tokens > 0 THEN quota ELSE 0 END) AS input_only_quota
  FROM logs, win WHERE type = 2 AND created_at > win.since GROUP BY channel_id
),
errs AS (
  SELECT channel_id, COUNT(*) AS err_rows
  FROM logs, win WHERE type = 5 AND created_at > win.since GROUP BY channel_id
)
SELECT c.channel_id,
       ch.name,
       c.consume_total,
       c.input_only,
       ROUND(100.0 * c.input_only / NULLIF(c.consume_total, 0), 2) AS input_only_pct,
       ROUND(c.input_only_quota / 500000.0, 2) AS input_only_cny,
       COALESCE(e.err_rows, 0) AS err_rows
FROM consume c
LEFT JOIN errs e USING (channel_id)
LEFT JOIN channels ch ON ch.id = c.channel_id
WHERE c.consume_total >= 20
ORDER BY input_only_pct DESC NULLS LAST
LIMIT 40;
"
