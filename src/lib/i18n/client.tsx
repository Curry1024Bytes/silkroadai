'use client';

/**
 * Client-side locale access. The root layout wraps the whole tree in
 * `<LocaleProvider locale={await getLocale()}>`; client islands read it with
 * `useLocale()` / `useMessages(dict)`. Default (no provider — e.g. a page
 * rendered in a vitest `renderToString` without the root layout) is `zh`,
 * matching the server default.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { DEFAULT_LOCALE, localeCookieString, pickMessages } from './index';
import type { Dict, Locale } from './index';

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
    return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
    return useContext(LocaleContext);
}

/** `const m = useMessages(keysMessages)` → `m.title` in the current locale. */
export function useMessages<T>(dict: Dict<T>): T {
    return pickMessages(dict, useLocale());
}

/** Persist the preference in the browser; the caller then refreshes the route. */
export function writeLocaleCookie(locale: Locale): void {
    if (typeof document === 'undefined') return;
    document.cookie = localeCookieString(locale);
}
