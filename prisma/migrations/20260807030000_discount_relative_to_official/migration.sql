-- 折扣口径重锚(2026-08-07,operator 方案 B):discount 从「零售价(挂牌×0.85)再乘」
-- 改为「相对官方挂牌价」。原 discount=1(即标准零售)的行改写为 0.85 → 实付分毫不变;
-- 已设 <1 折扣的行【保持原值】(operator 拍板按字面生效,实付相应上调 ~17.6%)。
ALTER TABLE "enterprise_upstream_keys" ALTER COLUMN "discount" SET DEFAULT 0.85;
UPDATE "enterprise_upstream_keys" SET "discount" = 0.85 WHERE "discount" = 1;
