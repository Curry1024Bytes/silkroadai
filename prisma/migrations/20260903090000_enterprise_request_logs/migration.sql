-- 企业门户请求日志(2026-09-03):一条对客请求一行(submit 全量 / poll 有信息量的 / reconcile 动作)。
-- 纯 additive,旧代码运行期间 apply 安全。
CREATE TABLE "enterprise_request_logs" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "format" TEXT,
    "user_id" UUID,
    "key_id" UUID,
    "region" TEXT,
    "model" TEXT,
    "task_id" TEXT,
    "vendor_task_id" TEXT,
    "client_request_id" TEXT,
    "http_status" INTEGER,
    "upstream_status" INTEGER,
    "cache_hit" BOOLEAN NOT NULL DEFAULT false,
    "outcome" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "duration_ms" INTEGER,
    "upstream_ms" INTEGER,
    "request_body" TEXT,
    "upstream_body" TEXT,
    "client_ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "enterprise_request_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "enterprise_request_logs_created_at_idx" ON "enterprise_request_logs"("created_at");
CREATE INDEX "enterprise_request_logs_user_id_created_at_idx" ON "enterprise_request_logs"("user_id", "created_at");
CREATE INDEX "enterprise_request_logs_task_id_idx" ON "enterprise_request_logs"("task_id");
