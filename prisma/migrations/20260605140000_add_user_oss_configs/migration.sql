-- W9 D3 PR-C: 客户自定义 OSS 配置表
-- CreateTable
CREATE TABLE "user_oss_configs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "endpoint" TEXT,
    "bucket" TEXT NOT NULL,
    "region" TEXT,
    "access_key_id" TEXT NOT NULL,
    "secret_access_key_encrypted" TEXT NOT NULL,
    "public_url_prefix" TEXT NOT NULL,
    "cdn_enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_test_at" TIMESTAMP(3),
    "last_test_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_oss_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_oss_configs_user_id_key" ON "user_oss_configs"("user_id");

-- AddForeignKey
ALTER TABLE "user_oss_configs" ADD CONSTRAINT "user_oss_configs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
