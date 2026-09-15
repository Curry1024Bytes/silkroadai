-- Purchasing terms are drafts only; no existing model, price, channel, or user is changed.
CREATE TABLE "pricing_cost_rules" (
    "id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "tier" TEXT NOT NULL,
    "channel_id" INTEGER NOT NULL,
    "upstream_model" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "pricing_cost_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pricing_cost_rules_channel_id_check" CHECK ("channel_id" > 0),
    CONSTRAINT "pricing_cost_rules_revision_check" CHECK ("revision" > 0)
);
CREATE UNIQUE INDEX "pricing_cost_rules_model_id_tier_key" ON "pricing_cost_rules"("model_id", "tier");
ALTER TABLE "pricing_cost_rules" ADD CONSTRAINT "pricing_cost_rules_model_id_fkey"
    FOREIGN KEY ("model_id") REFERENCES "catalog_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "pricing_cost_rule_revisions" (
    "id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "channel_id" INTEGER NOT NULL,
    "upstream_model" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pricing_cost_rule_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pricing_cost_rule_revisions_channel_id_check" CHECK ("channel_id" > 0),
    CONSTRAINT "pricing_cost_rule_revisions_revision_check" CHECK ("revision" > 0)
);
CREATE UNIQUE INDEX "pricing_cost_rule_revisions_rule_id_revision_key" ON "pricing_cost_rule_revisions"("rule_id", "revision");
ALTER TABLE "pricing_cost_rule_revisions" ADD CONSTRAINT "pricing_cost_rule_revisions_rule_id_fkey"
    FOREIGN KEY ("rule_id") REFERENCES "pricing_cost_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Draft history cannot be overwritten. Deletion follows its parent rule/model's
-- cascade lifecycle; saving a newer version must append another revision row.
CREATE FUNCTION "pricing_cost_rule_revision_reject_update"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'pricing_cost_rule_revisions are immutable; append a new revision';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "pricing_cost_rule_revisions_no_update"
    BEFORE UPDATE ON "pricing_cost_rule_revisions"
    FOR EACH ROW EXECUTE FUNCTION "pricing_cost_rule_revision_reject_update"();
