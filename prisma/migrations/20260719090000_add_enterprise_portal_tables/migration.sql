-- seedance 大客户独立门户 P1(纯 CREATE,无 backfill,零现有路径影响)。
-- enterprise_keys:门户自发 sk-ent- key(只存 sha256);enterprise_upstream_keys:每客户
-- 一把独立上游 key(AES-256-GCM 加密存);enterprise_rate_overrides:大客户议价费率覆盖。

-- CreateTable
CREATE TABLE "enterprise_keys" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "user_id" UUID NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "enterprise_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enterprise_upstream_keys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "upstream_key_enc" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enterprise_upstream_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enterprise_rate_overrides" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "resolution" TEXT NOT NULL,
    "has_video" BOOLEAN NOT NULL,
    "cny_per_m" DECIMAL(12,4) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enterprise_rate_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_keys_key_hash_key" ON "enterprise_keys"("key_hash");

-- CreateIndex
CREATE INDEX "enterprise_keys_user_id_idx" ON "enterprise_keys"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_upstream_keys_user_id_key" ON "enterprise_upstream_keys"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_rate_overrides_user_id_resolution_has_video_key" ON "enterprise_rate_overrides"("user_id", "resolution", "has_video");
