-- P4a shadow metering. Pure CREATE (no backfill):
--   usage_records      — one ¥-cost record per new-api consume log (idempotent on newapi_log_id)
--   usage_meter_cursor — single-row poll cursor (last processed new-api log id)
-- Shadow only: nothing here deducts balance, gates requests, or writes to new-api.

-- CreateTable
CREATE TABLE "usage_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "user_id" UUID NOT NULL,
    "token_id" UUID,
    "newapi_log_id" INTEGER NOT NULL,
    "newapi_user_id" INTEGER NOT NULL,
    "model_slug" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'pool',
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_cny" DECIMAL(20,8) NOT NULL,
    "price_id" UUID,
    "matched" BOOLEAN NOT NULL DEFAULT true,
    "newapi_quota" INTEGER NOT NULL DEFAULT 0,
    "log_created_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_meter_cursor" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "last_log_id" INTEGER NOT NULL DEFAULT 0,
    "last_run_at" TIMESTAMP(3),

    CONSTRAINT "usage_meter_cursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usage_records_newapi_log_id_key" ON "usage_records"("newapi_log_id");

-- CreateIndex
CREATE INDEX "usage_records_user_id_log_created_at_idx" ON "usage_records"("user_id", "log_created_at");

-- CreateIndex
CREATE INDEX "usage_records_tenant_id_model_slug_log_created_at_idx" ON "usage_records"("tenant_id", "model_slug", "log_created_at");

-- CreateIndex
CREATE INDEX "usage_records_matched_idx" ON "usage_records"("matched");
