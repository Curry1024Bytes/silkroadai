-- W6 D4: per-key usage cache.
--
-- `cached_used_quota` was added in W2 D4 as nullable but never written by
-- any code (the W4-2 D6 quota-cache work moved cache columns to the User
-- table). Existing rows are all NULL. Backfill to 0 before SET NOT NULL.
-- `cached_used_at` is the new 60s-TTL marker — nullable so callers can
-- distinguish "never synced" (null → cache miss) from "synced at T".

-- AlterTable: backfill nulls + tighten constraint + add cache-timestamp.
UPDATE "newapi_tokens" SET "cached_used_quota" = 0 WHERE "cached_used_quota" IS NULL;

ALTER TABLE "newapi_tokens" ADD COLUMN     "cached_used_at" TIMESTAMP(3),
ALTER COLUMN "cached_used_quota" SET NOT NULL,
ALTER COLUMN "cached_used_quota" SET DEFAULT 0;
