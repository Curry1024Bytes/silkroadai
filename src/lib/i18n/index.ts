/**
 * Portal i18n core (isomorphic — safe in server + client components).
 *
 * Model: ONE site locale (`zh` default | `en`), chosen by the visitor via the
 * `<LocaleSwitcher />` and persisted in the `portal_locale` cookie. Server
 * components resolve it with `getLocale()` (`./server`), client components
 * read it from `<LocaleProvider>` context (`./client`). No URL prefix — URLs
 * stay identical in both languages (SEO + deep links untouched).
 *
 * Messages are plain TypeScript objects, one module per area under
 * `./messages/*`, written with `defineMessages(zh, en)` so the `en` shape is
 * type-checked against `zh` (missing / extra keys fail `tsc`). Access is
 * direct property access (`m.keys.title`) — no string keys, no runtime
 * lookup, fully tree-shakeable (a client island only ships the areas it
 * imports). Interpolation = functions: `limit: (n: number) => \`最多 ${n} 把\``.
 *
 * `Locale` is shared with the legacy `@/lib/locale` (W1 pay-flow `?lang=en`)
 * so the two mechanisms agree on the value set.
 */
import type { Locale } from '@/lib/locale';

export type { Locale };

export const LOCALE_COOKIE = 'portal_locale';
export const LOCALES: readonly Locale[] = ['zh', 'en'];
export const DEFAULT_LOCALE: Locale = 'zh';
/** One year — the choice is a stable preference, not a session flag. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export interface Dict<T> {
    zh: T;
    en: T;
}

/** `zh` is the source of truth; `en` must have exactly the same shape. */
export function defineMessages<T>(zh: T, en: NoInfer<T>): Dict<T> {
    return { zh, en };
}

export function pickMessages<T>(dict: Dict<T>, locale: Locale): T {
    return locale === 'en' ? dict.en : dict.zh;
}

/** Strict parse of a cookie / query value. Anything unknown → null (caller decides fallback). */
export function parseLocale(value: string | null | undefined): Locale | null {
    const v = value?.trim().toLowerCase();
    if (v === 'en') return 'en';
    if (v === 'zh' || v === 'zh-cn' || v === 'zhcn') return 'zh';
    return null;
}

/**
 * First-visit default from the browser's `Accept-Language` (same idea as
 * new-api's i18next browser detector): only the highest-priority tag counts;
 * `zh*` → zh, anything else → en, missing header → zh. Crawlers (Googlebot /
 * Baiduspider) send no Accept-Language, so SEO keeps seeing the Chinese page.
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale {
    if (!header) return DEFAULT_LOCALE;
    const first = header.split(',')[0]?.trim().toLowerCase() ?? '';
    if (!first || first === '*') return DEFAULT_LOCALE;
    return first.startsWith('zh') ? 'zh' : 'en';
}

/** `<html lang>` value. */
export function htmlLang(locale: Locale): string {
    return locale === 'en' ? 'en' : 'zh-CN';
}

/** `Intl` / `toLocaleString` tag. Always pair with `{ timeZone: 'Asia/Shanghai' }` (gotcha #20). */
export function intlLocale(locale: Locale): string {
    return locale === 'en' ? 'en-US' : 'zh-CN';
}

/** Serialized `Set-Cookie` / `document.cookie` string for the locale preference. */
export function localeCookieString(locale: Locale): string {
    return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`;
}
