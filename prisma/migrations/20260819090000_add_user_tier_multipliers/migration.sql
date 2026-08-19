-- Portal customer-specific new-api GroupGroupRatio mirror.
-- No existing users or API keys are changed by this migration.
CREATE TABLE "user_tier_multipliers" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tier_key" TEXT NOT NULL,
    "newapi_billing_group" TEXT NOT NULL,
    "newapi_user_group" TEXT NOT NULL,
    "original_newapi_user_group" TEXT NOT NULL,
    "multiplier" DECIMAL(10,6) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "synced_at" TIMESTAMP(3),
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_tier_multipliers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_tier_multipliers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "user_tier_multipliers_user_id_tier_key_key" ON "user_tier_multipliers"("user_id", "tier_key");
CREATE INDEX "user_tier_multipliers_user_id_enabled_idx" ON "user_tier_multipliers"("user_id", "enabled");
