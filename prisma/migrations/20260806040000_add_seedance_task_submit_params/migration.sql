-- 火山方舟形查询响应逐字段对齐(2026-08-06):回显提交参数需落库
ALTER TABLE "seedance_video_tasks"
    ADD COLUMN "ratio" TEXT,
    ADD COLUMN "seed" BIGINT,
    ADD COLUMN "generate_audio" BOOLEAN;
