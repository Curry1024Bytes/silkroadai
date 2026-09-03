-- Reconcile every catalog routing entry with the tenant's enabled
-- ChannelGroup topology. This intentionally does not special-case `pool`:
-- stale aliases can exist under any old tier key after a channel is moved.
-- CatalogPrice rows are immutable history and are never deleted here.
WITH cleaned AS (
    SELECT
        model."id",
        COALESCE(
            jsonb_object_agg(entry.key, entry.value) FILTER (WHERE owner."id" IS NOT NULL),
            '{}'::jsonb
        ) AS upstream_map
    FROM "catalog_models" AS model
    LEFT JOIN LATERAL jsonb_each(model."upstream_map") AS entry(key, value) ON TRUE
    LEFT JOIN "channel_groups" AS owner
      ON COALESCE(owner."tenant_id", '00000000-0000-0000-0000-000000000001'::uuid)
       = COALESCE(model."tenant_id", '00000000-0000-0000-0000-000000000001'::uuid)
     AND owner."enabled" = TRUE
     AND owner."key" = entry.key
     AND CASE
             WHEN jsonb_typeof(entry.value -> 'channel_id') = 'number'
             THEN (entry.value ->> 'channel_id')::integer = ANY(owner."newapi_channel_ids")
             ELSE FALSE
         END
    GROUP BY model."id"
)
UPDATE "catalog_models" AS model
SET
    "upstream_map" = cleaned.upstream_map,
    "updated_at" = CURRENT_TIMESTAMP
FROM cleaned
WHERE model."id" = cleaned."id"
  AND model."upstream_map" IS DISTINCT FROM cleaned.upstream_map;

-- An enabled catalog row with no route is a ghost product. Preserve the row
-- and its price/audit history, but stop advertising it until an operator maps
-- it to a real channel again.
UPDATE "catalog_models"
SET "enabled" = FALSE, "updated_at" = CURRENT_TIMESTAMP
WHERE "enabled" = TRUE
  AND "upstream_map" = '{}'::jsonb;

-- Repair the eight known image shadow-meter rows produced by the old
-- token-miss => pool fallback. The guard is deliberately narrow: only the
-- affected resolution SKUs, a missing Portal token, an unmatched zero-cost
-- row, no real pool tier, and exactly one current route. Billing amounts and
-- price links stay untouched.
WITH sole_image_route AS (
    SELECT
        model."tenant_id",
        model."slug",
        (SELECT value FROM jsonb_object_keys(model."upstream_map") AS keys(value) LIMIT 1) AS tier
    FROM "catalog_models" AS model
    WHERE model."slug" IN ('gpt-image-2-1k', 'gpt-image-2-2k', 'gpt-image-2-4k')
      AND (SELECT COUNT(*) FROM jsonb_object_keys(model."upstream_map")) = 1
)
UPDATE "usage_records" AS usage
SET "tier" = route.tier
FROM "users" AS portal_user, sole_image_route AS route
WHERE usage."user_id" = portal_user."id"
  AND usage."model_slug" = route."slug"
  AND COALESCE(route."tenant_id", '00000000-0000-0000-0000-000000000001'::uuid)
      = COALESCE(portal_user."tenant_id", '00000000-0000-0000-0000-000000000001'::uuid)
  AND usage."tier" = 'pool'
  AND usage."token_id" IS NULL
  AND usage."matched" = FALSE
  AND usage."cost_cny" = 0
  AND NOT EXISTS (
      SELECT 1
      FROM "channel_groups" AS pool_group
      WHERE COALESCE(pool_group."tenant_id", '00000000-0000-0000-0000-000000000001'::uuid)
          = COALESCE(portal_user."tenant_id", '00000000-0000-0000-0000-000000000001'::uuid)
        AND pool_group."enabled" = TRUE
        AND pool_group."key" = 'pool'
  );

-- Tier values must always be supplied by application code. Removing the old
-- defaults turns future omissions into visible write failures instead of
-- silently creating another `pool` classification.
ALTER TABLE "newapi_tokens" ALTER COLUMN "tier" DROP DEFAULT;
ALTER TABLE "usage_records" ALTER COLUMN "tier" DROP DEFAULT;
ALTER TABLE "seedance_video_tasks" ALTER COLUMN "tier" DROP DEFAULT;

-- Database guardrails for invariants that can be expressed without parsing
-- CatalogModel.upstream_map JSON. The application performs the full topology
-- validation; these constraints also close concurrent admin-write races.
ALTER TABLE "channel_groups"
    ADD CONSTRAINT "channel_groups_enabled_requires_channels"
    CHECK (NOT "enabled" OR COALESCE(cardinality("newapi_channel_ids"), 0) > 0);

-- The earlier index used nullable tenant_id directly, so PostgreSQL allowed
-- multiple platform-default rows with tenant_id IS NULL. Replace it with the
-- canonical platform-tenant expression used throughout Portal.
DROP INDEX "channel_groups_one_enabled_default_per_tenant";

CREATE UNIQUE INDEX "channel_groups_one_enabled_default_per_tenant"
    ON "channel_groups" ((COALESCE("tenant_id", '00000000-0000-0000-0000-000000000001'::uuid)))
    WHERE "enabled" = TRUE AND "is_default" = TRUE;

CREATE UNIQUE INDEX "channel_groups_unique_enabled_newapi_group_per_tenant"
    ON "channel_groups" (
        (COALESCE("tenant_id", '00000000-0000-0000-0000-000000000001'::uuid)),
        "newapi_group"
    )
    WHERE "enabled" = TRUE;
