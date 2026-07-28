-- 客户 AK/SK 凭据(2026-07-28,火山 SignerV4 签名鉴权)。SK AES-256-GCM 加密存。additive,零客户影响。
CREATE TABLE "enterprise_ak_sk" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "user_id" UUID NOT NULL,
    "access_key" TEXT NOT NULL,
    "secret_key_enc" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    CONSTRAINT "enterprise_ak_sk_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "enterprise_ak_sk_access_key_key" ON "enterprise_ak_sk"("access_key");
CREATE INDEX "enterprise_ak_sk_user_id_idx" ON "enterprise_ak_sk"("user_id");
