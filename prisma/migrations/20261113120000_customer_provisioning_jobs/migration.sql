CREATE TABLE "customer_provisioning_jobs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(160) NOT NULL,
    "email" TEXT NOT NULL,
    "tier_key" TEXT NOT NULL,
    "newapi_group" TEXT NOT NULL,
    "initial_quota" INTEGER NOT NULL DEFAULT 0,
    "password_ciphertext" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 8,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runner_token" UUID,
    "lease_until" TIMESTAMP(3),
    "last_error_code" VARCHAR(80),
    "last_error_message" TEXT,
    "result" JSONB,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_provisioning_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_provisioning_jobs_user_id_key" ON "customer_provisioning_jobs"("user_id");
CREATE UNIQUE INDEX "customer_provisioning_jobs_idempotency_key_key" ON "customer_provisioning_jobs"("idempotency_key");
CREATE INDEX "customer_provisioning_jobs_status_next_attempt_at_idx" ON "customer_provisioning_jobs"("status", "next_attempt_at");
CREATE INDEX "customer_provisioning_jobs_lease_until_idx" ON "customer_provisioning_jobs"("lease_until");

ALTER TABLE "customer_provisioning_jobs" ADD CONSTRAINT "customer_provisioning_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
