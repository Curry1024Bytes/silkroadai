-- 企业权责透明(2026-07-24):任务失败原因落库(此前仅轮询实时透传,任务行无痕)。
ALTER TABLE "seedance_video_tasks" ADD COLUMN "fail_reason" TEXT;
