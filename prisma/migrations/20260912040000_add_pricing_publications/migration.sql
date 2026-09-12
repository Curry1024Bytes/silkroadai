-- CreateTable
CREATE TABLE "pricing_publish_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "requested_by" UUID,
    "model_id" UUID NOT NULL,
    "upstream_model" TEXT NOT NULL,
    "preview_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "plan" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT NOT NULL,
    "next_attempt_at" TIMESTAMP(3),
    "applied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_publish_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_publish_coordinator" (
    "id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "active_job_id" UUID,

    CONSTRAINT "pricing_publish_coordinator_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pricing_publish_jobs_preview_hash_key" ON "pricing_publish_jobs"("preview_hash");

-- CreateIndex
CREATE INDEX "pricing_publish_jobs_status_next_attempt_at_idx" ON "pricing_publish_jobs"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "pricing_publish_jobs_tenant_id_created_at_idx" ON "pricing_publish_jobs"("tenant_id", "created_at");

-- An independent durable write-ahead journal; deliberately no job FK/row lock.
CREATE TABLE "pricing_publish_writes" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_flight',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "resolved_by" TEXT,
    "resolution_note" TEXT,
    CONSTRAINT "pricing_publish_writes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pricing_publish_writes_job_id_status_created_at_idx"
    ON "pricing_publish_writes"("job_id", "status", "created_at");
