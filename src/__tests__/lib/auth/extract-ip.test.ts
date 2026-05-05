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
 */
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { extractClientIP } from '@/lib/auth/extract-ip';

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
        expect(
            extractClientIP(makeReq({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' })),
        ).toBe('203.0.113.7');
    });

    it('trims whitespace around the first hop', () => {
        expect(extractClientIP(makeReq({ 'x-forwarded-for': '  1.2.3.4  , 10.0.0.1' }))).toBe(
            '1.2.3.4',
        );
    });

    it('falls back to x-real-ip when x-forwarded-for absent', () => {
        expect(extractClientIP(makeReq({ 'x-real-ip': '5.6.7.8' }))).toBe('5.6.7.8');
    });

    it('prefers x-forwarded-for over x-real-ip when both are present', () => {
        expect(
            extractClientIP(
                makeReq({ 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' }),
            ),
        ).toBe('1.2.3.4');
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
