-- 海外版(global)接入(2026-07-23):三表加 region 维度,存量全部默认 'cn' 零影响。
-- enterprise_upstream_keys 每客户每版本一把上游 key(discount 挂行 = 分版本折扣);
-- enterprise_keys(sk-ent)绑版本;enterprise_rate_overrides unique 扩五元组。

-- AlterTable
ALTER TABLE "enterprise_keys" ADD COLUMN "region" TEXT NOT NULL DEFAULT 'cn';

-- AlterTable
ALTER TABLE "enterprise_upstream_keys" ADD COLUMN "region" TEXT NOT NULL DEFAULT 'cn';

-- DropIndex
DROP INDEX "enterprise_upstream_keys_user_id_key";

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_upstream_keys_user_id_region_key" ON "enterprise_upstream_keys"("user_id", "region");

-- AlterTable
ALTER TABLE "enterprise_rate_overrides" ADD COLUMN "region" TEXT NOT NULL DEFAULT 'cn';

-- DropIndex
DROP INDEX "enterprise_rate_overrides_user_id_variant_resolution_has_v_key";

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_rate_overrides_user_id_region_variant_resolutio_key" ON "enterprise_rate_overrides"("user_id", "region", "variant", "resolution", "has_video");
