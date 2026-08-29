-- OpenAI Batch API 兼容(/v1/files + /v1/batches)— 全 additive,零 ALTER/DROP
CREATE TABLE "batch_files" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_files_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "batch_files_user_id_created_at_idx" ON "batch_files"("user_id", "created_at");

CREATE TABLE "batches" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "input_file_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'validating',
    "output_file_id" TEXT,
    "error_file_id" TEXT,
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "completed_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "errors_json" JSONB,
    "metadata_json" JSONB,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "auth_header" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "batches_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "batches_user_id_created_at_idx" ON "batches"("user_id", "created_at");
CREATE INDEX "batches_status_created_at_idx" ON "batches"("status", "created_at");

CREATE TABLE "batch_request_results" (
    "batch_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "custom_id" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response_json" JSONB,
    "error_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_request_results_pkey" PRIMARY KEY ("batch_id", "line_no")
);

CREATE INDEX "batch_request_results_batch_id_idx" ON "batch_request_results"("batch_id");
