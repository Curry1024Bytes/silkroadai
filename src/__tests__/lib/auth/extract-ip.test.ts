/**
 * W5 D4 — extractClientIP helper.
 *
 * Behavior matrix:
 *   no headers                   → null
 *   x-forwarded-for single IP    → that IP
 *   x-forwarded-for multi-hop    → first (=client) hop, trimmed
 *   x-real-ip only               → that IP
 *   both XFF + XRI               → XFF wins (more standard)
 *   abusive long header          → truncated to 45 chars (matches schema budget)
 *
 * 2026-11-11 — Cloudflare awareness. Prod is client → Cloudflare → Caddy →
 * portal, and Caddy's XFF is the Cloudflare edge node, so the real client is
 * only in CF-Connecting-IP. That header is trusted ONLY when the peer is a
 * Cloudflare address (Caddy forwards it verbatim, so a direct-to-origin
 * request could forge it).
 */
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { extractClientIP, isCloudflareIP, isPublicIP } from '@/lib/auth/extract-ip';

function makeReq(headers: Record<string, string> = {}): NextRequest {
    return new NextRequest('http://internal/test', { method: 'GET', headers });
}

describe('extractClientIP', () => {
    it('returns null when neither header is present', () => {
        expect(extractClientIP(makeReq())).toBeNull();
    });

    it('returns single x-forwarded-for value', () => {
        expect(extractClientIP(makeReq({ 'x-forwarded-for': '1.2.3.4' }))).toBe('1.2.3.4');
    });

    it('takes the first hop from a multi-hop x-forwarded-for', () => {
        // Caddy → upstream proxy → us. The leftmost value is the actual
        // client; subsequent ones are intermediate proxies.
        expect(extractClientIP(makeReq({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' }))).toBe('203.0.113.7');
    });

    it('trims whitespace around the first hop', () => {
        expect(extractClientIP(makeReq({ 'x-forwarded-for': '  1.2.3.4  , 10.0.0.1' }))).toBe('1.2.3.4');
    });

    it('falls back to x-real-ip when x-forwarded-for absent', () => {
        expect(extractClientIP(makeReq({ 'x-real-ip': '5.6.7.8' }))).toBe('5.6.7.8');
    });

    it('prefers x-forwarded-for over x-real-ip when both are present', () => {
        expect(extractClientIP(makeReq({ 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' }))).toBe('1.2.3.4');
    });

    it('handles full IPv6 address (39 chars, fits in 45-char budget)', () => {
        const v6 = '2001:0db8:85a3:0000:0000:8a2e:0370:7334';
        expect(extractClientIP(makeReq({ 'x-forwarded-for': v6 }))).toBe(v6);
    });

    it('truncates abusive header at 45 chars (defense vs header bloat)', () => {
        const huge = 'A'.repeat(200);
        const r = extractClientIP(makeReq({ 'x-forwarded-for': huge }));
        expect(r).not.toBeNull();
        expect(r!.length).toBe(45);
    });

    it('returns null when x-forwarded-for is empty string', () => {
        // Empty XFF and no XRI → null. (NextRequest may serialize as empty.)
        expect(extractClientIP(makeReq({ 'x-real-ip': '' }))).toBeNull();
    });
});

describe('extractClientIP — behind Cloudflare', () => {
    it('returns CF-Connecting-IP when the peer is a Cloudflare edge (IPv4)', () => {
        expect(
            extractClientIP(makeReq({ 'x-forwarded-for': '162.158.90.12', 'cf-connecting-ip': '203.0.113.7' })),
        ).toBe('203.0.113.7');
    });

    it('returns CF-Connecting-IP when the peer is a Cloudflare edge (IPv6 peer, IPv6 client)', () => {
        expect(
            extractClientIP(
                makeReq({ 'x-forwarded-for': '2606:4700:10::6816:1a2b', 'cf-connecting-ip': '2408:8207:1850:abcd::1' }),
            ),
        ).toBe('2408:8207:1850:abcd::1');
    });

    it('IGNORES a forged CF-Connecting-IP when the peer is not Cloudflare (direct-to-origin)', () => {
        // attacker connects straight to the origin IP and sets the header
        // themselves — they get their own address recorded, not the fake one
        expect(extractClientIP(makeReq({ 'x-forwarded-for': '198.51.100.23', 'cf-connecting-ip': '8.8.8.8' }))).toBe(
            '198.51.100.23',
        );
    });

    it('ignores CF-Connecting-IP on container-internal calls (private peer)', () => {
        expect(extractClientIP(makeReq({ 'x-forwarded-for': '172.20.0.1', 'cf-connecting-ip': '8.8.8.8' }))).toBe(
            '172.20.0.1',
        );
    });

    it('ignores CF-Connecting-IP when there is no proxy peer at all', () => {
        expect(extractClientIP(makeReq({ 'cf-connecting-ip': '8.8.8.8' }))).toBeNull();
    });

    it('falls back to the edge IP when CF-Connecting-IP is missing or not an address', () => {
        expect(extractClientIP(makeReq({ 'x-forwarded-for': '104.16.1.1' }))).toBe('104.16.1.1');
        expect(extractClientIP(makeReq({ 'x-forwarded-for': '104.16.1.1', 'cf-connecting-ip': 'not-an-ip' }))).toBe(
            '104.16.1.1',
        );
        expect(
            extractClientIP(makeReq({ 'x-forwarded-for': '104.16.1.1', 'cf-connecting-ip': '1.2.3.4, 5.6.7.8' })),
        ).toBe('104.16.1.1');
    });

    it('unwraps an IPv4-mapped IPv6 client address', () => {
        expect(
            extractClientIP(makeReq({ 'x-forwarded-for': '172.71.10.10', 'cf-connecting-ip': '::ffff:203.0.113.7' })),
        ).toBe('203.0.113.7');
    });
});

describe('isCloudflareIP', () => {
    it('matches addresses inside the published ranges', () => {
        for (const ip of [
            '162.158.0.1',
            '172.71.255.254',
            '104.23.9.9',
            '173.245.48.1',
            '2606:4700::1',
            '2a06:98c7::1',
        ]) {
            expect(isCloudflareIP(ip), ip).toBe(true);
        }
    });

    it('rejects neighbours just outside them, and garbage', () => {
        // 172.64.0.0/13 ends at 172.71.255.255; 104.16.0.0/13 + 104.24.0.0/14 end at 104.27.255.255
        for (const ip of [
            '172.72.0.1',
            '172.63.255.255',
            '104.28.0.1',
            '162.160.0.1',
            '8.8.8.8',
            '10.0.0.1',
            'nope',
            '',
        ]) {
            expect(isCloudflareIP(ip), ip).toBe(false);
        }
    });
});

describe('isPublicIP', () => {
    it('is true for routable addresses', () => {
        for (const ip of ['203.0.113.7', '8.8.8.8', '172.15.0.1', '172.32.0.1', '2408:8207::1']) {
            expect(isPublicIP(ip), ip).toBe(true);
        }
    });

    it('is false for private / loopback / link-local / CGNAT / missing / unparseable', () => {
        for (const ip of [
            '127.0.0.1',
            '10.88.0.2',
            '172.20.0.1',
            '192.168.1.1',
            '169.254.1.1',
            '100.64.0.1',
            '::1',
            'fe80::1',
            'fd00::1',
            '::ffff:10.0.0.1',
            'AAAA',
            '',
            null,
            undefined,
        ]) {
            expect(isPublicIP(ip), String(ip)).toBe(false);
        }
    });
});
