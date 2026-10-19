-- 企业门户回调投递(2026-10-19):提交时记客户 callback_url(绝不转发上游,#271),任务终态由我们 POST 查询响应体。
-- 可空,非破坏;存量行 NULL = 没要回调。
ALTER TABLE "seedance_video_tasks" ADD COLUMN "callback_url" TEXT;
ALTER TABLE "seedance_video_tasks" ADD COLUMN "callback_format" TEXT;
ALTER TABLE "seedance_video_tasks" ADD COLUMN "callback_status" TEXT;
ALTER TABLE "seedance_video_tasks" ADD COLUMN "callback_sent_at" TIMESTAMP(3);
ALTER TABLE "seedance_video_tasks" ADD COLUMN "callback_error" TEXT;
