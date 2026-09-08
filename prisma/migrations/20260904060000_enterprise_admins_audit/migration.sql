-- 企业运营后台 次级管理员 + 管理员操作审计(2026-09-04)。纯 additive,旧代码运行期间 apply 安全。
CREATE TABLE "enterprise_admins" (
    "user_id" UUID NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "enterprise_admins_pkey" PRIMARY KEY ("user_id")
);

CREATE TABLE "admin_audit_logs" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "admin_user_id" UUID,
    "admin_email" TEXT,
    "level" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "target" TEXT,
    "params" TEXT,
    "client_ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_audit_logs_created_at_idx" ON "admin_audit_logs"("created_at");
CREATE INDEX "admin_audit_logs_admin_user_id_created_at_idx" ON "admin_audit_logs"("admin_user_id", "created_at");
