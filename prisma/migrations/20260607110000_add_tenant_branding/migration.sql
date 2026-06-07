-- P6a white-label foundations: tenant branding/domain columns + platform backfill.
-- Pure add-columns + backfill. The platform tenant is backfilled to its CURRENT
-- hardcoded values so the platform domain renders byte-identically (no regression).

-- AlterTable
ALTER TABLE "tenants"
    ADD COLUMN "logo_url" TEXT,
    ADD COLUMN "primary_color" TEXT DEFAULT '#1E3A8A',
    ADD COLUMN "support_email" TEXT,
    ADD COLUMN "support_wechat" TEXT,
    ADD COLUMN "domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "signup_enabled" BOOLEAN NOT NULL DEFAULT true;

-- Backfill platform tenant (PLATFORM_TENANT_ID) with its existing brand so the
-- platform domain is unchanged. primary_color = the real current navy (#1a2540),
-- NOT the #1E3A8A column default (that default is for new partners).
UPDATE "tenants" SET
    "domains" = ARRAY['silkroadai.io', 'www.silkroadai.io', 'ai.silkroadai.io'],
    "primary_domain" = 'silkroadai.io',
    "brand_name" = 'Silk Road AI',
    "primary_color" = '#1a2540',
    "support_email" = 'support@silkroadai.io',
    "support_wechat" = 'Global_Ads'
WHERE "id" = '00000000-0000-0000-0000-000000000001';
