-- CreateTable
CREATE TABLE "kling_video_tasks" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID,
    "user_id" UUID NOT NULL,
    "newapi_user_id" INTEGER,
    "model" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "generate_audio" BOOLEAN NOT NULL DEFAULT false,
    "has_video" BOOLEAN NOT NULL DEFAULT false,
    "duration" INTEGER NOT NULL DEFAULT 5,
    "cost_cny" DECIMAL(20,8),
    "billed" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "billed_at" TIMESTAMP(3),

    CONSTRAINT "kling_video_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kling_video_tasks_user_id_created_at_idx" ON "kling_video_tasks"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "kling_video_tasks_billed_idx" ON "kling_video_tasks"("billed");

