-- Finalize the official display casing and visual identity from the supplied brand master.
-- Keep the previous migration immutable because it has already been deployed.
UPDATE "tenants"
SET
    "brand_name" = 'LLmRoute',
    "primary_color" = '#0e1a2a',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = '00000000-0000-0000-0000-000000000001';
