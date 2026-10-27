/**
 * Server-side locale resolution. Only call from server components / route
 * handlers / server actions — never from `'use client'` files (they get the
 * locale from `<LocaleProvider>` via `./client`).
 *
 * Resolution order: `portal_locale` cookie → `Accept-Language` → `zh`.
 *
 * Outside a request scope (vitest renders pages by calling the page function
 * directly, no `next/headers` store) `cookies()` / `headers()` throw — we
 * swallow that and return the default, so every existing SSR smoke test keeps
 * rendering Chinese without mocking anything. Tests that want English mock
 * this module (`vi.mock('@/lib/i18n/server', …)`).
 *
 * Wrapped in React `cache()` so layout + page + nested helpers share one
 * resolution per request.
 */
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { DEFAULT_LOCALE, LOCALE_COOKIE, localeFromAcceptLanguage, parseLocale, pickMessages } from './index';
import type { Dict, Locale } from './index';

export const getLocale = cache(async (): Promise<Locale> => {
    try {
        const jar = await cookies();
        const fromCookie = parseLocale(jar.get(LOCALE_COOKIE)?.value);
        if (fromCookie) return fromCookie;
        const h = await headers();
        return localeFromAcceptLanguage(h.get('accept-language'));
    } catch {
        return DEFAULT_LOCALE;
    }
});

/** `const m = await getMessages(keysMessages)` → `m.title` in the request locale. */
export async function getMessages<T>(dict: Dict<T>): Promise<T> {
    return pickMessages(dict, await getLocale());
}
