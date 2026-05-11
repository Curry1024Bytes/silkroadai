-- CreateEnum
CREATE TYPE "ResellerStatus" AS ENUM ('active', 'suspended', 'banned');

-- CreateEnum
CREATE TYPE "ResellerTier" AS ENUM ('bronze', 'silver', 'gold');

-- CreateEnum
CREATE TYPE "CommissionStatus" AS ENUM ('pending', 'confirmed', 'settled');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('pending', 'requested', 'paid');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "attribution_expires_at" TIMESTAMP(3),
ADD COLUMN     "inviter_code_id" UUID,
ADD COLUMN     "inviter_reseller_id" UUID,
ADD COLUMN     "signup_ip" TEXT,
ADD COLUMN     "signup_ua" TEXT;

-- CreateTable
CREATE TABLE "resellers" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tier" "ResellerTier" NOT NULL DEFAULT 'bronze',
    "cumulative_gmv" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "status" "ResellerStatus" NOT NULL DEFAULT 'active',
    "settle_method" TEXT,
    "settle_account" TEXT,
    "settle_name" TEXT,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resellers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reseller_invite_codes" (
    "id" UUID NOT NULL,
    "reseller_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reseller_invite_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reseller_commissions" (
    "id" UUID NOT NULL,
    "reseller_id" UUID NOT NULL,
    "user_id" UUID,
    "recharge_log_id" UUID NOT NULL,
    "attributed_gmv" DECIMAL(12,4) NOT NULL,
    "commission_rate" DECIMAL(5,4) NOT NULL,
    "commission_amount" DECIMAL(12,4) NOT NULL,
    "status" "CommissionStatus" NOT NULL DEFAULT 'pending',
    "admin_review_required" BOOLEAN NOT NULL DEFAULT false,
    "hold_until" TIMESTAMP(3) NOT NULL,
    "settled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reseller_commissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reseller_settlements" (
    "id" UUID NOT NULL,
    "reseller_id" UUID NOT NULL,
    "period_month" TEXT NOT NULL,
    "total_commission" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "commission_count" INTEGER NOT NULL DEFAULT 0,
    "status" "SettlementStatus" NOT NULL DEFAULT 'pending',
    "requested_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "paid_tx_ref" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reseller_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "resellers_user_id_key" ON "resellers"("user_id");

-- CreateIndex
CREATE INDEX "resellers_status_idx" ON "resellers"("status");

-- CreateIndex
CREATE INDEX "resellers_tier_idx" ON "resellers"("tier");

-- CreateIndex
CREATE UNIQUE INDEX "reseller_invite_codes_code_key" ON "reseller_invite_codes"("code");

-- CreateIndex
CREATE INDEX "reseller_invite_codes_reseller_id_is_active_idx" ON "reseller_invite_codes"("reseller_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "reseller_commissions_recharge_log_id_key" ON "reseller_commissions"("recharge_log_id");

-- CreateIndex
CREATE INDEX "reseller_commissions_reseller_id_status_idx" ON "reseller_commissions"("reseller_id", "status");

-- CreateIndex
CREATE INDEX "reseller_commissions_reseller_id_created_at_idx" ON "reseller_commissions"("reseller_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "reseller_commissions_status_hold_until_idx" ON "reseller_commissions"("status", "hold_until");

-- CreateIndex
CREATE INDEX "reseller_commissions_user_id_idx" ON "reseller_commissions"("user_id");

-- CreateIndex
CREATE INDEX "reseller_settlements_reseller_id_status_idx" ON "reseller_settlements"("reseller_id", "status");

-- CreateIndex
CREATE INDEX "reseller_settlements_status_period_month_idx" ON "reseller_settlements"("status", "period_month");

-- CreateIndex
CREATE UNIQUE INDEX "reseller_settlements_reseller_id_period_month_key" ON "reseller_settlements"("reseller_id", "period_month");

-- CreateIndex
CREATE INDEX "users_inviter_reseller_id_created_at_idx" ON "users"("inviter_reseller_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "users_signup_ip_created_at_idx" ON "users"("signup_ip", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "resellers" ADD CONSTRAINT "resellers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reseller_invite_codes" ADD CONSTRAINT "reseller_invite_codes_reseller_id_fkey" FOREIGN KEY ("reseller_id") REFERENCES "resellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reseller_commissions" ADD CONSTRAINT "reseller_commissions_reseller_id_fkey" FOREIGN KEY ("reseller_id") REFERENCES "resellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reseller_commissions" ADD CONSTRAINT "reseller_commissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reseller_commissions" ADD CONSTRAINT "reseller_commissions_recharge_log_id_fkey" FOREIGN KEY ("recharge_log_id") REFERENCES "recharge_logs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reseller_settlements" ADD CONSTRAINT "reseller_settlements_reseller_id_fkey" FOREIGN KEY ("reseller_id") REFERENCES "resellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
