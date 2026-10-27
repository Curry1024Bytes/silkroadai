# Portal i18n (zh / en)

One site locale, cookie `portal_locale` (`zh` default | `en`), switched by `<LocaleSwitcher />`. URLs never change.

## Rules

1. **Messages live in `messages/<area>.ts`**, one module per page area, built with
   `defineMessages(zh, en)`. `zh` is the source of truth; `en` must match its shape (tsc enforces).
   Use functions for interpolation: `limit: (n: number) => \`最多 ${n} 把\``. Keep JSX out of
   messages — split a sentence into parts and compose in the component when you need markup.
2. **Server components**: only the _top-level_ page / layout calls `await getLocale()` or
   `await getMessages(dict)` (from `@/lib/i18n/server`) and passes `locale` / `m` down as props to
   sync child components. Reason: vitest renders pages with `renderToString(await Page())`, which
   can't pump _nested_ async components.
3. **Client components** (`'use client'`): `const m = useMessages(dict)` / `useLocale()` from
   `@/lib/i18n/client`. No provider in tests → `zh`, so existing Chinese assertions keep passing.
4. **Metadata**: pages that need a translated `<title>` switch `export const metadata` to
   `export async function generateMetadata()` using `getLocale()`.
5. **Dates / numbers**: `toLocaleString(intlLocale(locale), { timeZone: 'Asia/Shanghai', … })` —
   the explicit timeZone stays mandatory (CLAUDE.md gotcha #20).
6. **Default-locale tests must not change**: with no cookie the site is Chinese exactly as before.
   Add an English assertion per area by mocking `@/lib/i18n/server` (`getLocale: async () => 'en'`)
   or wrapping client islands in `<LocaleProvider locale="en">`.
7. Never put the locale in the URL, never auto-translate API error bodies (`/v1/*` is a protocol
   surface, not UI).

Not in scope (still Chinese in both locales): `/docs` prose (English edition is a separate PR —
an English notice bar is shown), legal markdown under `src/content/legal`, admin / enterprise
consoles (operator-facing).
