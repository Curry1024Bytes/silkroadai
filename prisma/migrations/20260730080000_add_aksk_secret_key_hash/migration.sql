-- SK 直接当 Bearer key 用的查找索引(2026-07-30)。additive:加 nullable 列 + unique 索引,
-- 存量行由 scripts/backfill-aksk-secret-hash.ts 解密补 hash。
ALTER TABLE "enterprise_ak_sk" ADD COLUMN "secret_key_hash" TEXT;

CREATE UNIQUE INDEX "enterprise_ak_sk_secret_key_hash_key" ON "enterprise_ak_sk"("secret_key_hash");
