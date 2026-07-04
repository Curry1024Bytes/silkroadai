-- CreateTable
CREATE TABLE "image_tasks" (
    "task_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "model" TEXT,
    "endpoint" TEXT NOT NULL,
    "result_json" JSONB,
    "fail_reason" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "image_tasks_pkey" PRIMARY KEY ("task_id")
);

-- CreateIndex
CREATE INDEX "image_tasks_user_id_created_at_idx" ON "image_tasks"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "image_tasks_status_created_at_idx" ON "image_tasks"("status", "created_at");
