-- Rebrand the platform tenant while retaining legacy hosts during migration.
UPDATE "tenants"
SET
    "brand_name" = 'LLMRoute',
    "primary_domain" = 'llmroute.club',
    "primary_color" = '#0066cc',
    "support_email" = 'support@llmroute.club',
    "domains" = ARRAY[
        'llmroute.club',
        'www.llmroute.club',
        'api.llmroute.club',
        'images.llmroute.club',
        'silkroadai.io',
        'www.silkroadai.io',
        'ai.silkroadai.io',
        'api.silkroadai.io',
        'portal.silkroadai.io'
    ],
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = '00000000-0000-0000-0000-000000000001';
