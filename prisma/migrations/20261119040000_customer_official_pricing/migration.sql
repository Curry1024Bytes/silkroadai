CREATE TABLE "customer_official_references" (
    "id" UUID NOT NULL, "tenant_id" UUID, "model_id" UUID NOT NULL, "tier_key" TEXT NOT NULL,
    "shape" TEXT NOT NULL, "cells" JSONB NOT NULL, "source_currency" TEXT NOT NULL,
    "source_fx" DECIMAL(24,12) NOT NULL, "source_note" TEXT NOT NULL, "revision" INTEGER NOT NULL DEFAULT 1,
    "confirmed_by" UUID, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "customer_official_references_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_official_references_fx_positive" CHECK ("source_fx" > 0)
);
CREATE UNIQUE INDEX "customer_official_references_model_id_tier_key_key" ON "customer_official_references"("model_id", "tier_key");

CREATE TABLE "customer_official_price_rules" (
    "id" UUID NOT NULL, "tenant_id" UUID, "user_id" UUID NOT NULL, "tier_key" TEXT NOT NULL,
    "model_key" TEXT NOT NULL, "official_multiplier" DECIMAL(24,12) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1, "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "customer_official_price_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_official_price_rules_multiplier_positive" CHECK ("official_multiplier" > 0 AND "official_multiplier" <= 100)
);
CREATE UNIQUE INDEX "customer_official_price_rules_user_id_tier_key_model_key_key" ON "customer_official_price_rules"("user_id", "tier_key", "model_key");
CREATE INDEX "customer_official_price_rules_tier_key_model_key_idx" ON "customer_official_price_rules"("tier_key", "model_key");

CREATE TABLE "customer_model_billing_groups" (
    "id" UUID NOT NULL, "tenant_id" UUID, "tier_key" TEXT NOT NULL, "model_id" UUID NOT NULL,
    "model_name" TEXT NOT NULL, "public_group" TEXT NOT NULL, "internal_group" TEXT NOT NULL,
    "source_channel_ids" INTEGER[] NOT NULL, "replica_channel_ids" INTEGER[] NOT NULL,
    "source_fingerprint" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'preparing',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "customer_model_billing_groups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "customer_model_billing_groups_internal_group_key" ON "customer_model_billing_groups"("internal_group");
CREATE UNIQUE INDEX "customer_model_billing_groups_tier_key_model_id_key" ON "customer_model_billing_groups"("tier_key", "model_id");

CREATE TABLE "customer_pricing_bindings" (
    "id" UUID NOT NULL, "user_id" UUID NOT NULL, "tier_key" TEXT NOT NULL, "public_group" TEXT NOT NULL,
    "model_groups" JSONB NOT NULL, "token_snapshots" JSONB NOT NULL, "original_user_group" TEXT NOT NULL,
    "original_auto_permissions" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'applying', "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "customer_pricing_bindings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "customer_pricing_bindings_user_id_tier_key_key" ON "customer_pricing_bindings"("user_id", "tier_key");
CREATE INDEX "customer_pricing_bindings_status_idx" ON "customer_pricing_bindings"("status");

CREATE TABLE "customer_pricing_changes" (
    "id" UUID NOT NULL, "user_id" UUID NOT NULL, "tier_key" TEXT NOT NULL, "actor_id" UUID,
    "status" TEXT NOT NULL, "before" JSONB NOT NULL, "after" JSONB NOT NULL, "progress" JSONB NOT NULL,
    "error" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "customer_pricing_changes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "customer_pricing_changes_status_created_at_idx" ON "customer_pricing_changes"("status", "created_at");

CREATE TABLE "customer_pricing_token_identities" (
    "token_id" INTEGER NOT NULL, "key_hash" TEXT NOT NULL, "user_id" UUID NOT NULL, "tier_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "customer_pricing_token_identities_pkey" PRIMARY KEY ("token_id")
);
CREATE UNIQUE INDEX "customer_pricing_token_identities_key_hash_key" ON "customer_pricing_token_identities"("key_hash");
CREATE INDEX "customer_pricing_token_identities_user_id_tier_key_idx" ON "customer_pricing_token_identities"("user_id", "tier_key");
