-- 请求日志 P2(2026-09-04):素材库 Action API 落日志 —— 加 Action 名与素材/组 id 两列。
-- 纯 additive,旧代码运行期间 apply 安全。
ALTER TABLE "enterprise_request_logs" ADD COLUMN "action" TEXT;
ALTER TABLE "enterprise_request_logs" ADD COLUMN "resource_id" TEXT;
