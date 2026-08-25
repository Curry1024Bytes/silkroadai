/**
 * Browser-safe public brand configuration.
 *
 * These values are intentionally limited to NEXT_PUBLIC_* variables. Secrets
 * and internal new-api addresses must stay in server-only configuration.
 */
function withoutTrailingSlash(value: string): string {
    return value.replace(/\/+$/, '');
}

export const BRAND_NAME = 'LLmRoute';
export const BRAND_TAGLINE = 'One route. Every model.';
export const BRAND_SITE_URL = withoutTrailingSlash(process.env.NEXT_PUBLIC_APP_URL || 'https://llmroute.club');
export const CUSTOMER_API_BASE_URL = withoutTrailingSlash(
    process.env.NEXT_PUBLIC_API_URL || 'https://api.llmroute.club',
);
export const OPENAI_API_BASE_URL = `${CUSTOMER_API_BASE_URL}/v1`;
export const ANTHROPIC_API_BASE_URL = CUSTOMER_API_BASE_URL;
export const IMAGE_CDN_BASE_URL = withoutTrailingSlash(
    process.env.NEXT_PUBLIC_IMAGE_URL || 'https://images.llmroute.club',
);
export const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@llmroute.club';
export const SUPPORT_WECHAT = process.env.NEXT_PUBLIC_SUPPORT_WECHAT || 'LLmRoute';
