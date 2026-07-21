-- 客户级整体折扣率(2026-07-20):挂牌价 × discount;1 = 无折扣。
-- 单档 enterprise_rate_overrides 仍是绝对单价,优先且不再乘折扣。
ALTER TABLE "enterprise_upstream_keys" ADD COLUMN "discount" DECIMAL(6,4) NOT NULL DEFAULT 1;
