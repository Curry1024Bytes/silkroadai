-- 企业门户全局折扣日历规则与任务提交时价格快照。
ALTER TABLE "enterprise_global_discounts"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "schedule_timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  ADD COLUMN "schedule_weekdays" JSONB,
  ADD COLUMN "schedule_windows" JSONB,
  ADD COLUMN "effective_from" TIMESTAMP(3);

ALTER TABLE "seedance_video_tasks"
  ADD COLUMN "pricing_discount" DECIMAL(8,6),
  ADD COLUMN "pricing_source" TEXT,
  ADD COLUMN "pricing_rule" JSONB,
  ADD COLUMN "pricing_timezone" TEXT;
