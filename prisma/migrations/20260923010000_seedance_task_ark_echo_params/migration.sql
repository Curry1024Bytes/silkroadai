-- 火山官方查询响应新增回显字段(safety_identifier / output_format / tools),提交时落库。
-- 非破坏性:三列均可空,旧代码期间 apply 安全。
ALTER TABLE "seedance_video_tasks"
    ADD COLUMN "safety_identifier" TEXT,
    ADD COLUMN "output_format" TEXT,
    ADD COLUMN "tools" JSONB;
