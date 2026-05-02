/*
  Warnings:

  - You are about to drop the column `litellm_user_id` on the `users` table. All the data in the column will be lost.
  - You are about to drop the `litellm_keys` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[newapi_user_id]` on the table `users` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[newapi_username]` on the table `users` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "litellm_keys" DROP CONSTRAINT "litellm_keys_user_id_fkey";

-- DropForeignKey
ALTER TABLE "orders" DROP CONSTRAINT "orders_key_id_fkey";

-- DropForeignKey
ALTER TABLE "recharge_logs" DROP CONSTRAINT "recharge_logs_key_id_fkey";

-- DropIndex
DROP INDEX "users_litellm_user_id_key";

-- AlterTable
ALTER TABLE "recharge_logs" ADD COLUMN     "newapi_quota_added" BIGINT,
ADD COLUMN     "newapi_user_id" INTEGER,
ALTER COLUMN "key_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "users" DROP COLUMN "litellm_user_id",
ADD COLUMN     "newapi_access_token" TEXT,
ADD COLUMN     "newapi_cached_at" TIMESTAMP(3),
ADD COLUMN     "newapi_quota_cache" BIGINT,
ADD COLUMN     "newapi_used_quota_cache" BIGINT,
ADD COLUMN     "newapi_user_id" INTEGER,
ADD COLUMN     "newapi_username" TEXT;

-- DropTable
DROP TABLE "litellm_keys";

-- CreateTable
CREATE TABLE "newapi_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "newapi_token_id" INTEGER NOT NULL,
    "newapi_token_value" TEXT NOT NULL,
    "key_alias" TEXT NOT NULL,
    "cached_remain_quota" BIGINT,
    "cached_used_quota" BIGINT,
    "last_synced_at" TIMESTAMP(3),
    "model_limits_enabled" BOOLEAN NOT NULL DEFAULT false,
    "model_limits" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "KeyStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "newapi_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "newapi_tokens_newapi_token_id_key" ON "newapi_tokens"("newapi_token_id");

-- CreateIndex
CREATE UNIQUE INDEX "newapi_tokens_newapi_token_value_key" ON "newapi_tokens"("newapi_token_value");

-- CreateIndex
CREATE INDEX "newapi_tokens_user_id_idx" ON "newapi_tokens"("user_id");

-- CreateIndex
CREATE INDEX "newapi_tokens_newapi_token_id_idx" ON "newapi_tokens"("newapi_token_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_newapi_user_id_key" ON "users"("newapi_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_newapi_username_key" ON "users"("newapi_username");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "newapi_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newapi_tokens" ADD CONSTRAINT "newapi_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recharge_logs" ADD CONSTRAINT "recharge_logs_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "newapi_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;
