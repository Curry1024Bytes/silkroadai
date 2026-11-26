CREATE TABLE "upstream_margin_costs" (
    "id" UUID NOT NULL,
    "channel_id" INTEGER NOT NULL,
    "reference_kind" VARCHAR(16) NOT NULL,
    "reference_id" VARCHAR(192) NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "currency" VARCHAR(12) NOT NULL,
    "cny_per_unit" DECIMAL(20,8) NOT NULL,
    "status" VARCHAR(12) NOT NULL,
    "evidence" VARCHAR(240) NOT NULL,
    "imported_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "upstream_margin_costs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "upstream_margin_costs_valid" CHECK (
        channel_id > 0 AND cny_per_unit > 0
        AND reference_kind IN ('task', 'upstream', 'request')
        AND status IN ('verified', 'estimated')
    )
);

CREATE UNIQUE INDEX "upstream_margin_costs_reference_key"
    ON "upstream_margin_costs" ("channel_id", "reference_kind", "reference_id");
CREATE INDEX "upstream_margin_costs_reference_id_idx"
    ON "upstream_margin_costs" ("reference_id");
