-- AlterTable
ALTER TABLE "users" ADD COLUMN     "allowed_tier_keys" TEXT[] DEFAULT ARRAY[]::TEXT[];
