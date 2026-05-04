import { NextResponse } from 'next/server';

/**
 * Default-deny security headers for every response.
 *
 * W5 D2 dropped the W1 sub2apipay iframe-allow CSP segment (frame-ancestors
 * with LITELLM_BASE_URL / IFRAME_ALLOW_ORIGINS). The portal is now standalone
 * — no iframe embedding from sub2apipay anymore — so the strict default
 * (X-Frame-Options=SAMEORIGIN) is correct and the dynamic CSP build was
 * dead code.
 */
export function middleware() {
    const response = NextResponse.next();
    response.headers.set('X-Frame-Options', 'SAMEORIGIN');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    return response;
}

export const config = {
    matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
