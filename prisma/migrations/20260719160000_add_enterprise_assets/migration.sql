-- P3 素材库(纯 CREATE,零现有路径影响):门户自有素材存储(R2),API 对标火山方舟。
-- enterprise_assets:素材行(user_id 行级归属 = 隔离);enterprise_asset_groups:素材组。

-- CreateTable
CREATE TABLE "enterprise_asset_groups" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enterprise_asset_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enterprise_assets" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "group_id" TEXT,
    "asset_type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "r2_key" TEXT NOT NULL,
    "public_url" TEXT NOT NULL,
    "mime" TEXT,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "source_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enterprise_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "enterprise_asset_groups_user_id_idx" ON "enterprise_asset_groups"("user_id");

-- CreateIndex
CREATE INDEX "enterprise_assets_user_id_created_at_idx" ON "enterprise_assets"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "enterprise_assets_group_id_idx" ON "enterprise_assets"("group_id");
