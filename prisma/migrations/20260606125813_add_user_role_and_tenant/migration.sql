-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('customer', 'staff', 'admin', 'superadmin');

-- AlterTable
ALTER TABLE "channels" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "payment_provider_instances" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "subscription_plans" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'customer',
ADD COLUMN     "tenant_id" UUID;

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "brand_name" TEXT NOT NULL,
    "primary_domain" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "prepaid_balance_cny" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "channels_tenant_id_idx" ON "channels"("tenant_id");

-- CreateIndex
CREATE INDEX "orders_tenant_id_idx" ON "orders"("tenant_id");

-- CreateIndex
CREATE INDEX "payment_provider_instances_tenant_id_idx" ON "payment_provider_instances"("tenant_id");

-- CreateIndex
CREATE INDEX "subscription_plans_tenant_id_idx" ON "subscription_plans"("tenant_id");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_tenant_id_idx" ON "users"("tenant_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_provider_instances" ADD CONSTRAINT "payment_provider_instances_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- 数据回填(P1):创建平台主体租户,把所有现存数据归到主体。
-- 固定 UUID 必须与 src/lib/admin/tenant-scope.ts 的 PLATFORM_TENANT_ID 一致。
-- superadmin 的 tenantScope() 返回 {}(不过滤);非 superadmin 过滤到本 id。
-- 不在此硬编码任何管理员邮箱 —— superadmin 授予走 scripts/grant-admin.ts。
-- tenant_id 列保持 nullable(null 视为主体);回填后所有现存行均指向主体行,
-- FK 约束(上方,ON DELETE SET NULL)因此满足。
INSERT INTO "tenants" ("id", "slug", "brand_name", "status", "prepaid_balance_cny", "created_at", "updated_at")
VALUES ('00000000-0000-0000-0000-000000000001', 'silkroadai', 'Silk Road AI', 'active', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

UPDATE "users" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "orders" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "channels" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "subscription_plans" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "payment_provider_instances" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
