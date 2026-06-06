-- AlterTable
ALTER TABLE "newapi_tokens" ADD COLUMN     "tier" TEXT NOT NULL DEFAULT 'pool';

-- CreateTable
CREATE TABLE "channel_groups" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "newapi_group" TEXT NOT NULL,
    "tier_level" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "newapi_channel_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_groups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_groups_tenant_id_enabled_idx" ON "channel_groups"("tenant_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "channel_groups_tenant_id_key_key" ON "channel_groups"("tenant_id", "key");

-- AddForeignKey
ALTER TABLE "channel_groups" ADD CONSTRAINT "channel_groups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- 数据回填(P3):平台主体的两个档次 + 现有 token 显式置 'pool'。
-- ─────────────────────────────────────────────────────────────────────────
-- 档次 key 与 new-api group 解耦:pool→'default'(复用现有渠道组,现有 token
-- 已是 default,零迁移);official→'official'(运维需在 new-api 新建该 group 并把
-- 官方渠道归进去后才有渠道)。平台主体租户固定 UUID 与
-- src/lib/admin/tenant-scope.ts PLATFORM_TENANT_ID 一致。
INSERT INTO "channel_groups"
  ("id", "tenant_id", "key", "display_name", "description", "newapi_group", "tier_level", "enabled", "is_default", "newapi_channel_ids", "created_at", "updated_at")
VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', 'pool', '低价号池', '默认档:复用现有 default 渠道组(骨折价)', 'default', 0, true, true, ARRAY[]::INTEGER[], now(), now()),
  (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', 'official', '官方稳定', '官方 / 云厂商稳定渠道(更稳更贵);运维需在 new-api 新建 official group 并归入官方渠道', 'official', 1, true, false, ARRAY[]::INTEGER[], now(), now());

-- 现有 token 显式置 pool(上方 ADD COLUMN DEFAULT 'pool' 已覆盖,这里确保旧行
-- 一致)。其 new-api group 仍是 'default'(未改),与 pool→default 映射一致。
UPDATE "newapi_tokens" SET "tier" = 'pool';
