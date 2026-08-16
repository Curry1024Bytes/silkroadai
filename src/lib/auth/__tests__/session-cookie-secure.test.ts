/**
 * 会话 cookie Secure 属性(P2 独立门户裸 IP 修正)。
 *
 * 背景:企业门户走裸 IP HTTP(128.241.232.23),生产默认 `secure: true` 的
 * cookie 在纯 HTTP 下被浏览器直接丢弃 → 登录 200 但 /enterprise 永远弹回
 * 登录页(2026-07-19 真机实测)。企业实例 env 设 `SESSION_COOKIE_SECURE=false`
 * (+ `BRAND_COOKIE_DOMAIN=` 置空)修正;主站实例不设,行为不变。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { setSessionCookie, clearSessionCookie, cookieSecureForRequest, SESSION_COOKIE_NAME } from '../session';

function reqWithProto(proto?: string) {
    const headers: Record<string, string> = {};
    if (proto) headers['x-forwarded-proto'] = proto;
    return new NextRequest('http://internal/api/auth/login', { method: 'POST', headers });
}

afterEach(() => {
    vi.unstubAllEnvs();
});

function vi_setNodeEnv(v: string) {
    vi.stubEnv('NODE_ENV', v);
}

function cookieOf(res: NextResponse) {
    return res.cookies.get(SESSION_COOKIE_NAME);
}

describe('session cookie secure attribute', () => {
    it('production 默认 secure=true', () => {
        vi_setNodeEnv('production');
        const res = NextResponse.json({});
        setSessionCookie(res, 'tok');
        expect(cookieOf(res)?.secure).toBe(true);
    });

    it('SESSION_COOKIE_SECURE=false → secure=false(裸 IP HTTP 实例)', () => {
        vi_setNodeEnv('production');
        vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
        const res = NextResponse.json({});
        setSessionCookie(res, 'tok');
        expect(cookieOf(res)?.secure).toBeFalsy();
    });

    it('clearSessionCookie 与 set 同属性(否则清不掉)', () => {
        vi_setNodeEnv('production');
        vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
        const res = NextResponse.json({});
        clearSessionCookie(res);
        const c = cookieOf(res);
        expect(c?.secure).toBeFalsy();
        expect(c?.maxAge).toBe(0);
    });

    it('其他值(on/true/空)不触发关闭,仍按 NODE_ENV', () => {
        vi_setNodeEnv('production');
        vi.stubEnv('SESSION_COOKIE_SECURE', 'true');
        const res = NextResponse.json({});
        setSessionCookie(res, 'tok');
        expect(cookieOf(res)?.secure).toBe(true);
    });
});

describe('cookieSecureForRequest — 按请求协议决定 secure(域名 HTTPS vs 裸 IP HTTP 并存)', () => {
    it('X-Forwarded-Proto=https → 强制 true,即使 env SESSION_COOKIE_SECURE=false', () => {
        vi_setNodeEnv('production');
        vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
        expect(cookieSecureForRequest(reqWithProto('https'))).toBe(true);
    });

    it('X-Forwarded-Proto=http + env false → false(裸 IP HTTP 入口照常登录)', () => {
        vi_setNodeEnv('production');
        vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
        expect(cookieSecureForRequest(reqWithProto('http'))).toBe(false);
    });

    it('无 X-Forwarded-Proto → 回落 env(主站不设 env → production → true)', () => {
        vi_setNodeEnv('production');
        expect(cookieSecureForRequest(reqWithProto(undefined))).toBe(true);
    });

    it('http + 无 env(主站假想 http)→ 仍按 env=true,不误降级', () => {
        vi_setNodeEnv('production');
        expect(cookieSecureForRequest(reqWithProto('http'))).toBe(true);
    });

    it('setSessionCookie 传 req(https)→ cookie secure=true,即使 env=false', () => {
        vi_setNodeEnv('production');
        vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
        const res = NextResponse.json({});
        setSessionCookie(res, 'tok', reqWithProto('https'));
        expect(cookieOf(res)?.secure).toBe(true);
    });

    it('setSessionCookie 传 req(http)+ env false → cookie secure=false', () => {
        vi_setNodeEnv('production');
        vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
        const res = NextResponse.json({});
        setSessionCookie(res, 'tok', reqWithProto('http'));
        expect(cookieOf(res)?.secure).toBeFalsy();
    });
});
