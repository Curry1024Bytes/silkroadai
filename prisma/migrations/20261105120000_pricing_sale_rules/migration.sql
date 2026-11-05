-- 动态售卖规则:计费分组纳管、售卖规则、编译发布记录(2026-11-05 规格)。只增不改。
-- AlterTable
ALTER TABLE "user_tier_multipliers" ADD COLUMN     "managed_by_rules" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "pricing_billing_groups" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "tier_key" TEXT NOT NULL,
    "newapi_group" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT true,
    "unified_sale_ratio" DECIMAL(24,12),
    "managed_at" TIMESTAMP(3),
    "managed_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_billing_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_sale_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "kind" TEXT NOT NULL,
    "user_id" UUID,
    "tier_key" TEXT NOT NULL,
    "model_id" UUID,
    "discount" DECIMAL(16,10) NOT NULL,
    "effective_from" TIMESTAMP(3),
    "effective_to" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "below_cost_ack_reason" TEXT,
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_sale_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_rule_publications" (
    "id" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "actor_id" UUID,
    "actor_email" TEXT,
    "status" TEXT NOT NULL,
    "target_at" TIMESTAMP(3) NOT NULL,
    "preview_hash" TEXT,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "diagnostics" JSONB NOT NULL,
    "moves" JSONB NOT NULL,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_rule_publications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pricing_billing_groups_newapi_group_key" ON "pricing_billing_groups"("newapi_group");

-- CreateIndex
CREATE INDEX "pricing_billing_groups_tenant_id_tier_key_idx" ON "pricing_billing_groups"("tenant_id", "tier_key");

-- CreateIndex
CREATE INDEX "pricing_sale_rules_tenant_id_tier_key_enabled_idx" ON "pricing_sale_rules"("tenant_id", "tier_key", "enabled");

-- CreateIndex
CREATE INDEX "pricing_sale_rules_user_id_enabled_idx" ON "pricing_sale_rules"("user_id", "enabled");

-- CreateIndex
CREATE INDEX "pricing_rule_publications_created_at_idx" ON "pricing_rule_publications"("created_at");

