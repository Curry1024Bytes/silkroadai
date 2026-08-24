-- New customer provisioning requires one unambiguous enabled default tier.
-- Admin writes already switch defaults transactionally; this index also closes
-- the concurrent-writer/direct-SQL race that could otherwise create two.
CREATE UNIQUE INDEX "channel_groups_one_enabled_default_per_tenant"
ON "channel_groups" ("tenant_id")
WHERE "is_default" = true AND "enabled" = true;
