-- Keep the persisted platform tenant contact in sync with the public brand.
-- The initial tenant-branding migration is already applied in production and
-- must remain immutable, so this correction is a separate forward migration.
UPDATE "tenants"
SET "support_wechat" = 'LLmRoute'
WHERE "id" = '00000000-0000-0000-0000-000000000001';
