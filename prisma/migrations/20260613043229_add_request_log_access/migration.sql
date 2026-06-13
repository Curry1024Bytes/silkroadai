-- CreateTable
CREATE TABLE "request_log_access" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID,
    "via_break_glass" BOOLEAN NOT NULL DEFAULT false,
    "action" TEXT NOT NULL,
    "request_log_id" UUID,
    "query" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_log_access_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "request_log_access_actor_user_id_created_at_idx" ON "request_log_access"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "request_log_access_request_log_id_idx" ON "request_log_access"("request_log_id");

-- CreateIndex
CREATE INDEX "request_log_access_created_at_idx" ON "request_log_access"("created_at");
