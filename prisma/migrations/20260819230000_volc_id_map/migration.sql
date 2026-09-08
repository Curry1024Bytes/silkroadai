-- volc 渠道「火山原生 id」→「上游 id」映射表。
-- 纯增量:新表,不动任何既有表/列;回滚 = DROP TABLE。
CREATE TABLE "volc_id_map" (
    "vendor_id" TEXT NOT NULL,
    "upstream_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "volc_id_map_pkey" PRIMARY KEY ("vendor_id")
);

CREATE INDEX "volc_id_map_upstream_id_idx" ON "volc_id_map"("upstream_id");
CREATE INDEX "volc_id_map_user_id_idx" ON "volc_id_map"("user_id");
