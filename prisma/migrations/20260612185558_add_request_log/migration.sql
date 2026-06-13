-- CreateTable
CREATE TABLE "request_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "user_id" UUID,
    "token_id" UUID,
    "newapi_token_hash" TEXT,
    "path" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "model" TEXT,
    "status_code" INTEGER,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "duration_ms" INTEGER,
    "streamed" BOOLEAN NOT NULL DEFAULT false,
    "incomplete" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "input_r2_key" TEXT,
    "output_r2_key" TEXT,
    "input_bytes" INTEGER NOT NULL DEFAULT 0,
    "output_bytes" INTEGER NOT NULL DEFAULT 0,
    "input_image_r2_keys" JSONB NOT NULL DEFAULT '[]',
    "output_image_refs" JSONB NOT NULL DEFAULT '[]',
    "retention_expires_at" TIMESTAMP(3),
    "capture_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "request_logs_user_id_created_at_idx" ON "request_logs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "request_logs_model_created_at_idx" ON "request_logs"("model", "created_at");

-- CreateIndex
CREATE INDEX "request_logs_created_at_idx" ON "request_logs"("created_at");

-- CreateIndex
CREATE INDEX "request_logs_success_created_at_idx" ON "request_logs"("success", "created_at");
