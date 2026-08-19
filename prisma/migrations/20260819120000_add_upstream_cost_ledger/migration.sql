-- 真实上游成本台账(P1)。只保存 Portal 内部的对账证据；不会写 new-api 或客户账务。
CREATE TYPE "UpstreamCostStatus" AS ENUM ('verified', 'estimated', 'unmatched');
CREATE TYPE "UpstreamCostSource" AS ENUM ('manual', 'csv_import', 'upstream_api');

CREATE TABLE "upstream_cost_imports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "filename" VARCHAR(255) NOT NULL,
    "file_sha256" CHAR(64) NOT NULL,
    "row_count" INTEGER NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upstream_cost_imports_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "upstream_cost_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "import_id" UUID,
    "import_row_number" INTEGER,
    "status" "UpstreamCostStatus" NOT NULL,
    "source" "UpstreamCostSource" NOT NULL,
    "newapi_log_id" INTEGER,
    "newapi_request_id" VARCHAR(256),
    "upstream_request_id" VARCHAR(256),
    "upstream_provider" VARCHAR(128),
    "upstream_route" VARCHAR(160) NOT NULL,
    "upstream_model" VARCHAR(160),
    "upstream_amount" DECIMAL(20,8) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "cny_per_unit" DECIMAL(20,8) NOT NULL,
    "cost_multiplier" DECIMAL(20,8) NOT NULL DEFAULT 1,
    "cost_cny" DECIMAL(20,8) NOT NULL,
    "evidence_hash" VARCHAR(128),
    "evidence_summary" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upstream_cost_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "upstream_cost_imports_tenant_id_file_sha256_key"
    ON "upstream_cost_imports"("tenant_id", "file_sha256");
CREATE INDEX "upstream_cost_imports_tenant_id_created_at_idx"
    ON "upstream_cost_imports"("tenant_id", "created_at");
CREATE UNIQUE INDEX "upstream_cost_entries_import_id_import_row_number_key"
    ON "upstream_cost_entries"("import_id", "import_row_number");
CREATE INDEX "upstream_cost_entries_tenant_id_created_at_idx"
    ON "upstream_cost_entries"("tenant_id", "created_at");
CREATE INDEX "upstream_cost_entries_tenant_id_status_created_at_idx"
    ON "upstream_cost_entries"("tenant_id", "status", "created_at");
CREATE INDEX "upstream_cost_entries_newapi_log_id_idx"
    ON "upstream_cost_entries"("newapi_log_id");
CREATE INDEX "upstream_cost_entries_newapi_request_id_idx"
    ON "upstream_cost_entries"("newapi_request_id");
CREATE INDEX "upstream_cost_entries_upstream_request_id_idx"
    ON "upstream_cost_entries"("upstream_request_id");

ALTER TABLE "upstream_cost_imports"
    ADD CONSTRAINT "upstream_cost_imports_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "upstream_cost_entries"
    ADD CONSTRAINT "upstream_cost_entries_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "upstream_cost_entries"
    ADD CONSTRAINT "upstream_cost_entries_import_id_fkey"
    FOREIGN KEY ("import_id") REFERENCES "upstream_cost_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
