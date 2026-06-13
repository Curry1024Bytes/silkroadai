/**
 * middleware 守护测试(2026-06-11)。
 *
 * 1. 安全响应头行为不变(X-Frame-Options / nosniff / Referrer-Policy)。
 * 2. matcher 必须排除 /v1/*:Next 对命中 middleware 的路由会把请求体缓冲到
 *    middlewareClientMaxBodySize(默认 10MB)再交给 handler,超出被截断 —
 *    客户给 /v1/images/edits 传 >10MB multipart 会拿到 400 "invalid request body"
 *    (2026-06-11 实测,proxy 自身的 20MB 单图限制被框架层先挡)。
 *    谁要是把 `v1/` 从负向断言里删掉,这里会红。
 */
import { describe, expect, it } from 'vitest';
import { config, middleware } from '@/middleware';

/** 近似 Next 的 matcher 编译:本仓 matcher 是单个含正则组的 pattern,首尾锚定即可。 */
function matches(pattern: string, path: string): boolean {
    return new RegExp(`^${pattern}$`).test(path);
}

describe('middleware — security headers', () => {
    it('sets the three security headers', () => {
        const res = middleware();
        expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
        expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    });
});

describe('middleware — matcher excludes /v1/* (body-buffering 10MB cap)', () => {
    const pattern = config.matcher[0];

    it('declares the v1/ negative lookahead explicitly', () => {
        expect(pattern).toContain('?!v1/');
    });

    it.each(['/v1/chat/completions', '/v1/images/edits', '/v1/images/generations', '/v1/models', '/v1/messages'])(
        'does NOT match proxy path %s',
        (path) => {
            expect(matches(pattern, path)).toBe(false);
        },
    );

    it.each([
        '/',
        '/dashboard',
        '/login',
        '/pay',
        '/chat',
        '/api/portal/keys',
        '/api/orders',
        // /v1beta 不经 portal(Caddy 直送 new-api),不在排除范围 — 精确只排 /v1/
        '/v1beta/models',
    ])('still matches page/API path %s', (path) => {
        expect(matches(pattern, path)).toBe(true);
    });

    it.each(['/_next/static/chunk.js', '/_next/image', '/favicon.ico'])(
        'keeps excluding static asset path %s',
        (path) => {
            expect(matches(pattern, path)).toBe(false);
        },
    );
});
