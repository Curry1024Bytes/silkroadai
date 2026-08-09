-- 企业门户后台:全局折扣(按渠道×模型)+ 账号软删除(2026-08-08)

-- 1) 软删除标记:删账号时该客户全部 upstream_key 行置 deleted_at(保留历史,客户列表过滤)
ALTER TABLE "enterprise_upstream_keys" ADD COLUMN "deleted_at" TIMESTAMP(3);

-- 2) 全局折扣表:按 (region, variant) 的临时促销折扣,覆盖客户折扣率(不覆盖绝对议价),按模型隔离
CREATE TABLE "enterprise_global_discounts" (
    "id" UUID NOT NULL,
    "region" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "discount" DECIMAL(6,4) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    CONSTRAINT "enterprise_global_discounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "enterprise_global_discounts_region_variant_key" ON "enterprise_global_discounts"("region", "variant");
