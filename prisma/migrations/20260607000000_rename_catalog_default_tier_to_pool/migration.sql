-- P2.6: rename catalog tier 'default' → 'pool'.
--
-- Aligns the P2.5 import output (which wrote tier='default' + upstream_map.default)
-- with P3's ChannelGroup tiers (pool/official). P3's `pool` tier maps to new-api
-- group 'default' (existing customer tokens are already group=default), so the
-- already-imported 'default' prices ARE the pool (号池) prices — a rename is correct.
--
-- Pure DATA migration, no schema change. Preserves every row, including any
-- operator-hand-filled image prices (their tier='default' rows are renamed too).
-- Idempotent: re-running affects 0 rows once no 'default' remains.

-- 1) CatalogPrice.tier 'default' → 'pool' (chat + image price rows alike).
UPDATE "catalog_prices" SET "tier" = 'pool' WHERE "tier" = 'default';

-- 2) CatalogModel.upstream_map JSON key 'default' → 'pool' (jsonb: drop the old
--    key, re-add as 'pool' with the same {channel_id, upstream_model} value).
UPDATE "catalog_models"
SET "upstream_map" = ("upstream_map" - 'default') || jsonb_build_object('pool', "upstream_map" -> 'default')
WHERE "upstream_map" ? 'default';
