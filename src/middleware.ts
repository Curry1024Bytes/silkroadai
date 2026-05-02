import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const response = NextResponse.next();

  // 自动从 LITELLM_BASE_URL 提取 origin，允许 Sub2API 主站 iframe 嵌入
  const sub2apiUrl = process.env.LITELLM_BASE_URL || '';
  const extraOrigins = process.env.IFRAME_ALLOW_ORIGINS || '';

  // 检查是否包含通配符 *
  const extras = extraOrigins
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const hasWildcard = extras.includes('*');

  if (hasWildcard) {
    // 通配符：允许任何站点嵌入
    response.headers.set('Content-Security-Policy', 'frame-ancestors *');
    response.headers.delete('X-Frame-Options');
  } else {
    const origins = new Set<string>();

    if (sub2apiUrl) {
      try {
        origins.add(new URL(sub2apiUrl).origin);
      } catch {
        // ignore invalid URL
      }
    }

    for (const trimmed of extras) {
      origins.add(trimmed);
    }

    if (origins.size > 0) {
      response.headers.set('Content-Security-Policy', `frame-ancestors 'self' ${[...origins].join(' ')}`);
      // 有自定义 origins 时移除 X-Frame-Options（与 CSP frame-ancestors 冲突）
      response.headers.delete('X-Frame-Options');
    } else {
      response.headers.set('X-Frame-Options', 'SAMEORIGIN');
    }
  }

  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
