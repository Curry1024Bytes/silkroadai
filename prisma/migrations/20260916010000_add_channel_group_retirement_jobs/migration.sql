-- Additive only. Existing groups, keys, balances and histories are untouched.
CREATE TABLE "channel_group_retirement_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "requested_by" UUID,
    "group_id" UUID,
    "tier_key" TEXT NOT NULL,
    "group_name" TEXT NOT NULL,
    "newapi_group" TEXT NOT NULL,
    "replacement_default_id" UUID,
    "orphaned" BOOLEAN NOT NULL DEFAULT FALSE,
    "preview_hash" TEXT NOT NULL,
    "plan" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "message" TEXT NOT NULL,
    "runner_token" UUID,
    "lease_until" TIMESTAMP(3),
    "result" JSONB,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "channel_group_retirement_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "channel_group_retirement_jobs_status_check" CHECK ("status" IN ('queued', 'running', 'needs_attention', 'succeeded', 'cancelled'))
);
CREATE UNIQUE INDEX "channel_group_retirement_jobs_preview_hash_key" ON "channel_group_retirement_jobs"("preview_hash");
CREATE INDEX "channel_group_retirement_jobs_tenant_id_tier_key_status_idx" ON "channel_group_retirement_jobs"("tenant_id", "tier_key", "status");
CREATE INDEX "channel_group_retirement_jobs_status_updated_at_idx" ON "channel_group_retirement_jobs"("status", "updated_at");
CREATE UNIQUE INDEX "channel_group_retirement_jobs_one_active_tier" ON "channel_group_retirement_jobs"(
    (COALESCE("tenant_id", '00000000-0000-0000-0000-000000000001'::uuid)), "tier_key"
) WHERE "status" NOT IN ('succeeded', 'cancelled');

CREATE TABLE "channel_group_retirement_keys" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "portal_key_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "newapi_user_id" INTEGER,
    "newapi_token_id" INTEGER NOT NULL,
    "expected_group" TEXT NOT NULL,
    "credential_hash" TEXT NOT NULL,
    "ownership_evidence" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "message" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "verified_remote" JSONB,
    "verified_at" TIMESTAMP(3),
    "delete_started_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),
    "last_error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "channel_group_retirement_keys_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "channel_group_retirement_keys_status_check" CHECK ("status" IN ('pending', 'revoking', 'confirmed', 'already_absent', 'blocked')),
    CONSTRAINT "channel_group_retirement_keys_positive_ids" CHECK ("newapi_token_id" > 0 AND ("newapi_user_id" IS NULL OR "newapi_user_id" > 0)),
    CONSTRAINT "channel_group_retirement_keys_attempts_check" CHECK ("attempts" >= 0)
);
CREATE UNIQUE INDEX "channel_group_retirement_keys_job_id_portal_key_id_key" ON "channel_group_retirement_keys"("job_id", "portal_key_id");
CREATE INDEX "channel_group_retirement_keys_job_id_status_idx" ON "channel_group_retirement_keys"("job_id", "status");
CREATE INDEX "channel_group_retirement_keys_portal_key_id_idx" ON "channel_group_retirement_keys"("portal_key_id");
