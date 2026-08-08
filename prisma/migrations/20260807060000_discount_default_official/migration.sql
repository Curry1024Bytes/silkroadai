-- 新开户默认改回官方原价(2026-08-07,operator:折扣必须显式设置才生效)。
-- 只改 DEFAULT,【不动任何存量行】—— 上一步迁移写成 0.85 的客户保持现价不变。
ALTER TABLE "enterprise_upstream_keys" ALTER COLUMN "discount" SET DEFAULT 1;
