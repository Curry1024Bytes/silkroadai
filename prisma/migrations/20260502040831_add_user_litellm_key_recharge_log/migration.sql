/*
  Warnings:

  - The `user_id` column on the `orders` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'disabled', 'banned');

-- CreateEnum
CREATE TYPE "KeyStatus" AS ENUM ('active', 'disabled', 'expired');

-- CreateEnum
CREATE TYPE "RechargeSource" AS ENUM ('payment', 'manual', 'refund', 'promo', 'adjustment');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "key_id" UUID,
DROP COLUMN "user_id",
ADD COLUMN     "user_id" UUID;

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "email_verify_token" TEXT,
    "email_verify_expires" TIMESTAMP(3),
    "reset_password_token" TEXT,
    "reset_password_expires" TIMESTAMP(3),
    "nickname" TEXT,
    "avatar_url" TEXT,
    "last_login_at" TIMESTAMP(3),
    "last_login_ip" TEXT,
    "locale" VARCHAR(10) NOT NULL DEFAULT 'zh-CN',
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "litellm_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "litellm_keys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "litellm_key" TEXT NOT NULL,
    "key_alias" TEXT NOT NULL,
    "max_budget" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "cached_spend" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "last_synced_at" TIMESTAMP(3),
    "models" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "KeyStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "litellm_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recharge_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "key_id" UUID NOT NULL,
    "order_id" TEXT,
    "amount" DECIMAL(12,4) NOT NULL,
    "balance_before" DECIMAL(12,4) NOT NULL,
    "balance_after" DECIMAL(12,4) NOT NULL,
    "source" "RechargeSource" NOT NULL DEFAULT 'payment',
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recharge_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_litellm_user_id_key" ON "users"("litellm_user_id");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE UNIQUE INDEX "litellm_keys_litellm_key_key" ON "litellm_keys"("litellm_key");

-- CreateIndex
CREATE INDEX "litellm_keys_user_id_idx" ON "litellm_keys"("user_id");

-- CreateIndex
CREATE INDEX "litellm_keys_litellm_key_idx" ON "litellm_keys"("litellm_key");

-- CreateIndex
CREATE INDEX "recharge_logs_user_id_idx" ON "recharge_logs"("user_id");

-- CreateIndex
CREATE INDEX "recharge_logs_key_id_idx" ON "recharge_logs"("key_id");

-- CreateIndex
CREATE INDEX "recharge_logs_order_id_idx" ON "recharge_logs"("order_id");

-- CreateIndex
CREATE INDEX "recharge_logs_created_at_idx" ON "recharge_logs"("created_at");

-- CreateIndex
CREATE INDEX "orders_user_id_idx" ON "orders"("user_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "litellm_keys" ADD CONSTRAINT "litellm_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recharge_logs" ADD CONSTRAINT "recharge_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recharge_logs" ADD CONSTRAINT "recharge_logs_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "litellm_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recharge_logs" ADD CONSTRAINT "recharge_logs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
