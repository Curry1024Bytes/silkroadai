-- 客户专属倍率写路径(2026-10-25,PR-2):portal 留痕表 + users.newapi_user_group 镜像。非破坏;事实源仍是 new-api GroupGroupRatio 矩阵。
-- AlterTable
ALTER TABLE "users" ADD COLUMN     "newapi_user_group" TEXT;

-- CreateTable
CREATE TABLE "customer_ratio_overrides" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "newapi_group" TEXT NOT NULL,
    "ratio" DECIMAL(8,4) NOT NULL,
    "note" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_ratio_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_ratio_overrides_user_id_idx" ON "customer_ratio_overrides"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_ratio_overrides_user_id_newapi_group_key" ON "customer_ratio_overrides"("user_id", "newapi_group");

-- AddForeignKey
ALTER TABLE "customer_ratio_overrides" ADD CONSTRAINT "customer_ratio_overrides_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

