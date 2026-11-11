import { BlockList, isIP } from 'node:net';
import type { NextRequest } from 'next/server';

/**
 * Extract the originating client IP from a NextRequest.
 *
 * Deployment shape (prod): client → Cloudflare → host Caddy → portal.
 * Caddy has no `trusted_proxies`, so it discards any client-supplied
 * X-Forwarded-For and sets it to the TCP peer it saw. Behind Cloudflare
 * that peer is a Cloudflare edge node, NOT the customer — which is why
 * `User.last_login_ip` used to fill up with 162.158.x / 172.7x addresses.
 * The real client address is in `CF-Connecting-IP`.
 *
 * Order:
 *   1. CF-Connecting-IP — only when the peer (below) is itself a Cloudflare
 *      address. Caddy forwards this header verbatim, so a request sent
 *      straight to the origin IP could carry a forged value; gating on the
 *      peer means a forger gets their own real address recorded instead.
 *   2. X-Forwarded-For first hop — the peer Caddy saw. Correct on its own
 *      for hosts that are not behind Cloudflare (enterprise bare-IP entry,
 *      galaxytoken.ai) and for container-internal calls.
 *   3. X-Real-IP — alternative single-IP header set by some proxies.
 *   4. null — bare/dev request without a proxy in front.
 *
 * Truncated at 45 chars (max IPv6 textual length is 39; +6 padding) to stay
 * inside the `last_login_ip` / `signup_ip` column expectations and resist
 * adversarial header bloat.
 */
const MAX_IP_LEN = 45;

/** https://www.cloudflare.com/ips/ — static list, changes roughly once every
 *  few years. If Cloudflare adds a range we don't know, requests arriving
 *  through it fall back to step 2 (edge IP recorded): degraded, never wrong
 *  in the dangerous direction. */
const CLOUDFLARE_V4: Array<[string, number]> = [
    ['173.245.48.0', 20],
    ['103.21.244.0', 22],
    ['103.22.200.0', 22],
    ['103.31.4.0', 22],
    ['141.101.64.0', 18],
    ['108.162.192.0', 18],
    ['190.93.240.0', 20],
    ['188.114.96.0', 20],
    ['197.234.240.0', 22],
    ['198.41.128.0', 17],
    ['162.158.0.0', 15],
    ['104.16.0.0', 13],
    ['104.24.0.0', 14],
    ['172.64.0.0', 13],
    ['131.0.72.0', 22],
];
const CLOUDFLARE_V6: Array<[string, number]> = [
    ['2400:cb00::', 32],
    ['2606:4700::', 32],
    ['2803:f800::', 32],
    ['2405:b500::', 32],
    ['2405:8100::', 32],
    ['2a06:98c0::', 29],
    ['2c0f:f248::', 32],
];

/** Loopback, RFC1918, CGNAT, link-local, ULA — addresses that never identify
 *  a customer (docker bridge 172.20.0.1, WireGuard 10.88.0.x, localhost). */
const NON_PUBLIC_V4: Array<[string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
];
const NON_PUBLIC_V6: Array<[string, number]> = [
    ['::', 127], // :: and ::1
    ['fc00::', 7],
    ['fe80::', 10],
];

function buildList(v4: Array<[string, number]>, v6: Array<[string, number]>): BlockList {
    const list = new BlockList();
    for (const [net, prefix] of v4) list.addSubnet(net, prefix, 'ipv4');
    for (const [net, prefix] of v6) list.addSubnet(net, prefix, 'ipv6');
    return list;
}

const cloudflareList = buildList(CLOUDFLARE_V4, CLOUDFLARE_V6);
const nonPublicList = buildList(NON_PUBLIC_V4, NON_PUBLIC_V6);

/** Strip the IPv4-mapped IPv6 prefix so `::ffff:1.2.3.4` matches v4 ranges. */
function unmap(ip: string): string {
    const lower = ip.toLowerCase();
    return lower.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

function inList(list: BlockList, raw: string): boolean {
    const ip = unmap(raw);
    const family = isIP(ip);
    if (family === 0) return false;
    return list.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export function isCloudflareIP(ip: string): boolean {
    return inList(cloudflareList, ip);
}

/** True for a syntactically valid, publicly routable address. Per-IP
 *  throttles key on this: a private / unparseable value means "we don't know
 *  who this is", and limiting on it would lump unrelated users together. */
export function isPublicIP(ip: string | null | undefined): ip is string {
    if (!ip) return false;
    const v = unmap(ip);
    return isIP(v) !== 0 && !nonPublicList.check(v, isIP(v) === 4 ? 'ipv4' : 'ipv6');
}

function proxyPeer(req: NextRequest): string | null {
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

export function extractClientIP(req: NextRequest): string | null {
    const peer = proxyPeer(req);
    if (peer && isCloudflareIP(peer)) {
        const cf = req.headers.get('cf-connecting-ip')?.trim();
        // Must parse as an address — this value ends up in the DB and in
        // rate-limit keys, so a non-IP string is ignored rather than stored.
        if (cf && cf.length <= MAX_IP_LEN && isIP(cf) !== 0) return unmap(cf);
    }
    return peer;
}
