-- 白标代理（White-label Partner）P1 v2 — 按用户分组倍率定价
-- Migration: 20261126000000_add_partner_reseller_tables
-- 由 prisma migrate diff（HEAD schema → 本次 schema）生成；结算游标用 IF NOT EXISTS，兼容跑过 v1 的开发库。

-- AlterTable
ALTER TABLE "usage_meter_cursor" ADD COLUMN IF NOT EXISTS "partner_last_log_id" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "partner_group_prices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "group_key" VARCHAR(80) NOT NULL,
    "wholesale_ratio" DECIMAL(12,6) NOT NULL,
    "retail_ratio" DECIMAL(12,6),
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_group_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_wholesale_ratio_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "group_key" VARCHAR(80) NOT NULL,
    "wholesale_ratio" DECIMAL(12,6) NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "partner_wholesale_ratio_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_retail_ratio_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "group_key" VARCHAR(80) NOT NULL,
    "retail_ratio" DECIMAL(12,6),
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "partner_retail_ratio_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_wallets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "balance_cny" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "pending_cny" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "total_earned_cny" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_earnings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "newapi_log_id" INTEGER NOT NULL,
    "kind" VARCHAR(16) NOT NULL DEFAULT 'consume',
    "task_id" VARCHAR(200),
    "model_slug" VARCHAR(200) NOT NULL,
    "group_key" VARCHAR(80) NOT NULL,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "charged_quota" BIGINT NOT NULL,
    "retail_ratio" DECIMAL(12,6) NOT NULL,
    "wholesale_ratio" DECIMAL(12,6) NOT NULL,
    "retail_cny" DECIMAL(12,6) NOT NULL,
    "wholesale_cny" DECIMAL(12,6) NOT NULL,
    "profit_cny" DECIMAL(12,6) NOT NULL,
    "settled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_earnings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_withdrawals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "amount_cny" DECIMAL(20,4) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "note" VARCHAR(500),
    "admin_note" VARCHAR(500),
    "requested_by" UUID,
    "processed_by" UUID,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_domain_claims" (
    "tenant_id" UUID NOT NULL,
    "domain" VARCHAR(253) NOT NULL,
    "token" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_domain_claims_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateIndex
CREATE INDEX "partner_group_prices_tenant_id_idx" ON "partner_group_prices"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_group_prices_tenant_id_group_key_key" ON "partner_group_prices"("tenant_id", "group_key");

-- CreateIndex
CREATE INDEX "partner_wholesale_ratio_history_tenant_id_group_key_effecti_idx" ON "partner_wholesale_ratio_history"("tenant_id", "group_key", "effective_from" DESC);

-- CreateIndex
CREATE INDEX "partner_retail_ratio_history_tenant_id_group_key_effective__idx" ON "partner_retail_ratio_history"("tenant_id", "group_key", "effective_from" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "partner_wallets_tenant_id_key" ON "partner_wallets"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_earnings_newapi_log_id_key" ON "partner_earnings"("newapi_log_id");

-- CreateIndex
CREATE INDEX "partner_earnings_tenant_id_settled_at_idx" ON "partner_earnings"("tenant_id", "settled_at" DESC);

-- CreateIndex
CREATE INDEX "partner_earnings_user_id_idx" ON "partner_earnings"("user_id");

-- CreateIndex
CREATE INDEX "partner_earnings_tenant_id_task_id_idx" ON "partner_earnings"("tenant_id", "task_id");

-- CreateIndex
CREATE INDEX "partner_withdrawals_tenant_id_created_at_idx" ON "partner_withdrawals"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "partner_withdrawals_status_created_at_idx" ON "partner_withdrawals"("status", "created_at");

-- AddForeignKey
ALTER TABLE "partner_group_prices" ADD CONSTRAINT "partner_group_prices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_wholesale_ratio_history" ADD CONSTRAINT "partner_wholesale_ratio_history_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_retail_ratio_history" ADD CONSTRAINT "partner_retail_ratio_history_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_wallets" ADD CONSTRAINT "partner_wallets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_earnings" ADD CONSTRAINT "partner_earnings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_withdrawals" ADD CONSTRAINT "partner_withdrawals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_domain_claims" ADD CONSTRAINT "partner_domain_claims_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

