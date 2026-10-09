-- 样片模式(火山官方 draft / draft_task,2026-10-08):创建参数 draft 布尔 + 正片引用的客户样片任务号。
-- 两列可空,非破坏;存量行 NULL → 查询响应 draft=false、不出 draft_task_id。
ALTER TABLE "seedance_video_tasks" ADD COLUMN "draft" BOOLEAN;
ALTER TABLE "seedance_video_tasks" ADD COLUMN "draft_task_id" TEXT;
