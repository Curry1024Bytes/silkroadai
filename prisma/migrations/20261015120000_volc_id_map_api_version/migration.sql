-- service-inference.ai 任务按 API 版本隔离(/v1 建的任务 /v2 查 404,反之亦然):
-- 映射行记下创建时用的版本,轮询按版本打。可空,非破坏;存量行 NULL = 按配置版 + 404 回退另一版。
ALTER TABLE "volc_id_map" ADD COLUMN "api_version" TEXT;
