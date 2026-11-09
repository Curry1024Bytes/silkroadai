-- The V1–V7 signed publication chain was removed on 2026-11-08
-- (docs/2026-11-08-拆除签名发布链路.md). It never ran in this deployment: its
-- persistence check accepts only mysql:// against a PostgreSQL new-api and its
-- scheduler required NEWAPI_PRICING_DATABASE_URL, which was never set. Both
-- tables were verified empty in production before this migration was written.
--
-- pricing_publish_coordinator is deliberately NOT dropped: the live pricing path
-- locks its row as a mutex, and the model catalog uses its revision as a cache key.

DROP TABLE IF EXISTS "pricing_publish_writes";
DROP TABLE IF EXISTS "pricing_publish_jobs";
