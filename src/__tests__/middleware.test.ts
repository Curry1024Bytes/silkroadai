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
import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { config, middleware } from '@/middleware';

/** 近似 Next 的 matcher 编译:本仓 matcher 是单个含正则组的 pattern,首尾锚定即可。 */
function matches(pattern: string, path: string): boolean {
    return new RegExp(`^${pattern}$`).test(path);
}

const req = (path: string) => new NextRequest(`http://localhost${path}`);

describe('middleware — security headers', () => {
    it('sets the three security headers', () => {
        const res = middleware(req('/dashboard'));
        expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
        expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    });
});

describe('middleware — 独立门户形态门(PORTAL_FLAVOR=seedance-enterprise)', () => {
    afterEach(() => {
        delete process.env.PORTAL_FLAVOR;
    });

    it('enterprise 实例:主站页面/API 全 404,白名单放行', () => {
        process.env.PORTAL_FLAVOR = 'seedance-enterprise';
        for (const p of ['/dashboard', '/pay', '/api/portal/keys', '/api/orders', '/api/auth/register', '/models']) {
            expect(middleware(req(p)).status).toBe(404);
        }
        for (const p of [
            '/api/admin/enterprise/onboard',
            '/api/admin/enterprise/credit',
            '/api/admin/enterprise/set-password',
            '/enterprise',
            '/enterprise/login',
            '/enterprise/billing',
            '/enterprise/keys',
            '/api/auth/login',
            '/api/auth/logout',
            '/api/enterprise/keys',
            '/api', // P3 素材库 Action API(火山形)
            '/api/v3/contents/generations/tasks', // 火山方舟形视频 API
            '/enterprise-admin', // 运营后台
            '/enterprise-admin/login',
        ]) {
            expect(middleware(req(p)).status).not.toBe(404);
        }
    });

    it('enterprise 实例:/ 与 /login 重定向到 /enterprise/login(借道 next.config 的 / → /login)', () => {
        process.env.PORTAL_FLAVOR = 'seedance-enterprise';
        for (const p of ['/', '/login']) {
            const res = middleware(req(p));
            expect(res.status).toBe(307);
            expect(res.headers.get('location')).toContain('/enterprise/login');
        }
    });

    it('主站实例(env 未设):行为不变', () => {
        expect(middleware(req('/dashboard')).status).not.toBe(404);
    });
});

describe('middleware — matcher excludes /v1/* (body-buffering 10MB cap)', () => {
    const pattern = config.matcher[0];

    it('declares the v1/ v1beta/ seedance-adapter/ api/tools/ negative lookaheads explicitly', () => {
        expect(pattern).toContain('?!v1/');
        expect(pattern).toContain('v1beta/');
        expect(pattern).toContain('seedance-adapter/');
        expect(pattern).toContain('api/tools/');
        expect(pattern).toContain('api/v3/');
    });

    it.each([
        '/v1/chat/completions',
        '/v1/images/edits',
        '/v1/images/generations',
        '/v1/models',
        '/v1/messages',
        // P3:dashboard 素材上传(multipart 视频可 >10MB)避开 body 缓冲截断
        '/api/enterprise/assets',
        '/api/enterprise/assets/asset-20260719120000-abcdef',
        '/api/v3/contents/generations/tasks',
        // W10:/v1beta native 透传经 portal(Caddy 今晚切流),Gemini inlineData
        // 大图 base64 必须避开 middleware 的 10MB body 缓冲截断
        '/v1beta/models/gemini-3-pro-image-preview:generateContent',
        '/v1beta/models',
        '/seedance-adapter/v1/videos',
        // 2026-07-05:工具箱各工具的提交入口带参考图 base64,>10MB 被缓冲截断 →
        // new-api 报 "unexpected end of JSON input"(seedance 图生视频客户实测)。
        '/api/tools/seedance/submit',
        '/api/tools/image/generate',
        '/api/tools/chat/stream',
    ])('does NOT match proxy path %s', (path) => {
        expect(matches(pattern, path)).toBe(false);
    });

    it.each(['/', '/dashboard', '/login', '/pay', '/chat', '/api/portal/keys', '/api/orders'])(
        'still matches page/API path %s',
        (path) => {
            expect(matches(pattern, path)).toBe(true);
        },
    );

    it.each(['/_next/static/chunk.js', '/_next/image', '/favicon.ico'])(
        'keeps excluding static asset path %s',
        (path) => {
            expect(matches(pattern, path)).toBe(false);
        },
    );
});
