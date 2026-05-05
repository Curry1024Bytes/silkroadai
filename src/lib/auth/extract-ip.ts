import type { NextRequest } from 'next/server';

/**
 * Extract the originating client IP from a NextRequest, preferring proxy
 * headers in the order our deployment trusts them.
 *
 * Order:
 *   1. X-Forwarded-For — Caddy on the host adds this; first comma-separated
 *      hop is the actual remote_addr Caddy saw.
 *   2. X-Real-IP — alternative single-IP header set by some proxies.
 *   3. null — bare/dev request without a proxy in front.
 *
 * Truncated at 45 chars (max IPv6 length is 39; +6 padding) to stay
 * inside the User.last_login_ip column expectations and resist
 * adversarial header bloat.
 *
 * Note: trust here assumes the host-level Caddy is the only thing setting
 * these headers. If we ever sit behind another proxy, the first hop in
 * X-Forwarded-For becomes spoofable; revisit at that point.
 */
const MAX_IP_LEN = 45;

export function extractClientIP(req: NextRequest): string | null {
    const xff = req.headers.get('x-forwarded-for');
    if (xff) {
        const first = xff.split(',')[0]?.trim();
        if (first) return first.slice(0, MAX_IP_LEN);
    }
    const xri = req.headers.get('x-real-ip');
    if (xri) {
        const v = xri.trim();
        if (v) return v.slice(0, MAX_IP_LEN);
    }
    return null;
}
