ALTER TABLE "channel_groups"
    ADD COLUMN "upstream_present" BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN "upstream_synced_at" TIMESTAMP(3);

-- new-api permits selectable groups without channels. Mirrored groups retain
-- that state; model mappings still require an actual group/channel membership.
-- Manually managed tiers keep their original guardrail.
ALTER TABLE "channel_groups" DROP CONSTRAINT "channel_groups_enabled_requires_channels";
ALTER TABLE "channel_groups" ADD CONSTRAINT "channel_groups_enabled_requires_channels"
    CHECK (NOT "enabled" OR "upstream_synced_at" IS NOT NULL
        OR COALESCE(cardinality("newapi_channel_ids"), 0) > 0);
