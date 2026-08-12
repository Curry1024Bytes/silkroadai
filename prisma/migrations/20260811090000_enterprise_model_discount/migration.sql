-- 议价重构(2026-08-11):绝对单价 → per-模型折扣率,优先级最高。
-- 旧表 enterprise_rate_overrides 生产 0 行(未启用),直接 drop 换新表;无数据迁移。

-- 幂等写法:支持「先手工建新表 → 切新代码 → 再由 migrate deploy 删旧表」的零破坏部署顺序
-- (DROP TABLE 不能在旧代码运行时先跑 —— 旧代码仍引用 enterprise_rate_overrides)。

CREATE TABLE IF NOT EXISTS "enterprise_model_discounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "region" TEXT NOT NULL DEFAULT 'cn',
    "variant" TEXT NOT NULL DEFAULT 'pro',
    "discount" DECIMAL(6,4) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "enterprise_model_discounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "enterprise_model_discounts_user_id_region_variant_key" ON "enterprise_model_discounts"("user_id", "region", "variant");

DROP TABLE IF EXISTS "enterprise_rate_overrides";
