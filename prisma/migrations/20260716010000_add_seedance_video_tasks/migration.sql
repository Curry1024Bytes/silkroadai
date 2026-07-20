-- seedance-cn 视频端到端自扣计费:每笔视频任务归属 + token + ¥ 消费(纯 CREATE,无 backfill)。
-- /v1 代理绕过 new-api 直连上游:提交记录、轮询完成按 usage.completion_tokens 扣费(billed 幂等),
-- 兼作 dashboard 用量来源。不扣 new-api、不影响其它计费路径。

-- CreateTable
CREATE TABLE "seedance_video_tasks" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID,
    "user_id" UUID NOT NULL,
    "newapi_user_id" INTEGER,
    "tier" TEXT NOT NULL DEFAULT 'pool',
    "model" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "has_video" BOOLEAN NOT NULL DEFAULT false,
    "duration" INTEGER NOT NULL DEFAULT 5,
    "tokens" BIGINT,
    "cost_cny" DECIMAL(20,8),
    "billed" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "billed_at" TIMESTAMP(3),

    CONSTRAINT "seedance_video_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "seedance_video_tasks_user_id_created_at_idx" ON "seedance_video_tasks"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "seedance_video_tasks_billed_idx" ON "seedance_video_tasks"("billed");
