-- fast/mini 新变体(2026-07-19):议价覆盖表加 variant 维度(默认 pro,存量行语义不变——
-- 现网无覆盖行,ALTER 零风险)。unique 从 (user,resolution,has_video) 扩为 (user,variant,resolution,has_video)。

-- AlterTable
ALTER TABLE "enterprise_rate_overrides" ADD COLUMN "variant" TEXT NOT NULL DEFAULT 'pro';

-- DropIndex
DROP INDEX "enterprise_rate_overrides_user_id_resolution_has_video_key";

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_rate_overrides_user_id_variant_resolution_has_v_key" ON "enterprise_rate_overrides"("user_id", "variant", "resolution", "has_video");
