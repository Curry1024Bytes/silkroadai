import 'server-only';

/** Optional second budget gate. User quota remains the default and authoritative budget. */
export function keyQuotaLimitsEnabled(): boolean {
    return process.env.PORTAL_KEY_QUOTA_LIMITS_ENABLED === 'true';
}
