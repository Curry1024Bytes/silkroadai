-- AlterTable
ALTER TABLE "recharge_logs" ADD COLUMN     "bonus_quota_added" BIGINT DEFAULT 0;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "first_recharge_bonus_granted" BOOLEAN NOT NULL DEFAULT false;
